// ============================================================
// chat.info — 채팅 상단바 + 입력 아래 usage 표시
// ============================================================

chat.info = chat.info || function(k){ return k==null?chat.info:chat.info[k]; };
chat.info.dom = chat.info.dom || {};
chat.info.usage = chat.info.usage || {};
chat.info.status = chat.info.status || {};
chat.info.label = chat.info.label || {};
chat.info.perm = chat.info.perm || {};

(function init() {
  const $ = core.system.dom.$;
  chat.info.dom.activeLabel  = $('ec-active-label');
  chat.info.dom.status       = $('ec-status');
  chat.info.dom.usage        = $('ec-usage');
  chat.info.dom.viewbarUsage = $('ec-viewbar-usage');
  chat.info.dom.restart      = $('ec-restart-btn');
  chat.info.dom.disconnect   = $('ec-disconnect-btn');
  chat.info.dom.infoBtn      = $('ec-info-btn');
  chat.info.dom.permPill     = $('ec-perm-pill');
  chat.info.dom.permToggle   = $('ec-perm-toggle-btn');
  chat.info.dom.modelToggle  = $('ec-model-toggle-btn');
})();

// 연결 상태 표시 (WS 이벤트에서 호출)
chat.info.status.set = (text, kind) => {
  const el = chat.info.dom.status;
  if (!el) return;
  el.textContent = text;
  el.className = 'ec-parse-status' + (kind ? ' ec-status-' + kind : '');
};
window.setStatus = chat.info.status.set;

// 권한 pill 렌더 (채팅 상단 우측)
chat.info.perm.render = () => {
  const pill = chat.info.dom.permPill;
  if (!pill) return;
  const ch = (typeof activeChannel === 'function') ? activeChannel() : null;
  if (!ch) { pill.style.display = 'none'; return; }
  const sess = state.session.list.find(s => s.id === ch.sessionId);
  const ctrl = (typeof parseControlsFromArgs === 'function') ? parseControlsFromArgs(sess?.args) : { permissionMode: 'default' };
  let mode = ctrl.permissionMode;
  if (ctrl.permissionPromptTool) mode = 'prompt-tool';
  pill.style.display = '';
  const lockIcon = mode === 'bypassPermissions'
    ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="2.5"/></svg>`
    : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
  pill.innerHTML = lockIcon;
  pill.dataset.mode = mode;
  pill.title = cfg.bypassEnabled
    ? '클릭: bypassPermissions ↔ default 토글 (재기동)'
    : '권한 모드 (위험 모드 비활성)';
  pill.disabled = !cfg.bypassEnabled;
  pill.classList.toggle('ec-perm-bypass', mode === 'bypassPermissions');
};
window.renderPermPill = chat.info.perm.render;

// 권한 pill 클릭 핸들러 (modal.chat.perm.show 호출 — 아직 app.js에 showPermModal 있음)
chat.info.dom.permPill?.addEventListener('click', () => {
  if (typeof showPermModal === 'function') showPermModal();
});

// 포맷 헬퍼 (chat.info에 위치 — usage 표시용)
chat.info.fmtNum = (n) => (n || 0).toLocaleString();
chat.info.fmtTok = (n) => {
  n = n || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
};
window.fmtNum = chat.info.fmtNum;
window.fmtTok = chat.info.fmtTok;

// _cachedHomeMsg 호환
window._cachedHomeMsg = null;

// usage render
chat.info.usage.render = function() {
  const ch = activeChannel();
  const setBoth = (text, title) => {
    const $vu = chat.info.dom.viewbarUsage;
    if ($vu) { $vu.textContent = text; if (title) $vu.title = title; }
  };
  if (!ch) {
    if (!window._cachedHomeMsg) window._cachedHomeMsg = chat.message.welcome.genMsg();
    chat.message.welcome.setStatus(window._cachedHomeMsg);
    return;
  }
  window._cachedHomeMsg = null;
  const u = ch.usage;
  const s = ch.session || {};
  const model = s.model || '';
  const mcpBad = (s.mcpServers || []).filter(m => m.status && m.status !== 'connected' && m.status !== 'needs-auth').length;
  const mcpAuth = (s.mcpServers || []).filter(m => m.status === 'needs-auth').length;
  let mcp = '';
  if (s.mcpServers?.length) {
    const ok = s.mcpServers.length - mcpBad - mcpAuth;
    mcp = ` · MCP ${ok}/${s.mcpServers.length}`;
    if (mcpBad) mcp += ` ✕${mcpBad}`;
    if (mcpAuth) mcp += ` ⚠${mcpAuth}`;
  }
  const sess = ecSessions.find(x => x.id === ch.sessionId);
  const fallback = model || (sess ? effectiveLabel(sess) : '');
  if (!u) { setBoth(fallback + mcp, ''); return; }
  const total = (u.input || 0) + (u.output || 0) + (u.cache_read || 0);
  const ctxTokEarly = s.lastCtxInput || 0;
  if (!total && !ctxTokEarly) { setBoth(fallback + mcp, ''); return; }
  const ctxTok = s.lastCtxInput || 0;
  const maxCtx = /\[1m\]/i.test(model) ? 1048576 : 200000;
  const usedPct = ctxTok > 0 ? Math.min(100, Math.round(ctxTok / maxCtx * 100)) : null;
  const ctxStr = usedPct !== null ? ` · ctx ${usedPct}%` : '';
  const text = `${chat.info.fmtTok(total)} tok${ctxStr}${mcp}`;
  const title = `model: ${model}\nin: ${chat.info.fmtNum(u.input)} / out: ${chat.info.fmtNum(u.output)}\ncache_read: ${chat.info.fmtNum(u.cache_read)} / cache_create: ${chat.info.fmtNum(u.cache_creation)}\ntotal: ${chat.info.fmtNum(total)} / ctx 사용: ${chat.info.fmtNum(ctxTok)} / ${usedPct ?? '?'}% (최대 ${chat.info.fmtNum(maxCtx)})\n${(s.mcpServers||[]).map(m=>`${m.name}: ${m.status}`).join('\n')}`;
  setBoth(text, title);
};
window.renderUsage = chat.info.usage.render;

// app.js에서 본체 이동 예정 placeholder (alias로 연결):
//   chat.info.usage.render    (renderUsage)
//   chat.info.label.update    (effectiveLabel 표시)
//   chat.info.perm.render     (renderPermPill)
// 현재는 app.js의 함수가 글로벌에 있으므로 그대로 동작.
