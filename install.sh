#!/usr/bin/env bash
# easyclaude 시스템 설치
#   /opt/easyclaude/        ← 코드 (이 스크립트가 있는 디렉토리에서 복사)
#   /usr/local/bin/easyclaude       ← entrypoint 심볼릭 링크
#   /usr/local/bin/easyclaude-tail  ← tail 헬퍼 심볼릭 링크
#   /etc/systemd/system/easyclaude.service  ← (선택) systemd unit
#
# 사용자 설정/상태는 XDG 경로 사용:
#   ~/.config/easyclaude/config.json
#   ~/.local/share/easyclaude/state.json
#
# 옵션:
#   --prefix /opt/easyclaude    설치 위치 변경
#   --no-systemd                systemd unit 설치 안 함
#   --user                      user-level 설치 (~/.local/lib/easyclaude/)
set -e

PREFIX=/opt/easyclaude
INSTALL_SYSTEMD=1
USER_MODE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --no-systemd) INSTALL_SYSTEMD=0; shift ;;
    --user) USER_MODE=1; INSTALL_SYSTEMD=0; PREFIX="$HOME/.local/lib/easyclaude"; shift ;;
    --help) sed -n '2,/^set -e/p' "$0" | sed 's/^# //'; exit 0 ;;
    *) echo "알 수 없는 옵션: $1"; exit 2 ;;
  esac
done

SRC="$(dirname "$(readlink -f "$0")")"
echo "[easyclaude] src: $SRC"
echo "[easyclaude] target: $PREFIX"

# sudo 필요 여부
if [ "$USER_MODE" = 0 ] && [ "$(id -u)" != 0 ]; then
  echo "system-wide 설치는 sudo로 실행하세요. (또는 --user 사용)"
  exit 1
fi

# 1. 코드 복사
mkdir -p "$PREFIX"
rsync -a --delete \
  --exclude=node_modules \
  --exclude='.git' \
  --exclude='*.state.json' \
  --exclude='examples/*/easyclaude.config.state.json' \
  "$SRC/" "$PREFIX/"

# 2. node_modules 설치
echo "[easyclaude] npm install (production)…"
cd "$PREFIX"
npm install --production --no-audit --no-fund

# 3. 심볼릭 링크
if [ "$USER_MODE" = 0 ]; then
  BIN_DIR=/usr/local/bin
else
  BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"
fi
ln -sf "$PREFIX/bin/easyclaude" "$BIN_DIR/easyclaude"
ln -sf "$PREFIX/bin/easyclaude-tail" "$BIN_DIR/easyclaude-tail"
echo "[easyclaude] linked: $BIN_DIR/easyclaude, $BIN_DIR/easyclaude-tail"

# 4. systemd unit (system-wide만)
if [ "$INSTALL_SYSTEMD" = 1 ]; then
  cat > /etc/systemd/system/easyclaude.service << EOF
[Unit]
Description=easyclaude — Claude Code stream-json GUI
After=network.target

[Service]
Type=simple
ExecStart=$PREFIX/bin/easyclaude
Restart=on-failure
RestartSec=5
User=%i
Group=%i
Environment=HOME=/home/%i

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  echo "[easyclaude] systemd unit: /etc/systemd/system/easyclaude.service"
  echo "  사용: systemctl --user enable --now easyclaude  (또는 @user 인스턴스로 system)"
fi

# 5. 기본 config 생성 (없을 때만)
USER_CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/easyclaude"
mkdir -p "$USER_CFG_DIR"
if [ ! -f "$USER_CFG_DIR/config.json" ]; then
  cat > "$USER_CFG_DIR/config.json" << 'EOF'
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
  "sessions": []
}
EOF
  echo "[easyclaude] default config: $USER_CFG_DIR/config.json"
fi

mkdir -p "${XDG_DATA_HOME:-$HOME/.local/share}/easyclaude"

echo
echo "[easyclaude] 설치 완료."
echo "  실행: easyclaude"
echo "  config: $USER_CFG_DIR/config.json"
echo "  state:  ${XDG_DATA_HOME:-$HOME/.local/share}/easyclaude/state.json"
