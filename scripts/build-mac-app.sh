#!/usr/bin/env bash
# easyclaude macOS .app 번들 빌더.
#
# 출력: dist/easyclaude.app/ + dist/easyclaude-mac.tar.gz
# 테스터 사용:
#   1. tar.gz 다운로드 후 압축 해제
#   2. easyclaude.app 우클릭 → 열기 (서명 없음 → Gatekeeper 우회)
#   3. http://127.0.0.1:7860 가 자동으로 열림
#
# 의존: 테스터 mac에 node 20+ 설치 필요 (brew install node 또는 nodejs.org).
set -e

HERE="$(dirname "$(readlink -f "$0")")"
ROOT="$(dirname "$HERE")"
DIST="$ROOT/dist"
APP="$DIST/easyclaude.app"
RES="$APP/Contents/Resources"
MACOS="$APP/Contents/MacOS"

VERSION=$(node -e "console.log(require('$ROOT/package.json').version)" 2>/dev/null || echo "0.0.0")

echo "[build-mac] target: $APP (version=$VERSION)"

rm -rf "$APP"
mkdir -p "$MACOS" "$RES/app"

# 1) ec 소스 복사 (node_modules 포함, .git/dist/사용자데이터 제외)
echo "[build-mac] copy sources..."
rsync -a --delete \
  --exclude='.git' \
  --exclude='dist' \
  --exclude='*.log' \
  --exclude='.arche*' \
  --exclude='node_modules/.cache' \
  "$ROOT/" "$RES/app/"

# 2) Info.plist
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>easyclaude</string>
  <key>CFBundleDisplayName</key><string>easyclaude</string>
  <key>CFBundleIdentifier</key><string>kr.philtoday.easyclaude</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>easyclaude</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSUIElement</key><false/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
EOF

# 3) launcher (Contents/MacOS/easyclaude)
cat > "$MACOS/easyclaude" <<'LAUNCHER_EOF'
#!/bin/bash
# easyclaude .app launcher
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$HERE/../Resources/app" && pwd)"
LOG_DIR="$HOME/Library/Logs/easyclaude"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/server.log"
PID_FILE="$LOG_DIR/server.pid"

# node 찾기 (PATH + 일반 위치)
find_node() {
  for p in \
    "$(command -v node 2>/dev/null)" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.nvm/versions/node/v20"*"/bin/node" \
    "$HOME/.volta/bin/node"; do
    if [ -n "$p" ] && [ -x "$p" ]; then echo "$p"; return; fi
  done
}
NODE="$(find_node)"
if [ -z "$NODE" ]; then
  osascript -e 'display alert "node.js가 필요합니다" message "easyclaude는 Node.js 20+ 가 필요합니다.\n\nbrew install node\n또는 https://nodejs.org/ 에서 설치 후 다시 실행하세요." as critical'
  exit 1
fi

# 이미 실행 중이면 그냥 브라우저만 열기
if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || echo)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    open "http://127.0.0.1:7860"
    exit 0
  fi
fi

# npm install (첫 실행 시)
if [ ! -d "$APP_DIR/node_modules/ws" ]; then
  if command -v npm >/dev/null 2>&1; then
    (cd "$APP_DIR" && npm install --production --no-audit --no-fund) >> "$LOG" 2>&1 || true
  fi
fi

# ec server 백그라운드 spawn
"$NODE" "$APP_DIR/server/index.js" >> "$LOG" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

# server listen 대기 (최대 5초)
for i in 1 2 3 4 5; do
  if nc -z 127.0.0.1 7860 2>/dev/null; then break; fi
  sleep 1
done

# 브라우저 열기
open "http://127.0.0.1:7860"

# 사용자가 .app 종료(cmd+Q)할 때까지 wait → 종료 시 server kill
trap 'kill "$SERVER_PID" 2>/dev/null; rm -f "$PID_FILE"' EXIT INT TERM
wait "$SERVER_PID" 2>/dev/null || true
LAUNCHER_EOF
chmod +x "$MACOS/easyclaude"

# 4) 아이콘 (logo.svg가 있으면 단순 placeholder; .icns 변환은 mac에서만 가능)
# 일단 placeholder 텍스트 파일로 두고, 실제 .icns 는 mac에서 sips/iconutil로 생성하는 build-mac-icon.sh 별도.

# 5) tar.gz 패키징
echo "[build-mac] packaging tar.gz..."
TAR="$DIST/easyclaude-mac-v${VERSION}.tar.gz"
(cd "$DIST" && tar -czf "$TAR" easyclaude.app)
SIZE=$(du -sh "$TAR" | awk '{print $1}')

echo "[build-mac] 완료"
echo "  app   : $APP"
echo "  tar   : $TAR ($SIZE)"
echo ""
echo "테스터 안내:"
echo "  1) tar.gz 받아 압축 풀기"
echo "  2) easyclaude.app 우클릭 → 열기 (Gatekeeper 우회)"
echo "  3) Node.js 20+ 미설치 시 alert로 안내됨"
