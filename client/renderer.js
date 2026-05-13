'use strict';
// renderer.js — lexicon이 분류한 {evt, lex} 이벤트 배열을 HTML로 렌더링.
// 파싱 없음. raw event에서 필요한 필드를 직접 추출해 lex.css를 적용.

/* global esc, ecRenderBody, COLORS, cfg, T, LABELS, showDebugEvents */

// ── 콘텐츠 추출 헬퍼 ─────────────────────────────────────────────────────────
function extractUserText(evt) {
  const content = evt.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.length > 0) {
    const c = content[0];
    if (c && typeof c === 'object') return c.text || '';
  }
  return '';
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
function renderSingleEvent(e) {
  const { evt, lex } = e;
  const cat = lex.category;
  const css = lex.css.replace(/^\./g, '').replace(/\./g, ' ');

  // EC 시스템 메시지들
  if (cat.startsWith('compact_boundary')) {
    const m = evt.compactMetadata || evt.compact_metadata || {};
    const metaStr = m.preTokens != null
      ? ` · ${m.trigger === 'auto' ? '자동' : '수동'} · ${m.preTokens.toLocaleString()} → ${m.postTokens.toLocaleString()} tokens${m.durationMs ? ` · ${(m.durationMs/1000).toFixed(0)}s` : ''}`
      : '';
    return `<div class="ec-turn-ec-system"><div class="ec-divider">대화가 압축됐습니다.${esc(metaStr)}</div></div>`;
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
    // ec-system inject
    const ecSys = text.match(/^<ec-system>([\s\S]*?)<\/ec-system>$/);
    if (ecSys) return `<div class="ec-turn-ec-system">${esc(ecSys[1].trim())}</div>`;
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
    if (parts.thinking) {
      bodyHtml += `<details class="ec-thinking-block"><summary style="font-size:11px;color:var(--muted);cursor:pointer">생각 보기</summary><div style="font-size:12px;color:var(--muted)">${ecRenderBody(parts.thinking)}</div></details>`;
    }
    if (parts.text) {
      bodyHtml += `<div>${ecRenderBody(parts.text)}</div>`;
    }
    if (parts.tools.length > 0 && !parts.text && !parts.thinking) {
      bodyHtml = `<div style="font-size:12px;color:var(--muted)">${esc(parts.tools.map(t => t.name).join(', '))} 호출 중…</div>`;
    }
    if (!bodyHtml) return '';
    return `<div class="ec-turn ec-turn-assistant">
      <div class="ec-turn-label" style="color:${COLORS.assistant||'var(--green)'}">${esc(sessLabel)}</div>
      <div class="ec-turn-body assistant">${bodyHtml}</div>
    </div>`;
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

// ── 이벤트 스트림 렌더 (괄호 그룹핑 포함) ───────────────────────────────────
function renderEventStream(events) {
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
          if (result) resultHtml = `<div class="ec-turn-ec-system ec-slash-result">${esc(result)}</div>`;
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

    // user_text with ! → bash 그룹
    if (cat === 'user_text') {
      const text = extractUserText(evt);
      if (/^!\s/.test(text)) {
        const related = [];
        let j = i + 1;
        while (j < events.length) {
          const ne = events[j];
          if (ne.lex.category === 'asst_tool_use') {
            const tc = (ne.evt.message?.content || []).find(c => c.type === 'tool_use' && c.name === 'Bash');
            if (tc) {
              const output = (ne.evt.message?.content || []).find(c => c.type === 'tool_result')?.content;
              related.push({ input: tc.input, output });
              j++;
              break;
            }
          }
          if (['user_text', 'user_block', 'asst_text', 'asst_thinking+text'].includes(ne.lex.category)) break;
          j++;
        }
        const outputHtml = related.map(r => {
          const out = typeof r.output === 'string' ? r.output : JSON.stringify(r.output || '');
          return out ? `<pre class="ec-bash-output">${esc(out)}</pre>` : '';
        }).join('');
        html += `<div class="ec-bash-group">
          <div class="ec-cmd-pill ec-cmd-pill-bash">${esc(text)}</div>
          ${outputHtml ? `<details class="ec-bash-details"><summary>출력 보기</summary>${outputHtml}</details>` : ''}
        </div>`;
        i = j;
        continue;
      }
    }

    // asst_tool_use → fold (비-bash 도구)
    if (cat === 'asst_tool_use') {
      const tools = (evt.message?.content || []).filter(c => c.type === 'tool_use');
      const label = tools.map(t => t.name).join(', ');
      const inner = renderSingleEvent(e);
      html += `<details class="ec-turn-fold"><summary>▸ ${esc(label)}</summary>${inner}</details>`;
      i++;
      continue;
    }

    html += renderSingleEvent(e);
    i++;
  }

  return html;
}

// ── pending 렌더 ─────────────────────────────────────────────────────────────
function renderPendingInputs(pending) {
  return pending.map(p => {
    if (p.kind === 'slash') return `<div class="ec-cmd-pill ec-cmd-pill-slash ec-pending">${esc(p.text)}</div>`;
    if (p.kind === 'bash')  return `<div class="ec-cmd-pill ec-cmd-pill-bash ec-pending">${esc(p.text)}</div>`;
    const label = cfg?.userName || (T && T('user_default')) || 'User';
    return `<div class="ec-turn ec-turn-human ec-pending">
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
  const events = ch.events || [];
  if (!events.length) return false;
  const last = events[events.length - 1];
  return last && (last.lex.category === 'user_text' || last.lex.category === 'user_block');
}

if (typeof module !== 'undefined') module.exports = { renderEventStream, renderPendingInputs, confirmPendingInputs, isWaitingForResponse, extractUserText };
