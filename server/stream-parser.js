'use strict';
// Claude Code stream-json 출력 파서.
// 라인별 JSON 이벤트(system/user/assistant/result/stream_event/hook_event)를
// 클라이언트가 렌더할 수 있는 통일된 turn 형태로 변환한다.
//
// turn types:
//   human       — 사용자가 직접 입력한 텍스트
//   channel     — <channel source="..."> 봉투 (IOA 등 외부 push)
//   tool_out    — tool_result 응답
//   assistant   — claude 텍스트 응답
//   thinking    — claude 내부 사유
//   tool_call   — claude의 tool_use (category 필드 부착)
//   result      — turn 종료 마커 (duration/cost/result_text)
//   hook        — hook lifecycle 이벤트
//   other       — 알 수 없는 타입 (raw 보존)

// ── 채널 봉투 파싱 ─────────────────────────────────────────────────────────
function parseChannelEnvelope(text) {
  if (!text || typeof text !== 'string') return null;
  if (text.indexOf('<channel ') === -1) return null;
  const m = text.match(/<channel\s+([^>]+)>([\s\S]*?)<\/channel>/);
  if (!m) return null;
  const attrs = {};
  const re = /([a-zA-Z_][\w-]*)="([^"]*)"/g;
  let am;
  while ((am = re.exec(m[1])) !== null) attrs[am[1]] = am[2];
  return {
    source: attrs.source || 'unknown',
    ioa_id: attrs.ioa_id || null,
    from: attrs.from || null,
    channelType: attrs.type || null,
    body: m[2].trim(),
    raw: text,
  };
}

// ── tool 분류 ──────────────────────────────────────────────────────────────
function toolCategory(name) {
  if (!name) return 'unknown';
  if (name.startsWith('mcp__ioa__')) return 'mcp_ioa';
  if (name.startsWith('mcp__claude_ai_')) return 'mcp_claude_ai';
  if (name.startsWith('mcp__claude-in-chrome__')) return 'mcp_browser';
  if (name.startsWith('mcp__')) return 'mcp_other';
  if (name === 'Agent' || name === 'Task') return 'agent';
  if (name === 'Skill') return 'skill';
  if (name === 'AskUserQuestion') return 'dialog';
  if (name === 'TodoWrite' || name.startsWith('Task') || name.startsWith('Cron') || name === 'ScheduleWakeup') return 'task';
  if (name === 'WebFetch' || name === 'WebSearch') return 'web';
  if (['Read','Write','Edit','Glob','Grep','NotebookEdit'].includes(name)) return 'fs';
  if (name === 'Bash' || name === 'Monitor') return 'shell';
  return 'builtin';
}

class StreamParser {
  constructor(handlers = {}) {
    this.h = handlers;
    this.turns = [];
    this.session = {
      id: null,
      model: null,
      cwd: null,
      tools: [],
      usage: { input: 0, output: 0, cache_creation: 0, cache_read: 0 },
      lastCtxInput: 0,   // 마지막 turn의 input_tokens (ctx% 계산용)
      contextWindow: null,
    };
    this.lastResult = null;
    this.pendingAssistant = null;
    this.pendingAgentIds = new Set();  // Agent tool_use_id 추적 — 결과 전 user 텍스트 분류용
  }

  feedLine(line) {
    line = line.replace(/\r?$/, '').trim();
    if (!line) return;
    let evt;
    try { evt = JSON.parse(line); }
    catch (e) { this._emitRaw(line); return; }
    this._handle(evt);
  }

  _emitRaw(line) {
    // JSON 파스 실패 — 진짜 비정형 stdout (보통은 안 일어남). 디버그용으로 'meta' 분류.
    this._addTurn({ type: 'meta', body: line, raw: true, eventType: 'raw_line' });
  }

