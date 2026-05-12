'use strict';
// easyclaude 클라이언트 — stream-json turn 수신 + 텍스트 송신 + dialog modal.

const $ = id => document.getElementById(id);
const $tabs = $('ec-tabs');
const $parsed = $('ec-parsed-view');
const $input = $('ec-input');
const $send = $('ec-send-btn');
const $interrupt = $('ec-interrupt-btn');
const $restart = $('ec-restart-btn');
const $usage = $('ec-usage');
const $viewbarUsage = $('ec-viewbar-usage');
const $ham = $('ec-ham');
const $nav = $('ec-nav');
const $settingsBtn = $('ec-settings-btn');
const $settings = $('ec-settings');
const $settingsClose = $('ec-settings-close');
const $status = $('ec-status');
const $activeLabel = $('ec-active-label');
const $ac = $('ec-autocomplete');
const $dialog = $('ec-dialog');
const $dialogTitle = $('ec-dialog-title');
const $dialogBody = $('ec-dialog-body');
const $dialogCancel = $('ec-dialog-cancel');
const $dialogSubmit = $('ec-dialog-submit');
const $dialogClose = $('ec-dialog-close');
const $newSessionBtn = $('ec-new-session-btn');
const $newSession = $('ec-newsession');
const $newSessionClose = $('ec-newsession-close');
const $newSessionCancel = $('ec-newsession-cancel');
const $newSessionCreate = $('ec-newsession-create');
const $nsLabel = $('ns-label');
const $nsCwd = $('ns-cwd');
const $nsName = $('ns-name');
const $nsArgs = $('ns-args');

const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

// ── 설정 ──────────────────────────────────────────────────────────────────────
const CFG_KEY = 'easyclaude.cfg';
const cfg = Object.assign({
  fontSize: 14,
  theme: 'auto',              // mode: auto | light | dark
  themePreset: 'default',     // default | philtoday | custom
  logoPreset: 'default',      // default | philtoday | custom | none
  titleText: '',              // override (빈 문자열이면 프리셋 기반)
  customTheme: {},            // 커스텀 색상 토큰
  customLogoSvg: '',          // 커스텀 로고 SVG 원문
  customThemeMode: 'light',   // custom 테마 다크 여부 (light가 디폴트)
  bypassEnabled: false,       // bypassPermissions 옵션 허용 여부 (위험 모드)
}, (() => { try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch { return {}; } })());

function saveCfg() { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); applyCfg(); }

const TITLE_DEFAULTS = {
  default:   'easyclaude',
  philtoday: 'PhilConsole',
  custom:    'easyclaude',
};

// SVG 로고 — fetch로 가져옴 (logos/*.svg)
const LOGO_CACHE = new Map();
async function loadLogoSvg(name) {
  if (LOGO_CACHE.has(name)) return LOGO_CACHE.get(name);
  try {
    const r = await fetch(apiBase() + 'logos/' + name + '.svg');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const svg = await r.text();
    LOGO_CACHE.set(name, svg);
    return svg;
  } catch (e) {
    console.warn('logo load fail', name, e.message);
    return '';
  }
}

async function applyCfg() {
  // 1) 테마 프리셋
  if (cfg.themePreset === 'default') {
    document.body.removeAttribute('data-theme-preset');
  } else {
    document.body.setAttribute('data-theme-preset', cfg.themePreset);
  }

  // 2) 커스텀 색상 토큰 (custom일 때만 inline style로 주입, 그 외에는 정리)
  const tokenKeys = ['bg','surface','surface-2','surface-3','border','border-strong',
    'text','text-2','muted','accent','accent-2','accent-3','green','warn','danger','info'];
  for (const k of tokenKeys) document.body.style.removeProperty('--' + k);
  if (cfg.themePreset === 'custom' && cfg.customTheme) {
    for (const [k, v] of Object.entries(cfg.customTheme)) {
      if (v) document.body.style.setProperty('--' + k, v);
    }
  }

  // 3) 다크/라이트 모드
  if (cfg.themePreset === 'custom') {
    document.body.dataset.theme = cfg.customThemeMode === 'dark' ? 'dark' : 'light';
  } else {
    document.body.dataset.theme = cfg.theme;
  }

  // 4) 폰트 크기
  document.documentElement.style.setProperty('--ec-font-size', cfg.fontSize + 'px');

  // 5) 타이틀 텍스트
  const titleEl = $('ec-title');
  if (titleEl) titleEl.textContent = cfg.titleText || TITLE_DEFAULTS[cfg.themePreset] || 'easyclaude';

  // 6) 로고
  const logoEl = $('ec-logo');
  if (logoEl) {
    if (cfg.logoPreset === 'none') logoEl.innerHTML = '';
    else if (cfg.logoPreset === 'custom') logoEl.innerHTML = cfg.customLogoSvg || '';
    else logoEl.innerHTML = await loadLogoSvg(cfg.logoPreset || 'default');
  }

  // 7) 설정 모달 input 동기화
  const $fs = $('cfg-fontsize'), $fsV = $('cfg-fontsize-val'), $th = $('cfg-theme');
  if ($fs)  { $fs.value = cfg.fontSize; }
  if ($fsV) { $fsV.textContent = cfg.fontSize; }
  if ($th)  { $th.value = cfg.theme; }
  syncSettingsForm();
}

function syncSettingsForm() {
  const set = (id, val) => { const el = $(id); if (el) el.value = val ?? ''; };
  set('cfg-theme-preset', cfg.themePreset);
  set('cfg-logo-preset',  cfg.logoPreset);
  set('cfg-title-text',   cfg.titleText);
  set('cfg-custom-svg',   cfg.customLogoSvg);
  set('cfg-custom-mode',  cfg.customThemeMode);
  const bypassEl = $('cfg-bypass-enabled');
  if (bypassEl) bypassEl.checked = !!cfg.bypassEnabled;
  const rdMd = $('cfg-render-md');
  if (rdMd) rdMd.checked = getRenderMd();
  const rdMj = $('cfg-render-mathjax');
  if (rdMj) rdMj.checked = getRenderMathJax();
  for (const k of ['bg','surface','text','accent','border']) {
    set('cfg-color-' + k, (cfg.customTheme && cfg.customTheme[k]) || '');
  }
  const customSection = $('ec-settings-custom');
  if (customSection) customSection.classList.toggle('ec-hidden', cfg.themePreset !== 'custom');
  const logoCustomSection = $('ec-settings-logo-custom');
  if (logoCustomSection) logoCustomSection.classList.toggle('ec-hidden', cfg.logoPreset !== 'custom');
}

function renderPermPill() {
  const pill = $('ec-perm-pill');
  if (!pill) return;
  const ch = activeChannel();
  if (!ch) { pill.style.display = 'none'; return; }
  const sess = ecSessions.find(s => s.id === ch.sessionId);
  const ctrl = parseControlsFromArgs(sess?.args);
  let mode = ctrl.permissionMode;
  if (ctrl.permissionPromptTool) mode = 'prompt-tool';
  pill.style.display = '';
  const icons = {
    default: '🔒', acceptEdits: '✏️', auto: '🤖',
    bypassPermissions: '🔓', dontAsk: '🤫', plan: '📋', 'prompt-tool': '🤝',
  };
  pill.textContent = `${icons[mode] || '🔒'} ${mode}`;
  pill.dataset.mode = mode;
  pill.title = cfg.bypassEnabled
    ? '클릭: bypassPermissions ↔ default 토글 (재기동)'
    : '권한 모드 (위험 모드 비활성)';
  pill.disabled = !cfg.bypassEnabled;
  pill.classList.toggle('ec-perm-bypass', mode === 'bypassPermissions');
}

$('ec-perm-pill')?.addEventListener('click', () => {
  if (!cfg.bypassEnabled) return;
  const ch = activeChannel();
  if (!ch) return;
  const sess = ecSessions.find(s => s.id === ch.sessionId);
  const ctrl = parseControlsFromArgs(sess?.args);
  const cur = ctrl.permissionPromptTool ? 'prompt-tool' : ctrl.permissionMode;
  const target = cur === 'bypassPermissions' ? 'default' : 'bypassPermissions';
  if (!confirm(`권한 모드 ${cur} → ${target} 로 변경 (재기동)?`)) return;
  const newArgs = patchArgs(sess?.args || [], { permissionMode: target });
  sendWs({ op: 'restart', id: ch.id, args: newArgs });
});

// ── 상태 ──────────────────────────────────────────────────────────────────────
let ws = null;
let ecSessions = [];
const channels = new Map();           // sessionId → { id, sessionId, label, turns, usage, session, alive, pendingDialog }
let activeSid = null;
let nextClientId = 1;

// ── WebSocket ─────────────────────────────────────────────────────────────────
let outboundQueue = [];          // ws 닫혀 있을 때 모았다가 reconnect 후 flush
let lastActiveSid = null;        // reconnect 후 자동 re-open할 세션
let reconnectAttempts = 0;
let reconnectTimer = null;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const base  = location.pathname.replace(/[^/]*$/, '') || '/';
  ws = new WebSocket(`${proto}://${location.host}${base}`);
  ws.addEventListener('open', () => {
    setStatus('connected', 'ok');
    reconnectAttempts = 0;
    channels.clear();
    activeSid = null;
    sendWs({ op: 'list' });
    // outbound queue flush
    if (outboundQueue.length) {
      const drained = outboundQueue.slice();
      outboundQueue = [];
      for (const obj of drained) {
        try { ws.send(JSON.stringify(obj)); }
        catch (e) { outboundQueue.push(obj); break; }
      }
    }
    // 이전에 활성화돼 있던 세션 자동 re-open (sessions 리스트 도착 후 처리)
    pendingReopenSid = lastActiveSid;
  });
  ws.addEventListener('message', e => onMsg(JSON.parse(e.data)));
  ws.addEventListener('close', () => {
    setStatus(outboundQueue.length ? `disconnected (queued ${outboundQueue.length})` : 'disconnected', 'err');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectAttempts++;
    // 지수 backoff: 0.5s → 1s → 2s → ... 최대 15s
    const delay = Math.min(500 * Math.pow(1.7, reconnectAttempts - 1), 15000);
    reconnectTimer = setTimeout(connect, delay);
  });
  ws.addEventListener('error', () => {});
  // 탭이 보이게 되면 즉시 재연결 시도 (브라우저가 백그라운드에서 ws를 끊은 경우 빠른 복구)
  if (!window.__ec_visibility_hooked__) {
    window.__ec_visibility_hooked__ = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
          connect();
        }
        // 활성 ch가 비어 보이면 history 강제 reload
        const ch = activeSid ? channels.get(activeSid) : null;
        if (ch && (!ch.turns || !ch.turns.length) && (!ch.histTurns || !ch.histTurns.length)) {
          ch.histStart = -1;
          loadMoreHistory(ch).then(() => {
            if (ch.sessionId === activeSid) $parsed.scrollTop = $parsed.scrollHeight;
          });
        }
      }
    });
    // 모바일 BFCache 복귀: ws/channels 상태 보존 안 됨 → 페이지 reload로 안전 복구
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) location.reload();
    });
  }
}
let pendingReopenSid = null;

function sendWs(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); return true; }
    catch (e) { outboundQueue.push(obj); }
  } else {
    // 연결 안 됨 — queue. reconnect 후 flush.
    outboundQueue.push(obj);
    setStatus(`reconnecting (queued ${outboundQueue.length})`, 'warn');
  }
  return false;
}

function setStatus(text, kind) {
  $status.textContent = text;
  $status.className = 'ec-parse-status' + (kind ? ' ec-status-' + kind : '');
}

function onMsg(msg) {
  const { op, id } = msg;
  if (op === 'sessions') {
    ecSessions = msg.list;
    // 사라진 세션의 channel은 정리
    for (const sid of [...channels.keys()]) {
      if (!ecSessions.some(s => s.id === sid)) channels.delete(sid);
    }
    // 다시 나타난(unhide / 재출현) cfg 세션은 hidden store에서 제거
    const store = loadHiddenStore();
    let storeDirty = false;
    for (const s of ecSessions) {
      if (store[s.id]) { delete store[s.id]; storeDirty = true; }
    }
    if (storeDirty) saveHiddenStore(store);
    // 설정 패널이 열려있으면 hidden 섹션도 재렌더
    if (!$settings.classList.contains('ec-hidden')) renderHiddenSessions();
    renderTabs();
    // reconnect 후 이전 활성 세션 자동 복귀
    if (pendingReopenSid && ecSessions.some(s => s.id === pendingReopenSid)) {
      const sidToReopen = pendingReopenSid;
      pendingReopenSid = null;
      if (!channels.has(sidToReopen)) openSession(sidToReopen);
      // openSession이 즉시 활성화 처리하지만, 만약 안 되면 명시적 activate
      setTimeout(() => { if (channels.has(sidToReopen)) activate(sidToReopen); }, 100);
    }
    return;
  }
  if (op === 'session_created') {
    // 사용자가 + 버튼으로 만든 세션. 만든 직후 자동 활성화.
    const sid = msg.sessionId;
    setTimeout(() => {
      if (!channels.has(sid)) openSession(sid);
      activate(sid);
    }, 100);
    return;
  }
  if (op === 'session_deleted') {
    channels.delete(msg.sessionId);
    if (activeSid === msg.sessionId) activeSid = null;
    refreshTabState();
    return;
  }
  if (op === 'session_purged') {
    // 서버는 broadcastSessions 도 같이 보내지만 ack 도 따로 처리
    channels.delete(msg.sessionId);
    if (activeSid === msg.sessionId) activeSid = null;
    if (!msg.hidden) {
      // adhoc 세션은 복원 불가 — store 에서도 제거
      forgetHiddenSession(msg.sessionId);
    }
    if (!$settings.classList.contains('ec-hidden')) renderHiddenSessions();
    refreshTabState();
    return;
  }
  if (op === 'session_unhidden') {
    forgetHiddenSession(msg.sessionId);
    if (!$settings.classList.contains('ec-hidden')) renderHiddenSessions();
    return;
  }
  const ch = id != null ? [...channels.values()].find(c => c.id === id) : null;
  if (op === 'opened') {
    if (ch) { ch.alive = true; ch.claudeId = msg.info?.claudeId; }
    refreshTabState();
    return;
  }
  if (op === 'turns') {
    if (!ch) return;
    ch.turns = msg.turns || [];
    ch.usage = msg.usage || ch.usage;
    if (ch.stalled && ch.turns.length) ch.stalled = null;  // 응답 재개 시 stalled 해제
    // pendingInputs 중 서버 turns에 매칭되는 항목 제거 (echo 도착)
    if (ch.pendingInputs?.length) {
      ch.pendingInputs = ch.pendingInputs.filter(p =>
        !ch.turns.some(t => t.type === 'human' && t.body === p.text)
      );
    }
    if (ch.sessionId === activeSid) { renderActive(); renderUsage(); }
    return;
  }
  if (op === 'system') {
    if (ch) {
      const prevTitle = ch.session?.customTitle || null;
      ch.session = msg.session;
      // claude 측 세션 이름이 바뀌었으면 탭/활성 라벨 sync
      const newTitle = ch.session?.customTitle || null;
      if (prevTitle !== newTitle) syncSessionLabel(ch);
    }
    if (ch && ch.sessionId === activeSid) renderUsage();
    return;
  }
  if (op === 'usage') {
    if (ch) ch.usage = msg.usage;
    if (ch && ch.sessionId === activeSid) renderUsage();
    return;
  }
  if (op === 'result') {
    if (ch) ch.lastResult = msg.result;
    return;
  }
  if (op === 'dialog') {
    if (!ch) return;
    ch.pendingDialog = { tool_use_id: msg.tool_use_id, kind: msg.kind, input: msg.input };
    if (ch.sessionId === activeSid) showDialog(ch);
    return;
  }
  if (op === 'hook') {
    // 디버그용 — 일단 무시 (필요시 dev console)
    return;
  }
  if (op === 'closed') {
    if (ch) {
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
      ch.stalled = {
        kind: 'rate_limit',
        resetAt: info.resets_at_unix || info.resets_at || null,
        message: info.message || info.text || 'Claude rate limit',
      };
      if (ch.sessionId === activeSid) renderActive();
    }
    return;
  }
  if (op === 'restarted') {
    if (ch) {
      ch.alive = !!msg.alive;
      ch.claudeId = msg.claudeId;
      // turns 는 reset 하지 않음 — 서버가 영속 (--resume) + 새 system 이벤트로 갱신될 것
      ch.pendingDialog = null;
      ch.stalled = null;
    }
    refreshTabState();
    renderActive();
    renderPermPill();
    return;
  }
  if (op === 'error') {
    console.error('[easyclaude]', msg.message);
    return;
  }
}

