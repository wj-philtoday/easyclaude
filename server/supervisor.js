'use strict';
// easyclaude supervisor — 각 세션마다 별도 process로 spawn되어 claude를 직접 자식으로 유지.
// stdin/stdout/stderr 를 unix socket 로 expose. ec server 가 재기동돼도 supervisor 와 claude 는
// 살아있다. 새 ec server 가 같은 socket 에 reconnect 하면 최근 N 라인 buffer 가 catch-up 으로 흘러나옴.
//
// 호출 방식 (ec server 에서):
//   nohup setsid node /opt/easyclaude/server/supervisor.js \
//     <sid> <sockPath> <pidPath> <cwd> '<argsJson>' '<envJson>' \
//     > <logPath> 2>&1 < /dev/null &
//
// 프로토콜 (newline-delimited JSON):
//   server→supervisor:
//     {"op":"input","data":"...line...\\n"}   stdin 으로 그대로 forward
//     {"op":"kill","signal":"SIGTERM"}        claude 에 시그널
//     {"op":"shutdown"}                       supervisor 자체 종료
//   supervisor→server:
//     {"op":"stdout","data":"..."}            claude stdout chunk
//     {"op":"stderr","data":"..."}            claude stderr chunk
//     {"op":"exit","code":N,"signal":null}    claude 종료
//     {"op":"hello","claudePid":N,"bufferedChunks":K}
'use strict';

const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const SID   = process.argv[2];
const SOCK  = process.argv[3];
const PIDF  = process.argv[4];
const CWD   = process.argv[5];
let ARGS = [];
let ENV  = {};
try { ARGS = JSON.parse(process.argv[6] || '[]'); } catch {}
try { ENV  = JSON.parse(process.argv[7] || '{}'); } catch {}

if (!SID || !SOCK) { console.error('usage: supervisor.js <sid> <sock> <pid> <cwd> <argsJson> <envJson>'); process.exit(2); }

const childEnv = { ...process.env, ...ENV };
// EC가 삭제한 claude 세션 관련 env vars가 process.env에서 다시 유입되지 않도록 제거
delete childEnv.CLAUDE_CODE_SESSION_ID;
delete childEnv.CLAUDE_CODE_ENTRYPOINT;

// pid 파일 기록
try { fs.mkdirSync(path.dirname(PIDF), { recursive: true }); } catch {}
try { fs.writeFileSync(PIDF, String(process.pid)); } catch {}

const proc = spawn('claude', ARGS, { cwd: CWD, env: childEnv, stdio: ['pipe','pipe','pipe'] });
proc.stdout.setEncoding('utf8');
proc.stderr.setEncoding('utf8');

const conns = new Set();
const buffer = [];                  // catch-up용 최근 chunk
const MAX_BUFFER = 2000;
let exited = false;
let exitInfo = null;

function broadcast(obj) {
  const line = JSON.stringify(obj) + '\n';
  for (const c of conns) {
    try { c.write(line); } catch {}
  }
}

function rememberOutput(op, data) {
  buffer.push({ op, data });
  while (buffer.length > MAX_BUFFER) buffer.shift();
}

proc.stdout.on('data', d => { rememberOutput('stdout', d); broadcast({ op: 'stdout', data: d }); });
proc.stderr.on('data', d => { rememberOutput('stderr', d); broadcast({ op: 'stderr', data: d }); });
proc.stdin.on('error', () => {});

proc.on('exit', (code, signal) => {
  exited = true;
  exitInfo = { code, signal };
  broadcast({ op: 'exit', code, signal });
  // supervisor는 계속 살아있음 — EC 재시작 후 reattach + claude 재스폰을 기다림
  // (종료 + pid 삭제하지 않음. EC가 reattach 후 새 claude를 스폰함)
});
proc.on('error', err => {
  console.error('[supervisor]', SID, 'spawn error:', err.message);
  broadcast({ op: 'exit', code: -1, signal: null, error: err.message });
});

try { fs.unlinkSync(SOCK); } catch {}
fs.mkdirSync(path.dirname(SOCK), { recursive: true });
const server = net.createServer(conn => {
  conns.add(conn);
  // hello + catch-up
  try {
    conn.write(JSON.stringify({ op: 'hello', sid: SID, claudePid: proc.pid, bufferedChunks: buffer.length }) + '\n');
    for (const e of buffer) conn.write(JSON.stringify(e) + '\n');
    if (exited && exitInfo) conn.write(JSON.stringify({ op: 'exit', ...exitInfo }) + '\n');
  } catch {}
  let inbuf = '';
  conn.on('data', d => {
    inbuf += String(d);
    let nl;
    while ((nl = inbuf.indexOf('\n')) >= 0) {
      const line = inbuf.slice(0, nl); inbuf = inbuf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.op === 'input' && typeof msg.data === 'string') {
        // 임시 stdin 로그 — hex dump로 실제 전송 데이터 확인용
        const hex = Buffer.from(msg.data).toString('hex');
        if (hex.length <= 64) {  // 짧은 입력만 (escape sequence 확인용)
          console.log(`[supervisor:${SID}:stdin] hex=${hex} str=${JSON.stringify(msg.data)}`);
        }
        try { proc.stdin.write(msg.data); } catch {}
      } else if (msg.op === 'kill') {
        try { proc.kill(msg.signal || 'SIGTERM'); } catch {}
      } else if (msg.op === 'shutdown') {
        try { proc.kill('SIGTERM'); } catch {}
      }
    }
  });
  conn.on('error', () => {});
  conn.on('close', () => conns.delete(conn));
});
server.listen(SOCK, () => {
  try { fs.chmodSync(SOCK, 0o600); } catch {}
  console.log(`[supervisor:${SID}] pid=${process.pid} claude=${proc.pid} sock=${SOCK}`);
});
server.on('error', err => {
  console.error('[supervisor]', SID, 'server error:', err.message);
});

// 자체 종료 시그널 처리 — claude 도 함께 정리
function shutdown(sig) {
  try { proc.kill(sig || 'SIGTERM'); } catch {}
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
