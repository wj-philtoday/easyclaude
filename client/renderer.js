'use strict';
// renderer.js — lexicon이 분류한 {evt, lex} 이벤트 배열을 HTML로 렌더링.
// 파싱 없음. raw event에서 필요한 필드를 직접 추출해 lex.css를 적용.

/* global esc, ecRenderBody, COLORS, cfg, T, LABELS, showDebugEvents */

// ── 콘텐츠 추출 헬퍼 ─────────────────────────────────────────────────────────
function extractUserText(evt) {
  const content = evt.message?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content) && content.length > 0) {
    const c = content[0];
    if (c && typeof c === 'object') text = c.text || '';
  }
  // ec-hint는 에이전트용 — 유저에게 노출 안 함
  return text.replace(/<ec-hint>[\s\S]*?<\/ec-hint>\n?/gi, '').trimStart();
}

function extractAssistantParts(evt) {
  const parts = { text: '', thinking: '', tools: [] };
  for (const c of (evt.message?.content || [])) {
    if (c.type === 'text') parts.text += c.text || '';
    if (c.type === 'thinking') parts.thinking += c.thinking || '';
    if (c.type === 'tool_use') parts.tools.push(c);
  }
  return parts;
}

function extractChannelEnvelope(text) {
  if (!text || text.indexOf('<channel ') === -1) return null;
  const m = text.match(/<channel\s+([^>]+)>([\s\S]*?)<\/channel>/);
  if (!m) return null;
  const attrs = {};
  const re = /([a-zA-Z_][\w-]*)="([^"]*)"/g;
  let am;
  while ((am = re.exec(m[1])) !== null) attrs[am[1]] = am[2];
  return { source: attrs.source || 'unknown', from: attrs.from || null, body: m[2].trim() };
}

