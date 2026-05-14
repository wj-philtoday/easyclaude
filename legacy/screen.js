'use strict';
// 가상 스크린 버퍼: cells × rows + scrollback.
// xterm.js의 buffer.active.getCell()이 주던 것과 동일한 정보를 셀 단위로 보관.

const PALETTE = 33554432; // 256-color palette mode flag
const RGB     = 67108864; // truecolor mode flag

function defaultAttrs() {
  return {
    fg: -1, bg: -1, fgM: 0, bgM: 0,
    bold: 0, dim: 0, italic: 0, underline: 0,
    blink: 0, inverse: 0, invisible: 0, strike: 0, overline: 0,
  };
}

function emptyCell(attrs) {
  return { char: ' ', ...attrs };
}

class Screen {
  constructor(cols = 220, rows = 50) {
    this.cols = cols;
    this.rows = rows;
    this.cursor = { row: 0, col: 0 };
    this.savedCursor = null;
    this.attrs = defaultAttrs();
    this.scrollback = []; // 이전에 viewport 위로 밀려난 라인들
    this.scrollbackLimit = 100000;
    this.viewport = [];
    this._initViewport();
    this.alt = null;       // alt screen 상태 (모달 등에서 사용)
    this.dirty = false;
  }

  // ── Alt screen (1049/47/1047) ─────────────────────────────────────────
  // 모달·full-screen TUI 진입 시 main viewport를 보존하고 별도 viewport 사용
  enterAltScreen() {
    if (this.alt) return;
    this.alt = {
      viewport: this.viewport,
      cursor: { ...this.cursor },
      attrs: { ...this.attrs },
      savedCursor: this.savedCursor,
    };
    this.viewport = [];
    for (let r = 0; r < this.rows; r++) this.viewport.push(this._emptyLine());
    this.cursor = { row: 0, col: 0 };
    this.savedCursor = null;
    this.dirty = true;
  }
  exitAltScreen() {
    if (!this.alt) return;
    this.viewport = this.alt.viewport;
    this.cursor = this.alt.cursor;
    this.attrs = this.alt.attrs;
    this.savedCursor = this.alt.savedCursor;
    this.alt = null;
    this.dirty = true;
  }

  _initViewport() {
    this.viewport = [];
    for (let r = 0; r < this.rows; r++) this.viewport.push(this._emptyLine());
  }

  _emptyLine() {
    const line = new Array(this.cols);
    for (let c = 0; c < this.cols; c++) line[c] = emptyCell(defaultAttrs());
    return line;
  }

