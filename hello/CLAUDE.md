# easyclaude (EC) base context

이 세션은 easyclaude(EC)에 의해 spawn되었습니다. EC 특화 행동은 `~/.claude/skills/ec-toolkit/SKILL.md` 참조.

## 기본 원칙
- 모든 응답은 명확하고 간결하게.
- 출력 포맷팅은 EC config 강제 사항에 따른다 (있으면 Markdown / MathJax).
- IOA 채널 push (`<channel source="ioa" ...>`)는 외부에서 도착한 알림. 즉시 대응 필요 시 처리, 단순 알림이면 상황 인지만.

## 컨텍스트 확장
- 이 파일은 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`로 모든 EC 세션에 자동 주입됩니다.
- user-level (`~/.claude/CLAUDE.md`): 실제 HOME의 사용자 CLAUDE.md가 그대로 적용됩니다.
- project-level (`<cwd>/CLAUDE.md`, `<cwd>/.claude/CLAUDE.md`): claude code가 cwd 기준 자동 탐색.

## EC 메커니즘 요약
EC는 사용자의 실제 `~/.claude/` 를 HOME으로 사용합니다. EC 자체 설정은 `CLAUDE_CONFIG_DIR=~/.easyclaude` 경유로 격리되며, EC 세션 ID는 `CLAUDE_CODE_SESSION_ID`로 안정적으로 식별됩니다.