// ── 단일 이벤트 렌더 (그룹핑 없음) ──────────────────────────────────────────
function renderSingleEvent(e, foldIdx) {
  const { evt, lex } = e;
  const cat = lex.category;
  const css = lex.css.replace(/^\./g, '').replace(/\./g, ' ');

  // compact_boundary는 renderEventStream에서 그룹 처리 (여기는 fallback)
  if (cat.startsWith('compact_boundary')) {
    return `<div class="ec-turn-ec-system"><div class="ec-divider">대화가 압축됐습니다.</div></div>`;
  }
  if (cat === 'compact_canceled') {
    return `<div class="ec-turn-ec-system"><div class="ec-divider ec-divider-warn">압축이 취소됐습니다.</div></div>`;
  }
  if (cat === 'clear_complete') {
    const idStr = evt.new_session_id ? ` · ${evt.new_session_id.slice(0, 8)}` : '';
    return `<div class="ec-turn-ec-system"><div class="ec-divider">대화 내역이 초기화됐습니다.${esc(idStr)}</div></div>`;
  }
  if (cat.startsWith('mode:') || cat === 'hook_system_message' || cat.startsWith('system:')) {
    const body = evt.content || evt.message || '';
    return `<div class="ec-turn-ec-system">${esc(typeof body === 'string' ? body : JSON.stringify(body))}</div>`;
  }
  if (cat === 'api_error') {
    return `<div class="ec-turn-ec-system ec-error">${esc(evt.error?.message || JSON.stringify(evt.error || {}))}</div>`;
  }
  if (cat === 'info_warning') {
    return `<div class="ec-turn-ec-system"><div class="ec-divider ec-divider-warn">${esc(evt.content || '')}</div></div>`;
  }

  // user_text
  if (cat === 'user_text' || cat === 'user_block') {
    const text = extractUserText(evt);
    // task-notification, system-reminder 등 harness 내부 태그 — 숨김
    if (/<task-notification>|<system-reminder>|<local-command-caveat>/.test(text)) return '';
    // ec-system inject
    const ecSys = text.match(/^<ec-system>([\s\S]*?)<\/ec-system>$/);
    if (ecSys) {
      const body = ecSys[1].replace(/<ec-hint>[\s\S]*?<\/ec-hint>/gi, '').trim();
      return `<div class="ec-turn-ec-system">${esc(body)}</div>`;
    }
    // channel
    const ch = extractChannelEnvelope(text);
    if (ch) {
      return `<div class="ec-turn ec-turn-channel">
        <div class="ec-turn-label" style="color:var(--muted)">${esc(ch.source)}${ch.from ? ' · ' + esc(ch.from) : ''}</div>
        <div class="ec-turn-body channel">${ecRenderBody(ch.body)}</div>
      </div>`;
    }
    const label = cfg?.userName || T('user_default');
    return `<div class="ec-turn ec-turn-human">
      <div class="ec-turn-label" style="color:${COLORS.human}">${esc(label)}</div>
      <div class="ec-turn-body human">${ecRenderBody(text)}</div>
    </div>`;
  }

  // assistant
  if (cat.startsWith('asst_')) {
    const parts = extractAssistantParts(evt);
    const sessLabel = window.__activeSessLabel || 'Claude';
    let bodyHtml = '';
    // thinking fold는 어시스턴트 버블 밖에 따로 렌더링 (아래에서 반환)
    const thinkingHtml = (parts.thinking && parts.thinking.trim())
      ? `<details class="ec-thinking-fold" data-fold-i="${foldIdx ?? ''}"><summary class="ec-thinking-summary">생각 완료</summary><pre class="ec-code-thinking ec-fold-clickable">${esc(parts.thinking)}</pre></details>`
      : '';
    if (parts.text) {
      bodyHtml += `<div>${ecRenderBody(parts.text)}</div>`;
    }
    if (parts.tools.length > 0 && !parts.text && !parts.thinking) {
      bodyHtml = `<div style="font-size:12px;color:var(--muted)">${esc(parts.tools.map(t => t.name).join(', '))} 호출 중…</div>`;
    }
    if (!bodyHtml && !thinkingHtml) return '';
    const assistHtml = bodyHtml ? `<div class="ec-turn ec-turn-assistant">
      <div class="ec-turn-label" style="color:${COLORS.assistant||'var(--green)'}">${esc(sessLabel)}</div>
      <div class="ec-turn-body assistant">${bodyHtml}</div>
    </div>` : '';
    return thinkingHtml + assistHtml;
  }

  // hook fold
  if (cat.startsWith('hook:') || cat.startsWith('hook_err:') || cat.startsWith('hook_cancelled:')) {
    const label = cat;
    return `<details class="ec-turn-fold"><summary>▸ ${esc(label)}</summary><pre>${esc(JSON.stringify(evt, null, 2))}</pre></details>`;
  }

  // debug fallback
  if (showDebugEvents && showDebugEvents()) {
    return `<div class="ec-turn ec-turn-meta" style="font-size:10px;color:var(--muted)"><span class="ec-turn-label">${esc(cat)}</span> ${esc(JSON.stringify(evt).slice(0, 200))}</div>`;
  }
  return '';
}

// tool_result_response에서 텍스트 추출
function extractToolResultText(evt) {
  const contents = evt.message?.content || [];
  for (const c of contents) {
    if (c.type === 'tool_result') {
      const rc = c.content;
      if (typeof rc === 'string') return rc;
      if (Array.isArray(rc)) return rc.map(x => x.text || '').join('\n');
    }
    if (c.type === 'text') return c.text || '';
  }
  return '';
}

