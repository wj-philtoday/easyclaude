// ============================================================
// modal.chat — 채팅창 종속 모달
//   세션 정보 모달(ⓘ; MCP/플러그인/스킬 편집 포함),
//   권한 변경, 모델 변경, Claude permission/AskUserQuestion dialog
// ============================================================

modal.chat = modal.chat || {};
modal.chat.dom = modal.chat.dom || {};
modal.chat.info = modal.chat.info || {};
modal.chat.info.extension = modal.chat.info.extension || {};
modal.chat.info.controls = modal.chat.info.controls || {};
modal.chat.perm = modal.chat.perm || {};
modal.chat.model = modal.chat.model || {};
modal.chat.dialog = modal.chat.dialog || {};

(function init() {
  const $ = core.system.dom.$;
  // Claude dialog (permission / AskUserQuestion)
  modal.chat.dom.dialog       = $('ec-dialog');
  modal.chat.dom.dialogTitle  = $('ec-dialog-title');
  modal.chat.dom.dialogBody   = $('ec-dialog-body');
  modal.chat.dom.dialogCancel = $('ec-dialog-cancel');
  modal.chat.dom.dialogSubmit = $('ec-dialog-submit');
  modal.chat.dom.dialogClose  = $('ec-dialog-close');
  // info 패널
  modal.chat.dom.infoPanel = $('ec-info');
})();

// info 패널 (세션 정보 모달)
modal.chat.info.SCOPE_LABEL = { user: 'user', project: 'project', local: 'local' };
modal.chat.info.SCOPE_ORDER = ['user', 'project', 'local'];

