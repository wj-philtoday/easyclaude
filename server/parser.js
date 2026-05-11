'use strict';
// Turn classifier — client/app.js에 있던 parseClaudeOutput을 서버 모듈로 이전.
// 입력: rows (Screen.rows() 형식 — {text,fg,bg,dim,bold,hasDimCell,cells}),
//      cursorLine (현재 활성 프롬프트 라인 절대 인덱스, optional)
// 출력: { turns: [{type, body}, ...], unparsed: [...] }
//
// 인스턴스 단위로 envSpec(채널별 색 학습 상태)을 유지.

const MODAL_TAB_FG = new Set([110, 153]);
const MODAL_TAB_KW = /\b(Settings|Status|Config|Usage|Stats|Help|General|Commands)\b/;
const PERM_MODE_RE = /^[⏵⏸][⏵⏸]?\s+\S.*\s(mode|permissions?)\s+on\s+\(shift\+tab\s+to\s+cycle\)/i;

// 셀별 attr 기반 modal cell 식별 — modal 활성 row에서 leftover conversation cells 분리용.
function isModalCell(c) {
  if (c.fg === 153 || c.fg === 110 || c.fg === 246 || c.fg === 220) return true; // accent/footer/warning
  if (c.fg === 16 && c.bg === 153) return true;                                    // title bar
  if (c.fg === -1 && !c.bold && c.bg === -1) return true;                         // modal body
  return false; // leftover
}

// statusline cell: fg:246 dim=1 또는 fg:241 dim=1
function isStatusCell(c) { return (c.fg === 246 || c.fg === 241) && c.dim && c.bg === -1; }

// warning cell: fg:220 (yellow) — Claude TUI 시스템 경고 (PATH 안내 등)
function isWarningCell(c) { return c.fg === 220 && c.bg === -1; }

// modal row를 cells 단위로 정제: modal-style cell만 유지, leftover는 공백으로 치환해 컬럼 정렬 보존
function extractCellsByPredicate(cells, predicate) {
  if (!cells || !cells.length) return '';
  const chars = [];
  for (const c of cells) {
    const ch = c.char || ' ';
    if (!ch.trim()) { chars.push(' '); continue; }
    if (predicate(c)) chars.push(ch);
    else chars.push(' ');
  }
  return chars.join('').replace(/\s{4,}/g, '   ').replace(/\s+$/, '').replace(/^\s+/, '');
}
function extractStatusFromCells(cells)  { return extractCellsByPredicate(cells, isStatusCell); }
function extractWarningFromCells(cells) { return extractCellsByPredicate(cells, isWarningCell); }

function cleanModalRowFromCells(cells) {
  if (!cells || !cells.length) return '';
  const chars = [];
  for (const c of cells) {
    const ch = c.char || ' ';
    if (ch === ' ' || ch === ' ') { chars.push(' '); continue; } // 공백은 attrs 무관 보존
    if (isModalCell(c)) chars.push(ch);
    else chars.push(' '); // leftover → space
  }
  return chars.join('').replace(/\s{4,}/g, '   ').replace(/\s+$/, '').replace(/^\s{2,}/, '  ');
}

class Parser {
  constructor() {
    this.envSpec = { assistantFg:-2, humanBg:-2, toolOutFg:-2, statusFg:-2, thinkingFg:-2, modalOpen:false };
  }

  _CC() {
    const env = this.envSpec;
    return {
      DIFF_ADD: (fg, bg) => bg === 194 || bg === 22,
      DIFF_DEL: (fg, bg) => bg === 224 || bg === 217 || bg === 52,
      TMUX:     (fg, bg) => bg === 2 || fg === 5,
      IS_HUMAN_BG: bg => env.humanBg !== -2 ? bg === env.humanBg : (bg === 255 || bg === 237),
      IS_ASSISTANT: fg => env.assistantFg !== -2 ? fg === env.assistantFg : (fg === 16 || fg === 231),
      IS_TOOL_OUT: (fg, dim) => !dim && (env.toolOutFg !== -2 ? fg === env.toolOutFg : (fg === 241 || fg === 246)),
      IS_STATUS: (fg, dim) => !!dim && (env.statusFg !== -2 ? fg === env.statusFg : (fg === 241 || fg === 246)),
      IS_THINKING: fg => env.thinkingFg !== -2 ? fg === env.thinkingFg : fg === 174,
    };
  }