// ── 탭 ──────────────────────────────────────────────────────────────────────────
// ── 탭 선호도 (pin / group / order) — localStorage 영속 ───────────────────────
const TABPREFS_KEY = 'easyclaude.tabPrefs';
const tabPrefs = (() => {
  try { return JSON.parse(localStorage.getItem(TABPREFS_KEY) || '{}'); }
  catch { return {}; }
})();
function saveTabPrefs() {
  localStorage.setItem(TABPREFS_KEY, JSON.stringify(tabPrefs));
}
function getTabPref(sid) {
  return tabPrefs[sid] || {};
}
function setTabPref(sid, patch) {
  tabPrefs[sid] = { ...(tabPrefs[sid] || {}), ...patch };
  // null 값은 제거
  for (const [k, v] of Object.entries(tabPrefs[sid])) {
    if (v === null || v === undefined || v === '') delete tabPrefs[sid][k];
  }
  if (!Object.keys(tabPrefs[sid]).length) delete tabPrefs[sid];
  saveTabPrefs();
  renderTabs();
}

// 그룹 접기 상태 (메모리만)
const collapsedGroups = new Set();

function tabSortKey(s, prefs) {
  // pin 우선, pin 안에서는 pinOrder, 같으면 label
  const p = prefs[s.id] || {};
  return {
    pinned: p.pinned ? 0 : 1,
    pinOrder: p.pinOrder ?? 99999,
    group: p.group || '',
    label: s.label || s.id,
  };
}

function renderTabs() {
  $tabs.innerHTML = '';
  // 1) 정렬: pin / group / label
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
  // 2) 섹션: pinned 블록 + group별 블록 + 나머지
  const pinned = sorted.filter(s => tabPrefs[s.id]?.pinned);
  const rest = sorted.filter(s => !tabPrefs[s.id]?.pinned);
  if (pinned.length) {
    appendTabSection('📌 고정', pinned, '__pinned__');
  }
  // group별로 묶기
  const groups = new Map();
  for (const s of rest) {
    const g = tabPrefs[s.id]?.group || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  // 그룹 있는 것 먼저, 빈 그룹은 마지막
  const groupNames = [...groups.keys()].filter(g => g);
  for (const g of groupNames) {
    appendTabSection(g, groups.get(g), g);
  }
  const ungrouped = groups.get('') || [];
  if (ungrouped.length) {
    appendTabSection(pinned.length || groupNames.length ? '기타' : null, ungrouped, '__ungrouped__');
  }
  refreshTabState();
}

function appendTabSection(headerLabel, items, groupKey) {
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
      renderTabs();
    });
    $tabs.appendChild(header);
    if (isCollapsed) return;
  }
  for (const s of items) {
    $tabs.appendChild(createTabElement(s));
  }
}

// claude 내부 세션 이름(custom-title)이 있으면 그것 우선, 아니면 ec sess.label
function effectiveLabel(s) {
  const ch = channels.get(s.id);
  return (ch && ch.session && ch.session.customTitle) || s.label || s.id;
}

// claude custom-title 변경 시 탭 라벨 + 활성 라벨 즉시 sync (전체 재렌더 없이)
function syncSessionLabel(ch) {
  const s = ecSessions.find(x => x.id === ch.sessionId);
  if (!s) return;
  const label = (ch.session && ch.session.customTitle) || s.label || s.id;
  ch.label = label;
  const tab = document.querySelector(`.ec-tab[data-sid="${CSS.escape(ch.sessionId)}"] .ec-tab-label`);
  if (tab) tab.textContent = label;
  if (ch.sessionId === activeSid && $activeLabel) $activeLabel.textContent = label;
}

