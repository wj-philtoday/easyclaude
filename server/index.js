'use strict';
// easyclaude server — claude를 직접 stream-json 모드로 spawn하는 단일 파이프라인.
// tmux/ANSI 파이프라인은 제거 (ansi.js/screen.js/parser.js 파일은 디버그용으로 디스크에만 보존).

const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { StreamParser } = require('./stream-parser');
const { startWatcher: startInboxWatcher, eventToChannelText, detectAgentIdentity } = require('./inbox-watcher');

// ── auth process tracking (login OAuth 플로우 상태) ─────────────────────────
const authProcs = new Map(); // home → { proc, url, status, output, error, exitCode }

// 세션이 jsonl을 찾아야 할 HOME 후보 — overlay HOME 우선
function homesForSession(sess) {
  const overlayEnabled = !(cfg && cfg.overlay && cfg.overlay.enabled === false);
  const overlayHome = path.join(XDG_DATA_HOME, 'easyclaude', 'overlay');
  return [sess?.home, overlayEnabled ? overlayHome : null, process.env.HOME].filter(Boolean);
}

// jsonl → turns 캐시 (대화창 위 스크롤 history용)
const _jsonlTurnsCache = new Map(); // jsonlPath → { mtime, turns }
function jsonlToTurns(jsonlPath) {
  const stat = fs.statSync(jsonlPath);
  const cached = _jsonlTurnsCache.get(jsonlPath);
  if (cached && cached.mtime === stat.mtimeMs) return cached.turns;
  const parser = new StreamParser({});
  const raw = fs.readFileSync(jsonlPath, 'utf8');
  for (const line of raw.split('\n')) {
    if (line) parser.feedLine(line);
  }
  const turns = parser.snapshot().turns;
  _jsonlTurnsCache.set(jsonlPath, { mtime: stat.mtimeMs, turns });
  return turns;
}

// claude (login / setup-token)는 TTY를 기대 → script(1)로 PTY wrap.
function shellEscapeArg(s) {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_\-\.\/=:@,]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
function spawnClaudePty(args, env) {
  const cmd = ['claude', ...args].map(shellEscapeArg).join(' ');
  return spawn('script', ['-q', '-c', cmd, '/dev/null'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[=>NOP\\\(\)\*\+]|\x1b\[\?[0-9;]+[hl]/g;
function stripAnsi(s) { return String(s).replace(ANSI_RE, ''); }

// PTY 80-col wrap된 OAuth URL 재조립용. claude code의 URL은 보통 한 줄에 ~80 char로 잘려
// 줄바꿈이 끼어서 출력됨. 매칭 전에 모든 whitespace를 제거한 사본에서 URL 추출.
// claude OAuth URL — PTY 80-col wrap 재조립.
// 같은 https://...로 시작하는 줄을 찾고, 그 뒤 줄들이 url-safe char로만 구성되면 합쳐 본 URL 완성.
const OAUTH_LINE_RE = /(https:\/\/(?:claude\.com|console\.anthropic\.com|platform\.claude\.com)\/\S*)/;
const OAUTH_CONT_RE = /^[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+$/;
function tryCaptureOAuthUrl(state) {
  if (state.url) return;
  const raw = stripAnsi((state.output || '') + (state.error || ''));
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(OAUTH_LINE_RE);
    if (!m) continue;
    let url = m[1];
    for (let j = i + 1; j < lines.length; j++) {
      const next = (lines[j] || '').trim();
      if (!next) break;                    // 빈 줄 만나면 URL 끝
      if (!OAUTH_CONT_RE.test(next)) break; // URL-safe char 외 만나면 끝 (예: 'Paste code...')
      url += next;
    }
    if (url.length > 50) { state.url = url; return; }
  }
}

// ── HOME overlay (ec가 spawn할 claude의 ~/.claude/* 격리) ───────────────────
// 기본 ON — ec는 단일 자체 HOME(overlay)으로 claude를 spawn한다.
// cfg.overlay.enabled === false 명시 시에만 비활성 (real HOME 사용).
// overlay HOME 경로: $XDG_DATA_HOME/easyclaude/overlay/
//   .claude/
//     settings.json   ← /opt/easyclaude/data/settings.json 복사 (없을 때만)
//     CLAUDE.md       ← /opt/easyclaude/data/CLAUDE.md base + cfg.overlay.claudeMd 합성
//     skills/         ← /opt/easyclaude/data/skills/* 심볼릭 (디렉토리 단위)
//     credentials.json ← 자동 생성 안 함. ec 내에서 첫 `/login`으로 채워짐.
// project-level (<cwd>/.claude/*)은 claude code가 cwd 자동 탐색 — 따로 안 건드림.
function ensureOverlayHome(realHome) {
  const xdgData = process.env.XDG_DATA_HOME || path.join(realHome, '.local', 'share');
  const ovDir = path.join(xdgData, 'easyclaude', 'overlay');
  const ovClaude = path.join(ovDir, '.claude');
  try { fs.mkdirSync(ovClaude, { recursive: true }); } catch {}

  const pkgRoot = path.join(__dirname, '..');
  const pkgData = path.join(pkgRoot, 'data');
  const pkgSettings = path.join(pkgData, 'settings.json');
  const pkgCMd     = path.join(pkgData, 'CLAUDE.md');
  const pkgSkills  = path.join(pkgData, 'skills');

  // 1) settings.json — 없으면 패키지 데이터 복사 (있으면 사용자의 ec 편집 보존)
  const ovSettings = path.join(ovClaude, 'settings.json');
  if (!fs.existsSync(ovSettings) && fs.existsSync(pkgSettings)) {
    try { fs.copyFileSync(pkgSettings, ovSettings); } catch {}
  }

  // 2) CLAUDE.md — base + @-refs (cfg.overlay.claudeMd.refs.user 등)
  const ovCfg = (cfg && cfg.overlay) || {};
  const cmdCfg = (ovCfg.claudeMd) || {};
  const refs = cmdCfg.refs || {};
  let base = cmdCfg.base;
  if (!base && fs.existsSync(pkgCMd)) base = fs.readFileSync(pkgCMd, 'utf8');
  if (!base) base = '# easyclaude default context\n';
  const lines = [base.replace(/\n+$/, '')];
  if (refs.user)    lines.push('', `@${realHome}/.claude/CLAUDE.md`);
  // project/cwd CLAUDE.md는 claude가 cwd 기반으로 자동 탐색 — @ 참조 불필요.
  // 단 cfg.overlay.claudeMd.extraRefs (절대 경로 배열) 지원
  if (Array.isArray(cmdCfg.extraRefs)) {
    for (const r of cmdCfg.extraRefs) lines.push('', `@${r}`);
  }
  try { fs.writeFileSync(path.join(ovClaude, 'CLAUDE.md'), lines.join('\n') + '\n'); } catch {}

  // 3) skills — 패키지 번들을 항목 단위로 심볼릭
  const ovSkills = path.join(ovClaude, 'skills');
  try { fs.mkdirSync(ovSkills, { recursive: true }); } catch {}
  if (fs.existsSync(pkgSkills)) {
    let entries = [];
    try { entries = fs.readdirSync(pkgSkills); } catch {}
    for (const name of entries) {
      const src = path.join(pkgSkills, name);
      const dst = path.join(ovSkills, name);
      try {
        const st = fs.lstatSync(dst);
        if (st.isSymbolicLink()) continue; // 이미 있음
        // 다른 파일/디렉토리가 있으면 건드리지 않음
        continue;
      } catch {
        try { fs.symlinkSync(src, dst, 'dir'); } catch {}
      }
    }
  }

  // 4) projects — real HOME의 .claude/projects/ 를 그대로 공유 (대화 jsonl 계승).
  //    ec HOME은 스킬/플러그인/credentials 격리용이고, 대화 기록은 cwd 기반 projects를 공유.
  const ovProjects = path.join(ovClaude, 'projects');
  const realProjects = path.join(realHome, '.claude', 'projects');
  try {
    fs.lstatSync(ovProjects);
    // 이미 존재 — symlink든 dir이든 건드리지 않음
  } catch {
    if (fs.existsSync(realProjects)) {
      try { fs.symlinkSync(realProjects, ovProjects, 'dir'); }
      catch (e) { console.error(`[easyclaude] projects symlink fail: ${e.message}`); }
    }
  }

  return ovDir;
}

// ── 응답 포맷 강제 (--append-system-prompt) ────────────────────────────────
// cfg.formatting: { markdown:bool, mathJax:bool, extraPrompt:string }
// markdown/mathJax 켜면 자동으로 지시 문장 합성. extraPrompt는 자유 추가.
function buildFormattingPrompt() {
  const fcfg = (typeof cfg !== 'undefined' && cfg) ? cfg.formatting : null;
  if (!fcfg) return null;
  const parts = [];
  if (fcfg.markdown) parts.push('모든 응답은 Markdown 형식. 헤딩(##/###), 굵게(**), 인라인 코드(`), 코드블록(```), 리스트, 표 적극 활용.');
  if (fcfg.mathJax)  parts.push('수학 기호는 MathJax 형식: 인라인 $...$, 디스플레이 $$...$$. \\frac, \\sum, \\int 등 LaTeX 명령어 자유 사용.');
  if (typeof fcfg.extraPrompt === 'string' && fcfg.extraPrompt.trim()) parts.push(fcfg.extraPrompt.trim());
  return parts.length ? parts.join(' ') : null;
}

// ── claude-code 환경변수 자동 주입 (토글 가능) ───────────────────────────────
// 기본값을 spawn 시 claude 프로세스 env에 주입한다.
// 비활성화: cfg.claudeEnv === false
// 부분/전체 override: cfg.claudeEnv = { KEY: "VALUE", ... }
function defaultClaudeEnv() {
  const defaults = {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    CLAUDE_CODE_ENABLE_BACKGROUND_PLUGIN_REFRESH: '1',
    CLAUDE_CODE_ENABLE_TASKS: '1',
    CLAUDE_CODE_SYNC_PLUGIN_INSTALL: '1',
  };
  // cfg는 아래 loadConfig() 이후에 정의되므로 함수 호출 시점에 참조
  const cfgEnv = (typeof cfg !== 'undefined' && cfg) ? cfg.claudeEnv : undefined;
  if (cfgEnv === false) return {};
  if (cfgEnv && typeof cfgEnv === 'object') return { ...defaults, ...cfgEnv };
  return defaults;
}

// ── Bash 단축 자동 처리 ('! ' + 문자열 → '! `문자열`') ──────────────────────
// claude TUI의 ! shortcut을 stream-json 환경에서도 동일하게 재현.
// 이미 backtick으로 감싸져 있으면 그대로 둠. cfg.bashShortcut === false 면 비활성.
function maybeBashShortcut(text) {
  if (typeof cfg !== 'undefined' && cfg && cfg.bashShortcut === false) return text;
  const m = text.match(/^!\s+([\s\S]+)$/);
  if (!m) return text;
  const cmd = m[1].trim();
  if (!cmd) return text;
  if (cmd.startsWith('`') && cmd.endsWith('`')) return text;
  return '! `' + cmd + '`';
}

// ── Config & State 경로 (XDG + legacy 마이그레이션) ──────────────────────────
// 우선순위:
//   config: $EASYCLAUDE_CONFIG → ./easyclaude.config.json → $XDG_CONFIG_HOME/easyclaude/config.json
//           → ~/.config/easyclaude/config.json → /etc/easyclaude/config.json
//   state : $EASYCLAUDE_STATE  → <config>.state.json (legacy) → $XDG_DATA_HOME/easyclaude/state.json
//           → ~/.local/share/easyclaude/state.json
const HOME = process.env.HOME || '/tmp';
const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
const XDG_DATA_HOME   = process.env.XDG_DATA_HOME   || path.join(HOME, '.local', 'share');

function findConfigPath() {
  const candidates = [
    process.env.EASYCLAUDE_CONFIG,
    path.join(process.cwd(), 'easyclaude.config.json'),
    path.join(XDG_CONFIG_HOME, 'easyclaude', 'config.json'),
    '/etc/easyclaude/config.json',
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
function findStatePath(configPath) {
  if (process.env.EASYCLAUDE_STATE) return process.env.EASYCLAUDE_STATE;
  // legacy: config 옆 .state.json
  if (configPath) {
    const legacy = configPath.replace(/\.json$/, '.state.json');
    if (fs.existsSync(legacy)) return legacy;
  }
  return path.join(XDG_DATA_HOME, 'easyclaude', 'state.json');
}
function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

const cfgPath = findConfigPath();
function loadConfig() {
  if (!cfgPath) return {};
  try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch (e) { console.error(`[easyclaude] config load fail (${cfgPath}): ${e.message}`); return {}; }
}
const cfg = loadConfig();
const PORT = Number(process.env.PORT || cfg.port || 7860);
const HOST = process.env.HOST || cfg.host || '127.0.0.1';

const stateFile = findStatePath(cfgPath);
ensureDir(path.dirname(stateFile));

function loadState() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } }
function saveState(state) { try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); } catch {} }
let sessionState = loadState();

console.log(`[easyclaude] config: ${cfgPath || '(none — defaults)'}`);
console.log(`[easyclaude] state : ${stateFile}`);

// 런타임에 추가된 ad-hoc 세션 (사용자가 + 버튼으로 만든 것)
const runtimeSessions = new Map(); // id → session

function defaultArgs() {
  if (Array.isArray(cfg.defaultArgs) && cfg.defaultArgs.length) return cfg.defaultArgs.slice();
  return [
    '-p',
    '--output-format', 'stream-json',
    '--input-format',  'stream-json',
    '--include-hook-events',
    '--include-partial-messages',
    '--replay-user-messages',
    '--verbose',
  ];
}

function normalizeSession(s) {
  return {
    id:    s.id,
    label: s.label || s.id,
    cwd:   s.cwd   || process.env.HOME || '/tmp',
    name:  s.name  || s.label || s.id,
    args:  Array.isArray(s.args) ? s.args.slice() : [],
    home:  s.home  || null,           // claude HOME override (null이면 process HOME)
    meta:  s.meta  || {},
  };
}

function sessions() {
  const fromCfg = (cfg.sessions || []).map(normalizeSession);
  const fromRt  = [...runtimeSessions.values()].map(normalizeSession);
  // sessionState[id].hidden 인 항목은 목록에서 제외 (purge로 hide된 세션)
  return [...fromCfg, ...fromRt].filter(s => !sessionState[s.id]?.hidden);
}

function findSession(id) {
  return sessions().find(s => s.id === id);
}

function effectiveArgs(sess) {
  return sessionState[sess.id]?.argsOverride ?? sess.args;
}

function serializeForClient(s) {
  return { id: s.id, label: s.label, args: effectiveArgs(s), cwd: s.cwd, home: s.home, meta: s.meta };
}

function broadcastSessions() {
  const list = sessions().map(serializeForClient);
  wss.clients.forEach(c => {
    if (c.readyState === c.OPEN) c.send(JSON.stringify({ op: 'sessions', list }));
  });
}

// ── Claude session history (~/.claude/projects/) ────────────────────────────
const CLAUDE_PROJECTS = path.join(process.env.HOME || '/root', '.claude', 'projects');

function encodeCwd(cwd) {
  // claude의 encoding: `/`와 `.` 모두 `-` 로 치환
  return String(cwd).replace(/[/.]/g, '-');
}

function readHead(filePath, maxBytes = 8192) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    fs.closeSync(fd);
    return buf.slice(0, n).toString('utf8');
  } catch { return ''; }
}

