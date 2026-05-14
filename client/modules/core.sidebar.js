// ============================================================
// core.sidebar — 좌측 사이드바 (탭 리스트, 설정 버튼)
//   탭 렌더/액션/prefs/hidden/그룹 분류 모두 포함 (자기완결적)
// ============================================================

core.sidebar = core.sidebar || {};
core.sidebar.dom = core.sidebar.dom || {};
core.sidebar.tab = core.sidebar.tab || {};
core.sidebar.tab.prefs = core.sidebar.tab.prefs || {};
core.sidebar.tab.hidden = core.sidebar.tab.hidden || {};
core.sidebar.tab.actions = core.sidebar.tab.actions || {};

(function init() {
  const $ = core.system.dom.$;
  core.sidebar.dom.nav         = $('ec-nav');
  core.sidebar.dom.tabs        = $('ec-tabs');
  core.sidebar.dom.settingsBtn = $('ec-settings-btn');
})();

core.sidebar.tab.render = function() {
  const T = core.system.i18n.t;
  $tabs.innerHTML = '';
  const _newBtn = document.createElement('button');
  _newBtn.id = 'ec-new-session-btn-tab';
  _newBtn.className = 'ec-new-session-tab';
  _newBtn.textContent = '＋ 새 세션';
  _newBtn.addEventListener('click', showNewSessionModal);
  $tabs.appendChild(_newBtn);
  const sorted = [...ecSessions].sort((a, b) => {
    const ka = tabSortKey(a, tabPrefs);
    const kb = tabSortKey(b, tabPrefs);
    if (ka.pinned !== kb.pinned) return ka.pinned - kb.pinned;
    if (ka.pinned === 0) {
      if (ka.pinOrder !== kb.pinOrder) return ka.pinOrder - kb.pinOrder;
    }
    if (ka.group !== kb.group) {
      if (!ka.group) return 1;
      if (!kb.group) return -1;
      return ka.group.localeCompare(kb.group);
    }
    return ka.label.localeCompare(kb.label);
  });
  const pinned = sorted.filter(s => tabPrefs[s.id]?.pinned);
  const rest = sorted.filter(s => !tabPrefs[s.id]?.pinned);
  if (pinned.length) core.sidebar.tab.appendSection(T('pinned_header'), pinned, '__pinned__');
  const groups = new Map();
  for (const s of rest) {
    const g = tabPrefs[s.id]?.group || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const groupNames = [...groups.keys()].filter(g => g);
  for (const g of groupNames) {
    const groupItems = [...groups.get(g)].sort((a, b) =>
      (tabPrefs[a.id]?.groupOrder || 0) - (tabPrefs[b.id]?.groupOrder || 0)
    );
    core.sidebar.tab.appendSection(g, groupItems, g);
  }
  const ungrouped = groups.get('') || [];
  if (ungrouped.length) {
    const ungroupedSorted = [...ungrouped].sort((a, b) => {
      const ta = a.lastTurnAt || 0;
      const tb = b.lastTurnAt || 0;
      if (ta !== tb) return tb - ta;
      return (b.id > a.id ? 1 : -1);
    });
    core.sidebar.tab.appendSection(pinned.length || groupNames.length ? T('unnamed_header') : null, ungroupedSorted, '__ungrouped__');
  }
  refreshTabState();
};
window.renderTabs = core.sidebar.tab.render;

core.sidebar.tab.appendSection = function(headerLabel, items, groupKey) {
  const esc = core.system.format.esc;
  if (headerLabel) {
    const isCollapsed = collapsedGroups.has(groupKey);
    const header = document.createElement('div');
    header.className = 'ec-tab-group-header';
    header.innerHTML = `<span class="ec-group-caret">${isCollapsed ? '▸' : '▾'}</span>` +
      `<span class="ec-group-name">${esc(headerLabel)}</span>` +
      `<span class="ec-group-count">${items.length}</span>`;
    header.addEventListener('click', () => {
      if (collapsedGroups.has(groupKey)) collapsedGroups.delete(groupKey);
      else collapsedGroups.add(groupKey);
      core.sidebar.tab.render();
    });
    $tabs.appendChild(header);
    if (isCollapsed) return;
  }
  const isDraggable = groupKey === '__pinned__' || (groupKey !== '__ungrouped__' && groupKey);
  for (const s of items) {
    const el = core.sidebar.tab.create(s);
    if (isDraggable) {
      const handle = el.querySelector('.ec-tab-handle');
      if (handle) handle.classList.remove('ec-hidden');
      let dragReady = false;
      handle?.addEventListener('mousedown', () => { dragReady = true; el.draggable = true; });
      handle?.addEventListener('touchstart', (e) => { e.preventDefault(); dragReady = true; el.draggable = true; }, { passive: false });
      const clearDropIndicators = () => {
        document.querySelectorAll('.ec-tab-drop-before,.ec-tab-drop-after')
          .forEach(t => t.classList.remove('ec-tab-drop-before','ec-tab-drop-after'));
      };
      el.addEventListener('dragend', () => {
        dragReady = false; el.draggable = false;
        el.classList.remove('ec-tab-dragging');
        clearDropIndicators();
      });
      el.addEventListener('dragstart', (e) => {
        if (!dragReady) { e.preventDefault(); return; }
        e.dataTransfer.setData('text/plain', s.id);
        e.dataTransfer.effectAllowed = 'move';
        el.classList.add('ec-tab-dragging');
      });
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clearDropIndicators();
        const mid = el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2;
        el.classList.add(e.clientY < mid ? 'ec-tab-drop-before' : 'ec-tab-drop-after');
      });
      el.addEventListener('dragleave', clearDropIndicators);
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        const insertBefore = el.classList.contains('ec-tab-drop-before');
        clearDropIndicators();
        const fromId = e.dataTransfer.getData('text/plain');
        if (fromId === s.id) return;
        const orderKey = groupKey === '__pinned__' ? 'pinOrder' : 'groupOrder';
        const newOrder = items.map(i => i.id).filter(id => id !== fromId);
        const targetIdx = newOrder.indexOf(s.id);
        newOrder.splice(insertBefore ? targetIdx : targetIdx + 1, 0, fromId);
        newOrder.forEach((id, idx) => {
          tabPrefs[id] = { ...(tabPrefs[id] || {}), [orderKey]: idx };
          core.system.ws.send({ op: 'tab_pref', sessionId: id, patch: { [orderKey]: idx } });
        });
        core.sidebar.tab.render();
      });
    }
    $tabs.appendChild(el);
  }
};
window.appendTabSection = core.sidebar.tab.appendSection;