function createTabElement(s) {
  const btn = document.createElement('button');
  btn.className = 'ec-tab';
  btn.dataset.sid = s.id;
  const pref = tabPrefs[s.id] || {};
  const pinIcon = pref.pinned ? '📌' : '';
  btn.innerHTML = `<span class="ec-dot"></span>` +
    (pinIcon ? `<span class="ec-tab-pin">${pinIcon}</span>` : '') +
    `<span class="ec-tab-label">${esc(effectiveLabel(s))}</span>` +
    `<span class="ec-tab-menu" title="옵션">⋮</span>` +
    `<span class="ec-tab-x" title="${s.meta?.adhoc ? '제거 (jsonl 보존)' : '보관 (숨기기)'}">✕</span>`;
  btn.addEventListener('click', e => {
    if (e.target.classList.contains('ec-tab-x')) {
      e.stopPropagation();
      return handleTabClose(s);
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
}

function showTabMenu(s, anchor) {
  // 기존 메뉴 닫기
  document.querySelectorAll('.ec-tab-popup').forEach(el => el.remove());
  const rect = anchor.getBoundingClientRect();
  const pref = tabPrefs[s.id] || {};
  const isAdhoc = !!s.meta?.adhoc;
  const menu = document.createElement('div');
  menu.className = 'ec-tab-popup';
  // 화면 밖 overflow 방지 — 우선 anchor 아래에 띄우고 viewport 안에 fit
  const vw = window.innerWidth, vh = window.innerHeight;
  const menuW = 220, menuH = 260;
  let left = Math.min(rect.left, vw - menuW - 8);
  let top  = rect.bottom + 4;
  if (top + menuH > vh - 8) top = Math.max(8, rect.top - menuH - 4);
  if (left < 8) left = 8;
  menu.style.left = left + 'px';
  menu.style.top  = top + 'px';
  menu.style.maxWidth = (vw - 16) + 'px';
  menu.innerHTML = `
    <button data-act="rename">✎ 이름 변경…</button>
    <button data-act="pin">${pref.pinned ? '📌 고정 해제' : '📌 고정'}</button>
    ${pref.pinned ? `<button data-act="pin-up">▲ 위로</button>
                     <button data-act="pin-down">▼ 아래로</button>` : ''}
    <button data-act="group">📂 그룹 설정…</button>
    <button data-act="restart">↻ 재기동</button>
    <hr style="border:0;border-top:1px solid var(--border);margin:4px 0">
    ${isAdhoc ? `<button data-act="delete">🗑 삭제</button>` : ''}
    <button data-act="purge" style="color:var(--danger,#c0392b)">⚠ 영구 삭제 (purge)</button>
    <button data-act="hidden-panel">👁 숨김 해제는 별도 화면에서</button>
  `;
  document.body.appendChild(menu);
  const close = () => menu.remove();
  setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
  menu.addEventListener('click', e => {
    const act = e.target.dataset.act;
    if (!act) return;
    if (act === 'pin') {
      const newPinned = !pref.pinned;
      const patch = { pinned: newPinned };
      if (newPinned) {
        // 새 pin은 맨 뒤 순서로
        const maxOrder = Math.max(0, ...Object.values(tabPrefs).map(p => p.pinOrder || 0));
        patch.pinOrder = maxOrder + 1;
      } else {
        patch.pinOrder = null;
      }
      setTabPref(s.id, patch);
    } else if (act === 'pin-up' || act === 'pin-down') {
      // pinned 탭들의 순서 교환
      const pinned = ecSessions
        .filter(x => tabPrefs[x.id]?.pinned)
        .sort((a, b) => (tabPrefs[a.id].pinOrder || 0) - (tabPrefs[b.id].pinOrder || 0));
      const idx = pinned.findIndex(x => x.id === s.id);
      const target = act === 'pin-up' ? idx - 1 : idx + 1;
      if (target < 0 || target >= pinned.length) { close(); return; }
      const otherSid = pinned[target].id;
      const a = tabPrefs[s.id].pinOrder;
      tabPrefs[s.id].pinOrder = tabPrefs[otherSid].pinOrder;
      tabPrefs[otherSid].pinOrder = a;
      saveTabPrefs();
      renderTabs();
    } else if (act === 'group') {
      const cur = pref.group || '';
      const ans = prompt('그룹 이름 (비우면 그룹 해제):', cur);
      if (ans === null) { close(); return; }
      setTabPref(s.id, { group: ans.trim() || null });
    } else if (act === 'rename') {
      const cur = effectiveLabel(s);
      const ans = prompt('세션 이름 (비우면 기본값으로 복원):', cur);
      if (ans === null) { close(); return; }
      sendWs({ op: 'rename_session', id: nextClientId++, sessionId: s.id, label: ans.trim() });
    } else if (act === 'restart') {
      if (!confirm(`'${effectiveLabel(s)}' 세션을 재기동할까요? (claudeId 보존)`)) { close(); return; }
      const ch = channels.get(s.id);
      if (ch) sendWs({ op:'restart', id: ch.id });
    } else if (act === 'delete') {
      handleTabDelete(s);
    } else if (act === 'purge') {
      handleTabPurge(s);
    } else if (act === 'hidden-panel') {
      // 설정 패널 열고 숨김 섹션으로 스크롤
      $settings.classList.remove('ec-hidden');
      renderHomesList();
      renderHiddenSessions();
      setTimeout(() => {
        const sec = $('ec-hidden-sessions-section');
        if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
    }
    close();
  });
}

// adhoc 세션만 가능. config 파일 변경 없음.
function handleTabDelete(s) {
  if (!s.meta?.adhoc) {
    alert('config 세션은 "삭제"가 불가합니다.\n영구 삭제(purge)로 숨김 처리하세요.');
    return;
  }
  if (!confirm(`'${s.label}' 세션을 목록에서 제거할까요?\n(jsonl 파일은 보존됩니다)`)) return;
  sendWs({ op: 'delete_session', id: nextClientId++, sessionId: s.id });
}

// 강한 확인 — irreversible. cfg 세션의 경우 hidden 처리 (복원 가능),
// adhoc 세션의 경우 jsonl 까지 제거.
function handleTabPurge(s) {
  const isAdhoc = !!s.meta?.adhoc;
  // cfg 세션이면 향후 복원을 위해 라벨/claudeId를 로컬에 기억
  if (!isAdhoc) {
    rememberHiddenSession(s);
  }
  const warn = isAdhoc
    ? `'${s.label}' 세션을 영구 삭제합니다.\n` +
      `• 세션 목록에서 제거\n` +
      `• ~/.claude/projects/.../*.jsonl 파일까지 제거\n` +
      `이 작업은 되돌릴 수 없습니다.\n\n계속하려면 OK.`
    : `'${s.label}' (config 세션)을 숨김 처리합니다.\n` +
      `• 목록에서 숨김 (config 파일은 보존)\n` +
      `• ~/.claude/projects/.../*.jsonl 파일까지 제거\n` +
      `숨김 해제는 "설정 → 숨김된 세션" 에서 가능합니다.\n\n계속하려면 OK.`;
  if (!confirm(warn)) return;
  // 2단계 확인 — 더블 클릭 실수 방지
  const second = prompt(`확인: 정말 영구 삭제할까요?\n세션 ID '${s.id}' 를 입력해 확정하세요.`);
  if (second !== s.id) {
    alert('취소되었습니다 (id 미일치).');
    return;
  }
  sendWs({ op: 'purge_session', id: nextClientId++, sessionId: s.id });
}

// ── 숨김된 세션 기억 (localStorage) ─────────────────────────────────────────
// 서버 사이드 sessions() 가 hidden을 필터링하므로, 복원 가능한 cfg 세션 id를
// 클라이언트에서 기억해 두어야 한다.
const HIDDEN_KEY = 'easyclaude.hiddenSessions';
function loadHiddenStore() {
  try { return JSON.parse(localStorage.getItem(HIDDEN_KEY) || '{}'); }
  catch { return {}; }
}
function saveHiddenStore(store) {
  localStorage.setItem(HIDDEN_KEY, JSON.stringify(store));
}
function rememberHiddenSession(s) {
  const store = loadHiddenStore();
  store[s.id] = {
    id: s.id,
    label: s.label || s.id,
    cwd: s.cwd || '',
    hiddenAt: new Date().toISOString(),
  };
  saveHiddenStore(store);
}
function forgetHiddenSession(sid) {
  const store = loadHiddenStore();
  delete store[sid];
  saveHiddenStore(store);
}

// 탭 ✕: 보관(숨기기). cfg 세션 → hidden 플래그 set + 로컬 기억(복원 가능),
// adhoc 세션 → 목록에서만 제거(jsonl 보존). purge(영구 삭제)는 ⋮ 메뉴에서만.
function handleTabClose(s) {
  const isAdhoc = !!s.meta?.adhoc;
  const label = isAdhoc ? '제거' : '숨김';
  if (!confirm(`'${s.label}' 탭을 ${label}할까요?\n(jsonl 보존 · 영구 삭제는 ⋮ 메뉴에서)`)) return;
  if (!isAdhoc) {
    rememberHiddenSession(s);
    // server 측 cfg 세션의 purge_session = hidden 플래그 set (jsonl 보존)
    sendWs({ op: 'purge_session', id: nextClientId++, sessionId: s.id });
  } else {
    // adhoc — delete_session: 목록에서 제거, jsonl 보존
    sendWs({ op: 'delete_session', id: nextClientId++, sessionId: s.id });
  }
}

function refreshTabState() {
  document.querySelectorAll('.ec-tab').forEach(t => {
    const sid = t.dataset.sid;
    const ch = channels.get(sid);
    t.classList.toggle('active', sid === activeSid);
    t.classList.toggle('connected', !!(ch && ch.alive));
    t.classList.toggle('disconnected', !!(ch && !ch.alive));
  });
}

function activate(sessionId) {
  if (!channels.has(sessionId)) return;
  activeSid = sessionId;
  lastActiveSid = sessionId;     // reconnect 후 자동 복귀용
  const ch = channels.get(sessionId);
  const sess = ecSessions.find(x => x.id === sessionId);
  const label = (ch?.session?.customTitle) || ch?.label || sess?.label || sessionId;
  if ($activeLabel) $activeLabel.textContent = label;
  refreshTabState();
  renderActive();
  renderUsage();
  renderPermPill();
  if (ch?.pendingDialog) showDialog(ch);
  else hideDialog();
  requestAnimationFrame(() => $input.focus());
  // history 자동 로드 (이 세션에서 아직 한 번도 안 받았으면)
  if (ch && ch.histStart === -1) {
    loadMoreHistory(ch).then(() => {
      if (ch.sessionId === activeSid) $parsed.scrollTop = $parsed.scrollHeight;
    });
  }
}

function openSession(sessionId) {
  if (channels.has(sessionId)) return;
  const id = nextClientId++;
  const meta = ecSessions.find(s => s.id === sessionId);
  const ch = {
    id, sessionId,
    label: meta?.label || sessionId,
    alive: false,
    turns: [],
    histTurns: [],     // jsonl에서 파스된 옛 turn (위 스크롤 시 prepend)
    histStart: -1,     // 다음 페이지 fetch 시작점 (-1 = 아직 미로드, 0 = 최상단 도달)
    histTotal: 0,
    histLoading: false,
    pendingInputs: [],  // optimistic 사용자 메시지 (서버 echo 도착 전 표시)
    usage: null,
    session: null,
    pendingDialog: null,
  };
  channels.set(sessionId, ch);
  sendWs({ op: 'open', id, sessionId });
  // 세션을 열면 jsonl 옛 turn을 자동 로드 — 대화창 안에서 그대로 이어 보이게.
  // 첫 페이지 로드 후 스크롤은 bottom으로 (가장 최근 대화부터 보이게).
  loadMoreHistory(ch).then(() => {
    if (ch.sessionId === activeSid) $parsed.scrollTop = $parsed.scrollHeight;
  });
}

// ── 대화창 in-place history (jsonl 파스 turn을 위 스크롤로 prepend) ──────────
async function loadMoreHistory(ch) {
  if (!ch || ch.histLoading) return;
  if (ch.histStart === 0) return;  // 최상단 도달
  ch.histLoading = true;
  try {
    const params = new URLSearchParams({ limit: '100' });
    if (ch.histStart > 0) params.set('before', String(ch.histStart));
    const url = apiBase() + `api/sessions/${encodeURIComponent(ch.sessionId)}/history-turns?` + params.toString();
    console.log('[ec] history fetch', ch.sessionId, 'histStart=', ch.histStart, 'url=', url);
    const r = await fetch(url);
    const data = await r.json();
    console.log('[ec] history resp', ch.sessionId, 'ok=', data?.ok, 'total=', data?.total, 'start=', data?.start, 'end=', data?.end, 'turns=', (data?.turns||[]).length, 'hint=', data?.hint);
    if (!data || !data.ok) return;
    ch.histTotal = data.total;
    ch.histStart = data.start;
    if (Array.isArray(data.turns) && data.turns.length) {
      const wasActive = ch.sessionId === activeSid;
      const prevH = wasActive ? $parsed.scrollHeight : 0;
      const prevT = wasActive ? $parsed.scrollTop : 0;
      ch.histTurns = data.turns.concat(ch.histTurns);
      if (wasActive) {
        renderActive();
        // 스크롤 위치 보정 — prepend된 만큼 아래로
        $parsed.scrollTop = ($parsed.scrollHeight - prevH) + prevT;
      }
    }
  } catch (e) { console.warn('[ec] history load fail', e); }
  finally { ch.histLoading = false; }
}

// ── 마크다운 / MathJax 렌더링 헬퍼 ─────────────────────────────────────────
function getRenderMd() {
  try { return localStorage.getItem('ec.renderMarkdown') === '1'; } catch { return false; }
}
function getRenderMathJax() {
  try { return localStorage.getItem('ec.renderMathJax') === '1'; } catch { return false; }
}
function setRenderMd(v)       { try { localStorage.setItem('ec.renderMarkdown', v ? '1' : '0'); } catch {} }
function setRenderMathJax(v)  { try { localStorage.setItem('ec.renderMathJax', v ? '1' : '0'); } catch {} }

function ecRenderBody(text, forceMarkdown) {
  if (!text) return '';
  const useMd = forceMarkdown || getRenderMd();
  if (!useMd || typeof marked === 'undefined') {
    // plain: escape + newline to <br>
    const s = String(text);
    return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])).replace(/\n/g,'<br>');
  }
  const holders = [];
  const protect = s => { const k = '\x02MATH' + holders.length + '\x03'; holders.push(s); return k; };
  let t = text
    .replace(/\$\$[\s\S]+?\$\$/g, m => protect(m))
    .replace(/\\\[[\s\S]+?\\\]/g, m => protect(m))
    .replace(/\$[^$\n]+?\$/g, m => protect(m))
    .replace(/\\\([\s\S]+?\\\)/g, m => protect(m));
  let html;
  try { html = marked.parse(t); } catch { html = esc(t).replace(/\n/g,'<br>'); }
  if (typeof DOMPurify !== 'undefined') html = DOMPurify.sanitize(html);
  html = html.replace(/\x02MATH(\d+)\x03/g, (_, i) => esc(holders[+i]));
  return html;
}
function ecTypeset(el) {
  if (getRenderMathJax() && window.MathJax && MathJax.typesetPromise) {
    MathJax.typesetPromise(el ? [el] : undefined).catch(() => {});
  }
}

// ── 렌더 ──────────────────────────────────────────────────────────────────────
const LABELS = {
  human:'You', assistant:'Claude',
  tool_call:'Tool', tool_out:'Result',
  thinking:'Thinking', channel:'IOA',
  result:'Turn 종료', hook:'Hook', meta:'Meta', other:'기타',
};
const COLORS = {
  human:'var(--accent)', assistant:'var(--green)',
  tool_call:'#cba6f7', tool_out:'#f9e2af',
  thinking:'#74c7ec', channel:'#94e2d5',
  result:'var(--muted)', hook:'var(--muted)', meta:'var(--muted)', other:'var(--muted)',
};
// 기본 숨김 turn type — 디버그 모드에서만 표시
const HIDDEN_TYPES_DEFAULT = new Set(['meta', 'hook', 'other']);
function showDebugEvents() {
  try { return localStorage.getItem('ec.showDebug') === '1'; } catch { return false; }
}
function setShowDebugEvents(v) {
  try { localStorage.setItem('ec.showDebug', v ? '1' : '0'); } catch {}
}
function shouldHideTurn(t) {
  if (showDebugEvents()) return false;
  return HIDDEN_TYPES_DEFAULT.has(t.type);
}

// ── (제거됨) jsonl 모달 — 대화창 in-place history로 대체 ────────────────────
/* DEPRECATED 모달 코드 — 의도적으로 제거. 옛 대화는 대화창에서 위로 스크롤하면 자동 로드.
async function fetchJsonlInfo(sid) {
  try {
    const r = await fetch(apiBase() + 'api/sessions/' + encodeURIComponent(sid) + '/jsonl?offset=0&limit=1&parse=0');
    return await r.json();
  } catch { return null; }
}
async function loadOlderJsonl(sid, fromOffset, count) {
  // fromOffset에서 count만큼 위 (offset 작은 쪽) 가져옴
  const start = Math.max(0, fromOffset - count);
  const lim = fromOffset - start;
  if (lim <= 0) return null;
  try {
    const r = await fetch(apiBase() + `api/sessions/${encodeURIComponent(sid)}/jsonl?offset=${start}&limit=${lim}`);
    return await r.json();
  } catch { return null; }
}
async function showJsonlHistory(sid) {
  // 전체 jsonl history를 모달로 보여줌. 위로 스크롤 시 추가 로드.
  let el = document.getElementById('ec-jsonl-modal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ec-jsonl-modal';
    el.className = 'ec-dialog ec-hidden';
    el.innerHTML = `
      <div class="ec-dialog-panel ec-jsonl-panel">
        <div class="ec-dialog-head">
          <h3>jsonl 히스토리 — <span id="jh-info"></span></h3>
          <button id="jh-close" class="ec-icon-btn">✕</button>
        </div>
        <div id="jh-loader" class="ec-jsonl-loader"></div>
        <div id="jh-body" class="ec-jsonl-body"></div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('#jh-close').addEventListener('click', () => el.classList.add('ec-hidden'));
    el.addEventListener('click', e => { if (e.target === el) el.classList.add('ec-hidden'); });
  }
  el.dataset.sid = sid;
  el.dataset.loaded = '0';
  el.dataset.total = '0';
  document.getElementById('jh-body').innerHTML = '';
  document.getElementById('jh-info').textContent = '로드 중…';
  document.getElementById('jh-loader').textContent = '';
  el.classList.remove('ec-hidden');
  // 첫 페이지: 마지막 500 라인 (가장 최근)
  const info = await fetchJsonlInfo(sid);
  const total = info?.total || 0;
  el.dataset.total = String(total);
  document.getElementById('jh-info').textContent = `총 ${total} 라인 — 최근부터 표시 (위 스크롤로 더 불러오기)`;
  const initialLimit = Math.min(500, total);
  const initialOffset = Math.max(0, total - initialLimit);
  const first = await loadOlderJsonl(sid, total, initialLimit);
  if (first && first.entries) {
    el.dataset.loaded = String(first.entries.length);
    el.dataset.offset = String(initialOffset);
    renderJsonlEntries(first.entries, false);
  }
  // 위 스크롤 시 추가 로드
  const body = document.getElementById('jh-body');
  body.onscroll = async () => {
    if (body.scrollTop < 80) {
      const loaded = parseInt(el.dataset.loaded, 10);
      const currentOffset = parseInt(el.dataset.offset, 10);
      if (currentOffset <= 0) {
        document.getElementById('jh-loader').textContent = '— 최상단 도달 —';
        return;
      }
      document.getElementById('jh-loader').textContent = '로드 중…';
      const older = await loadOlderJsonl(sid, currentOffset, 500);
      if (older && older.entries && older.entries.length) {
        el.dataset.loaded = String(loaded + older.entries.length);
        el.dataset.offset = String(Math.max(0, currentOffset - older.entries.length));
        const oldHeight = body.scrollHeight;
        renderJsonlEntries(older.entries, true); // prepend
        // 스크롤 위치 유지
        body.scrollTop = body.scrollHeight - oldHeight;
      }
      document.getElementById('jh-loader').textContent = '';
    }
  };
}
function jhTruncate(s, n) {
  if (!s) return '';
  s = String(s);
  if (s.length <= n) return s;
  return s.slice(0, n) + ` …(+${s.length - n} chars)`;
}
function jhContentText(c) {
  if (!c) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(jhContentText).join('\n');
  if (c.type === 'text') return c.text || '';
  if (c.type === 'thinking') return c.thinking || c.text || '';
  if (c.text) return c.text;
  return '';
}
function jhTurn(label, klass, body) {
  return `<div class="ec-turn"><div class="ec-turn-label">${esc(label)}</div><div class="ec-turn-body ${klass}"><pre style="white-space:pre-wrap;margin:0;font-family:inherit">${esc(body)}</pre></div></div>`;
}
function jhRenderEntry(e) {
  if (!e || typeof e !== 'object') return '';
  if (e._parseError) return jhTurn('⚠ 파싱 실패', 'other', e.raw || '');
  const t = e.type;
  const cs = e.message && e.message.content;
  if (t === 'user' && Array.isArray(cs)) {
    const parts = [];
    for (const c of cs) {
      if (c.type === 'tool_result') {
        const txt = (Array.isArray(c.content) ? c.content.map(jhContentText).join('\n')
                    : (typeof c.content === 'string' ? c.content : JSON.stringify(c.content)));
        parts.push(jhTurn(`📦 tool_result${c.is_error ? ' (error)' : ''}`, 'tool_out', jhTruncate(txt, 2000)));
      } else if (c.type === 'text') {
        parts.push(jhTurn('🙋 사용자', 'human', jhTruncate(c.text || '', 6000)));
      } else {
        parts.push(jhTurn(`user · ${c.type}`, 'other', jhTruncate(JSON.stringify(c), 600)));
      }
    }
    return parts.join('');
  }
  if (t === 'assistant' && Array.isArray(cs)) {
    return cs.map(c => {
      if (c.type === 'text')     return jhTurn('🤖 어시스턴트', 'assistant', jhTruncate(c.text || '', 6000));
      if (c.type === 'tool_use') return jhTurn(`🔧 ${c.name || 'tool'}`, 'tool_call', jhTruncate(JSON.stringify(c.input || {}, null, 2), 1500));
      if (c.type === 'thinking') return jhTurn('💭 thinking', 'thinking', jhTruncate(c.thinking || c.text || '', 3000));
      return jhTurn(`assistant · ${c.type}`, 'other', jhTruncate(JSON.stringify(c), 600));
    }).join('');
  }
  if (t === 'system') {
    const usage = (e.session && e.session.usage)
      ? ` · in=${e.session.usage.input_tokens||0} out=${e.session.usage.output_tokens||0}` : '';
    return jhTurn(`⚙ system · ${e.subtype || ''}${usage}`, 'status', jhTruncate(JSON.stringify(e), 500));
  }
  if (t === 'result') {
    const u = e.usage || {};
    return jhTurn(`✅ result · ${e.subtype || ''} · in=${u.input_tokens||0} out=${u.output_tokens||0}`, 'status', '');
  }
  if (t === 'hook' || t === 'channel' || t === 'attachment') {
    return jhTurn(`${t}`, 'other', jhTruncate(JSON.stringify(e), 600));
  }
  return jhTurn(t || '(unknown)', 'other', jhTruncate(JSON.stringify(e), 600));
}
function renderJsonlEntries(entries, prepend) {
  const body = document.getElementById('jh-body');
  const html = entries.map(jhRenderEntry).join('');
  if (prepend) body.insertAdjacentHTML('afterbegin', html);
  else body.innerHTML = html;
}
*/

function renderHome() {
  const totalSessions = ecSessions.length;
  const liveCount = [...channels.values()].filter(c => c.alive).length;
  $parsed.innerHTML = `
    <div class="ec-home">
      <div class="ec-home-hero">
        <div class="ec-home-logo" id="ec-home-logo" aria-hidden="true"></div>
        <h1 class="ec-home-title">easyclaude</h1>
        <p class="ec-home-sub">claude code 멀티 세션 워크벤치</p>
      </div>
      <div class="ec-home-actions">
        <button type="button" class="ec-btn ec-btn-primary ec-home-action" id="ec-home-new">＋ 새 세션</button>
        <button type="button" class="ec-btn ec-home-action" id="ec-home-open-nav">☰ 세션 목록</button>
        <button type="button" class="ec-btn ec-home-action" id="ec-home-settings">⚙ 설정</button>
      </div>
      <div class="ec-home-grid">
        <div class="ec-home-card">
          <div class="ec-home-card-label">세션</div>
          <div class="ec-home-card-value">${totalSessions}</div>
          <div class="ec-home-card-sub">활성 ${liveCount}</div>
        </div>
        <div class="ec-home-card" id="ec-home-auth">
          <div class="ec-home-card-label">인증</div>
          <div class="ec-home-card-value" id="ec-home-auth-state">⏳</div>
          <div class="ec-home-card-sub" id="ec-home-auth-sub">조회 중…</div>
        </div>
        <div class="ec-home-card">
          <div class="ec-home-card-label">overlay HOME</div>
          <div class="ec-home-card-value" style="font-size:13px" id="ec-home-overlay">조회 중…</div>
          <div class="ec-home-card-sub">ec 격리 환경</div>
        </div>
      </div>
      <div class="ec-home-recent">
        <h4>최근 세션</h4>
        <div id="ec-home-recent-list" class="ec-home-list"></div>
      </div>
    </div>`;
  // 로고 inject
  const logoSlot = $('ec-home-logo');
  if (logoSlot && $('ec-logo')) logoSlot.innerHTML = $('ec-logo').innerHTML;
  // 액션
  $('ec-home-new')?.addEventListener('click', () => $('ec-new-session-btn')?.click());
  $('ec-home-open-nav')?.addEventListener('click', () => $nav?.classList.add('open'));
  $('ec-home-settings')?.addEventListener('click', () => $('ec-settings-btn')?.click());
  // 인증/overlay 상태
  fetch(apiBase() + 'api/ec-home').then(r => r.json()).then(h => {
    $('ec-home-overlay').textContent = h.overlayEnabled ? 'overlay ON' : 'real HOME';
    $('ec-home-overlay').title = h.home || '';
    return fetch(apiBase() + 'api/auth/status?home=' + encodeURIComponent(h.home));
  }).then(r => r.json()).then(s => {
    if (s.loggedIn) {
      $('ec-home-auth-state').innerHTML = '<span style="color:var(--green)">●</span> 로그인';
      $('ec-home-auth-sub').textContent = s.subscriptionType || s.authMethod || '';
    } else {
      $('ec-home-auth-state').innerHTML = '<span style="color:var(--warn)">○</span> 미로그인';
      $('ec-home-auth-sub').textContent = '설정에서 로그인 진행';
    }
  }).catch(() => {});
  // 최근 세션 카드
  const recents = ecSessions.slice(0, 6);
  const $rl = $('ec-home-recent-list');
  if ($rl) {
    if (!recents.length) {
      $rl.innerHTML = '<div class="ec-empty">등록된 세션이 없습니다. <b>＋ 새 세션</b>으로 시작하세요.</div>';
    } else {
      $rl.innerHTML = recents.map(s => {
        const ch = channels.get(s.id);
        const alive = ch && ch.alive;
        return `<button type="button" class="ec-home-session" data-sid="${esc(s.id)}">
          <span class="ec-home-session-dot" style="background:${alive ? 'var(--green)' : 'var(--muted)'}"></span>
          <span class="ec-home-session-label">${esc(s.label || s.id)}</span>
          <span class="ec-home-session-cwd">${esc(s.cwd || '')}</span>
        </button>`;
      }).join('');
      $rl.querySelectorAll('.ec-home-session').forEach(btn => {
        btn.addEventListener('click', () => {
          const sid = btn.dataset.sid;
          if (!channels.has(sid)) openSession(sid);
          activate(sid);
        });
      });
    }
  }
}

function renderActive() {
  if (!activeSid) {
    renderHome();
    return;
  }
  const ch = channels.get(activeSid);
  if (!ch) {
    // 활성 세션 sid는 있으나 채널이 사라짐 (탭 닫힘/숨김 후) → 홈으로 복귀
    activeSid = null;
    if ($activeLabel) $activeLabel.textContent = '';
    renderActive();
    return;
  }
  const allTurns = [...(ch.histTurns || []), ...(ch.turns || [])];
  // Auth/리밋 stalled 감지 — turn body에 키워드 검출 (claude code가 assistant/result로 emit하는 텍스트)
  if (!ch.stalled) {
    for (let i = allTurns.length - 1; i >= Math.max(0, allTurns.length - 30); i--) {
      const t = allTurns[i];
      const b = typeof t?.body === 'string' ? t.body : '';
      if (!b) continue;
      if (/not logged in|please run \/login|please log in|run \/login|invalid api key|api key not found/i.test(b)) {
        ch.stalled = { kind: 'auth', message: b.slice(0, 400) };
        break;
      }
      if (/rate limit|usage limit reached|quota exceeded|too many requests/i.test(b)) {
        ch.stalled = { kind: 'rate_limit', message: b.slice(0, 400) };
        break;
      }
    }
  }
  const visible = allTurns.filter(t => !shouldHideTurn(t));
  const hiddenCount = allTurns.length - visible.length;
  const pending = ch.pendingInputs || [];
  if (!visible.length && !pending.length && !hiddenCount) {
    $parsed.innerHTML = '<div class="ec-empty">출력 대기 중…</div>';
    return;
  }
  const wasAtBottom = $parsed.scrollTop + $parsed.clientHeight + 80 >= $parsed.scrollHeight;
  const hiddenBanner = hiddenCount > 0
    ? `<div class="ec-hidden-banner" id="ec-hidden-banner">메타/훅 이벤트 ${hiddenCount}개 숨김 — <a href="#" id="ec-show-debug">디버그 표시</a></div>`
    : '';
  // 발화 turn(human/assistant/channel)은 그대로 노출, 그 외 (tool_call/tool_out/thinking/result 등)는
  // 연속 구간을 하나의 <details> 그룹으로 묶음. 사용자가 한 스위치로 펼침/접힘.
  const SPOKEN_TURN_TYPES = new Set(['human', 'assistant', 'channel']);
  const renderOneTurn = (t) => {
    const cls = `ec-turn ec-turn-${t.type}` + (t.is_error ? ' ec-error' : '');
    const labelText = (t.type === 'meta' && t.eventType) ? `${LABELS.meta} · ${t.eventType}` : (LABELS[t.type] || t.type);
    // assistant/human/channel은 마크다운 렌더링 대상; 나머지는 코드/원문 그대로
    const RENDERABLE = new Set(['human','assistant','channel','thinking']);
    const bodyHtml = RENDERABLE.has(t.type) ? ecRenderBody(t.body || '') : `<pre style="margin:0;white-space:pre-wrap;word-break:break-word">${esc(t.body||'')}</pre>`;
    return `<div class="${cls}"><div class="ec-turn-label" style="color:${COLORS[t.type]||'var(--muted)'}">${esc(labelText)}</div><div class="ec-turn-body ${t.type}">${bodyHtml}</div></div>`;
  };
  let turnsHtml = '';
  let foldBuf = [];
  const flushFold = () => {
    if (!foldBuf.length) return '';
    const n = foldBuf.length;
    const counts = {};
    for (const t of foldBuf) counts[t.type] = (counts[t.type] || 0) + 1;
    const summary = Object.entries(counts).map(([k,v]) => `${LABELS[k]||k}${v>1?' ×'+v:''}`).join(' · ');
    const inner = foldBuf.map(renderOneTurn).join('');
    foldBuf = [];
    return `<details class="ec-turn-fold"><summary>▸ ${esc(summary)} <span class="ec-muted">(${n})</span></summary>${inner}</details>`;
  };
  for (const t of visible) {
    if (SPOKEN_TURN_TYPES.has(t.type)) {
      turnsHtml += flushFold();
      turnsHtml += renderOneTurn(t);
    } else {
      foldBuf.push(t);
    }
  }
  turnsHtml += flushFold();
  const pendingHtml = pending.map(p => `
    <div class="ec-turn ec-turn-human ec-turn-pending">
      <div class="ec-turn-label" style="color:${COLORS.human}">You · 전송 중…</div>
      <div class="ec-turn-body human">${esc(p.text)}</div>
    </div>`).join('');
  // 인증/리밋 등 fallback banner
  const stalled = ch.stalled || null;
  const stalledHtml = stalled ? renderStalledBanner(stalled) : '';
  $parsed.innerHTML = hiddenBanner + turnsHtml + pendingHtml + stalledHtml;
  $('ec-show-debug')?.addEventListener('click', e => {
    e.preventDefault();
    setShowDebugEvents(true);
    renderActive();
  });
  wireStalledBanner(ch);
  if (wasAtBottom) $parsed.scrollTop = $parsed.scrollHeight;
  ecTypeset($parsed);
}

function renderStalledBanner(s) {
  // s: { kind: 'auth' | 'rate_limit' | 'exit', message, resetAt? }
  const ecHomeHint = ' (ec 환경 단일 HOME)';
  if (s.kind === 'auth') {
    return `<div class="ec-stalled ec-stalled-auth">
      <div class="ec-stalled-title">⚠ 인증 필요${ecHomeHint}</div>
      <div class="ec-stalled-body">${esc(s.message || 'Claude 세션이 인증 실패로 멈췄습니다.')}</div>
      <div class="ec-stalled-actions">
        <button class="ec-btn ec-btn-primary" id="stalled-login">로그인 / OAuth</button>
        <button class="ec-btn" id="stalled-setup-token">장기 토큰 발급</button>
        <button class="ec-btn" id="stalled-restart">세션 재기동</button>
      </div>
    </div>`;
  }
  if (s.kind === 'rate_limit') {
    const resetTxt = s.resetAt ? new Date(s.resetAt * 1000).toLocaleString() : null;
    return `<div class="ec-stalled ec-stalled-rate">
      <div class="ec-stalled-title">⏳ 사용량 한도 도달</div>
      <div class="ec-stalled-body">${esc(s.message || 'Claude rate limit. 다음 윈도까지 대기 또는 다른 모델로 재기동.')}${resetTxt ? ' · 해제 예정: ' + esc(resetTxt) : ''}</div>
      <div class="ec-stalled-actions">
        <button class="ec-btn" id="stalled-wait">자동 재시도 대기</button>
        <button class="ec-btn" id="stalled-switch-model">다른 모델로 재기동</button>
        <button class="ec-btn" id="stalled-restart">세션 재기동</button>
      </div>
    </div>`;
  }
  return `<div class="ec-stalled">
    <div class="ec-stalled-title">⚠ 세션 멈춤</div>
    <div class="ec-stalled-body">${esc(s.message || '세션이 종료됐거나 응답하지 않습니다.')}</div>
    <div class="ec-stalled-actions">
      <button class="ec-btn ec-btn-primary" id="stalled-restart">재기동</button>
    </div>
  </div>`;
}
async function wireStalledBanner(ch) {
  $('stalled-login')?.addEventListener('click', async () => {
    try {
      const r = await fetch(apiBase() + 'api/ec-home');
      const h = await r.json();
      if (h && h.home) openLogin(h.home);
    } catch {}
  });
  $('stalled-setup-token')?.addEventListener('click', async () => {
    try {
      const r = await fetch(apiBase() + 'api/ec-home');
      const h = await r.json();
      if (h && h.home) { openLogin(h.home); setTimeout(() => $('lg-setup-token')?.click(), 100); }
    } catch {}
  });
  $('stalled-restart')?.addEventListener('click', () => {
    sendWs({ op: 'restart_session', id: nextClientId++, sessionId: ch.sessionId });
    ch.stalled = null;
    renderActive();
  });
  $('stalled-wait')?.addEventListener('click', () => {
    ch.stalled = { ...ch.stalled, message: '자동 재시도 대기 중 — 윈도 해제 시 자동 재기동' };
    // 윈도 시각이 있으면 그 시점에 자동 재기동
    if (ch.stalled.resetAt) {
      const ms = ch.stalled.resetAt * 1000 - Date.now() + 5000;
      if (ms > 0) setTimeout(() => {
        sendWs({ op: 'restart_session', id: nextClientId++, sessionId: ch.sessionId });
        ch.stalled = null;
        renderActive();
      }, Math.min(ms, 6 * 3600 * 1000));
    }
    renderActive();
  });
  $('stalled-switch-model')?.addEventListener('click', () => {
    // info 모달에 모델 변경 UI 있음 — 그쪽으로 안내
    $('ec-info-btn')?.click();
  });
}

function fmtNum(n) { return (n || 0).toLocaleString(); }
function fmtTok(n) {
  n = n || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}
function renderUsage() {
  const ch = activeChannel();
  const setBoth = (text, title) => {
    if ($usage) { $usage.textContent = text; if (title) $usage.title = title; }
    if ($viewbarUsage) { $viewbarUsage.textContent = text; if (title) $viewbarUsage.title = title; }
  };
  if (!ch) { setBoth('', ''); return; }
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
  if (!u) { setBoth(model + mcp, ''); return; }
  const total = (u.input || 0) + (u.output || 0) + (u.cache_read || 0);
  const text = `${model} · ${fmtTok(total)} tok${mcp}`;
  const title = `model: ${model}\nin: ${fmtNum(u.input)} / out: ${fmtNum(u.output)}\ncache_read: ${fmtNum(u.cache_read)} / cache_create: ${fmtNum(u.cache_creation)}\ntotal: ${fmtNum(total)}\n${(s.mcpServers||[]).map(m=>`${m.name}: ${m.status}`).join('\n')}`;
  setBoth(text, title);
}

// ── 입력 ──────────────────────────────────────────────────────────────────────
function activeChannel() { return activeSid ? channels.get(activeSid) : null; }
function sendInput() {
  const val = $input.value;
  if (!val || !val.trim()) return;
  const ch = activeChannel();
  if (!ch) return;
  // ec-handled 슬래시 인터셉트 (claude로 보내지 않음)
  const slashM = val.trim().match(/^(\/\w+)\b/);
  if (slashM) {
    const def = SLASH_CMDS.find(c => c.cmd === slashM[1]);
    if (def && def.kind === 'ec') {
      runEcSlash(def.cmd, ch);
      $input.value = '';
      autosize();
      hideAc();
      return;
    }
  }
  sendWs({ op:'input', id: ch.id, data: val });
  // optimistic 풍선 — echo 도착 전 즉시 표시
  ch.pendingInputs = ch.pendingInputs || [];
  ch.pendingInputs.push({ text: val, sentAt: Date.now() });
  $input.value = '';
  autosize();
  hideAc();
  if (ch.sessionId === activeSid) renderActive();
  requestAnimationFrame(() => $input.focus());
}
function autosize() {
  $input.style.height = 'auto';
  // 2줄(56px) 이하면 그대로 두고, 그 이상 입력 시 scrollHeight 만큼 (최대 200px)
  const target = Math.max(56, Math.min($input.scrollHeight, 200));
  $input.style.height = target + 'px';
}

$send.addEventListener('click', sendInput);
$interrupt?.addEventListener('click', () => {
  const ch = activeChannel();
  if (!ch) return;
  sendWs({ op: 'interrupt', id: ch.id });
});
// 대화창 위 스크롤 → history 더 로드 (in-place 무한 스크롤)
$parsed?.addEventListener('scroll', () => {
  if ($parsed.scrollTop < 80) {
    const ch = activeChannel();
    if (ch) loadMoreHistory(ch);
  }
});
// Escape 키: 입력칸이 비어있을 때만 인터럽트로 (포커스 있는 곳 텍스트 입력 중이면 무시)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (!$input.value || document.activeElement !== $input)) {
    const ch = activeChannel();
    if (ch) sendWs({ op: 'interrupt', id: ch.id });
  }
});
$input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (acIdx >= 0) fillAc(acIdx);
    else sendInput();
    return;
  }
  if (e.key === 'ArrowDown') { e.preventDefault(); moveAc(1); return; }
  if (e.key === 'ArrowUp')   { e.preventDefault(); moveAc(-1); return; }
  if (e.key === 'Escape')    { hideAc(); return; }
});
$input.addEventListener('input', () => { autosize(); updateAc(); });

