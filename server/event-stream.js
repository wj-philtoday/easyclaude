'use strict';
// event-stream.js — lexicon 기반 이벤트 분류기 + 서버 메타데이터 추출기.
// StreamParser를 대체. 파싱(변환) 없이 raw event를 lexicon으로 분류해 포워딩.
//
// 서버 전용 메타데이터(init/result/status/usage 등)는 callbacks로 추출.
// 콘텐츠 이벤트는 {evt, lex}로 클라이언트에 포워딩.

const { classify } = require('./lexicon');

// Agent 호출 내부 상태 추적 — 서브에이전트 컨텍스트 user 이벤트 숨김
// processLine 호출 시 h._agentIds를 공유 상태로 사용 (per-session/per-file 격리)
function processLine(line, h) {
  let evt;
  try { evt = JSON.parse(line.trim()); } catch { return; }

  const typ = evt.type;

  // ── 서버 전용 메타데이터 ──────────────────────────────────────────────────
  if (typ === 'system') {
    const sub = evt.subtype;

    if (sub === 'init') {
      h.onInit && h.onInit(evt);
      return;
    }
    if (sub === 'status') {
      if (evt.compact_result === 'failed') {
        h.onEvent && h.onEvent({
          evt: { type: 'system', subtype: 'compact_canceled', compact_error: evt.compact_error || '' },
          lex: { css: '.ec-turn-ec-system', category: 'compact_canceled' },
        });
      }
      h.onStatus && h.onStatus(evt.status || '', evt);
      return;
    }
    if (sub === 'session_id_change' || evt.new_session_id) {
      if (evt.new_session_id) h.onSessionIdChange && h.onSessionIdChange(evt.new_session_id, evt);
      h.onEvent && h.onEvent({
        evt: { type: 'system', subtype: 'clear_complete', new_session_id: evt.new_session_id },
        lex: { css: '.ec-turn-ec-system', category: 'clear_complete' },
      });
      return;
    }
    // compact_boundary, local_command 등 콘텐츠 이벤트는 classify로 처리
  }

  if (typ === 'session_id_change') {
    if (evt.new_session_id) {
      h.onSessionIdChange && h.onSessionIdChange(evt.new_session_id, evt);
      h.onEvent && h.onEvent({
        evt: { type: 'system', subtype: 'clear_complete', new_session_id: evt.new_session_id },
        lex: { css: '.ec-turn-ec-system', category: 'clear_complete' },
      });
    }
    return;
  }

  if (typ === 'rate_limit_event') {
    h.onRateLimit && h.onRateLimit(evt.rate_limit_info);
    return;
  }

  if (typ === 'result') {
    if (evt.usage) h.onUsage && h.onUsage(evt.usage);
    h.onResult && h.onResult(evt);
    h.onStatus && h.onStatus('', evt);
    return;
  }

  if (typ === 'stream_event') {
    const sub = evt.event;
    if (sub?.type === 'content_block_delta') {
      if (sub.delta?.type === 'text_delta') {
        h.onPartial && h.onPartial(sub.delta.text || '');
      } else if (sub.delta?.type === 'thinking_delta') {
        h.onThinkingDelta && h.onThinkingDelta(sub.delta.thinking || '');
      }
    }
    return;
  }

  // ── Agent 호출 상태 추적 — 서브에이전트 컨텍스트 user 이벤트 숨김 ─────────
  // h._agentIds: Set<tool_use_id> — 현재 실행 중인 Agent tool_use_id 집합
  if (!h._agentIds) h._agentIds = new Set();

  if (typ === 'assistant') {
    for (const c of (evt.message?.content || [])) {
      if (c && c.type === 'tool_use' && c.name === 'Agent' && c.id) {
        h._agentIds.add(c.id);
      }
    }
  }

  // user 이벤트: Agent 대기 중이면 subagent 컨텍스트 → tool_result_response 체크
  if (typ === 'user' && h._agentIds.size > 0) {
    const content = evt.message?.content;
    const hasToolResult = Array.isArray(content) &&
      content.some(c => c && typeof c === 'object' && 'tool_use_id' in c);
    if (hasToolResult) {
      // Agent tool_result → 대기 목록에서 제거
      for (const c of content) {
        if (c && c.tool_use_id && h._agentIds.has(c.tool_use_id)) {
          h._agentIds.delete(c.tool_use_id);
        }
      }
      // tool_result 자체는 classify로 정상 처리 (아래로 계속)
    } else {
      // tool_use_id 없는 user 이벤트 = 서브에이전트 프롬프트/컨텍스트 → 숨김
      return;
    }
  }

  // ── usage 추출 (assistant message) ──────────────────────────────────────
  if (typ === 'assistant' && evt.message?.usage) {
    h.onUsage && h.onUsage(evt.message.usage);
  }

  // ── dialog 감지 (AskUserQuestion) ────────────────────────────────────────
  if (typ === 'assistant') {
    for (const c of (evt.message?.content || [])) {
      if (c.type === 'tool_use' && c.name === 'AskUserQuestion') {
        h.onAskUserQuestion && h.onAskUserQuestion({ tool_use_id: c.id, input: c.input });
      }
    }
  }

  // ── classify + 포워딩 ──────────────────────────────────────────────────
  const lex = classify(evt);
  // tool_result_response는 hidden이지만 fold 렌더링에 필요 — 포워딩
  if (lex.css === 'hidden' && lex.category !== 'tool_result_response') return;
  h.onEvent && h.onEvent({ evt, lex });
}

module.exports = { processLine };
