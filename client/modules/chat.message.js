// ============================================================
// chat.message — 채팅 메시지 영역
//   메시지 렌더, 마크다운/MathJax, 디테일 토글, welcome,
//   옛 메시지 자동 로드, stalled 알림, 맨 아래 버튼
// ============================================================

chat.message = chat.message || function(k){ return k==null?chat.message:chat.message[k]; };
chat.message.dom = chat.message.dom || {};
chat.message.body = chat.message.body || {};
chat.message.welcome = chat.message.welcome || {};
chat.message.stalled = chat.message.stalled || {};
chat.message.history = chat.message.history || {};
chat.message.scroll = chat.message.scroll || {};
chat.message.turn = chat.message.turn || {};
chat.message.debug = chat.message.debug || {};
chat.message.render = chat.message.render || function(){}; // 본체는 아래에서 할당

(function init() {
  const $ = core.system.dom.$;
  chat.message.dom.parsed       = $('ec-parsed-view');
  chat.message.dom.scrollBottom = $('ec-scroll-bottom');
})();

// 상수
chat.message.LABELS = {
  human:'You', assistant:'Claude',
  tool_call:'Tool', tool_out:'Result',
  thinking:'Thinking', channel:'IOA',
  agent_input:'Agent 프롬프트',
  result:'Turn 종료', hook:'Hook', meta:'Meta', other:'기타',
};
chat.message.COLORS = {
  human:'var(--accent)', assistant:'var(--green)',
  tool_call:'#cba6f7', tool_out:'#f9e2af',
  thinking:'#74c7ec', channel:'#94e2d5',
  agent_input:'#fab387',
  result:'var(--muted)', hook:'var(--muted)', meta:'var(--muted)', other:'var(--muted)',
};
chat.message.HIDDEN_TYPES_DEFAULT = new Set(['meta', 'hook', 'other']);
chat.message.CMD_PILL_EVENTS = new Set(['compact_cmd', 'clear_cmd', 'bash_cmd', 'slash_cmd']);
window.LABELS = chat.message.LABELS;
window.COLORS = chat.message.COLORS;

// ─── 렌더 옵션 ──────────────────────────────────────────
chat.message.render.getMd     = () => { try { return localStorage.getItem('ec.renderMarkdown') === '1'; } catch { return false; } };
chat.message.render.getMath   = () => { try { return localStorage.getItem('ec.renderMathJax') === '1'; } catch { return false; } };
chat.message.render.setMd     = (v) => { try { localStorage.setItem('ec.renderMarkdown', v ? '1' : '0'); } catch {} };
chat.message.render.setMath   = (v) => { try { localStorage.setItem('ec.renderMathJax', v ? '1' : '0'); } catch {} };
window.getRenderMd      = chat.message.render.getMd;
window.getRenderMathJax = chat.message.render.getMath;
window.setRenderMd      = chat.message.render.setMd;
window.setRenderMathJax = chat.message.render.setMath;

chat.message.debug.get = () => { try { return localStorage.getItem('ec.showDebug') === '1'; } catch { return false; } };
chat.message.debug.set = (v) => { try { localStorage.setItem('ec.showDebug', v ? '1' : '0'); } catch {} };
window.showDebugEvents    = chat.message.debug.get;
window.setShowDebugEvents = chat.message.debug.set;

chat.message.turn.shouldHide = function(t) {
  if (chat.message.debug.get()) return false;
  if (t.type === 'meta' && chat.message.CMD_PILL_EVENTS.has(t.eventType)) return false;
  return chat.message.HIDDEN_TYPES_DEFAULT.has(t.type);
};
chat.message.turn.extractCmd = function(body) {
  const m = (body || '').match(/<command-name>([\s\S]*?)<\/command-name>/);
  return m ? m[1].trim() : (body || '').trim().slice(0, 80);
};
window.shouldHideTurn = chat.message.turn.shouldHide;
window.extractCmd     = chat.message.turn.extractCmd;

