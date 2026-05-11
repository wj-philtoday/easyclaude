'use strict';
// easyclaude server — claude를 직접 stream-json 모드로 spawn하는 단일 파이프라인.
// tmux/ANSI 파이프라인은 제거 (ansi.js/screen.js/parser.js 파일은 디버그용으로 디스크에만 보존).

const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { StreamParser } = require('./stream-parser');
const { startWatcher: startInboxWatcher, eventToChannelText, detectAgentIdentity } = require('./inbox-watcher');

// ── claude-code 환경변수 자동 주입 (토글 가능) ───────────────────────────────
// 기본값을 spawn 시 claude 프로세스 env에 주입한다.
// 비활성화: cfg.claudeEnv === false
// 부분/전체 override: cfg.claudeEnv = { KEY: "VALUE", ... }
function defaultClaudeEnv() {
  const defaults = {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    CLAUDE_CODE_ENABLE_BACKGROUND_PLUGIN_REFRESH: '1',
    CLAUDE_CODE_ENABLE_TASKS: '1',
    CLAUDE_CODE_SYNC_PLUGIN_INSTALL: '1',
  };
  // cfg는 아래 loadConfig() 이후에 정의되므로 함수 호출 시점에 참조
  const cfgEnv = (typeof cfg !== 'undefined' && cfg) ? cfg.claudeEnv : undefined;
  if (cfgEnv === false) return {};
  if (cfgEnv && typeof cfgEnv === 'object') return { ...defaults, ...cfgEnv };
  return defaults;
}

// ── Bash 단축 자동 처리 ('! ' + 문자열 → '! `문자열`') ──────────────────────
// claude TUI의 ! shortcut을 stream-json 환경에서도 동일하게 재현.
// 이미 backtick으로 감싸져 있으면 그대로 둠. cfg.bashShortcut === false 면 비활성.
function maybeBashShortcut(text) {
  if (typeof cfg !== 'undefined' && cfg && cfg.bashShortcut === false) return text;
  const m = text.match(/^!\s+([\s\S]+)$/);
  if (!m) return text;
  const cmd = m[1].trim();
  if (!cmd) return text;
  if (cmd.startsWith('`') && cmd.endsWith('`')) return text;
  return '! `' + cmd + '`';
}

// ── Config & State 경로 (XDG + legacy 마이그레이션) ──────────────────────────
// 우선순위:
//   config: $EASYCLAUDE_CONFIG → ./easyclaude.config.json → $XDG_CONFIG_HOME/easyclaude/config.json
//           → ~/.config/easyclaude/config.json → /etc/easyclaude/config.json
//   state : $EASYCLAUDE_STATE  → <config>.state.json (legacy) → $XDG_DATA_HOME/easyclaude/state.json
//           → ~/.local/share/easyclaude/state.json
const HOME = process.env.HOME || '/tmp';
const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
const XDG_DATA_HOME   = process.env.XDG_DATA_HOME   || path.join(HOME, '.local', 'share');

function findConfigPath() {
  const candidates = [
    process.env.EASYCLAUDE_CONFIG,
    path.join(process.cwd(), 'easyclaude.config.json'),
    path.join(XDG_CONFIG_HOME, 'easyclaude', 'config.json'),
    '/etc/easyclaude/config.json',
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
function findStatePath(configPath) {
  if (process.env.EASYCLAUDE_STATE) return process.env.EASYCLAUDE_STATE;
  // legacy: config 옆 .state.json
  if (configPath) {
    const legacy = configPath.replace(/\.json$/, '.state.json');
    if (fs.existsSync(legacy)) return legacy;
  }
  return path.join(XDG_DATA_HOME, 'easyclaude', 'state.json');
}
function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

const cfgPath = findConfigPath();
function loadConfig() {
  if (!cfgPath) return {};
  try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch (e) { console.error(`[easyclaude] config load fail (${cfgPath}): ${e.message}`); return {}; }
}
const cfg = loadConfig();
const PORT = Number(process.env.PORT || cfg.port || 7860);
const HOST = process.env.HOST || cfg.host || '127.0.0.1';

const stateFile = findStatePath(cfgPath);
ensureDir(path.dirname(stateFile));

function loadState() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } }
function saveState(state) { try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); } catch {} }
let sessionState = loadState();

console.log(`[easyclaude] config: ${cfgPath || '(none — defaults)'}`);
console.log(`[easyclaude] state : ${stateFile}`);

// 런타임에 추가된 ad-hoc 세션 (사용자가 + 버튼으로 만든 것)
const runtimeSessions = new Map(); // id → session

function defaultArgs() {
  if (Array.isArray(cfg.defaultArgs) && cfg.defaultArgs.length) return cfg.defaultArgs.slice();
  return [
    '-p',
    '--output-format', 'stream-json',
    '--input-format',  'stream-json',
    '--include-hook-events',
    '--include-partial-messages',
    '--replay-user-messages',
    '--verbose',
  ];
}

function normalizeSession(s) {
  return {
    id:    s.id,
    label: s.label || s.id,
    cwd:   s.cwd   || process.env.HOME || '/tmp',
    name:  s.name  || s.label || s.id,
    args:  Array.isArray(s.args) ? s.args.slice() : [],
    home:  s.home  || null,           // claude HOME override (null이면 process HOME)
    meta:  s.meta  || {},
  };
}

function sessions() {
  const fromCfg = (cfg.sessions || []).map(normalizeSession);
  const fromRt  = [...runtimeSessions.values()].map(normalizeSession);
  // sessionState[id].hidden 인 항목은 목록에서 제외 (purge로 hide된 세션)
  return [...fromCfg, ...fromRt].filter(s => !sessionState[s.id]?.hidden);
}

function findSession(id) {
  return sessions().find(s => s.id === id);
}

function effectiveArgs(sess) {
  return sessionState[sess.id]?.argsOverride ?? sess.args;
}

function serializeForClient(s) {
  return { id: s.id, label: s.label, args: effectiveArgs(s), cwd: s.cwd, home: s.home, meta: s.meta };
}

function broadcastSessions() {
  const list = sessions().map(serializeForClient);
  wss.clients.forEach(c => {
    if (c.readyState === c.OPEN) c.send(JSON.stringify({ op: 'sessions', list }));
  });
}

// ── Claude session history (~/.claude/projects/) ────────────────────────────
const CLAUDE_PROJECTS = path.join(process.env.HOME || '/root', '.claude', 'projects');

function encodeCwd(cwd) {
  // claude의 encoding: `/`와 `.` 모두 `-` 로 치환
  return String(cwd).replace(/[/.]/g, '-');
}

function readHead(filePath, maxBytes = 8192) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    fs.closeSync(fd);
    return buf.slice(0, n).toString('utf8');
  } catch { return ''; }
}

