#!/usr/bin/env bash
# easyclaude restart — ec server process만 재기동. supervisor + 자식 claude는 detach되어 살아남음.
#
# 안전장치:
# 1. 호출자 HOME이 overlay 경로일 수 있으므로 /etc/passwd에서 real HOME 조회해 명시 주입.
#    (nested overlay 경로에 state.json이 잘못 생성되는 문제 방지)
# 2. helper script를 임시 파일로 작성 후 setsid로 분리 spawn → 호출자가 죽어도 진행.
# 3. ec server 재기동 후 10초간 /api/status health check, 실패 시 로그에 기록.
# 4. setsid로 새 session/process group 분리 → 호출자 SIGHUP/SIGTERM이 전파되지 않음.

set -e
HERE="$(dirname "$(readlink -f "$0")")"
ROOT="$(dirname "$HERE")"
LOG="${EASYCLAUDE_LOG:-/tmp/easyclaude.log}"
PORT="${EASYCLAUDE_PORT:-7860}"
HOST="${EASYCLAUDE_HOST:-127.0.0.1}"

REAL_HOME="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6)"
if [ -z "$REAL_HOME" ] || [ ! -d "$REAL_HOME" ]; then
  REAL_HOME="$HOME"
fi

HELPER="$(mktemp -t ec-restart.XXXXXX.sh)"
cat > "$HELPER" <<EOF
#!/usr/bin/env bash
exec >> '$LOG' 2>&1
ts() { date '+%Y-%m-%d %H:%M:%S'; }
echo "[ec:restart \$(ts)] killing old ec server"
pkill -f '$ROOT/server/index.js' 2>/dev/null || true
# 포트가 free될 때까지 대기 (최대 5초)
for i in 1 2 3 4 5; do
  ss -tln 2>/dev/null | grep -q ":$PORT " || break
  sleep 1
done
echo "[ec:restart \$(ts)] starting new ec (HOME=$REAL_HOME)"
HOME='$REAL_HOME' setsid node '$ROOT/server/index.js' < /dev/null >> '$LOG' 2>&1 &
NEWPID=\$!
disown
# health check (최대 10초)
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -fs "http://$HOST:$PORT/api/status" > /dev/null 2>&1; then
    echo "[ec:restart \$(ts)] OK pid=\$NEWPID"
    rm -f '$HELPER'
    exit 0
  fi
done
echo "[ec:restart \$(ts)] FAILED pid=\$NEWPID — port $PORT not responding after 10s"
rm -f '$HELPER'
exit 1
EOF
chmod +x "$HELPER"

# setsid로 새 session 분리 → 호출자 죽어도 helper 진행
setsid bash "$HELPER" < /dev/null > /dev/null 2>&1 &
disown
echo "[easyclaude:restart] scheduled (HOME=$REAL_HOME, health check 10s)"
