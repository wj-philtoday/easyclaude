'use strict';
// easyclaude 클라이언트 — stream-json turn 수신 + 텍스트 송신 + dialog modal.


const $ = id => document.getElementById(id);
const $tabs = $('ec-tabs');
const $parsed = $('ec-parsed-view');
const $input = $('ec-input');
const $send = $('ec-send-btn');
const $interrupt = $('ec-interrupt-btn');
const $restart = $('ec-restart-btn');
const $disconnect = $('ec-disconnect-btn');
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
const $newSessionBtn = null; // renderTabs()에서 동적 생성
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
  userName: '',               // 대화창 사용자 표시명
  locale: 'ko',               // 언어: ko | en
}, (() => { try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch { return {}; } })());




// ── 상태 ──────────────────────────────────────────────────────────────────────

// ── WebSocket ─────────────────────────────────────────────────────────────────






// ── 탭 ──────────────────────────────────────────────────────────────────────────
// ── 탭 선호도 (pin / group / order) — 서버 영속 ───────────────────────────────

// 그룹 접기 상태 (메모리만)







// ── 대화창 in-place history (jsonl 파스 turn을 위 스크롤로 prepend) ──────────

// ── 마크다운 / MathJax 렌더링 헬퍼 ─────────────────────────────────────────


// ── 렌더 ──────────────────────────────────────────────────────────────────────
const CMD_PILL_EVENTS = new Set(['compact_cmd', 'clear_cmd', 'bash_cmd', 'slash_cmd']);