function summarizeSessionFile(absPath, encodedCwd) {
  let stat;
  try { stat = fs.statSync(absPath); } catch { return null; }
  const base = path.basename(absPath, '.jsonl');
  const head = readHead(absPath, 8192);
  const lines = head.split('\n').slice(0, 6);
  let aiTitle = null, firstMsg = '', cwd = null, permissionMode = null;
  for (const ln of lines) {
    if (!ln.trim()) continue;
    let evt; try { evt = JSON.parse(ln); } catch { continue; }
    if (evt.type === 'ai-title' && !aiTitle) aiTitle = evt.aiTitle || null;
    if (evt.type === 'permission-mode' && !permissionMode) permissionMode = evt.permissionMode || null;
    if (evt.type === 'user' && !firstMsg) {
      const c = evt.message && evt.message.content;
      if (typeof c === 'string') firstMsg = c.slice(0, 200);
      else if (Array.isArray(c) && c[0]) {
        const t = c[0].text || (typeof c[0].content === 'string' ? c[0].content : '');
        firstMsg = String(t).slice(0, 200);
      }
    }
    if (evt.cwd && !cwd) cwd = evt.cwd;
  }
  return {
    sessionId: base,
    encodedCwd,
    cwd,
    aiTitle: aiTitle || null,
    firstMessage: firstMsg,
    permissionMode,
    mtime: stat.mtimeMs,
    sizeKB: Math.round(stat.size / 1024),
  };
}

function listClaudeSessions({ cwd, q, limit }) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return [];
  const dirs = cwd
    ? [encodeCwd(cwd)].filter(d => fs.existsSync(path.join(CLAUDE_PROJECTS, d)))
    : fs.readdirSync(CLAUDE_PROJECTS).filter(d => {
        try { return fs.statSync(path.join(CLAUDE_PROJECTS, d)).isDirectory(); } catch { return false; }
      });

  const all = [];
  for (const d of dirs) {
    const dirAbs = path.join(CLAUDE_PROJECTS, d);
    let entries; try { entries = fs.readdirSync(dirAbs); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const abs = path.join(dirAbs, f);
      try {
        const stat = fs.statSync(abs);
        if (!stat.isFile()) continue;
        all.push({ abs, encodedCwd: d, mtime: stat.mtimeMs });
      } catch {}
    }
  }
  // 최신순 정렬 후 limit*5 만 head 읽음 (성능)
  all.sort((a, b) => b.mtime - a.mtime);
  const headLimit = Math.min(all.length, Math.max((limit || 20) * 5, 50));
  const summaries = [];
  for (let i = 0; i < headLimit; i++) {
    const s = summarizeSessionFile(all[i].abs, all[i].encodedCwd);
    if (!s) continue;
    if (q) {
      const ql = q.toLowerCase();
      const hay = ((s.aiTitle || '') + ' ' + (s.firstMessage || '')).toLowerCase();
      if (!hay.includes(ql)) continue;
    }
    summaries.push(s);
    if (summaries.length >= (limit || 20)) break;
  }
  return summaries;
}

function inspectClaudeHome(homeDir) {
  const claudeDir = path.join(homeDir, '.claude');
  if (!fs.existsSync(claudeDir)) return null;
  let readable = false, writable = false;
  try { fs.accessSync(claudeDir, fs.constants.R_OK); readable = true; } catch {}
  try { fs.accessSync(claudeDir, fs.constants.W_OK); writable = true; } catch {}
  let email = null, hasCredentials = false;
  try {
    const credPath = path.join(claudeDir, '.credentials.json');
    if (fs.existsSync(credPath)) {
      hasCredentials = true;
      // 파일 권한 600이라 우리(team-pm) 소유 아니면 못 읽음
      try {
        const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        // oauth account 정보 별도 보관 위치도 검사
      } catch {}
    }
    // 메일은 .claude.json 의 oauthAccount 에 보관됨 (HOME 안)
    const claudeJson = path.join(homeDir, '.claude.json');
    if (fs.existsSync(claudeJson)) {
      try {
        const cj = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
        email = cj.oauthAccount?.emailAddress || cj.oauthAccount?.email || null;
      } catch {}
    }
  } catch {}
  let mtime = null;
  try { mtime = fs.statSync(claudeDir).mtimeMs; } catch {}
  return { home: homeDir, claudeDir, email, hasCredentials, readable, writable, mtime };
}

function scanClaudeHomes() {
  const candidates = new Set();
  // 1) 현재 프로세스 HOME (가장 흔한 케이스)
  if (process.env.HOME) candidates.add(process.env.HOME);
  // 2) /home/* 스캔 (각 디렉토리에 .claude 있는지)
  try {
    for (const u of fs.readdirSync('/home')) {
      const p = path.join('/home', u);
      try {
        if (fs.statSync(p).isDirectory()) candidates.add(p);
      } catch {}
    }
  } catch {}
  // 3) /root
  if (fs.existsSync('/root')) candidates.add('/root');

  const out = [];
  for (const homeDir of candidates) {
    const info = inspectClaudeHome(homeDir);
    if (info) out.push(info);
  }
  // readable + writable 우선 정렬
  out.sort((a, b) => {
    if (a.writable !== b.writable) return a.writable ? -1 : 1;
    if (a.readable !== b.readable) return a.readable ? -1 : 1;
    return (b.mtime || 0) - (a.mtime || 0);
  });
  return out;
}

let _cachedOptions = null;
function getClaudeOptions() {
  if (_cachedOptions) return _cachedOptions;
  const { spawnSync } = require('child_process');
  let help = '';
  try {
    const r = spawnSync('claude', ['--help'], { timeout: 5000, encoding: 'utf8' });
    help = r.stdout || '';
  } catch (e) {}
  // 옵션 파싱: "--effort <level>  ...(low, medium, high, xhigh, max)"
  // "--permission-mode <mode>  ...(choices: "acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan")"
  function pickChoices(flag) {
    const re = new RegExp(`${flag}\\s+\\S+\\s+([^\\n]+)`);
    const m = help.match(re);
    if (!m) return [];
    const line = m[1];
    const choicesMatch = line.match(/choices:\s*([^)]+)\)/);
    if (choicesMatch) {
      return choicesMatch[1].match(/"([^"]+)"/g)?.map(s => s.slice(1,-1)) || [];
    }
    // 괄호 안 "low, medium, high"
    const inParens = line.match(/\(([^)]+)\)/);
    if (inParens) {
      return inParens[1].split(/[,|]/).map(s => s.trim()).filter(s => /^[a-z]/i.test(s));
    }
    return [];
  }
  const efforts = pickChoices('--effort');
  const permissionModes = pickChoices('--permission-mode');
  // 모델은 alias만 (실제 변경 가능한 것). 1m 컨텍스트는 [1m] 접미.
  const models = ['opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'haiku'];
  _cachedOptions = {
    efforts: efforts.length ? efforts : ['low', 'medium', 'high', 'xhigh', 'max'],
    permissionModes: permissionModes.length ? permissionModes : ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'],
    models,
    claudeVersion: (help.match(/claude\s+([\d.]+)/i) || [])[1] || null,
  };
  return _cachedOptions;
}

