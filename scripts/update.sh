#!/usr/bin/env bash
# easyclaude update — git pull origin main + npm install + 프로세스 재기동.
# systemd 유닛이 있으면 systemctl restart, 아니면 nohup setsid 로 재spawn.
set -e
HERE="$(dirname "$(readlink -f "$0")")"
ROOT="$(dirname "$HERE")"
cd "$ROOT"

echo "[easyclaude:update] target: $ROOT"

if [ ! -d "$ROOT/.git" ]; then
  echo "  (.git 없음 — git clone 으로 받은 작업트리에서만 update 가능)" >&2
  exit 1
fi

echo "[easyclaude:update] git fetch + pull origin main"
git fetch origin main
git pull --ff-only origin main

if [ -f "$ROOT/package.json" ]; then
  echo "[easyclaude:update] npm install (production)"
  npm install --production --no-audit --no-fund
fi

# 재기동
if systemctl list-units --type=service 2>/dev/null | grep -q '^easyclaude\.service'; then
  echo "[easyclaude:update] systemctl restart easyclaude"
  if [ "$(id -u)" = 0 ]; then
    systemctl restart easyclaude
  else
    sudo systemctl restart easyclaude
  fi
elif pgrep -f 'easyclaude/server/index\.js' >/dev/null; then
  echo "[easyclaude:update] respawn (nohup setsid)"
  pkill -f 'easyclaude/server/index\.js' || true
  sleep 1
  LOG="${EASYCLAUDE_LOG:-/tmp/easyclaude.log}"
  nohup setsid node "$ROOT/server/index.js" >> "$LOG" 2>&1 < /dev/null &
  disown
  sleep 1
  if pgrep -f 'easyclaude/server/index\.js' >/dev/null; then
    echo "  → respawned (PID $(pgrep -f 'easyclaude/server/index\.js' | head -1))"
  else
    echo "  ⚠ respawn 실패 — 로그: $LOG" >&2
  fi
else
  echo "  (실행 중인 프로세스 없음 — 'easyclaude' 로 시작하세요)"
fi

echo "[easyclaude:update] 완료. 브라우저 강제 새로고침으로 client 적용 확인."
