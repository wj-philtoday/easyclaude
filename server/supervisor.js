'use strict';
// easyclaude supervisor — 단일 프로세스로 모든 claude 세션 관리.
// EC server의 관리 소켓 요청을 받아 세션 생사를 처리하고,
// 각 세션 I/O를 per-session unix socket으로 노출.
//
// 실행: nohup setsid node supervisor.js <mgmt-sock> <pid-file> >> <log> 2>&1 &
//
// 서버 → 수퍼바이저 (관리 소켓):
//   {"op":"spawn","sid":"...","sockPath":"...","pidPath":"...","cwd":"...","args":[...],"env":{}}
//   {"op":"kill","sid":"...","signal":"SIGTERM"}
//   {"op":"destroy","sid":"..."}
//   {"op":"list"}
//
// 수퍼바이저 → 서버 (관리 소켓):
//   {"op":"sessions","list":[...]}  ← 연결 즉시 전송 (서버가 ec-system 주입 여부 판단)
//   {"op":"spawned","sid":"...","pid":N}
//   {"op":"exited","sid":"...","code":N,"signal":null}
//
// 세션 소켓 프로토콜:
//   수퍼→서버: hello(alive, bufferedChunks), stdout, stderr, exit
//   서버→수퍼: input, kill, shutdown

const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const MGMT_SOCK = process.argv[2];
const PID_FILE  = process.argv[3];
if (!MGMT_SOCK) { console.error('usage: supervisor.js <mgmt-sock> [pid-file]'); process.exit(2); }

const sessions  = new Map(); // sid → session object
const mgmtConns = new Set(); // 활성 관리 연결

// ── 세션 생성/제거 ────────────────────────────────────────────────────────────
const SUP_LOG = process.env.HOME ? process.env.HOME + '/tmp/supervisor-events.log' : '/tmp/supervisor-events.log';
function supLog(msg) { try { require('fs').appendFileSync(SUP_LOG, `${msg} ts=${Date.now()}\n`); } catch {} }

function createSession(sid, sockPath, pidPath, cwd, args, env) {
  supLog(`[createSession] sid=${sid}`);
  // 동일 UUID로 이미 살아있는 프로세스가 있으면 중복 소환 방지
  const existing = sessions.get(sid);
  if (existing) {
    if (existing.proc.exitCode === null) {
      supLog(`[createSession:skip] sid=${sid} already alive`);
      console.log(`[supervisor:${sid}] already alive pid=${existing.proc.pid} — skip`);
      return existing.proc.pid;
    }
    // 종료된 세션 정리 후 재생성
    _cleanupSession(sid, false);
  }

  const childEnv = { ...env };
  const claudeBin = childEnv._EC_CLAUDE_BIN || 'claude';
  delete childEnv._EC_CLAUDE_BIN;
  delete childEnv.CLAUDE_CODE_SESSION_ID;
  delete childEnv.CLAUDE_CODE_ENTRYPOINT;

  const proc = spawn(claudeBin, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdin.on('error', () => {});

  // pid 기록
  try { fs.mkdirSync(path.dirname(pidPath), { recursive: true }); } catch {}
  try { fs.writeFileSync(pidPath, String(proc.pid)); } catch {}

  const buffer  = [];
  const MAX_BUF = 2000;
  const conns   = new Set();

  function broadcastSession(obj) {
    const line = JSON.stringify(obj) + '\n';
    for (const c of conns) try { c.write(line); } catch {}
  }
  function broadcastMgmt(obj) {
    const line = JSON.stringify(obj) + '\n';
    for (const c of mgmtConns) try { c.write(line); } catch {}
  }

  proc.stdout.on('data', d => {
    buffer.push({ op: 'stdout', data: d });
    while (buffer.length > MAX_BUF) buffer.shift();
    broadcastSession({ op: 'stdout', data: d });
  });
  proc.stderr.on('data', d => {
    buffer.push({ op: 'stderr', data: d });
    while (buffer.length > MAX_BUF) buffer.shift();
    broadcastSession({ op: 'stderr', data: d });
    const s = String(d).trim();
    if (s) console.error(`[supervisor:${sid}:stderr] ${s.slice(0, 400)}`);
  });
  proc.on('exit', (code, signal) => {
    console.log(`[supervisor:${sid}] exited code=${code} signal=${signal} pid=${proc.pid}`);
    broadcastSession({ op: 'exit', code, signal });
    broadcastMgmt({ op: 'exited', sid, code, signal });
  });
  proc.on('error', err => {
    console.error(`[supervisor:${sid}] spawn error: ${err.message}`);
    broadcastSession({ op: 'exit', code: -1, signal: null, error: err.message });
    broadcastMgmt({ op: 'exited', sid, code: -1, signal: null, error: err.message });
  });

  // 세션 I/O 소켓 서버
  try { fs.unlinkSync(sockPath); } catch {}
  fs.mkdirSync(path.dirname(sockPath), { recursive: true });
  const server = net.createServer(conn => {
    conns.add(conn);
    // proc.exitCode === null → 명시적 alive 확인 (null state 혼동 방지)
    const alive = proc.exitCode === null;
    supLog(`[session-socket:conn] sid=${sid} alive=${alive}`);
    try {
      conn.write(JSON.stringify({
        op: 'hello', sid,
        claudePid: proc.pid,
        bufferedChunks: buffer.length,
        alive,
        exitInfo: alive ? null : { code: proc.exitCode },
      }) + '\n');
      for (const e of buffer) conn.write(JSON.stringify(e) + '\n');
    } catch {}

    let inbuf = '';
    conn.on('data', d => {
      inbuf += String(d);
      let nl;
      while ((nl = inbuf.indexOf('\n')) >= 0) {
        const line = inbuf.slice(0, nl); inbuf = inbuf.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.op === 'input' && typeof msg.data === 'string') {
          // 진단용 stdin 로그 (짧은 입력만)
          const hex = Buffer.from(msg.data).toString('hex');
          if (hex.length <= 64) console.log(`[supervisor:${sid}:stdin] hex=${hex} str=${JSON.stringify(msg.data)}`);
          try { proc.stdin.write(msg.data); } catch {}
        } else if (msg.op === 'kill') {
          try { proc.kill(msg.signal || 'SIGTERM'); } catch {}
        } else if (msg.op === 'shutdown') {
          // 명시적 세션 종료 요청
          try { proc.kill('SIGTERM'); } catch {}
          setTimeout(() => destroySession(sid), 300);
        }
      }
    });
    conn.on('error', () => {});
    conn.on('close', () => conns.delete(conn));
  });
  server.listen(sockPath, () => {
    try { fs.chmodSync(sockPath, 0o600); } catch {}
    console.log(`[supervisor:${sid}] pid=${process.pid} claude=${proc.pid} sock=${sockPath}`);
  });
  server.on('error', err => console.error(`[supervisor:${sid}] socket error: ${err.message}`));

  sessions.set(sid, { proc, server, sockPath, pidPath });
  return proc.pid;
}