function summarizeSessionFile(absPath, encodedCwd) {
  let stat;
  try { stat = fs.statSync(absPath); } catch { return null; }
  const base = path.basename(absPath, '.jsonl');
  const head = readHead(absPath, 8192);
  const lines = head.split('\n').slice(0, 6);
  let aiTitle = null, firstMsg = '', cwd = null, permissionMode = null;
  for (const ln of lines) {
    if (!ln.trim()) continue;
    let evt; try { evt = JSON.parse(ln); } catch { continue; }
    if (evt.type === 'ai-title' && !aiTitle) aiTitle = evt.aiTitle || null;
    if (evt.type === 'permission-mode' && !permissionMode) permissionMode = evt.permissionMode || null;
    if (evt.type === 'user' && !firstMsg) {
      const c = evt.message && evt.message.content;
      if (typeof c === 'string') firstMsg = c.slice(0, 200);
      else if (Array.isArray(c) && c[0]) {
        const t = c[0].text || (typeof c[0].content === 'string' ? c[0].content : '');
        firstMsg = String(t).slice(0, 200);
      }
    }
    if (evt.cwd && !cwd) cwd = evt.cwd;
  }
  return {
    sessionId: base,
    encodedCwd,
    cwd,
    aiTitle: aiTitle || null,
    firstMessage: firstMsg,
    permissionMode,
    mtime: stat.mtimeMs,
    sizeKB: Math.round(stat.size / 1024),
  };
}

function listClaudeSessions({ cwd, q, limit }) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return [];
  const dirs = cwd
    ? [encodeCwd(cwd)].filter(d => fs.existsSync(path.join(CLAUDE_PROJECTS, d)))
    : fs.readdirSync(CLAUDE_PROJECTS).filter(d => {
        try { return fs.statSync(path.join(CLAUDE_PROJECTS, d)).isDirectory(); } catch { return false; }
      });

  const all = [];
  for (const d of dirs) {
    const dirAbs = path.join(CLAUDE_PROJECTS, d);
    let entries; try { entries = fs.readdirSync(dirAbs); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const abs = path.join(dirAbs, f);
      try {
        const stat = fs.statSync(abs);
        if (!stat.isFile()) continue;
        all.push({ abs, encodedCwd: d, mtime: stat.mtimeMs });
      } catch {}
    }
  }
  // 최신순 정렬 후 limit*5 만 head 읽음 (성능)
  all.sort((a, b) => b.mtime - a.mtime);
  const headLimit = Math.min(all.length, Math.max((limit || 20) * 5, 50));
  const summaries = [];
  for (let i = 0; i < headLimit; i++) {
    const s = summarizeSessionFile(all[i].abs, all[i].encodedCwd);
    if (!s) continue;
    if (q) {
      const ql = q.toLowerCase();
      const hay = ((s.aiTitle || '') + ' ' + (s.firstMessage || '')).toLowerCase();
      if (!hay.includes(ql)) continue;
    }
    summaries.push(s);
    if (summaries.length >= (limit || 20)) break;
  }
  return summaries;
}

function inspectClaudeHome(homeDir) {
  const claudeDir = path.join(homeDir, '.claude');
  if (!fs.existsSync(claudeDir)) return null;
  let readable = false, writable = false;
  try { fs.accessSync(claudeDir, fs.constants.R_OK); readable = true; } catch {}
  try { fs.accessSync(claudeDir, fs.constants.W_OK); writable = true; } catch {}
  let email = null, hasCredentials = false;
  try {
    const credPath = path.join(claudeDir, '.credentials.json');
    if (fs.existsSync(credPath)) {
      hasCredentials = true;
      // 파일 권한 600이라 우리(team-pm) 소유 아니면 못 읽음
      try {
        const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        // oauth account 정보 별도 보관 위치도 검사
      } catch {}
    }
    // 메일은 .claude.json 의 oauthAccount 에 보관됨 (HOME 안)
    const claudeJson = path.join(homeDir, '.claude.json');
    if (fs.existsSync(claudeJson)) {
      try {
        const cj = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
        email = cj.oauthAccount?.emailAddress || cj.oauthAccount?.email || null;
      } catch {}
    }
  } catch {}
  let mtime = null;
  try { mtime = fs.statSync(claudeDir).mtimeMs; } catch {}
  return { home: homeDir, claudeDir, email, hasCredentials, readable, writable, mtime };
}

function scanClaudeHomes() {
  const candidates = new Set();
  // 1) 현재 프로세스 HOME (가장 흔한 케이스)
  if (process.env.HOME) candidates.add(process.env.HOME);
  // 2) /home/* 스캔 (각 디렉토리에 .claude 있는지)
  try {
    for (const u of fs.readdirSync('/home')) {
      const p = path.join('/home', u);
      try {
        if (fs.statSync(p).isDirectory()) candidates.add(p);
      } catch {}
    }
  } catch {}
  // 3) /root
  if (fs.existsSync('/root')) candidates.add('/root');

  const out = [];
  for (const homeDir of candidates) {
    const info = inspectClaudeHome(homeDir);
    if (info) out.push(info);
  }
  // readable + writable 우선 정렬
  out.sort((a, b) => {
    if (a.writable !== b.writable) return a.writable ? -1 : 1;
    if (a.readable !== b.readable) return a.readable ? -1 : 1;
    return (b.mtime || 0) - (a.mtime || 0);
  });
  return out;
}

