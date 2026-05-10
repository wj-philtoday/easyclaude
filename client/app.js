'use strict';
/* easyclaude — client */
window.onerror = (msg, src, line) => console.error(`[easyclaude] ${msg} ${src}:${line}`);

// ── Slash commands ────────────────────────────────────────────────────────────
const SLASH_CMDS = [
  { cmd: '/help',       desc: '사용 가능한 명령어 보기' },
  { cmd: '/clear',      desc: '대화 기록 초기화' },
  { cmd: '/compact',    desc: '컨텍스트 압축' },
  { cmd: '/cost',       desc: '토큰 사용량 및 비용' },
  { cmd: '/config',     desc: '설정 변경' },
  { cmd: '/status',     desc: '현재 상태 확인' },
  { cmd: '/memory',     desc: 'AI 기억 관리' },
  { cmd: '/exit',       desc: '종료' },
  { cmd: '/bug',        desc: '버그 리포트' },
  { cmd: '/review',     desc: '코드 리뷰' },
  { cmd: '/init',       desc: 'CLAUDE.md 초기화' },
];

// ── Themes ────────────────────────────────────────────────────────────────────
const THEMES = {
  dark:      { background:'#11111b', foreground:'#cdd6f4', cursor:'#f5e0dc', selectionBackground:'#585b70', black:'#45475a', red:'#f38ba8', green:'#a6e3a1', yellow:'#f9e2af', blue:'#89b4fa', magenta:'#f5c2e7', cyan:'#94e2d5', white:'#bac2de', brightBlack:'#585b70', brightRed:'#f38ba8', brightGreen:'#a6e3a1', brightYellow:'#f9e2af', brightBlue:'#89b4fa', brightMagenta:'#f5c2e7', brightCyan:'#94e2d5', brightWhite:'#a6adc8' },
  light:     { background:'#eff1f5', foreground:'#4c4f69', cursor:'#dc8a78', selectionBackground:'#acb0be', black:'#5c5f77', red:'#d20f39', green:'#40a02b', yellow:'#df8e1d', blue:'#1e66f5', magenta:'#ea76cb', cyan:'#179299', white:'#acb0be', brightBlack:'#6c6f85', brightRed:'#d20f39', brightGreen:'#40a02b', brightYellow:'#df8e1d', brightBlue:'#1e66f5', brightMagenta:'#ea76cb', brightCyan:'#179299', brightWhite:'#bcc0cc' },
  solarized: { background:'#002b36', foreground:'#839496', cursor:'#839496', selectionBackground:'#073642', black:'#073642', red:'#dc322f', green:'#859900', yellow:'#b58900', blue:'#268bd2', magenta:'#d33682', cyan:'#2aa198', white:'#eee8d5', brightBlack:'#002b36', brightRed:'#cb4b16', brightGreen:'#586e75', brightYellow:'#657b83', brightBlue:'#839496', brightMagenta:'#6c71c4', brightCyan:'#93a1a1', brightWhite:'#fdf6e3' },
  monokai:   { background:'#272822', foreground:'#f8f8f2', cursor:'#f8f8f2', selectionBackground:'#75715e', black:'#272822', red:'#f92672', green:'#a6e22e', yellow:'#f4bf75', blue:'#66d9ef', magenta:'#ae81ff', cyan:'#a1efe4', white:'#f8f8f2', brightBlack:'#75715e', brightRed:'#f92672', brightGreen:'#a6e22e', brightYellow:'#f4bf75', brightBlue:'#66d9ef', brightMagenta:'#ae81ff', brightCyan:'#a1efe4', brightWhite:'#f9f8f5' },
};

// ── Config ────────────────────────────────────────────────────────────────────
function loadCfg() { try { return JSON.parse(localStorage.getItem('easyclaude-cfg') || '{}'); } catch { return {}; } }
function saveCfg(c) { localStorage.setItem('easyclaude-cfg', JSON.stringify(c)); }
let cfg = { fontSize: 13, theme: 'dark', ...loadCfg() };

// ── State ─────────────────────────────────────────────────────────────────────
let ws = null, nextId = 0, activeId = null, cmdMode = true;
let channels = new Map(); // id → { term, fitAddon, wrap, tab, sessionId, alive }
let ecSessions = [];
let acIdx = -1;

