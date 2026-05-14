// ============================================================
// core.system — 시스템 인프라 (state 트리, DOM 헬퍼, cfg, WS, 포맷, API, toast, preset)
// ============================================================

// ─── 글로벌 namespace ─────────────────────────────────────
window.core   = window.core   || function(k){ return k==null?core:core[k]; };
window.chat   = window.chat   || function(k){ return k==null?chat:chat[k]; };
window.modal  = window.modal  || function(k){ return k==null?modal:modal[k]; };
window.state  = window.state  || {};
core.system = core.system || function(k){ return k==null?core.system:core.system[k]; };

// ─── 공유 state 트리 ──────────────────────────────────────
state.session = state.session || {
  active: null, list: [], channels: new Map(),
  lastActive: null, pendingReopen: null,
};
state.tab = state.tab || { prefs: {}, collapsedGroups: new Set() };
state.system = state.system || {
  ws: null, outboundQueue: [],
  reconnect: { attempts: 0, timer: null },
  nextClientId: 1,
  claudeOptions: { efforts: [], permissionModes: [], models: [] },
};
state.modal = state.modal || {
  dialog: null,
  core:   { create: { tab: 'new', resumeSelected: null, searchDebounce: null } },
  config: { auth: { pollTimer: null } },
};
state.ui = state.ui || { toast: { timer: null }, ac: { idx: -1 } };
state.chat = state.chat || {
  message: { cachedHomeMsg: null },
  info:    { currentArgs: null },
};

// ─── 글로벌 호환 alias (이전 글로벌 변수명 ↔ state.* 양방향) ─────
// app.js / 모듈 어디서든 글로벌 이름 또는 state.* 둘 다 동작.
(function bindGlobals() {
  const bind = (name, get, set) => {
    if (Object.prototype.hasOwnProperty.call(window, name)) return; // 이미 있으면 skip
    Object.defineProperty(window, name, { get, set, configurable: true });
  };
  // state.session
  bind('activeSid',         () => state.session.active,         v => { state.session.active = v; });
  bind('ecSessions',        () => state.session.list,           v => { state.session.list = v; });
  bind('channels',          () => state.session.channels,       v => { state.session.channels = v; });
  bind('lastActiveSid',     () => state.session.lastActive,     v => { state.session.lastActive = v; });
  bind('pendingReopenSid',  () => state.session.pendingReopen,  v => { state.session.pendingReopen = v; });
  // state.system
  bind('ws',                () => state.system.ws,              v => { state.system.ws = v; });
  bind('outboundQueue',     () => state.system.outboundQueue,   v => { state.system.outboundQueue = v; });
  bind('nextClientId',      () => state.system.nextClientId,    v => { state.system.nextClientId = v; });
  bind('reconnectAttempts', () => state.system.reconnect.attempts, v => { state.system.reconnect.attempts = v; });
  bind('reconnectTimer',    () => state.system.reconnect.timer,    v => { state.system.reconnect.timer = v; });
  // state.tab
  bind('tabPrefs',          () => state.tab.prefs,              v => { state.tab.prefs = v; });
  bind('collapsedGroups',   () => state.tab.collapsedGroups,    v => { state.tab.collapsedGroups = v; });
  // state.ui
  bind('acIdx',             () => state.ui.ac.idx,              v => { state.ui.ac.idx = v; });
  // state.modal
  bind('currentDialog',     () => state.modal.dialog,           v => { state.modal.dialog = v; });
  bind('lgPollTimer',       () => state.modal.config.auth.pollTimer, v => { state.modal.config.auth.pollTimer = v; });
  bind('nsActiveTab',       () => state.modal.core.create.tab,            v => { state.modal.core.create.tab = v; });
  bind('nsResumeSelected',  () => state.modal.core.create.resumeSelected, v => { state.modal.core.create.resumeSelected = v; });
  bind('searchDebounce',    () => state.modal.core.create.searchDebounce, v => { state.modal.core.create.searchDebounce = v; });
  // state.chat
  bind('_cachedHomeMsg',    () => state.chat.message.cachedHomeMsg, v => { state.chat.message.cachedHomeMsg = v; });
  bind('_infoCurrentArgs',  () => state.chat.info.currentArgs,      v => { state.chat.info.currentArgs = v; });
  // state.system.claudeOptions
  bind('claudeOptions',     () => state.system.claudeOptions,   v => { state.system.claudeOptions = v; });
  // state.ui.toast
  bind('_toastTimer',       () => state.ui.toast.timer,         v => { state.ui.toast.timer = v; });
})();