function claudeJsonlExists(claudeId) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return false;
  try {
    for (const d of fs.readdirSync(CLAUDE_PROJECTS)) {
      if (fs.existsSync(path.join(CLAUDE_PROJECTS, d, claudeId + '.jsonl'))) return true;
    }
  } catch {}
  return false;
}

function deleteClaudeSessionFile(sessionId) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return 0;
  let n = 0;
  for (const d of fs.readdirSync(CLAUDE_PROJECTS)) {
    const f = path.join(CLAUDE_PROJECTS, d, sessionId + '.jsonl');
    try {
      if (fs.existsSync(f)) { fs.unlinkSync(f); n++; }
    } catch {}
    // sidecar 디렉토리도 정리
    const sidecar = path.join(CLAUDE_PROJECTS, d, sessionId);
    try {
      if (fs.existsSync(sidecar) && fs.statSync(sidecar).isDirectory()) {
        fs.rmSync(sidecar, { recursive: true, force: true });
      }
    } catch {}
  }
  return n;
}

// ── Permission-prompt bridge (easypermitter MCP ↔ easyclaude) ────────────────
// easypermitter.js (stdio MCP)가 HTTP로 권한 요청을 등록하고 응답을 대기한다.
// pending Map 으로 다중 요청 지원. 동일 tool_use_id 재요청 시 종전 요청은 deny.
const pendingPermissions = new Map(); // tool_use_id → { res, timer, sessionId, payload }

function readJsonBody(req, cb) {
  let buf = '';
  req.setEncoding('utf8');
  req.on('data', d => {
    buf += d;
    if (buf.length > 1024 * 1024) {
      // 1MB cap — 권한 입력 페이로드가 그렇게 클 일 없다
      req.destroy();
      cb(new Error('payload too large'));
    }
  });
  req.on('end', () => {
    if (!buf) return cb(null, {});
    try { cb(null, JSON.parse(buf)); } catch (e) { cb(e); }
  });
  req.on('error', err => cb(err));
}

function bridgeBroadcastPermission(sessionId, payload) {
  const ch = sessionId ? ptyChannels.get(sessionId) : null;
  const targets = ch ? [ch] : [...ptyChannels.values()];
  for (const c of targets) {
    for (const [ws, ids] of c.subscribers) {
      if (ws.readyState !== ws.OPEN) continue;
      for (const cid of ids) {
        try {
          ws.send(JSON.stringify({ op: 'dialog', id: cid, kind: 'PermissionPrompt', ...payload }));
        } catch {}
      }
    }
  }
}