core.sidebar.tab.label = function(s) {
  const ch = channels.get(s.id);
  return (ch && ch.session && ch.session.customTitle) || s.label || s.id;
};
window.effectiveLabel = core.sidebar.tab.label;

core.sidebar.tab.sync = function(ch) {
  const s = ecSessions.find(x => x.id === ch.sessionId);
  if (!s) return;
  const label = (ch.session && ch.session.customTitle) || s.label || s.id;
  ch.label = label;
  const tab = document.querySelector(`.ec-tab[data-sid="${CSS.escape(ch.sessionId)}"] .ec-tab-label`);
  if (tab) tab.textContent = label;
  if (ch.sessionId === activeSid && $activeLabel) $activeLabel.textContent = label;
};
window.syncSessionLabel = core.sidebar.tab.sync;

// ─── prefs ────────────────────────────────────────────────
core.sidebar.tab.prefs.get = function(sid) { return tabPrefs[sid] || {}; };
window.getTabPref = core.sidebar.tab.prefs.get;

core.sidebar.tab.prefs.set = function(sid, patch) {
  tabPrefs[sid] = { ...(tabPrefs[sid] || {}), ...patch };
  for (const [k, v] of Object.entries(tabPrefs[sid])) {
    if (v === null || v === undefined || v === '') delete tabPrefs[sid][k];
  }
  if (!Object.keys(tabPrefs[sid]).length) delete tabPrefs[sid];
  core.system.ws.send({ op: 'tab_pref', sessionId: sid, patch });
  core.sidebar.tab.render();
};
window.setTabPref = core.sidebar.tab.prefs.set;