let _cachedOptions = null;
function getClaudeOptions() {
  if (_cachedOptions) return _cachedOptions;
  const { spawnSync } = require('child_process');
  let help = '';
  try {
    const r = spawnSync('claude', ['--help'], { timeout: 5000, encoding: 'utf8' });
    help = r.stdout || '';
  } catch (e) {}
  // 옵션 파싱: "--effort <level>  ...(low, medium, high, xhigh, max)"
  // "--permission-mode <mode>  ...(choices: "acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan")"
  function pickChoices(flag) {
    const re = new RegExp(`${flag}\\s+\\S+\\s+([^\\n]+)`);
    const m = help.match(re);
    if (!m) return [];
    const line = m[1];
    const choicesMatch = line.match(/choices:\s*([^)]+)\)/);
    if (choicesMatch) {
      return choicesMatch[1].match(/"([^"]+)"/g)?.map(s => s.slice(1,-1)) || [];
    }
    // 괄호 안 "low, medium, high"
    const inParens = line.match(/\(([^)]+)\)/);
    if (inParens) {
      return inParens[1].split(/[,|]/).map(s => s.trim()).filter(s => /^[a-z]/i.test(s));
    }
    return [];
  }
  const efforts = pickChoices('--effort');
  const permissionModes = pickChoices('--permission-mode');
  // 모델은 alias만 (실제 변경 가능한 것). 1m 컨텍스트는 [1m] 접미.
  const models = ['opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'haiku'];
  _cachedOptions = {
    efforts: efforts.length ? efforts : ['low', 'medium', 'high', 'xhigh', 'max'],
    permissionModes: permissionModes.length ? permissionModes : ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'],
    models,
    claudeVersion: (help.match(/claude\s+([\d.]+)/i) || [])[1] || null,
  };
  return _cachedOptions;
}

function claudeJsonlExists(claudeId, homeOverride) {
  // spawn 시 사용할 실제 HOME 기준으로 jsonl 존재 확인 (overlay HOME일 때 중요)
  const projectsRoot = homeOverride
    ? path.join(homeOverride, '.claude', 'projects')
    : CLAUDE_PROJECTS;
  if (!fs.existsSync(projectsRoot)) return false;
  try {
    for (const d of fs.readdirSync(projectsRoot)) {
      if (fs.existsSync(path.join(projectsRoot, d, claudeId + '.jsonl'))) return true;
    }
  } catch {}
  return false;
}

function deleteClaudeSessionFile(sessionId) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return 0;
  let n = 0;
  for (const d of fs.readdirSync(CLAUDE_PROJECTS)) {
    const f = path.join(CLAUDE_PROJECTS, d, sessionId + '.jsonl');
    try {
      if (fs.existsSync(f)) { fs.unlinkSync(f); n++; }
    } catch {}
    // sidecar 디렉토리도 정리
    const sidecar = path.join(CLAUDE_PROJECTS, d, sessionId);
    try {
      if (fs.existsSync(sidecar) && fs.statSync(sidecar).isDirectory()) {
        fs.rmSync(sidecar, { recursive: true, force: true });
      }
    } catch {}
  }
  return n;
}

// ── Permission-prompt bridge (easypermitter MCP ↔ easyclaude) ────────────────
// easypermitter.js (stdio MCP)가 HTTP로 권한 요청을 등록하고 응답을 대기한다.
// pending Map 으로 다중 요청 지원. 동일 tool_use_id 재요청 시 종전 요청은 deny.
const pendingPermissions = new Map(); // tool_use_id → { res, timer, sessionId, payload }

function readJsonBody(req, cb) {
  let buf = '';
  req.setEncoding('utf8');
  req.on('data', d => {
    buf += d;
    if (buf.length > 1024 * 1024) {
      // 1MB cap — 권한 입력 페이로드가 그렇게 클 일 없다
      req.destroy();
      cb(new Error('payload too large'));
    }
  });
  req.on('end', () => {
    if (!buf) return cb(null, {});
    try { cb(null, JSON.parse(buf)); } catch (e) { cb(e); }
  });
  req.on('error', err => cb(err));
}

function bridgeBroadcastPermission(sessionId, payload) {
  const ch = sessionId ? ptyChannels.get(sessionId) : null;
  const targets = ch ? [ch] : [...ptyChannels.values()];
  for (const c of targets) {
    for (const [ws, ids] of c.subscribers) {
      if (ws.readyState !== ws.OPEN) continue;
      for (const cid of ids) {
        try {
          ws.send(JSON.stringify({ op: 'dialog', id: cid, kind: 'PermissionPrompt', ...payload }));
        } catch {}
      }
    }
  }
}