// ─── DOM 헬퍼 ─────────────────────────────────────────────
core.system.dom = core.system.dom || {};
core.system.dom.$ = (id) => document.getElementById(id);

// ─── 포맷 헬퍼 ────────────────────────────────────────────
core.system.format = core.system.format || {};
core.system.format.esc     = (s) => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
core.system.format.escAttr = (s) => String(s ?? '').replace(/"/g, '&quot;');
core.system.format.num     = (n) => (n || 0).toLocaleString();
core.system.format.tok     = (n) => {
  if (n == null) return '';
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  return (n / 1000000).toFixed(n < 10000000 ? 2 : 1) + 'M';
};

// ─── i18n ─────────────────────────────────────────────────
core.system.i18n = core.system.i18n || {};
core.system.i18n.LOCALES = {
  ko: {
    new_session: '＋ 새 세션',
    settings: '설정',
    pinned_header: '고정',
    unnamed_header: '미분류',
    tab_rename: '이름 변경',
    tab_pin: '상단 고정',
    tab_unpin: '고정 해제',
    tab_group_add: '그룹 설정…',
    tab_group_remove: '그룹에서 제거',
    tab_hide: '숨기기',
    tab_restart: '재기동',
    tab_delete: '삭제',
    tab_unpin_btn: '해제',
    tab_ungroup_btn: '제거',
    user_default: '사용자',
    colors: ['파란','빨간','초록','노란','보라','주황','하늘','분홍','회색','갈색','검은','하얀'],
    animals: ['고양이','강아지','여우','토끼','곰','늑대','사슴','수달','판다','코끼리','기린','하마','독수리','부엉이','펭귄','돌고래','상어','호랑이','사자','치타'],
    session_name: (c, a) => `${c}색 ${a}`,
  },
  en: {
    new_session: '＋ New Session',
    settings: 'Settings',
    pinned_header: 'Pinned',
    unnamed_header: 'Unclassified',
    tab_rename: 'Rename',
    tab_pin: 'Pin to Top',
    tab_unpin: 'Unpin',
    tab_group_add: 'Set Group…',
    tab_group_remove: 'Remove from Group',
    tab_hide: 'Hide',
    tab_restart: 'Restart',
    tab_delete: 'Delete',
    tab_unpin_btn: 'Unpin',
    tab_ungroup_btn: 'Ungroup',
    user_default: 'User',
    colors: ['Blue','Red','Green','Yellow','Purple','Orange','Sky','Pink','Gray','Brown','Black','White'],
    animals: ['Cat','Dog','Fox','Rabbit','Bear','Wolf','Deer','Otter','Panda','Elephant','Giraffe','Hippo','Eagle','Owl','Penguin','Dolphin','Shark','Tiger','Lion','Cheetah'],
    session_name: (c, a) => `${c} ${a}`,
  },
};
core.system.i18n.t = (key) => {
  const cfg = window.cfg || {};
  const locale = cfg.locale || 'ko';
  const L = core.system.i18n.LOCALES[locale] || core.system.i18n.LOCALES.ko;
  return L[key] || key;
};
core.system.i18n.genSessionName = () => {
  const cfg = window.cfg || {};
  const locale = cfg.locale || 'ko';
  const L = core.system.i18n.LOCALES[locale] || core.system.i18n.LOCALES.ko;
  const c = L.colors[Math.floor(Math.random() * L.colors.length)];
  const a = L.animals[Math.floor(Math.random() * L.animals.length)];
  return L.session_name(c, a);
};
// 글로벌 alias (app.js 호환)
window.T = core.system.i18n.t;
window.genSessionName = core.system.i18n.genSessionName;
window.LOCALES = core.system.i18n.LOCALES;

// ─── API ──────────────────────────────────────────────────
core.system.api = core.system.api || {};
// 현재 페이지 path 기준 상대 URL prefix (reverse proxy 안전).
// 예: 페이지가 https://x/ec/  → base() = '/ec/' → fetch('/ec/api/...')
core.system.api.base = () => location.pathname.replace(/[^/]*$/, '') || '/';
window.apiBase = core.system.api.base;

// ─── Toast ────────────────────────────────────────────────
core.system.toast = core.system.toast || {};
core.system.toast.show = (text, kind = 'info', durationMs = 3000) => {
  let toast = document.getElementById('ec-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'ec-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.className = 'ec-toast ec-toast-' + kind + ' ec-toast-show';
  if (state.ui.toast.timer) clearTimeout(state.ui.toast.timer);
  state.ui.toast.timer = setTimeout(() => { toast.classList.remove('ec-toast-show'); }, durationMs);
};
window.showToast = core.system.toast.show;

// ─── Config ────────────────────────────────────────────────
core.system.cfg = core.system.cfg || {};
core.system.cfg.KEY = 'easyclaude.cfg';
core.system.cfg.TITLE_DEFAULTS = { default: 'easyclaude', philtoday: 'PhilConsole', custom: 'easyclaude' };
core.system.cfg.LOGO_CACHE = new Map();

core.system.cfg.save = () => {
  localStorage.setItem(core.system.cfg.KEY, JSON.stringify(cfg));
  core.system.cfg.apply();
  const syncFields = ['theme','themePreset','locale','userName','logoPreset','fontSize','bypassEnabled'];
  const patch = {};
  for (const k of syncFields) patch[k] = cfg[k];
  core.system.ws.send({ op: 'set_cfg', cfg: patch });
};

core.system.cfg.loadLogo = async (name) => {
  if (core.system.cfg.LOGO_CACHE.has(name)) return core.system.cfg.LOGO_CACHE.get(name);
  try {
    const r = await fetch(core.system.api.base() + 'logos/' + name + '.svg');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const svg = await r.text();
    core.system.cfg.LOGO_CACHE.set(name, svg);
    return svg;
  } catch (e) {
    console.warn('logo load fail', name, e.message);
    return '';
  }
};

core.system.cfg.apply = async () => {
  const $ = core.system.dom.$;
  if (cfg.themePreset === 'default') document.body.removeAttribute('data-theme-preset');
  else document.body.setAttribute('data-theme-preset', cfg.themePreset);
  const tokenKeys = ['bg','surface','surface-2','surface-3','border','border-strong',
    'text','text-2','muted','accent','accent-2','accent-3','green','warn','danger','info'];
  for (const k of tokenKeys) document.body.style.removeProperty('--' + k);
  if (cfg.themePreset === 'custom' && cfg.customTheme) {
    for (const [k, v] of Object.entries(cfg.customTheme)) { if (v) document.body.style.setProperty('--' + k, v); }
  }
  if (cfg.themePreset === 'custom') {
    document.body.dataset.theme = cfg.customThemeMode === 'dark' ? 'dark' : 'light';
  } else {
    document.body.dataset.theme = cfg.theme;
  }
  document.documentElement.style.setProperty('--ec-font-size', cfg.fontSize + 'px');
  const titleEl = $('ec-title');
  if (titleEl) titleEl.textContent = cfg.titleText || core.system.cfg.TITLE_DEFAULTS[cfg.themePreset] || 'easyclaude';
  const logoEl = $('ec-logo');
  if (logoEl) {
    if (cfg.logoPreset === 'none') logoEl.innerHTML = '';
    else if (cfg.logoPreset === 'custom') logoEl.innerHTML = cfg.customLogoSvg || '';
    else logoEl.innerHTML = await core.system.cfg.loadLogo(cfg.logoPreset || 'default');
  }
  const $fs = $('cfg-fontsize'), $fsV = $('cfg-fontsize-val'), $th = $('cfg-theme');
  if ($fs)  { $fs.value = cfg.fontSize; }
  if ($fsV) { $fsV.textContent = cfg.fontSize; }
  if ($th)  { $th.value = cfg.theme; }
  core.system.cfg.syncForm();
};

core.system.cfg.syncForm = () => {
  const $ = core.system.dom.$;
  const set = (id, val) => { const el = $(id); if (el) el.value = val ?? ''; };
  set('cfg-theme-preset', cfg.themePreset);
  set('cfg-logo-preset',  cfg.logoPreset);
  set('cfg-title-text',   cfg.titleText);
  set('cfg-custom-svg',   cfg.customLogoSvg);
  set('cfg-custom-mode',  cfg.customThemeMode);
  const unEl = $('cfg-username'); if (unEl) unEl.value = cfg.userName || '';
  const localeEl = $('cfg-locale'); if (localeEl) localeEl.value = cfg.locale || 'ko';
  const bypassEl = $('cfg-bypass-enabled'); if (bypassEl) bypassEl.checked = !!cfg.bypassEnabled;
  const rdMd = $('cfg-render-md'); if (rdMd && typeof getRenderMd === 'function') rdMd.checked = getRenderMd();
  const rdMj = $('cfg-render-mathjax'); if (rdMj && typeof getRenderMathJax === 'function') rdMj.checked = getRenderMathJax();
  for (const k of ['bg','surface','text','accent','border']) {
    set('cfg-color-' + k, (cfg.customTheme && cfg.customTheme[k]) || '');
  }
  const customSection = $('ec-settings-custom');
  if (customSection) customSection.classList.toggle('ec-hidden', cfg.themePreset !== 'custom');
  const logoCustomSection = $('ec-settings-logo-custom');
  if (logoCustomSection) logoCustomSection.classList.toggle('ec-hidden', cfg.logoPreset !== 'custom');
};

// alias
window.saveCfg = core.system.cfg.save;
window.loadLogoSvg = core.system.cfg.loadLogo;
window.applyCfg = core.system.cfg.apply;
window.syncSettingsForm = core.system.cfg.syncForm;

// ─── WebSocket ────────────────────────────────────────────
core.system.ws = core.system.ws || {};

core.system.ws.connect = () => {
  if (state.system.ws && state.system.ws.readyState !== WebSocket.CLOSED) {
    try {
      state.system.ws.onclose = null; state.system.ws.onerror = null;
      state.system.ws.onmessage = null; state.system.ws.onopen = null;
      state.system.ws.close();
    } catch {}
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const base  = location.pathname.replace(/[^/]*$/, '') || '/';
  chat.info.status.set('connecting…', 'warn');
  const sock = new WebSocket(`${proto}://${location.host}${base}`);
  state.system.ws = sock;
  window.ws = sock; // app.js 호환
  sock.addEventListener('open', () => {
    chat.info.status.set('connected', 'ok');
    if (state.system.reconnect.attempts > 0) core.system.toast.show('서버 재연결됨', 'ok', 2000);
    state.system.reconnect.attempts = 0;
    for (const ch of state.session.channels.values()) ch.alive = false;
    core.system.ws.send({ op: 'list' });
    if (state.system.outboundQueue.length) {
      const drained = state.system.outboundQueue.slice();
      state.system.outboundQueue = [];
      for (const obj of drained) {
        try { sock.send(JSON.stringify(obj)); }
        catch { state.system.outboundQueue.push(obj); break; }
      }
    }
    state.session.pendingReopen = state.session.lastActive;
    window.pendingReopenSid = state.session.pendingReopen;
  });
  sock.addEventListener('message', e => core.system.ws.handle(JSON.parse(e.data)));
  sock.addEventListener('close', () => {
    if (state.system.reconnect.attempts === 0) core.system.toast.show('서버 연결 끊김 — 재연결 중…', 'warn', 5000);
    chat.info.status.set(state.system.outboundQueue.length ? `disconnected (queued ${state.system.outboundQueue.length})` : 'disconnected', 'err');
    if (state.system.reconnect.timer) clearTimeout(state.system.reconnect.timer);
    state.system.reconnect.attempts++;
    const delay = Math.min(500 * Math.pow(1.7, state.system.reconnect.attempts - 1), 8000);
    state.system.reconnect.timer = setTimeout(core.system.ws.connect, delay);
  });
  sock.addEventListener('error', () => {});
  if (!window.__ec_visibility_hooked__) {
    window.__ec_visibility_hooked__ = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (!state.system.ws || state.system.ws.readyState !== WebSocket.OPEN) {
          if (state.system.reconnect.timer) { clearTimeout(state.system.reconnect.timer); state.system.reconnect.timer = null; }
          state.system.reconnect.attempts = 0;
          core.system.ws.connect();
        }
        const sid = state.session.active;
        const ch = sid ? state.session.channels.get(sid) : null;
        if (ch && (!ch.turns || !ch.turns.length) && (!ch.histTurns || !ch.histTurns.length)) {
          ch.histStart = -1;
          if (typeof loadMoreHistory === 'function') {
            loadMoreHistory(ch).then(() => {
              const parsed = chat.message.dom.parsed;
              if (ch.sessionId === state.session.active && parsed) parsed.scrollTop = parsed.scrollHeight;
            });
          }
        }
      }
    });
    window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
  }
};