core.sidebar.tab.prefs.sortKey = function(s, prefs) {
  const p = prefs[s.id] || {};
  return {
    pinned: p.pinned ? 0 : 1,
    pinOrder: p.pinOrder ?? 99999,
    group: p.group || '',
    label: s.label || s.id,
  };
};
window.tabSortKey = core.sidebar.tab.prefs.sortKey;

// ─── hidden store ─────────────────────────────────────────
core.sidebar.tab.hidden.KEY = 'easyclaude.hiddenSessions';
core.sidebar.tab.hidden.load = function() {
  try { return JSON.parse(localStorage.getItem(core.sidebar.tab.hidden.KEY) || '{}'); }
  catch { return {}; }
};
window.loadHiddenStore = core.sidebar.tab.hidden.load;

core.sidebar.tab.hidden.save = function(store) {
  localStorage.setItem(core.sidebar.tab.hidden.KEY, JSON.stringify(store));
};
window.saveHiddenStore = core.sidebar.tab.hidden.save;

core.sidebar.tab.hidden.remember = function(s) {
  const store = core.sidebar.tab.hidden.load();
  store[s.id] = {
    id: s.id, label: s.label || s.id, cwd: s.cwd || '',
    hiddenAt: new Date().toISOString(),
  };
  core.sidebar.tab.hidden.save(store);
};
window.rememberHiddenSession = core.sidebar.tab.hidden.remember;

core.sidebar.tab.hidden.forget = function(sid) {
  const store = core.sidebar.tab.hidden.load();
  delete store[sid];
  core.sidebar.tab.hidden.save(store);
};
window.forgetHiddenSession = core.sidebar.tab.hidden.forget;

// ─── actions ──────────────────────────────────────────────
core.sidebar.tab.actions.delete = function(s) {
  if (!s.meta?.adhoc) {
    alert('config 세션은 "삭제"가 불가합니다.\n영구 삭제(purge)로 숨김 처리하세요.');
    return;
  }
  if (!confirm(`'${s.label}' 세션을 목록에서 제거할까요?\n(jsonl 파일은 보존됩니다)`)) return;
  core.system.ws.send({ op: 'delete_session', id: nextClientId++, sessionId: s.id });
};
window.handleTabDelete = core.sidebar.tab.actions.delete;

core.sidebar.tab.actions.purge = function(s) {
  const isAdhoc = !!s.meta?.adhoc;
  if (!isAdhoc) core.sidebar.tab.hidden.remember(s);
  const warn = isAdhoc
    ? `'${s.label}' 세션을 영구 삭제합니다.\n• 세션 목록에서 제거\n• ~/.claude/projects/.../*.jsonl 파일까지 제거\n이 작업은 되돌릴 수 없습니다.\n\n계속하려면 OK.`
    : `'${s.label}' (config 세션)을 숨김 처리합니다.\n• 목록에서 숨김 (config 파일은 보존)\n• ~/.claude/projects/.../*.jsonl 파일까지 제거\n숨김 해제는 "설정 → 숨김된 세션" 에서 가능합니다.\n\n계속하려면 OK.`;
  if (!confirm(warn)) return;
  const second = prompt(`확인: 정말 영구 삭제할까요?\n세션 ID '${s.id}' 를 입력해 확정하세요.`);
  if (second !== s.id) { alert('취소되었습니다 (id 미일치).'); return; }
  core.system.ws.send({ op: 'purge_session', id: nextClientId++, sessionId: s.id });
};
window.handleTabPurge = core.sidebar.tab.actions.purge;