function resolvePermission(tool_use_id, result) {
  const p = pendingPermissions.get(tool_use_id);
  if (!p) return false;
  pendingPermissions.delete(tool_use_id);
  if (p.timer) clearTimeout(p.timer);
  try {
    p.res.writeHead(200, { 'Content-Type': 'application/json' });
    p.res.end(JSON.stringify(result));
  } catch {}
  return true;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml' };

// ── slash command 상응 API helpers ───────────────────────────────────────────
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function listDirSafe(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}
function homeDirOf(sessId) {
  // 세션이 home override 갖고 있으면 그쪽, 아니면 process.env.HOME
  const sess = sessions().find(s => s.id === sessId);
  return (sess && sess.home) || process.env.HOME || '/tmp';
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({ok:true}));
  }

  // ── /api/status ── ec 자체 상태 (splash/hello에서 polling 가능)
  if (req.url === '/api/status') {
    const pkg = readJsonSafe(path.join(__dirname, '..', 'package.json')) || {};
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({
      ok: true,
      version: pkg.version || 'unknown',
      port: PORT,
      host: HOST,
      sessions: sessions().map(s => ({
        id: s.id, label: s.label,
        alive: !!(ptyChannels.get(s.id)?.proc && ptyChannels.get(s.id).proc.exitCode === null),
        signedInAs: ptyChannels.get(s.id)?.signedInAs || null,
      })),
    }));
  }

  // ── /api/slash/* ── claude TUI 슬래시 커맨드 상응물 ─────────────────────────
  const slashMatch = req.url.match(/^\/api\/slash\/([a-z]+)(?:\?(.*))?$/);
  if (slashMatch) {
    const cmd = slashMatch[1];
    const qs = new URLSearchParams(slashMatch[2] || '');
    const sid = qs.get('sid');
    const ch = sid ? ptyChannels.get(sid) : null;
    res.writeHead(200, {'Content-Type':'application/json'});

    // /status — 세션 메타 (model, cwd, session_id, tools, mcp_servers...)
    if (cmd === 'status') {
      if (!ch) return res.end(JSON.stringify({ok:false, error:'session not running', sid}));
      return res.end(JSON.stringify({ok:true, session: ch.parser.snapshot().session}));
    }
    // /usage, /context — token usage (in/out/cache) 누적
    if (cmd === 'usage' || cmd === 'context') {
      if (!ch) return res.end(JSON.stringify({ok:false, error:'session not running', sid}));
      const snap = ch.parser.snapshot();
      return res.end(JSON.stringify({ok:true, usage: snap.session.usage, lastResult: ch.parser.lastResult, contextWindow: snap.session.contextWindow}));
    }
    // /stats — ~/.claude/stats-cache.json
    if (cmd === 'stats') {
      const home = sid ? homeDirOf(sid) : (process.env.HOME || '/tmp');
      const stats = readJsonSafe(path.join(home, '.claude', 'stats-cache.json'));
      return res.end(JSON.stringify({ok:true, stats}));
    }
    // /hooks — settings.json의 hooks 섹션
    if (cmd === 'hooks') {
      const home = sid ? homeDirOf(sid) : (process.env.HOME || '/tmp');
      const settings = readJsonSafe(path.join(home, '.claude', 'settings.json')) || {};
      return res.end(JSON.stringify({ok:true, hooks: settings.hooks || {}}));
    }
    // /agents — ~/.claude/agents/ 디렉토리 + settings agents
    if (cmd === 'agents') {
      const home = sid ? homeDirOf(sid) : (process.env.HOME || '/tmp');
      const agentsDir = path.join(home, '.claude', 'agents');
      const files = listDirSafe(agentsDir).filter(f => f.endsWith('.md') || f.endsWith('.json'));
      const sessionAgents = ch ? (ch.parser.snapshot().session.agents || []) : [];
      return res.end(JSON.stringify({ok:true, files, sessionAgents}));
    }
    // /tasks — .claude/tasks/ 디렉토리 (project-local)
    if (cmd === 'tasks') {
      const tasksDir = path.join(process.cwd(), '.claude', 'tasks');
      const files = listDirSafe(tasksDir);
      return res.end(JSON.stringify({ok:true, files, dir: tasksDir}));
    }
    // /doctor — 진단 (claude version, auth, mcp 상태)
    if (cmd === 'doctor') {
      const { spawnSync } = require('child_process');
      const version = spawnSync('claude', ['--version'], {timeout: 3000, encoding:'utf8'}).stdout?.trim();
      const auth = spawnSync('claude', ['auth', 'status', '--json'], {timeout: 5000, encoding:'utf8'}).stdout?.trim();
      let authParsed = null;
      try { authParsed = JSON.parse(auth); } catch {}
      const sessSnap = ch ? ch.parser.snapshot().session : null;
      return res.end(JSON.stringify({
        ok: true,
        claudeVersion: version,
        auth: authParsed,
        mcpServers: sessSnap?.mcpServers || [],
        sessionId: sessSnap?.id || null,
      }));
    }
    // /rename — POST body로 새 이름. (현재 cfg 세션 args 수정은 PoC에서 보류; session label 변경만 echo)
    if (cmd === 'rename') {
      if (req.method !== 'POST') return res.end(JSON.stringify({ok:false, error:'POST required'}));
      return readJsonBody(req, (err, body) => {
        if (err) return res.end(JSON.stringify({ok:false, error: err.message}));
        const newName = body && body.name;
        if (!sid || !newName) return res.end(JSON.stringify({ok:false, error:'sid + name required'}));
        const sess = sessions().find(s => s.id === sid);
        if (!sess) return res.end(JSON.stringify({ok:false, error:'session not found'}));
        sessionState[sid] = { ...(sessionState[sid] || {}), name: newName };
        saveState(sessionState);
        return res.end(JSON.stringify({ok:true, sid, name:newName, note:'in-memory; full rename requires session respawn'}));
      });
    }
    // /config — 기존 /api/claude-settings로 redirect (READ/WRITE 이미 있음)
    if (cmd === 'config') {
      return res.end(JSON.stringify({ok:true, redirect:'/api/claude-settings', hint:'use GET/PUT /api/claude-settings?home=<path>'}));
    }
    return res.end(JSON.stringify({ok:false, error:`unknown slash: ${cmd}`}));
  }
  if (req.url === '/api/sessions') {
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify(sessions().map(s=>({id:s.id,label:s.label,meta:s.meta}))));
  }

  // /api/sessions/history?cwd=&q=&limit=20 — claude jsonl 스캔
  // /api/options — claude --help 에서 동적으로 추출한 효력/권한모드/모델 옵션
  if (req.url === '/api/options') {
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify(getClaudeOptions()));
  }

  // /api/claude-homes — 로컬에서 사용 가능한 .claude 디렉토리 후보 조회
  if (req.url === '/api/claude-homes' || req.url.startsWith('/api/claude-homes?')) {
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({ list: scanClaudeHomes() }));
  }

  // /api/auth/status?home=... — claude auth status --json
  if (req.url.startsWith('/api/auth/status')) {
    const u = new URL(req.url, 'http://x');
    const home = u.searchParams.get('home') || process.env.HOME;
    const { spawnSync } = require('child_process');
    const result = spawnSync('claude', ['auth', 'status', '--json'], {
      env: { ...process.env, HOME: home }, timeout: 10000, encoding: 'utf8',
    });
    res.writeHead(200, {'Content-Type':'application/json'});
    try { return res.end(JSON.stringify(JSON.parse(result.stdout || '{}'))); }
    catch { return res.end(JSON.stringify({ error: result.stderr || 'parse fail', raw: result.stdout })); }
  }

  // /api/claude-settings?home=...  GET: 읽기 / PUT: body 로 저장
  if (req.url.startsWith('/api/claude-settings')) {
    const u = new URL(req.url, 'http://x');
    const home = u.searchParams.get('home') || process.env.HOME;
    const settingsPath = path.join(home, '.claude', 'settings.json');
    if (req.method === 'GET') {
      try {
        const txt = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '{}';
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ home, path: settingsPath, content: txt }));
      } catch (e) {
        res.writeHead(500, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ error: e.message }));
      }
    }
    if (req.method === 'PUT') {
      return readJsonBody(req, (err, body) => {
        if (err) { res.writeHead(400); return res.end(err.message); }
        const content = body && body.content;
        if (typeof content !== 'string') {
          res.writeHead(400, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ error: 'content (string) required' }));
        }
        // JSON 유효성 검사
        try { JSON.parse(content); }
        catch (e) {
          res.writeHead(400, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ error: 'invalid JSON: ' + e.message }));
        }
        try {
          ensureDir(path.dirname(settingsPath));
          fs.writeFileSync(settingsPath, content, { mode: 0o600 });
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ ok: true, path: settingsPath }));
        } catch (e) {
          res.writeHead(500, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ error: e.message }));
        }
      });
    }
  }

  // /api/sessions/<sid>/jsonl-path — claudeId 기반 jsonl 절대경로 응답
  const jsonlMatch = req.url.match(/^\/api\/sessions\/([^/]+)\/jsonl-path$/);
  if (jsonlMatch) {
    const sid = decodeURIComponent(jsonlMatch[1]);
    const claudeId = sessionState[sid]?.claudeId;
    if (!claudeId) {
      res.writeHead(404, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ error: 'session not found or no claudeId' }));
    }
    // 모든 home + projects 디렉토리 탐색
    const candidates = [];
    const sess = findSession(sid);
    const homes = [sess?.home, process.env.HOME].filter(Boolean);
    for (const h of homes) {
      const projectsDir = path.join(h, '.claude', 'projects');
      if (!fs.existsSync(projectsDir)) continue;
      try {
        for (const d of fs.readdirSync(projectsDir)) {
          const p = path.join(projectsDir, d, claudeId + '.jsonl');
          if (fs.existsSync(p)) candidates.push(p);
        }
      } catch {}
    }
    res.writeHead(candidates.length ? 200 : 404, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({
      claudeId, paths: candidates,
      tailCmd: candidates[0] ? `tail -f ${candidates[0]}` : null,
    }));
  }

  if (req.url.startsWith('/api/sessions/history')) {
    const u = new URL(req.url, 'http://x');
    const cwd = u.searchParams.get('cwd') || '';
    const q   = u.searchParams.get('q')   || '';
    const limit = Math.min(parseInt(u.searchParams.get('limit') || '30', 10) || 30, 100);
    try {
      const list = listClaudeSessions({ cwd: cwd || null, q: q || null, limit });
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ list }));
    } catch (e) {
      res.writeHead(500, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── Permitter 브리지 ─────────────────────────────────────────────────────────
  // easypermitter MCP 가 호출하는 두 엔드포인트.
  //   POST /api/permitter/request  — long-poll, body: { tool_name, input, tool_use_id, session?, timeoutMs? }
  //   POST /api/permitter/respond  — body: { tool_use_id, behavior, updatedInput?, message? }
  if (req.url === '/api/permitter/request' && req.method === 'POST') {
    return readJsonBody(req, (err, body) => {
      if (err) { res.writeHead(400); return res.end(err.message); }
      const tool_use_id = body && body.tool_use_id;
      const tool_name   = body && body.tool_name;
      if (!tool_use_id || !tool_name) {
        res.writeHead(400, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ error: 'tool_use_id and tool_name required' }));
      }
      // 이미 같은 tool_use_id 가 대기 중이면 종전 요청을 deny 처리하고 새 요청으로 교체.
      const prev = pendingPermissions.get(tool_use_id);
      if (prev) {
        try {
          prev.res.writeHead(200, {'Content-Type':'application/json'});
          prev.res.end(JSON.stringify({ behavior: 'deny', message: 'superseded' }));
        } catch {}
        if (prev.timer) clearTimeout(prev.timer);
        pendingPermissions.delete(tool_use_id);
      }
      const timeoutMs = Math.max(1000, Math.min(Number(body.timeoutMs) || 300000, 1800000));
      const sessionId = body.session || body.sessionId || null;
      const payload = { tool_name, input: body.input || {}, tool_use_id, sessionId };
      const timer = setTimeout(() => {
        const p = pendingPermissions.get(tool_use_id);
        if (!p) return;
        pendingPermissions.delete(tool_use_id);
        try {
          p.res.writeHead(200, {'Content-Type':'application/json'});
          p.res.end(JSON.stringify({ behavior: 'deny', message: 'timeout' }));
        } catch {}
      }, timeoutMs);
      pendingPermissions.set(tool_use_id, { res, timer, sessionId, payload });
      console.log(`[easyclaude] permit request: tool=${tool_name} id=${tool_use_id} sess=${sessionId||'-'}`);
      bridgeBroadcastPermission(sessionId, payload);
      // 클라이언트(소켓)가 끊기면 pending 정리. req.on('close')는 본문 종료 직후 발생하므로
      // 응답 측 close 만 감지해야 한다 (response sent 또는 socket disconnect).
      res.on('close', () => {
        if (res.writableEnded) return; // 정상 응답 끝났음 — 우리가 이미 정리함
        const p = pendingPermissions.get(tool_use_id);
        if (p && p.res === res) {
          pendingPermissions.delete(tool_use_id);
          if (p.timer) clearTimeout(p.timer);
        }
      });
    });
  }
  if (req.url === '/api/permitter/respond' && req.method === 'POST') {
    return readJsonBody(req, (err, body) => {
      if (err) { res.writeHead(400); return res.end(err.message); }
      const tool_use_id = body && body.tool_use_id;
      const behavior = body && body.behavior;
      if (!tool_use_id || (behavior !== 'allow' && behavior !== 'deny')) {
        res.writeHead(400, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ error: 'tool_use_id + behavior(allow|deny) required' }));
      }
      const out = { behavior };
      if (behavior === 'allow' && body.updatedInput !== undefined) out.updatedInput = body.updatedInput;
      if (body.message) out.message = String(body.message);
      const ok = resolvePermission(tool_use_id, out);
      res.writeHead(ok ? 200 : 404, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ ok }));
    });
  }
  if (req.url === '/api/permitter/pending' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify(
      [...pendingPermissions.entries()].map(([id, p]) => ({ tool_use_id: id, ...p.payload }))
    ));
  }

  // ── 디버그 엔드포인트 ────────────────────────────────────────────────────────
  // /api/debug/:sessionId/turns — parser snapshot 전체
  // /api/debug/:sessionId/raw   — 최근 raw JSON 라인 (lineLog)
  // /api/debug/:sessionId/usage — usage 누적
  const dbgMatch = req.url.match(/^\/api\/debug\/([^/]+)\/(turns|raw|usage|session)$/);
  if (dbgMatch) {
    const sid = dbgMatch[1], kind = dbgMatch[2];
    const ch = ptyChannels.get(sid);
    if (!ch) { res.writeHead(404); return res.end('session not running'); }
    res.writeHead(200, {'Content-Type':'application/json'});
    if (kind === 'turns')   return res.end(JSON.stringify(ch.parser.snapshot().turns, null, 2));
    if (kind === 'raw')     return res.end(JSON.stringify(ch.rawLog.slice(-200), null, 2));
    if (kind === 'usage')   return res.end(JSON.stringify(ch.parser.snapshot().session.usage, null, 2));
    if (kind === 'session') return res.end(JSON.stringify(ch.parser.snapshot().session, null, 2));
  }

  const urlPath = req.url.split('?')[0];
  let fp = path.join(CLIENT_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!fp.startsWith(CLIENT_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream'});
    res.end(data);
  });
});