function _cleanupSession(sid, unlinkFiles) {
  const s = sessions.get(sid);
  if (!s) return;
  try { s.proc.kill('SIGKILL'); } catch {}
  if (s.server) try { s.server.close(); } catch {}
  if (unlinkFiles) {
    try { fs.unlinkSync(s.sockPath); } catch {}
    try { fs.unlinkSync(s.pidPath); } catch {}
  }
  sessions.delete(sid);
}

function destroySession(sid) {
  _cleanupSession(sid, true);
  console.log(`[supervisor] destroyed: ${sid}`);
}

// ── 관리 소켓 ─────────────────────────────────────────────────────────────────
try { fs.unlinkSync(MGMT_SOCK); } catch {}
fs.mkdirSync(path.dirname(MGMT_SOCK), { recursive: true });

const mgmtServer = net.createServer(conn => {
  mgmtConns.add(conn);
  // 연결 즉시 세션 목록 전송 — 서버가 재시작 후 ec-system 주입 여부 결정
  const list = [...sessions.entries()].map(([sid, s]) => ({
    sid,
    pid: s.proc.pid,
    alive: s.proc.exitCode === null,
    sockPath: s.sockPath,
  }));
  try { conn.write(JSON.stringify({ op: 'sessions', list }) + '\n'); } catch {}

  let inbuf = '';
  conn.on('data', d => {
    inbuf += String(d);
    let nl;
    while ((nl = inbuf.indexOf('\n')) >= 0) {
      const line = inbuf.slice(0, nl); inbuf = inbuf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.op === 'spawn') {
        const pid = createSession(msg.sid, msg.sockPath, msg.pidPath, msg.cwd, msg.args, msg.env || {});
        try { conn.write(JSON.stringify({ op: 'spawned', sid: msg.sid, pid }) + '\n'); } catch {}
      } else if (msg.op === 'kill') {
        const s = sessions.get(msg.sid);
        if (s) try { s.proc.kill(msg.signal || 'SIGTERM'); } catch {}
      } else if (msg.op === 'destroy') {
        destroySession(msg.sid);
        try { conn.write(JSON.stringify({ op: 'destroyed', sid: msg.sid }) + '\n'); } catch {}
      } else if (msg.op === 'list') {
        const list = [...sessions.entries()].map(([sid, s]) => ({
          sid, pid: s.proc.pid, alive: s.proc.exitCode === null,
        }));
        try { conn.write(JSON.stringify({ op: 'sessions', list }) + '\n'); } catch {}
      }
    }
  });
  conn.on('error', () => {});
  conn.on('close', () => mgmtConns.delete(conn));
});

mgmtServer.listen(MGMT_SOCK, () => {
  try { fs.chmodSync(MGMT_SOCK, 0o600); } catch {}
  console.log(`[supervisor] started pid=${process.pid} mgmt=${MGMT_SOCK}`);
});
mgmtServer.on('error', err => {
  console.error('[supervisor] mgmt error:', err.message);
  process.exit(1);
});

// supervisor 자신의 pid 기록
if (PID_FILE) {
  try { fs.mkdirSync(path.dirname(PID_FILE), { recursive: true }); } catch {}
  try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}
}

// 종료 처리 — server restart 시 SIGTERM 받지 않음, 전체 종료 시에만
process.on('SIGTERM', () => {
  console.log('[supervisor] SIGTERM — cleanup all sessions');
  for (const [sid] of [...sessions]) destroySession(sid);
  setTimeout(() => process.exit(0), 500);
});
process.on('SIGINT', () => {
  for (const [sid] of [...sessions]) destroySession(sid);
  setTimeout(() => process.exit(0), 300);
});