core.system.ws.send = (obj) => {
  const sock = state.system.ws;
  if (sock && sock.readyState === WebSocket.OPEN) {
    try { sock.send(JSON.stringify(obj)); return true; }
    catch (e) { state.system.outboundQueue.push(obj); }
  } else {
    state.system.outboundQueue.push(obj);
    chat.info.status.set(`reconnecting (queued ${state.system.outboundQueue.length})`, 'warn');
  }
  return false;
};

core.system.ws.handle = function(msg) {
  const { op, id } = msg;
  if (op === 'sessions') {
    ecSessions = msg.list;
    for (const sid of [...channels.keys()]) {
      if (!ecSessions.some(s => s.id === sid)) channels.delete(sid);
    }
    const store = loadHiddenStore();
    let storeDirty = false;
    for (const s of ecSessions) {
      if (store[s.id]) { delete store[s.id]; storeDirty = true; }
    }
    if (storeDirty) saveHiddenStore(store);
    if (!$settings.classList.contains('ec-hidden')) renderHiddenSessions();
    if (!activeSid) renderUsage();
    renderTabs();
    if (!activeSid) renderHome();
    if (pendingReopenSid && ecSessions.some(s => s.id === pendingReopenSid)) {
      const sidToReopen = pendingReopenSid;
      pendingReopenSid = null;
      if (!channels.has(sidToReopen)) {
        openSession(sidToReopen);
      } else {
        const ch = channels.get(sidToReopen);
        const newId = nextClientId++;
        ch.id = newId;
        core.system.ws.send({ op: 'open', id: newId, sessionId: sidToReopen });
      }
      setTimeout(() => { if (channels.has(sidToReopen)) activate(sidToReopen); }, 100);
    }
    return;
  }
  if (op === 'session_created') {
    const sid = msg.sessionId;
    setTimeout(() => {
      if (!channels.has(sid)) openSession(sid);
      activate(sid);
    }, 100);
    return;
  }
  if (op === 'session_deleted') {
    channels.delete(msg.sessionId);
    if (activeSid === msg.sessionId) { activeSid = null; renderUsage(); }
    refreshTabState();
    return;
  }
  if (op === 'session_purged') {
    channels.delete(msg.sessionId);
    if (activeSid === msg.sessionId) { activeSid = null; renderUsage(); }
    if (!msg.hidden) forgetHiddenSession(msg.sessionId);
    if (!$settings.classList.contains('ec-hidden')) renderHiddenSessions();
    refreshTabState();
    return;
  }
  if (op === 'session_unhidden') {
    forgetHiddenSession(msg.sessionId);
    if (!$settings.classList.contains('ec-hidden')) renderHiddenSessions();
    return;
  }
  if (op === 'tab_prefs') {
    const incoming = msg.prefs || {};
    for (const k of Object.keys(tabPrefs)) { if (!incoming[k]) delete tabPrefs[k]; }
    Object.assign(tabPrefs, incoming);
    renderTabs();
    return;
  }
  if (op === 'ui_state') {
    if (msg.lastActiveSessionId && !lastActiveSid) lastActiveSid = msg.lastActiveSessionId;
    return;
  }
  if (op === 'ui_cfg') {
    const serverCfg = msg.cfg || {};
    let changed = false;
    for (const k of Object.keys(serverCfg)) {
      if (serverCfg[k] !== undefined && cfg[k] !== serverCfg[k]) {
        cfg[k] = serverCfg[k]; changed = true;
      }
    }
    if (changed) { localStorage.setItem(core.system.cfg.KEY, JSON.stringify(cfg)); core.system.cfg.apply(); }
    return;
  }
  const ch = id != null ? [...channels.values()].find(c => c.id === id) : null;
  if (op === 'opened') {
    if (ch) { ch.alive = true; ch.claudeId = msg.info?.claudeId; ch.stalled = null; }
    refreshTabState();
    if (ch && ch.sessionId === activeSid) renderActive();
    return;
  }
  if (op === 'events') {
    if (!ch) return;
    const newEvts = msg.events || [];
    if (newEvts.length > 0 || !ch.events?.length) ch.events = newEvts;
    ch.usage = msg.usage || ch.usage;
    if (ch.stalled && ch.events.length) ch.stalled = null;
    confirmPendingInputs(ch);
    if (ch.sessionId === activeSid) { renderActive(); renderUsage(); }
    return;
  }
  if (op === 'events_patch') {
    if (!ch) return;
    const from = msg.from | 0;
    const patch = msg.events || [];
    if ((ch.events || []).length < from) {
      core.system.ws.send({ op: 'open', id: ch.id, sid: ch.sessionId });
      return;
    }
    ch.events = ch.events || [];
    ch.events.splice(from, ch.events.length - from, ...patch);
    ch.usage = msg.usage || ch.usage;
    if (ch.stalled && ch.events.length) ch.stalled = null;
    confirmPendingInputs(ch);
    if (ch.sessionId === activeSid) { renderActive(); renderUsage(); }
    return;
  }
  if (op === 'turns' || op === 'turns_patch') {
    if (!ch) return;
    if (ch.sessionId === activeSid) renderActive();
    return;
  }
  if (op === 'system') {
    if (ch) {
      const prevTitle = ch.session?.customTitle || null;
      ch.session = msg.session;
      const newTitle = ch.session?.customTitle || null;
      if (prevTitle !== newTitle) syncSessionLabel(ch);
    }
    if (ch && ch.sessionId === activeSid) renderUsage();
    return;
  }
  if (op === 'usage') {
    if (ch) {
      ch.usage = msg.usage;
      if (msg.lastCtxInput !== undefined && ch.session) ch.session.lastCtxInput = msg.lastCtxInput;
    }
    if (ch && ch.sessionId === activeSid) renderUsage();
    return;
  }
  if (op === 'thinking_delta') {
    if (!ch || ch.sessionId !== activeSid) return;
    if (ch) ch.thinkingActive = true;
    if (!document.getElementById('ec-thinking-live') && ch && ch.sessionId === activeSid) {
      renderActive();
    }
    let details = document.getElementById('ec-thinking-live');
    if (!details) {
      details = document.createElement('details');
      details.id = 'ec-thinking-live';
      details.open = false;
      details.style.cssText = 'margin:4px 0;';
      const summary = document.createElement('summary');
      summary.id = 'ec-thinking-summary';
      summary.style.cssText = 'font-size:11px;color:var(--muted);cursor:pointer;user-select:none;padding:2px 0;';
      summary.textContent = '생각 중 …';
      const pre = document.createElement('pre');
      pre.id = 'ec-thinking-pre';
      pre.className = 'ec-code-thinking ec-fold-clickable';
      pre.style.cssText = 'margin:4px 0 0;';
      details.appendChild(summary);
      details.appendChild(pre);
      details.addEventListener('click', e => {
        if (e.target === details || e.target.closest('.ec-fold-clickable')) details.open = false;
      });
      $parsed.appendChild(details);
    }
    const pre = document.getElementById('ec-thinking-pre');
    if (pre) {
      const atPreBottom = pre.scrollTop + pre.clientHeight + 4 >= pre.scrollHeight;
      pre.textContent += msg.text || '';
      if (atPreBottom) pre.scrollTop = pre.scrollHeight;
    }
    return;
  }
  if (op === 'user_turn') {
    if (ch) { ch.hadResult = false; ch.thinkingBuf = ''; ch.thinkingCompleteContent = null; }
    return;
  }
  if (op === 'result') {
    if (ch) {
      ch.lastResult = msg.result;
      ch.statusText = '';
      ch.hadResult = true;
      ch.thinkingActive = false;
      ch.thinkingBuf = '';
    }
    const liveEl = document.getElementById('ec-thinking-live');
    if (liveEl) {
      liveEl.open = false;
      const s = liveEl.querySelector('summary');
      if (s) s.textContent = '생각 완료';
      liveEl.id = 'ec-thinking-done';
    }
    if (ch && ch.sessionId === activeSid) { renderActive(); renderUsage(); }
    return;
  }
  if (op === 'dialog') {
    if (!ch) return;
    ch.pendingDialog = { tool_use_id: msg.tool_use_id, kind: msg.kind, input: msg.input };
    if (ch.sessionId === activeSid) showDialog(ch);
    return;
  }
  if (op === 'hook') return;
  if (op === 'closed') {
    if (ch) {
      ch.statusText = '';
      ch.alive = false;
      const err = ((msg.stderr || '') + ' ' + (msg.error || '')).toLowerCase();
      if (/not logged in|authentication|credentials|please log in|invalid api key|auth/.test(err)) {
        ch.stalled = { kind: 'auth', message: ((msg.stderr || msg.error || '')).slice(-300) };
      } else if (/rate limit|usage limit|quota|too many requests/.test(err)) {
        ch.stalled = { kind: 'rate_limit', message: ((msg.stderr || msg.error || '')).slice(-300) };
      } else if (msg.exitCode != null && msg.exitCode !== 0) {
        ch.stalled = { kind: 'exit', message: 'exit ' + msg.exitCode + ': ' + ((msg.stderr || msg.error || '')).slice(-300) };
      }
      if (ch.sessionId === activeSid) renderActive();
    }
    refreshTabState();
    return;
  }
  if (op === 'rate_limit') {
    if (ch) {
      const info = msg.info || {};
      const isHardLimit = info.type === 'pause' || info.type === 'rate_limit' ||
        (typeof (info.message || info.text || '') === 'string' &&
         /rate limit|usage limit|quota exceeded|too many requests/i.test(info.message || info.text || ''));
      if (isHardLimit) {
        ch.stalled = {
          kind: 'rate_limit',
          resetAt: info.resets_at_unix || info.resets_at || null,
          message: info.message || info.text || 'Claude rate limit',
        };
        if (ch.sessionId === activeSid) renderActive();
      }
    }
    return;
  }
  if (op === 'stalled') {
    if (ch && !ch.stalled?.dismissed) {
      ch.stalled = { kind: msg.kind, message: msg.message || '' };
      if (ch.sessionId === activeSid) renderActive();
    }
    return;
  }
  if (op === 'restarted') {
    if (ch) {
      ch.alive = !!msg.alive;
      ch.claudeId = msg.claudeId;
      ch.pendingDialog = null;
      ch.stalled = null;
    }
    refreshTabState();
    renderActive();
    chat.info.perm.render();
    if (ch && ch.sessionId === activeSid) core.system.toast.show('세션 재기동 완료', 'ok');
    return;
  }
  if (op === 'status') {
    if (!ch) return;
    const STATUS_LABELS = { requesting: '생각 중...', processing: '처리 중...', compacting: '압축 중...' };
    ch.statusText = STATUS_LABELS[msg.status] || (msg.status || '');
    if (ch.sessionId === activeSid) {
      const el = document.querySelector('.ec-thinking-status');
      if (el) el.textContent = ch.statusText;
      else if (ch.statusText) renderActive();
    }
    return;
  }
  if (op === 'error') {
    const code = msg.code || '';
    if (code === 'cwd_not_found' || (msg.message || '').includes('cwd')) {
      core.system.toast.show(msg.message || '오류', 'err', 4000);
    } else {
      console.error('[easyclaude]', msg.message);
    }
    return;
  }
};
window.onMsg = core.system.ws.handle;

