---
name: ec-toolkit
description: easyclaude (EC) 환경에서만 활성화되는 기본 도구 가이드. IOA 채널 push 처리, EC 슬래시 상응 API, Bash 단축 변환, overlay HOME 동작 등 EC 특화 행동을 정리. 비-EC 컨텍스트면 무시.
---

# easyclaude Toolkit

이 skill은 **easyclaude로 spawn된 claude 세션에서만 의미가 있다**. 일반 claude TUI/CLI 환경이면 즉시 무시.

## EC 컨텍스트 자기 확인
- 환경 변수 `HOME`이 `.local/share/easyclaude/overlay`로 끝나면 EC overlay 안.
- 또는 stream-json 모드 (`--output-format stream-json` 인자)면 EC 가능성 높음.
- 둘 다 아니면 EC 컨텍스트 아님 — 본 skill 적용 보류.

## EC가 제공하는 추가 행동

### 1. IOA 채널 push
`<channel source="ioa" ioa_id="..." from="..." type="...">` 형식의 user 메시지가 도착하면 외부 푸시.
- `type`: inbox / calendar / notification 등
- `from`: 발신자 ioa_id
- 처리: 본문 읽고 필요 시 `mcp__ioa__*` 도구로 응답

### 2. Slash 상응 API
TUI `/usage`, `/status`, `/stats`, `/doctor` 등은 EC에서 `/api/slash/*` HTTP 엔드포인트로 대체.
사용자가 `/usage` 입력하면 EC가 인터셉트해서 모달로 결과 표시 — claude가 직접 처리할 필요 없음.

### 3. Bash 단축
사용자 입력 `! command` 는 EC가 `! \`command\`` 형태로 변환 후 전송.
즉 claude가 backtick 안의 명령을 직접 실행하는 shortcut으로 인식.

### 4. Overlay HOME
EC는 spawn 시 `HOME`을 overlay 디렉토리로 override:
- settings.json: EC 전용 (full override)
- credentials.json: EC 전용 (별도 `/login`)
- skills/: EC 번들 + cwd 자동탐색
- CLAUDE.md: EC base + 토글 가능한 @-refs

사용자의 진짜 `~/.claude/` 는 안 건드림. project-level `<cwd>/.claude/*` 는 cwd 기반 자동 탐색.

## 응답 포맷팅
EC config의 `formatting` 토글에 따라 다음이 강제될 수 있음 (`--append-system-prompt`로 주입):
- Markdown 적극 활용
- MathJax 수식 (`$...$`, `$$...$$`)

해당 강제가 있으면 따르고, 없으면 자연스러운 텍스트로.

## 참고
구체적 EC 운영 절차나 API 명세는 [README](https://github.com/wj-philtoday/easyclaude) 참조.
