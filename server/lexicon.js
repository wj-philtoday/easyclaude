// Skeleton-based event lexicon — 도출 과정은 ~/.arche/memo/ec_skeleton_categories.md
// claude jsonl 코퍼스 분석으로 추출한 88 skeleton → 58 (css, category) 매핑.
// raw event를 받아 turn renderer가 사용할 cssClass와 의미 카테고리를 반환한다.

function classify(evt) {
  if (!evt || typeof evt !== 'object') return { css: 'hidden', category: 'invalid' };

  const typ = evt.type;

  // 메타 root-only (sessionId만 들고 다님)
  const METAS = new Set([
    'agent-name','agent-setting','ai-title','custom-title',
    'fork-context-ref','last-prompt','permission-mode','pr-link',
    'file-history-snapshot','queue-operation'
  ]);
  if (METAS.has(typ)) return { css: 'hidden', category: `meta:${typ}` };

  if (typ === 'attachment') {
    const att = evt.attachment || {};
    const at = att.type || '?';
    if (at === 'queued_command') {
      return { css: '.ec-cmd-pill.ec-pending', category: `queued_command/${att.commandMode || '?'}` };
    }
    if (at === 'auto_mode' || at === 'auto_mode_exit' || at === 'plan_mode' || at === 'plan_mode_exit') {
      return { css: '.ec-turn-ec-system', category: `mode:${at}` };
    }
    if (at === 'hook_success') return { css: '.ec-turn-fold', category: `hook:${att.hookEvent || '?'}` };
    if (at === 'hook_non_blocking_error' || at === 'hook_blocking_error') {
      return { css: '.ec-turn-fold.ec-error', category: `hook_err:${att.hookEvent || '?'}` };
    }
    if (at === 'hook_cancelled') return { css: '.ec-turn-fold', category: `hook_cancelled:${att.hookEvent || '?'}` };
    if (at === 'hook_system_message') return { css: '.ec-turn-ec-system', category: 'hook_system_message' };
    if (at === 'hook_additional_context') return { css: 'hidden', category: `hook_ctx:${att.hookEvent || '?'}` };
    if (at === 'async_hook_response') return { css: 'hidden', category: `async_hook:${att.hookEvent || '?'}` };
    if (at === 'deferred_tools_delta') return { css: 'hidden', category: 'tools_delta' };
    if (at === 'mcp_instructions_delta') return { css: 'hidden', category: 'mcp_delta' };
    const CTX = new Set([
      'nested_memory','file','edited_text_file','skill_listing',
      'task_reminder','todo_reminder','team_context',
      'compact_file_reference','date_change','command_permissions',
      'invoked_skills'
    ]);
    if (CTX.has(at)) return { css: 'hidden', category: `ctx:${at}` };
    return { css: 'hidden', category: `attachment:${at}` };
  }

  if (typ === 'system') {
    const sub = evt.subtype;
    if (sub === 'api_error') return { css: '.ec-turn-ec-system.ec-error', category: 'api_error' };
    if (sub === 'compact_boundary') {
      const trig = (evt.compactMetadata && evt.compactMetadata.trigger) || '?';
      return { css: '.ec-turn-ec-system.ec-compact-details', category: `compact_boundary:${trig}` };
    }
    if (sub === 'local_command') return { css: '.ec-turn-ec-system', category: 'slash_cmd_result' };
    if (sub === 'informational') return { css: '.ec-turn-ec-system.ec-divider-warn', category: 'info_warning' };
    if (sub === 'away_summary' || sub === 'bridge_status' || sub === 'scheduled_task_fire') {
      return { css: '.ec-turn-ec-system', category: sub };
    }
    if (sub === 'stop_hook_summary') return { css: 'hidden', category: 'stop_hook' };
    if (sub === 'turn_duration') return { css: 'hidden', category: 'turn_duration' };
    return { css: '.ec-turn-ec-system', category: `system:${sub || '?'}` };
  }

  if (typ === 'user') {
    if (evt.isMeta) return { css: 'hidden', category: 'user_meta' };
    const msg = evt.message || {};
    const content = msg.content;
    if (Array.isArray(content) && content.length > 0) {
      // 하나라도 tool_use_id 있으면 tool_result (순서 무관하게 검사)
      if (content.some(c => c && typeof c === 'object' && 'tool_use_id' in c))
        return { css: 'hidden', category: 'tool_result_response' };
      const inner = content[0];
      if (inner && typeof inner === 'object') {
        if ('text' in inner) return { css: '.ec-turn-human', category: 'user_text' };
        return { css: '.ec-turn-human', category: 'user_block' };
      }
    }
    return { css: '.ec-turn-human', category: 'user_text' };
  }

  if (typ === 'assistant') {
    const msg = evt.message || {};
    const content = msg.content;
    if (Array.isArray(content) && content.length > 0) {
      let hasThinking = false, hasText = false, hasTool = false;
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        if (c.type === 'thinking' || 'thinking' in c) hasThinking = true;
        if (c.type === 'text' || 'text' in c) hasText = true;
        if (c.type === 'tool_use' || 'input' in c) hasTool = true;
      }
      if (hasThinking && hasText) return { css: '.ec-turn-assistant', category: 'asst_thinking+text' };
      if (hasThinking) return { css: '.ec-turn-assistant.ec-thinking-status', category: 'asst_thinking' };
      if (hasTool) return { css: '.ec-turn-assistant', category: 'asst_tool_use' };
      if (hasText) return { css: '.ec-turn-assistant', category: 'asst_text' };
    }
    return { css: '.ec-turn-assistant', category: 'asst_other' };
  }

  return { css: 'hidden', category: `unknown:${typ}` };
}

module.exports = { classify };