$restart.addEventListener('click', () => {
  const ch = activeChannel();
  if (!ch) return;
  if (!confirm(`${ch.label} 세션을 재기동할까요? (claudeId 보존 → --resume)`)) return;
  sendWs({ op:'restart', id: ch.id });
});

// ── Dialog (AskUserQuestion) ──────────────────────────────────────────────────
let currentDialog = null; // { ch, tool_use_id, kind, input, answers }

function showDialog(ch) {
  if (!ch.pendingDialog) return;
  const d = ch.pendingDialog;
  currentDialog = { ch, ...d, answers: {} };
  if (d.kind === 'PermissionPrompt') return renderPermissionDialog(d);
  return renderAskUserQuestionDialog(d);
}

function renderPermissionDialog(d) {
  $dialogTitle.textContent = '권한 확인';
  const toolName = d.input?.tool_name || d.tool_name || '(unknown)';
  const toolInput = d.input?.input ?? d.input ?? {};
  $dialogBody.innerHTML = `
    <div class="ec-perm-tool">
      <div class="ec-perm-toolname">${esc(toolName)}</div>
      <pre class="ec-perm-input">${esc(JSON.stringify(toolInput, null, 2))}</pre>
    </div>
    <label class="ec-field">
      <span>수정된 입력 (선택, JSON — 비우면 원본 사용)</span>
      <textarea id="perm-updated" rows="4" placeholder="비우면 원본 그대로 허용"></textarea>
    </label>
    <label class="ec-field">
      <span>메모 (선택)</span>
      <input id="perm-message" type="text" placeholder="claude에 전달될 짧은 메모">
    </label>
  `;
  // submit 버튼 라벨 변경
  $dialogSubmit.textContent = '허용';
  $dialogCancel.textContent = '거부';
  setTimeout(() => $dialogBody.querySelector('#perm-updated')?.focus(), 50);
  $dialog.classList.remove('ec-hidden');
}

