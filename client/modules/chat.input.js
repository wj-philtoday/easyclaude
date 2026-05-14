// ============================================================
// chat.input — 입력바
//   텍스트 입력/전송, 슬래시 자동완성, interrupt
// ============================================================

chat.input = chat.input || {};
chat.input.dom = chat.input.dom || {};
chat.input.autocomplete = chat.input.autocomplete || {};
chat.input.slash = chat.input.slash || {};

(function init() {
  const $ = core.system.dom.$;
  chat.input.dom.textarea  = $('ec-input');
  chat.input.dom.send      = $('ec-send-btn');
  chat.input.dom.interrupt = $('ec-interrupt-btn');
  chat.input.dom.ac        = $('ec-autocomplete');
})();

chat.input.activeChannel = function() { return activeSid ? channels.get(activeSid) : null; };
window.activeChannel = chat.input.activeChannel;

chat.input.send = function() {
  const val = $input.value;
  if (!val || !val.trim()) return;
  const ch = chat.input.activeChannel();
  if (!ch) return;
  const slashM = val.trim().match(/^(\/\w+)\b/);
  if (slashM) {
    const def = SLASH_CMDS.find(c => c.cmd === slashM[1]);
    if (def && def.kind === 'ec') {
      chat.input.slash.run(def.cmd, ch);
      $input.value = '';
      chat.input.autosize();
      chat.input.autocomplete.hide();
      return;
    }
  }
  const draftKey = 'ec-draft-' + ch.sessionId;
  localStorage.setItem(draftKey, val);
  core.system.ws.send({ op:'input', id: ch.id, data: val });
  ch.pendingInputs = ch.pendingInputs || [];
  const isSlashCmd = /^\/\w/.test(val.trim());
  const isBashCmd  = /^!\s/.test(val.trim());
  const kind = isSlashCmd ? 'slash' : isBashCmd ? 'bash' : null;
  ch.pendingInputs.push({ text: val, kind, sentAt: Date.now(), draftKey });
  $input.value = '';
  chat.input.autosize();
  chat.input.autocomplete.hide();
  if (ch.sessionId === activeSid) chat.message.render();
  requestAnimationFrame(() => $input.focus());
};
window.sendInput = chat.input.send;

chat.input.autosize = function() {
  chat.message.scroll.updateBtnPos();
};
window.autosize = chat.input.autosize;

// ─── autocomplete ──────────────────────────────────────
chat.input.autocomplete.update = function() {
  const v = $input.value;
  if (!v.startsWith('/')) { chat.input.autocomplete.hide(); return; }
  const q = v.toLowerCase();
  const matches = SLASH_CMDS.filter(c => c.cmd.startsWith(q));
  if (!matches.length) { chat.input.autocomplete.hide(); return; }
  state.ui.ac.idx = -1;
  window.acIdx = state.ui.ac.idx;
  $ac.innerHTML = matches.map((c, i) =>
    `<div class="ec-ac-item" data-i="${i}">
       <span class="ec-ac-cmd">${core.system.format.esc(c.cmd)}</span>
       <span class="ec-ac-desc">${core.system.format.esc(c.desc)}</span>
     </div>`).join('');
  $ac.querySelectorAll('.ec-ac-item').forEach((el, i) => {
    el.addEventListener('pointerdown', e => { e.preventDefault(); chat.input.autocomplete.fill(i, matches); });
  });
  $ac.classList.remove('ec-hidden');
  $ac._matches = matches;
};
chat.input.autocomplete.move = function(dir) {
  const items = $ac.querySelectorAll('.ec-ac-item');
  if (!items.length) return;
  items[state.ui.ac.idx]?.classList.remove('selected');
  state.ui.ac.idx = Math.max(-1, Math.min(items.length - 1, state.ui.ac.idx + dir));
  window.acIdx = state.ui.ac.idx;
  items[state.ui.ac.idx]?.classList.add('selected');
};
chat.input.autocomplete.fill = function(i, matches) {
  matches = matches || $ac._matches || [];
  if (!matches[i]) return;
  $input.value = matches[i].cmd + ' ';
  chat.input.autocomplete.hide();
  $input.focus();
};
chat.input.autocomplete.hide = function() {
  state.ui.ac.idx = -1;
  window.acIdx = -1;
  $ac.classList.add('ec-hidden');
  $ac.innerHTML = '';
};
window.updateAc = chat.input.autocomplete.update;
window.moveAc   = chat.input.autocomplete.move;
window.fillAc   = chat.input.autocomplete.fill;
window.hideAc   = chat.input.autocomplete.hide;

// ─── slash ─────────────────────────────────────────────
chat.input.slash.run = async function(cmd, ch) {
  const name = cmd.replace(/^\//, '');
  if (name === 'config') {
    document.getElementById('ec-settings-btn')?.click();
    return;
  }
  const sid = ch && ch.sessionId ? ch.sessionId : '';
  try {
    const r = await fetch(core.system.api.base() + `api/slash/${name}?sid=${encodeURIComponent(sid)}`);
    const data = await r.json();
    chat.input.slash.showResult(cmd, data);
  } catch (e) {
    chat.input.slash.showResult(cmd, { error: e.message });
  }
};
chat.input.slash.showResult = function(cmd, data) {
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
};
window.runEcSlash = chat.input.slash.run;
window.showSlashResult = chat.input.slash.showResult;

// app.js 글로벌 호환
window.acIdx = -1;
window.claudeOptions = window.claudeOptions || { efforts: [], permissionModes: [], models: [] };
