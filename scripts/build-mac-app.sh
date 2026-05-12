#!/usr/bin/env bash
# easyclaude macOS .app 번들 빌더 (node.js 번들 포함 — zero-dependency)
#
# 출력: dist/easyclaude-mac-v<ver>.zip
#   easyclaude.app          ← 앱 (node 22 LTS arm64 번들)
#   시작하기.command          ← 더블클릭 → quarantine 제거 + 앱 실행
#   README.txt
#
# 아이콘은 별도: easyclaude build-mac-icon (mac에서 한 번 실행 필요)
set -e

HERE="$(dirname "$(readlink -f "$0")")"
ROOT="$(dirname "$HERE")"
DIST="$ROOT/dist"
APP="$DIST/easyclaude.app"
RES="$APP/Contents/Resources"
MACOS="$APP/Contents/MacOS"

NODE_VERSION="${EC_NODE_VERSION:-v22.22.2}"
NODE_URL_ARM="https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-darwin-arm64.tar.gz"
NODE_CACHE="$DIST/.node-cache"

VERSION=$(node -e "console.log(require('$ROOT/package.json').version)" 2>/dev/null || echo "0.0.0")

echo "[build-mac] easyclaude v$VERSION — Node.js $NODE_VERSION 번들"
echo "[build-mac] target: $APP"

rm -rf "$APP"
mkdir -p "$MACOS" "$RES/app" "$RES/node-arm64" "$NODE_CACHE"

# 1) node 다운로드 + 압축 해제 (캐시 사용)
download_node() {
  local url="$1" arch="$2"
  local dst="$RES/node-${arch}"
  local cache="$NODE_CACHE/node-${arch}.tar.gz"
  if [ ! -f "$cache" ]; then
    echo "[build-mac] downloading node ${arch}..."
    curl -# -L "$url" -o "$cache"
  else
    echo "[build-mac] using cached node ${arch}"
  fi
  echo "[build-mac] extracting node ${arch}..."
  mkdir -p "$dst/bin"
  local inner_path="node-${NODE_VERSION}-darwin-${arch}/bin/node"
  # 단일 파일 추출 후 복사
  local tmp_extract
  tmp_extract="$(mktemp -d)"
  tar -xzf "$cache" -C "$tmp_extract" "$inner_path" 2>/dev/null
  if [ -f "$tmp_extract/${inner_path}" ]; then
    cp "$tmp_extract/${inner_path}" "$dst/bin/node"
    chmod +x "$dst/bin/node"
    echo "[build-mac] node ${arch} → $dst/bin/node ($(du -sh "$dst/bin/node" | awk '{print $1}'))"
  else
    echo "[build-mac] WARNING: ${inner_path} not in tar — trying fallback"
    tar -xzf "$cache" -C "$tmp_extract"
    local found
    found="$(find "$tmp_extract" -name 'node' -type f | head -1)"
    if [ -n "$found" ]; then
      cp "$found" "$dst/bin/node"
      chmod +x "$dst/bin/node"
      echo "[build-mac] node ${arch} (fallback) → $dst/bin/node"
    else
      echo "[build-mac] ERROR: node binary not found for ${arch}"
    fi
  fi
  rm -rf "$tmp_extract"
}

download_node "$NODE_URL_ARM" "arm64"

# 2) ec 소스 복사
echo "[build-mac] copying ec sources..."
rsync -a --delete \
  --exclude='.git' \
  --exclude='dist' \
  --exclude='*.log' \
  --exclude='.node-cache' \
  "$ROOT/" "$RES/app/"

# 3) Info.plist
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
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>CFBundleIconFile</key><string>AppIcon</string>
</dict>
</plist>
EOF

# 4) launcher
cat > "$MACOS/easyclaude" <<'LAUNCHER'
#!/bin/bash
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
RES="$HERE/../Resources"
APP_DIR="$RES/app"
LOG_DIR="$HOME/Library/Logs/easyclaude"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/server.log"
PID_FILE="$LOG_DIR/server.pid"

NODE="$RES/node-arm64/bin/node"
if [ ! -x "$NODE" ]; then
  # fallback: 시스템 node
  for p in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -n "$p" ] && [ -x "$p" ]; then NODE="$p"; break; fi
  done
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  osascript -e 'display alert "실행 오류" message "실행할 수 없습니다. easyclaude 팀에 문의하세요." as critical'
  exit 1
fi

# 이미 실행 중이면 브라우저만 열기
if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || echo)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    open "http://127.0.0.1:7860"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

# ec server 실행
"$NODE" "$APP_DIR/server/index.js" >> "$LOG" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

# listen 대기 (최대 6초)
for i in 1 2 3 4 5 6; do
  nc -z 127.0.0.1 7860 2>/dev/null && break
  sleep 1
done

open "http://127.0.0.1:7860"

# 앱 종료 시 server kill
cleanup() { kill "$SERVER_PID" 2>/dev/null; rm -f "$PID_FILE"; }
trap cleanup EXIT INT TERM HUP
wait "$SERVER_PID" 2>/dev/null || true
LAUNCHER
chmod +x "$MACOS/easyclaude"

# 5) 배포 폴더 구성 + zip
echo "[build-mac] preparing distribution folder..."
DEPLOY_DIR="$DIST/easyclaude-mac-v${VERSION}"
rm -rf "$DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR"

# .app 이동
mv "$APP" "$DEPLOY_DIR/easyclaude.app"

# 시작하기.command
cat > "$DEPLOY_DIR/시작하기.command" <<'CMD'
#!/bin/bash
# easyclaude 시작 도우미 — quarantine 해제 + 앱 실행
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$APP_DIR/easyclaude.app"
if [ ! -d "$APP" ]; then
  echo "easyclaude.app을 같은 폴더에 두고 실행하세요."
  exit 1
fi
echo "easyclaude를 시작합니다..."
xattr -cr "$APP" 2>/dev/null || true
open "$APP"
echo "브라우저에서 http://127.0.0.1:7860 이 열립니다."
CMD
chmod +x "$DEPLOY_DIR/시작하기.command"

# README
cat > "$DEPLOY_DIR/README.txt" <<README
easyclaude v${VERSION} — Claude Code 멀티 세션 워크벤치
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

시작하는 법:
  1. 이 폴더에서 "시작하기.command" 파일을 더블클릭하세요.
  2. macOS 보안 경고가 뜨면 "열기"를 클릭하세요.
  3. 브라우저에서 http://127.0.0.1:7860 이 자동으로 열립니다.

다음부터는:
  easyclaude.app 을 응용 프로그램 폴더로 이동 후 더블클릭으로 바로 실행.

문의: wj@philtoday.kr
README

# zip
echo "[build-mac] creating zip..."
ZIP="$DIST/easyclaude-mac-v${VERSION}.zip"
(cd "$DIST" && zip -qr "$ZIP" "easyclaude-mac-v${VERSION}/")
SIZE=$(du -sh "$ZIP" | awk '{print $1}')

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  빌드 완료!"
echo "╠══════════════════════════════════════╣"
echo "║  zip : $(basename "$ZIP") ($SIZE)"
echo "║  위치: $ZIP"
echo "╠══════════════════════════════════════╣"
echo "║  테스터 배포 흐름:"
echo "║    1. zip 전달 → 압축 해제"
echo "║    2. 시작하기.command 더블클릭"
echo "║    3. http://127.0.0.1:7860 자동 열림"
echo "╠══════════════════════════════════════╣"
echo "║  아이콘 추가 (선택):"
echo "║    easyclaude build-mac-icon"
echo "║    (mac에서 한 번만 실행 — .icns 생성)"
echo "╚══════════════════════════════════════╝"
