# easyclaude

[공개 베타] 클로드 코드를 더 쉽게, easyclaude. 한글 씹히는 ttyd, 스크롤 안 되는 tmux,
코드 탭에 매번 들어가야 하는 Claude 클라이언트. easyclaude는 이 모든 것에 질려 만든
통합 솔루션입니다. 당신의 에이전트를 서버에 띄워 PC와 모바일, 집과 버스, 사무실 등
모든 환경에서 지연 없이 이용하세요. 하원재가 설계하고 오늘의 철학 AI 에이전트 Arche가
짓습니다. (프론트엔드는 프로토타입으로 개선 예정. 미구현 상태의 슬래시 커맨드들 또한
v1.0에서 구현 예정. 베타는 수시로 업데이트됩니다.)

## 빠른 시작

```bash
git clone https://github.com/wj-philtoday/easyclaude.git
cd easyclaude
./bin/easyclaude install --user       # ~/.local/lib/easyclaude/ 설치 + ~/.local/bin 링크
easyclaude                            # 7860 포트로 listen
# http://127.0.0.1:7860 접속
```

업그레이드:

```bash
easyclaude update                     # git pull + npm install + 프로세스 재기동
```

서브커맨드 한눈에:

```
easyclaude [run]            서버 실행 (기본)
easyclaude install [opts]   설치 (sudo / --user / --no-systemd / --prefix)
easyclaude update           최신 main pull + npm install + 재기동
easyclaude tail <sid|uuid>  활성 세션 jsonl tail
easyclaude help             도움말
```

## 특징

- **단일 stream-json 파이프라인** — `claude --input-format stream-json --output-format stream-json`
  으로 spawn해 JSON 라인 단위 양방향 통신. ANSI 파서·xterm 없음.
- **세션 영속** — `--session-id` 새 세션, 재기동 시 `--resume <uuid>`. 메모리에서 안 사라짐.
- **대화 in-place 무한 스크롤** — 위로 스크롤하면 옛 turn을 페이지네이션 로드 (모달 없음).
- **단일 ec HOME (overlay)** — 모든 claude 세션이 격리된 `~/.local/share/easyclaude/overlay/`
  를 HOME으로 spawn. real HOME 의 user-scope mcp/plugin은 첫 부팅 시 자동 시드,
  대화 jsonl(`~/.claude/projects/`)은 symlink로 공유.
- **OAuth/장기 토큰 인증** — claude `auth login` / `setup-token` 을 PTY로 wrap해 URL/code
  GUI 흐름 자동화. setup-token 결과는 ec 영역(`oauth_tokens.json`, 0600) native 저장 후
  spawn 시 `CLAUDE_CODE_OAUTH_TOKEN` 자동 주입.
- **확장(MCP·Plugin·Skill) scope별 viewer/편집** — user / project / local 3개 scope에서
  add / edit / delete / enable / disable. mcp는 활성 세션에 `/mcp` slash inject로 재연결.
- **권한 다이얼로그 (easypermitter MCP)** — `--permission-prompt-tool` 인터페이스로 GUI 모달
  허용/거부. stream-json 모드에서도 동작.
- **인증/리밋 stalled UX** — claude가 미인증/usage-limit 응답 시 대화창 하단에 액션 배너
  (로그인 / 장기토큰 / 모델변경 / 재기동 / 대기).
- **홈 대시보드** — 세션·인증·overlay HOME 상태 카드 + 최근 세션 6개. 상단 타이틀/로고
  클릭이 홈.
- **테마/로고** — default / PhilToday / 커스텀 토큰·SVG.
- **모바일 대응** — touch scroll, 안전영역 padding, BFCache 복귀 시 자동 reload, ⋮ 메뉴
  viewport-fit.

## 요구 사항

- Node 20+ (`ws` 와 `child_process.spawn` 만 사용)
- `claude` CLI 2.1+ 가 PATH 에 있음
- `util-linux` (`script`) — claude PTY 래핑용

## 설치

```bash
# 사용자 단독 (sudo 불필요, ~/.local/lib/easyclaude/)
easyclaude install --user

# 시스템 전체 (sudo 필요, /opt/easyclaude/ + /etc/systemd/system/easyclaude.service)
sudo easyclaude install
sudo easyclaude install --no-systemd   # systemd 유닛 안 만들 때
sudo easyclaude install --prefix /opt/ec   # 위치 변경
```

