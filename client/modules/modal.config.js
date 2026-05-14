// ============================================================
// modal.config — 설정 모달 (사이드바 설정 버튼 → 열림)
//   외관, 렌더링, 안전, 응답 포맷, 환경변수, 디버그, 버전, 숨김세션,
//   홈/인증 (사이드 home 패널 통합)
// ============================================================

modal.config = modal.config || {};
modal.config.dom = modal.config.dom || {};
modal.config.env = modal.config.env || {};
modal.config.env.row = modal.config.env.row || {};
modal.config.env.extraRow = modal.config.env.extraRow || {};
modal.config.version = modal.config.version || {};
modal.config.hidden = modal.config.hidden || {};
modal.config.home = modal.config.home || {};
modal.config.auth = modal.config.auth || {};

(function init() {
  const $ = core.system.dom.$;
  modal.config.dom.panel = $('ec-settings');
  modal.config.dom.close = $('ec-settings-close');
  // env 패널 DOM
  modal.config.env.dom = {
    list:       $('ec-env-list'),
    extraList:  $('ec-env-extra-list'),
    saveBtn:    $('ec-env-save'),
    reloadBtn:  $('ec-env-reload'),
    extraAdd:   $('ec-env-extra-add'),
  };
})();

// ─── 환경변수 패널 ─────────────────────────────────────────
modal.config.env.row.render = (v, userVal) => {
  const esc = core.system.format.escAttr;
  const row = document.createElement('div');
  row.className = 'ec-env-row';
  const placeholder = v.placeholder || (v.default ? `기본: ${v.default}` : '');
  row.innerHTML = `
    <div class="ec-env-row-head">
      <code class="ec-env-row-key">${esc(v.key)}</code>
      <span class="ec-env-row-type">${esc(v.type || 'string')}</span>
    </div>
    <input type="text" data-env-key="${esc(v.key)}" value="${esc(userVal)}" placeholder="${esc(placeholder)}">
    <div class="ec-env-row-desc">${esc(v.description || '')}</div>
  `;
  return row;
};

modal.config.env.extraRow.render = (filePath) => {
  const esc = core.system.format.escAttr;
  const row = document.createElement('div');
  row.className = 'ec-env-extra-row';
  row.innerHTML = `
    <input type="text" data-env-extra value="${esc(filePath)}" placeholder="/path/to/file.env">
    <button type="button" class="ec-btn" data-env-extra-remove>−</button>
  `;
  row.querySelector('[data-env-extra-remove]').addEventListener('click', () => row.remove());
  return row;
};

modal.config.env.load = async () => {
  const { list, extraList } = modal.config.env.dom;
  if (!list) return;
  try {
    const r = await fetch(core.system.api.base() + 'api/ec-env');
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'load fail');
    list.innerHTML = '';
    for (const v of (data.schema.vars || [])) {
      list.appendChild(modal.config.env.row.render(v, (data.user.overrides || {})[v.key] || ''));
    }
    if (extraList) {
      extraList.innerHTML = '';
      for (const f of (data.user.extraFiles || [])) extraList.appendChild(modal.config.env.extraRow.render(f));
    }
  } catch (e) {
    core.system.toast?.show?.('환경변수 로드 실패: ' + e.message, 'error');
  }
};

modal.config.env.save = async () => {
  const overrides = {};
  document.querySelectorAll('#ec-env-list input[data-env-key]').forEach(el => {
    const k = el.getAttribute('data-env-key');
    const v = el.value.trim();
    if (v) overrides[k] = v;
  });
  const extraFiles = [];
  document.querySelectorAll('#ec-env-extra-list input[data-env-extra]').forEach(el => {
    const v = el.value.trim();
    if (v) extraFiles.push(v);
  });
  try {
    const r = await fetch(core.system.api.base() + 'api/ec-env', {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ overrides, extraFiles }),
    });
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || 'save fail');
    core.system.toast?.show?.(data.hint || '환경변수 저장됨', 'info');
  } catch (e) {
    core.system.toast?.show?.('저장 실패: ' + e.message, 'error');
  }
};

// 이벤트 바인딩 (모듈 로드 시점)
modal.config.env.dom.saveBtn?.addEventListener('click', modal.config.env.save);
modal.config.env.dom.reloadBtn?.addEventListener('click', modal.config.env.load);
modal.config.env.dom.extraAdd?.addEventListener('click', () => {
  modal.config.env.dom.extraList?.appendChild(modal.config.env.extraRow.render(''));
});

// 글로벌 alias
window.loadEcEnvPanel = modal.config.env.load;
window.saveEcEnvPanel = modal.config.env.save;