core.sidebar.tab.actions.close = function(s) {
  const isAdhoc = !!s.meta?.adhoc;
  const label = isAdhoc ? '제거' : '숨김';
  if (!confirm(`'${s.label}' 탭을 ${label}할까요?\n(jsonl 보존 · 영구 삭제는 ⋮ 메뉴에서)`)) return;
  if (!isAdhoc) {
    core.sidebar.tab.hidden.remember(s);
    core.system.ws.send({ op: 'purge_session', id: nextClientId++, sessionId: s.id });
  } else {
    core.system.ws.send({ op: 'delete_session', id: nextClientId++, sessionId: s.id });
  }
};
window.handleTabClose = core.sidebar.tab.actions.close;

core.sidebar.tab.actions.refresh = function() {
  document.querySelectorAll('.ec-tab').forEach(t => {
    const sid = t.dataset.sid;
    const ch = channels.get(sid);
    const sess = ecSessions.find(s => s.id === sid);
    const alive = !!(ch && ch.alive) || !!(sess && sess.alive);
    t.classList.toggle('active', sid === activeSid);
    t.classList.toggle('connected', alive);
    t.classList.toggle('disconnected', !!(ch && !ch.alive) && !alive);
  });
  core.sidebar.tab.actions.updateInput();
};
window.refreshTabState = core.sidebar.tab.actions.refresh;

core.sidebar.tab.actions.updateInput = function() {
  const ch = activeChannel();
  const alive = !!(ch && ch.alive);
  const hasSession = !!activeSid;
  if ($interrupt) {
    $interrupt.disabled = !alive;
    $interrupt.classList.toggle('ec-active', alive);
  }
  $restart?.classList.toggle('ec-hidden', !hasSession);
  $disconnect?.classList.toggle('ec-hidden', !hasSession);
  core.system.dom.$('ec-perm-toggle-btn')?.classList.toggle('ec-hidden', !hasSession);
  core.system.dom.$('ec-model-toggle-btn')?.classList.toggle('ec-hidden', !hasSession);
};
window.updateInputBar = core.sidebar.tab.actions.updateInput;

core.sidebar.tab.actions.activate = function(sessionId) {
  if (!channels.has(sessionId)) return;
  const prevCh = activeSid ? channels.get(activeSid) : null;
  if (prevCh && $input.value.trim()) prevCh.draftText = $input.value;
  else if (prevCh) prevCh.draftText = '';
  activeSid = sessionId;
  lastActiveSid = sessionId;
  core.system.ws.send({ op: 'ui_state', lastActiveSessionId: sessionId });
  const ch = channels.get(sessionId);
  const sess = ecSessions.find(x => x.id === sessionId);
  const label = (ch?.session?.customTitle) || ch?.label || sess?.label || sessionId;
  if ($activeLabel) $activeLabel.textContent = label;
  core.sidebar.tab.actions.refresh();
  renderActive();
  renderUsage();
  chat.info.perm.render();
  $input.value = '';
  if (ch?.draftText) {
    $input.value = ch.draftText;
  } else {
    const savedDraft = localStorage.getItem('ec-draft-' + sessionId);
    if (savedDraft) {
      const events = [...(ch?.histEvents || []), ...(ch?.events || [])];
      const alreadySent = events.some(e => {
        if (e.lex?.category !== 'user_text') return false;
        const t = (e.evt?.message?.content?.[0]?.text || '').replace(/<ec-hint>[\s\S]*?<\/ec-hint>\n?/gi,'').trim();
        return t === savedDraft.trim();
      });
      if (!alreadySent) $input.value = savedDraft;
      else localStorage.removeItem('ec-draft-' + sessionId);
    }
  }
  autosize();
  if (ch?.pendingDialog) showDialog(ch);
  else hideDialog();
  requestAnimationFrame(() => $input.focus());
  if (ch && ch.histStart === -1 && !ch.histLoading) {
    ch.needsScrollBottom = true;
    loadMoreHistory(ch).then(() => {
      ch.needsScrollBottom = false;
      if (ch.sessionId === activeSid) $parsed.scrollTop = $parsed.scrollHeight;
    });
  }
};
window.activate = core.sidebar.tab.actions.activate;