// ── DOM ───────────────────────────────────────────────────────────────────────
const $nav      = document.getElementById('ec-nav');
const $tabs     = document.getElementById('ec-tabs');
const $terms    = document.getElementById('ec-terms');
const $keybar   = document.getElementById('ec-keybar');
const $inputbar = document.getElementById('ec-inputbar');
const $input    = document.getElementById('ec-input');
const $send     = document.getElementById('ec-send-btn');
const $ac       = document.getElementById('ec-autocomplete');
const $modeBtn  = document.getElementById('ec-mode-btn');
const $settings = document.getElementById('ec-settings');

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const base  = location.pathname.replace(/[^/]*$/, '') || '/';
  ws = new WebSocket(`${proto}://${location.host}${base}`);
  ws.addEventListener('open', () => {
    // 재연결 시 기존 채널 정리 (wrap은 DOM에 유지, 연결만 끊김 표시)
    channels.forEach(ch => { ch.alive = false; ch.tab?.classList.remove('connected'); ch.tab?.classList.add('disconnected'); });
    channels.clear();
    activeId = null;
    sendWs({ op: 'list' });
  });
  ws.addEventListener('message', e  => onMsg(JSON.parse(e.data)));
  ws.addEventListener('close',   () => setTimeout(connect, 2000));
  ws.addEventListener('error',   () => {});
}

function sendWs(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function onMsg(msg) {
  const { op, id } = msg;
  if (op === 'sessions') {
    ecSessions = msg.list;
    renderTabs();
    ecSessions.forEach(s => openSession(s.id));
    return;
  }
  if (op === 'opened') {
    const ch = channels.get(id);
    if (ch) { ch.alive = true; ch.tab?.classList.add('connected'); }
    return;
  }
  if (op === 'output') {
    const ch = channels.get(id);
    if (ch) ch.term.write(msg.data);
    return;
  }
  if (op === 'closed') {
    const ch = channels.get(id);
    if (ch) { ch.alive = false; ch.tab?.classList.remove('connected'); ch.tab?.classList.add('disconnected'); }
    return;
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function renderTabs() {
  $tabs.innerHTML = '';
  ecSessions.forEach(s => {
    const btn = document.createElement('button');
    btn.className = 'ec-tab';
    btn.dataset.sid = s.id;
    btn.innerHTML = `<span class="ec-dot"></span>${esc(s.label)}`;
    btn.addEventListener('click', () => { activate(s.id); $nav.classList.remove('open'); });
    $tabs.appendChild(btn);
    const ch = [...channels.values()].find(c => c.sessionId === s.id);
    if (ch) ch.tab = btn;
  });
}

function activate(sessionId) {
  const ch = [...channels.values()].find(c => c.sessionId === sessionId);
  if (!ch) return;
  activeId = ch.id;
  channels.forEach(c => c.wrap.classList.remove('active'));
  ch.wrap.classList.add('active');
  document.querySelectorAll('.ec-tab').forEach(t => t.classList.remove('active'));
  ch.tab?.classList.add('active');
  requestAnimationFrame(() => { ch.fitAddon.fit(); sendWs({ op:'resize', id:ch.id, cols:ch.term.cols, rows:ch.term.rows }); if (cmdMode) $input.focus(); else ch.term.focus(); });
}

// ── Terminal ──────────────────────────────────────────────────────────────────
// 세션별 터미널 인스턴스 캐시 (WS 재연결 시 재사용)
const termCache = new Map(); // sessionId → { term, fitAddon, wrap }

function openSession(sessionId) {
  const id = nextId++;

  // 기존 터미널 재사용 또는 새로 생성
  let cached = termCache.get(sessionId);
  let term, fitAddon, wrap;
  if (cached) {
    ({ term, fitAddon, wrap } = cached);
  } else {
    term = new Terminal({
      fontSize: cfg.fontSize,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
      theme: THEMES[cfg.theme] || THEMES.dark,
      allowProposedApi: true,
      scrollback: 10000,
      macOptionIsMeta: true,
    });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon.WebLinksAddon());
    wrap = document.createElement('div');
    wrap.className = 'ec-term-wrap';
    $terms.appendChild(wrap);
    term.open(wrap);
    fitAddon.fit();
    termCache.set(sessionId, { term, fitAddon, wrap });
  }

  // INT 모드 전용: 직접 키입력 → 서버 (신규 생성 시에만 등록)
  if (!cached) {
    term.attachCustomKeyEventHandler(() => !cmdMode);
    term.onData(data => { if (!cmdMode) { const ch2 = [...channels.values()].find(c=>c.sessionId===sessionId); if(ch2) sendWs({ op:'input', id:ch2.id, data }); } });
  }

  const tabEl = $tabs.querySelector(`[data-sid="${sessionId}"]`);
  channels.set(id, { id, sessionId, term, fitAddon, wrap, tab: tabEl, alive: false });

  const ro = new ResizeObserver(() => {
    if (!wrap.classList.contains('active')) return;
    fitAddon.fit();
    sendWs({ op:'resize', id, cols: term.cols, rows: term.rows });
  });
  ro.observe(wrap);

  sendWs({ op:'open', id, sessionId });
  if (channels.size === 1) activate(sessionId);
}

// ── Input & Autocomplete ─────────────────────────────────────────────────────
function sendInput() {
  const val = $input.value.trim();
  if (!val) return;
  const ch = activeId !== null ? channels.get(activeId) : null;
  if (ch) {
    sendWs({ op:'input', id: ch.id, data: val });
    // send-keys 완료 후 Enter (서버에서 비동기 처리됨)
    // 서버 청크 전송 완료 후 Enter: (청크 수 × 12ms) + 여유 50ms
    const enterDelay = Math.ceil(val.length / 20) * 12 + 50;
    setTimeout(() => sendWs({ op:'input', id: ch.id, data: '\r' }), enterDelay);
  }
  $input.value = '';
  hideAc();
  requestAnimationFrame(() => $input.focus());
}

$send.addEventListener('click', sendInput);
$input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (acIdx >= 0) fillAc(acIdx); else sendInput(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); moveAc(1); return; }
  if (e.key === 'ArrowUp')   { e.preventDefault(); moveAc(-1); return; }
  if (e.key === 'Escape')    { hideAc(); return; }
});
$input.addEventListener('input', updateAc);

