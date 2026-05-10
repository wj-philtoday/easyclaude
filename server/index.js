'use strict';
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
function loadConfig() {
  const p = process.env.EASYCLAUDE_CONFIG
    || path.join(process.cwd(), 'easyclaude.config.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}
const cfg = loadConfig();
const PORT = Number(process.env.PORT || cfg.port || 7860);
const HOST = process.env.HOST || cfg.host || '127.0.0.1';

// session registry: id → { label, cwd, cmd, args }
function sessions() {
  return (cfg.sessions || []).map(s => ({
    id:    s.id,
    label: s.label || s.id,
    cwd:   s.cwd   || process.env.HOME || '/tmp',
    cmd:   s.cmd   || 'claude',
    args:  s.args  || [],
    meta:  s.meta  || {},
  }));
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml' };

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:true})); }
  if (req.url === '/api/sessions') { res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify(sessions().map(s=>({id:s.id,label:s.label,meta:s.meta})))); }

  // tmux 전체 스크롤백 캡처 — /api/capture/:sessionId
  const captureMatch = req.url.match(/^\/api\/capture\/(.+)$/);
  if (captureMatch) {
    const sess = sessions().find(s => s.id === captureMatch[1]);
    if (!sess) { res.writeHead(404); return res.end('not found'); }
    // tmux target: args에서 -t 값 추출
    const tIdx = sess.args.indexOf('-t');
    const target = tIdx >= 0 ? sess.args[tIdx + 1] : null;
    if (!target) { res.writeHead(400); return res.end('no tmux target'); }
    const { execFile } = require('child_process');
    execFile('tmux', ['capture-pane', '-t', target, '-pS', '-'], (err, stdout) => {
      res.writeHead(200, {'Content-Type':'text/plain; charset=utf-8'});
      res.end(err ? '' : stdout);
    });
    return;
  }

  const urlPath = req.url.split('?')[0]; // 쿼리스트링 제거
  let fp = path.join(CLIENT_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!fp.startsWith(CLIENT_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream'});
    res.end(data);
  });
});

// ── WebSocket — multiplexed sessions ─────────────────────────────────────────
//
// Client → Server:
//   { op:'list' }
//   { op:'open',   id, sessionId }   open a channel
//   { op:'input',  id, data }         send text
//   { op:'resize', id, cols, rows }   resize pty
//   { op:'close',  id }
//
// Server → Client:
//   { op:'sessions', list }
//   { op:'opened',   id, info }
//   { op:'output',   id, data }       raw ANSI stream
//   { op:'closed',   id }
//   { op:'error',    id, message }

const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  const channels = new Map();

  const send = obj => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));

  const openChannel = (id, sessionId) => {
    if (channels.has(id)) return send({ op:'error', id, message:'already open' });
    const sess = sessions().find(s => s.id === sessionId);
    if (!sess) return send({ op:'error', id, message:`unknown session: ${sessionId}` });

    const term = pty.spawn(sess.cmd, sess.args, {
      name: 'xterm-256color',
      cols: 220, rows: 50,
      cwd: sess.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    });

    term.onData(data => send({ op:'output', id, data }));
    term.onExit(() => { channels.delete(id); send({ op:'closed', id }); });

    // ── OSC 색상 응답 필터: xterm.js의 OSC 10/11 응답이 readline에 유입되는 버그 차단 ──
    // OSC 시퀀스가 여러 청크로 분할되어 오므로 상태로 추적
    // OSC 필터 상태 (WS input 핸들러에서 사용)


    channels.set(id, { pty: term, sess, _oscState: false });
    send({ op:'opened', id, info: { pid: term.pid, ...sess.meta } });
  };

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { op, id } = msg;
    if (op === 'list')   return send({ op:'sessions', list: sessions().map(s=>({id:s.id,label:s.label,meta:s.meta})) });
    if (op === 'open')   return openChannel(id, msg.sessionId);
    if (op === 'input') {
      const ch = channels.get(id);
      if (!ch) return;
      const data = msg.data;

      // OSC 색상 응답 필터: xterm.js가 보내는 \x1b] 시퀀스 차단 (b1b 유입 방지)
      if (data.includes('\x1b]')) { ch._oscState = true; return; }
      if (ch._oscState) {
        if (data.includes('\x1b\\') || data.includes('\x07')) ch._oscState = false;
        return;
      }

      // Enter 단독: 즉시 전송
      if (data === '\r' || data === '\n' || data === '\r\n') { ch.pty.write('\r'); return; }
      // 텍스트: 20자 청크로 나눠 pty에 써서 INT 모드와 동일한 타이밍 재현
      const CHUNK = 20, DELAY = 12;
      const chunks = [];
      for (let i = 0; i < data.length; i += CHUNK) chunks.push(data.slice(i, i + CHUNK));
      chunks.forEach((c, i) => setTimeout(() => ch.pty.write(c), i * DELAY));
      return;
    }
    if (op === 'resize') { const ch = channels.get(id); if (ch) ch.pty.resize(Number(msg.cols)||220, Number(msg.rows)||50); return; }
    if (op === 'close')  { const ch = channels.get(id); if (ch) { ch.pty.kill(); channels.delete(id); } return; }
  });

  ws.on('close', () => { channels.forEach(({pty:t}) => { try { t.kill(); } catch {} }); channels.clear(); });
});

server.listen(PORT, HOST, () => {
  console.log(`[easyclaude] ${HOST}:${PORT}`);
  console.log(`[easyclaude] sessions: ${sessions().map(s=>s.id).join(', ') || '(none)'}`);
});