$send.addEventListener('click', sendInput);
$interrupt?.addEventListener('click', () => {
  const ch = activeChannel();
  if (!ch || !ch.alive) return;
  sendWs({ op: 'interrupt', id: ch.id });
});
$('ec-perm-toggle-btn')?.addEventListener('click', () => showPermModal());
$('ec-model-toggle-btn')?.addEventListener('click', () => showModelModal());
// 툴유즈 탭 클릭 핸들러 (이벤트 위임)
$parsed?.addEventListener('click', e => {
  const tab = e.target.closest('.ec-tool-tab');
  if (!tab) return;
  const panelId = tab.dataset.panel;
  const pane = tab.dataset.pane;
  if (!panelId || !pane) return;
  const panel = document.getElementById(panelId);
  if (!panel) return;
  // 탭 버튼 활성화
  panel.querySelectorAll('.ec-tool-tab').forEach(t => t.classList.toggle('active', t.dataset.pane === pane));
  // 패널 표시
  panel.querySelectorAll('.ec-tool-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === pane));
  e.stopPropagation(); // fold close 이벤트 방지
});

// 대화창 위 스크롤 → history 더 로드 (in-place 무한 스크롤)
const $scrollBottom = $('ec-scroll-bottom');
$parsed?.addEventListener('scroll', () => {
  if ($parsed.scrollTop < 80) {
    const ch = activeChannel();
    if (ch) loadMoreHistory(ch);
  }
  // 맨밑 버튼: 스크롤이 바닥에서 200px 이상 위에 있으면 표시
  if ($scrollBottom) {
    const atBottom = $parsed.scrollTop + $parsed.clientHeight + 200 >= $parsed.scrollHeight;
    $scrollBottom.classList.toggle('ec-hidden', atBottom);
  }
});
$scrollBottom?.addEventListener('click', () => {
  $parsed.scrollTo({ top: $parsed.scrollHeight, behavior: 'smooth' });
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

$disconnect?.addEventListener('click', () => {
  const ch = activeChannel();
  if (!ch) return;
  if (!confirm(`${ch.label || '세션'}의 연결을 끊을까요? (claude 프로세스 종료)`)) return;
  sendWs({ op: 'disconnect', id: ch.id });
});

// ── Dialog (AskUserQuestion) ──────────────────────────────────────────────────

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
  // claude-native (stream-json stdin에 user text로 inject — claude가 slash command로 처리)
  { cmd: '/clear',    desc: '대화 초기화',                   kind: 'claude' },
  { cmd: '/compact',  desc: '대화 압축',                     kind: 'claude' },
  { cmd: '/model',    desc: '모델 변경 (예: /model sonnet)',  kind: 'claude' },
  { cmd: '/memory',   desc: '메모리 보기/편집',              kind: 'claude' },
  { cmd: '/review',   desc: 'PR 리뷰',                      kind: 'claude' },
  { cmd: '/help',     desc: '도움말',                        kind: 'claude' },
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

// ── 사이드바 / 설정 ───────────────────────────────────────────────────────────
$ham?.addEventListener('click', () => $nav.classList.toggle('open'));
$settingsBtn?.addEventListener('click', () => $settings.classList.remove('ec-hidden'));
$settingsClose?.addEventListener('click', () => $settings.classList.add('ec-hidden'));
$('cfg-fontsize')?.addEventListener('input', e => { cfg.fontSize = +e.target.value; saveCfg(); });
$('cfg-username')?.addEventListener('input', e => { cfg.userName = e.target.value; saveCfg(); });
$('cfg-locale')?.addEventListener('change', e => { cfg.locale = e.target.value; saveCfg(); renderTabs(); });
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


// scope별 확장 데이터 로드 + 렌더

// ── 확장 편집 모달 ──────────────────────────────────────────────────────────

$('exe-mcp-type')?.addEventListener('change', syncMcpFormVisibility);

$('exe-close')?.addEventListener('click', () => $('ec-ext-edit').classList.add('ec-hidden'));
$('exe-cancel')?.addEventListener('click', () => $('ec-ext-edit').classList.add('ec-hidden'));


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

// ── ec HOME 단일 카드 (settings 모달) ─────────────────────────────────────────


// ── Auth login/logout ────────────────────────────────────────────────────────
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

// 콜백 URL 전체를 paste한 경우 code 파라미터만 추출.
// 우선순위: ?code=...&state=... 형식 → code+#state 결합 (claude code의 OAuth 콜백 형식)

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
$('cfg-ec-edit-btn')?.addEventListener('click', openEcConfigEdit);

// 버전 정보 + 업데이트
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
    // overlay 컨셉 제거됨 (~/.easyclaude로 통합). 이전 cfg.overlay 값은 무시.
    delete cfg.overlay;
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
$settingsBtn?.addEventListener('click', () => { renderHomesList(); renderHiddenSessions(); loadEcEnvPanel(); });


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






// 셸 토큰화: 공백 split + 따옴표 보존 (간단)
$newSession.querySelectorAll('[data-preset]').forEach(btn => {
  btn.addEventListener('click', () => {
    const allPresets = { ...PRESETS, ...loadCustomPresets() };
    const preset = allPresets[btn.dataset.preset];
    if (!preset) return;
    const args = Array.isArray(preset) ? preset : tokenizeArgs(preset);
    applyPresetToTarget(args, btn.dataset.target || 'ns-args');
  });
});
$('ns-custom-preset-add')?.addEventListener('click', () => {
  const name = $('ns-custom-preset-name')?.value.trim();
  const val = $('ns-custom-preset-val')?.value.trim();
  if (!name || !val) return;
  const customs = loadCustomPresets();
  customs[name] = val;
  saveCustomPresets(customs);
  if ($('ns-custom-preset-name')) $('ns-custom-preset-name').value = '';
  if ($('ns-custom-preset-val')) $('ns-custom-preset-val').value = '';
  renderCustomPresets();
});
renderCustomPresets();
// 닫기/취소/백드롭
$newSessionClose?.addEventListener('click', hideNewSessionModal);
$newSessionCancel?.addEventListener('click', hideNewSessionModal);
$newSession?.addEventListener('click', e => { if (e.target === $newSession) hideNewSessionModal(); });
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
  const label = $nsLabel.value.trim() || genSessionName();
  const cwd = $nsCwd.value.trim();
  const name = $nsName.value.trim() || null;
  const args = tokenizeArgs($nsArgs.value);
  const home = $('ns-home').value || null;
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
renderActive();
renderUsage();
updateScrollBtnPos();
// HTTP fetch: lastActiveSid 복원용 (tabPrefs/uiCfg는 WS list op에서 받으므로 보조용)
fetch('/api/initial-state').then(r => r.json()).then(data => {
  if (data.lastActiveSessionId && !lastActiveSid) lastActiveSid = data.lastActiveSessionId;
  // WS 연결 전에 먼저 적용 (빠른 초기 렌더용)
  if (data.tabPrefs && !Object.keys(tabPrefs).length) Object.assign(tabPrefs, data.tabPrefs);
}).catch(() => {}).finally(() => connect());
