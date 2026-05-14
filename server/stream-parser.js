'use strict';
const { classify } = require('./lexicon');
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
      lastCtxInput: 0,
      contextWindow: null,
    };
    this.lastResult = null;
    this.pendingAssistant = null;
    this.pendingAgentIds = new Set();
    this._clearPending  = false;
    this._slashPending  = false;  // 슬래시 커맨드 후 다음 assistant → ec_system
    this._postCompact   = false;
    this._compactTurn   = null;
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
    this._curLex = classify(evt);
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
        // type:'compact_boundary'로 직접 오는 경우도 처리 (버전별 차이 대비)
        this._onSystem({ ...evt, subtype: 'compact_boundary' });
        return;
      case 'session_id_change':
        if (evt.new_session_id) {
          this.session.id = evt.new_session_id;
          this.h.onSessionIdChange && this.h.onSessionIdChange(evt.new_session_id, evt);
        }
        // /clear 후 session_id_change → 클리어 완료 확정
        if (this._clearPending) {
          this._clearPending = false;
          this._addTurn({ type: 'ec_system', subtype: 'clear_complete', body: '대화 내역이 초기화됐습니다.' });
        }
        return;
      case 'usage_alert':
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
    const sub = evt.subtype;

    // ── 압축 상태 기계 ─────────────────────────────────────────────────────
    if (sub === 'compact_boundary') {
      const meta = evt.compactMetadata || evt.compact_metadata || {};
      if (this._compactTurn) {
        // 라이브: "압축 중..." → "압축 완료"로 mutate
        this._compactTurn.subtype     = 'compact_complete';
        this._compactTurn.body        = '대화가 압축됐습니다.';
        this._compactTurn.compactMeta = meta;
        this._compactTurn = null;
        this.h.onTurnUpdate && this.h.onTurnUpdate();
      } else {
        // 재생(jsonl): compact_boundary 먼저 옴 → 새 ec_system 생성
        const ct = { type: 'ec_system', subtype: 'compact_complete', body: '대화가 압축됐습니다.', details: [], compactMeta: meta };
        this._addTurn(ct);
        this._compactTurn = ct; // post-compact context의 details 누적용
      }
      this._postCompact = true;
      return;
    }

    if (sub === 'status') {
      const status = evt.status;
      const result = evt.compact_result;

      if (status === 'compacting' && !this._compactTurn) {
        // 압축 시작 — "압축 중..." 턴 생성
        const ct = { type: 'ec_system', subtype: 'compacting', body: '압축 중...', details: [] };
        this._compactTurn = ct;
        this._addTurn(ct);
      } else if (result === 'failed') {
        // 압축 취소/실패
        const err = evt.compact_error || '압축 실패';
        if (this._compactTurn) {
          this._compactTurn.subtype = 'compact_canceled';
          this._compactTurn.body    = `압축이 취소됐습니다.`;
          this._compactTurn.error   = err;
          this._compactTurn = null;
          this.h.onTurnUpdate && this.h.onTurnUpdate();
        } else {
          this._addTurn({ type: 'ec_system', subtype: 'compact_canceled', body: '압축이 취소됐습니다.', error: err });
        }
      }
      // result === 'success'는 compact_boundary가 뒤따름 — 거기서 처리
      this.h.onStatus && this.h.onStatus(status, evt);
      return;
    }

    // ── local_command ─────────────────────────────────────────────────────
    if (sub === 'local_command') {
      const content = evt.content || '';

      // /clear 닫는 괄호 (빈 stdout)
      if (this._clearPending) {
        this._clearPending = false;
        this._addTurn({ type: 'ec_system', subtype: 'clear_complete', body: '대화 내역이 초기화됐습니다.', newSessionId: this.session.id });
        return;
      }

      // stdout 결과 — /help 등 슬래시 커맨드 응답
      const stdoutM = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
      if (stdoutM) {
        const result = stdoutM[1].trim();
        if (result) this._addTurn({ type: 'ec_system', subtype: 'slash_result', body: result });
        return;
      }

      // stderr 결과 — 취소/에러
      const stderrM = content.match(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/);
      if (stderrM) {
        const result = stderrM[1].trim();
        if (result) this._addTurn({ type: 'ec_system', subtype: 'slash_result', body: result });
        return;
      }

      // 커맨드 자체 — /help, /model 등 → pill 표시 + pending 확인용 meta
      if (/^\/\w/.test(content.trim())) {
        this._addTurn({ type: 'meta', body: content.trim(), eventType: 'slash_cmd' });
        this._slashPending = false; // user turn 기반 감지 취소
      }
      return;
    }

    if (sub === 'session_id_change' || evt.new_session_id) {
      if (evt.new_session_id) {
        this.session.id = evt.new_session_id;
        this.h.onSessionIdChange && this.h.onSessionIdChange(evt.new_session_id, evt);
      }
      if (this._clearPending) {
        this._clearPending = false;
        this._addTurn({ type: 'ec_system', subtype: 'clear_complete', body: '대화 내역이 초기화됐습니다.', newSessionId: evt.new_session_id });
      }
      return;
    }

    // ── 세션 메타 ──────────────────────────────────────────────────────────
    if (sub === 'init') {
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
    // isMeta: true — claude code가 직접 meta로 표시한 이벤트 (caveat 등)
    if (evt.isMeta) {
      const raw = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      this._addTurn({ type: 'meta', body: raw, eventType: 'client_meta', ts: evt.timestamp || null, uuid: evt.uuid || null });
      return;
    }
    const contents = Array.isArray(msg.content)
      ? msg.content
      : [{ type: 'text', text: String(msg.content || '') }];
    const ts = evt.timestamp || null;
    const uuid = evt.uuid || null;
    for (const c of contents) {
      if (c.type === 'text') {
        const text = c.text || '';
        // <ec-system> 태그 — EC 코어 시스템 메시지
        const ecSysMatch = text.match(/^<ec-system>([\s\S]*?)<\/ec-system>$/);
        if (ecSysMatch) {
          this._addTurn({ type: 'ec_system', body: ecSysMatch[1].trim(), ts, uuid });
          continue;
        }
        // /compact 커맨드 — meta로 숨김
        if (/^\/compact\s*$/.test(text.trim()) || /<command-name>\/compact<\/command-name>/i.test(text)) {
          this._addTurn({ type: 'meta', body: text, eventType: 'compact_cmd', ts, uuid });
          continue;
        }
        // 기타 슬래시 커맨드 (/help, /model 등) — meta + 다음 assistant 응답을 ec_system으로
        if (/^\/\w/.test(text.trim())) {
          this._slashPending = true;
          this._addTurn({ type: 'meta', body: text, eventType: 'slash_cmd', ts, uuid });
          continue;
        }
        // ! bash 단축 — meta로 숨김 (서버가 backtick으로 변환해 echo됨)
        if (/^!\s/.test(text.trim())) {
          this._addTurn({ type: 'meta', body: text, eventType: 'bash_cmd', ts, uuid });
          continue;
        }
        // <local-command-caveat> — 항상 meta (clear/compact 전후 자동 주입되는 래퍼)
        if (/<local-command-caveat>/i.test(text)) {
          this._addTurn({ type: 'meta', body: text, eventType: 'local_cmd_caveat', ts, uuid });
          continue;
        }
        // <local-command-stdout> — 항상 meta
        if (/<local-command-stdout>/i.test(text)) {
          this._addTurn({ type: 'meta', body: text, eventType: 'local_cmd_stdout', ts, uuid });
          continue;
        }
        // "Continue from where you left off." — 구형 ec-system inject 잔재 → meta
        if (/^Continue from where you left off\./i.test(text.trim())) {
          this._addTurn({ type: 'meta', body: text, eventType: 'legacy_ec_inject', ts, uuid });
          continue;
        }
        // post-compact context — compact_boundary 이후 user 턴 숨김
        // 첫 번째 user 턴("This session is being continued...")은 details에 포함
        if (this._postCompact) {
          const isSummary = /^This session is being continued/i.test(text.trim());
          this._addTurn({ type: 'meta', body: text, eventType: 'compact_context', ts, uuid });
          if (isSummary && this._compactTurn) {
            this._compactTurn.details.push(text);
            this.h.onTurnUpdate && this.h.onTurnUpdate();
          }
          continue;
        }
        // /clear 감지 — 평문 또는 <command-name>/clear</command-name> 형식
        if (/^\/clear\s*$/.test(text.trim()) || /<command-name>\/clear<\/command-name>/i.test(text)) {
          this._clearPending = true;
          this._addTurn({ type: 'meta', body: text, eventType: 'clear_cmd', ts, uuid });
          continue;
        }
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
        } else if (/^Base directory for this skill:/i.test(text) || /^---\s*\nname:\s*\S/.test(text)) {
          // SKILL.md 주입 컨텍스트 — meta로 분류 (기본 숨김)
          this._addTurn({ type: 'meta', body: text, raw: false, eventType: 'skill_injection', ts, uuid });
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
    // msg.usage = 이 API 호출의 실제 input 크기 (누적 아님, 컴팩션 반영됨)
    // cache_creation은 제외 — 새로 캐시 쓰는 양이라 컨텍스트 창 사용량에 포함하면 100% 초과 오산됨
    if (msg.usage) {
      const u = msg.usage;
      const rawCtx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0);
      if (rawCtx > 0) this.session.lastCtxInput = rawCtx;
    }
    const contents = Array.isArray(msg.content) ? msg.content : [];
    const ts = evt.timestamp || null;
    const uuid = evt.uuid || null;
    const hasText = contents.some(c => c.type === 'text' && c.text);
    // 슬래시 커맨드 직후 assistant 응답 → ec_system으로 전환 (결과/에러 메시지)
    if (this._slashPending) {
      this._slashPending = false;
      if (hasText) {
        const body = contents.filter(c => c.type === 'text').map(c => c.text).join('');
        this._addTurn({ type: 'ec_system', subtype: 'slash_result', body, ts, uuid });
        if (msg.usage) this._updateUsage(msg.usage);
        return;
      }
    }
    // post-compact 중 "No response requested." → meta, 계속 _postCompact 유지
    // 그 외 실제 assistant 응답 → post-compact 종료
    if (this._postCompact) {
      const firstText = contents.find(c => c.type === 'text')?.text || '';
      if (!firstText || /^No response requested\.?$/i.test(firstText.trim())) {
        this._addTurn({ type: 'meta', body: firstText, eventType: 'compact_no_resp', ts, uuid });
        this._postCompact = false;
        this._compactTurn = null;
        if (msg.usage) this._updateUsage(msg.usage);
        return;
      }
      this._postCompact = false;
      this._compactTurn = null;
    }
    // /clear 후 빈 assistant 응답 → ec_system "클리어 완료"로 대체
    if (!hasText && this._clearPending) {
      this._clearPending = false;
      this._addTurn({ type: 'ec_system', subtype: 'clear_complete', body: '대화 내역이 초기화됐습니다.', ts, uuid });
      if (msg.usage) this._updateUsage(msg.usage);
      return;
    }
    this._clearPending = false;
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
    if (this._clearPending) {
      this._clearPending = false;
      this._addTurn({ type: 'ec_system', body: '대화 내역이 초기화됐습니다.' });
    }
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
    // lastCtxInput은 _onAssistant에서 per-API-call 기준으로 업데이트
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
    if (this._curLex && !turn.lex) turn.lex = this._curLex;
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