modal.chat.info.open = function() {
  const $ = core.system.dom.$;
  const esc = core.system.format.esc;
  const fmtNum = chat.info.fmtNum;
  const ch = activeChannel();
  if (!ch) { alert('활성 세션이 없습니다.'); return; }
  const sess = ecSessions.find(s => s.id === ch.sessionId);
  const u = ch.usage || {};
  const s = ch.session || {};
  const ctrl = parseControlsFromArgs(sess?.args);
  state.chat.info.currentArgs = ctrl.raw.slice();
  window._infoCurrentArgs = state.chat.info.currentArgs;

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
          ${(state.system.claudeOptions.models||[]).map(m => `<option value="${esc(m)}" ${m===ctrl.model?'selected':''}>${esc(m)}</option>`).join('')}
        </select>
      </label>
      <label class="ec-field">
        <span>Effort</span>
        <select id="info-effort">
          <option value="default" ${ctrl.effort==='default'?'selected':''}>default</option>
          ${(state.system.claudeOptions.efforts||[]).map(m => `<option value="${esc(m)}" ${m===ctrl.effort?'selected':''}>${esc(m)}</option>`).join('')}
        </select>
      </label>
      <label class="ec-field">
        <span>Permission mode</span>
        <select id="info-perm">
          <option value="default" ${permDisplay==='default'?'selected':''}>default</option>
          ${(state.system.claudeOptions.permissionModes||[]).filter(m=>m!=='default').map(m => {
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
  modal.chat.info.extension.load(ch.sessionId);
};
window.openInfoPanel = modal.chat.info.open;

modal.chat.info.extension.load = async function(sid) {
  const $ = core.system.dom.$;
  const esc = core.system.format.esc;
  const $el = $('ec-ext-list');
  if (!$el) return;
  $el.dataset.sid = sid;
  try {
    const r = await fetch(core.system.api.base() + 'api/scoped/extensions?sid=' + encodeURIComponent(sid));
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
      const rows = modal.chat.info.SCOPE_ORDER.map(scope => {
        const list = byScope[scope] || [];
        const addBtn = `<button type="button" class="ec-btn ec-ext-add" data-kind="${sec.key}" data-scope="${scope}" style="font-size:11px;padding:1px 6px">＋ 추가</button>`;
        const head = `<div class="ec-ext-scope-head"><b>${esc(modal.chat.info.SCOPE_LABEL[scope])}</b> <span class="ec-muted">(${list.length})</span> ${addBtn}</div>`;
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
    $el.querySelectorAll('.ec-ext-toggle').forEach(cb => {
      cb.addEventListener('change', async () => {
        const kind  = cb.dataset.kind;
        const scope = cb.dataset.scope;
        const name  = cb.dataset.name;
        const enabled = cb.checked;
        cb.disabled = true;
        try {
          const r2 = await fetch(core.system.api.base() + 'api/scoped/toggle', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ sid, scope, kind, name, enabled }),
          });
          const data = await r2.json();
          if (!r2.ok || data.error) { alert(data.error || ('HTTP ' + r2.status)); cb.checked = !enabled; }
        } catch (e) { alert('오류: ' + e.message); cb.checked = !enabled; }
        cb.disabled = false;
      });
    });
    $el.querySelectorAll('.ec-ext-add').forEach(b => {
      b.addEventListener('click', () => modal.chat.info.extension.openEdit({ sid, scope: b.dataset.scope, kind: b.dataset.kind, name: '', isNew: true }));
    });
    $el.querySelectorAll('.ec-ext-edit').forEach(b => {
      b.addEventListener('click', () => modal.chat.info.extension.openEdit({ sid, scope: b.dataset.scope, kind: b.dataset.kind, name: b.dataset.name, isNew: false }));
    });
    $el.querySelectorAll('.ec-ext-reconnect').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm(`'${b.dataset.name}' (또는 전체) MCP 재연결을 위해 활성 세션에 /mcp 를 보냅니다. 진행할까요?`)) return;
        b.disabled = true;
        try {
          const r2 = await fetch(core.system.api.base() + `api/sessions/${encodeURIComponent(sid)}/inject`, {
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
};
window.loadAndRenderExtensions = modal.chat.info.extension.load;

modal.chat.info.extension.openEdit = async function({ sid, scope, kind, name, isNew }) {
  const $ = core.system.dom.$;
  $('exe-message').textContent = '';
  $('exe-title').textContent = (isNew ? '새 ' : '편집 — ') + ({mcp:'MCP 서버', plugin:'Plugin', skill:'Skill'}[kind] || kind);
  $('exe-scope').value = scope;
  $('exe-kind').textContent = kind;
  $('exe-name').value = name || '';
  $('exe-name').readOnly = false;
  $('exe-delete').style.display = isNew ? 'none' : '';
  $('exe-mcp').classList.toggle('ec-hidden', kind !== 'mcp');
  $('exe-plugin').classList.toggle('ec-hidden', kind !== 'plugin');
  $('exe-skill').classList.toggle('ec-hidden', kind !== 'skill');
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
  $('ec-ext-edit').dataset.sid = sid;
  $('ec-ext-edit').dataset.oldName = name || '';
  $('ec-ext-edit').dataset.isNew = isNew ? '1' : '0';
  $('ec-ext-edit').classList.remove('ec-hidden');
  if (!isNew && name) {
    try {
      const r = await fetch(core.system.api.base() + `api/scoped/extension/details?sid=${encodeURIComponent(sid)}&scope=${encodeURIComponent(scope)}&kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`);
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
  modal.chat.info.extension.syncMcp();
};
window.openExtEdit = modal.chat.info.extension.openEdit;

modal.chat.info.extension.syncMcp = function() {
  const $ = core.system.dom.$;
  const t = $('exe-mcp-type')?.value;
  if (!t) return;
  const isStdio = t === 'stdio';
  $('exe-mcp-stdio')?.classList.toggle('ec-hidden', !isStdio);
  $('exe-mcp-url')?.classList.toggle('ec-hidden', isStdio);
};
window.syncMcpFormVisibility = modal.chat.info.extension.syncMcp;

modal.chat.info.extension.buildConfig = function(kind) {
  const $ = core.system.dom.$;
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
};
window.buildExtConfigFromForm = modal.chat.info.extension.buildConfig;
modal.chat.info.controls.load = async function() {
  try {
    const r = await fetch(core.system.api.base() + 'api/options');
    if (!r.ok) return;
    state.system.claudeOptions = await r.json();
    window.claudeOptions = state.system.claudeOptions;
  } catch {}
};
window.loadClaudeOptions = modal.chat.info.controls.load;

modal.chat.info.controls.parse = function(args) {
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
};
window.parseControlsFromArgs = modal.chat.info.controls.parse;

modal.chat.info.controls.patch = function(originalArgs, patches) {
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
    if (patches.permissionMode === 'prompt-tool') {
      args.push('--permission-prompt-tool', 'mcp__easypermitter__permission_prompt');
    } else if (patches.permissionMode && patches.permissionMode !== 'default') {
      args.push('--permission-mode', patches.permissionMode);
    }
  }
  return args;
};
window.patchArgs = modal.chat.info.controls.patch;

modal.chat.perm.show = function() {
  const ch = activeChannel();
  if (!ch) return;
  const sess = ecSessions.find(s => s.id === ch.sessionId);
  if (!sess) return;
  const ctrl = parseControlsFromArgs(sess.args);
  const cur = ctrl.permissionMode || 'default';
  const PERMS = [
    { value: 'default',            label: '기본',   desc: '각 도구 사용마다 확인' },
    { value: 'acceptEdits',        label: '편집',   desc: '파일 편집은 자동, 나머지 확인' },
    { value: 'auto',               label: '자동',   desc: '안전한 작업 자동 허용' },
    { value: 'dontAsk',            label: '무묻',   desc: '모든 작업 자동 허용 (위험 낮음)' },
    { value: 'bypassPermissions',  label: '우회',   desc: '모든 권한 우회 (위험)' },
    { value: 'plan',               label: '계획',   desc: '작업 계획만 수립, 실행 안 함' },
  ];
  const frag = document.createElement('div');
  frag.innerHTML = `<div class="ec-perm-list">${PERMS.map(p =>
    `<button class="ec-perm-mode-btn${p.value === cur ? ' active' : ''}" data-perm="${p.value}">
      <span class="ec-perm-mode-label">${p.label}</span>
      <span class="ec-perm-mode-desc">${p.desc}</span>
    </button>`
  ).join('')}</div>
  <p style="font-size:11px;color:var(--muted);margin-top:8px">변경 시 세션이 재기동됩니다.</p>`;
  const { overlay } = modal.core.base.show({ title: '권한 모드 변경', body: frag });
  frag.querySelectorAll('.ec-perm-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.perm;
      if (next === cur) { overlay.remove(); return; }
      const newArgs = patchArgs(sess.args || [], { permissionMode: next });
      core.system.ws.send({ op: 'restart', id: ch.id, args: newArgs });
      overlay.remove();
    });
  });
};
window.showPermModal = modal.chat.perm.show;

modal.chat.model.show = function() {
  const ch = activeChannel();
  if (!ch) return;
  const sess = ecSessions.find(s => s.id === ch.sessionId);
  if (!sess) return;
  const ctrl = parseControlsFromArgs(sess?.args);
  const cur = ctrl.model || '';
  const MODELS = [
    { label: 'Opus 4.7',        value: 'opus' },
    { label: 'Opus 4.7 (1M)',   value: 'claude-opus-4-7' },
    { label: 'Sonnet 4.6',      value: 'sonnet' },
    { label: 'Sonnet 4.6 (1M)', value: 'claude-sonnet-4-6[1M]' },
    { label: 'Haiku 4.5',       value: 'haiku' },
  ];
  const frag = document.createElement('div');
  frag.innerHTML = `<div class="ec-perm-list">${MODELS.map(m =>
    `<button class="ec-perm-mode-btn${cur === m.value ? ' active' : ''}" data-model="${m.value}">
      <span class="ec-perm-mode-label">${m.label}</span>
    </button>`
  ).join('')}</div>
  <p style="font-size:11px;color:var(--muted);margin-top:8px">변경 시 세션이 재기동됩니다.</p>`;
  const { overlay } = modal.core.base.show({ title: '모델 변경', body: frag });
  frag.querySelectorAll('.ec-perm-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const model = btn.dataset.model;
      if (model === cur) { overlay.remove(); return; }
      core.system.ws.send({ op: 'model_toggle', id: ch.id, model });
      overlay.remove();
    });
  });
};
window.showModelModal = modal.chat.model.show;

