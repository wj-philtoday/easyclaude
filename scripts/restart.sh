#!/usr/bin/env bash
# easyclaude restart — ec server process만 재기동. supervisor + 자식 claude는 살아남음.
# 호출자가 ec 안의 자식이라도 안전: setsid로 새 process group 분리 후 background detach.
set -e
HERE="$(dirname "$(readlink -f "$0")")"
ROOT="$(dirname "$HERE")"
LOG="${EASYCLAUDE_LOG:-/tmp/easyclaude.log}"

# 별도 process tree로 분리 spawn — 호출자가 죽어도 진행됨.
setsid bash -c "
  sleep 1
  pkill -f '$ROOT/server/index.js' 2>/dev/null || true
  sleep 1
  nohup setsid node '$ROOT/server/index.js' >> '$LOG' 2>&1 < /dev/null &
  disown
" < /dev/null > /dev/null 2>&1 &
disown
echo "[easyclaude:restart] scheduled (1초 후 ec server 재기동, supervisor + claude는 보존)"
