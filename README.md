# easyclaude

Claude Code(`claude` CLI) 의 `--output-format stream-json` 출력을 그대로 받아 웹 UI로
보여주는 가벼운 멀티-세션 GUI입니다. xterm.js 없이 동작하며, 권한 다이얼로그·세션 검색·
영구 삭제·테마 / 로고 커스터마이즈 등을 지원합니다.

## 특징

- **단일 stream-json 파이프라인** — claude를 `-p --input-format stream-json --output-format stream-json`
  으로 spawn해 JSON 라인 단위로 양방향 통신.
- **세션 영속화** — `--session-id` 로 새 세션 시작, 재기동 시 `--resume <uuid>`. 메모리에 사라지지 않음.
- **검색 부활** — 사용자의 모든 `~/.claude/projects/*/<uuid>.jsonl` 스캔. cwd / 키워드 필터링 후 부활.
- **권한 다이얼로그 (easypermitter MCP)** — claude의 `--permission-prompt-tool` 인터페이스를 통해 GUI 모달로
  허용/거부 응답. stream-json 모드에서도 동작.
- **AskUserQuestion** — claude의 인터랙티브 질문 툴을 모달 폼으로 응답.
- **테마 / 로고** — `default` (따뜻한 크림 + 코랄), `PhilToday` (포털 디자인 + PhilConsole 라벨), 커스텀 토큰 / SVG.
- **멀티 Claude home** — 한 호스트에서 여러 `.claude` 디렉토리를 선택 spawn (각자 다른 OAuth 계정, 세션 분리).
- **MCP 상태 표시** — `system/init` 의 `mcp_servers` 배열을 헤더 인디케이터로 라이브 표시.
- **jsonl tail 헬퍼** — `easyclaude-tail <session-id>` 로 진짜 raw 스트림을 터미널에서 직접 모니터링.

## 요구

- Node 20+ (`ws` 와 `child_process.spawn` 만 사용, 무거운 deps 없음)
- `claude` CLI 2.1+ 가 PATH 에 있음

## 설치

### 시스템

```bash
sudo ./install.sh
# /opt/easyclaude/ 에 코드 설치
# /usr/local/bin/easyclaude, /usr/local/bin/easyclaude-tail 심볼릭 링크
# /etc/systemd/system/easyclaude.service 추가
```

### 사용자 단독

```bash
./install.sh --user
# ~/.local/lib/easyclaude/ 에 코드
# ~/.local/bin/easyclaude 심볼릭 링크
```

### 수동

```bash
git clone <repo> easyclaude
cd easyclaude
npm install --production
./bin/easyclaude
```

## 설정

XDG 경로 우선:

- 설정 (사용자별): `~/.config/easyclaude/config.json`
- 상태 (세션 매핑): `~/.local/share/easyclaude/state.json`

또는 환경 변수로 override:

- `EASYCLAUDE_CONFIG=/path/to/config.json`
- `EASYCLAUDE_STATE=/path/to/state.json`
- `PORT=7860`
- `HOST=127.0.0.1`

config 예시:

```json
{
  "port": 7860,
  "host": "127.0.0.1",
  "defaultArgs": [
    "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--include-hook-events",
    "--include-partial-messages",
    "--replay-user-messages",
    "--verbose"
  ],
  "sessions": [
    {
      "id": "scratch",
      "label": "Scratch",
      "cwd": "/home/me/projects/scratch",
      "name": "Scratch",
      "args": ["--permission-mode", "bypassPermissions"],
      "home": null
    }
  ]
}
```

세션 옵션:

- `cwd`: claude 실행 디렉토리 (대화 컨텍스트)
- `name`: claude `--name` (식별용 라벨)
- `args`: defaultArgs 뒤에 붙는 추가 인자 (예: `--model sonnet[1m]`, `--permission-prompt-tool ...`)
- `home`: `HOME` 환경변수 override — `.claude/` 위치를 옮기고 싶을 때
- `meta.adhoc`: 사용자가 + 버튼으로 만든 임시 세션 (서버 재시작 시 메모리에서 사라짐, 단 claudeId는 state.json 에 영속)

## UI 동작

### 새 세션

좌측 사이드바의 **＋ 새 세션** 버튼:

- **새 세션** 탭 — label / cwd / 표시 이름 / 추가 인자 / Claude home 선택. 프리셋 버튼으로 권한 우회 /
  권한 확인 (easypermitter) / Opus 1M / Sonnet 1M 인자 추가.