function resolvePermission(tool_use_id, result) {
  const p = pendingPermissions.get(tool_use_id);
  if (!p) return false;
  pendingPermissions.delete(tool_use_id);
  if (p.timer) clearTimeout(p.timer);
  try {
    p.res.writeHead(200, { 'Content-Type': 'application/json' });
    p.res.end(JSON.stringify(result));
  } catch {}
  return true;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml' };

// ── slash command 상응 API helpers ───────────────────────────────────────────
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function listDirSafe(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}
function homeDirOf(sessId) {
  // 세션이 home override 갖고 있으면 그쪽, 아니면 process.env.HOME
  const sess = sessions().find(s => s.id === sessId);
  return (sess && sess.home) || process.env.HOME || '/tmp';
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({ok:true}));
  }

  // ── /api/status ── ec 자체 상태 (splash/hello에서 polling 가능)
  if (req.url === '/api/status') {
    const pkg = readJsonSafe(path.join(__dirname, '..', 'package.json')) || {};
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({
      ok: true,
      version: pkg.version || 'unknown',
      port: PORT,
      host: HOST,
      sessions: sessions().map(s => ({
        id: s.id, label: s.label,
        alive: !!(ptyChannels.get(s.id)?.proc && ptyChannels.get(s.id).proc.exitCode === null),
        signedInAs: ptyChannels.get(s.id)?.signedInAs || null,
      })),
    }));
  }

  // ── /api/slash/* ── claude TUI 슬래시 커맨드 상응물 ─────────────────────────
  const slashMatch = req.url.match(/^\/api\/slash\/([a-z]+)(?:\?(.*))?$/);
  if (slashMatch) {
    const cmd = slashMatch[1];
    const qs = new URLSearchParams(slashMatch[2] || '');
    const sid = qs.get('sid');
    const ch = sid ? ptyChannels.get(sid) : null;
    res.writeHead(200, {'Content-Type':'application/json'});

    // /status — 세션 메타 (model, cwd, session_id, tools, mcp_servers...)
    if (cmd === 'status') {
      if (!ch) return res.end(JSON.stringify({ok:false, error:'session not running', sid}));
      return res.end(JSON.stringify({ok:true, session: ch.parser.snapshot().session}));
    }
    // /usage, /context — token usage (in/out/cache) 누적
    if (cmd === 'usage' || cmd === 'context') {
      if (!ch) return res.end(JSON.stringify({ok:false, error:'session not running', sid}));
      const snap = ch.parser.snapshot();
      return res.end(JSON.stringify({ok:true, usage: snap.session.usage, lastResult: ch.parser.lastResult, contextWindow: snap.session.contextWindow}));
    }
    // /stats — ~/.claude/stats-cache.json
    if (cmd === 'stats') {
      const home = sid ? homeDirOf(sid) : (process.env.HOME || '/tmp');
      const stats = readJsonSafe(path.join(home, '.claude', 'stats-cache.json'));
      return res.end(JSON.stringify({ok:true, stats}));
    }
    // /hooks — settings.json의 hooks 섹션
    if (cmd === 'hooks') {
      const home = sid ? homeDirOf(sid) : (process.env.HOME || '/tmp');
      const settings = readJsonSafe(path.join(home, '.claude', 'settings.json')) || {};
      return res.end(JSON.stringify({ok:true, hooks: settings.hooks || {}}));
    }
    // /agents — ~/.claude/agents/ 디렉토리 + settings agents
    if (cmd === 'agents') {
      const home = sid ? homeDirOf(sid) : (process.env.HOME || '/tmp');
      const agentsDir = path.join(home, '.claude', 'agents');
      const files = listDirSafe(agentsDir).filter(f => f.endsWith('.md') || f.endsWith('.json'));
      const sessionAgents = ch ? (ch.parser.snapshot().session.agents || []) : [];
      return res.end(JSON.stringify({ok:true, files, sessionAgents}));
    }
    // /tasks — .claude/tasks/ 디렉토리 (project-local)
    if (cmd === 'tasks') {
      const tasksDir = path.join(process.cwd(), '.claude', 'tasks');
      const files = listDirSafe(tasksDir);
      return res.end(JSON.stringify({ok:true, files, dir: tasksDir}));
    }
    // /doctor — 진단 (claude version, auth, mcp 상태)
    if (cmd === 'doctor') {
      const { spawnSync } = require('child_process');
      const version = spawnSync('claude', ['--version'], {timeout: 3000, encoding:'utf8'}).stdout?.trim();
      const auth = spawnSync('claude', ['auth', 'status', '--json'], {timeout: 5000, encoding:'utf8'}).stdout?.trim();
      let authParsed = null;
      try { authParsed = JSON.parse(auth); } catch {}
      const sessSnap = ch ? ch.parser.snapshot().session : null;
      return res.end(JSON.stringify({
        ok: true,
        claudeVersion: version,
        auth: authParsed,
        mcpServers: sessSnap?.mcpServers || [],
        sessionId: sessSnap?.id || null,
      }));
    }
    // /rename — POST body로 새 이름. (현재 cfg 세션 args 수정은 PoC에서 보류; session label 변경만 echo)
    if (cmd === 'rename') {
      if (req.method !== 'POST') return res.end(JSON.stringify({ok:false, error:'POST required'}));
      return readJsonBody(req, (err, body) => {
        if (err) return res.end(JSON.stringify({ok:false, error: err.message}));
        const newName = body && body.name;
        if (!sid || !newName) return res.end(JSON.stringify({ok:false, error:'sid + name required'}));
        const sess = sessions().find(s => s.id === sid);
        if (!sess) return res.end(JSON.stringify({ok:false, error:'session not found'}));
        sessionState[sid] = { ...(sessionState[sid] || {}), name: newName };
        saveState(sessionState);
        return res.end(JSON.stringify({ok:true, sid, name:newName, note:'in-memory; full rename requires session respawn'}));
      });
    }
    // /config — 기존 /api/claude-settings로 redirect (READ/WRITE 이미 있음)
    if (cmd === 'config') {
      return res.end(JSON.stringify({ok:true, redirect:'/api/claude-settings', hint:'use GET/PUT /api/claude-settings?home=<path>'}));
    }
    return res.end(JSON.stringify({ok:false, error:`unknown slash: ${cmd}`}));
  }
  if (req.url === '/api/sessions') {
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify(sessions().map(s=>({id:s.id,label:s.label,meta:s.meta}))));
  }

  // /api/sessions/history?cwd=&q=&limit=20 — claude jsonl 스캔
  // /api/options — claude --help 에서 동적으로 추출한 효력/권한모드/모델 옵션
  if (req.url === '/api/options') {
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify(getClaudeOptions()));
  }

  // /api/claude-homes — DEPRECATED (multi-home 컨셉 폐기). ec는 단일 ec HOME만 다룸.
  // 호환을 위해 ec HOME 하나만 list로 감싸 반환.
  if (req.url === '/api/claude-homes' || req.url.startsWith('/api/claude-homes?')) {
    const overlayEnabled = !(cfg && cfg.overlay && cfg.overlay.enabled === false);
    let home;
    try { home = overlayEnabled ? ensureOverlayHome(process.env.HOME) : process.env.HOME; }
    catch { home = process.env.HOME; }
    const info = inspectClaudeHome(home) || { home, claudeDir: path.join(home, '.claude'), email: null, hasCredentials: false, readable: true, writable: true };
    info.overlayEnabled = overlayEnabled;
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({ list: [info] }));
  }

  // /api/ec-home — ec가 현재 사용 중인 단일 HOME 정보
  if (req.url === '/api/ec-home' || req.url.startsWith('/api/ec-home?')) {
    const overlayEnabled = !(cfg && cfg.overlay && cfg.overlay.enabled === false);
    let home;
    try { home = overlayEnabled ? ensureOverlayHome(process.env.HOME) : process.env.HOME; }
    catch { home = process.env.HOME; }
    const info = inspectClaudeHome(home) || { home, claudeDir: path.join(home, '.claude'), email: null, hasCredentials: false, readable: true, writable: true };
    info.overlayEnabled = overlayEnabled;
    info.realHome = process.env.HOME;
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({ ok: true, ...info }));
  }

  // /api/auth/status?home=... — claude auth status --json
  if (req.url.startsWith('/api/auth/status')) {
    const u = new URL(req.url, 'http://x');
    const home = u.searchParams.get('home') || process.env.HOME;
    const { spawnSync } = require('child_process');
    const result = spawnSync('claude', ['auth', 'status', '--json'], {
      env: { ...process.env, HOME: home }, timeout: 10000, encoding: 'utf8',
    });
    res.writeHead(200, {'Content-Type':'application/json'});
    try { return res.end(JSON.stringify(JSON.parse(result.stdout || '{}'))); }
    catch { return res.end(JSON.stringify({ error: result.stderr || 'parse fail', raw: result.stdout })); }
  }

  // ── /api/auth/* ── claude auth 래퍼 (login / logout / status / setup-token) ──
  // login은 OAuth 브라우저 플로우라 spawn 후 URL 캡처 → 클라이언트가 새 탭에서 열고
  // login-status 폴링으로 완료 확인.
  //
  // claude 1.x는 setup-token/login 둘 다 isTTY check를 해서 non-TTY면 출력을 생략한다.
  // 우회: util-linux `script -q -c "claude ..." /dev/null` 로 PTY 안에서 실행.
  // 출력엔 ANSI escape가 잔뜩 섞여 오므로 URL 추출 전에 strip 후 검색.
  if (req.url.startsWith('/api/auth/login-status')) {
    const u = new URL(req.url, 'http://x');
    const home = u.searchParams.get('home') || process.env.HOME;
    const state = authProcs.get(home);
    res.writeHead(200, {'Content-Type':'application/json'});
    if (!state) return res.end(JSON.stringify({ ok:true, status: 'idle', home }));
    return res.end(JSON.stringify({
      ok: true,
      status: state.status,           // pending | success | failed | killed
      url: state.url,
      exitCode: state.exitCode ?? null,
      output: (state.output || '').slice(-2000),
      error:  (state.error  || '').slice(-2000),
      home,
    }));
  }
  if (req.url.startsWith('/api/auth/login')) {
    if (req.method !== 'POST') { res.writeHead(405); return res.end('POST required'); }
    return readJsonBody(req, (err, body) => {
      if (err) { res.writeHead(400); return res.end(err.message); }
      const method = (body && body.method) || 'claudeai';  // claudeai | console | sso
      const home   = (body && body.home)   || process.env.HOME;
      const flags = ['auth', 'login'];
      if (method === 'console') flags.push('--console');
      else if (method === 'sso') flags.push('--sso');
      // 'claudeai' is default — no flag
      if (body && body.email) flags.push('--email', body.email);
      // 기존 진행 중 프로세스 종료
      const existing = authProcs.get(home);
      if (existing && existing.proc && existing.proc.exitCode === null) {
        try { existing.proc.kill('SIGTERM'); } catch {}
      }
      const proc = spawnClaudePty(flags, { ...process.env, HOME: home });
      const state = { proc, url: null, status: 'pending', output: '', error: '', exitCode: null };
      authProcs.set(home, state);
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', d => { state.output += d; tryCaptureOAuthUrl(state); });
      proc.stderr.on('data', d => { state.error  += d; tryCaptureOAuthUrl(state); });
      proc.on('exit', (code, signal) => {
        state.exitCode = code;
        state.status = signal === 'SIGTERM' ? 'killed' : (code === 0 ? 'success' : 'failed');
      });
      // URL 캡처 위해 대기 — PTY 80 char wrap된 splash가 ~10s, URL은 그 뒤에 나옴
      const respondAt = Date.now() + 15000;
      const tick = setInterval(() => {
        if (state.url || Date.now() >= respondAt || state.exitCode !== null) {
          clearInterval(tick);
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ ok: true, url: state.url, status: state.status, home, hint: 'GET /api/auth/login-status?home=<>로 폴링' }));
        }
      }, 300);
    });
  }
  // /api/auth/paste-code — 진행 중 login/setup-token proc의 stdin에 코드 paste + Enter
  // body: { home, code }
  if (req.url.startsWith('/api/auth/paste-code')) {
    if (req.method !== 'POST') { res.writeHead(405); return res.end('POST required'); }
    return readJsonBody(req, (err, body) => {
      if (err) { res.writeHead(400); return res.end(err.message); }
      const home = (body && body.home) || process.env.HOME;
      const code = body && body.code;
      if (typeof code !== 'string' || !code.trim()) {
        res.writeHead(400, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ error: 'code (string) required' }));
      }
      const state = authProcs.get(home);
      if (!state || !state.proc || state.proc.exitCode !== null) {
        res.writeHead(409, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ error: 'no active auth process for this home — start login/setup-token first' }));
      }
      try {
        state.proc.stdin.write(code.trim() + '\r');
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ ok: true, hint: '폴링으로 status 확인' }));
      } catch (e) {
        res.writeHead(500, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
  }
  if (req.url.startsWith('/api/auth/logout')) {
    if (req.method !== 'POST') { res.writeHead(405); return res.end('POST required'); }
    return readJsonBody(req, (err, body) => {
      if (err) { res.writeHead(400); return res.end(err.message); }
      const home = (body && body.home) || process.env.HOME;
      const { spawnSync } = require('child_process');
      const r = spawnSync('claude', ['auth', 'logout'], {
        env: { ...process.env, HOME: home },
        timeout: 10000, encoding: 'utf8',
      });
      // 진행 중 login proc 있으면 정리
      const existing = authProcs.get(home);
      if (existing && existing.proc && existing.proc.exitCode === null) {
        try { existing.proc.kill('SIGTERM'); } catch {}
      }
      authProcs.delete(home);
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ ok: r.status === 0, stdout: r.stdout, stderr: r.stderr, home }));
    });
  }
  // /api/auth/models?home=... — auth 방식 보고 사용 가능한 모델 후보 반환
  // 하드코딩 피하기 위해 claude --help 추출 + auth status 기반.
  if (req.url.startsWith('/api/auth/models')) {
    const u = new URL(req.url, 'http://x');
    const home = u.searchParams.get('home') || process.env.HOME;
    const { spawnSync } = require('child_process');
    const auth = spawnSync('claude', ['auth', 'status', '--json'], {
      env: { ...process.env, HOME: home }, timeout: 5000, encoding: 'utf8',
    });
    let authParsed = null;
    try { authParsed = JSON.parse(auth.stdout); } catch {}
    // claude --help에서 --model 행을 찾으면 거기에 모델 enum이 박혀있을 수 있음
    const help = spawnSync('claude', ['--help'], { timeout: 3000, encoding: 'utf8' });
    let modelHelp = '';
    if (help.stdout) {
      const m = help.stdout.match(/-m,\s+--model\s+<model>\s+([^\n]+)/);
      if (m) modelHelp = m[1];
    }
    // auth 방식별 일반적 후보 (subscription tier에 따라 가용성 다를 수 있음; 최종 결정은 사용자)
    const subscription = authParsed && authParsed.subscriptionType;
    let candidates = [];
    if (authParsed && authParsed.loggedIn) {
      if (authParsed.authMethod === 'claude.ai') {
        // Pro/Team/Enterprise 모두 일반적으로 사용 가능한 별칭
        candidates = ['opus', 'sonnet', 'haiku'];
      } else if (authParsed.authMethod === 'console' || authParsed.apiProvider === 'firstParty') {
        // API 명시적 모델 ID
        candidates = ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
      }
    }
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({
      ok: true,
      authMethod: authParsed && authParsed.authMethod,
      subscriptionType: subscription,
      loggedIn: authParsed && authParsed.loggedIn,
      candidates,
      modelHelp,
      note: '실제 사용 가능 모델은 구독 등급/API 키 권한에 따라 다를 수 있음. 자유 입력 가능.',
    }));
  }
  if (req.url.startsWith('/api/auth/setup-token')) {
    if (req.method !== 'POST') { res.writeHead(405); return res.end('POST required'); }
    return readJsonBody(req, (err, body) => {
      if (err) { res.writeHead(400); return res.end(err.message); }
      const home = (body && body.home) || process.env.HOME;
      // setup-token은 인터랙티브 — login과 동일 패턴으로 spawn 후 URL/토큰 캡처
      const existing = authProcs.get(home);
      if (existing && existing.proc && existing.proc.exitCode === null) {
        try { existing.proc.kill('SIGTERM'); } catch {}
      }
      const proc = spawnClaudePty(['setup-token'], { ...process.env, HOME: home });
      const state = { proc, url: null, status: 'pending', output: '', error: '', exitCode: null };
      authProcs.set(home, state);
      proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', d => { state.output += d; tryCaptureOAuthUrl(state); });
      proc.stderr.on('data', d => { state.error  += d; tryCaptureOAuthUrl(state); });
      proc.on('exit', (code, signal) => { state.exitCode = code; state.status = signal === 'SIGTERM' ? 'killed' : (code === 0 ? 'success' : 'failed'); });
      // PTY 안 claude는 splash ~10s 후 URL 출력. timeout 충분히.
      const respondAt = Date.now() + 15000;
      const tick = setInterval(() => {
        if (state.url || Date.now() >= respondAt || state.exitCode !== null) {
          clearInterval(tick);
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ ok: true, url: state.url, status: state.status, home }));
        }
      }, 300);
    });
  }

  // /api/claude-settings?home=...[&force=1]  GET: 읽기 / PUT: body 로 저장
  //   force=1: 권한 부족 시 sudo로 강제 read/write (sudoers에 tee/cat 허용 필요)
  if (req.url.startsWith('/api/claude-settings')) {
    const u = new URL(req.url, 'http://x');
    const home = u.searchParams.get('home') || process.env.HOME;
    const force = u.searchParams.get('force') === '1';
    const settingsPath = path.join(home, '.claude', 'settings.json');
    const { spawnSync } = require('child_process');
    const sudoCat = (p) => {
      const r = spawnSync('sudo', ['-n', 'cat', p], { timeout: 5000, encoding: 'utf8' });
      return r.status === 0 ? r.stdout : null;
    };
    const sudoWrite = (p, content) => {
      const r = spawnSync('sudo', ['-n', 'tee', p], { input: content, timeout: 5000, encoding: 'utf8' });
      return r.status === 0;
    };
    if (req.method === 'GET') {
      let txt = null, mode = 'normal';
      try {
        if (fs.existsSync(settingsPath)) txt = fs.readFileSync(settingsPath, 'utf8');
        else txt = '{}';
      } catch (e) {
        if (force || (e.code === 'EACCES' || e.code === 'EPERM')) {
          const sudoTxt = sudoCat(settingsPath);
          if (sudoTxt !== null) { txt = sudoTxt; mode = 'sudo'; }
          else {
            res.writeHead(500, {'Content-Type':'application/json'});
            return res.end(JSON.stringify({ error: e.message, sudo: 'failed (sudoers cat 미허용?)' }));
          }
        } else {
          res.writeHead(500, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ error: e.message }));
        }
      }
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ home, path: settingsPath, content: txt, mode }));
    }
    if (req.method === 'PUT') {
      return readJsonBody(req, (err, body) => {
        if (err) { res.writeHead(400); return res.end(err.message); }
        const content = body && body.content;
        if (typeof content !== 'string') {
          res.writeHead(400, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ error: 'content (string) required' }));
        }
        try { JSON.parse(content); }
        catch (e) {
          res.writeHead(400, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ error: 'invalid JSON: ' + e.message }));
        }
        let mode = 'normal';
        try {
          ensureDir(path.dirname(settingsPath));
          fs.writeFileSync(settingsPath, content, { mode: 0o600 });
        } catch (e) {
          if (force || e.code === 'EACCES' || e.code === 'EPERM') {
            if (sudoWrite(settingsPath, content)) mode = 'sudo';
            else {
              res.writeHead(500, {'Content-Type':'application/json'});
              return res.end(JSON.stringify({ error: e.message, sudo: 'failed (sudoers tee 미허용?)' }));
            }
          } else {
            res.writeHead(500, {'Content-Type':'application/json'});
            return res.end(JSON.stringify({ error: e.message }));
          }
        }
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ ok: true, path: settingsPath, mode }));
      });
    }
  }

  // /api/ec-config — ec 자체 설정(cfg.json) GET/PUT
  // cfg는 module load 시점 const라 PUT 후 재기동 필요. response의 needsRestart=true 안내.
  if (req.url.startsWith('/api/ec-config')) {
    const targetPath = cfgPath || path.join(XDG_CONFIG_HOME, 'easyclaude', 'config.json');
    if (req.method === 'GET') {
      let content;
      try {
        content = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '{}';
      } catch (e) {
        res.writeHead(500, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ error: e.message }));
      }
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ ok: true, path: targetPath, content, exists: fs.existsSync(targetPath) }));
    }
    if (req.method === 'PUT') {
      return readJsonBody(req, (err, body) => {
        if (err) { res.writeHead(400); return res.end(err.message); }
        const content = body && body.content;
        if (typeof content !== 'string') {
          res.writeHead(400, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ error: 'content (string) required' }));
        }
        try { JSON.parse(content); }
        catch (e) {
          res.writeHead(400, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ error: 'invalid JSON: ' + e.message }));
        }
        try {
          ensureDir(path.dirname(targetPath));
          fs.writeFileSync(targetPath, content);
        } catch (e) {
          res.writeHead(500, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ error: e.message }));
        }
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ ok: true, path: targetPath, needsRestart: true, hint: 'ec 프로세스 재기동 필요 (포트/세션 목록/defaultArgs 등 cfg는 부팅 시 1회 로드)' }));
      });
    }
    res.writeHead(405); return res.end('GET or PUT');
  }

  // /api/sessions/<sid>/history-turns?before=K&limit=N
  // jsonl 전체를 StreamParser로 파스해 turn 배열 만든 뒤 [before-limit, before) 슬라이스 반환.
  // before 미지정 시 전체 끝(=total)에서 limit 만큼.
  const histTurnsMatch = req.url.match(/^\/api\/sessions\/([^/]+)\/history-turns(?:\?(.*))?$/);
  if (histTurnsMatch) {
    const sid = decodeURIComponent(histTurnsMatch[1]);
    const qs = new URLSearchParams(histTurnsMatch[2] || '');
    const limit = Math.min(2000, Math.max(1, parseInt(qs.get('limit') || '100', 10) || 100));
    const beforeRaw = qs.get('before');
    const claudeId = sessionState[sid]?.claudeId;
    if (!claudeId) {
      res.writeHead(404, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ ok:true, turns: [], total: 0, start: 0, end: 0, hint: 'no claudeId yet' }));
    }
    const sess = findSession(sid);
    const homes = homesForSession(sess);
    let jsonlPath = null;
    for (const h of homes) {
      const projectsDir = path.join(h, '.claude', 'projects');
      if (!fs.existsSync(projectsDir)) continue;
      try {
        for (const d of fs.readdirSync(projectsDir)) {
          const p = path.join(projectsDir, d, claudeId + '.jsonl');
          if (fs.existsSync(p)) { jsonlPath = p; break; }
        }
      } catch {}
      if (jsonlPath) break;
    }
    if (!jsonlPath) {
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ ok: true, turns: [], total: 0, start: 0, end: 0, hint: 'jsonl not found yet (new session?)' }));
    }
    try {
      const turns = jsonlToTurns(jsonlPath);
      const total = turns.length;
      const before = beforeRaw != null ? Math.max(0, Math.min(total, parseInt(beforeRaw, 10) || total)) : total;
      const start  = Math.max(0, before - limit);
      const slice  = turns.slice(start, before);
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ ok: true, turns: slice, total, start, end: before, path: jsonlPath }));
    } catch (e) {
      res.writeHead(500, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // /api/sessions/<sid>/jsonl?offset=N&limit=M — 페이지 단위 jsonl 라인 + 총 라인 수
  // (프론트 무한 스크롤 용. offset/limit 미지정 시 default offset=0, limit=500)
  const jsonlPageMatch = req.url.match(/^\/api\/sessions\/([^/]+)\/jsonl(?:\?(.*))?$/);
  if (jsonlPageMatch && !req.url.includes('jsonl-path')) {
    const sid = decodeURIComponent(jsonlPageMatch[1]);
    const qs = new URLSearchParams(jsonlPageMatch[2] || '');
    const offset = Math.max(0, parseInt(qs.get('offset') || '0', 10) || 0);
    const limit  = Math.min(2000, Math.max(1, parseInt(qs.get('limit') || '500', 10) || 500));
    const parse  = qs.get('parse') !== '0'; // default: parse each line
    const claudeId = sessionState[sid]?.claudeId;
    if (!claudeId) {
      res.writeHead(404, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ error: 'session not found or no claudeId' }));
    }
    // jsonl path 찾기 (jsonl-path와 동일 로직)
    const sess = findSession(sid);
    const homes = homesForSession(sess);
    let jsonlPath = null;
    for (const h of homes) {
      const projectsDir = path.join(h, '.claude', 'projects');
      if (!fs.existsSync(projectsDir)) continue;
      try {
        for (const d of fs.readdirSync(projectsDir)) {
          const p = path.join(projectsDir, d, claudeId + '.jsonl');
          if (fs.existsSync(p)) { jsonlPath = p; break; }
        }
      } catch {}
      if (jsonlPath) break;
    }
    if (!jsonlPath) {
      res.writeHead(404, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ error: 'jsonl not found', claudeId }));
    }
    try {
      const raw = fs.readFileSync(jsonlPath, 'utf8');
      const allLines = raw.split('\n').filter(l => l.length > 0);
      const total = allLines.length;
      const slice = allLines.slice(offset, offset + limit);
      const entries = parse
        ? slice.map(l => { try { return JSON.parse(l); } catch { return { _parseError: true, raw: l.slice(0, 200) }; } })
        : slice;
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({
        ok: true,
        total,
        offset,
        limit,
        returned: slice.length,
        path: jsonlPath,
        entries,
      }));
    } catch (e) {
      res.writeHead(500, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // /api/sessions/<sid>/jsonl-path — claudeId 기반 jsonl 절대경로 응답
  const jsonlMatch = req.url.match(/^\/api\/sessions\/([^/]+)\/jsonl-path$/);
  if (jsonlMatch) {
    const sid = decodeURIComponent(jsonlMatch[1]);
    const claudeId = sessionState[sid]?.claudeId;
    if (!claudeId) {
      res.writeHead(404, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ error: 'session not found or no claudeId' }));
    }
    // 모든 home + projects 디렉토리 탐색
    const candidates = [];
    const sess = findSession(sid);
    const homes = homesForSession(sess);
    for (const h of homes) {
      const projectsDir = path.join(h, '.claude', 'projects');
      if (!fs.existsSync(projectsDir)) continue;
      try {
        for (const d of fs.readdirSync(projectsDir)) {
          const p = path.join(projectsDir, d, claudeId + '.jsonl');
          if (fs.existsSync(p)) candidates.push(p);
        }
      } catch {}
    }
    res.writeHead(candidates.length ? 200 : 404, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({
      claudeId, paths: candidates,
      tailCmd: candidates[0] ? `tail -f ${candidates[0]}` : null,
    }));
  }

  if (req.url.startsWith('/api/sessions/history')) {
    const u = new URL(req.url, 'http://x');
    const cwd = u.searchParams.get('cwd') || '';
    const q   = u.searchParams.get('q')   || '';
    const limit = Math.min(parseInt(u.searchParams.get('limit') || '30', 10) || 30, 100);
    try {
      const list = listClaudeSessions({ cwd: cwd || null, q: q || null, limit });
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ list }));
    } catch (e) {
      res.writeHead(500, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── Permitter 브리지 ─────────────────────────────────────────────────────────
  // easypermitter MCP 가 호출하는 두 엔드포인트.
  //   POST /api/permitter/request  — long-poll, body: { tool_name, input, tool_use_id, session?, timeoutMs? }
  //   POST /api/permitter/respond  — body: { tool_use_id, behavior, updatedInput?, message? }
  if (req.url === '/api/permitter/request' && req.method === 'POST') {
    return readJsonBody(req, (err, body) => {
      if (err) { res.writeHead(400); return res.end(err.message); }
      const tool_use_id = body && body.tool_use_id;
      const tool_name   = body && body.tool_name;
      if (!tool_use_id || !tool_name) {
        res.writeHead(400, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ error: 'tool_use_id and tool_name required' }));
      }
      // 이미 같은 tool_use_id 가 대기 중이면 종전 요청을 deny 처리하고 새 요청으로 교체.
      const prev = pendingPermissions.get(tool_use_id);
      if (prev) {
        try {
          prev.res.writeHead(200, {'Content-Type':'application/json'});
          prev.res.end(JSON.stringify({ behavior: 'deny', message: 'superseded' }));
        } catch {}
        if (prev.timer) clearTimeout(prev.timer);
        pendingPermissions.delete(tool_use_id);
      }
      const timeoutMs = Math.max(1000, Math.min(Number(body.timeoutMs) || 300000, 1800000));
      const sessionId = body.session || body.sessionId || null;
      const payload = { tool_name, input: body.input || {}, tool_use_id, sessionId };
      const timer = setTimeout(() => {
        const p = pendingPermissions.get(tool_use_id);
        if (!p) return;
        pendingPermissions.delete(tool_use_id);
        try {
          p.res.writeHead(200, {'Content-Type':'application/json'});
          p.res.end(JSON.stringify({ behavior: 'deny', message: 'timeout' }));
        } catch {}
      }, timeoutMs);
      pendingPermissions.set(tool_use_id, { res, timer, sessionId, payload });
      console.log(`[easyclaude] permit request: tool=${tool_name} id=${tool_use_id} sess=${sessionId||'-'}`);
      bridgeBroadcastPermission(sessionId, payload);
      // 클라이언트(소켓)가 끊기면 pending 정리. req.on('close')는 본문 종료 직후 발생하므로
      // 응답 측 close 만 감지해야 한다 (response sent 또는 socket disconnect).
      res.on('close', () => {
        if (res.writableEnded) return; // 정상 응답 끝났음 — 우리가 이미 정리함
        const p = pendingPermissions.get(tool_use_id);
        if (p && p.res === res) {
          pendingPermissions.delete(tool_use_id);
          if (p.timer) clearTimeout(p.timer);
        }
      });
    });
  }
  if (req.url === '/api/permitter/respond' && req.method === 'POST') {
    return readJsonBody(req, (err, body) => {
      if (err) { res.writeHead(400); return res.end(err.message); }
      const tool_use_id = body && body.tool_use_id;
      const behavior = body && body.behavior;
      if (!tool_use_id || (behavior !== 'allow' && behavior !== 'deny')) {
        res.writeHead(400, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ error: 'tool_use_id + behavior(allow|deny) required' }));
      }
      const out = { behavior };
      if (behavior === 'allow' && body.updatedInput !== undefined) out.updatedInput = body.updatedInput;
      if (body.message) out.message = String(body.message);
      const ok = resolvePermission(tool_use_id, out);
      res.writeHead(ok ? 200 : 404, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ ok }));
    });
  }
  if (req.url === '/api/permitter/pending' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify(
      [...pendingPermissions.entries()].map(([id, p]) => ({ tool_use_id: id, ...p.payload }))
    ));
  }

  // ── 디버그 엔드포인트 ────────────────────────────────────────────────────────
  // /api/debug/:sessionId/turns — parser snapshot 전체
  // /api/debug/:sessionId/raw   — 최근 raw JSON 라인 (lineLog)
  // /api/debug/:sessionId/usage — usage 누적
  const dbgMatch = req.url.match(/^\/api\/debug\/([^/]+)\/(turns|raw|usage|session)$/);
  if (dbgMatch) {
    const sid = dbgMatch[1], kind = dbgMatch[2];
    const ch = ptyChannels.get(sid);
    if (!ch) { res.writeHead(404); return res.end('session not running'); }
    res.writeHead(200, {'Content-Type':'application/json'});
    if (kind === 'turns')   return res.end(JSON.stringify(ch.parser.snapshot().turns, null, 2));
    if (kind === 'raw')     return res.end(JSON.stringify(ch.rawLog.slice(-200), null, 2));
    if (kind === 'usage')   return res.end(JSON.stringify(ch.parser.snapshot().session.usage, null, 2));
    if (kind === 'session') return res.end(JSON.stringify(ch.parser.snapshot().session, null, 2));
  }

  const urlPath = req.url.split('?')[0];
  let fp = path.join(CLIENT_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!fp.startsWith(CLIENT_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream'});
    res.end(data);
  });
});