function renderAskUserQuestionDialog(d) {
  const questions = (d.input?.questions || []);
  $dialogTitle.textContent = '질문';
  $dialogSubmit.textContent = '전송';
  $dialogCancel.textContent = '취소';
  $dialogBody.innerHTML = questions.map((q, i) => {
    const header = q.header ? `<span class="ec-dialog-header-chip">${esc(q.header)}</span>` : '';
    const opts = (q.options || []).map((opt, oi) => {
      const inputType = q.multiSelect ? 'checkbox' : 'radio';
      const inputName = `dlg-q-${i}`;
      return `
        <label class="ec-dialog-opt">
          <input type="${inputType}" name="${inputName}" value="${esc(opt.label)}" data-qidx="${i}">
          <div class="ec-dialog-opt-text">
            <div class="ec-dialog-opt-label">${esc(opt.label)}</div>
            ${opt.description ? `<div class="ec-dialog-opt-desc">${esc(opt.description)}</div>` : ''}
          </div>
        </label>`;
    }).join('');
    const otherInput = `
      <label class="ec-dialog-opt ec-dialog-opt-other">
        <input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="dlg-q-${i}" value="__other__" data-qidx="${i}">
        <div class="ec-dialog-opt-text">
          <div class="ec-dialog-opt-label">기타</div>
          <input type="text" class="ec-dialog-opt-other-input" data-qidx="${i}" placeholder="직접 입력…">
        </div>
      </label>`;
    return `
      <div class="ec-dialog-question" data-qidx="${i}">
        <div class="ec-dialog-question-head">${header}${esc(q.question)}</div>
        <div class="ec-dialog-options">${opts}${otherInput}</div>
      </div>`;
  }).join('');
  $dialog.classList.remove('ec-hidden');
  const first = $dialogBody.querySelector('input[type=radio],input[type=checkbox]');
  first?.focus();
}

function collectPermissionResponse(allow) {
  const d = currentDialog;
  if (!d) return null;
  const out = { tool_use_id: d.tool_use_id, behavior: allow ? 'allow' : 'deny' };
  if (allow) {
    const txt = $dialogBody.querySelector('#perm-updated')?.value?.trim();
    if (txt) {
      try { out.updatedInput = JSON.parse(txt); }
      catch (e) { return { error: 'updatedInput JSON 파싱 실패: ' + e.message }; }
    }
  }
  const msg = $dialogBody.querySelector('#perm-message')?.value?.trim();
  if (msg) out.message = msg;
  return out;
}

function hideDialog() {
  $dialog.classList.add('ec-hidden');
  currentDialog = null;
}
// 백드롭 클릭 + Esc로 닫기 (다른 모달과 일관성)
$dialog?.addEventListener('click', (e) => { if (e.target === $dialog) hideDialog(); });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $dialog && !$dialog.classList.contains('ec-hidden')) {
    hideDialog();
  }
});

function collectDialogAnswers() {
  const d = currentDialog;
  if (!d) return null;
  const questions = d.input?.questions || [];
  const answers = {};
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const inputs = $dialogBody.querySelectorAll(`input[name="dlg-q-${i}"]`);
    const selected = [];
    for (const el of inputs) {
      if (!el.checked) continue;
      let val = el.value;
      if (val === '__other__') {
        const other = $dialogBody.querySelector(`.ec-dialog-opt-other-input[data-qidx="${i}"]`);
        val = other?.value?.trim() || '';
        if (!val) continue;
      }
      selected.push(val);
    }
    if (!selected.length) return { error: `질문 ${i+1}에 답이 필요합니다` };
    answers[q.question] = q.multiSelect ? selected : selected[0];
  }
  return { answers };
}

$dialogSubmit.addEventListener('click', () => {
  if (!currentDialog) return;
  const { ch, tool_use_id, kind } = currentDialog;
  if (kind === 'PermissionPrompt') {
    const r = collectPermissionResponse(true);
    if (r.error) { alert(r.error); return; }
    sendWs({ op:'permission_response', id: ch.id, ...r });
  } else {
    const r = collectDialogAnswers();
    if (r.error) { alert(r.error); return; }
    sendWs({ op:'dialog_response', id: ch.id, tool_use_id, answers: r.answers });
  }
  ch.pendingDialog = null;
  hideDialog();
});
$dialogCancel.addEventListener('click', () => {
  if (!currentDialog) return;
  const { ch, tool_use_id, kind } = currentDialog;
  if (kind === 'PermissionPrompt') {
    sendWs({ op:'permission_response', id: ch.id, tool_use_id, behavior: 'deny' });
  } else {
    sendWs({ op:'dialog_response', id: ch.id, tool_use_id, cancelled: true });
  }
  ch.pendingDialog = null;
  hideDialog();
});
$dialogClose.addEventListener('click', () => $dialogCancel.click());

// ── Autocomplete (슬래시 커맨드) ──────────────────────────────────────────────
// stream-json/-p 모드에서는 TUI 슬래시 대부분 미지원. 두 갈래로 분리:
//   kind:'claude' — 실제로 claude에게 전송되어 동작하는 것
//   kind:'ec'     — ec 자체 API(/api/slash/*)로 인터셉트, 결과를 모달에 표시
const SLASH_CMDS = [
  // claude-native (stream-json 모드에서도 동작)
  { cmd: '/clear',    desc: '대화 초기화',                   kind: 'claude' },
  { cmd: '/compact',  desc: '대화 압축',                     kind: 'claude' },
  // ec-handled (API 호출 + 모달 표시)
  { cmd: '/status',   desc: '세션 상태 (model/cwd/tools/mcp)', kind: 'ec' },
  { cmd: '/usage',    desc: '토큰 사용량 + 비용',              kind: 'ec' },
  { cmd: '/context',  desc: '컨텍스트 윈도우',                kind: 'ec' },
  { cmd: '/stats',    desc: '~/.claude/stats-cache 누적',     kind: 'ec' },
  { cmd: '/doctor',   desc: '진단 (claude version/auth/mcp)', kind: 'ec' },
  { cmd: '/hooks',    desc: 'settings.json hooks 섹션',       kind: 'ec' },
  { cmd: '/agents',   desc: '에이전트 목록 (filesystem)',     kind: 'ec' },
  { cmd: '/tasks',    desc: '태스크 디렉토리',                kind: 'ec' },
  { cmd: '/config',   desc: '설정 패널 열기',                 kind: 'ec' },
];