  _handle(evt) {
    switch (evt.type) {
      case 'system':           return this._onSystem(evt);
      case 'user':             return this._onUser(evt);
      case 'assistant':        return this._onAssistant(evt);
      case 'stream_event':     return this._onStreamEvent(evt);
      case 'result':           return this._onResult(evt);
      case 'hook_event':       return this._onHook(evt);
      case 'rate_limit_event':
        this.session.rateLimit = evt.rate_limit_info;
        this.h.onRateLimit && this.h.onRateLimit(evt.rate_limit_info);
        return;
      // 세션 메타 이벤트들은 session에 흡수, turn 미생성
      case 'custom-title':
        this.session.customTitle = evt.customTitle || this.session.customTitle;
        this.h.onSystem && this.h.onSystem(this.session);
        return;
      case 'agent-name':
        this.session.agentName = evt.agentName || this.session.agentName;
        this.h.onSystem && this.h.onSystem(this.session);
        return;
      case 'permission-mode':
        this.session.permissionMode = evt.permissionMode || this.session.permissionMode;
        this.h.onSystem && this.h.onSystem(this.session);
        return;
      case 'compact_boundary':
      case 'session_id_change':
      case 'usage_alert':
        // 세션 lifecycle 이벤트 — 흡수
        return;
      case 'queue-operation':
      case 'last-prompt':
      case 'attachment':
      case 'todo-list':
      case 'model-change':
        // claude jsonl 부수 메타 — turn 미생성 (필요 시 session에 흡수)
        return;
      default:
        // 알려지지 않은 type — 'meta' 로 분류 (대화창 기본 숨김, 디버그 토글로 노출)
        this._addTurn({ type: 'meta', body: JSON.stringify(evt), raw: true, eventType: evt.type });
    }
  }

  _onSystem(evt) {
    if (evt.subtype === 'init') {
      this.session.id = evt.session_id || this.session.id;
      this.session.model = evt.model || this.session.model;
      this.session.cwd = evt.cwd || this.session.cwd;
      this.session.tools = evt.tools || this.session.tools;
      this.session.mcpServers = evt.mcp_servers || [];
      this.session.slashCommands = evt.slash_commands || [];
      this.session.agents = evt.agents || [];
      this.session.skills = evt.skills || [];
      this.session.claudeCodeVersion = evt.claude_code_version || null;
      this.session.permissionMode = evt.permissionMode || null;
      this.h.onSystem && this.h.onSystem(this.session);
      return;
    }
    if (evt.subtype === 'status') {
      // 단순 'requesting' 등 heartbeat — turn 미생성, callback만
      this.h.onStatus && this.h.onStatus(evt.status, evt);
    }
  }

  _onUser(evt) {
    const msg = evt.message;
    if (!msg) return;
    const contents = Array.isArray(msg.content)
      ? msg.content
      : [{ type: 'text', text: String(msg.content || '') }];
    const ts = evt.timestamp || null;
    const uuid = evt.uuid || null;
    for (const c of contents) {
      if (c.type === 'text') {
        const text = c.text || '';
        const channel = parseChannelEnvelope(text);
        if (channel) {
          this._addTurn({
            type: 'channel',
            source: channel.source,
            ioa_id: channel.ioa_id,
            from: channel.from,
            channelType: channel.channelType,
            body: channel.body,
            raw: channel.raw,
            ts, uuid,
          });
        } else if (this.pendingAgentIds.size > 0) {
          // Agent 실행 대기 중에 들어온 텍스트 — 서브에이전트 프롬프트 인젝션
          this._addTurn({ type: 'agent_input', body: text, ts, uuid });
        } else {
          this._addTurn({ type: 'human', body: text, ts, uuid });
        }
      } else if (c.type === 'tool_result') {
        this.pendingAgentIds.delete(c.tool_use_id);
        const body = this._stringifyContent(c.content);
        this._addTurn({
          type: 'tool_out',
          body,
          tool_use_id: c.tool_use_id,
          is_error: !!c.is_error,
          ts, uuid,
        });
      }
    }
  }