설치 디렉토리에는 `.git` 워킹트리 + 코드 + node_modules 가 그대로 들어갑니다.
이후 `easyclaude update` 가 같은 위치에서 `git pull` 합니다.

## 경로

| 종류 | 경로 |
|------|------|
| ec 설정 | `~/.config/easyclaude/config.json` |
| ec 상태 (sid→claudeId 매핑) | `~/.local/share/easyclaude/state.json` |
| ec native OAuth 토큰 | `~/.local/share/easyclaude/oauth_tokens.json` (0600) |
| overlay HOME | `~/.local/share/easyclaude/overlay/` |
| claude 대화 jsonl | `~/.claude/projects/` (overlay에서 symlink 공유) |

환경변수 override:

```
EASYCLAUDE_CONFIG=/path/to/config.json
EASYCLAUDE_STATE=/path/to/state.json
PORT=7860
HOST=127.0.0.1
```

## 설정 — 두 종류

1. **ec 설정 (`~/.config/easyclaude/config.json`)** — port·host·defaultArgs·sessions·overlay·
   formatting·bashShortcut 등. 설정 모달의 "ec 설정 열기" 에서 스니펫 form + 고급 JSON 편집.
   저장 후 ec 재기동 필요(부팅 1회 로드).
2. **claude settings.json** — claude 자체 동작 설정. 설정 모달의 "ec 환경" 카드의 details 안
   "고급: claude settings.json 직접 편집" (raw JSON editor).
3. **확장(MCP/Plugin/Skill)** — 활성 세션 ⓘ 모달의 "확장" 섹션. scope별 추가/편집/삭제/토글,
   mcp 재연결.

## UI

- **홈 대시보드** — 세션 / 인증 / overlay 상태 + 빠른 액션 + 최근 세션. 상단 타이틀/로고 클릭.
- **새 세션** — 사이드바 `＋` 버튼. label / cwd / 표시 이름 / 추가 인자 / claude HOME override
  선택. 프리셋: 권한 우회 · 권한 확인(easypermitter) · Opus 1M · Sonnet 1M.
- **기존 부활** — `~/.claude/projects/` 스캔, cwd / 키워드 필터, `--resume <uuid>` 로 ad-hoc 세션.
- **탭 ✕** — 보관(숨김). cfg 세션은 hidden 플래그, adhoc은 목록 제거(jsonl 보존). 영구 삭제는
  탭 ⋮ 메뉴.
- **대화창** — 위 스크롤 시 옛 turn 자동 로드. 비-발화 turn(tool_call·result·meta·…) 은 연속
  구간이 `<details>` 그룹으로 자동 접힘.

## API 요약

REST:

```
GET  /health
GET  /api/sessions
GET  /api/sessions/history?cwd=&q=&limit=
GET  /api/sessions/<sid>/history-turns?before=&limit=    # 파스된 turn 페이지네이션
GET  /api/sessions/<sid>/jsonl-path
GET  /api/ec-home                                        # ec가 쓰는 단일 HOME
GET  /api/auth/status?home=                              # claude auth status
POST /api/auth/login         {method, email?, home}
POST /api/auth/setup-token   {home}                      # 장기 토큰 발급 + ec 저장
POST /api/auth/paste-code    {home, code}
POST /api/auth/logout        {home}
GET  /api/scoped/extensions?sid=                         # user/project/local 합본
GET  /api/scoped/extension/details?sid&scope&kind&name
POST /api/scoped/extension/save   {sid,scope,kind,name,config,oldName?}
POST /api/scoped/extension/delete {sid,scope,kind,name}
POST /api/scoped/toggle      {sid,scope,kind,name,enabled}
POST /api/sessions/<sid>/inject   {text}                 # slash 등 stdin 주입
GET  /api/ec-config / PUT                                # ec 자체 cfg.json
GET  /api/claude-settings?home= / PUT                    # claude settings.json (고급)
```

WebSocket op (요약):

```
list / sessions
open / opened / close / restart / restarted / interrupt
input → turns / system / usage / result / hook / rate_limit / input_failed
create_session / session_created / resume_session
delete_session / purge_session / session_purged / unhide_session
dialog / dialog_response / permission_response
```

## 라이선스

MIT — LICENSE 참조.
