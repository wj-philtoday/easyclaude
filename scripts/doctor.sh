#!/bin/bash
# easyclaude doctor — EC 진단/관리 전용 Claude 세션
# 사용: easyclaude doctor  또는  bash /opt/easyclaude/scripts/doctor.sh

set -e

EC_DIR="/opt/easyclaude"
CWD="$EC_DIR"

# EC overlay HOME의 claude 바이너리 우선, fallback은 which claude
OVERLAY_HOME="${HOME}/.local/share/easyclaude/overlay"
CLAUDE_BIN="${OVERLAY_HOME}/.local/bin/claude"
if [ ! -x "$CLAUDE_BIN" ]; then
  CLAUDE_BIN="$(which claude 2>/dev/null || echo 'claude')"
fi

# EC 프로젝트 디렉터리에서 가장 최근 세션 찾아 resume
CWD_HASH=$(python3 -c "import sys; p=sys.argv[1]; print(p.replace('/','-').strip('-'))" "$CWD" 2>/dev/null || echo "opt-easyclaude")
PROJECTS_DIR="${OVERLAY_HOME}/.claude/projects"
SESSION_ID=""
if [ -d "${PROJECTS_DIR}/${CWD_HASH}" ]; then
  LATEST=$(ls -t "${PROJECTS_DIR}/${CWD_HASH}"/*.jsonl 2>/dev/null | head -1)
  if [ -n "$LATEST" ]; then
    SESSION_ID=$(basename "$LATEST" .jsonl)
  fi
fi

if [ -n "$SESSION_ID" ]; then
  echo "[ec-doctor] resuming session $SESSION_ID"
  exec "$CLAUDE_BIN" --resume "$SESSION_ID" --cwd "$CWD"
else
  echo "[ec-doctor] starting new EC doctor session in $CWD"
  exec "$CLAUDE_BIN" --cwd "$CWD"
fi
