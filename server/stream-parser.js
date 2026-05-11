'use strict';
// Claude Code stream-json 출력 파서.
// 라인별 JSON 이벤트(system/user/assistant/result/stream_event/hook_event)를
// 클라이언트가 렌더할 수 있는 통일된 turn 형태로 변환한다.

class StreamParser {
  constructor(handlers = {}) {
    this.h = handlers;
    this.turns = [];                          // 누적 turn (full history)
    this.session = {
      id: null,
      model: null,
      cwd: null,
      tools: [],
      usage: { input: 0, output: 0, cache_creation: 0, cache_read: 0 },
      contextWindow: null,
    };
    this.lastResult = null;
    this.pendingAssistant = null;            // stream_event 누적
  }

  feedLine(line) {
    line = line.replace(/\r?$/, '').trim();
    if (!line) return;
    let evt;
    try { evt = JSON.parse(line); }
    catch (e) {
      this._emitRaw(line);
      return;
    }
    this._handle(evt);
  }

  _emitRaw(line) {
    // JSON이 아닌 stderr/로그 라인 — debug용 raw turn으로
    this._addTurn({ type: 'other', body: line, raw: true });
  }

  _handle(evt) {
    switch (evt.type) {
      case 'system':                  return this._onSystem(evt);
      case 'user':                    return this._onUser(evt);
      case 'assistant':               return this._onAssistant(evt);
      case 'stream_event':            return this._onStreamEvent(evt);
      case 'result':                  return this._onResult(evt);
      case 'hook_event':              return this._onHook(evt);
      case 'rate_limit_event':
        // rate limit info — turn 미생성, 메타로만 (필요시 onHook 통로 사용)
        this.session.rateLimit = evt.rate_limit_info;
        this.h.onRateLimit && this.h.onRateLimit(evt.rate_limit_info);
        return;
      default:
        this._addTurn({ type: 'other', body: JSON.stringify(evt), raw: true });
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
    }
  }

  _onUser(evt) {
    const msg = evt.message;
    if (!msg) return;
    const contents = Array.isArray(msg.content)
      ? msg.content
      : [{ type: 'text', text: String(msg.content || '') }];
    for (const c of contents) {
      if (c.type === 'text') {
        this._addTurn({ type: 'human', body: c.text || '' });
      } else if (c.type === 'tool_result') {
        const body = this._stringifyContent(c.content);
        this._addTurn({
          type: 'tool_out',
          body,
          tool_use_id: c.tool_use_id,
          is_error: !!c.is_error,
        });
      }
    }
  }

  _onAssistant(evt) {
    const msg = evt.message;
    if (!msg) return;
    const contents = Array.isArray(msg.content) ? msg.content : [];
    for (const c of contents) {
      if (c.type === 'text') {
        this._addTurn({ type: 'assistant', body: c.text || '' });
      } else if (c.type === 'tool_use') {
        const inputStr = typeof c.input === 'string'
          ? c.input
          : JSON.stringify(c.input, null, 2);
        this._addTurn({
          type: 'tool_call',
          body: `${c.name}\n${inputStr}`,
          tool_name: c.name,
          tool_use_id: c.id,
          input: c.input,
        });
        // 인터랙티브 툴 — Phase 2 다이얼로그 트리거
        if (c.name === 'AskUserQuestion') {
          this.h.onAskUserQuestion && this.h.onAskUserQuestion({
            tool_use_id: c.id,
            input: c.input,
          });
        }
      } else if (c.type === 'thinking') {
        this._addTurn({ type: 'thinking', body: c.thinking || c.text || '' });
      }
    }
    if (msg.usage) this._updateUsage(msg.usage);
  }

  _onStreamEvent(evt) {
    // partial message — turn 생성 안 함. 최종 'assistant' 이벤트로 완성된 텍스트만 turn화.
    // typing indicator가 필요하면 별도 onPartial 콜백으로 broadcast (turn에 미반영).
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
    };
    this.h.onResult && this.h.onResult(this.lastResult, this.session.usage);
  }

  _onHook(evt) {
    // hook lifecycle event — 일단 미처리, 필요시 turn으로 흘려보냄
    // 예: pre_tool_use / post_tool_use / user_prompt_submit / session_start ...
    this.h.onHook && this.h.onHook(evt);
  }

  _updateUsage(u) {
    const s = this.session.usage;
    s.input += u.input_tokens || 0;
    s.output += u.output_tokens || 0;
    s.cache_creation += u.cache_creation_input_tokens || 0;
    s.cache_read += u.cache_read_input_tokens || 0;
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

module.exports = { StreamParser };