// ── 영속 PTY 채널 ────────────────────────────────────────────────────────────
const ptyChannels = new Map();
// channel: { pty, sess, parser, lineBuf, rawLog, subscribers:Map<ws,Set<id>>, debounceTimer, lastTurnsJson }

function buildSpawnArgs(sess) {
  // defaultArgs + 세션별 args (argsOverride 우선) + (resume | session-id + name)
  const args = defaultArgs();
  const userArgs = sessionState[sess.id]?.argsOverride ?? sess.args;
  if (Array.isArray(userArgs)) args.push(...userArgs);

  // --permission-prompt-tool 가 있고 --mcp-config 는 없으면 easypermitter MCP 자동 주입
  const hasPromptTool = args.some(a => a === '--permission-prompt-tool');
  const hasMcpConfig  = args.some(a => a === '--mcp-config');
  let injectedEnv = null;
  if (hasPromptTool && !hasMcpConfig) {
    const mcpConfig = {
      mcpServers: {
        easypermitter: {
          type: 'stdio',
          command: 'node',
          args: [path.join(__dirname, 'easypermitter.js')],
        },
      },
    };
    args.push('--mcp-config', JSON.stringify(mcpConfig));
    injectedEnv = {
      EASYCLAUDE_HOST: HOST,
      EASYCLAUDE_PORT: String(PORT),
      EASYPERMITTER_SESSION: sess.id,
      EASYPERMITTER_TIMEOUT_MS: '300000',
    };
  }

  // --append-system-prompt 자동 주입 (cfg.formatting)
  const fmtPrompt = buildFormattingPrompt();
  if (fmtPrompt && !args.includes('--append-system-prompt')) {
    args.push('--append-system-prompt', fmtPrompt);
  }

  // jsonl 검색은 실제 spawn 대상 HOME 기준 — overlay 활성 시 process HOME에 있어도 의미 없음.
  const overlayEnabled = !(cfg && cfg.overlay && cfg.overlay.enabled === false);
  const targetHome = sess.home || (overlayEnabled ? path.join(XDG_DATA_HOME, 'easyclaude', 'overlay') : process.env.HOME);
  const saved = sessionState[sess.id];
  const existingId = saved?.claudeId;
  if (existingId) {
    // jsonl 파일 존재 확인 — 없으면 새 session-id 로 fallback
    if (claudeJsonlExists(existingId, targetHome)) {
      args.push('--resume', existingId);
      return { args, isNew: false, claudeId: existingId, injectedEnv };
    } else {
      console.warn(`[easyclaude] resume target jsonl missing for ${sess.id} (claudeId=${existingId}) in ${targetHome}; starting new session`);
    }
  }
  const newId = randomUUID();
  args.push('--session-id', newId);
  if (sess.name && !args.includes('--name') && !args.includes('-n')) {
    args.push('--name', sess.name);
  }
  return { args, isNew: true, claudeId: newId, injectedEnv };
}