// ec-handled 슬래시 인터셉트 — claude로 보내지 않고 ec API 호출
async function runEcSlash(cmd, ch) {
  const name = cmd.replace(/^\//, '');
  if (name === 'config') {
    // 설정 패널 열기 (이미 존재하는 settings 모달)
    document.getElementById('ec-settings-btn')?.click();
    return;
  }
  const sid = ch && ch.sessionId ? ch.sessionId : '';
  try {
    const r = await fetch(apiBase() + `api/slash/${name}?sid=${encodeURIComponent(sid)}`);
    const data = await r.json();
    showSlashResult(cmd, data);
  } catch (e) {
    showSlashResult(cmd, { error: e.message });
  }
}

function showSlashResult(cmd, data) {
  let el = document.getElementById('ec-slash-modal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ec-slash-modal';
    el.className = 'ec-dialog ec-hidden';
    el.innerHTML = `
      <div class="ec-dialog-box">
        <div class="ec-dialog-head">
          <h3 id="ec-slash-title"></h3>
          <button id="ec-slash-close" class="ec-icon-btn">✕</button>
        </div>
        <pre id="ec-slash-body" class="ec-slash-body"></pre>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('#ec-slash-close').addEventListener('click', () => el.classList.add('ec-hidden'));
    el.addEventListener('click', e => { if (e.target === el) el.classList.add('ec-hidden'); });
  }
  document.getElementById('ec-slash-title').textContent = cmd;
  document.getElementById('ec-slash-body').textContent = JSON.stringify(data, null, 2);
  el.classList.remove('ec-hidden');
}
let acIdx = -1;
function updateAc() {
  const v = $input.value;
  if (!v.startsWith('/')) { hideAc(); return; }
  const q = v.toLowerCase();
  const matches = SLASH_CMDS.filter(c => c.cmd.startsWith(q));
  if (!matches.length) { hideAc(); return; }
  acIdx = -1;
  $ac.innerHTML = matches.map((c, i) =>
    `<div class="ec-ac-item" data-i="${i}">
       <span class="ec-ac-cmd">${esc(c.cmd)}</span>
       <span class="ec-ac-desc">${esc(c.desc)}</span>
     </div>`).join('');
  $ac.querySelectorAll('.ec-ac-item').forEach((el, i) => {
    el.addEventListener('pointerdown', e => { e.preventDefault(); fillAc(i, matches); });
  });
  $ac.classList.remove('ec-hidden');
  $ac._matches = matches;
}
function moveAc(dir) {
  const items = $ac.querySelectorAll('.ec-ac-item');
  if (!items.length) return;
  items[acIdx]?.classList.remove('selected');
  acIdx = Math.max(-1, Math.min(items.length - 1, acIdx + dir));
  items[acIdx]?.classList.add('selected');
}
function fillAc(i, matches) {
  matches = matches || $ac._matches || [];
  if (!matches[i]) return;
  $input.value = matches[i].cmd + ' ';
  hideAc();
  $input.focus();
}
function hideAc() { acIdx = -1; $ac.classList.add('ec-hidden'); $ac.innerHTML = ''; }

// ── 사이드바 / 설정 ───────────────────────────────────────────────────────────
$ham?.addEventListener('click', () => $nav.classList.toggle('open'));
$settingsBtn?.addEventListener('click', () => $settings.classList.remove('ec-hidden'));
$settingsClose?.addEventListener('click', () => $settings.classList.add('ec-hidden'));
$('cfg-fontsize')?.addEventListener('input', e => { cfg.fontSize = +e.target.value; saveCfg(); });
$('cfg-theme')?.addEventListener('change', e => { cfg.theme = e.target.value; saveCfg(); });
$('cfg-theme-preset')?.addEventListener('change', e => { cfg.themePreset = e.target.value; saveCfg(); });
$('cfg-logo-preset')?.addEventListener('change', e => { cfg.logoPreset = e.target.value; saveCfg(); });
$('cfg-title-text')?.addEventListener('input', e => { cfg.titleText = e.target.value; saveCfg(); });
$('cfg-custom-mode')?.addEventListener('change', e => { cfg.customThemeMode = e.target.value; saveCfg(); });
$('cfg-custom-svg')?.addEventListener('input', e => { cfg.customLogoSvg = e.target.value; saveCfg(); });
$('cfg-bypass-enabled')?.addEventListener('change', e => { cfg.bypassEnabled = e.target.checked; saveCfg(); renderPermPill(); });
$('cfg-render-md')?.addEventListener('change', e => { setRenderMd(e.target.checked); renderActive(); });
$('cfg-render-mathjax')?.addEventListener('change', e => { setRenderMathJax(e.target.checked); renderActive(); });
['bg','surface','text','accent','border'].forEach(k => {
  $('cfg-color-' + k)?.addEventListener('input', e => {
    if (!cfg.customTheme) cfg.customTheme = {};
    cfg.customTheme[k] = e.target.value;
    saveCfg();
  });
});
$('cfg-reset')?.addEventListener('click', () => {
  if (!confirm('모든 설정을 기본값으로 되돌릴까요?')) return;
  localStorage.removeItem(CFG_KEY);
  location.reload();
});

// ── Session info panel (status/usage/mcp/agents/controls) ────────────────────
// 옵션은 /api/options 에서 동적 로드 (claude --help 파싱)
let claudeOptions = { efforts: [], permissionModes: [], models: [] };
async function loadClaudeOptions() {
  try {
    const r = await fetch(apiBase() + 'api/options');
    if (!r.ok) return;
    claudeOptions = await r.json();
  } catch {}
}

function parseControlsFromArgs(args) {
  // sess.args(또는 argsOverride) 에서 model/effort/permission 추출
  const a = args || [];
  let model = 'default', effort = 'default', permissionMode = 'default';
  let permissionPromptTool = null;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--model' && a[i+1]) model = a[i+1];
    if (a[i] === '--effort' && a[i+1]) effort = a[i+1];
    if (a[i] === '--permission-mode' && a[i+1]) permissionMode = a[i+1];
    if (a[i] === '--permission-prompt-tool' && a[i+1]) permissionPromptTool = a[i+1];
  }
  return { model, effort, permissionMode, permissionPromptTool, raw: a };
}

function patchArgs(originalArgs, patches) {
  // model/effort/permissionMode 만 교체, 나머지는 보존. permission-prompt-tool 토글도 처리.
  const args = (originalArgs || []).slice();
  const removeFlag = flag => {
    let i = args.indexOf(flag);
    while (i !== -1) { args.splice(i, 2); i = args.indexOf(flag); }
  };
  if (patches.model !== undefined) {
    removeFlag('--model');
    if (patches.model && patches.model !== 'default') args.push('--model', patches.model);
  }
  if (patches.effort !== undefined) {
    removeFlag('--effort');
    if (patches.effort && patches.effort !== 'default') args.push('--effort', patches.effort);
  }
  if (patches.permissionMode !== undefined) {
    removeFlag('--permission-mode');
    removeFlag('--permission-prompt-tool');
    // mcp-config는 우리가 자동 주입했으니 제거하지 않음 (다른 mcp config 보존)
    if (patches.permissionMode === 'prompt-tool') {
      args.push('--permission-prompt-tool', 'mcp__easypermitter__permission_prompt');
    } else if (patches.permissionMode && patches.permissionMode !== 'default') {
      args.push('--permission-mode', patches.permissionMode);
    }
  }
  return args;
}

let _infoCurrentArgs = null;

function openInfoPanel() {
  const ch = activeChannel();
  if (!ch) { alert('활성 세션이 없습니다.'); return; }
  const sess = ecSessions.find(s => s.id === ch.sessionId);
  const u = ch.usage || {};
  const s = ch.session || {};
  const ctrl = parseControlsFromArgs(sess?.args);
  _infoCurrentArgs = ctrl.raw.slice();

  // permission mode 표시 정규화
  let permDisplay = ctrl.permissionMode;
  if (ctrl.permissionPromptTool) permDisplay = 'prompt-tool';

  $('info-session-label').textContent = ch.label;
  $('info-body').innerHTML = `
    <section class="ec-info-section">
      <h4>상태</h4>
      <div class="ec-info-grid">
        <div><span>Session ID</span><code>${esc(s.id || ch.session?.id || '')}</code></div>
        <div><span>cwd</span><code>${esc(s.cwd || sess?.cwd || '')}</code></div>
        <div><span>Model</span><code>${esc(s.model || '-')}</code></div>
        <div><span>Version</span><code>${esc(s.claudeCodeVersion || '-')}</code></div>
        <div><span>Permission</span><code>${esc(s.permissionMode || permDisplay || '-')}</code></div>
        <div><span>PID</span><code>${esc(ch.session?.pid || '-')}</code></div>
      </div>
    </section>

    <section class="ec-info-section">
      <h4>사용량</h4>
      <div class="ec-info-grid">
        <div><span>Input</span><b>${fmtNum(u.input)}</b></div>
        <div><span>Output</span><b>${fmtNum(u.output)}</b></div>
        <div><span>Cache read</span><b>${fmtNum(u.cache_read)}</b></div>
        <div><span>Cache create</span><b>${fmtNum(u.cache_creation)}</b></div>
        <div class="ec-info-total"><span>합계</span><b>${fmtNum((u.input||0)+(u.output||0)+(u.cache_read||0)+(u.cache_creation||0))}</b></div>
      </div>
    </section>

    <section class="ec-info-section">
      <h4>MCP 라이브 상태 (${(s.mcpServers||[]).length})</h4>
      <div class="ec-mcp-list">
        ${(s.mcpServers||[]).map(m => `
          <div class="ec-mcp-row">
            <code>${esc(m.name)}</code>
            <span class="ec-mcp-status ec-mcp-${m.status}">${esc(m.status)}</span>
          </div>`).join('') || '<div class="ec-empty">없음</div>'}
      </div>
    </section>

    <section class="ec-info-section">
      <h4>확장 (scope별 설정)</h4>
      <small class="ec-field-hint">user(ec HOME) / project(&lt;cwd&gt;/.claude/settings.json) / local(&lt;cwd&gt;/.claude/settings.local.json). 토글 후 재기동 필요.</small>
      <div id="ec-ext-list" style="margin-top:8px"><div class="ec-empty">로드 중…</div></div>
      <div class="ec-info-tags" style="margin-top:8px">
        ${(s.agents||[]).map(a => `<span class="ec-tag">${esc(a)}</span>`).join('') || ''}
      </div>
    </section>

    <section class="ec-info-section">
      <h4>제어 (변경 후 재기동 필요)</h4>
      <label class="ec-field">
        <span>Model</span>
        <select id="info-model">
          <option value="default" ${ctrl.model==='default'?'selected':''}>default</option>
          ${(claudeOptions.models||[]).map(m => `<option value="${esc(m)}" ${m===ctrl.model?'selected':''}>${esc(m)}</option>`).join('')}
        </select>
      </label>
      <label class="ec-field">
        <span>Effort</span>
        <select id="info-effort">
          <option value="default" ${ctrl.effort==='default'?'selected':''}>default</option>
          ${(claudeOptions.efforts||[]).map(m => `<option value="${esc(m)}" ${m===ctrl.effort?'selected':''}>${esc(m)}</option>`).join('')}
        </select>
      </label>
      <label class="ec-field">
        <span>Permission mode</span>
        <select id="info-perm">
          <option value="default" ${permDisplay==='default'?'selected':''}>default</option>
          ${(claudeOptions.permissionModes||[]).filter(m=>m!=='default').map(m => {
            const disabled = (m === 'bypassPermissions' && !cfg.bypassEnabled) ? ' disabled' : '';
            const lock = disabled ? ' 🔒' : '';
            return `<option value="${esc(m)}" ${m===permDisplay?'selected':''}${disabled}>${esc(m)}${lock}</option>`;
          }).join('')}
          <option value="prompt-tool" ${permDisplay==='prompt-tool'?'selected':''}>prompt-tool (easypermitter)</option>
        </select>
        ${!cfg.bypassEnabled ? '<small class="ec-field-hint">bypassPermissions 사용은 설정 → 외관 → "위험 모드 허용" 켜야 함</small>' : ''}
      </label>
    </section>
  `;
  $('ec-info').classList.remove('ec-hidden');
  // 확장 (scope별 mcp/plugin/skill) 비동기 로드
  loadAndRenderExtensions(ch.sessionId);
}

// scope별 확장 데이터 로드 + 렌더
const SCOPE_LABEL = { user: 'user', project: 'project', local: 'local' };
const SCOPE_ORDER = ['user', 'project', 'local'];
async function loadAndRenderExtensions(sid) {
  const $el = $('ec-ext-list');
  if (!$el) return;
  $el.dataset.sid = sid;
  try {
    const r = await fetch(apiBase() + 'api/scoped/extensions?sid=' + encodeURIComponent(sid));
    const d = await r.json();
    if (!d.ok) { $el.innerHTML = `<div class="ec-empty">로드 실패</div>`; return; }
    const sections = [
      { key: 'mcp', label: 'MCP 서버', items: d.mcp || [] },
      { key: 'plugin', label: 'Plugin', items: d.plugins || [] },
      { key: 'skill', label: 'Skill', items: d.skills || [] },
    ];
    const renderSection = (sec) => {
      const byScope = {};
      for (const it of sec.items) {
        if (!byScope[it.scope]) byScope[it.scope] = [];
        byScope[it.scope].push(it);
      }
      const rows = SCOPE_ORDER.map(scope => {
        const list = byScope[scope] || [];
        const addBtn = `<button type="button" class="ec-btn ec-ext-add" data-kind="${sec.key}" data-scope="${scope}" style="font-size:11px;padding:1px 6px">＋ 추가</button>`;
        const head = `<div class="ec-ext-scope-head"><b>${esc(SCOPE_LABEL[scope])}</b> <span class="ec-muted">(${list.length})</span> ${addBtn}</div>`;
        if (!list.length) return `<div class="ec-ext-scope">${head}</div>`;
        return `
          <div class="ec-ext-scope">
            ${head}
            ${list.map(it => `
              <div class="ec-ext-row">
                <input type="checkbox" class="ec-ext-toggle"
                  data-kind="${sec.key}" data-scope="${esc(it.scope)}" data-name="${esc(it.name)}"
                  ${it.enabled ? 'checked' : ''} title="활성/비활성">
                <code class="ec-ext-name">${esc(it.name)}</code>
                ${sec.key === 'mcp' && it.config?.command ? `<span class="ec-muted ec-ext-meta">${esc(it.config.command)}${(it.config.args||[]).length?' '+esc((it.config.args||[]).slice(0,2).join(' ')):''}</span>` : ''}
                ${sec.key === 'mcp' && it.config?.url ? `<span class="ec-muted ec-ext-meta">${esc(it.config.url)}</span>` : ''}
                ${sec.key === 'skill' && it.symlink ? `<span class="ec-muted ec-ext-meta">(symlink)</span>` : ''}
                <span class="ec-ext-actions">
                  ${sec.key === 'mcp' ? `<button type="button" class="ec-btn ec-ext-reconnect" data-name="${esc(it.name)}" title="이 세션에 /mcp slash 보냄">↻</button>` : ''}
                  <button type="button" class="ec-btn ec-ext-edit" data-kind="${sec.key}" data-scope="${esc(it.scope)}" data-name="${esc(it.name)}" title="편집">✎</button>
                </span>
              </div>
            `).join('')}
          </div>`;
      }).join('');
      return `
        <details class="ec-ext-cat" open>
          <summary><b>${esc(sec.label)}</b> <span class="ec-muted">(${sec.items.length})</span></summary>
          ${rows}
        </details>`;
    };
    $el.innerHTML = sections.map(renderSection).join('');
    // 토글
    $el.querySelectorAll('.ec-ext-toggle').forEach(cb => {
      cb.addEventListener('change', async () => {
        const kind  = cb.dataset.kind;
        const scope = cb.dataset.scope;
        const name  = cb.dataset.name;
        const enabled = cb.checked;
        cb.disabled = true;
        try {
          const r2 = await fetch(apiBase() + 'api/scoped/toggle', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ sid, scope, kind, name, enabled }),
          });
          const data = await r2.json();
          if (!r2.ok || data.error) { alert(data.error || ('HTTP ' + r2.status)); cb.checked = !enabled; }
        } catch (e) { alert('오류: ' + e.message); cb.checked = !enabled; }
        cb.disabled = false;
      });
    });
    // +추가
    $el.querySelectorAll('.ec-ext-add').forEach(b => {
      b.addEventListener('click', () => openExtEdit({ sid, scope: b.dataset.scope, kind: b.dataset.kind, name: '', isNew: true }));
    });
    // 편집
    $el.querySelectorAll('.ec-ext-edit').forEach(b => {
      b.addEventListener('click', () => openExtEdit({ sid, scope: b.dataset.scope, kind: b.dataset.kind, name: b.dataset.name, isNew: false }));
    });
    // mcp 재연결 (해당 세션에 /mcp slash 보냄)
    $el.querySelectorAll('.ec-ext-reconnect').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm(`'${b.dataset.name}' (또는 전체) MCP 재연결을 위해 활성 세션에 /mcp 를 보냅니다. 진행할까요?`)) return;
        b.disabled = true;
        try {
          const r2 = await fetch(apiBase() + `api/sessions/${encodeURIComponent(sid)}/inject`, {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ text: '/mcp' }),
          });
          const data = await r2.json();
          if (!r2.ok || data.error) alert(data.error || ('HTTP ' + r2.status));
        } catch (e) { alert('오류: ' + e.message); }
        b.disabled = false;
      });
    });
  } catch (e) {
    $el.innerHTML = `<div class="ec-empty">로드 실패: ${esc(e.message)}</div>`;
  }
}

// ── 확장 편집 모달 ──────────────────────────────────────────────────────────
async function openExtEdit({ sid, scope, kind, name, isNew }) {
  $('exe-message').textContent = '';
  $('exe-title').textContent = (isNew ? '새 ' : '편집 — ') + ({mcp:'MCP 서버', plugin:'Plugin', skill:'Skill'}[kind] || kind);
  $('exe-scope').value = scope;
  $('exe-kind').textContent = kind;
  $('exe-name').value = name || '';
  $('exe-name').readOnly = false;
  $('exe-delete').style.display = isNew ? 'none' : '';
  // 컨테이너 토글
  $('exe-mcp').classList.toggle('ec-hidden', kind !== 'mcp');
  $('exe-plugin').classList.toggle('ec-hidden', kind !== 'plugin');
  $('exe-skill').classList.toggle('ec-hidden', kind !== 'skill');
  // 초기 빈값
  if (kind === 'mcp') {
    $('exe-mcp-type').value = 'stdio';
    $('exe-mcp-command').value = '';
    $('exe-mcp-args').value = '';
    $('exe-mcp-url-val').value = '';
    $('exe-mcp-env').value = '';
  } else if (kind === 'plugin') {
    $('exe-plugin-enabled').checked = true;
    $('exe-plugin-config').value = '';
  } else if (kind === 'skill') {
    $('exe-skill-content').value = '---\nname: ' + (name || 'new-skill') + '\ndescription: \n---\n\n';
  }
  $('exe-raw').value = '';
  // dataset에 컨텍스트 보관
  $('ec-ext-edit').dataset.sid = sid;
  $('ec-ext-edit').dataset.oldName = name || '';
  $('ec-ext-edit').dataset.isNew = isNew ? '1' : '0';
  $('ec-ext-edit').classList.remove('ec-hidden');
  // 기존 항목 details 로드
  if (!isNew && name) {
    try {
      const r = await fetch(apiBase() + `api/scoped/extension/details?sid=${encodeURIComponent(sid)}&scope=${encodeURIComponent(scope)}&kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`);
      const d = await r.json();
      if (!d.ok) { $('exe-message').textContent = d.error || 'load fail'; return; }
      if (kind === 'mcp') {
        const c = d.config || {};
        if (c.url) {
          $('exe-mcp-type').value = c.type || 'http';
          $('exe-mcp-url-val').value = c.url;
        } else {
          $('exe-mcp-type').value = 'stdio';
          $('exe-mcp-command').value = c.command || '';
          $('exe-mcp-args').value = Array.isArray(c.args) ? c.args.join('\n') : '';
        }
        $('exe-mcp-env').value = c.env ? Object.entries(c.env).map(([k,v]) => `${k}=${v}`).join('\n') : '';
        $('exe-raw').value = JSON.stringify(c, null, 2);
      } else if (kind === 'plugin') {
        const c = d.config || {};
        $('exe-plugin-enabled').checked = c.enabled !== false;
        $('exe-plugin-config').value = JSON.stringify(c, null, 2);
        $('exe-raw').value = JSON.stringify(c, null, 2);
      } else if (kind === 'skill') {
        $('exe-skill-content').value = d.content || '';
      }
    } catch (e) {
      $('exe-message').textContent = '로드 실패: ' + e.message;
    }
  }
  syncMcpFormVisibility();
}

function syncMcpFormVisibility() {
  const t = $('exe-mcp-type')?.value;
  if (!t) return;
  const isStdio = t === 'stdio';
  $('exe-mcp-stdio')?.classList.toggle('ec-hidden', !isStdio);
  $('exe-mcp-url')?.classList.toggle('ec-hidden', isStdio);
}
$('exe-mcp-type')?.addEventListener('change', syncMcpFormVisibility);

$('exe-close')?.addEventListener('click', () => $('ec-ext-edit').classList.add('ec-hidden'));
$('exe-cancel')?.addEventListener('click', () => $('ec-ext-edit').classList.add('ec-hidden'));

function buildExtConfigFromForm(kind) {
  if (kind === 'mcp') {
    const raw = $('exe-raw').value.trim();
    if (raw) { try { return JSON.parse(raw); } catch (e) { throw new Error('raw JSON 파스 실패: ' + e.message); } }
    const type = $('exe-mcp-type').value;
    const envStr = ($('exe-mcp-env').value || '').trim();
    const env = {};
    if (envStr) {
      for (const line of envStr.split('\n')) {
        const m = line.match(/^([^=]+)=(.*)$/);
        if (m) env[m[1].trim()] = m[2];
      }
    }
    if (type === 'stdio') {
      const args = ($('exe-mcp-args').value || '').split('\n').map(s => s.trim()).filter(Boolean);
      const c = { command: $('exe-mcp-command').value.trim() };
      if (args.length) c.args = args;
      if (Object.keys(env).length) c.env = env;
      return c;
    } else {
      const c = { type, url: $('exe-mcp-url-val').value.trim() };
      if (Object.keys(env).length) c.env = env;
      return c;
    }
  }
  if (kind === 'plugin') {
    const raw = ($('exe-plugin-config').value || '').trim();
    let c = {};
    if (raw) { try { c = JSON.parse(raw); } catch (e) { throw new Error('plugin config JSON 파스 실패: ' + e.message); } }
    c.enabled = $('exe-plugin-enabled').checked;
    return c;
  }
  return null;
}

$('exe-save')?.addEventListener('click', async () => {
  const sid = $('ec-ext-edit').dataset.sid;
  const kind = $('exe-kind').textContent;
  const scope = $('exe-scope').value;
  const name = ($('exe-name').value || '').trim();
  const oldName = $('ec-ext-edit').dataset.oldName;
  if (!name) { $('exe-message').textContent = 'name 필요'; return; }
  $('exe-message').style.color = 'var(--text-2)';
  $('exe-message').textContent = '저장 중…';
  try {
    let bodyPayload = { sid, scope, kind, name, oldName };
    if (kind === 'skill') {
      bodyPayload.config = $('exe-skill-content').value;
    } else {
      bodyPayload.config = buildExtConfigFromForm(kind);
    }
    const r = await fetch(apiBase() + 'api/scoped/extension/save', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(bodyPayload),
    });
    const data = await r.json();
    if (!r.ok || data.error) {
      $('exe-message').style.color = 'var(--danger)';
      $('exe-message').textContent = data.error || ('HTTP ' + r.status);
      return;
    }
    $('exe-message').style.color = 'var(--green)';
    $('exe-message').textContent = '✓ 저장됨 — ' + (data.hint || '재기동/재연결 필요');
    setTimeout(() => {
      $('ec-ext-edit').classList.add('ec-hidden');
      loadAndRenderExtensions(sid);
    }, 800);
  } catch (e) {
    $('exe-message').style.color = 'var(--danger)';
    $('exe-message').textContent = '오류: ' + e.message;
  }
});

$('exe-delete')?.addEventListener('click', async () => {
  const sid = $('ec-ext-edit').dataset.sid;
  const kind = $('exe-kind').textContent;
  const scope = $('exe-scope').value;
  const name = $('exe-name').value;
  if (!confirm(`${kind} '${name}' (scope=${scope}) 삭제할까요?`)) return;
  try {
    const r = await fetch(apiBase() + 'api/scoped/extension/delete', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ sid, scope, kind, name }),
    });
    const data = await r.json();
    if (!r.ok || data.error) {
      $('exe-message').style.color = 'var(--danger)';
      $('exe-message').textContent = data.error || ('HTTP ' + r.status);
      return;
    }
    $('ec-ext-edit').classList.add('ec-hidden');
    loadAndRenderExtensions(sid);
  } catch (e) {
    $('exe-message').style.color = 'var(--danger)';
    $('exe-message').textContent = '오류: ' + e.message;
  }
});

$('ec-info-btn')?.addEventListener('click', openInfoPanel);

// 상단 타이틀/로고 클릭 → 홈으로 (활성 세션 해제)
function goHome() {
  activeSid = null;
  if ($activeLabel) $activeLabel.textContent = '';
  refreshTabState();
  renderActive();
  $nav?.classList.remove('open');
}
$('ec-title')?.addEventListener('click', goHome);
$('ec-title')?.style && ($('ec-title').style.cursor = 'pointer');
$('ec-logo')?.addEventListener('click', goHome);
$('ec-logo')?.style && ($('ec-logo').style.cursor = 'pointer');
$('info-close')?.addEventListener('click', () => $('ec-info').classList.add('ec-hidden'));
$('info-cancel')?.addEventListener('click', () => $('ec-info').classList.add('ec-hidden'));
$('info-restart-apply')?.addEventListener('click', () => {
  const ch = activeChannel();
  if (!ch) return;
  const newArgs = patchArgs(_infoCurrentArgs, {
    model:           $('info-model').value,
    effort:          $('info-effort').value,
    permissionMode:  $('info-perm').value,
  });
  if (!confirm(`'${ch.label}' 세션을 재기동하고 새 설정 적용할까요?\n(대화 이력은 --resume 으로 보존)`)) return;
  sendWs({ op:'restart', id: ch.id, args: newArgs });
  $('ec-info').classList.add('ec-hidden');
});

// ── 숨김된 세션 패널 (설정 안) ─────────────────────────────────────────────────
function renderHiddenSessions() {
  const $list = $('cfg-hidden-sessions');
  if (!$list) return;
  const store = loadHiddenStore();
  const items = Object.values(store).sort((a, b) =>
    String(b.hiddenAt || '').localeCompare(String(a.hiddenAt || '')));
  if (!items.length) {
    $list.innerHTML = `<div class="ec-empty">이 브라우저에서 숨긴 세션이 없습니다.
      아래 입력으로 세션 ID를 직접 입력해 복원할 수도 있습니다.</div>`;
    return;
  }
  $list.innerHTML = items.map(it => `
    <div class="ec-home-card" data-sid="${esc(it.id)}">
      <div class="ec-home-row">
        <div class="ec-home-path">
          <code>${esc(it.id)}</code>
          <span style="margin-left:8px;opacity:.7">— ${esc(it.label)}</span>
        </div>
      </div>
      <div class="ec-home-row ec-home-meta">
        <span>${it.cwd ? esc(it.cwd) : '(cwd 미상)'}</span>
        <span>${it.hiddenAt ? esc(it.hiddenAt.slice(0, 19).replace('T', ' ')) : ''}</span>
      </div>
      <div class="ec-home-actions">
        <button class="ec-btn ec-btn-primary ec-hidden-restore" data-sid="${esc(it.id)}">↩ 복원</button>
        <button class="ec-btn ec-hidden-forget" data-sid="${esc(it.id)}">목록에서만 제거</button>
      </div>
    </div>
  `).join('');
  $list.querySelectorAll('.ec-hidden-restore').forEach(b => {
    b.addEventListener('click', () => {
      const sid = b.dataset.sid;
      sendWs({ op: 'unhide_session', id: nextClientId++, sessionId: sid });
      // ack 도착 시 forget 처리. 실패해도 사용자가 '목록에서만 제거' 가능.
    });
  });
  $list.querySelectorAll('.ec-hidden-forget').forEach(b => {
    b.addEventListener('click', () => {
      forgetHiddenSession(b.dataset.sid);
      renderHiddenSessions();
    });
  });
}

// ── ec HOME 단일 카드 (settings 모달) ─────────────────────────────────────────
async function renderHomesList() {
  const $list = $('cfg-homes-list');
  if (!$list) return;
  $list.innerHTML = '<div class="ec-empty">로드 중…</div>';
  try {
    const r = await fetch(apiBase() + 'api/ec-home');
    const h = await r.json();
    if (!h || !h.ok) { $list.innerHTML = '<div class="ec-empty">로드 실패</div>'; return; }
    const overlayBadge = h.overlayEnabled
      ? '<span class="ec-badge ec-badge-ok">overlay 활성</span>'
      : `<span class="ec-badge ec-badge-warn">real HOME (${esc(h.realHome || '')})</span>`;
    $list.innerHTML = `
      <div class="ec-home-card">
        <div class="ec-home-row">
          <div class="ec-home-path"><code>${esc(h.home)}</code></div>
          <span class="ec-home-status" id="ec-home-status">조회 중…</span>
        </div>
        <div class="ec-home-row ec-home-meta">
          <span>${esc(h.email || '(이메일 없음)')}</span>
          <span>${h.writable ? '✏️ 쓰기 가능' : '🔒 읽기 전용'}</span>
          ${overlayBadge}
        </div>
        <div class="ec-home-actions">
          <button class="ec-btn" id="ec-home-login-btn" data-home="${esc(h.home)}">로그인</button>
          <button class="ec-btn" id="ec-home-logout-btn" data-home="${esc(h.home)}">로그아웃</button>
          <details style="margin-top:6px;width:100%"><summary style="cursor:pointer;font-size:11.5px;color:var(--muted)">고급: claude settings.json 직접 편집</summary><div style="margin-top:6px"><button class="ec-btn" id="ec-home-edit-btn" data-home="${esc(h.home)}">settings.json 편집…</button></div></details>
        </div>
      </div>`;
    // auth status
    try {
      const r2 = await fetch(apiBase() + 'api/auth/status?home=' + encodeURIComponent(h.home));
      const st = await r2.json();
      const el = document.getElementById('ec-home-status');
      if (el) {
        if (st.loggedIn) el.innerHTML = `<span class="ec-badge ec-badge-ok">● ${esc(st.subscriptionType || 'logged in')}</span>`;
        else el.innerHTML = `<span class="ec-badge ec-badge-warn">○ 미로그인</span>`;
      }
    } catch {}
    $('ec-home-edit-btn')?.addEventListener('click', () => openSettingsEdit(h.home));
    $('ec-home-login-btn')?.addEventListener('click', () => openLogin(h.home));
    $('ec-home-logout-btn')?.addEventListener('click', () => doLogout(h.home));
  } catch (e) {
    $list.innerHTML = '<div class="ec-empty">로드 실패: ' + esc(e.message) + '</div>';
  }
}

async function openSettingsEdit(home) {
  $('se-home-label').textContent = home;
  $('se-content').value = '로드 중…';
  $('se-message').textContent = '';
  $('ec-settings-edit').classList.remove('ec-hidden');
  $('ec-settings-edit').dataset.home = home;
  try {
    const r = await fetch(apiBase() + 'api/claude-settings?home=' + encodeURIComponent(home));
    const data = await r.json();
    if (data.error) { $('se-message').textContent = data.error; return; }
    $('se-content').value = data.content;
  } catch (e) {
    $('se-message').textContent = '로드 실패: ' + e.message;
  }
}

// ── Auth login/logout ────────────────────────────────────────────────────────
let lgPollTimer = null;
function openLogin(home) {
  $('lg-home-label').textContent = home;
  $('ec-login').dataset.home = home;
  $('lg-step1').classList.remove('ec-hidden');
  $('lg-step2').classList.add('ec-hidden');
  $('lg-message').textContent = '';
  $('lg-message').style.color = 'var(--danger)';
  $('lg-url').value = '';
  if ($('lg-code')) $('lg-code').value = '';
  $('lg-status').textContent = '대기 중…';
  window.lgCodeSubmitted = false;
  if (lgPollTimer) { clearInterval(lgPollTimer); lgPollTimer = null; }
  $('ec-login').classList.remove('ec-hidden');
}
$('lg-close')?.addEventListener('click', () => {
  if (lgPollTimer) { clearInterval(lgPollTimer); lgPollTimer = null; }
  $('ec-login').classList.add('ec-hidden');
});
$('lg-start')?.addEventListener('click', async () => {
  const home = $('ec-login').dataset.home;
  const method = $('lg-method').value;
  const email = $('lg-email').value.trim();
  $('lg-message').textContent = '';
  // PTY 안 splash 후 URL 출력까지 ~10s — 진행 안내 + 버튼 잠금
  $('lg-step1').classList.add('ec-hidden');
  $('lg-step2').classList.remove('ec-hidden');
  $('lg-url').value = '';
  $('lg-status').textContent = '⏳ OAuth URL 생성 중… (최대 15초 소요)';
  $('lg-start').disabled = true;
  try {
    const r = await fetch(apiBase() + 'api/auth/login', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ method, email: email || undefined, home }),
    });
    const data = await r.json();
    $('lg-start').disabled = false;
    if (!data.ok) { $('lg-message').textContent = data.error || '로그인 시작 실패'; return; }
    if (data.url) { $('lg-url').value = data.url; $('lg-status').textContent = '✅ URL 받음 — 새 탭/복사 후 인증'; }
    else { $('lg-status').textContent = 'URL 미수신 — 상태 폴링 중'; }
    // polling
    if (lgPollTimer) clearInterval(lgPollTimer);
    lgPollTimer = setInterval(() => pollAuth(home), 1500);
  } catch (e) {
    $('lg-message').textContent = '오류: ' + e.message;
  }
});
$('lg-setup-token')?.addEventListener('click', async () => {
  const home = $('ec-login').dataset.home;
  $('lg-message').textContent = '';
  // setup-token도 splash 후 URL 출력까지 ~10s
  $('lg-step1').classList.add('ec-hidden');
  $('lg-step2').classList.remove('ec-hidden');
  $('lg-url').value = '';
  $('lg-status').textContent = '⏳ 장기 토큰 URL 생성 중… (최대 15초 소요)';
  $('lg-setup-token').disabled = true;
  try {
    const r = await fetch(apiBase() + 'api/auth/setup-token', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ home }),
    });
    const data = await r.json();
    $('lg-setup-token').disabled = false;
    if (!data.ok) { $('lg-message').textContent = data.error || '시작 실패'; return; }
    if (data.url) { $('lg-url').value = data.url; $('lg-status').textContent = '✅ URL 받음 — 새 탭/복사 후 인증'; }
    else { $('lg-status').textContent = 'URL 미수신 — 폴링 중'; }
    if (lgPollTimer) clearInterval(lgPollTimer);
    lgPollTimer = setInterval(() => pollAuth(home), 1500);
  } catch (e) {
    $('lg-message').textContent = '오류: ' + e.message;
  }
});

$('lg-open')?.addEventListener('click', () => {
  const url = $('lg-url').value;
  if (url) window.open(url, '_blank', 'noopener');
});
$('lg-copy')?.addEventListener('click', () => {
  const url = $('lg-url').value;
  if (url) navigator.clipboard?.writeText(url);
});
// 인증(login/setup-token) 진행 상태 폴링 — lg-status / lg-message 갱신
// 코드 제출 후엔 status 'pending' 으로 덮지 않게 boolean flag (window.lgCodeSubmitted)
async function pollAuth(home) {
  try {
    const r2 = await fetch(apiBase() + 'api/auth/login-status?home=' + encodeURIComponent(home));
    const s = await r2.json();
    if (s.url && !$('lg-url').value) $('lg-url').value = s.url;
    // 진행 raw output을 작은 글씨로 노출 (디버그/사용자 인지)
    const tail = ((s.output || '') + (s.error || '')).slice(-400).trim();
    if (tail) {
      $('lg-message').style.color = 'var(--text-2)';
      $('lg-message').textContent = tail.slice(-300);
    }
    if (s.status === 'success') {
      clearInterval(lgPollTimer); lgPollTimer = null;
      $('lg-status').textContent = '✅ 완료';
      window.lgCodeSubmitted = false;
      setTimeout(() => { $('ec-login').classList.add('ec-hidden'); renderHomesList(); }, 1200);
    } else if (s.status === 'failed' || s.status === 'killed') {
      clearInterval(lgPollTimer); lgPollTimer = null;
      $('lg-status').textContent = `❌ ${s.status}${s.exitCode != null ? ` (exit ${s.exitCode})` : ''}`;
      $('lg-message').style.color = 'var(--danger)';
      $('lg-message').textContent = `실패: ${(s.error || s.output || s.status || '').toString().slice(-300)}`;
      window.lgCodeSubmitted = false;
    } else if (!window.lgCodeSubmitted) {
      // 코드 제출 전: 일반 진행 상태 표시
      $('lg-status').textContent = `상태: ${s.status}${s.exitCode != null ? ` (exit ${s.exitCode})` : ''}`;
    }
    // 코드 제출 후 pending이면 status overwrite 안 함 (위 ✅ 코드 전송됨 유지)
  } catch {}
}

// 콜백 URL 전체를 paste한 경우 code 파라미터만 추출.
// 우선순위: ?code=...&state=... 형식 → code+#state 결합 (claude code의 OAuth 콜백 형식)
function extractAuthCode(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!/^https?:\/\//i.test(s)) return s; // URL 아니면 그대로
  try {
    const u = new URL(s);
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    if (code && state) return `${code}#${state}`;
    if (code) return code;
  } catch {}
  return s;
}

$('lg-submit-code')?.addEventListener('click', async (e) => {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  const home = $('ec-login').dataset.home;
  const raw  = ($('lg-code').value || '').trim();
  if (!raw) { $('lg-message').textContent = '코드 또는 콜백 URL을 입력하세요'; return; }
  const code = extractAuthCode(raw);
  $('lg-message').textContent = '';
  $('lg-status').textContent = '⏳ 코드 제출 중…';
  $('lg-submit-code').disabled = true;
  try {
    const r = await fetch(apiBase() + 'api/auth/paste-code', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ home, code }),
    });
    const data = await r.json();
    $('lg-submit-code').disabled = false;
    if (!r.ok || data.error) {
      $('lg-message').textContent = data.error || ('HTTP ' + r.status);
      return;
    }
    $('lg-status').textContent = '✅ 코드 전송됨 — 인증 진행 대기 중';
    $('lg-code').value = '';
    window.lgCodeSubmitted = true;
    // 폴링이 멈췄으면 재시작 (success/failed에서 정지된 경우 다시 시도)
    if (!lgPollTimer) lgPollTimer = setInterval(() => pollAuth(home), 1500);
  } catch (err) {
    $('lg-submit-code').disabled = false;
    $('lg-message').textContent = '오류: ' + err.message;
  }
});
// 코드 입력란에서 Enter로도 제출
$('lg-code')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); $('lg-submit-code')?.click(); }
});

