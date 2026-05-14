// ============================================================
// modal.core — 사이드바 종속 모달
//   탭 ⋮ 메뉴, 그룹 변경, 새 세션 모달, 공통 모달 base
// ============================================================

modal.core = modal.core || {};
modal.core.dom = modal.core.dom || {};
modal.core.base = modal.core.base || {};
modal.core.menu = modal.core.menu || {};
modal.core.group = modal.core.group || {};
modal.core.create = modal.core.create || {};

(function init() {
  const $ = core.system.dom.$;
  // 새 세션 모달
  modal.core.dom.newSession       = $('ec-newsession');
  modal.core.dom.newSessionClose  = $('ec-newsession-close');
  modal.core.dom.newSessionCancel = $('ec-newsession-cancel');
  modal.core.dom.newSessionCreate = $('ec-newsession-create');
  modal.core.dom.nsLabel = $('ns-label');
  modal.core.dom.nsCwd   = $('ns-cwd');
  modal.core.dom.nsName  = $('ns-name');
  modal.core.dom.nsArgs  = $('ns-args');
})();

modal.core.base.show = function({ title, body, onClose }) {
  const esc = core.system.format.esc;
  const overlay = document.createElement('div');
  overlay.className = 'ec-mini-modal-overlay';
  overlay.innerHTML = `<div class="ec-mini-modal"><div class="ec-mini-modal-head"><span>${esc(title)}</span><button class="ec-icon-btn ec-mini-modal-close" aria-label="닫기">✕</button></div><div class="ec-mini-modal-body"></div></div>`;
  const bodyEl = overlay.querySelector('.ec-mini-modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else bodyEl.appendChild(body);
  overlay.querySelector('.ec-mini-modal-close').addEventListener('click', () => { overlay.remove(); onClose?.(); });
  overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); onClose?.(); } });
  document.body.appendChild(overlay);
  return { overlay, bodyEl };
};
window.showMiniModal = modal.core.base.show;

modal.core.menu.show = function(s, anchor) {
  const T = core.system.i18n.t;
  document.querySelectorAll('.ec-tab-popup').forEach(el => el.remove());
  const rect = anchor.getBoundingClientRect();
  const pref = tabPrefs[s.id] || {};
  const isAdhoc = !!s.meta?.adhoc;
  const menu = document.createElement('div');
  menu.className = 'ec-tab-popup';
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
    <button data-act="rename" style="color:var(--text-2)">${T('tab_rename')}</button>
    <button data-act="pin" style="color:var(--text-2)">${pref.pinned ? T('tab_unpin') : T('tab_pin')}</button>
    <button data-act="group" style="color:var(--text-2)">${pref.group ? T('tab_group_remove') : T('tab_group_add')}</button>
    <button data-act="hide" style="color:var(--text-2)">${T('tab_hide')}</button>
    <hr style="border:0;border-top:1px solid var(--border);margin:4px 0">
    <button data-act="restart" style="color:var(--text-2)">${T('tab_restart')}</button>
    <button data-act="disconnect" style="color:var(--text-2)">연결 끊기</button>
    ${isAdhoc ? `<button data-act="delete" style="color:var(--text-2)">${T('tab_delete')}</button>` : ''}
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
        const maxOrder = Math.max(0, ...Object.values(tabPrefs).map(p => p.pinOrder || 0));
        patch.pinOrder = maxOrder + 1;
      } else patch.pinOrder = null;
      setTabPref(s.id, patch);
    } else if (act === 'group') {
      if (pref.group) setTabPref(s.id, { group: null });
      else { close(); showGroupModal(s); return; }
    } else if (act === 'hide') {
      handleTabClose(s);
    } else if (act === 'rename') {
      const cur = effectiveLabel(s);
      const ans = prompt('세션 이름 (비우면 기본값으로 복원):', cur);
      if (ans === null) { close(); return; }
      core.system.ws.send({ op: 'rename_session', id: nextClientId++, sessionId: s.id, label: ans.trim() });
    } else if (act === 'restart') {
      if (!confirm(`'${effectiveLabel(s)}' 세션을 재기동할까요? (claudeId 보존)`)) { close(); return; }
      const ch = channels.get(s.id);
      if (ch) core.system.ws.send({ op:'restart', id: ch.id });
    } else if (act === 'disconnect') {
      if (!confirm(`'${effectiveLabel(s)}' 연결을 끊을까요? (claude 프로세스 종료)`)) { close(); return; }
      const ch = channels.get(s.id);
      if (ch) core.system.ws.send({ op: 'disconnect', id: ch.id });
    } else if (act === 'delete') {
      handleTabDelete(s);
    }
    close();
  });
};
window.showTabMenu = modal.core.menu.show;