core.sidebar.tab.actions.open = function(sessionId) {
  if (channels.has(sessionId)) return;
  const id = nextClientId++;
  const meta = ecSessions.find(s => s.id === sessionId);
  const ch = {
    id, sessionId,
    label: meta?.label || sessionId,
    alive: false,
    turns: [], events: [], histEvents: [], histTurns: [],
    histStart: -1, histTotal: 0, histLoading: false,
    pendingInputs: [], usage: null, session: null, pendingDialog: null,
  };
  channels.set(sessionId, ch);
  core.system.ws.send({ op: 'open', id, sessionId });
  ch.needsScrollBottom = true;
  loadMoreHistory(ch).then(() => {
    ch.needsScrollBottom = false;
    if (ch.sessionId === activeSid) $parsed.scrollTop = $parsed.scrollHeight;
  });
};
window.openSession = core.sidebar.tab.actions.open;

core.sidebar.tab.create = function(s) {
  const T = core.system.i18n.t;
  const esc = core.system.format.esc;
  const btn = document.createElement('button');
  btn.className = 'ec-tab';
  btn.dataset.sid = s.id;
  const pref = tabPrefs[s.id] || {};
  const ctxTitle = pref.pinned ? T('tab_unpin') : pref.group ? T('tab_group_remove') : T('tab_hide');
  const ctxAct   = pref.pinned ? 'unpin' : pref.group ? 'ungroup' : 'hide';
  const contextBtn = `<span class="ec-tab-ctx" data-ctx="${ctxAct}" title="${esc(ctxTitle)}">✕</span>`;
  btn.innerHTML = `<span class="ec-dot"></span>` +
    `<span class="ec-tab-label">${esc(core.sidebar.tab.label(s))}</span>` +
    contextBtn +
    `<span class="ec-tab-menu" title="옵션">⋮</span>` +
    `<span class="ec-tab-handle ec-hidden" title="순서 변경">⠿</span>`;
  btn.addEventListener('click', e => {
    if (e.target.classList.contains('ec-tab-ctx')) {
      e.stopPropagation();
      const ctx = e.target.dataset.ctx;
      if (ctx === 'unpin') setTabPref(s.id, { pinned: false, pinOrder: null });
      else if (ctx === 'ungroup') setTabPref(s.id, { group: null });
      else if (ctx === 'hide') handleTabClose(s);
      return;
    }
    if (e.target.classList.contains('ec-tab-menu')) {
      e.stopPropagation();
      return showTabMenu(s, btn);
    }
    if (!channels.has(s.id)) openSession(s.id);
    activate(s.id);
    $nav.classList.remove('open');
  });
  return btn;
};
window.createTabElement = core.sidebar.tab.create;

core.sidebar.tab.prefs = core.sidebar.tab.prefs || {};
core.sidebar.tab.prefs.get     = (...a) => window.getTabPref(...a);
core.sidebar.tab.prefs.set     = (...a) => window.setTabPref(...a);
core.sidebar.tab.prefs.sortKey = (...a) => window.tabSortKey(...a);

core.sidebar.tab.actions = core.sidebar.tab.actions || {};
core.sidebar.tab.actions.delete   = (...a) => window.handleTabDelete(...a);
core.sidebar.tab.actions.purge    = (...a) => window.handleTabPurge(...a);
core.sidebar.tab.actions.close    = (...a) => window.handleTabClose(...a);
core.sidebar.tab.actions.activate = (...a) => window.activate(...a);
core.sidebar.tab.actions.open     = (...a) => window.openSession(...a);
core.sidebar.tab.actions.refresh  = (...a) => window.refreshTabState(...a);
core.sidebar.tab.actions.updateInput = (...a) => window.updateInputBar(...a);

core.sidebar.tab.hidden = core.sidebar.tab.hidden || {};
core.sidebar.tab.hidden.load     = (...a) => window.loadHiddenStore(...a);
core.sidebar.tab.hidden.save     = (...a) => window.saveHiddenStore(...a);
core.sidebar.tab.hidden.remember = (...a) => window.rememberHiddenSession(...a);
core.sidebar.tab.hidden.forget   = (...a) => window.forgetHiddenSession(...a);