async function doLogout(home) {
  if (!confirm(`${home}에서 로그아웃할까요?`)) return;
  try {
    const r = await fetch(apiBase() + 'api/auth/logout', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ home }),
    });
    const data = await r.json();
    if (!data.ok) { alert('로그아웃 실패: ' + (data.stderr || 'unknown')); return; }
    renderHomesList();
  } catch (e) {
    alert('오류: ' + e.message);
  }
}

async function showJsonlPath(home) {
  const ch = activeChannel();
  if (!ch) { alert('활성 세션이 없습니다'); return; }
  try {
    const r = await fetch(apiBase() + 'api/sessions/' + encodeURIComponent(ch.sessionId) + '/jsonl-path');
    const data = await r.json();
    if (data.tailCmd) {
      prompt('터미널에서 실행하세요 (Ctrl+C 또는 Cmd+C로 복사):', data.tailCmd);
    } else {
      alert('해당 세션의 jsonl 파일을 찾을 수 없습니다.');
    }
  } catch (e) {
    alert('오류: ' + e.message);
  }
}

$('se-close')?.addEventListener('click', () => $('ec-settings-edit').classList.add('ec-hidden'));
$('se-cancel')?.addEventListener('click', () => $('ec-settings-edit').classList.add('ec-hidden'));
$('se-save')?.addEventListener('click', async () => {
  const home = $('ec-settings-edit').dataset.home;
  const content = $('se-content').value;
  const force = $('se-force')?.checked;
  $('se-message').textContent = '저장 중…';
  $('se-message').style.color = 'var(--text-2)';
  try {
    const url = 'api/claude-settings?home=' + encodeURIComponent(home) + (force ? '&force=1' : '');
    const r = await fetch(apiBase() + url, {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ content }),
    });
    const data = await r.json();
    if (!r.ok || data.error) {
      $('se-message').style.color = 'var(--danger)';
      $('se-message').textContent = data.error || ('HTTP ' + r.status);
      return;
    }
    $('se-message').style.color = 'var(--green)';
    $('se-message').textContent = '저장됨 — 실행 중 세션은 재기동 필요';
    setTimeout(() => $('ec-settings-edit').classList.add('ec-hidden'), 1200);
  } catch (e) {
    $('se-message').style.color = 'var(--danger)';
    $('se-message').textContent = '오류: ' + e.message;
  }
});

