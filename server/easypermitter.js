#!/usr/bin/env node
'use strict';
/**
 * easypermitter — easyclaude permission-prompt-tool MCP server (stdio).
 *
 * claude CLI 가 `--permission-prompt-tool mcp__easypermitter__permission_prompt`
 * 로 호출하는 stdio MCP. 입력은 { tool_name, input, tool_use_id } 형태이며,
 * 응답은 단일 text block 안에 JSON 문자열을 담아 돌려준다:
 *   { behavior: "allow", updatedInput: { ... } }
 *   { behavior: "deny",  message: "사유" }
 *
 * 내부적으로는 easyclaude 메인 서버(127.0.0.1:7860)의 long-poll 엔드포인트
 * /api/permitter/request 에 동일 payload 를 POST 하여 사용자 결정(allow/deny)
 * 을 받아온다. GUI 가 응답할 때까지 HTTP 응답이 보류되므로, 별도 polling
 * 루프는 필요 없다.
 *
 * 의존성: Node 내장(http, readline)만 사용. 외부 패키지 없음.
 */

const http = require('http');
const readline = require('readline');

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME      = 'easypermitter';
const SERVER_VERSION   = '0.1.0';
const TOOL_NAME        = 'permission_prompt';

const EASYCLAUDE_HOST = process.env.EASYCLAUDE_HOST || '127.0.0.1';
const EASYCLAUDE_PORT = Number(process.env.EASYCLAUDE_PORT || 7860);
const REQUEST_TIMEOUT_MS = Number(process.env.EASYPERMITTER_TIMEOUT_MS || 300000); // 5min default
const SESSION_HINT = process.env.EASYPERMITTER_SESSION || null; // easyclaude session id (optional)

// stderr 만 로깅. stdout 은 MCP 프레이밍 전용이므로 절대 오염 금지.
function log(...a) { try { process.stderr.write('[easypermitter] ' + a.join(' ') + '\n'); } catch {} }

// ── easyclaude HTTP long-poll ───────────────────────────────────────────────
function postPermissionRequest({ tool_name, input, tool_use_id }) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      tool_name,
      input: input || {},
      tool_use_id: tool_use_id || `permitter-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      session: SESSION_HINT,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const req = http.request({
      host: EASYCLAUDE_HOST,
      port: EASYCLAUDE_PORT,
      path: '/api/permitter/request',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      // 서버가 long-poll 로 응답을 보류하므로 socket 타임아웃은 충분히 크게.
      timeout: REQUEST_TIMEOUT_MS + 30000,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', d => buf += d);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch (e) {
          log('non-JSON response from easyclaude:', buf.slice(0, 200));
        }
        if (!parsed || (parsed.behavior !== 'allow' && parsed.behavior !== 'deny')) {
          return resolve({ behavior: 'deny', message: 'invalid easyclaude response' });
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => {
      log('request timeout');
      try { req.destroy(new Error('timeout')); } catch {}
      resolve({ behavior: 'deny', message: 'easyclaude bridge timeout' });
    });
    req.on('error', err => {
      log('request error:', err.message);
      resolve({ behavior: 'deny', message: `easyclaude bridge error: ${err.message}` });
    });
    req.write(body);
    req.end();
  });
}

// ── MCP stdio JSON-RPC framing ──────────────────────────────────────────────
// claude CLI 는 line-delimited JSON-RPC 를 사용한다 (LSP-style Content-Length 헤더가
// 아니라 line per message). 안전을 위해 양쪽 모두 지원: 입력 라인이 '{' 로 시작하면
// 즉시 JSON 으로 파싱, 아니면 Content-Length 헤더 파서로 폴백한다.

function sendMessage(msg) {
  const line = JSON.stringify(msg);
  process.stdout.write(line + '\n');
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}
function sendError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  sendMessage({ jsonrpc: '2.0', id, error: err });
}

// ── MCP method handlers ─────────────────────────────────────────────────────
async function handleRequest(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return sendResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'notifications/initialized' || method === 'initialized') {
    return; // notification, no response
  }

  if (method === 'ping') {
    return sendResult(id, {});
  }

  if (method === 'tools/list') {
    return sendResult(id, {
      tools: [{
        name: TOOL_NAME,
        description: 'Route Claude permission prompts to the easyclaude GUI for user decision.',
        inputSchema: {
          type: 'object',
          properties: {
            tool_name:   { type: 'string',  description: 'Name of the tool Claude wants to invoke.' },
            input:       { type: 'object',  description: 'Tool input that requires approval.', additionalProperties: true },
            tool_use_id: { type: 'string',  description: 'Correlation id for this permission request.' },
          },
          required: ['tool_name', 'input'],
          additionalProperties: true,
        },
      }],
    });
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    if (name !== TOOL_NAME) {
      return sendError(id, -32602, `unknown tool: ${name}`);
    }
    const args = (params && params.arguments) || {};
    const tool_name   = args.tool_name || 'unknown';
    const input       = args.input || {};
    const tool_use_id = args.tool_use_id;
    log(`prompt: tool=${tool_name} id=${tool_use_id}`);

    let decision;
    try {
      decision = await postPermissionRequest({ tool_name, input, tool_use_id });
    } catch (e) {
      decision = { behavior: 'deny', message: `bridge exception: ${e.message}` };
    }

    // claude 는 단일 text block 안의 JSON 문자열을 기대한다 (binary string confirm).
    return sendResult(id, {
      content: [{ type: 'text', text: JSON.stringify(decision) }],
    });
  }

  // 일반 notifications (no id) — silently ignore
  if (id === undefined || id === null) return;

  sendError(id, -32601, `method not found: ${method}`);
}

// ── Input loop ──────────────────────────────────────────────────────────────
// stdin 으로 들어오는 line-delimited JSON-RPC 를 처리. Content-Length 헤더 프레이밍은
// claude CLI 가 사용하지 않으므로 단순화.
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); }
  catch (e) { log('parse error:', e.message, '— line:', trimmed.slice(0, 200)); return; }
  Promise.resolve(handleRequest(msg)).catch(err => {
    log('handler error:', err && err.stack || err);
    if (msg && msg.id !== undefined) sendError(msg.id, -32603, `internal error: ${err.message}`);
  });
});
rl.on('close', () => {
  log('stdin closed, exiting');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  log('uncaught:', err && err.stack || err);
});
process.on('unhandledRejection', (reason) => {
  log('unhandledRejection:', reason);
});

log(`ready (proto=${PROTOCOL_VERSION}, tool=${TOOL_NAME}, target=${EASYCLAUDE_HOST}:${EASYCLAUDE_PORT})`);