- **기존 부활** 탭 — `~/.claude/projects/` 스캔, cwd / 키워드 필터링, 결과 클릭 후 [부활] 누르면
  `--resume <uuid>` 로 ad-hoc 세션 추가. 부활 시에도 추가 인자(모델 / 권한 등) 새로 부여 가능.

### 영구 삭제

탭 우측의 ✕ 버튼:

- ad-hoc 세션 → `purge_session` (jsonl 파일까지 삭제, 되돌릴 수 없음).
- cfg 세션 → `hidden: true` 플래그로 메모리 hide (config 파일은 안 건드림, 재시작 후에도 hidden 유지).
  `unhide_session` op 로 복원 가능.

### 권한 확인 (easypermitter)

`--permission-prompt-tool mcp__easypermitter__permission_prompt` 인자를 가진 세션은 모든 tool 호출 전
GUI 모달로 사용자에게 묻습니다. 응답:

- **허용** — `behavior: "allow"`. 옵션으로 updatedInput JSON 편집, 메모 (claude에 전달).
- **거부** — `behavior: "deny"`. 메모 전달 가능.

서버가 죽거나 타임아웃(기본 5분, 최대 30분) 시 자동 deny.

### 테마 / 로고

설정 모달에서 변경. 변경은 즉시 적용되며 localStorage 에 저장됩니다.

- **테마 프리셋**: default / PhilToday / 커스텀.
- **로고 프리셋**: default / PhilToday (포털 SVG) / 커스텀 SVG / 없음.
- **타이틀 텍스트** override — 비우면 프리셋 기본값 (PhilToday 시 "PhilConsole").
- **커스텀 테마** 토큰: bg / surface / text / accent / border. 다크 모드 여부도 선택.

### MCP / settings.json

설정 모달의 "Claude 인증 / 설정" 섹션:

- 각 home 카드: 경로, 이메일, 로그인 상태, 쓰기 가능 여부.
- [settings.json 편집] — raw JSON 편집기 (저장 시 유효성 검사). MCP 서버 추가 / 제거 / 환경변수 등.
- [jsonl 위치] — 활성 세션의 jsonl 절대 경로 표시 (tail -f 용).

settings.json 수정 후 실행 중 세션에 반영하려면 **재기동** 필요 (탭 ↻ 버튼).

## 직접 raw 스트림 모니터링

```bash
easyclaude-tail <session-id>            # ec 세션 ID 로 조회
easyclaude-tail <claude-uuid>           # claude 세션 UUID 로 직접
# 또는
tail -f ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
```

read-only 이므로 실행 중인 세션에 영향 없음.

## API

### REST

- `GET /health`
- `GET /api/sessions`
- `GET /api/sessions/history?cwd=&q=&limit=` — `~/.claude/projects/` 검색
- `GET /api/sessions/<sid>/jsonl-path`
- `GET /api/claude-homes` — 사용 가능한 `.claude` 디렉토리 후보
- `GET /api/auth/status?home=` — `claude auth status --json`
- `GET /api/claude-settings?home=` / `PUT` — settings.json 읽기 / 쓰기
- `GET /api/debug/<sid>/{turns,raw,usage,session}`

### WebSocket

- `list` / `sessions`
- `open` / `opened` / `closed` / `restart` / `restarted` / `interrupt`
- `input` (사용자 텍스트) / `turns` (서버 → 클라이언트 누적 turn 목록)
- `create_session` / `session_created` / `resume_session`
- `delete_session` / `purge_session` / `session_purged` / `unhide_session`
- `dialog` (AskUserQuestion / PermissionPrompt) / `dialog_response` / `permission_response`
- `system` (init) / `usage` / `result` / `hook`

### easypermitter MCP 브리지

- `POST /api/permitter/request` — easypermitter 가 long-poll 등록 (max 30분)
- `POST /api/permitter/respond` — GUI / 외부에서 응답 (`{tool_use_id, behavior, updatedInput?, message?}`)
- `GET /api/permitter/pending` — 대기 중인 요청 목록

## 디자인 메모

- claude `-p` 모드 + stream-json 입출력 + `--replay-user-messages` 조합이 핵심. `-p` 는 stdin 즉시
  입력 없으면 종료하지만 `--replay-user-messages` 가 stdin 대기를 가능하게 함.
- AskUserQuestion 응답은 `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":...,"content":[{"text": "<json>"}]}]}}` 로 stdin.
- 권한 응답은 MCP tool 의 단일 text content block 으로 `{"behavior":"allow|deny","updatedInput":..,"message":..}`.
- `system/init` 의 `mcp_servers[].status` 가 라이브 MCP 상태. `connected` / `failed` / `needs-auth`.

## 라이선스

MIT — 자세한 내용은 LICENSE 참조.