// ── 영속 PTY 채널 ────────────────────────────────────────────────────────────
const ptyChannels = new Map();
// channel: { pty, sess, parser, lineBuf, rawLog, subscribers:Map<ws,Set<id>>, debounceTimer, lastTurnsJson }

function buildSpawnArgs(sess) {
  // defaultArgs + 세션별 args (argsOverride 우선) + (resume | session-id + name)
  const args = defaultArgs();
  const userArgs = sessionState[sess.id]?.argsOverride ?? sess.args;
  if (Array.isArray(userArgs)) args.push(...userArgs);

  // --permission-prompt-tool 가 있고 --mcp-config 는 없으면 easypermitter MCP 자동 주입
  const hasPromptTool = args.some(a => a === '--permission-prompt-tool');
  const hasMcpConfig  = args.some(a => a === '--mcp-config');
  let injectedEnv = null;
  if (hasPromptTool && !hasMcpConfig) {
    const mcpConfig = {
      mcpServers: {
        easypermitter: {
          type: 'stdio',
          command: 'node',
          args: [path.join(__dirname, 'easypermitter.js')],
        },
      },
    };
    args.push('--mcp-config', JSON.stringify(mcpConfig));
    injectedEnv = {
      EASYCLAUDE_HOST: HOST,
      EASYCLAUDE_PORT: String(PORT),
      EASYPERMITTER_SESSION: sess.id,
      EASYPERMITTER_TIMEOUT_MS: '300000',
    };
  }

  const saved = sessionState[sess.id];
  const existingId = saved?.claudeId;
  if (existingId) {
    // jsonl 파일 존재 확인 — 없으면 새 session-id 로 fallback
    if (claudeJsonlExists(existingId)) {
      args.push('--resume', existingId);
      return { args, isNew: false, claudeId: existingId, injectedEnv };
    } else {
      console.warn(`[easyclaude] resume target jsonl missing for ${sess.id} (claudeId=${existingId}); starting new session`);
    }
  }
  const newId = randomUUID();
  args.push('--session-id', newId);
  if (sess.name && !args.includes('--name') && !args.includes('-n')) {
    args.push('--name', sess.name);
  }
  return { args, isNew: true, claudeId: newId, injectedEnv };
}