// ── 글로벌 Escape — 가장 위에 열린 모달 닫기 ────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const candidates = ['.ec-dialog', '.ec-settings']
    .map(sel => [...document.querySelectorAll(sel)])
    .flat();
  // DOM 뒤쪽이 보통 위 — 마지막 가시 모달 닫음
  const top = candidates.filter(el => !el.classList.contains('ec-hidden')).pop();
  if (top) { e.preventDefault(); top.classList.add('ec-hidden'); }
});

// ── ec config 편집 (스니펫 form + 고급 JSON) ─────────────────────────────────
async function openEcConfigEdit() {
  $('ece-message').textContent = '';
  $('ece-message').style.color = 'var(--text-2)';
  $('ec-econfig-edit').classList.remove('ec-hidden');
  try {
    const r = await fetch(apiBase() + 'api/ec-config');
    const data = await r.json();
    if (!r.ok || data.error) {
      $('ece-message').style.color = 'var(--danger)';
      $('ece-message').textContent = data.error || ('HTTP ' + r.status); return;
    }
    $('ece-path-label').textContent = data.path || '';
    $('ece-content').value = data.content || '{}';
    let cfg = {};
    try { cfg = JSON.parse(data.content || '{}'); } catch {}
    // 스니펫 form 채우기 (default ON 정책 일관)
    const overlayEnabled = !(cfg.overlay && cfg.overlay.enabled === false);
    $('ece-overlay-enabled').checked    = overlayEnabled;
    $('ece-claudemd-user-ref').checked  = !!(cfg.overlay?.claudeMd?.refs?.user);
    $('ece-fmt-markdown').checked       = !!(cfg.formatting?.markdown);
    $('ece-fmt-mathjax').checked        = !!(cfg.formatting?.mathJax);
    $('ece-fmt-extra').value            = cfg.formatting?.extraPrompt || '';
    $('ece-bash-shortcut').checked      = !(cfg.bashShortcut === false);
  } catch (e) {
    $('ece-message').style.color = 'var(--danger)';
    $('ece-message').textContent = '로드 실패: ' + e.message;
  }
}
$('cfg-ec-edit-btn')?.addEventListener('click', openEcConfigEdit);

// 버전 정보 + 업데이트
async function loadVersionInfo() {
  const $info = $('cfg-version-info');
  if (!$info) return;
  try {
    const r = await fetch(apiBase() + 'api/version');
    const d = await r.json();
    if (!d.ok) { $info.textContent = '조회 실패'; return; }
    let badge = '';
    if (d.behind > 0)     badge = ` · <b style="color:var(--warn)">${d.behind} commits behind</b>`;
    else if (d.ahead > 0) badge = ` · <span style="color:var(--text-2)">${d.ahead} ahead</span>`;
    else                  badge = ` · <span style="color:var(--green)">최신</span>`;
    $info.innerHTML = `v${esc(d.version)} · <code>${esc((d.commit||'').slice(0,7))}</code> · ${esc(d.branch||'')}${badge}`;
  } catch (e) { $info.textContent = '조회 오류: ' + e.message; }
}
$('cfg-version-check')?.addEventListener('click', async () => {
  const btn = $('cfg-version-check'); btn.disabled = true; btn.textContent = '확인 중…';
  try {
    const r = await fetch(apiBase() + 'api/version/check', { method: 'POST' });
    const d = await r.json();
    if (d.behind > 0) alert(`새 커밋 ${d.behind}개 사용 가능 — "업데이트 + 재기동" 클릭`);
    else alert('최신 상태입니다.');
    loadVersionInfo();
  } catch (e) { alert('오류: ' + e.message); }
  btn.disabled = false; btn.textContent = '최신 확인';
});
$('cfg-version-update')?.addEventListener('click', async () => {
  if (!confirm('git pull + npm install + ec 재기동을 진행할까요?\n대화 세션은 supervisor가 보존합니다.')) return;
  const btn = $('cfg-version-update'); btn.disabled = true; btn.textContent = '업데이트 중…';
  try {
    const r = await fetch(apiBase() + 'api/version/update', { method: 'POST' });
    const d = await r.json();
    if (!r.ok || d.error) { alert(d.error || 'HTTP ' + r.status); btn.disabled = false; btn.textContent = '업데이트 + 재기동'; return; }
    alert(d.hint || '진행 중… 30초 후 자동 새로고침');
    setTimeout(() => location.reload(), 30000);
  } catch (e) { alert('오류: ' + e.message); btn.disabled = false; btn.textContent = '업데이트 + 재기동'; }
});
$('cfg-restart')?.addEventListener('click', async () => {
  if (!confirm('ec server만 재기동합니다 (supervisor + 대화 세션은 보존).')) return;
  try {
    const r = await fetch(apiBase() + 'api/restart', { method: 'POST' });
    const d = await r.json();
    alert(d.hint || '재기동 요청 보냄.');
    setTimeout(() => location.reload(), 5000);
  } catch (e) { alert('오류: ' + e.message); }
});
// 설정 모달 열 때 버전 정보 갱신
$settingsBtn?.addEventListener('click', () => { loadVersionInfo(); });

// 디버그 토글 (메타/훅 이벤트 표시)
const _cfgShowDebug = $('cfg-show-debug');
if (_cfgShowDebug) {
  _cfgShowDebug.checked = showDebugEvents();
  _cfgShowDebug.addEventListener('change', () => {
    setShowDebugEvents(_cfgShowDebug.checked);
    renderActive();
  });
}
$('ece-close')?.addEventListener('click', () => $('ec-econfig-edit').classList.add('ec-hidden'));
$('ece-cancel')?.addEventListener('click', () => $('ec-econfig-edit').classList.add('ec-hidden'));
$('ec-econfig-edit')?.addEventListener('click', e => { if (e.target.id === 'ec-econfig-edit') $('ec-econfig-edit').classList.add('ec-hidden'); });
$('ece-save')?.addEventListener('click', async () => {
  $('ece-message').style.color = 'var(--text-2)';
  $('ece-message').textContent = '저장 중…';
  try {
    // 고급 탭(textarea)의 JSON을 baseline으로 삼고 form 값을 머지 (form이 우선)
    let cfg;
    try { cfg = JSON.parse($('ece-content').value || '{}'); }
    catch (e) {
      $('ece-message').style.color = 'var(--danger)';
      $('ece-message').textContent = '고급 탭 JSON 파스 실패: ' + e.message;
      return;
    }
    cfg.overlay = cfg.overlay || {};
    cfg.overlay.enabled = $('ece-overlay-enabled').checked;
    cfg.overlay.claudeMd = cfg.overlay.claudeMd || {};
    cfg.overlay.claudeMd.refs = cfg.overlay.claudeMd.refs || {};
    cfg.overlay.claudeMd.refs.user = $('ece-claudemd-user-ref').checked;
    cfg.formatting = cfg.formatting || {};
    cfg.formatting.markdown = $('ece-fmt-markdown').checked;
    cfg.formatting.mathJax  = $('ece-fmt-mathjax').checked;
    const extra = ($('ece-fmt-extra').value || '').trim();
    if (extra) cfg.formatting.extraPrompt = extra;
    else delete cfg.formatting.extraPrompt;
    cfg.bashShortcut = $('ece-bash-shortcut').checked;
    const content = JSON.stringify(cfg, null, 2);
    const r = await fetch(apiBase() + 'api/ec-config', {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ content }),
    });
    const data = await r.json();
    if (!r.ok || data.error) {
      $('ece-message').style.color = 'var(--danger)';
      $('ece-message').textContent = data.error || ('HTTP ' + r.status);
      return;
    }
    $('ece-message').style.color = 'var(--green)';
    $('ece-message').textContent = '저장됨 — ' + (data.hint || '재기동 필요');
    // 고급 탭도 갱신 (사용자가 다시 펼쳤을 때 일관)
    $('ece-content').value = content;
  } catch (e) {
    $('ece-message').style.color = 'var(--danger)';
    $('ece-message').textContent = '오류: ' + e.message;
  }
});

// settings 모달 열 때 homes list 채우기
const _origSettingsOpen = () => $settings.classList.remove('ec-hidden');
$settingsBtn?.addEventListener('click', () => { renderHomesList(); renderHiddenSessions(); });

// 수동 unhide (서버 측 sessionState에는 있으나 이 브라우저 store에 없는 경우)
$('cfg-hidden-manual-btn')?.addEventListener('click', () => {
  const inp = $('cfg-hidden-manual-id');
  const sid = (inp?.value || '').trim();
  if (!sid) { inp?.focus(); return; }
  if (!confirm(`'${sid}' 세션의 숨김을 해제할까요?\n(서버 sessionState 에 hidden 플래그가 있어야 효과 있음)`)) return;
  sendWs({ op: 'unhide_session', id: nextClientId++, sessionId: sid });
  inp.value = '';
});

// ── 새 세션 생성 / 부활 ───────────────────────────────────────────────────────
let nsActiveTab = 'new'; // 'new' | 'resume'
let nsResumeSelected = null; // 선택된 history item

function setNsTab(name) {
  nsActiveTab = name;
  document.querySelectorAll('.ec-ns-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.ec-ns-pane').forEach(p => p.classList.toggle('ec-hidden', p.dataset.pane !== name));
  $newSessionCreate.textContent = name === 'resume' ? '부활' : '생성';
}

async function populateHomeSelectors() {
  try {
    const r = await fetch(apiBase() + 'api/claude-homes');
    if (!r.ok) return;
    const data = await r.json();
    const homes = data.list || [];
    const renderOptions = () => {
      const opts = ['<option value="">기본 (현재 HOME)</option>'];
      for (const h of homes) {
        const emailTag = h.email ? ` · ${esc(h.email)}` : '';
        const disabled = h.writable ? '' : ' disabled';
        const tag = h.writable ? '' : ' (읽기전용/접근불가)';
        opts.push(`<option value="${esc(h.home)}"${disabled}>${esc(h.home)}${emailTag}${tag}</option>`);
      }
      return opts.join('');
    };
    const html = renderOptions();
    const setHomeSelect = id => {
      const el = $(id);
      if (!el) return;
      const cur = el.value;
      el.innerHTML = html;
      if (cur && [...el.options].some(o => o.value === cur)) el.value = cur;
    };
    setHomeSelect('ns-home');
    setHomeSelect('rs-home');
  } catch (e) { console.warn('home scan fail', e); }
}

function showNewSessionModal() {
  $nsLabel.value = '';
  $nsCwd.value = '';
  $nsName.value = '';
  $nsArgs.value = '';
  $('ns-home').value = '';
  $('rs-cwd').value = '';
  $('rs-q').value = '';
  $('rs-args').value = '';
  $('rs-home').value = '';
  $('rs-list').innerHTML = '<div class="ec-empty">검색 필요</div>';
  nsResumeSelected = null;
  setNsTab('new');
  $newSession.classList.remove('ec-hidden');
  populateHomeSelectors();
  setTimeout(() => $nsLabel.focus(), 50);
}

function apiBase() {
  // WebSocket 과 동일한 base path 사용. portal/oauth-proxy 라우팅 통과용.
  return location.pathname.replace(/[^/]*$/, '') || '/';
}
async function searchHistory() {
  const cwd = $('rs-cwd').value.trim();
  const q = $('rs-q').value.trim();
  const params = new URLSearchParams();
  if (cwd) params.set('cwd', cwd);
  if (q) params.set('q', q);
  params.set('limit', '40');
  const $list = $('rs-list');
  $list.innerHTML = '<div class="ec-empty">검색 중…</div>';
  try {
    const r = await fetch(apiBase() + 'api/sessions/history?' + params.toString());
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) throw new Error('서버 응답 비JSON (' + r.status + ')');
    const data = await r.json();
    const items = data.list || [];
    if (!items.length) { $list.innerHTML = '<div class="ec-empty">결과 없음</div>'; return; }
    $list.innerHTML = items.map(it => {
      const date = new Date(it.mtime).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
      const title = it.aiTitle || it.firstMessage.slice(0, 80) || '(제목 없음)';
      const cwd = it.cwd || it.encodedCwd;
      return `<div class="ec-rs-item" data-claude-id="${esc(it.sessionId)}" data-cwd="${esc(cwd)}" data-title="${esc(title)}">
        <div class="ec-rs-item-title">${esc(title)}</div>
        <div class="ec-rs-item-meta">
          <span class="ec-rs-item-cwd">${esc(cwd)}</span>
          <span class="ec-rs-item-date">${esc(date)}</span>
          <span class="ec-rs-item-size">${it.sizeKB}KB</span>
        </div>
      </div>`;
    }).join('');
    $list.querySelectorAll('.ec-rs-item').forEach(el => {
      el.addEventListener('click', () => {
        $list.querySelectorAll('.ec-rs-item').forEach(x => x.classList.remove('selected'));
        el.classList.add('selected');
        nsResumeSelected = {
          claudeId: el.dataset.claudeId,
          cwd: el.dataset.cwd,
          title: el.dataset.title,
        };
      });
    });
  } catch (e) {
    $list.innerHTML = `<div class="ec-empty">오류: ${esc(e.message)}</div>`;
  }
}

let searchDebounce = null;
function scheduleSearch() {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(searchHistory, 300);
}
function hideNewSessionModal() { $newSession.classList.add('ec-hidden'); }

// 셸 토큰화: 공백 split + 따옴표 보존 (간단)
function tokenizeArgs(str) {
  if (!str || !str.trim()) return [];
  const out = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  }
  return out;
}

const PRESETS = {
  // 서버가 --permission-prompt-tool 보이면 mcp-config 자동 주입.
  bypass:   ['--permission-mode', 'bypassPermissions'],
  prompt:   ['--permission-prompt-tool', 'mcp__easypermitter__permission_prompt'],
  opus1m:   ['--model', 'opus[1m]'],
  sonnet1m: ['--model', 'sonnet[1m]'],
};

$newSessionBtn?.addEventListener('click', showNewSessionModal);
$newSessionClose?.addEventListener('click', hideNewSessionModal);
$newSessionCancel?.addEventListener('click', hideNewSessionModal);
$newSession.querySelectorAll('[data-preset]').forEach(btn => {
  btn.addEventListener('click', () => {
    const preset = PRESETS[btn.dataset.preset];
    if (!preset) return;
    const targetId = btn.dataset.target || 'ns-args';
    const $target = $(targetId);
    if (!$target) return;
    const cur = $target.value.trim();
    $target.value = (cur ? cur + ' ' : '') + preset.map(a => a.includes(' ') || a.includes('"') ? JSON.stringify(a) : a).join(' ');
  });
});
$newSessionCreate?.addEventListener('click', () => {
  if (nsActiveTab === 'resume') {
    if (!nsResumeSelected) { alert('세션을 선택하세요'); return; }
    const args = tokenizeArgs($('rs-args').value);
    const home = $('rs-home').value || null;
    sendWs({
      op: 'resume_session', id: nextClientId++,
      label: nsResumeSelected.title.slice(0, 24),
      cwd: nsResumeSelected.cwd,
      claudeId: nsResumeSelected.claudeId,
      args, home,
    });
    hideNewSessionModal();
    return;
  }
  const label = $nsLabel.value.trim();
  const cwd = $nsCwd.value.trim();
  const name = $nsName.value.trim() || null;
  const args = tokenizeArgs($nsArgs.value);
  const home = $('ns-home').value || null;
  if (!label) { $nsLabel.focus(); return; }
  if (!cwd)   { $nsCwd.focus();   return; }
  sendWs({ op: 'create_session', id: nextClientId++, label, cwd, name, args, home });
  hideNewSessionModal();
});

// 탭 전환
document.querySelectorAll('.ec-ns-tab').forEach(t => {
  t.addEventListener('click', () => {
    setNsTab(t.dataset.tab);
    if (t.dataset.tab === 'resume') searchHistory();
  });
});
$('rs-cwd')?.addEventListener('input', scheduleSearch);
$('rs-q')?.addEventListener('input', scheduleSearch);

// ── 시작 ──────────────────────────────────────────────────────────────────────
applyCfg();
loadClaudeOptions();
renderActive();   // 첫 페이지 로드: activeSid=null → 홈 대시보드 즉시 표시
connect();