  _onAssistant(evt) {
    const msg = evt.message;
    if (!msg) return;
    const contents = Array.isArray(msg.content) ? msg.content : [];
    const ts = evt.timestamp || null;
    const uuid = evt.uuid || null;
    for (const c of contents) {
      if (c.type === 'text') {
        this._addTurn({ type: 'assistant', body: c.text || '', ts, uuid });
      } else if (c.type === 'tool_use') {
        const inputStr = typeof c.input === 'string'
          ? c.input
          : JSON.stringify(c.input, null, 2);
        if (c.name === 'Agent' || c.name === 'Task') {
          this.pendingAgentIds.add(c.id);
        }
        this._addTurn({
          type: 'tool_call',
          body: `${c.name}\n${inputStr}`,
          tool_name: c.name,
          tool_use_id: c.id,
          input: c.input,
          category: toolCategory(c.name),
          ts, uuid,
        });
        if (c.name === 'AskUserQuestion') {
          this.h.onAskUserQuestion && this.h.onAskUserQuestion({
            tool_use_id: c.id,
            input: c.input,
          });
        }
      } else if (c.type === 'thinking') {
        this._addTurn({ type: 'thinking', body: c.thinking || c.text || '', ts, uuid });
      }
    }
    if (msg.usage) this._updateUsage(msg.usage);
  }

  _onStreamEvent(evt) {
    const sub = evt.event;
    if (!sub) return;
    if (sub.type === 'content_block_delta' && sub.delta && sub.delta.type === 'text_delta') {
      const text = sub.delta.text || '';
      if (!text) return;
      this.h.onPartial && this.h.onPartial(text);
    }
  }

  _onResult(evt) {
    if (evt.usage) this._updateUsage(evt.usage);
    this.lastResult = {
      subtype: evt.subtype,
      duration_ms: evt.duration_ms,
      duration_api_ms: evt.duration_api_ms,
      num_turns: evt.num_turns,
      total_cost_usd: evt.total_cost_usd,
      session_id: evt.session_id,
      is_error: !!evt.is_error,
      stop_reason: evt.stop_reason || null,
      result_text: evt.result || '',
    };
    this._addTurn({
      type: 'result',
      subtype: evt.subtype,
      result_text: evt.result || '',
      duration_ms: evt.duration_ms,
      num_turns: evt.num_turns,
      cost_usd: evt.total_cost_usd,
      is_error: !!evt.is_error,
      stop_reason: evt.stop_reason || null,
      uuid: evt.uuid || null,
    });
    this.h.onResult && this.h.onResult(this.lastResult, this.session.usage);
  }

  _onHook(evt) {
    const hookName = evt.hook_event_name || evt.name || evt.event || null;
    this._addTurn({
      type: 'hook',
      hook_event: hookName,
      raw: evt,
    });
    this.h.onHook && this.h.onHook(evt);
  }

  _updateUsage(u) {
    const s = this.session.usage;
    s.input += u.input_tokens || 0;
    s.output += u.output_tokens || 0;
    s.cache_creation += u.cache_creation_input_tokens || 0;
    s.cache_read += u.cache_read_input_tokens || 0;
    // 마지막 turn의 실제 ctx 사용량 (누적이 아닌 단일 turn)
    const rawCtx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (rawCtx > 0) this.session.lastCtxInput = rawCtx;
    this.h.onUsage && this.h.onUsage(this.session.usage);
  }

  _stringifyContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(c => {
        if (typeof c === 'string') return c;
        if (c.type === 'text') return c.text || '';
        return JSON.stringify(c);
      }).join('\n');
    }
    return JSON.stringify(content);
  }

  _addTurn(turn) {
    this.turns.push(turn);
    this.h.onTurn && this.h.onTurn(turn, this.turns);
  }

  snapshot() {
    return {
      session: this.session,
      turns: this.turns,
      lastResult: this.lastResult,
    };
  }

  clear() {
    this.turns = [];
    this.pendingAssistant = null;
  }
}

module.exports = { StreamParser, parseChannelEnvelope, toolCategory };
