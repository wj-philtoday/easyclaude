'use strict';
// 최소 ANSI 상태 머신 — Claude Code TUI에서 쓰이는 시퀀스 위주.

const S = { NORMAL:0, ESC:1, CSI:2, OSC:3, OSC_ESC:4, DCS:5, DCS_ESC:6 };

class AnsiParser {
  constructor(handler) {
    this.h = handler; // { onText, onControl, onCSI, onOSC, onESC }
    this.state = S.NORMAL;
    this.text = '';
    this.params = '';
    this.intermediates = '';
    this.private = false;
    this.oscBuf = '';
  }

  feed(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk.charCodeAt(i);
      const ch = chunk[i];
      this._step(code, ch);
    }
    this._flushText();
  }

  _flushText() {
    if (this.text) { this.h.onText && this.h.onText(this.text); this.text = ''; }
  }

  _step(code, ch) {
    switch (this.state) {
      case S.NORMAL:
        if (code === 0x1b) {
          this._flushText();
          this.state = S.ESC;
          // 새 ESC 시퀀스 시작 — 이전 CSI/ESC가 남긴 상태 정리
          this.intermediates = '';
          this.params = '';
          this.private = false;
          return;
        }
        if (code < 0x20 || code === 0x7f) {
          this._flushText();
          this.h.onControl && this.h.onControl(code);
          return;
        }
        this.text += ch;
        return;

      case S.ESC:
        // Intermediate bytes (0x20-0x2f): "(", ")", "*", "+", "#", "%", "$", " "
        // 누적해서 다음 final 바이트와 함께 한 시퀀스로 소비 (예: ESC ( B = G0=US ASCII)
        if (code >= 0x20 && code <= 0x2f) {
          this.intermediates = (this.intermediates || '') + ch;
          return;
        }
        // intermediates 누적된 상태에서 final byte (0x30-0x7e)는 designate 시퀀스 종료
        if (this.intermediates) {
          // 무시 (charset/line attributes 등 — Claude TUI에서 시각적 영향 거의 없음)
          this.intermediates = '';
          this.state = S.NORMAL;
          return;
        }
        // intermediates 없이 직접 도착하는 특수 leading bytes
        if (ch === '[') { this.state = S.CSI; this.params = ''; this.intermediates = ''; this.private = false; return; }
        if (ch === ']') { this.state = S.OSC; this.oscBuf = ''; return; }
        if (ch === 'P') { this.state = S.DCS; return; }
        if (ch === 'N' || ch === 'O') { this.state = S.NORMAL; return; } // SS2/SS3 — ignore next
        if (ch === '\\') { this.state = S.NORMAL; return; } // ST after orphan ESC
        // Single-char ESC: 7, 8, c, D, E, M, =, > 등
        this.h.onESC && this.h.onESC(ch);
        this.state = S.NORMAL;
        return;

      case S.CSI:
        if (code >= 0x30 && code <= 0x3f) {
          if (this.params === '' && ch === '?') { this.private = true; return; }
          this.params += ch;
          return;
        }
        if (code >= 0x20 && code <= 0x2f) { this.intermediates += ch; return; }
        if (code >= 0x40 && code <= 0x7e) {
          const parts = this.params === '' ? [] : this.params.split(';');
          const params = parts.map(p => p === '' ? null : parseInt(p, 10));
          this.h.onCSI && this.h.onCSI(ch, params, this.private, this.intermediates);
          this.state = S.NORMAL;
          return;
        }
        this.state = S.NORMAL;
        return;

      case S.OSC:
        if (code === 0x07) { this.h.onOSC && this.h.onOSC(this.oscBuf); this.oscBuf = ''; this.state = S.NORMAL; return; }
        if (code === 0x1b) { this.state = S.OSC_ESC; return; }
        this.oscBuf += ch;
        return;

      case S.OSC_ESC:
        if (ch === '\\') {
          // ST 정상 종료
          this.h.onOSC && this.h.onOSC(this.oscBuf);
          this.oscBuf = '';
          this.state = S.NORMAL;
          return;
        }
        // ESC 뒤가 \\가 아니면 OSC를 강제 종료하고 이 바이트를 새 ESC 시퀀스 시작으로 재처리
        this.h.onOSC && this.h.onOSC(this.oscBuf);
        this.oscBuf = '';
        this.state = S.ESC;
        this._step(code, ch); // 재귀 1회
        return;

      case S.DCS:
        if (code === 0x1b) { this.state = S.DCS_ESC; return; }
        return; // discard

      case S.DCS_ESC:
        this.state = S.NORMAL;
        return;
    }
  }
}

module.exports = { AnsiParser };