  _learn(t, fg, bg, dim) {
    const env = this.envSpec;
    if (env.assistantFg === -2 && /^●\s+/.test(t) && !/^●\s+\w+\s*\(/.test(t) && bg === -1 && fg !== 6) env.assistantFg = fg;
    if (env.humanBg === -2 && /^❯\s+/.test(t) && bg !== -1) env.humanBg = bg;
    if (env.toolOutFg === -2 && /^⎿/.test(t)) env.toolOutFg = fg;
    if (env.statusFg === -2 && !!dim && /Sonnet|Opus|Haiku|Claude/.test(t) && bg === -1) env.statusFg = fg;
    if (env.thinkingFg === -2 && /^[·•✢✻✶✽*]\s/.test(t) && bg === -1 && !/\s+for\s+[\d]/.test(t)) env.thinkingFg = fg;
  }

  _findDialogRanges(rows, CC) {
    const ranges = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.fg !== 153 || !/^❯\s+\d+\./.test(r.text.trim())) continue;
      let start = i, end = i;
      for (let j = i - 1; j >= Math.max(0, i - 12); j--) {
        const rj = rows[j], tj = rj.text.trim();
        if (!tj) continue;
        if (rj.fg === 174) break;
        if (PERM_MODE_RE.test(tj)) break;
        if (/^❯/.test(tj) && CC.IS_HUMAN_BG(rj.bg)) break;
        if (MODAL_TAB_FG.has(rj.fg) && MODAL_TAB_KW.test(tj)) break;
        start = j;
        if ((rj.fg === 153 || rj.fg === 220) && /^─+$/.test(tj)) break;
        if (rj.fg === 246 && /^●\s/.test(tj)) break;
        if (rj.bg === 153) break;
      }
      for (let j = i + 1; j < Math.min(rows.length, i + 15); j++) {
        const rj = rows[j], tj = rj.text.trim();
        if (!tj) continue;
        if (/^❯/.test(tj) && CC.IS_HUMAN_BG(rj.bg)) break;
        if (rj.fg === 174) break;
        end = j;
        if (/Enter\s+to\s+\w+|Esc\s+to\s+cancel/i.test(tj)) break;
      }
      ranges.push({ start, end });
      i = end;
    }
    return ranges;
  }

  // scrollbackLen: rows 배열 중 처음 N개는 스크롤백 (과거), 그 이후는 viewport (현재)
  // 각 turn에 live 플래그(viewport에서 유래 = "지금 화면에 떠 있는 상태") 표시
  parse(rows, cursorLine = -1, scrollbackLen = 0) {
    const CC = this._CC();
    const env = this.envSpec;
    const turns = [];
    let cur = null;
    const processedIdx = new Set();
    let modalOpen = env.modalOpen || false;
    const dialogRanges = this._findDialogRanges(rows, CC);

    const flush = () => {
      if (cur) {
        cur.body = cur.body.replace(/\n{3,}/g, '\n\n').trimEnd();
        if (cur.body.trim()) turns.push(cur);
      }
      cur = null;
    };
    const push   = (type, idx) => {
      flush();
      cur = { type, body: '', live: idx !== undefined && idx >= scrollbackLen };
      if (idx !== undefined) processedIdx.add(idx);
    };
    const append = (text, idx) => {
      if (cur) {
        cur.body += (cur.body ? '\n' : '') + text;
        if (idx !== undefined) {
          processedIdx.add(idx);
          if (idx >= scrollbackLen) cur.live = true;
        }
      }
    };
    const ignore = idx => processedIdx.add(idx);

    rows.forEach((row, idx) => {
      const { text, fg, bg, dim } = row;
      const t = text.trim();
      if (!t) { if (cur) cur.body += '\n'; return; }

      this._learn(t, fg, bg, dim);

      const skip = () => { ignore(idx); };

      if (CC.TMUX(fg, bg)) { skip(); return; }
      // OSC 누출 텍스트(]N;... 형태) 무시 — 파서가 놓친 색 query 등
      if (/^\][0-9]+;/.test(t)) { skip(); return; }
      // splash 블록은 항상 먼저 skip (status 잘못 매치 방지)
      if (/^[▐▛▜▌▝▘▗▙█]/.test(t)) { skip(); return; }
      // Statusline 감지 — dim 속성 의존 없이 텍스트 패턴으로 (보수적)
      // 1) 줄 시작이 "Model X.Y" (예: "Opus 4.7 ...")
      // 2) 또는 모델명 + pipe + (ctx:/left/tok/[branch]) 조합
      const isStatusByText =
        /^(Opus|Sonnet|Haiku|Claude)\s+[\d.]/.test(t) ||
        (/\b(Opus|Sonnet|Haiku|Claude)\b/.test(t) && /\|/.test(t) && /\bctx:|\bleft\b|\btok\b|\[main\]|\[master\]|\[\w+\]/.test(t));
      if (CC.IS_STATUS(fg, dim) || isStatusByText) {
        push('status', idx);
        // 같은 row에 다른 텍스트가 부착된 경우(예: tmux 경고)는 큰 공백 갭에서 자름
        const cleaned = t.replace(/\s{10,}.*$/, '');
        const parts = cleaned.split('|').map(p => p.trim());
        append(parts.join('  ·  '), idx);
        return;
      }
      if (/^\[view-/.test(t) || /^[─━╌]{2}\d/.test(t)) { skip(); return; }
      if (/^[─━═]+$/.test(t) || /^[─━]{2,}.*[─━]{2,}$/.test(t)) { skip(); return; }
      if (/^[▐▛▜▌▝▘▗▙]/.test(t)) { skip(); return; }
      if (!!dim && /^\d+\s/.test(t)) { skip(); return; }
      if (/^\d+\s*$/.test(t)) { skip(); return; }

      if (/^[※]\s*recap:/i.test(t)) { push('recap', idx); append(t.replace(/^[※]\s*recap:\s*/i, ''), idx); return; }
      if (cur?.type === 'recap' && !/^[●⎿✻✢·•✶✽*❯⏵※←]/.test(t)) { append(t, idx); return; }

      const isBoldRow = (row.bold === true) || (typeof row.bold === 'number' && row.bold !== 0);
      if (MODAL_TAB_FG.has(fg) && isBoldRow && MODAL_TAB_KW.test(t)) {
        modalOpen = true;
        if (cur?.type !== 'config') push('config', idx); append(t, idx); return;
      }
      if (modalOpen) {
        if (/^❯/.test(t) && CC.IS_HUMAN_BG(bg))      { modalOpen = false; }
        else if (/^⎿\s+.*dismissed/i.test(t))         { modalOpen = false; }
        else {
          // 셀별 attr 기반 정제 — leftover conversation cells 제거
          const clean = cleanModalRowFromCells(row.cells);
          if (cur?.type !== 'config') push('config', idx);
          append(clean || t, idx);
          return;
        }
      }

      if (dialogRanges.some(r => idx >= r.start && idx <= r.end)) {
        if (cur?.type !== 'dialog') push('dialog', idx);
        append(t, idx); return;
      }

      if (PERM_MODE_RE.test(t)) {
        if (cur?.type !== 'status') push('status', idx);
        append(t, idx); return;
      }

      if (/^\d+\s+tasks?\s+\(\d+\s+done,\s+\d+\s+open\)/i.test(t)) {
        if (cur?.type !== 'todo_list') push('todo_list', idx);
        append(t, idx); return;
      }
      if (/^[◻◼☐☑✓⎕☒▢▣]\s/.test(t)) {
        if (cur?.type !== 'todo_list') push('todo_list', idx);
        append(t, idx); return;
      }

      if (fg === 153 && bg === -1 && /^Tool\s+use\b/.test(t)) {
        if (cur?.type !== 'permission') push('permission', idx); append(t, idx); return;
      }
      if (/^↓\s+\d+\s+more\s+below/.test(t)) { if (cur?.type === 'config') { append(t, idx); return; } ignore(idx); return; }
      if (/^←\s+\w+:/.test(t)) { push('mcp', idx); append(t.replace(/^←\s+\w+:\s*/, ''), idx); return; }
      if (/^Called\s+\w/.test(t)) { push('mcp', idx); append(t, idx); return; }

      if (/^✻\s+\w.*\s+for\s+[\d]/.test(t)) { push('timing', idx); append(t.replace(/^✻\s*/, ''), idx); return; }

      const isBullet = /^[·•✢✻✶✽*](?:\s|$)/.test(t);
      const isTiming = /\s+for\s+[\d]/.test(t);
      if (isBullet && !isTiming) {
        if (fg === 147 || fg === 105) { push('compacting', idx); append(t, idx); return; }
        const isThinkingFg = env.thinkingFg === -2 ? (fg === 174 || fg === 131) : fg === env.thinkingFg;
        if (isThinkingFg || fg === 174 || fg === 131) { if (cur?.type !== 'thinking') push('thinking', idx); append(t, idx); return; }
      }

      if (/^⎿\s+Tip:/i.test(t)) {
        if (cur?.type !== 'tip') push('tip', idx);
        append(t.replace(/^⎿\s*/, ''), idx); return;
      }
      if (cur?.type === 'tip' && fg === 246 && bg === -1) { append(t, idx); return; }

      if (/^⎿/.test(t)) { if (cur?.type !== 'tool_out') push('tool_out', idx); append(t.replace(/^⎿\s*/, ''), idx); return; }
      if (/^…\s+\+\d+\s+lines/.test(t)) { if (cur?.type !== 'tool_out') push('tool_out', idx); append(t, idx); return; }
      if (/^(Reading|Searching for|Searched for|Read|Listed|Listing|Calling)\s+\d/.test(t)) {
        if (cur?.type !== 'tool_out') push('tool_out', idx); append(t, idx); return;
      }

      if (/^●\s+\w[\w/~.-]*\s*\(/.test(t)) { push('tool_call', idx); append(t.replace(/^●\s*/, ''), idx); return; }
      if (isBoldRow && bg === -1 && /^[\w-]+\s*\(/.test(t)) {
        if (cur?.type !== 'tool_call') push('tool_call', idx); append(t, idx); return;
      }
      if (isBoldRow && fg === -1 && /^●\s+\w+\s*$/.test(t)) {
        if (cur?.type !== 'status') push('status', idx); append(t, idx); return;
      }
      if (/^◯\s+\w/.test(t)) {
        if (cur?.type !== 'status') push('status', idx); append(t, idx); return;
      }

      if (/^●\s+/.test(t) && fg === 6) { push('session_eval', idx); append(t.replace(/^●\s*/, ''), idx); return; }
      if (/^●\s+/.test(t)) { if (cur?.type !== 'assistant') push('assistant', idx); append(t.replace(/^●\s*/, ''), idx); return; }
      if (/^⏵/.test(t)) { push('permission', idx); append(t, idx); return; }

      if (/^❯/.test(t)) {
        const body = t.replace(/^❯\s*/, '').trim();
        if (cursorLine >= 0 && Math.abs(idx - cursorLine) <= 1) { ignore(idx); return; }
        if (row.hasDimCell) { ignore(idx); return; }
        if (/^[▐▛▜▌▝▘▗▙]/.test(body)) { ignore(idx); return; }
        if (/^\]\d+;/.test(body)) { ignore(idx); return; } // OSC 누출
        // 슬래시 명령은 cmdline (human bg여도 우선) — 일반 메시지와 구분
        if (/^\//.test(body)) {
          if (body) { push('cmdline', idx); append(body, idx); } else ignore(idx);
          return;
        }
        if (CC.IS_HUMAN_BG(bg)) {
          if (body) { push('human', idx); append(body, idx); } else ignore(idx);
        } else {
          if (body) { push('cmdline', idx); append(body, idx); } else ignore(idx);
        }
        return;
      }

      if (CC.IS_HUMAN_BG(bg) && bg !== -1) {
        if (cur?.type === 'human') append(t, idx); else { push('human', idx); append(t, idx); }
        return;
      }

      if (CC.DIFF_ADD(fg, bg)) { if (cur?.type !== 'diff') push('diff', idx); append(t, idx); return; }

      const isBold = isBoldRow;
      if ((CC.IS_ASSISTANT(fg) || (fg === -1 && isBold)) && bg === -1) {
        if (cur?.type !== 'assistant') push('assistant', idx);
        append(t, idx); return;
      }
      if (CC.IS_TOOL_OUT(fg, dim)) {
        if (cur?.type !== 'tool_out') push('tool_out', idx);
        append(t.replace(/^⎿\s*/, ''), idx); return;
      }

      if (!cur) push('assistant', idx);
      append(text, idx);
    });
    flush();
    env.modalOpen = modalOpen;

    // 여러 live status가 있으면 = Claude가 viewport를 partial redraw하면서 옛 frame들이 stale로 남은 상태.
    // 첫 status 이전까지만(= 현재 frame의 새 메시지+응답) 유지하고, 마지막 status를 부착해서 redraw artifacts 제거.
    const liveStatusPositions = [];
    for (let i = 0; i < turns.length; i++) {
      if (turns[i].live && turns[i].type === 'status') liveStatusPositions.push(i);
    }

    let baseFilter;
    if (liveStatusPositions.length > 1) {
      // 다중 live status = Claude가 viewport에 새 frame을 그리면서 옛 frame들이 stale로 남음.
      // Claude TUI는 한 frame당 statusline 하나라서, 여러 개 보이면 무조건 redraw 잔재.
      // 첫 status 이전(= 가장 최신 frame의 본문)만 유지하고, 마지막 status로 마무리.
      const firstPos = liveStatusPositions[0];
      const lastPos = liveStatusPositions[liveStatusPositions.length - 1];
      baseFilter = turns.slice(0, firstPos);
      baseFilter.push(turns[lastPos]);
    } else {
      // 정상 — status는 한 개로 dedup
      const nonStatus = [];
      let lastStatus = null;
      for (const t of turns) {
        if (t.type === 'status') { lastStatus = t; continue; }
        nonStatus.push(t);
      }
      if (lastStatus) nonStatus.push(lastStatus);
      baseFilter = nonStatus;
    }

    // 인접 중복 합치기 (timing 등)
    const deduped = [];
    for (const t of baseFilter) {
      const prev = deduped[deduped.length - 1];
      if (prev && prev.type === t.type && t.type === 'timing' && prev.body === t.body) continue;
      deduped.push(t);
    }

    // 강력한 다이얼로그 텍스트 마커 — 옛 cells 위에 partial 덮어쓰기로 ❯ 옵션이 깨진 케이스 보조 감지
    const STRONG_DIALOG_SIGNAL = /Do you want to proceed\?|Esc to cancel · Tab to amend|Enter to select/;
    let dialogActive = false;
    let dialogBody = '';
    for (let i = scrollbackLen; i < rows.length; i++) {
      const tx = rows[i].text.trim();
      if (STRONG_DIALOG_SIGNAL.test(tx)) {
        dialogActive = true;
      }
      if (dialogActive) {
        if (rows[i].fg === 153 || /Bash command|Tool use|Do you want to proceed\?|Yes|No|Esc to cancel/.test(tx)) {
          // 셀별 attr 기반 정제
          const clean = cleanModalRowFromCells(rows[i].cells);
          if (clean) dialogBody += (dialogBody ? '\n' : '') + clean;
        }
      }
    }

    // dialog 활성인데 분류기가 못 잡았으면 synthetic dialog turn 주입
    if (dialogActive && !deduped.some(t => t.type === 'dialog' && t.live)) {
      deduped.push({
        type: 'dialog',
        body: dialogBody || '(다이얼로그 활성 — 화면 corruption으로 정확한 내용 표시 어려움)',
        live: true,
      });
    }

    // 모달/다이얼로그가 live 상태일 때, viewport에서 모달과 무관한 turn은 corruption 노이즈로 간주하고 숨김
    const MODAL_LIVE_TYPES = new Set(['config', 'dialog', 'permission', 'session_eval', 'todo_list']);
    const hasLiveModal = deduped.some(t => t.live && MODAL_LIVE_TYPES.has(t.type));
    const finalTurns = hasLiveModal
      ? deduped.filter(t => !t.live || MODAL_LIVE_TYPES.has(t.type) || t.type === 'status')
      : deduped;

    // unparsed: 흥미로운 미분류 라인 (디버그용)
    const unparsed = rows
      .filter((r, i) => !processedIdx.has(i) && r.text.trim().length > 1 && !/^[─━═╭╰│✳]+$/.test(r.text.trim()))
      .map(r => r.text.trim().slice(0, 200))
      .filter((v, i, a) => a.indexOf(v) === i);

    return { turns: finalTurns, unparsed };
  }
}

module.exports = { Parser };