// Autocomplete
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
     </div>`
  ).join('');
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
  const m = (matches || $ac._matches || [])[i];
  if (m) { $input.value = m.cmd + ' '; $input.focus(); }
  hideAc();
}

function hideAc() { $ac.classList.add('ec-hidden'); acIdx = -1; }

// ── Key bar ───────────────────────────────────────────────────────────────────
$keybar.querySelectorAll('button[data-seq]').forEach(btn => {
  btn.addEventListener('pointerdown', e => {
    e.preventDefault();
    const ch = activeId !== null ? channels.get(activeId) : null;
    if (!ch) return;
    sendWs({ op:'input', id: ch.id, data: parseSeq(btn.dataset.seq) });
    if (cmdMode) $input.focus(); else ch.term.focus();
  });
});

// ── Buffer Parser ─────────────────────────────────────────────────────────────
const $parsedView  = document.getElementById('ec-parsed-view');
const $parseStatus = document.getElementById('ec-parse-status');
let parsedMode = false;
let _parseTimer = null;

// ── 색상 샘플러 (개발용) ──────────────────────────────────────────────────────
function sampleColors(term) {
  const buf = term.buffer.active;
  const cell = term.buffer.active.getNullCell?.() || { getChars:()=>'', getFgColor:()=>0, getBgColor:()=>0, isBold:()=>false, isDim:()=>false };
  const results = [];
  const seen = new Set();

  for (let i = Math.max(0, buf.length - 500); i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true).trim();
    if (!text) continue;

    // 첫 비공백 셀의 색상 추출
    for (let x = 0; x < line.length; x++) {
      const c = line.getCell(x);
      if (!c || !c.getChars().trim()) continue;
      const fg = c.getFgColor();
      const bg = c.getBgColor();
      const attrs = [c.isBold()?'bold':'', c.isDim?c.isDim()?'dim':'':'', c.isItalic()?'italic':'', c.isUnderline()?'ul':''].filter(Boolean).join('|');
      const key = `fg:${fg} bg:${bg} ${attrs}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ key, sample: text.slice(0, 60) });
      }
      break;
    }
  }
  return results;
}

// ❯ 라인 셀별 색상 분석 (프롬프트 추천 fg/bg 탐지용)
// ❯ 프롬프트 라인 전체 목록 — 중복 제거 없이 모든 ❯ 라인 색상 출력
window.ecPrompt = () => {
  const ch = activeId !== null ? channels.get(activeId) : null;
  if (!ch) return console.log('no active channel');
  const buf = ch.term.buffer.active;
  const results = [];
  for (let i = Math.max(0, buf.length - 200); i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true).trim();
    if (!text.startsWith('❯')) continue;
    // 첫 셀 색상
    let fg = -1, bg = -1, dim = false;
    for (let x = 0; x < line.length; x++) {
      const c = line.getCell(x);
      if (!c || !c.getChars().trim()) continue;
      fg = c.getFgColor(); bg = c.getBgColor();
      dim = c.isDim ? !!c.isDim() : false;
      break;
    }
    results.push({ fg, bg, dim, text: text.slice(0, 60) });
  }
  console.table(results);
  return results;
};