// ─── 본문 렌더 (마크다운 + MathJax) ──────────────────────
chat.message.body.render = function(text, forceMarkdown) {
  if (!text) return '';
  const useMd = forceMarkdown || chat.message.render.getMd();
  if (!useMd || typeof marked === 'undefined') {
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
  html = html.replace(/<p>\s*<\/p>/g, '').trimEnd();
  if (typeof DOMPurify !== 'undefined') html = DOMPurify.sanitize(html);
  html = html.replace(/\x02MATH(\d+)\x03/g, (_, i) => esc(holders[+i]));
  return html;
};
chat.message.body.typeset = function(el) {
  if (chat.message.render.getMath() && window.MathJax && MathJax.typesetPromise) {
    MathJax.typesetPromise(el ? [el] : undefined).catch(() => {});
  }
};
window.ecRenderBody = chat.message.body.render;
window.ecTypeset    = chat.message.body.typeset;

// ─── 히스토리 로드 ──────────────────────────────────────
chat.message.history.loadMore = async function(ch) {
  if (!ch || !ch.sessionId || ch.histLoading) return;
  if (ch.histStart === 0) return;
  ch.histLoading = true;
  try {
    const params = new URLSearchParams({ limit: '500' });
    if (ch.histStart > 0) params.set('before', String(ch.histStart));
    const url = core.system.api.base() + `api/sessions/${encodeURIComponent(ch.sessionId)}/history-turns?` + params.toString();
    const r = await fetch(url);
    if (!r.ok) return;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) return;
    const data = await r.json();
    if (!data || !data.ok) return;
    ch.histTotal = data.total;
    ch.histStart = data.start;
    const newItems = data.events || data.turns || [];
    if (Array.isArray(newItems) && newItems.length) {
      const wasActive = ch.sessionId === activeSid;
      const $parsed = chat.message.dom.parsed;
      if (ch.needsScrollBottom) {
        ch.histEvents = newItems.concat(ch.histEvents || []);
        if (wasActive) chat.message.render();
      } else {
        const prevH = wasActive ? $parsed.scrollHeight : 0;
        const prevT = wasActive ? $parsed.scrollTop : 0;
        ch.histEvents = newItems.concat(ch.histEvents || []);
        if (wasActive) {
          const wasAtBottom = prevT + $parsed.clientHeight + 80 >= prevH;
          chat.message.render();
          if (!wasAtBottom) $parsed.scrollTop = ($parsed.scrollHeight - prevH) + prevT;
        }
      }
    }
  } catch (e) { console.warn('[ec] history load fail', e); }
  finally { ch.histLoading = false; }
};
window.loadMoreHistory = chat.message.history.loadMore;