modal.core.group.show = function(s) {
  const esc = core.system.format.esc;
  const existing = [...new Set(Object.values(tabPrefs).map(p => p.group).filter(Boolean))];
  const frag = document.createElement('div');
  frag.innerHTML = `
    ${existing.length ? `<p style="font-size:12px;color:var(--text-2);margin-bottom:8px">기존 그룹 선택</p>
    <div class="ec-group-modal-list">${existing.map(g => `<button class="ec-btn ec-group-pick" data-g="${esc(g)}">${esc(g)}</button>`).join('')}</div>
    <hr style="border:0;border-top:1px solid var(--border);margin:10px 0">` : ''}
    <p style="font-size:12px;color:var(--text-2);margin-bottom:6px">새 그룹 이름</p>
    <div style="display:flex;gap:6px">
      <input id="ec-group-input" type="text" placeholder="그룹 이름" style="flex:1;padding:6px 8px;border:1px solid var(--border);border-radius:4px;font-size:13px;background:var(--surface);color:var(--text)">
      <button class="ec-btn ec-btn-primary" id="ec-group-confirm">확인</button>
    </div>`;
  const { overlay } = modal.core.base.show({ title: '그룹 배정 — ' + esc(effectiveLabel(s)), body: frag });
  frag.querySelectorAll('.ec-group-pick').forEach(btn => {
    btn.addEventListener('click', () => {
      setTabPref(s.id, { group: btn.dataset.g });
      overlay.remove();
    });
  });
  const input = frag.querySelector('#ec-group-input');
  frag.querySelector('#ec-group-confirm').addEventListener('click', () => {
    const val = input.value.trim();
    if (val) { setTabPref(s.id, { group: val }); overlay.remove(); }
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') frag.querySelector('#ec-group-confirm').click(); });
  setTimeout(() => input.focus(), 50);
};
window.showGroupModal = modal.core.group.show;

modal.core.create.setTab = function(name) {
  state.modal.core.create.tab = name;
  window.nsActiveTab = name;
  document.querySelectorAll('.ec-ns-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.ec-ns-pane').forEach(p => p.classList.toggle('ec-hidden', p.dataset.pane !== name));
  $newSessionCreate.textContent = name === 'resume' ? '부활' : '생성';
};
window.setNsTab = modal.core.create.setTab;

modal.core.create.populateHomes = async function() {
  const $ = core.system.dom.$;
  const esc = core.system.format.esc;
  try {
    const r = await fetch(core.system.api.base() + 'api/claude-homes');
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
};
window.populateHomeSelectors = modal.core.create.populateHomes;

modal.core.create.show = function() {
  const $ = core.system.dom.$;
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
  state.modal.core.create.resumeSelected = null;
  window.nsResumeSelected = null;
  modal.core.create.setTab('new');
  $newSession.classList.remove('ec-hidden');
  modal.core.create.populateHomes();
  setTimeout(() => $nsLabel.focus(), 50);
};
window.showNewSessionModal = modal.core.create.show;

modal.core.create.search = async function() {
  const $ = core.system.dom.$;
  const esc = core.system.format.esc;
  const cwd = $('rs-cwd').value.trim();
  const q = $('rs-q').value.trim();
  const params = new URLSearchParams();
  if (cwd) params.set('cwd', cwd);
  if (q) params.set('q', q);
  params.set('limit', '40');
  const $list = $('rs-list');
  $list.innerHTML = '<div class="ec-empty">검색 중…</div>';
  try {
    const r = await fetch(core.system.api.base() + 'api/sessions/history?' + params.toString());
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
        state.modal.core.create.resumeSelected = {
          claudeId: el.dataset.claudeId,
          cwd: el.dataset.cwd,
          title: el.dataset.title,
        };
        window.nsResumeSelected = state.modal.core.create.resumeSelected;
      });
    });
  } catch (e) {
    $list.innerHTML = `<div class="ec-empty">오류: ${esc(e.message)}</div>`;
  }
};
window.searchHistory = modal.core.create.search;

modal.core.create.scheduleSearch = function() {
  clearTimeout(state.modal.core.create.searchDebounce);
  state.modal.core.create.searchDebounce = setTimeout(modal.core.create.search, 300);
  window.searchDebounce = state.modal.core.create.searchDebounce;
};
window.scheduleSearch = modal.core.create.scheduleSearch;

modal.core.create.hide = function() { $newSession.classList.add('ec-hidden'); };
window.hideNewSessionModal = modal.core.create.hide;

modal.core.create.renderPresets = function() {
  const $ = core.system.dom.$;
  const esc = core.system.format.esc;
  const $c = $('ns-custom-presets');
  if (!$c) return;
  const customs = loadCustomPresets();
  $c.innerHTML = Object.entries(customs).map(([name]) =>
    `<button type="button" class="ec-custom-preset-btn" data-name="${esc(name)}">${esc(name)} <span style="color:var(--danger);margin-left:4px">✕</span></button>`
  ).join('');
  $c.querySelectorAll('.ec-custom-preset-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (e.target.tagName === 'SPAN') {
        const customs = loadCustomPresets();
        delete customs[btn.dataset.name];
        saveCustomPresets(customs);
        modal.core.create.renderPresets();
      } else {
        const customs = loadCustomPresets();
        const val = customs[btn.dataset.name];
        if (val) applyPresetToTarget(tokenizeArgs(val), 'ns-args');
      }
    });
  });
};
window.renderCustomPresets = modal.core.create.renderPresets;

// 글로벌 호환 변수
window.nsActiveTab = 'new';
window.nsResumeSelected = null;
window.searchDebounce = null;