window.ecSuggest = () => {
  const ch = activeId !== null ? channels.get(activeId) : null;
  if (!ch) return console.log('no active channel');
  const buf = ch.term.buffer.active;
  for (let i = buf.length - 1; i >= Math.max(0, buf.length - 10); i--) {
    const line = buf.getLine(i);
    if (!line) continue;
    if (!line.translateToString(true).trim().startsWith('❯')) continue;
    const cells = [];
    let lastFg = -99, lastBg = -99, lastDim = false;
    for (let x = 0; x < line.length; x++) {
      const c = line.getCell(x);
      if (!c || !c.getChars().trim()) continue;
      const fg = c.getFgColor(), bg = c.getBgColor();
      const dim = c.isDim ? !!c.isDim() : false;
      const italic = c.isItalic ? !!c.isItalic() : false;
      // fg, bg, dim, italic 중 하나라도 변하면 기록
      if (fg !== lastFg || bg !== lastBg || dim !== lastDim) {
        cells.push({ x, fg, bg, dim, italic, sample: line.translateToString(true).slice(x, x + 40) });
        lastFg = fg; lastBg = bg; lastDim = dim;
      }
    }
    console.table(cells);
    // ❯ 다음 3줄도 확인 (제안이 별도 줄일 경우)
    for (let j = i + 1; j < Math.min(i + 4, buf.length); j++) {
      const nl = buf.getLine(j);
      if (!nl) continue;
      const nt = nl.translateToString(true).trim();
      if (!nt) continue;
      let nfg = -1, nbg = -1;
      for (let x = 0; x < nl.length; x++) { const c = nl.getCell(x); if (c?.getChars().trim()) { nfg = c.getFgColor(); nbg = c.getBgColor(); break; } }
      console.log(`[+${j-i}] fg:${nfg} bg:${nbg} | ${nt.slice(0, 60)}`);
    }
    return cells;
  }
  console.log('❯ 라인 없음');
};

// 개발 콘솔 명령: window.ecSample() — 콘솔 전용, 뷰 영향 없음
window.ecSample = () => {
  const ch = activeId !== null ? channels.get(activeId) : null;
  if (!ch) return console.log('no active channel');
  const samples = sampleColors(ch.term);
  console.table(samples);
  console.log('[easyclaude] ecSample 완료 — 콘솔에서 확인하세요');
};

// Claude Code 색상 스펙 (ecPatterns() 확인 완료)
// dim: xterm.js가 134217728 (비트플래그)를 반환 — truthy 체크로 통일
const CC = {
  HUMAN:       (fg, bg)      => fg === 248 && bg === 255,
  HUMAN_CONT:  (fg, bg)      => fg === 16  && bg === 255,  // Human 메시지 이어지는 줄 (래핑)
  ASSISTANT:   (fg, bg)      => fg === 16  && bg === -1,
  TOOL_CALL:   (fg, bg)      => fg === 65  && bg === -1,
  TOOL_OUT:    (fg, bg, dim) => fg === 241 && bg === -1 && !dim,
  THINKING:    (fg, bg)      => fg === 174 && bg === -1,  // ·✶*✢✽ 등 thinking 스피너
  DIFF_ADD:    (fg, bg)      => bg === 194,
  DIFF_DEL:    (fg, bg)      => bg === 224 || bg === 217,
  DIFF_LINENO: (fg, bg, dim) => fg === 236 && bg === -1 && !!dim,
  SEPARATOR:   (fg, bg)      => fg === 37  && bg === -1,
  STATUSLINE:  (fg, bg, dim) => fg === 241 && bg === -1 && !!dim,
  PERMISSION:  (fg, bg)      => fg === 131 && bg === -1,
  MCP:         (fg, bg)      => fg === 105 && bg === -1,  // ← ioa: 채널 메시지
  TMUX:        (fg, bg)      => bg === 2   || fg === 5,
};

function readBufferCells(term) {
  const buf = term.buffer.active;
  const rows = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true).trimEnd();
    // 첫 비공백 셀에서 색상 추출
    let fg = -1, bg = -1, dim = false;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell || !cell.getChars().trim()) continue;
      fg = cell.getFgColor();
      bg = cell.getBgColor();
      dim = cell.isDim ? cell.isDim() : false;
      break;
    }
    // ❯ 라인의 경우: dim 셀 포함 여부 추가 탐지 (서제스트 감지용)
    let hasDimCell = false;
    if (text.trimStart().startsWith('❯') && fg === -1 && bg === -1) {
      for (let x2 = 1; x2 < line.length; x2++) {
        const c2 = line.getCell(x2);
        if (c2?.getChars().trim() && (c2.isDim ? c2.isDim() : false)) { hasDimCell = true; break; }
      }
    }
    rows.push({ text, fg, bg, dim, hasDimCell });
  }
  // 하단 빈 줄 제거
  while (rows.length && !rows[rows.length - 1].text) rows.pop();
  return rows;
}