modal.chat.dialog.show = function(ch) {
  if (!ch.pendingDialog) return;
  const d = ch.pendingDialog;
  state.modal.dialog = { ch, ...d, answers: {} };
  window.currentDialog = state.modal.dialog;
  if (d.kind === 'PermissionPrompt') return modal.chat.dialog.renderPerm(d);
  return modal.chat.dialog.renderAsk(d);
};
window.showDialog = modal.chat.dialog.show;

modal.chat.dialog.renderPerm = function(d) {
  const esc = core.system.format.esc;
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
  $dialogSubmit.textContent = '허용';
  $dialogCancel.textContent = '거부';
  setTimeout(() => $dialogBody.querySelector('#perm-updated')?.focus(), 50);
  $dialog.classList.remove('ec-hidden');
};
window.renderPermissionDialog = modal.chat.dialog.renderPerm;

modal.chat.dialog.renderAsk = function(d) {
  const esc = core.system.format.esc;
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
};
window.renderAskUserQuestionDialog = modal.chat.dialog.renderAsk;

modal.chat.dialog.collectPerm = function(allow) {
  const d = state.modal.dialog;
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
};
window.collectPermissionResponse = modal.chat.dialog.collectPerm;

modal.chat.dialog.hide = function() {
  $dialog.classList.add('ec-hidden');
  state.modal.dialog = null;
  window.currentDialog = null;
};
window.hideDialog = modal.chat.dialog.hide;

modal.chat.dialog.collectAnswers = function() {
  const d = state.modal.dialog;
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
};
window.collectDialogAnswers = modal.chat.dialog.collectAnswers;
