'use strict';
// easyclaude supervisor daemon — per-session supervisor.js 여러 프로세스를 단일 프로세스로 통합.
// 관리 소켓(DAEMON_SOCK)으로 spawn/destroy/list 명령 수신.
// 각 세션은 supervisor.js와 동일한 unix socket 프로토콜 유지.
//
// 호출: nohup setsid node sup-daemon.js <daemon-sock-path> > <log> 2>&1 &
//
// 관리 프로토콜 (newline-delimited JSON):
//   EC→Daemon:
//     {"op":"spawn","sid":"...","sockPath":"...","pidPath":"...","cwd":"...","args":[...],"env":{...}}
//     {"op":"destroy","sid":"..."}   — 세션 강제 종료 + 소켓/pid 제거
//     {"op":"kill","sid":"...","signal":"SIGTERM"}
//     {"op":"list"}
//   Daemon→EC:
//     {"op":"spawned","sid":"..."}
//     {"op":"destroyed","sid":"..."}
//     {"op":"list","sessions":[...]}
//
// 세션 소켓 프로토콜 (supervisor.js와 동일):
//   Daemon→EC: hello(exited/exitInfo 포함), stdout, stderr, exit
//   EC→Daemon: input, kill, shutdown

'use strict';

const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const DAEMON_SOCK = process.argv[2];
if (!DAEMON_SOCK) {
  console.error('usage: sup-daemon.js <mgmt-sock>');
  process.exit(2);
}

// ── 세션 상태 ─────────────────────────────────────────────────────────────────
const sessions = new Map(); // sid → session object

function createSession(sid, sockPath, pidPath, cwd, args, env) {
  const existing = sessions.get(sid);
  if (existing) {
    if (existing.isExited()) {
      console.log(`[sup-daemon:${sid}] existing session is exited — destroy + recreate`);
      destroySession(sid);
    } else {
      console.log(`[sup-daemon:${sid}] already alive — skip spawn`);
      return;
    }
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

  // pid 파일 기록
  try { fs.mkdirSync(path.dirname(pidPath), { recursive: true }); } catch {}
  try { fs.writeFileSync(pidPath, String(proc.pid)); } catch {}

  const buffer = [];
  const MAX_BUFFER = 2000;
  const conns = new Set();
  let exited = false;
  let exitInfo = null;

  function broadcast(obj) {
    const line = JSON.stringify(obj) + '\n';
    for (const c of conns) try { c.write(line); } catch {}
  }

  function remember(op, data) {
    buffer.push({ op, data });
    while (buffer.length > MAX_BUFFER) buffer.shift();
  }

  proc.stdout.on('data', d => { remember('stdout', d); broadcast({ op: 'stdout', data: d }); });
  proc.stderr.on('data', d => {
    remember('stderr', d);
    broadcast({ op: 'stderr', data: d });
    // 진단용: stderr는 파일로도 캡처 (daemon 로그에 남도록)
    const s = String(d).trim();
    if (s) console.error(`[sup-daemon:${sid}:stderr] ${s.slice(0, 500)}`);
  });
  proc.on('exit', (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
    console.log(`[sup-daemon:${sid}] claude exited code=${code} signal=${signal} pid=${proc.pid}`);
    broadcast({ op: 'exit', code, signal });
  });
  proc.on('error', err => {
    console.error(`[sup-daemon:${sid}] spawn error: ${err.message}`);
    exited = true;
    exitInfo = { code: -1, signal: null };
    broadcast({ op: 'exit', code: -1, signal: null, error: err.message });
  });

  // 세션 unix socket 서버 — EC에서 직접 연결
  try { fs.unlinkSync(sockPath); } catch {}
  fs.mkdirSync(path.dirname(sockPath), { recursive: true });
  const server = net.createServer(conn => {
    conns.add(conn);
    // hello + catch-up (exit replay 없음 — hello의 exited 플래그로 EC가 판단)
    try {
      // proc.exitCode === null → 명시적 "살아있다" 확인. null state 혼동 방지.
      const alive = proc.exitCode === null;
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
          const hex = Buffer.from(msg.data).toString('hex');
          if (hex.length <= 64) console.log(`[sup-daemon:${sid}:stdin] hex=${hex} str=${JSON.stringify(msg.data)}`);
          try { proc.stdin.write(msg.data); } catch {}
        } else if (msg.op === 'kill') {
          try { proc.kill(msg.signal || 'SIGTERM'); } catch {}
        } else if (msg.op === 'shutdown') {
          try { proc.kill('SIGTERM'); } catch {}
          setTimeout(() => destroySession(sid), 500);
        }
      }
    });
    conn.on('error', () => {});
    conn.on('close', () => conns.delete(conn));
  });

  server.listen(sockPath, () => {
    try { fs.chmodSync(sockPath, 0o600); } catch {}
    console.log(`[sup-daemon:${sid}] pid=${process.pid} claude=${proc.pid} sock=${sockPath}`);
  });
  server.on('error', err => console.error(`[sup-daemon:${sid}] socket error: ${err.message}`));

  sessions.set(sid, {
    proc, server, sockPath, pidPath,
    isExited: () => exited,
    kill: (sig) => { try { proc.kill(sig || 'SIGTERM'); } catch {} },
  });
}