// ─── welcome (home) 화면 ────────────────────────────────
chat.message.welcome.render = function() {
  const $ = core.system.dom.$;
  const esc = core.system.format.esc;
  const $parsed = chat.message.dom.parsed;
  document.getElementById('ec-inputbar').style.display = 'none';
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
      </div>
      <div class="ec-home-recent">
        <h4>최근 세션</h4>
        <div id="ec-home-recent-list" class="ec-home-list"></div>
      </div>
    </div>`;
  const logoSlot = $('ec-home-logo');
  if (logoSlot && $('ec-logo')) logoSlot.innerHTML = $('ec-logo').innerHTML;
  $('ec-home-new')?.addEventListener('click', () => showNewSessionModal());
  $('ec-home-open-nav')?.addEventListener('click', () => $nav?.classList.add('open'));
  $('ec-home-settings')?.addEventListener('click', () => $('ec-settings-btn')?.click());
  fetch(core.system.api.base() + 'api/ec-home').then(r => r.json()).then(h => {
    $('ec-home-overlay').textContent = h.home ? `~/.easyclaude` : '';
    $('ec-home-overlay').title = h.home || '';
    return fetch(core.system.api.base() + 'api/auth/status?home=' + encodeURIComponent(h.home));
  }).then(r => r.json()).then(s => {
    if (s.loggedIn) {
      $('ec-home-auth-state').innerHTML = '<span style="color:var(--green)">●</span> 로그인';
      $('ec-home-auth-sub').textContent = s.subscriptionType || s.authMethod || '';
    } else {
      $('ec-home-auth-state').innerHTML = '<span style="color:var(--warn)">○</span> 미로그인';
      $('ec-home-auth-sub').textContent = '설정에서 로그인 진행';
    }
  }).catch(() => {});
  const recents = ecSessions.slice(0, 6);
  const $rl = $('ec-home-recent-list');
  if ($rl) {
    if (!recents.length) {
      $rl.innerHTML = '<div class="ec-empty">등록된 세션이 없습니다. <b>＋ 새 세션</b>으로 시작하세요.</div>';
    } else {
      $rl.innerHTML = recents.map(s => {
        const ch = channels.get(s.id);
        const alive = (ch && ch.alive) || !!s.alive;
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
};
window.renderHome = chat.message.welcome.render;

chat.message.welcome.genMsg = function() {
  const h = new Date().getHours();
  const period = h < 5 ? '새벽' : h < 9 ? '아침' : h < 12 ? '오전' : h < 14 ? '점심' : h < 18 ? '오후' : h < 22 ? '저녁' : '밤';
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const subjects = ['Claude', '에이전트', '언어모델', '토큰', '파라미터', '어텐션 헤드', 'transformer'];
  const adjs = ['졸린', '배고픈', '철학적인', '확률론적인', '창의적인', '수렴하는', '궁금한'];
  const actions = ['다음 토큰을 예측 중', '컨텍스트를 소화 중', '어텐션을 집중 중', '추론을 진행 중', '가중치를 탐색 중', '손실을 최소화 중'];
  const fulls = [
    '확률의 바다에서 표류 중',
    '컨텍스트 창이 맑습니다',
    '다음 단어는 무엇일까요?',
    '생각의 흐름을 타고 있습니다',
    '한 번에 하나씩, 토큰',
    '모든 단어가 가능성입니다',
    '세계는 토큰으로 이루어져 있습니다',
    '언어의 끝에서 시작됩니다',
    '텍스트는 계속됩니다',
    `생각이 많은 ${period}입니다`,
    `${period}의 적막 속 추론 중`,
    '지금 이 순간도 확률입니다',
    '아직 아무 말도 하지 않았습니다',
    '대화를 기다리고 있습니다',
    `${period}의 언어 모델, 준비 완료`,
    'hallucination 없는 하루를 기원합니다',
    '컨텍스트를 비웠습니다. 신선합니다',
  ];
  const r = Math.random();
  if (r < 0.25) return `${period}의 ${pick(subjects)}, ${pick(actions)}`;
  if (r < 0.5)  return `${pick(adjs)} ${pick(subjects)}가 ${pick(actions)}`;
  return pick(fulls);
};
chat.message.welcome.setStatus = function(text) {
  if (!$viewbarUsage) return;
  $viewbarUsage.innerHTML = '';
  const span = document.createElement('span');
  span.className = 'ec-home-status';
  span.textContent = text;
  $viewbarUsage.appendChild(span);
  requestAnimationFrame(() => {
    if (span.scrollWidth > $viewbarUsage.clientWidth + 2) {
      span.textContent = text + '　　　' + text;
      span.classList.add('scrolling');
    }
  });
};
window._genHomeMsg = chat.message.welcome.genMsg;
window._setHomeStatus = chat.message.welcome.setStatus;

// ─── stalled banner ─────────────────────────────────────
chat.message.stalled.render = function(s) {
  const esc = core.system.format.esc;
  if (!s) return '';
  const dismissBtn = `<button type="button" class="ec-btn" id="stalled-dismiss" style="margin-left:auto">✕ 닫기</button>`;
  if (s.kind === 'auth') {
    return `<div class="ec-stalled ec-stalled-auth">
      <div class="ec-stalled-title">⚠ 인증 필요</div>
      <div class="ec-stalled-body">${esc(s.message || 'Claude 세션이 인증 실패로 멈췄습니다.')}</div>
      <div class="ec-stalled-actions">
        <button type="button" class="ec-btn ec-btn-primary" id="stalled-login">로그인 / OAuth</button>
        <button type="button" class="ec-btn" id="stalled-setup-token">장기 토큰 발급</button>
        <button type="button" class="ec-btn" id="stalled-restart">세션 재기동</button>
        ${dismissBtn}
      </div>
    </div>`;
  }
  if (s.kind === 'rate_limit') {
    const resetTxt = s.resetAt ? new Date(s.resetAt * 1000).toLocaleString() : null;
    return `<div class="ec-stalled ec-stalled-rate">
      <div class="ec-stalled-title">⏳ 사용량 한도 도달</div>
      <div class="ec-stalled-body">${esc(s.message || 'Claude rate limit.')}${resetTxt ? ' · 해제 예정: ' + esc(resetTxt) : ''}</div>
      <div class="ec-stalled-actions">
        <button type="button" class="ec-btn" id="stalled-wait">자동 재시도 대기</button>
        <button type="button" class="ec-btn" id="stalled-switch-model">다른 모델로 재기동</button>
        <button type="button" class="ec-btn" id="stalled-restart">세션 재기동</button>
        ${dismissBtn}
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
};
chat.message.stalled.wire = async function(ch) {
  const $ = core.system.dom.$;
  const dismiss = () => { ch.stalled = null; chat.message.render(); };
  $('stalled-dismiss')?.addEventListener('click', dismiss);
  $('stalled-login')?.addEventListener('click', async () => {
    dismiss();
    try {
      const r = await fetch(core.system.api.base() + 'api/ec-home');
      const h = await r.json();
      if (h && h.home) openLogin(h.home);
    } catch {}
  });
  $('stalled-setup-token')?.addEventListener('click', async () => {
    dismiss();
    try {
      const r = await fetch(core.system.api.base() + 'api/ec-home');
      const h = await r.json();
      if (h && h.home) { openLogin(h.home); setTimeout(() => $('lg-setup-token')?.click(), 100); }
    } catch {}
  });
  $('stalled-restart')?.addEventListener('click', () => {
    ch.stalled = null;
    chat.message.render();
    if (!ch.alive) core.system.ws.send({ op: 'restart', id: ch.id });
  });
  $('stalled-wait')?.addEventListener('click', () => {
    const saved = ch.stalled;
    ch.stalled = { ...saved, message: '자동 재시도 대기 중 — 윈도 해제 시 자동 재기동' };
    if (saved.resetAt) {
      const ms = saved.resetAt * 1000 - Date.now() + 5000;
      if (ms > 0) setTimeout(() => {
        core.system.ws.send({ op: 'restart_session', id: nextClientId++, sessionId: ch.sessionId });
        ch.stalled = null;
        chat.message.render();
      }, Math.min(ms, 6 * 3600 * 1000));
    }
    chat.message.render();
  });
  $('stalled-switch-model')?.addEventListener('click', () => {
    $('ec-info-btn')?.click();
  });
};
window.renderStalledBanner = chat.message.stalled.render;
window.wireStalledBanner = chat.message.stalled.wire;