// ─── home / 인증 / 버전 / 숨김세션 본체 ────────────────────
modal.config.home.go = function() {
  activeSid = null;
  if ($activeLabel) $activeLabel.textContent = '';
  refreshTabState();
  renderActive();
  renderUsage();
  $nav?.classList.remove('open');
};
window.goHome = modal.config.home.go;

modal.config.hidden.render = function() {
  const $ = core.system.dom.$;
  const esc = core.system.format.esc;
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
      core.system.ws.send({ op: 'unhide_session', id: nextClientId++, sessionId: sid });
    });
  });
  $list.querySelectorAll('.ec-hidden-forget').forEach(b => {
    b.addEventListener('click', () => {
      forgetHiddenSession(b.dataset.sid);
      modal.config.hidden.render();
    });
  });
};
window.renderHiddenSessions = modal.config.hidden.render;

modal.config.home.render = async function() {
  const $ = core.system.dom.$;
  const esc = core.system.format.esc;
  const $list = $('cfg-homes-list');
  if (!$list) return;
  $list.innerHTML = '<div class="ec-empty">로드 중…</div>';
  try {
    const url = core.system.api.base() + 'api/ec-home';
    const r = await fetch(url);
    if (!r.ok) { $list.innerHTML = `<div class="ec-empty">HTTP ${r.status}: ${esc(url)}</div>`; return; }
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) {
      const body = (await r.text()).slice(0, 200);
      $list.innerHTML = `<div class="ec-empty">비JSON 응답 (${esc(ct)}): ${esc(body)}</div>`;
      return;
    }
    const h = await r.json();
    if (!h || !h.ok) { $list.innerHTML = '<div class="ec-empty">로드 실패: !ok</div>'; return; }
    const overlayBadge = `<span class="ec-badge ec-badge-ok">ec home: ${esc(h.home || '~/.easyclaude')}</span>`;
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
    try {
      const r2 = await fetch(core.system.api.base() + 'api/auth/status?home=' + encodeURIComponent(h.home));
      const st = await r2.json();
      const el = document.getElementById('ec-home-status');
      if (el) {
        if (st.loggedIn) el.innerHTML = `<span class="ec-badge ec-badge-ok">● ${esc(st.subscriptionType || 'logged in')}</span>`;
        else el.innerHTML = `<span class="ec-badge ec-badge-warn">○ 미로그인</span>`;
      }
    } catch {}
    $('ec-home-edit-btn')?.addEventListener('click', () => modal.config.home.openEdit(h.home));
    $('ec-home-login-btn')?.addEventListener('click', () => modal.config.auth.openLogin(h.home));
    $('ec-home-logout-btn')?.addEventListener('click', () => modal.config.auth.logout(h.home));
  } catch (e) {
    $list.innerHTML = '<div class="ec-empty">로드 실패: ' + esc(e.message) + '</div>';
  }
};
window.renderHomesList = modal.config.home.render;

modal.config.home.openEdit = async function(home) {
  const $ = core.system.dom.$;
  $('se-home-label').textContent = home;
  $('se-content').value = '로드 중…';
  $('se-message').textContent = '';
  $('ec-settings-edit').classList.remove('ec-hidden');
  $('ec-settings-edit').dataset.home = home;
  try {
    const r = await fetch(core.system.api.base() + 'api/claude-settings?home=' + encodeURIComponent(home));
    const data = await r.json();
    if (data.error) { $('se-message').textContent = data.error; return; }
    $('se-content').value = data.content;
  } catch (e) {
    $('se-message').textContent = '로드 실패: ' + e.message;
  }
};
window.openSettingsEdit = modal.config.home.openEdit;

modal.config.auth.openLogin = function(home) {
  const $ = core.system.dom.$;
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
  if (state.modal.config.auth.pollTimer) { clearInterval(state.modal.config.auth.pollTimer); state.modal.config.auth.pollTimer = null; }
  window.lgPollTimer = state.modal.config.auth.pollTimer;
  $('ec-login').classList.remove('ec-hidden');
};
window.openLogin = modal.config.auth.openLogin;

modal.config.auth.poll = async function(home) {
  const $ = core.system.dom.$;
  try {
    const r2 = await fetch(core.system.api.base() + 'api/auth/login-status?home=' + encodeURIComponent(home));
    const s = await r2.json();
    if (s.url && !$('lg-url').value) $('lg-url').value = s.url;
    // (구) raw output → lg-message 디버그 출력은 제거. 진짜 실패 시에만 메시지 표시.
    if (s.status === 'success') {
      clearInterval(state.modal.config.auth.pollTimer); state.modal.config.auth.pollTimer = null;
      window.lgPollTimer = null;
      $('lg-status').textContent = '✅ 완료';
      window.lgCodeSubmitted = false;
      setTimeout(() => { $('ec-login').classList.add('ec-hidden'); modal.config.home.render(); }, 1200);
    } else if (s.status === 'failed' || s.status === 'killed') {
      clearInterval(state.modal.config.auth.pollTimer); state.modal.config.auth.pollTimer = null;
      window.lgPollTimer = null;
      $('lg-status').textContent = `❌ ${s.status}${s.exitCode != null ? ` (exit ${s.exitCode})` : ''}`;
      $('lg-message').style.color = 'var(--danger)';
      $('lg-message').textContent = `실패: ${(s.error || s.output || s.status || '').toString().slice(-300)}`;
      window.lgCodeSubmitted = false;
    } else if (!window.lgCodeSubmitted) {
      $('lg-status').textContent = `상태: ${s.status}${s.exitCode != null ? ` (exit ${s.exitCode})` : ''}`;
    }
  } catch {}
};
window.pollAuth = modal.config.auth.poll;