// ── 이벤트 스트림 렌더 (괄호 그룹핑 포함) ───────────────────────────────────
function renderEventStream(events, opts) {
  opts = opts || {};
  let html = '';
  let i = 0;

  while (i < events.length) {
    const e = events[i];
    const { evt, lex } = e;
    const cat = lex.category;

    // slash_cmd_result 브라켓: local_command /cmd → 결과
    if (cat === 'slash_cmd_result') {
      const content = evt.content || '';
      if (/^\/\w/.test(content.trim())) {
        const cmd = content.trim();
        let resultHtml = '';
        if (i + 1 < events.length && events[i + 1].lex.category === 'slash_cmd_result') {
          const nextContent = events[i + 1].evt.content || '';
          const stdoutM = nextContent.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
          const stderrM = nextContent.match(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/);
          const result = (stdoutM || stderrM)?.[1]?.trim();
          // /compact 결과 "Compacted"는 compact_boundary가 이미 표시하므로 숨김
          if (result && !/^\/compact/i.test(cmd)) resultHtml = `<div class="ec-turn-ec-system ec-slash-result">${esc(result)}</div>`;
          i += 2;
        } else {
          i++;
        }
        html += `<div class="ec-cmd-pill ec-cmd-pill-slash">${esc(cmd)}</div>${resultHtml}`;
        continue;
      }
      i++;
      continue;
    }

    // user_text with ! → asst_tool_use로 통합 처리하므로 여기서 스킵
    if (cat === 'user_text') {
      const text = extractUserText(evt);
      if (/^!\s/.test(text)) { i++; continue; }
    }

    // tool_result_response — fold에서 소비 안 됐으면 스킵 (밖에 노출 방지)
    if (cat === 'tool_result_response') { i++; continue; }

    // thinking_complete synthetic 이벤트 → "생각 완료" fold
    if (cat === 'thinking_complete') {
      html += `<details class="ec-thinking-fold" data-fold-i="${i}"><summary class="ec-thinking-summary">생각 완료</summary><pre class="ec-code-thinking ec-fold-clickable">${esc(evt.thinking || '')}</pre></details>`;
      i++; continue;
    }
    // asst_thinking: 마지막 것만 "생각 완료" fold로 렌더 (진행 중엔 스킵)
    if (cat === 'asst_thinking') {
      if (opts.turnComplete) {
        const hasLater = events.slice(i + 1).some(e => e.lex.category === 'asst_thinking');
        if (!hasLater) {
          const parts = extractAssistantParts(evt);
          if (parts.thinking && parts.thinking.trim()) {
            html += `<details class="ec-thinking-fold" data-fold-i="${i}"><summary class="ec-thinking-summary">생각 완료</summary><pre class="ec-code-thinking ec-fold-clickable">${esc(parts.thinking)}</pre></details>`;
          }
        }
      }
      i++; continue;
    }

    // compact_boundary 브라켓: 이후 user_text(요약), meta, local_command 수집
    if (cat.startsWith('compact_boundary')) {
      const compactMeta = evt.compactMetadata || evt.compact_metadata || {};
      const details = [];
      let j = i + 1;
      while (j < events.length) {
        const ne = events[j];
        const nc = ne.lex.category;
        // 요약 텍스트 → details에 포함
        if (nc === 'user_text') {
          const t = extractUserText(ne.evt);
          if (/^This session is being continued/i.test(t.trim())) {
            details.push(t); j++; continue;
          }
          break; // 실제 사용자 메시지면 중단
        }
        // post-compact 메타(caveat, local_command 등) → 스킵
        if (ne.lex.css === 'hidden' || nc === 'slash_cmd_result' || nc === 'user_meta') {
          j++; continue;
        }
        break;
      }
      const metaStr = compactMeta.preTokens != null
        ? ` · ${compactMeta.trigger === 'auto' ? '자동' : '수동'} · ${compactMeta.preTokens.toLocaleString()} → ${compactMeta.postTokens.toLocaleString()} tokens${compactMeta.durationMs ? ` · ${(compactMeta.durationMs/1000).toFixed(0)}s` : ''}`
        : '';
      const detailHtml = details.length
        ? `<details class="ec-compact-details"><summary>요약 보기</summary><pre>${esc(details.join('\n\n'))}</pre></details>`
        : '';
      html += `<div class="ec-turn-ec-system"><div class="ec-divider">대화가 압축됐습니다.${esc(metaStr)}</div>${detailHtml}</div>`;
      i = j;
      continue;
    }

    // asst_tool_use → 연속된 tool_use 이벤트들을 하나의 fold로 그룹화
    if (cat === 'asst_tool_use') {
      // 연속 asst_tool_use 이벤트 수집
      const toolGroups = [{ evt, lex }];
      let j = i + 1;
      while (j < events.length && events[j].lex.category === 'asst_tool_use') {
        toolGroups.push(events[j]);
        j++;
      }
      const allToolIds = new Set();
      const LOOKAHEAD = 40;

      // 각 그룹의 tool_use + result 수집 → 탭 UI
      const toolTabId = `ec-tool-${i}`;
      const groupHtml = toolGroups.map((g, gi) => {
        const gtools = (g.evt.message?.content || []).filter(c => c.type === 'tool_use');
        const gids = new Set(gtools.map(t => t.id).filter(Boolean));
        gids.forEach(id => allToolIds.add(id));
        const gLabel = gtools.map(t => t.name).join(', ');
        const inputStr = gtools.map(t => {
          const s = typeof t.input === 'string' ? t.input : JSON.stringify(t.input || {}, null, 2);
          return s.slice(0, 1000);
        }).join('\n');
        let outputStr = '';
        for (let k = j; k < events.length && k <= j + LOOKAHEAD; k++) {
          const ne = events[k];
          if (ne.lex.category === 'tool_result_response') {
            const rid = ne.evt.message?.content?.[0]?.tool_use_id;
            if (!gids.size || gids.has(rid)) { outputStr = extractToolResultText(ne.evt).slice(0, 3000); break; }
          }
          if (ne.lex.category.startsWith('asst_')) break;
        }
        const subId = toolGroups.length > 1 ? `${toolTabId}-${gi}` : toolTabId;
        const tabPanel = `<div class="ec-tool-panel" id="${subId}">
          <div class="ec-tool-content">
            <pre class="ec-code-input ec-tool-pane active" data-pane="input">${esc(inputStr)}</pre>
            <pre class="ec-code-output ec-tool-pane" data-pane="output">${outputStr ? esc(outputStr) : '<span style="color:var(--muted);font-size:11px">출력 없음</span>'}</pre>
          </div>
          <div class="ec-tool-tabs">
            <button class="ec-tool-tab active" data-panel="${subId}" data-pane="input">입력</button>
            <button class="ec-tool-tab" data-panel="${subId}" data-pane="output">출력</button>
          </div>
        </div>`;
        if (toolGroups.length === 1) return tabPanel;
        return `<div class="ec-tool-sub-label">${esc(gLabel)}</div>${tabPanel}`;
      }).join('');

      const outerLabel = toolGroups.length === 1
        ? (toolGroups[0].evt.message?.content || []).filter(c => c.type === 'tool_use').map(t => t.name).join(', ')
        : `툴 ${toolGroups.length}개`;

      html += `<details class="ec-turn-fold" data-fold-i="${i}"><summary>▸ ${esc(outerLabel)}</summary>${groupHtml}</details>`;
      i = j;
      continue;
    }

    html += renderSingleEvent(e, i);
    i++;
  }

  return html;
}