function readBufferLines(term) {
  return readBufferCells(term).map(r => r.text);
}

function parseClaudeOutput(rows, cursorLine) {  // cursorLine: 현재 활성 프롬프트 라인 인덱스
  const turns = [];
  let cur = null;
  const processedIdx = new Set(); // 처리된 row 인덱스 (파싱 or 무시)

  const flush = () => {
    if (cur) {
      cur.body = cur.body.replace(/\n{3,}/g, '\n\n').trimEnd();
      if (cur.body.trim()) turns.push(cur);
    }
    cur = null;
  };
  const push   = (type, idx) => { flush(); cur = { type, body: '' }; if (idx !== undefined) processedIdx.add(idx); };
  const append = (text, idx) => { if (cur) { cur.body += (cur.body ? '\n' : '') + text; if (idx !== undefined) processedIdx.add(idx); } };
  const ignore = idx => processedIdx.add(idx);

  rows.forEach((row, idx) => {
    const { text, fg, bg, dim } = row;
    const t = text.trim();
    if (!t) { if (cur) cur.body += '\n'; return; }

    // 무시 처리 — 색상 기반 + 텍스트 패턴 백업 (둘 다 processedIdx에 등록)
    const skip = () => { ignore(idx); return true; };
    if (CC.TMUX(fg, bg))           { skip(); return; }
    if (CC.STATUSLINE(fg, bg, dim)){ skip(); return; }
    if (/^\[view-|^\[.*Arche/.test(t))           { skip(); return; }
    if (/^[─━╌]{2}\d/.test(t))    { skip(); return; } // ──N tmux pane 타이틀
    if (/Sonnet|Opus|Haiku/.test(t) && /ctx:\d+%|left/.test(t)) { skip(); return; }
    if (/^[─━═─━]+$/.test(t))                    { skip(); return; }
    if (/^[─━]{2,}.*[─━]{2,}$/.test(t))         { skip(); return; } // ───── Arche ── 혼합 구분선
    if (CC.DIFF_LINENO(fg, bg, dim))             { skip(); return; }
    if (/^\d+\s*$/.test(t))                      { skip(); return; }
    // Thinking 스피너 (fg:174)
    if (CC.THINKING(fg, bg)) { if (cur?.type !== 'thinking') push('thinking', idx); append(t, idx); return; }
    // Thinking 완료: ✻ Cooked/Worked for Ns (fg:241 비-dim, 텍스트로 구분)
    // Timing: ✻ + 임의 단어 + "for Nd/Nm/Ns" — 모든 변형 통합
    // Recap / MCP는 TOOL_OUT보다 먼저 체크
    if (/^[※]\s*recap:/i.test(t)) { push('recap', idx); append(t.replace(/^[※]\s*recap:\s*/i, ''), idx); return; }
    // Recap 연속: 이전 섹션이 recap이면 계속 붙임 (여러 줄 지원)
    if (cur?.type === 'recap' && !/^[●⎿✻✢·•✶✽*✾❯⏵※←╭│╰✢✻]/.test(t) && fg !== 65) {
      append(t, idx); return;
    }
    if (CC.MCP(fg, bg) || /^←\s+\w+:/.test(t)) { push('mcp', idx); append(t.replace(/^←\s+\w+:\s*/, ''), idx); return; }
    // Called X (ctrl+o to expand) → MCP 호출 표시
    if (/^Called\s+\w/.test(t)) { push('mcp', idx); append(t, idx); return; }

    if (CC.TOOL_OUT(fg, bg, dim) && /^✻\s+\w.*\s+for\s+[\d]/.test(t)) {
      push('timing', idx); append(t.replace(/^[✻]\s*/, ''), idx); return;
    }
    // 텍스트 기반 thinking 패턴 백업
    if (/^[·•✢✻✶✽*]\s/.test(t) && /thinking|calculat|infus|brewing|ponder|unravel/i.test(t)) {
      if (cur?.type !== 'thinking') push('thinking', idx); append(t, idx); return;
    }

    // fg:248 bg:255 = 현재 활성 인터랙티브 프롬프트 (cmd 입력)
    if (CC.HUMAN(fg, bg))       { const body = t.replace(/^❯\s*/, '').trim(); if (body) { push('human', idx); append(body, idx); } else ignore(idx); return; }
    if (CC.HUMAN_CONT(fg, bg))  { if (cur?.type === 'human') append(t, idx); else { push('human', idx); append(t, idx); } return; }
    // fg:-1 bg:-1 + ❯ = 명령줄 관련
    if (fg === -1 && bg === -1 && /^❯/.test(t)) {
      // 커서 라인 ±1 범위 또는 서제스트는 무시 (하단 잔여물 방지)
    if (Math.abs(idx - cursorLine) <= 1 || row.hasDimCell) { ignore(idx); return; }
      const body = t.replace(/^❯\s*/, '').trim();
      if (body) { push('cmdline', idx); append(body, idx); } else ignore(idx);
      return;
    }
    if (CC.ASSISTANT(fg, bg))   { if (cur?.type !== 'assistant') push('assistant', idx); append(t.replace(/^●\s*/, ''), idx); return; }
    if (CC.TOOL_CALL(fg, bg))   { push('tool_call', idx); append(t.replace(/^●\s*/, ''), idx); return; }
    if (CC.TOOL_OUT(fg, bg,dim)){ if (cur?.type !== 'tool_out')  push('tool_out',  idx); append(t.replace(/^⎿\s*/, ''), idx); return; }
    if (CC.DIFF_ADD(fg, bg))    { if (cur?.type !== 'diff')      push('diff',      idx); append(t, idx); return; }
    // 권한 확인: ⏵⏵ 텍스트 패턴 필수 (fg:131만으론 Edit 툴 출력과 구분 안됨)
    if (CC.PERMISSION(fg, bg) && /^⏵/.test(t)) { push('permission', idx); append(t, idx); return; }

    if (!cur) push('assistant', idx);
    append(text, idx);
  });
  flush();
  turns._parsedIdx = processedIdx;
  return turns;
}

function renderParsed(turns, rows) {
  if (!turns.length) { $parsedView.innerHTML = '<div style="color:var(--muted);text-align:center;padding:40px">출력 대기 중...</div>'; return; }
  const LABELS = { human:'Human', cmdline:'명령줄', assistant:'Assistant', tool_call:'Tool 호출', tool_out:'Tool 출력', diff:'Diff', thinking:'Thinking', timing:'처리 시간', permission:'권한 확인', recap:'Recap', mcp:'MCP/IOA', other:'기타' };
  const COLORS = { human:'var(--accent)', cmdline:'#6c7086', assistant:'var(--green)', tool_call:'#cba6f7', tool_out:'#f9e2af', diff:'#a6e3a1', thinking:'#74c7ec', timing:'var(--muted)', permission:'#f38ba8', recap:'#fab387', mcp:'#89dceb', other:'var(--muted)' };

  // 인덱스 기반 미파싱 항목 추출
  const parsedIdx = turns._parsedIdx || new Set(); // 파싱 + 무시 모두 포함
  const unparsedUniq = (rows || [])
    .filter((r, i) => !parsedIdx.has(i) && r.text.trim() && r.text.trim().length > 1 && !/^[─━═╭╰│✳]+$/.test(r.text.trim()))
    .map(r => r.text.trim().slice(0, 120))
    .filter((v, i, a) => a.indexOf(v) === i);

  let html = turns.map(t => `
    <div class="ec-turn">
      <div class="ec-turn-label" style="color:${COLORS[t.type]||'var(--muted)'}">${LABELS[t.type] || t.type}</div>
      <div class="ec-turn-body ${t.type}">${esc(t.body)}</div>
    </div>
  `).join('');

  if (unparsedUniq.length) {
    html += `
      <details style="margin-top:8px">
        <summary style="font-size:11px;color:var(--muted);cursor:pointer;padding:4px 0">파싱 안 된 항목 ${unparsedUniq.length}개</summary>
        <div class="ec-turn-body other" style="margin-top:6px">${esc(unparsedUniq.join('\n'))}</div>
      </details>`;
  }

  $parsedView.innerHTML = html;
  $parsedView.scrollTop = $parsedView.scrollHeight;
}

// 누적 색상 패턴 (폴링마다 새 조합 추가, 중복 제거)
const _seenPatterns = new Map(); // key → {fg, bg, dim, sample}

function accumulatePatterns(rows) {
  rows.forEach(({ text, fg, bg, dim }) => {
    const t = text.trim();
    if (!t || t.length < 2) return;
    const firstChar = [...t][0]; // 첫 unicode 문자
    const key = `fg:${fg} bg:${bg}${dim?' dim':''} ch:${firstChar}`;
    if (!_seenPatterns.has(key)) {
      _seenPatterns.set(key, { fg, bg, dim, char: firstChar, sample: t.slice(0, 60) });
    }
  });
}

// window.ecPatterns() 로 누적된 패턴 확인
window.ecPatterns = (filterFg) => {
  let list = [..._seenPatterns.values()];
  if (filterFg !== undefined) list = list.filter(p => p.fg === filterFg);
  console.table(list);
  $parsedView.innerHTML = '<pre style="padding:12px;font-size:11px;color:#cdd6f4;white-space:pre-wrap">' +
    list.map(p => `fg:${String(p.fg).padEnd(4)} bg:${String(p.bg).padEnd(4)} ${p.dim?'dim':'   '} [${p.char}] ${p.sample}`).join('\n') + '</pre>';
};

function updateParsed() {
  const ch = activeId !== null ? channels.get(activeId) : null;
  if (!ch || !parsedMode) return;
  const rows = readBufferCells(ch.term); // 단일 읽기
  accumulatePatterns(rows);
  const cursorLine = ch.term.buffer.active.baseY + ch.term.buffer.active.cursorY;

  // 현재 커서 라인 상태 파악
  const curRow = rows[cursorLine];
  let curState = '—';
  if (curRow) {
    const t = curRow.text.trim();
    if (!t || t === '❯') curState = '빈 프롬프트';
    else if (curRow.hasDimCell) curState = `제안: ${t.replace(/^❯\s*/, '')}`;
    else curState = `계류: ${t.replace(/^❯\s*/, '')}`;
  }
  $parseStatus.textContent = `${rows.length}줄 / 커서:${cursorLine} / ${curState}`;

  if (_paused) return;
  const turns = parseClaudeOutput(rows, cursorLine);
  renderParsed(turns, rows);
}

// 뷰 토글
let _paused = false;
const $pauseBtn = document.getElementById('ec-pause-btn');

document.getElementById('ec-view-raw').addEventListener('click', () => {
  parsedMode = false; _paused = false;
  document.getElementById('ec-view-raw').classList.add('active');
  document.getElementById('ec-view-parsed').classList.remove('active');
  $pauseBtn.textContent = '⏸'; $pauseBtn.classList.remove('active');
  document.getElementById('ec-terms').classList.remove('ec-hidden');
  $parsedView.classList.add('ec-hidden');
  clearInterval(_parseTimer); _parseTimer = null;
});
document.getElementById('ec-view-parsed').addEventListener('click', () => {
  parsedMode = true; _paused = false; _seenPatterns.clear(); // 탭 전환 시 누적 초기화
  document.getElementById('ec-view-parsed').classList.add('active');
  document.getElementById('ec-view-raw').classList.remove('active');
  $pauseBtn.textContent = '⏸'; $pauseBtn.classList.remove('active');
  document.getElementById('ec-terms').classList.add('ec-hidden');
  $parsedView.classList.remove('ec-hidden');
  updateParsed();
  clearInterval(_parseTimer);
  _parseTimer = setInterval(updateParsed, 800);
});
// tmux 전체 스크롤백 캡처 → 텍스트 파서로 PARSED 뷰 갱신
document.getElementById('ec-capture-btn').addEventListener('click', async () => {
  const ch = activeId !== null ? channels.get(activeId) : null;
  if (!ch) return;
  const base = location.pathname.replace(/[^/]*$/, '') || '/';
  const res = await fetch(`${base}api/capture/${ch.sessionId}`);
  if (!res.ok) return;
  const text = await res.text();
  const lines = text.split('\n');
  // 텍스트 기반 파서 (색상 없음)
  const turns = parseTextCapture(lines);
  parsedMode = true;
  document.getElementById('ec-view-parsed').classList.add('active');
  document.getElementById('ec-view-raw').classList.remove('active');
  document.getElementById('ec-terms').classList.add('ec-hidden');
  $parsedView.classList.remove('ec-hidden');
  $parseStatus.textContent = `${lines.length}줄 (전체)`;
  renderParsed(turns, []);
});

function parseTextCapture(lines) {
  const turns = []; let cur = null;
  const flush = () => { if (cur) { cur.body = cur.body.trimEnd(); if (cur.body.trim()) turns.push(cur); } cur = null; };
  const push = type => { flush(); cur = { type, body: '' }; };
  const app  = line => { if (cur) cur.body += (cur.body ? '\n' : '') + line; };
  for (const line of lines) {
    const t = line.trim();
    if (!t || /^─+$/.test(t) || /^[─]{2,}.*[─]{2,}$/.test(t)) continue;
    if (/Sonnet|Opus|Haiku/.test(t) && /ctx:\d+%/.test(t)) continue;
    if (/^\[view-|^[─━]{2}\d/.test(t)) continue;
    if (/^❯\s+/.test(t)) { const b = t.replace(/^❯\s+/, '').trim(); if (b) { push('human'); app(b); } continue; }
    if (/^●\s+Bash\(|^●\s+\w+\(/.test(t)) { push('tool_call'); app(t.replace(/^●\s+/, '')); continue; }
    if (/^⎿/.test(t)) { if (cur?.type !== 'tool_out') push('tool_out'); app(t.replace(/^⎿\s*/, '')); continue; }
    if (/^●\s+/.test(t)) { if (cur?.type !== 'assistant') push('assistant'); app(t.replace(/^●\s+/, '')); continue; }
    if (/^[·•✢✻]\s/.test(t) && /thinking|calculat|infus/i.test(t)) { push('thinking'); app(t.replace(/^[·•✢✻]\s*/, '')); continue; }
    if (/^⏵⏵/.test(t)) { push('permission'); app(t); continue; }
    if (!cur) push('assistant');
    app(line);
  }
  flush();
  return turns;
}

$pauseBtn.addEventListener('click', () => {
  if (!parsedMode) return;
  _paused = !_paused;
  if (_paused) {
    clearInterval(_parseTimer); _parseTimer = null;
    $pauseBtn.textContent = '▶'; $pauseBtn.classList.add('active');
  } else {
    $pauseBtn.textContent = '⏸'; $pauseBtn.classList.remove('active');
    updateParsed();
    _parseTimer = setInterval(updateParsed, 800);
  }
});

// ── CMD / INT toggle ─────────────────────────────────────────────────────────
$modeBtn.addEventListener('click', () => {
  cmdMode = !cmdMode;
  $modeBtn.textContent = cmdMode ? 'CMD' : 'INT';
  $modeBtn.className = cmdMode ? 'ec-mode-cmd' : 'ec-mode-int';
  $inputbar.style.opacity = cmdMode ? '' : '0.4';
  $inputbar.style.pointerEvents = cmdMode ? '' : 'none';
  const ch = activeId !== null ? channels.get(activeId) : null;
  if (cmdMode) { $input.focus(); }
  else if (ch) { ch.term.textarea.tabIndex = 0; ch.term.focus(); }
});

// ── Reconnect ────────────────────────────────────────────────────────────────
document.getElementById('ec-settings-btn').addEventListener('click', openSettings);
// Reconnect: close + reopen
function reconnect() {
  const ch = activeId !== null ? channels.get(activeId) : null;
  if (!ch) return;
  sendWs({ op:'close', id: ch.id });
  const newId = nextId++;
  ch.id = newId;
  channels.delete(ch.id);
  channels.set(newId, ch);
  activeId = newId;
  ch.alive = false;
  ch.tab?.classList.remove('connected');
  sendWs({ op:'open', id: newId, sessionId: ch.sessionId });
}

// ── Settings ─────────────────────────────────────────────────────────────────
function openSettings() {
  document.getElementById('cfg-fontsize').value = cfg.fontSize;
  document.getElementById('cfg-fontsize-val').textContent = cfg.fontSize;
  document.getElementById('cfg-theme').value = cfg.theme;
  $settings.classList.remove('ec-hidden');
}
function applyCfg() {
  channels.forEach(({ term, fitAddon }) => {
    Object.assign(term.options, { fontSize: cfg.fontSize, theme: THEMES[cfg.theme] || THEMES.dark });
    fitAddon.fit();
  });
  saveCfg(cfg);
}
document.getElementById('ec-settings-close').addEventListener('click', () => $settings.classList.add('ec-hidden'));
$settings.addEventListener('click', e => { if (e.target === $settings) $settings.classList.add('ec-hidden'); });
document.getElementById('cfg-fontsize').addEventListener('input', e => { cfg.fontSize = Number(e.target.value); document.getElementById('cfg-fontsize-val').textContent = cfg.fontSize; applyCfg(); });
document.getElementById('cfg-theme').addEventListener('change', e => { cfg.theme = e.target.value; applyCfg(); });

// ── Hamburger ────────────────────────────────────────────────────────────────
document.getElementById('ec-ham').addEventListener('click', () => $nav.classList.toggle('open'));

// ── Utils ────────────────────────────────────────────────────────────────────
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function parseSeq(s) {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_,h) => String.fromCharCode(parseInt(h,16)))
          .replace(/\\u([0-9a-fA-F]{4})/g, (_,h) => String.fromCharCode(parseInt(h,16)))
          .replace(/\\n/g,'\n').replace(/\\r/g,'\r').replace(/\\t/g,'\t');
}

// ── Init ─────────────────────────────────────────────────────────────────────
applyCfg();
connect();