function spawnSession(sess) {
  // 채널 영속 — proc 가 죽어도 ch 와 parser(turns history) 는 보존.
  // dormant 상태(proc=null)이면 재spawn.
  let ch = ptyChannels.get(sess.id);
  if (ch && ch.proc && ch.proc.exitCode === null) return ch;  // alive
  if (ch && ch.spawning) return ch;  // 진행 중 spawn — 중복 진입 차단

  const isNewChannel = !ch;
  if (isNewChannel) {
    ch = {
      proc: null,
      sess,
      parser: null,
      lineBuf: '',
      rawLog: [],
      stderrLog: [],
      subscribers: new Map(),
      debounceTimer: null,
      lastTurnsJson: '',
      claudeId: null,
      pendingDialogs: new Map(),
      alive: false,
      inboxStop: null,     // IOA 인박스 watcher stop fn
      signedInAs: null,    // 현재 watcher가 추적 중인 ioa_id
      spawning: false,     // spawn 진행 플래그 (중복 진입 방어)
    };
    ptyChannels.set(sess.id, ch);

    // broadcast / scheduleTurns 클로저는 한 번만 생성 (parser 와 함께)
    ch.broadcast = (msg) => {
      for (const [wsLocal, ids] of ch.subscribers) {
        if (wsLocal.readyState !== wsLocal.OPEN) continue;
        for (const cid of ids) wsLocal.send(JSON.stringify({ ...msg, id: cid }));
      }
    };
    ch.scheduleTurns = () => {
      if (ch.debounceTimer) return;
      ch.debounceTimer = setTimeout(() => {
        ch.debounceTimer = null;
        const snap = ch.parser.snapshot();
        const json = JSON.stringify(snap.turns);
        if (json === ch.lastTurnsJson) return;
        ch.lastTurnsJson = json;
        ch.broadcast({ op: 'turns', turns: snap.turns, usage: snap.session.usage });
      }, 40);
    };
    ch.parser = new StreamParser({
      onTurn: () => ch.scheduleTurns(),
      onTurnUpdate: () => ch.scheduleTurns(),
      onSystem: (session) => ch.broadcast({ op: 'system', session }),
      onUsage:  (usage)   => ch.broadcast({ op: 'usage', usage }),
      onResult: (result, usage) => ch.broadcast({ op: 'result', result, usage }),
      onAskUserQuestion: ({ tool_use_id, input }) => {
        ch.pendingDialogs.set(tool_use_id, { input });
        ch.broadcast({ op: 'dialog', kind: 'AskUserQuestion', tool_use_id, input });
      },
      onHook: (evt) => ch.broadcast({ op: 'hook', event: evt }),
      onRateLimit: (info) => ch.broadcast({ op: 'rate_limit', info }),
    });
  }

  // proc spawn — spawning 플래그로 동시 진입 차단
  ch.spawning = true;
  let proc;
  try {
    const { args, isNew, claudeId, injectedEnv } = buildSpawnArgs(sess);
    if (isNew) {
      sessionState[sess.id] = {
        ...(sessionState[sess.id] || {}),
        claudeId,
        name: sess.name,
        cwd: sess.cwd,
        createdAt: sessionState[sess.id]?.createdAt || new Date().toISOString(),
      };
      saveState(sessionState);
    }
    ch.claudeId = claudeId;
    console.log(`[easyclaude] spawn ${sess.id} (${claudeId}) → claude ${args.join(' ')}`);

    const childEnv = {
      ...process.env,
      ...defaultClaudeEnv(),
      ...(injectedEnv || {}),
    };
    // sess.home 명시 override가 최우선. 그 외엔 ec 자체 overlay HOME 사용 (기본 ON).
    // cfg.overlay.enabled === false 로 명시한 경우에만 real HOME 사용.
    const overlayEnabled = !(cfg && cfg.overlay && cfg.overlay.enabled === false);
    if (sess.home) {
      childEnv.HOME = sess.home;
    } else if (overlayEnabled) {
      try {
        const ovHome = ensureOverlayHome(process.env.HOME);
        childEnv.HOME = ovHome;
        console.log(`[easyclaude] overlay HOME for ${sess.id}: ${ovHome}`);
      } catch (e) {
        console.error(`[easyclaude] overlay setup fail: ${e.message}`);
      }
    }

    proc = spawn('claude', args, {
      cwd: sess.cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdin.on('error', err => {
      console.error(`[easyclaude:${sess.id}:stdin] ${err.code || err.message}`);
    });

    ch.proc = proc;
    ch.alive = true;
    ch.lineBuf = '';
  } finally {
    ch.spawning = false;
  }

  proc.stdout.on('data', data => {
    ch.lineBuf += data;
    let nl;
    while ((nl = ch.lineBuf.indexOf('\n')) >= 0) {
      const line = ch.lineBuf.slice(0, nl).replace(/\r$/, '');
      ch.lineBuf = ch.lineBuf.slice(nl + 1);
      if (line) {
        ch.rawLog.push(line);
        if (ch.rawLog.length > 200) ch.rawLog.shift();
        ch.parser.feedLine(line);
        maybeStartInboxFromLine(ch, line);
      }
    }
  });

  proc.stderr.on('data', data => {
    const txt = String(data);
    console.error(`[easyclaude:${sess.id}:stderr] ${txt.trim()}`);
    ch.stderrLog.push(txt);
    if (ch.stderrLog.length > 100) ch.stderrLog.shift();
  });

  proc.on('exit', (exitCode, signal) => {
    console.log(`[easyclaude] claude exited: ${sess.id} (code=${exitCode}, signal=${signal})`);
    if (ch.debounceTimer) { clearTimeout(ch.debounceTimer); ch.debounceTimer = null; }
    if (ch.inboxStop) { try { ch.inboxStop(); } catch {} ch.inboxStop = null; ch.signedInAs = null; }
    const snap = ch.parser.snapshot();
    ch.broadcast({ op: 'turns', turns: snap.turns, usage: snap.session.usage });
    ch.broadcast({ op: 'closed', exitCode, signal, stderr: ch.stderrLog.join('').slice(-2000) });
    ch.alive = false;
    ch.proc = null;
    // ch 자체는 ptyChannels 에 유지 — parser/turns 보존
  });

  proc.on('error', err => {
    console.error(`[easyclaude] spawn error ${sess.id}:`, err.message);
    ch.broadcast({ op: 'closed', error: err.message });
    ch.alive = false;
    ch.proc = null;
  });

  return ch;
}

// ── IOA 인박스 watcher trigger ───────────────────────────────────────────────
// claude의 stdout 라인을 보고 signin/signup tool_result 감지 → watcher 자동 시작/교체.
function maybeStartInboxFromLine(ch, line) {
  const identity = detectAgentIdentity(line);
  if (!identity) return;
  if (ch.signedInAs === identity.ioa_id && ch.inboxStop) return; // 이미 watching 중
  if (ch.inboxStop) { try { ch.inboxStop(); } catch {} ch.inboxStop = null; }
  ch.signedInAs = identity.ioa_id;
  ch.inboxStop = startInboxWatcher(identity.data_dir, (event) => {
    const text = eventToChannelText(event, identity.ioa_id);
    sendUserText(ch, text);
  });
  console.log(`[easyclaude] inbox watcher: ${ch.sess.id} → ${identity.ioa_id} (${identity.data_dir})`);
}

// ── 입력 헬퍼 ────────────────────────────────────────────────────────────────
function notifyInputFailed(ch, kind, reason, message) {
  if (!ch || typeof ch.broadcast !== 'function') return;
  ch.broadcast({ op: 'input_failed', kind, reason, message: message || null });
}

function sendUserText(ch, text) {
  if (!ch.proc || ch.proc.exitCode !== null) {
    // dormant 채널 — 자동 재spawn (대화 이력 보존)
    spawnSession(ch.sess);
  }
  if (!ch.proc) {
    notifyInputFailed(ch, 'user_text', 'no_process');
    return false;
  }
  const line = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }) + '\n';
  try { ch.proc.stdin.write(line); return true; }
  catch (e) {
    console.error(`[easyclaude] stdin write fail: ${e.message}`);
    notifyInputFailed(ch, 'user_text', 'write_error', e.message);
    return false;
  }
}