// ── pending 렌더 ─────────────────────────────────────────────────────────────
function renderPendingInputs(pending, ch) {
  const opaque = ch && ch.thinkingActive; // thinking 중이면 pending도 불투명
  const cls = opaque ? '' : ' ec-pending';
  return pending.map(p => {
    if (p.kind === 'slash') return `<div class="ec-cmd-pill ec-cmd-pill-slash${cls}">${esc(p.text)}</div>`;
    if (p.kind === 'bash')  return `<div class="ec-cmd-pill ec-cmd-pill-bash${cls}">${esc(p.text)}</div>`;
    const label = cfg?.userName || (T && T('user_default')) || 'User';
    return `<div class="ec-turn ec-turn-human${cls}">
      <div class="ec-turn-label" style="color:${COLORS?.human||'var(--blue)'}">${esc(label)}</div>
      <div class="ec-turn-body human">${esc(p.text)}</div>
    </div>`;
  }).join('');
}

// pending 확인 (echo 도착 여부)
function confirmPendingInputs(ch) {
  if (!ch.pendingInputs?.length) return;
  const norm = s => (s || '').replace(/`/g, '').trim();
  const isConfirmed = p => (ch.events || []).some(e => {
    if (e.lex.category !== 'user_text') return false;
    return norm(extractUserText(e.evt)) === norm(p.text);
  });
  const confirmed = ch.pendingInputs.filter(isConfirmed);
  confirmed.forEach(p => { if (p.draftKey) localStorage.removeItem(p.draftKey); });
  ch.pendingInputs = ch.pendingInputs.filter(p => !isConfirmed(p));
}

// isWaiting 판단
function isWaitingForResponse(ch, pending) {
  if (!ch.alive || pending.length > 0) return false;
  if (ch.hadResult) return false; // result 수신됨 (인터럽트 포함) — 대기 해제
  const events = ch.events || [];
  if (!events.length) return false;
  // 마지막 실질 이벤트가 user turn이면 응답 대기 중
  for (let i = events.length - 1; i >= 0; i--) {
    const cat = events[i].lex.category;
    if (cat === 'tool_result_response') continue; // hidden 이벤트 skip
    return cat === 'user_text' || cat === 'user_block';
  }
  return false;
}

if (typeof module !== 'undefined') module.exports = { renderEventStream, renderPendingInputs, confirmPendingInputs, isWaitingForResponse, extractUserText };
