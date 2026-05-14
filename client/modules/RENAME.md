# 변수/함수 namespace 정규화 매핑

분리 작업 중 변경 누락 방지용 추적 파일.

## 원칙
- 모든 글로벌 변수/함수: dot-path namespace로 정규화
- `X(Y.Z) → X.Y(Z)` 변환 가능하도록, 함수 namespace의 마지막 = 인자의 첫 namespace
- 각 카테고리는 자기 namespace 안에 함수/state/dom 보유
- 공유 state는 `state.*` 전역 트리

## 공유 state 트리

```
state.session
  .active          (현재 활성 sid; 이전: activeSid)
  .list            (세션 목록 배열; 이전: ecSessions)
  .channels        (Map<sid, channel>; 이전: channels)
  .lastActive      (이전: lastActiveSid)
  .pendingReopen   (이전: pendingReopenSid)
state.tab
  .prefs           (이전: tabPrefs)
  .collapsedGroups (이전: collapsedGroups)
state.system
  .ws              (WebSocket 인스턴스; 이전: ws)
  .outboundQueue   (이전: outboundQueue)
  .reconnect.attempts (이전: reconnectAttempts)
  .reconnect.timer    (이전: reconnectTimer)
  .nextClientId    (이전: nextClientId)
  .claudeOptions   (이전: claudeOptions)
state.modal
  .dialog          (현재 다이얼로그 상태; 이전: currentDialog)
  .core.create.tab            (이전: nsActiveTab)
  .core.create.resumeSelected (이전: nsResumeSelected)
  .core.create.searchDebounce (이전: searchDebounce)
state.modal.config.auth.pollTimer (이전: lgPollTimer)
state.ui
  .toast.timer     (이전: _toastTimer)
  .ac.idx          (이전: acIdx)
state.chat.message.cachedHomeMsg (이전: _cachedHomeMsg)
state.chat.info.currentArgs       (이전: _infoCurrentArgs)
state.cfg                         (이전: cfg)
```

## DOM 참조 (각 모듈의 `.dom` 안)

```
core.sidebar.dom
  .nav             (이전: $nav)
  .tabs            (이전: $tabs)
  .ham             (이전: $ham)
  .settingsBtn     (이전: $settingsBtn)
core.header.dom
  .logo            (#ec-logo)
  .title           (#ec-title)
chat.message.dom
  .parsed          (이전: $parsed)
  .scrollBottom    (이전: $scrollBottom)
chat.input.dom
  .textarea        (이전: $input)
  .send            (이전: $send)
  .interrupt       (이전: $interrupt)
  .ac              (이전: $ac)
chat.info.dom
  .activeLabel     (이전: $activeLabel)
  .status          (이전: $status)
  .usage           (이전: $usage)
  .viewbarUsage    (이전: $viewbarUsage)
  .restart         (이전: $restart)
  .disconnect      (이전: $disconnect)
modal.core.dom.newSession.* (이전: $newSession, $nsLabel, $nsCwd, $nsName, $nsArgs, $newSessionClose, $newSessionCancel, $newSessionCreate)
modal.chat.dom.dialog.*     (이전: $dialog, $dialogTitle, $dialogBody, $dialogCancel, $dialogSubmit, $dialogClose)
modal.config.dom            (이전: $settings, $settingsClose)
```

## 주요 함수 매핑

### core.system
- `$` (DOM helper) → `core.system.dom.$`
- `esc` → `core.system.format.esc`
- `T(key)` (i18n) → `core.system.i18n.t`
- `apiBase()` → `core.system.api.base`
- `fmtNum`, `fmtTok` → `core.system.format.num`, `.tok`
- `saveCfg`, `applyCfg`, `syncSettingsForm`, `loadLogoSvg` → `core.system.cfg.{save,apply,syncForm,loadLogo}`
- `connect`, `sendWs`, `onMsg` → `core.system.ws.{connect,send,handle}`
- `setStatus` → 공유 함수, `core.system`이 emit, `chat.info`가 render
- `showToast` → `core.system.toast.show`
- `tokenizeArgs`, `loadCustomPresets`, `saveCustomPresets`, `applyPresetToTarget`, `renderCustomPresets`
  → `core.system.preset.{tokenize,load,save,apply,render}`

### core.header
- 코드 거의 없음. 햄버거 토글, 로고/타이틀 cfg 적용 정도

### core.sidebar
- `renderTabs`, `appendTabSection`, `createTabElement`, `effectiveLabel`, `syncSessionLabel`
  → `core.sidebar.tab.{render,appendSection,create,label,sync}`
- `getTabPref`, `setTabPref`, `tabSortKey` → `core.sidebar.tab.prefs.{get,set,sortKey}`
- `handleTabDelete`, `handleTabPurge`, `handleTabClose`, `activate`, `openSession`, `refreshTabState`, `updateInputBar`
  → `core.sidebar.tab.actions.{delete,purge,close,activate,open,refresh,updateInput}`