function sendToolResult(ch, tool_use_id, content, isError) {
  if (!ch.proc || ch.proc.exitCode !== null) {
    spawnSession(ch.sess);
  }
  if (!ch.proc) {
    notifyInputFailed(ch, 'tool_result', 'no_process');
    return false;
  }
  const contentArr = typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : (Array.isArray(content) ? content : [{ type: 'text', text: JSON.stringify(content) }]);
  const line = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id,
        content: contentArr,
        is_error: !!isError,
      }],
    },
  }) + '\n';
  try { ch.proc.stdin.write(line); return true; }
  catch (e) {
    console.error(`[easyclaude] tool_result write fail: ${e.message}`);
    notifyInputFailed(ch, 'tool_result', 'write_error', e.message);
    return false;
  }
}

// ── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

// ── WS heartbeat: 30s마다 ping, 다음 주기 전까지 pong 없으면 terminate ────
const WS_HEARTBEAT_INTERVAL_MS = 30000;
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, WS_HEARTBEAT_INTERVAL_MS);

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const wsChannels = new Map(); // clientId → { sessionId }
  const send = obj => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { op, id } = msg;

    if (op === 'list') {
      return send({
        op: 'sessions',
        list: sessions().map(serializeForClient),
      });
    }

    if (op === 'create_session') {
      const { label, cwd, name, args, home } = msg;
      if (!label || !cwd) {
        return send({ op: 'error', id, message: 'label and cwd are required' });
      }
      const slug = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'session';
      let newId = slug;
      let i = 1;
      while (findSession(newId)) newId = `${slug}-${++i}`;
      const sess = normalizeSession({
        id: newId,
        label,
        cwd,
        name: name || label,
        args: Array.isArray(args) ? args : [],
        home: home || null,
        meta: { adhoc: true },
      });
      runtimeSessions.set(newId, sess);
      // 모든 연결 클라이언트에 새 sessions 목록 broadcast
      broadcastSessions();
      return send({ op: 'session_created', id, sessionId: newId });
    }

    if (op === 'delete_session') {
      const { sessionId } = msg;
      if (!runtimeSessions.has(sessionId)) {
        return send({ op: 'error', id, message: 'cannot delete (not adhoc or unknown)' });
      }
      const ch = ptyChannels.get(sessionId);
      if (ch) { try { ch.proc.kill(); } catch {} ptyChannels.delete(sessionId); }
      runtimeSessions.delete(sessionId);
      delete sessionState[sessionId];
      saveState(sessionState);
      broadcastSessions();
      return send({ op: 'session_deleted', id, sessionId });
    }

    if (op === 'purge_session') {
      // delete_session 보다 강함: claude jsonl 파일까지 삭제. claudeId 명시 가능.
      // cfg 세션도 hide. (config 파일은 수정하지 않음 — 메모리 hide 플래그로 처리)
      const { sessionId, claudeId } = msg;
      const targetClaudeId = claudeId || sessionState[sessionId]?.claudeId;
      const isCfg = (cfg.sessions || []).some(s => s.id === sessionId);
      if (sessionId) {
        const ch = ptyChannels.get(sessionId);
        if (ch) { try { ch.proc.kill(); } catch {} ptyChannels.delete(sessionId); }
        if (runtimeSessions.has(sessionId)) {
          runtimeSessions.delete(sessionId);
          delete sessionState[sessionId];
        } else if (isCfg) {
          // cfg 세션: hidden 플래그만 set (config 파일 보존, 재시작 후에도 hidden 유지)
          sessionState[sessionId] = { ...(sessionState[sessionId] || {}), hidden: true };
        } else {
          delete sessionState[sessionId];
        }
        saveState(sessionState);
      }
      let removedFiles = 0;
      if (targetClaudeId) removedFiles = deleteClaudeSessionFile(targetClaudeId);
      broadcastSessions();
      return send({ op: 'session_purged', id, sessionId, claudeId: targetClaudeId, removedFiles, hidden: isCfg });
    }

    if (op === 'unhide_session') {
      // hidden 플래그 해제 — cfg 세션 복원 (사용자가 잘못 누른 경우)
      const { sessionId } = msg;
      if (sessionState[sessionId]?.hidden) {
        delete sessionState[sessionId].hidden;
        if (Object.keys(sessionState[sessionId]).length === 0) delete sessionState[sessionId];
        saveState(sessionState);
        const list = sessions().map(s => ({ id: s.id, label: s.label, args: s.args, cwd: s.cwd, meta: s.meta }));
        wss.clients.forEach(c => {
          if (c.readyState === c.OPEN) c.send(JSON.stringify({ op: 'sessions', list }));
        });
      }
      return send({ op: 'session_unhidden', id, sessionId });
    }

    if (op === 'resume_session') {
      // 기존 claude session(uuid)을 ad-hoc 세션으로 import.
      const { label, cwd, name, args, claudeId, home } = msg;
      if (!claudeId || !cwd) {
        return send({ op: 'error', id, message: 'claudeId and cwd required' });
      }
      const slug = String(label || claudeId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'resumed';
      let newId = slug;
      let i = 1;
      while (findSession(newId)) newId = `${slug}-${++i}`;
      const sess = normalizeSession({
        id: newId,
        label: label || `resumed:${claudeId.slice(0,8)}`,
        cwd,
        name: name || label || null,
        args: Array.isArray(args) ? args : [],
        home: home || null,
        meta: { adhoc: true, resumed: true, fromClaudeId: claudeId },
      });
      runtimeSessions.set(newId, sess);
      // sessionState 에 claudeId 미리 설정 → spawn 시 --resume 사용
      sessionState[newId] = {
        claudeId, name: sess.name, cwd: sess.cwd,
        createdAt: new Date().toISOString(),
        resumedFrom: claudeId,
      };
      saveState(sessionState);
      broadcastSessions();
      return send({ op: 'session_created', id, sessionId: newId, resumed: true });
    }

    if (op === 'open') {
      if (wsChannels.has(id)) return send({ op: 'error', id, message: 'already open' });
      const sess = sessions().find(s => s.id === msg.sessionId);
      if (!sess) return send({ op: 'error', id, message: `unknown session: ${msg.sessionId}` });

      const ch = spawnSession(sess);
      if (!ch.subscribers.has(ws)) ch.subscribers.set(ws, new Set());
      ch.subscribers.get(ws).add(id);
      wsChannels.set(id, { sessionId: sess.id });

      send({
        op: 'opened', id,
        info: { pid: ch.proc.pid, sessionId: sess.id, label: sess.label, claudeId: ch.claudeId, ...sess.meta },
      });
      // 즉시 현재 turns + 보류 다이얼로그 송신 (catch-up)
      const snap = ch.parser.snapshot();
      send({ op: 'turns', id, turns: snap.turns, usage: snap.session.usage });
      if (snap.session.id) send({ op: 'system', id, session: snap.session });
      for (const [tool_use_id, pending] of ch.pendingDialogs) {
        send({ op: 'dialog', id, kind: 'AskUserQuestion', tool_use_id, input: pending.input });
      }
      return;
    }

    if (op === 'input') {
      const att = wsChannels.get(id);
      if (!att) return;
      const ch = ptyChannels.get(att.sessionId);
      if (!ch) return;
      let text = msg.data;
      if (!text || !text.trim()) return;
      text = maybeBashShortcut(text);
      sendUserText(ch, text);
      return;
    }

    if (op === 'interrupt') {
      // claude TUI의 ESC (현재 turn 중단) 상응. stream-json control_request 발사.
      // 출처: 비공식이나 reverse-engineering으로 확인된 control_request 프로토콜.
      const att = wsChannels.get(id);
      if (!att) return;
      const ch = ptyChannels.get(att.sessionId);
      if (!ch || !ch.proc || ch.proc.exitCode !== null) {
        return send({ op: 'error', id, message: 'session not running' });
      }
      const requestId = `int-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
      const line = JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'interrupt' },
      }) + '\n';
      try {
        ch.proc.stdin.write(line);
        send({ op: 'interrupt_sent', id, request_id: requestId });
      } catch (e) {
        send({ op: 'error', id, message: `interrupt write fail: ${e.message}` });
      }
      return;
    }

    if (op === 'dialog_response') {
      // AskUserQuestion 답변 송신
      const att = wsChannels.get(id);
      if (!att) return;
      const ch = ptyChannels.get(att.sessionId);
      if (!ch) return;
      const { tool_use_id, answers, cancelled } = msg;
      if (!ch.pendingDialogs.has(tool_use_id)) {
        return send({ op: 'error', id, message: `unknown tool_use_id: ${tool_use_id}` });
      }
      ch.pendingDialogs.delete(tool_use_id);
      const payload = cancelled ? '<cancelled>' : JSON.stringify({ answers });
      sendToolResult(ch, tool_use_id, payload, !!cancelled);
      return;
    }

    if (op === 'permission_response') {
      // GUI 측 권한 모달 결과를 받아 pending HTTP long-poll 응답을 해결한다.
      const { tool_use_id, behavior, updatedInput, message } = msg;
      if (!tool_use_id || (behavior !== 'allow' && behavior !== 'deny')) {
        return send({ op: 'error', id, message: 'permission_response requires tool_use_id + behavior' });
      }
      const out = { behavior };
      if (behavior === 'allow' && updatedInput !== undefined) out.updatedInput = updatedInput;
      if (message) out.message = String(message);
      const ok = resolvePermission(tool_use_id, out);
      send({ op: 'permission_resolved', id, tool_use_id, ok });
      return;
    }

    // 'interrupt' 중복 핸들러 제거 — 위 control_request 버전이 정상 (SIGINT은 stream-json proc에 잘못 작용)

    if (op === 'restart') {
      // 세션 재기동 — claudeId 보존, claude proc만 재spawn. args override 가능.
      const att = wsChannels.get(id);
      if (!att) return;
      if (msg.args !== undefined) {
        sessionState[att.sessionId] = sessionState[att.sessionId] || {};
        if (Array.isArray(msg.args)) sessionState[att.sessionId].argsOverride = msg.args;
        else delete sessionState[att.sessionId].argsOverride;
        saveState(sessionState);
      }
      const ch = ptyChannels.get(att.sessionId);
      if (ch && ch.proc) {
        try { ch.proc.kill(); } catch {}
        ch.proc = null;     // 즉시 dormant 처리 (spawnSession 이 respawn 하도록)
        ch.alive = false;
      }
      const sess = sessions().find(s => s.id === att.sessionId);
      if (!sess) return;
      const nch = spawnSession(sess);
      if (!nch.subscribers.has(ws)) nch.subscribers.set(ws, new Set());
      nch.subscribers.get(ws).add(id);
      broadcastSessions();
      send({ op: 'restarted', id, claudeId: nch.claudeId, alive: nch.alive });
      return;
    }

    if (op === 'close') {
      const att = wsChannels.get(id);
      if (!att) return;
      const ch = ptyChannels.get(att.sessionId);
      if (ch) {
        const ids = ch.subscribers.get(ws);
        if (ids) { ids.delete(id); if (ids.size === 0) ch.subscribers.delete(ws); }
      }
      wsChannels.delete(id);
      send({ op: 'detached', id });
      return;
    }
  });

  ws.on('close', () => {
    for (const ch of ptyChannels.values()) ch.subscribers.delete(ws);
    wsChannels.clear();
  });
});

// ── 안전망: uncaught → 로깅, process 유지 ────────────────────────────────────
process.on('uncaughtException', err => {
  console.error('[easyclaude:uncaught]', err && err.stack || err);
});
process.on('unhandledRejection', err => {
  console.error('[easyclaude:unhandledRejection]', err && err.stack || err);
});

// ── Shutdown ─────────────────────────────────────────────────────────────────
function shutdown() {
  saveState(sessionState);
  // 대기 중인 권한 요청은 모두 deny 로 닫는다 (claude 가 영원히 멈추지 않도록)
  for (const [tool_use_id, p] of pendingPermissions) {
    if (p.timer) clearTimeout(p.timer);
    try {
      p.res.writeHead(200, {'Content-Type':'application/json'});
      p.res.end(JSON.stringify({ behavior: 'deny', message: 'server shutdown' }));
    } catch {}
  }
  pendingPermissions.clear();
  for (const ch of ptyChannels.values()) { try { ch.proc.kill(); } catch {} }
  ptyChannels.clear();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

server.listen(PORT, HOST, () => {
  console.log(`[easyclaude] ${HOST}:${PORT}`);
  console.log(`[easyclaude] sessions: ${sessions().map(s => s.id).join(', ') || '(none)'}`);
});