// ─── 스크롤 ────────────────────────────────────────────
chat.message.scroll.updateBtnPos = function() {
  const ib = document.getElementById('ec-inputbar');
  const sb = document.getElementById('ec-statusbar');
  const ibH = ib ? ib.offsetHeight : 100;
  const sbH = sb ? sb.offsetHeight : 28;
  document.documentElement.style.setProperty('--inputbar-h', ibH + 'px');
  document.documentElement.style.setProperty('--statusbar-h', sbH + 'px');
};
window.updateScrollBtnPos = chat.message.scroll.updateBtnPos;

// ─── 메인 렌더 ─────────────────────────────────────────
chat.message.render = Object.assign(function() {
  const $ = core.system.dom.$;
  const esc = core.system.format.esc;
  const $parsed = chat.message.dom.parsed;
  if (!activeSid) {
    chat.message.welcome.render();
    return;
  }
  document.getElementById('ec-inputbar').style.display = '';
  const ch = channels.get(activeSid);
  if (!ch) {
    activeSid = null;
    if ($activeLabel) $activeLabel.textContent = '';
    chat.message.render();
    renderUsage();
    return;
  }
  const histArr = ch.histEvents || [];
  const liveArr = ch.events || [];
  let liveStart = 0;
  if (histArr.length > 0 && liveArr.length > 0) {
    // histArr 끝에서 UUID를 역방향 탐색해 liveArr 교차점 이후(새 이벤트)만 붙임
    outer: for (let i = histArr.length - 1; i >= 0; i--) {
      const hUuid = histArr[i]?.evt?.uuid;
      if (!hUuid) continue;
      for (let j = liveArr.length - 1; j >= 0; j--) {
        if (liveArr[j]?.evt?.uuid === hUuid) { liveStart = j + 1; break outer; }
      }
    }
  } else if (histArr.length === 0 && liveArr.length > 0) {
    // 히스토리 미로드 상태 — 버퍼에서 마지막 compact_boundary 이후만 표시해 플래시 방지
    for (let i = liveArr.length - 1; i >= 0; i--) {
      if (liveArr[i]?.lex?.category?.startsWith('compact_boundary')) { liveStart = i; break; }
    }
  }
  const allEvents = [...histArr, ...liveArr.slice(liveStart)];
  const pending = ch.pendingInputs || [];
  if (!allEvents.length && !pending.length) {
    $parsed.innerHTML = '<div class="ec-empty">출력 대기 중…</div>';
    return;
  }
  const wasAtBottom = $parsed.scrollTop + $parsed.clientHeight + 80 >= $parsed.scrollHeight;
  const sess = ecSessions.find(s => s.id === ch.sessionId);
  window.__activeSessLabel = sess ? effectiveLabel(sess) : 'Claude';

  const turnsHtml = renderEventStream(allEvents, { turnComplete: !!ch.hadResult });
  const pendingHtml = renderPendingInputs(pending, ch);
  const stalled = ch.stalled || null;
  const stalledHtml = stalled ? chat.message.stalled.render(stalled) : '';
  const isCompacting = (() => {
    let foundCompact = false;
    for (const e of allEvents) {
      if (e.lex?.category === 'slash_cmd_result') {
        const c = e.evt?.content || '';
        if (/^\/compact/i.test(c.trim())) { foundCompact = true; continue; }
        if (foundCompact && /<local-command-stdout>\s*Compacted/i.test(c)) { foundCompact = false; }
      }
    }
    return foundCompact;
  })();
  if (isCompacting && ch.statusText !== '압축 중...') ch.statusText = '압축 중...';
  const waiting = isWaitingForResponse(ch, pending) || isCompacting || ch.statusText === '압축 중...';
  const sessLabel = window.__activeSessLabel;
  const isRestarting = !stalled && ch.alive && !allEvents.length && !pending.length;
  const waitingHtml = waiting ? `
    <div class="ec-turn ec-turn-assistant">
      <div class="ec-turn-label" style="color:${chat.message.COLORS.assistant||'var(--green)'}">${esc(sessLabel)}</div>
      <div class="ec-turn-body ec-thinking-dots">
        <span></span><span></span><span></span>
        ${ch.statusText ? `<em class="ec-thinking-status">${esc(ch.statusText)}</em>` : ''}
      </div>
    </div>` : isRestarting ? `
    <div class="ec-turn ec-turn-assistant">
      <div class="ec-turn-label" style="color:var(--muted)">시스템</div>
      <div class="ec-turn-body" style="color:var(--muted);font-size:12px">세션 시작 중…</div>
    </div>` : '';
  const openFoldKeys = new Set();
  const foldPreScrolls = new Map();
  $parsed.querySelectorAll('details[data-fold-i]').forEach(el => {
    const fi = el.dataset.foldI;
    if (el.open) openFoldKeys.add(fi);
    const pre = el.querySelector('pre');
    if (pre && pre.scrollTop > 0) foldPreScrolls.set(fi, pre.scrollTop);
  });

  const liveTh = document.getElementById('ec-thinking-live');
  const liveThOpen = liveTh?.open || false;
  const liveThEl = (ch.thinkingActive && liveTh) ? liveTh : null;
  const livePreScrollTop = liveTh?.querySelector('pre')?.scrollTop || 0;

  $parsed.innerHTML = turnsHtml + pendingHtml + waitingHtml + stalledHtml;

  if (liveThEl) {
    $parsed.appendChild(liveThEl);
    const livePre = liveThEl.querySelector('pre');
    if (livePre && livePreScrollTop > 0) livePre.scrollTop = livePreScrollTop;
  }
  $('ec-show-debug')?.addEventListener('click', e => {
    e.preventDefault();
    chat.message.debug.set(true);
    chat.message.render();
  });
  chat.message.stalled.wire(ch);

  $parsed._restoringFolds = true;
  $parsed.querySelectorAll('details[data-fold-i]').forEach(el => {
    const fi = el.dataset.foldI;
    if (openFoldKeys.has(fi)) el.open = true;
    const savedScroll = foldPreScrolls.get(fi);
    if (savedScroll) {
      const pre = el.querySelector('pre');
      if (pre) pre.scrollTop = savedScroll;
    }
  });
  const newLiveTh = document.getElementById('ec-thinking-live');
  if (newLiveTh) newLiveTh.open = liveThOpen;
  requestAnimationFrame(() => { $parsed._restoringFolds = false; });

  $parsed.querySelectorAll('details').forEach(el => {
    if (!el._clickHandlerAdded) {
      el._clickHandlerAdded = true;
      el.querySelector('.ec-fold-close-btn')?.addEventListener('click', () => { el.open = false; });
      el.addEventListener('click', e => {
        if (e.target === el) { el.open = false; return; }
        const pre = e.target.closest('.ec-fold-clickable');
        if (pre) {
          const details = pre.closest('details');
          if (details) { details.open = false; e.stopPropagation(); }
        }
      });
    }
    if (!el._toggleHandlerAdded) {
      el._toggleHandlerAdded = true;
      el.addEventListener('toggle', () => {
        if (!el.open || $parsed._restoringFolds) return;
        requestAnimationFrame(() => {
          if ($parsed._restoringFolds) return;
          const rect = el.getBoundingClientRect();
          const parsedRect = $parsed.getBoundingClientRect();
          if (rect.bottom > parsedRect.bottom) {
            $parsed.scrollTop += rect.bottom - parsedRect.bottom + 8;
          }
        });
      });
    }
  });

  if (!ch?.needsScrollBottom && wasAtBottom) {
    requestAnimationFrame(() => { $parsed.scrollTop = $parsed.scrollHeight; });
  }
  chat.message.body.typeset($parsed);
}, chat.message.render); // 기존 멤버(.getMd/.setMd/.getMath/.setMath) 보존
window.renderActive = chat.message.render;