function destroySession(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  s.kill('SIGKILL');
  if (s.server) try { s.server.close(); } catch {}
  try { fs.unlinkSync(s.sockPath); } catch {}
  try { fs.unlinkSync(s.pidPath); } catch {}
  sessions.delete(sid);
  console.log(`[sup-daemon] destroyed: ${sid}`);
}

// ── 관리 소켓 ─────────────────────────────────────────────────────────────────
try { fs.unlinkSync(DAEMON_SOCK); } catch {}
fs.mkdirSync(path.dirname(DAEMON_SOCK), { recursive: true });

const mgmtServer = net.createServer(conn => {
  let inbuf = '';
  conn.on('data', d => {
    inbuf += String(d);
    let nl;
    while ((nl = inbuf.indexOf('\n')) >= 0) {
      const line = inbuf.slice(0, nl); inbuf = inbuf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.op === 'spawn') {
        createSession(msg.sid, msg.sockPath, msg.pidPath, msg.cwd, msg.args, msg.env || {});
        try { conn.write(JSON.stringify({ op: 'spawned', sid: msg.sid }) + '\n'); } catch {}
      } else if (msg.op === 'destroy') {
        destroySession(msg.sid);
        try { conn.write(JSON.stringify({ op: 'destroyed', sid: msg.sid }) + '\n'); } catch {}
      } else if (msg.op === 'kill') {
        const s = sessions.get(msg.sid);
        if (s) s.kill(msg.signal);
      } else if (msg.op === 'list') {
        const list = [...sessions.entries()].map(([sid, s]) => ({
          sid, claudePid: s.proc?.pid, exited: s.isExited(),
        }));
        try { conn.write(JSON.stringify({ op: 'list', sessions: list }) + '\n'); } catch {}
      }
    }
  });
  conn.on('error', () => {});
});

mgmtServer.listen(DAEMON_SOCK, () => {
  try { fs.chmodSync(DAEMON_SOCK, 0o600); } catch {}
  console.log(`[sup-daemon] started pid=${process.pid} mgmt=${DAEMON_SOCK}`);
});
mgmtServer.on('error', err => {
  console.error('[sup-daemon] mgmt error:', err.message);
  process.exit(1);
});

// 종료 시 모든 세션 정리
process.on('SIGTERM', () => {
  for (const [sid] of [...sessions]) destroySession(sid);
  setTimeout(() => process.exit(0), 1000);
});
process.on('SIGINT', () => {
  for (const [sid] of [...sessions]) destroySession(sid);
  setTimeout(() => process.exit(0), 500);
});