- `loadHiddenStore`, `saveHiddenStore`, `rememberHiddenSession`, `forgetHiddenSession`
  → `core.sidebar.tab.hidden.{load,save,remember,forget}`

### chat.message
- `renderActive` → `chat.message.render`
- `ecRenderBody`, `ecTypeset` → `chat.message.body.{render,typeset}`
- `getRenderMd`, `setRenderMd`, `getRenderMathJax`, `setRenderMathJax` → `chat.message.render.{getMd,setMd,getMath,setMath}`
- `shouldHideTurn`, `extractCmd` → `chat.message.turn.{shouldHide,extractCmd}`
- `showDebugEvents`, `setShowDebugEvents` → `chat.message.debug.{get,set}`
- `renderHome`, `_genHomeMsg`, `_setHomeStatus`, `_cachedHomeMsg` → `chat.message.welcome.*`
- `renderStalledBanner`, `wireStalledBanner` → `chat.message.stalled.{render,wire}`
- `loadMoreHistory` → `chat.message.history.loadMore`
- `updateScrollBtnPos` → `chat.message.scroll.updateBtnPos`

### chat.input
- `sendInput`, `autosize`, `updateInputBar` → `chat.input.{send,autosize,update}`
- `renderPermPill` → `chat.input.permPill.render` (또는 chat.info? — pill 위치는 viewbar라 chat.info)
- `updateAc`, `moveAc`, `fillAc`, `hideAc` → `chat.input.autocomplete.{update,move,fill,hide}`
- `runEcSlash`, `showSlashResult` → `chat.input.slash.{run,showResult}`

### chat.info
- `renderUsage` → `chat.info.usage.render`
- `setStatus` (연결 상태 표시) → `chat.info.status.set`
- `effectiveLabel` 표시 부분 → `chat.info.label.update`
- `renderPermPill` 실제 표시 위치 → `chat.info.perm.render` (코드 옮김)

### modal.core
- `showTabMenu` → `modal.core.menu.show`
- `showMiniModal` → `modal.core.base.show`
- `showGroupModal`, `showPermModal`, `showModelModal` → `modal.core.{group,perm,model}.show`
- `showNewSessionModal`, `hideNewSessionModal`, `setNsTab`, `populateHomeSelectors`, `searchHistory`, `scheduleSearch`
  → `modal.core.create.{show,hide,setTab,populateHomes,search,scheduleSearch}`

### modal.chat
- info 패널: `openInfoPanel`, `loadAndRenderExtensions`, `openExtEdit`, `syncMcpFormVisibility`, `buildExtConfigFromForm`
  → `modal.chat.info.{open,extension.load,extension.openEdit,extension.syncMcp,extension.buildConfig}`
- Claude dialog: `showDialog`, `renderPermissionDialog`, `renderAskUserQuestionDialog`, `collectPermissionResponse`, `hideDialog`, `collectDialogAnswers`
  → `modal.chat.dialog.{show,renderPerm,renderAsk,collectPerm,hide,collectAnswers}`
- `parseControlsFromArgs`, `patchArgs`, `loadClaudeOptions` → `modal.chat.info.controls.*`

### modal.config
- 외관: 폰트크기/테마/로고/타이틀/유저명/언어 — cfg 안의 값들
- 렌더링: 마크다운/MathJax
- 안전: bypassPermissions
- 응답포맷 강제 (ece-fmt-*)
- 환경변수: `loadEcEnvPanel`, `saveEcEnvPanel`, `renderEcEnvRow`, `renderEcEnvExtraRow` → `modal.config.env.*`
- 디버그
- 버전/업데이트: `loadVersionInfo` → `modal.config.version.load`
- 숨김세션: `renderHiddenSessions` → `modal.config.hidden.render`
- 홈/인증 (사이드 home 패널 → modal.config로): `goHome`, `renderHomesList`, `openSettingsEdit`, `openLogin`, `pollAuth`, `extractAuthCode`, `doLogout`, `showJsonlPath`, `openEcConfigEdit`
  → `modal.config.home.*`, `modal.config.auth.*`

## 처리 순서
1. ✅ 매핑 표 (이 파일)
2. 9개 모듈 골격 (빈 namespace 객체) + state 트리 정의
3. `core.system.js` — 헬퍼들 먼저 (다른 모듈이 의존)
4. `core.sidebar.js` — 탭 관련
5. `chat.message.js`, `chat.input.js`, `chat.info.js`
6. `modal.core.js`, `modal.chat.js`, `modal.config.js`
7. `core.header.js` (작음, 마지막)
8. app.js — entry point + 이벤트 바인딩만 남김
9. index.html에 `<script>` 로드 순서 추가
