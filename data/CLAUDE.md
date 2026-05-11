# easyclaude (EC) base context

이 세션은 easyclaude(EC)의 overlay HOME으로 spawn되었습니다. EC 특화 행동은 `~/.claude/skills/ec-toolkit/SKILL.md` 참조.

## 기본 원칙
- 모든 응답은 명확하고 간결하게.
- 출력 포맷팅은 EC config 강제 사항에 따른다 (있으면 Markdown / MathJax).
- IOA 채널 push (`<channel source="ioa" ...>`)는 외부에서 도착한 알림. 즉시 대응 필요 시 처리, 단순 알림이면 상황 인지만.

## 컨텍스트 확장
- user-level (`~/.claude/CLAUDE.md`): EC config의 `overlay.claudeMd.refs.user` 토글에 따라 @-참조됨.
- project-level (`<cwd>/CLAUDE.md`, `<cwd>/.claude/CLAUDE.md`): claude code가 cwd 기준 자동 탐색.

## EC 메커니즘 요약
EC는 사용자의 진짜 `~/.claude/` 를 손대지 않는다. credentials/settings/skills 등은 EC overlay에 독립 보관. project-level 자료(`<cwd>/.claude/*`)는 cwd 자동 탐색이라 자연 적용.