  resize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return;
    // 단순 처리: 컬럼은 trim/pad, 행은 trim/pad
    if (cols !== this.cols) {
      const trimOrPad = line => {
        if (cols <= line.length) return line.slice(0, cols);
        const ext = line.slice();
        while (ext.length < cols) ext.push(emptyCell(defaultAttrs()));
        return ext;
      };
      this.viewport = this.viewport.map(trimOrPad);
      this.scrollback = this.scrollback.map(trimOrPad);
    }
    this.cols = cols;
    if (rows !== this.rows) {
      if (rows < this.viewport.length) {
        const evict = this.viewport.length - rows;
        for (let i = 0; i < evict; i++) {
          this.scrollback.push(this.viewport.shift());
        }
      } else {
        for (let i = this.viewport.length; i < rows; i++) this.viewport.push(this._emptyLine());
      }
    }
    this.rows = rows;
    this.cursor.row = Math.min(this.cursor.row, rows - 1);
    this.cursor.col = Math.min(this.cursor.col, cols - 1);
    this._trimScrollback();
    this.dirty = true;
  }

  _trimScrollback() {
    while (this.scrollback.length > this.scrollbackLimit) this.scrollback.shift();
  }

  // ── text input ────────────────────────────
  writeChar(ch) {
    if (this.cursor.col >= this.cols) {
      this._lineFeed();
      this.cursor.col = 0;
    }
    const cell = { char: ch, ...this.attrs };
    this.viewport[this.cursor.row][this.cursor.col] = cell;
    this.cursor.col++;
    this.dirty = true;
  }

  writeText(text) {
    // 한글 등 멀티바이트는 1 width로 처리 (단순화)
    for (const ch of text) this.writeChar(ch);
  }

  cr() { this.cursor.col = 0; this.dirty = true; }
  lf() { this._lineFeed(); this.dirty = true; }
  bs() { if (this.cursor.col > 0) this.cursor.col--; this.dirty = true; }
  tab() { this.cursor.col = Math.min(this.cols - 1, ((this.cursor.col >> 3) + 1) << 3); this.dirty = true; }

  _lineFeed() {
    this.cursor.row++;
    if (this.cursor.row >= this.rows) {
      this._scrollUp(1);
      this.cursor.row = this.rows - 1;
    }
  }

  _scrollUp(n) {
    for (let i = 0; i < n; i++) {
      const evicted = this.viewport.shift();
      if (!this.alt) this.scrollback.push(evicted); // alt screen 중에는 main scrollback 보호
      this.viewport.push(this._emptyLine());
    }
    this._trimScrollback();
  }

  _scrollDown(n) {
    for (let i = 0; i < n; i++) {
      this.viewport.unshift(this._emptyLine());
      this.viewport.pop();
    }
  }

  // ── CSI ───────────────────────────────────
  csi(final, params, isPrivate, inter) {
    const def = (i, d) => (params[i] == null ? d : params[i]);
    switch (final) {
      case 'A': this.cursor.row = Math.max(0, this.cursor.row - def(0, 1)); break;
      case 'B': case 'e': this.cursor.row = Math.min(this.rows - 1, this.cursor.row + def(0, 1)); break;
      case 'C': case 'a': this.cursor.col = Math.min(this.cols - 1, this.cursor.col + def(0, 1)); break;
      case 'D': this.cursor.col = Math.max(0, this.cursor.col - def(0, 1)); break;
      case 'E': this.cursor.row = Math.min(this.rows - 1, this.cursor.row + def(0, 1)); this.cursor.col = 0; break;
      case 'F': this.cursor.row = Math.max(0, this.cursor.row - def(0, 1)); this.cursor.col = 0; break;
      case 'G': case '`': this.cursor.col = Math.max(0, Math.min(this.cols - 1, def(0, 1) - 1)); break;
      case 'H': case 'f':
        this.cursor.row = Math.max(0, Math.min(this.rows - 1, def(0, 1) - 1));
        this.cursor.col = Math.max(0, Math.min(this.cols - 1, def(1, 1) - 1));
        break;
      case 'd': this.cursor.row = Math.max(0, Math.min(this.rows - 1, def(0, 1) - 1)); break;
      case 'J': this._eraseDisplay(def(0, 0)); break;
      case 'K': this._eraseLine(def(0, 0)); break;
      case 'L': this._insertLines(def(0, 1)); break;
      case 'M': this._deleteLines(def(0, 1)); break;
      case 'P': this._deleteChars(def(0, 1)); break;
      case 'X': this._eraseChars(def(0, 1)); break;
      case 'S': this._scrollUp(def(0, 1)); break;
      case 'T': this._scrollDown(def(0, 1)); break;
      case 'm': this._sgr(params); break;
      case 's': this.savedCursor = { row: this.cursor.row, col: this.cursor.col, attrs: { ...this.attrs } }; break;
      case 'u': if (this.savedCursor) { this.cursor.row = this.savedCursor.row; this.cursor.col = this.savedCursor.col; this.attrs = { ...this.savedCursor.attrs }; } break;
      case 'h': case 'l':
        // DEC private modes: 1049/47/1047 = alt screen 진입/종료
        if (isPrivate) {
          if (process.env.EASYCLAUDE_DEBUG) console.log(`[screen] DEC ${final} params=${JSON.stringify(params)}`);
          for (const code of params) {
            if (code === 1049 || code === 47 || code === 1047) {
              if (final === 'h') this.enterAltScreen();
              else this.exitAltScreen();
            }
          }
        }
        break;
    }
    this.dirty = true;
  }

  _eraseLine(mode) {
    const line = this.viewport[this.cursor.row];
    const blank = () => emptyCell(this.attrs);
    if (mode === 0)      for (let c = this.cursor.col; c < this.cols; c++) line[c] = blank();
    else if (mode === 1) for (let c = 0; c <= this.cursor.col; c++)         line[c] = blank();
    else if (mode === 2) for (let c = 0; c < this.cols; c++)                 line[c] = blank();
  }

  _eraseDisplay(mode) {
    const blank = () => emptyCell(this.attrs);
    if (mode === 0) {
      this._eraseLine(0);
      for (let r = this.cursor.row + 1; r < this.rows; r++) {
        const line = this.viewport[r];
        for (let c = 0; c < this.cols; c++) line[c] = blank();
      }
    } else if (mode === 1) {
      this._eraseLine(1);
      for (let r = 0; r < this.cursor.row; r++) {
        const line = this.viewport[r];
        for (let c = 0; c < this.cols; c++) line[c] = blank();
      }
    } else if (mode === 2 || mode === 3) {
      for (const line of this.viewport) for (let c = 0; c < this.cols; c++) line[c] = blank();
      if (mode === 3) this.scrollback = [];
    }
  }

  _insertLines(n) {
    for (let i = 0; i < n; i++) {
      this.viewport.splice(this.cursor.row, 0, this._emptyLine());
      if (this.viewport.length > this.rows) this.viewport.pop();
    }
  }
  _deleteLines(n) {
    for (let i = 0; i < n; i++) {
      this.viewport.splice(this.cursor.row, 1);
      if (this.viewport.length < this.rows) this.viewport.push(this._emptyLine());
    }
  }
  _deleteChars(n) {
    const line = this.viewport[this.cursor.row];
    for (let i = 0; i < n; i++) {
      line.splice(this.cursor.col, 1);
      line.push(emptyCell(this.attrs));
    }
  }
  _eraseChars(n) {
    const line = this.viewport[this.cursor.row];
    for (let i = 0; i < n; i++) {
      const c = this.cursor.col + i;
      if (c < this.cols) line[c] = emptyCell(this.attrs);
    }
  }

  _sgr(params) {
    if (params.length === 0) { this.attrs = defaultAttrs(); return; }
    let i = 0;
    while (i < params.length) {
      const p = params[i];
      switch (p) {
        case 0: case null: this.attrs = defaultAttrs(); break;
        case 1: this.attrs.bold = 1; break;
        case 2: this.attrs.dim = 1; break;
        case 3: this.attrs.italic = 1; break;
        case 4: this.attrs.underline = 1; break;
        case 5: case 6: this.attrs.blink = 1; break;
        case 7: this.attrs.inverse = 1; break;
        case 8: this.attrs.invisible = 1; break;
        case 9: this.attrs.strike = 1; break;
        case 21: this.attrs.bold = 0; break; // double underline 처리 생략
        case 22: this.attrs.bold = 0; this.attrs.dim = 0; break;
        case 23: this.attrs.italic = 0; break;
        case 24: this.attrs.underline = 0; break;
        case 25: this.attrs.blink = 0; break;
        case 27: this.attrs.inverse = 0; break;
        case 28: this.attrs.invisible = 0; break;
        case 29: this.attrs.strike = 0; break;
        case 38: {
          const sub = params[i+1];
          if (sub === 5)      { this.attrs.fg = params[i+2] ?? 0; this.attrs.fgM = PALETTE; i += 2; }
          else if (sub === 2) { this.attrs.fg = ((params[i+2]||0)<<16)|((params[i+3]||0)<<8)|(params[i+4]||0); this.attrs.fgM = RGB; i += 4; }
          break;
        }
        case 39: this.attrs.fg = -1; this.attrs.fgM = 0; break;
        case 48: {
          const sub = params[i+1];
          if (sub === 5)      { this.attrs.bg = params[i+2] ?? 0; this.attrs.bgM = PALETTE; i += 2; }
          else if (sub === 2) { this.attrs.bg = ((params[i+2]||0)<<16)|((params[i+3]||0)<<8)|(params[i+4]||0); this.attrs.bgM = RGB; i += 4; }
          break;
        }
        case 49: this.attrs.bg = -1; this.attrs.bgM = 0; break;
        case 53: this.attrs.overline = 1; break;
        case 55: this.attrs.overline = 0; break;
        default:
          if (p >= 30 && p <= 37)        { this.attrs.fg = p - 30;       this.attrs.fgM = PALETTE; }
          else if (p >= 40 && p <= 47)   { this.attrs.bg = p - 40;       this.attrs.bgM = PALETTE; }
          else if (p >= 90 && p <= 97)   { this.attrs.fg = p - 90 + 8;   this.attrs.fgM = PALETTE; }
          else if (p >= 100 && p <= 107) { this.attrs.bg = p - 100 + 8;  this.attrs.bgM = PALETTE; }
          break;
      }
      i++;
    }
  }

  esc(ch) {
    switch (ch) {
      case '7': this.savedCursor = { row: this.cursor.row, col: this.cursor.col, attrs: { ...this.attrs } }; break;
      case '8': if (this.savedCursor) { this.cursor.row = this.savedCursor.row; this.cursor.col = this.savedCursor.col; this.attrs = { ...this.savedCursor.attrs }; } break;
      case 'D': this._lineFeed(); break;
      case 'E': this.cursor.col = 0; this._lineFeed(); break;
      case 'M': if (this.cursor.row > 0) this.cursor.row--; else this._scrollDown(1); break;
      case 'c': this._eraseDisplay(2); this.cursor = { row: 0, col: 0 }; this.attrs = defaultAttrs(); break;
    }
    this.dirty = true;
  }

  control(code) {
    switch (code) {
      case 0x07: break; // BEL
      case 0x08: this.bs(); break;
      case 0x09: this.tab(); break;
      case 0x0a: case 0x0b: case 0x0c: this.lf(); break;
      case 0x0d: this.cr(); break;
    }
  }

  // ── snapshot ─────────────────────────────
  // 클래시파이어가 사용할 row 배열 반환 (scrollback + viewport)
  snapshot() {
    const all = [...this.scrollback, ...this.viewport];
    return all.map(line => {
      const text = line.map(c => c.char).join('').replace(/\s+$/, '');
      // 첫 비공백 셀 attrs (기존 client 파서가 기대하는 형식)
      let fg = -1, bg = -1, dim = 0, bold = 0;
      let firstCell = null;
      for (const c of line) {
        if (c.char.trim()) { firstCell = c; fg = c.fg; bg = c.bg; dim = c.dim; bold = c.bold; break; }
      }
      // dim cell 포함 여부 (suggestion 감지용)
      let hasDimCell = false;
      if (text.trimStart().startsWith('❯') && fg === -1 && bg === -1) {
        for (let i = 1; i < line.length; i++) {
          if (line[i].char.trim() && line[i].dim) { hasDimCell = true; break; }
        }
      }
      return { text, fg, bg, dim, bold, hasDimCell, cells: line };
    });
  }

  cursorAbsRow() { return this.scrollback.length + this.cursor.row; }
}

module.exports = { Screen, defaultAttrs };