function spawnSession(sess) {
  // 채널 영속 — proc 가 죽어도 ch 와 parser(turns history) 는 보존.
  // dormant 상태(proc=null)이면 재spawn.
  let ch = ptyChannels.get(sess.id);
  if (ch && ch.proc && ch.proc.exitCode === null) return ch;  // alive

  const isNewChannel = !ch;
  if (isNewChannel) {
    ch = {
      proc: null,
      sess,
      parser: null,
      lineBuf: '',
      rawLog: [],
      stderrLog: [],
      subscribers: new Map(),
      debounceTimer: null,
      lastTurnsJson: '',
      claudeId: null,
      pendingDialogs: new Map(),
      alive: false,
      inboxStop: null,     // IOA 인박스 watcher stop fn
      signedInAs: null,    // 현재 watcher가 추적 중인 ioa_id
    };
    ptyChannels.set(sess.id, ch);

    // broadcast / scheduleTurns 클로저는 한 번만 생성 (parser 와 함께)
    ch.broadcast = (msg) => {
      for (const [wsLocal, ids] of ch.subscribers) {
        if (wsLocal.readyState !== wsLocal.OPEN) continue;
        for (const cid of ids) wsLocal.send(JSON.stringify({ ...msg, id: cid }));
      }
    };
    ch.scheduleTurns = () => {
      if (ch.debounceTimer) return;
      ch.debounceTimer = setTimeout(() => {
        ch.debounceTimer = null;
        const snap = ch.parser.snapshot();
        const json = JSON.stringify(snap.turns);
        if (json === ch.lastTurnsJson) return;
        ch.lastTurnsJson = json;
        ch.broadcast({ op: 'turns', turns: snap.turns, usage: snap.session.usage });
      }, 40);
    };
    ch.parser = new StreamParser({
      onTurn: () => ch.scheduleTurns(),
      onTurnUpdate: () => ch.scheduleTurns(),
      onSystem: (session) => ch.broadcast({ op: 'system', session }),
      onUsage:  (usage)   => ch.broadcast({ op: 'usage', usage }),
      onResult: (result, usage) => ch.broadcast({ op: 'result', result, usage }),
      onAskUserQuestion: ({ tool_use_id, input }) => {
        ch.pendingDialogs.set(tool_use_id, { input });
        ch.broadcast({ op: 'dialog', kind: 'AskUserQuestion', tool_use_id, input });
      },
      onHook: (evt) => ch.broadcast({ op: 'hook', event: evt }),
    });
  }

  // proc spawn
  const { args, isNew, claudeId, injectedEnv } = buildSpawnArgs(sess);
  if (isNew) {
    sessionState[sess.id] = {
      ...(sessionState[sess.id] || {}),
      claudeId,
      name: sess.name,
      cwd: sess.cwd,
      createdAt: sessionState[sess.id]?.createdAt || new Date().toISOString(),
    };
    saveState(sessionState);
  }
  ch.claudeId = claudeId;
  console.log(`[easyclaude] spawn ${sess.id} (${claudeId}) → claude ${args.join(' ')}`);

  const childEnv = {
    ...process.env,
    ...defaultClaudeEnv(),
    ...(injectedEnv || {}),
  };
  if (sess.home) childEnv.HOME = sess.home;

  const proc = spawn('claude', args, {
    cwd: sess.cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdin.on('error', err => {
    console.error(`[easyclaude:${sess.id}:stdin] ${err.code || err.message}`);
  });

  ch.proc = proc;
  ch.alive = true;
  ch.lineBuf = '';

  proc.stdout.on('data', data => {
    ch.lineBuf += data;
    let nl;
    while ((nl = ch.lineBuf.indexOf('\n')) >= 0) {
      const line = ch.lineBuf.slice(0, nl).replace(/\r$/, '');
      ch.lineBuf = ch.lineBuf.slice(nl + 1);
      if (line) {
        ch.rawLog.push(line);
        if (ch.rawLog.length > 200) ch.rawLog.shift();
        ch.parser.feedLine(line);
        maybeStartInboxFromLine(ch, line);
      }
    }
  });

  proc.stderr.on('data', data => {
    const txt = String(data);
    console.error(`[easyclaude:${sess.id}:stderr] ${txt.trim()}`);
    ch.stderrLog.push(txt);
    if (ch.stderrLog.length > 100) ch.stderrLog.shift();
  });

  proc.on('exit', (exitCode, signal) => {
    console.log(`[easyclaude] claude exited: ${sess.id} (code=${exitCode}, signal=${signal})`);
    if (ch.debounceTimer) { clearTimeout(ch.debounceTimer); ch.debounceTimer = null; }
    if (ch.inboxStop) { try { ch.inboxStop(); } catch {} ch.inboxStop = null; ch.signedInAs = null; }
    const snap = ch.parser.snapshot();
    ch.broadcast({ op: 'turns', turns: snap.turns, usage: snap.session.usage });
    ch.broadcast({ op: 'closed', exitCode, signal, stderr: ch.stderrLog.join('').slice(-2000) });
    ch.alive = false;
    ch.proc = null;
    // ch 자체는 ptyChannels 에 유지 — parser/turns 보존
  });

  proc.on('error', err => {
    console.error(`[easyclaude] spawn error ${sess.id}:`, err.message);
    ch.broadcast({ op: 'closed', error: err.message });
    ch.alive = false;
    ch.proc = null;
  });

  return ch;
}

// ── IOA 인박스 watcher trigger ───────────────────────────────────────────────
// claude의 stdout 라인을 보고 signin/signup tool_result 감지 → watcher 자동 시작/교체.
function maybeStartInboxFromLine(ch, line) {
  const identity = detectAgentIdentity(line);
  if (!identity) return;
  if (ch.signedInAs === identity.ioa_id && ch.inboxStop) return; // 이미 watching 중
  if (ch.inboxStop) { try { ch.inboxStop(); } catch {} ch.inboxStop = null; }
  ch.signedInAs = identity.ioa_id;
  ch.inboxStop = startInboxWatcher(identity.data_dir, (event) => {
    const text = eventToChannelText(event, identity.ioa_id);
    sendUserText(ch, text);
  });
  console.log(`[easyclaude] inbox watcher: ${ch.sess.id} → ${identity.ioa_id} (${identity.data_dir})`);
}

// ── 입력 헬퍼 ────────────────────────────────────────────────────────────────
function sendUserText(ch, text) {
  if (!ch.proc || ch.proc.exitCode !== null) {
    // dormant 채널 — 자동 재spawn (대화 이력 보존)
    spawnSession(ch.sess);
  }
  if (!ch.proc) return false;
  const line = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }) + '\n';
  try { ch.proc.stdin.write(line); return true; }
  catch (e) { console.error(`[easyclaude] stdin write fail: ${e.message}`); return false; }
}

