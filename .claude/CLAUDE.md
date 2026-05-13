# EC Doctor

easyclaude (EC) 서버 진단 및 관리 세션입니다.

## 경로
- 코드: `/opt/easyclaude/`
- 데이터: `~/.local/share/easyclaude/` (state.json, sup/, overlay/)
- 설정: `~/.config/easyclaude/config.json`
- 로그: `/tmp/easyclaude.log`
- Supervisor daemon: `~/.local/share/easyclaude/sup/.daemon.log`

## 주요 명령
```bash
# 상태 확인
curl -s http://localhost:7860/api/status | python3 -m json.tool

# 재기동 (graceful)
curl -s -X POST http://localhost:7860/api/restart

# 로그 실시간 확인
tail -f /tmp/easyclaude.log

# Supervisor daemon 로그
tail -f ~/.local/share/easyclaude/sup/.daemon.log

# 직접 재시작 (EC 다운 시)
nohup setsid node /opt/easyclaude/server/index.js >> /tmp/easyclaude.log 2>&1 < /dev/null &
```

## 아키텍처 참조
- `~/.arche/memo/easyclaude_architecture.md`
- `~/.arche/memo/easyclaude_audit_2026-05-11.md`