// alias
window.connect = core.system.ws.connect;
window.sendWs = core.system.ws.send;

// ─── Preset (args/customPresets) ──────────────────────────
core.system.preset = core.system.preset || {};
core.system.preset.tokenize = (str) => {
  if (!str) return [];
  const tokens = [];
  let cur = '', inQuote = null;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inQuote) {
      if (c === inQuote) inQuote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      inQuote = c;
    } else if (/\s/.test(c)) {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += c;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
};
core.system.preset.load = () => {
  try { return JSON.parse(localStorage.getItem('easyclaude.customPresets') || '{}'); }
  catch { return {}; }
};
core.system.preset.save = (obj) => {
  try { localStorage.setItem('easyclaude.customPresets', JSON.stringify(obj || {})); } catch {}
};
core.system.preset.apply = (args, targetId) => {
  const $ = core.system.dom.$;
  const ta = $(targetId);
  if (!ta) return;
  ta.value = (args || []).join(' ');
  ta.dispatchEvent(new Event('input'));
};
// renderCustomPresets는 newsession 모달 종속이라 modal.core.create로
window.tokenizeArgs = core.system.preset.tokenize;
window.loadCustomPresets = core.system.preset.load;
window.saveCustomPresets = core.system.preset.save;
window.applyPresetToTarget = core.system.preset.apply;