function sendToolResult(ch, tool_use_id, content, isError) {
  if (!ch.proc || ch.proc.exitCode !== null) {
    spawnSession(ch.sess);
  }
  if (!ch.proc) return false;
  const contentArr = typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : (Array.isArray(content) ? content : [{ type: 'text', text: JSON.stringify(content) }]);
  const line = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id,
        content: contentArr,
        is_error: !!isError,
      }],
    },
  }) + '\n';
  try { ch.proc.stdin.write(line); return true; }
  catch (e) { console.error(`[easyclaude] tool_result write fail: ${e.message}`); return false; }
}

// ── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  const wsChannels = new Map(); // clientId → { sessionId }
  const send = obj => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { op, id } = msg;

    if (op === 'list') {
      return send({
        op: 'sessions',
        list: sessions().map(serializeForClient),
      });
    }

    if (op === 'create_session') {
      const { label, cwd, name, args, home } = msg;
      if (!label || !cwd) {
        return send({ op: 'error', id, message: 'label and cwd are required' });
      }
      const slug = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'session';
      let newId = slug;
      let i = 1;
      while (findSession(newId)) newId = `${slug}-${++i}`;
      const sess = normalizeSession({
        id: newId,
        label,
        cwd,
        name: name || label,
        args: Array.isArray(args) ? args : [],
        home: home || null,
        meta: { adhoc: true },
      });
      runtimeSessions.set(newId, sess);
      // 모든 연결 클라이언트에 새 sessions 목록 broadcast
      broadcastSessions();
      return send({ op: 'session_created', id, sessionId: newId });
    }

    if (op === 'delete_session') {
      const { sessionId } = msg;
      if (!runtimeSessions.has(sessionId)) {
        return send({ op: 'error', id, message: 'cannot delete (not adhoc or unknown)' });
      }
      const ch = ptyChannels.get(sessionId);
      if (ch) { try { ch.proc.kill(); } catch {} ptyChannels.delete(sessionId); }
      runtimeSessions.delete(sessionId);
      delete sessionState[sessionId];
      saveState(sessionState);
      broadcastSessions();
      return send({ op: 'session_deleted', id, sessionId });
    }

    if (op === 'purge_session') {
      // delete_session 보다 강함: claude jsonl 파일까지 삭제. claudeId 명시 가능.
      // cfg 세션도 hide. (config 파일은 수정하지 않음 — 메모리 hide 플래그로 처리)
      const { sessionId, claudeId } = msg;
      const targetClaudeId = claudeId || sessionState[sessionId]?.claudeId;
      const isCfg = (cfg.sessions || []).some(s => s.id === sessionId);
      if (sessionId) {
        const ch = ptyChannels.get(sessionId);
        if (ch) { try { ch.proc.kill(); } catch {} ptyChannels.delete(sessionId); }
        if (runtimeSessions.has(sessionId)) {
          runtimeSessions.delete(sessionId);
          delete sessionState[sessionId];
        } else if (isCfg) {
          // cfg 세션: hidden 플래그만 set (config 파일 보존, 재시작 후에도 hidden 유지)
          sessionState[sessionId] = { ...(sessionState[sessionId] || {}), hidden: true };
        } else {
          delete sessionState[sessionId];
        }
        saveState(sessionState);
      }
      let removedFiles = 0;
      if (targetClaudeId) removedFiles = deleteClaudeSessionFile(targetClaudeId);
      broadcastSessions();
      return send({ op: 'session_purged', id, sessionId, claudeId: targetClaudeId, removedFiles, hidden: isCfg });
    }

    if (op === 'unhide_session') {
      // hidden 플래그 해제 — cfg 세션 복원 (사용자가 잘못 누른 경우)
      const { sessionId } = msg;
      if (sessionState[sessionId]?.hidden) {
        delete sessionState[sessionId].hidden;
        if (Object.keys(sessionState[sessionId]).length === 0) delete sessionState[sessionId];
        saveState(sessionState);
        const list = sessions().map(s => ({ id: s.id, label: s.label, args: s.args, cwd: s.cwd, meta: s.meta }));
        wss.clients.forEach(c => {
          if (c.readyState === c.OPEN) c.send(JSON.stringify({ op: 'sessions', list }));
        });
      }
      return send({ op: 'session_unhidden', id, sessionId });
    }

    if (op === 'resume_session') {
      // 기존 claude session(uuid)을 ad-hoc 세션으로 import.
      const { label, cwd, name, args, claudeId, home } = msg;
      if (!claudeId || !cwd) {
        return send({ op: 'error', id, message: 'claudeId and cwd required' });
      }
      const slug = String(label || claudeId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'resumed';
      let newId = slug;
      let i = 1;
      while (findSession(newId)) newId = `${slug}-${++i}`;
      const sess = normalizeSession({
        id: newId,
        label: label || `resumed:${claudeId.slice(0,8)}`,
        cwd,
        name: name || label || null,
        args: Array.isArray(args) ? args : [],
        home: home || null,
        meta: { adhoc: true, resumed: true, fromClaudeId: claudeId },
      });
      runtimeSessions.set(newId, sess);
      // sessionState 에 claudeId 미리 설정 → spawn 시 --resume 사용
      sessionState[newId] = {
        claudeId, name: sess.name, cwd: sess.cwd,
        createdAt: new Date().toISOString(),
        resumedFrom: claudeId,
      };
      saveState(sessionState);
      broadcastSessions();
      return send({ op: 'session_created', id, sessionId: newId, resumed: true });
    }

    if (op === 'open') {
      if (wsChannels.has(id)) return send({ op: 'error', id, message: 'already open' });
      const sess = sessions().find(s => s.id === msg.sessionId);
      if (!sess) return send({ op: 'error', id, message: `unknown session: ${msg.sessionId}` });

      const ch = spawnSession(sess);
      if (!ch.subscribers.has(ws)) ch.subscribers.set(ws, new Set());
      ch.subscribers.get(ws).add(id);
      wsChannels.set(id, { sessionId: sess.id });

      send({
        op: 'opened', id,
        info: { pid: ch.proc.pid, sessionId: sess.id, label: sess.label, claudeId: ch.claudeId, ...sess.meta },
      });
      // 즉시 현재 turns + 보류 다이얼로그 송신 (catch-up)
      const snap = ch.parser.snapshot();
      send({ op: 'turns', id, turns: snap.turns, usage: snap.session.usage });
      if (snap.session.id) send({ op: 'system', id, session: snap.session });
      for (const [tool_use_id, pending] of ch.pendingDialogs) {
        send({ op: 'dialog', id, kind: 'AskUserQuestion', tool_use_id, input: pending.input });
      }
      return;
    }

    if (op === 'input') {
      const att = wsChannels.get(id);
      if (!att) return;
      const ch = ptyChannels.get(att.sessionId);
      if (!ch) return;
      let text = msg.data;
      if (!text || !text.trim()) return;
      text = maybeBashShortcut(text);
      sendUserText(ch, text);
      return;
    }

    if (op === 'interrupt') {
      // claude TUI의 ESC (현재 turn 중단) 상응. stream-json control_request 발사.
      // 출처: 비공식이나 reverse-engineering으로 확인된 control_request 프로토콜.
      const att = wsChannels.get(id);
      if (!att) return;
      const ch = ptyChannels.get(att.sessionId);
      if (!ch || !ch.proc || ch.proc.exitCode !== null) {
        return send({ op: 'error', id, message: 'session not running' });
      }
      const requestId = `int-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
      const line = JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'interrupt' },
      }) + '\n';
      try {
        ch.proc.stdin.write(line);
        send({ op: 'interrupt_sent', id, request_id: requestId });
      } catch (e) {
        send({ op: 'error', id, message: `interrupt write fail: ${e.message}` });
      }
      return;
    }

    if (op === 'dialog_response') {
      // AskUserQuestion 답변 송신
      const att = wsChannels.get(id);
      if (!att) return;
      const ch = ptyChannels.get(att.sessionId);
      if (!ch) return;
      const { tool_use_id, answers, cancelled } = msg;
      if (!ch.pendingDialogs.has(tool_use_id)) {
        return send({ op: 'error', id, message: `unknown tool_use_id: ${tool_use_id}` });
      }
      ch.pendingDialogs.delete(tool_use_id);
      const payload = cancelled ? '<cancelled>' : JSON.stringify({ answers });
      sendToolResult(ch, tool_use_id, payload, !!cancelled);
      return;
    }

    if (op === 'permission_response') {
      // GUI 측 권한 모달 결과를 받아 pending HTTP long-poll 응답을 해결한다.
      const { tool_use_id, behavior, updatedInput, message } = msg;
      if (!tool_use_id || (behavior !== 'allow' && behavior !== 'deny')) {
        return send({ op: 'error', id, message: 'permission_response requires tool_use_id + behavior' });
      }
      const out = { behavior };
      if (behavior === 'allow' && updatedInput !== undefined) out.updatedInput = updatedInput;
      if (message) out.message = String(message);
      const ok = resolvePermission(tool_use_id, out);
      send({ op: 'permission_resolved', id, tool_use_id, ok });
      return;
    }

    if (op === 'interrupt') {
      // Ctrl+C 같은 인터럽트
      const att = wsChannels.get(id);
      if (!att) return;
      const ch = ptyChannels.get(att.sessionId);
      if (!ch) return;
      try { ch.proc.kill('SIGINT'); } catch {}
      return;
    }

    if (op === 'restart') {
      // 세션 재기동 — claudeId 보존, claude proc만 재spawn. args override 가능.
      const att = wsChannels.get(id);
      if (!att) return;
      if (msg.args !== undefined) {
        sessionState[att.sessionId] = sessionState[att.sessionId] || {};
        if (Array.isArray(msg.args)) sessionState[att.sessionId].argsOverride = msg.args;
        else delete sessionState[att.sessionId].argsOverride;
        saveState(sessionState);
      }
      const ch = ptyChannels.get(att.sessionId);
      if (ch && ch.proc) {
        try { ch.proc.kill(); } catch {}
        ch.proc = null;     // 즉시 dormant 처리 (spawnSession 이 respawn 하도록)
        ch.alive = false;
      }
      const sess = sessions().find(s => s.id === att.sessionId);
      if (!sess) return;
      const nch = spawnSession(sess);
      if (!nch.subscribers.has(ws)) nch.subscribers.set(ws, new Set());
      nch.subscribers.get(ws).add(id);
      broadcastSessions();
      send({ op: 'restarted', id, claudeId: nch.claudeId, alive: nch.alive });
      return;
    }

    if (op === 'close') {
      const att = wsChannels.get(id);
      if (!att) return;
      const ch = ptyChannels.get(att.sessionId);
      if (ch) {
        const ids = ch.subscribers.get(ws);
        if (ids) { ids.delete(id); if (ids.size === 0) ch.subscribers.delete(ws); }
      }
      wsChannels.delete(id);
      send({ op: 'detached', id });
      return;
    }
  });

  ws.on('close', () => {
    for (const ch of ptyChannels.values()) ch.subscribers.delete(ws);
    wsChannels.clear();
  });
});

// ── 안전망: uncaught → 로깅, process 유지 ────────────────────────────────────
process.on('uncaughtException', err => {
  console.error('[easyclaude:uncaught]', err && err.stack || err);
});
process.on('unhandledRejection', err => {
  console.error('[easyclaude:unhandledRejection]', err && err.stack || err);
});

// ── Shutdown ─────────────────────────────────────────────────────────────────
function shutdown() {
  saveState(sessionState);
  // 대기 중인 권한 요청은 모두 deny 로 닫는다 (claude 가 영원히 멈추지 않도록)
  for (const [tool_use_id, p] of pendingPermissions) {
    if (p.timer) clearTimeout(p.timer);
    try {
      p.res.writeHead(200, {'Content-Type':'application/json'});
      p.res.end(JSON.stringify({ behavior: 'deny', message: 'server shutdown' }));
    } catch {}
  }
  pendingPermissions.clear();
  for (const ch of ptyChannels.values()) { try { ch.proc.kill(); } catch {} }
  ptyChannels.clear();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

server.listen(PORT, HOST, () => {
  console.log(`[easyclaude] ${HOST}:${PORT}`);
  console.log(`[easyclaude] sessions: ${sessions().map(s => s.id).join(', ') || '(none)'}`);
});