modal.config.auth.extractCode = function(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!/^https?:\/\//i.test(s)) return s;
  try {
    const u = new URL(s);
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    if (code && state) return `${code}#${state}`;
    if (code) return code;
  } catch {}
  return s;
};
window.extractAuthCode = modal.config.auth.extractCode;

modal.config.auth.logout = async function(home) {
  if (!confirm(`${home}에서 로그아웃할까요?`)) return;
  try {
    const r = await fetch(core.system.api.base() + 'api/auth/logout', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ home }),
    });
    const data = await r.json();
    if (!data.ok) { alert('로그아웃 실패: ' + (data.stderr || 'unknown')); return; }
    modal.config.home.render();
  } catch (e) {
    alert('오류: ' + e.message);
  }
};
window.doLogout = modal.config.auth.logout;

modal.config.auth.showJsonl = async function(home) {
  const ch = activeChannel();
  if (!ch) { alert('활성 세션이 없습니다'); return; }
  try {
    const r = await fetch(core.system.api.base() + 'api/sessions/' + encodeURIComponent(ch.sessionId) + '/jsonl-path');
    const data = await r.json();
    if (data.tailCmd) {
      prompt('터미널에서 실행하세요 (Ctrl+C 또는 Cmd+C로 복사):', data.tailCmd);
    } else {
      alert('해당 세션의 jsonl 파일을 찾을 수 없습니다.');
    }
  } catch (e) {
    alert('오류: ' + e.message);
  }
};
window.showJsonlPath = modal.config.auth.showJsonl;

modal.config.home.openEcEdit = async function() {
  const $ = core.system.dom.$;
  $('ece-message').textContent = '';
  $('ece-message').style.color = 'var(--text-2)';
  $('ec-econfig-edit').classList.remove('ec-hidden');
  try {
    const r = await fetch(core.system.api.base() + 'api/ec-config');
    const data = await r.json();
    if (!r.ok || data.error) {
      $('ece-message').style.color = 'var(--danger)';
      $('ece-message').textContent = data.error || ('HTTP ' + r.status); return;
    }
    $('ece-path-label').textContent = data.path || '';
    $('ece-content').value = data.content || '{}';
    let cfg2 = {};
    try { cfg2 = JSON.parse(data.content || '{}'); } catch {}
    $('ece-fmt-markdown').checked       = !!(cfg2.formatting?.markdown);
    $('ece-fmt-mathjax').checked        = !!(cfg2.formatting?.mathJax);
    $('ece-fmt-extra').value            = cfg2.formatting?.extraPrompt || '';
    $('ece-bash-shortcut').checked      = !(cfg2.bashShortcut === false);
  } catch (e) {
    $('ece-message').style.color = 'var(--danger)';
    $('ece-message').textContent = '로드 실패: ' + e.message;
  }
};
window.openEcConfigEdit = modal.config.home.openEcEdit;

modal.config.version.load = async function() {
  const $ = core.system.dom.$;
  const esc = core.system.format.esc;
  const $info = $('cfg-version-info');
  if (!$info) return;
  try {
    const r = await fetch(core.system.api.base() + 'api/version');
    const d = await r.json();
    if (!d.ok) { $info.textContent = '조회 실패'; return; }
    let badge = '';
    if (d.behind > 0)     badge = ` · <b style="color:var(--warn)">${d.behind} commits behind</b>`;
    else if (d.ahead > 0) badge = ` · <span style="color:var(--text-2)">${d.ahead} ahead</span>`;
    else                  badge = ` · <span style="color:var(--green)">최신</span>`;
    $info.innerHTML = `v${esc(d.version)} · <code>${esc((d.commit||'').slice(0,7))}</code> · ${esc(d.branch||'')}${badge}`;
  } catch (e) { $info.textContent = '조회 오류: ' + e.message; }
};
window.loadVersionInfo = modal.config.version.load;

// lgPollTimer 글로벌 호환 (이벤트 바인딩에서 사용)
window.lgPollTimer = null;
