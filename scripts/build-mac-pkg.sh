#!/usr/bin/env bash
# easyclaude macOS .pkg 빌더 — Mac에서 실행
#
# 필요: Xcode Command Line Tools (pkgbuild, productbuild)
# 순서: build-mac-app.sh → build-mac-icon.sh → build-mac-pkg.sh
#
# 설치 내용:
#   /Applications/easyclaude.app
#   postinstall: Claude Code CLI (npm) 자동 설치
set -e

HERE="$(dirname "$(cd "$(dirname "$0")" && pwd)/$(basename "$0")")"
ROOT="$(dirname "$HERE")"
DIST="$ROOT/dist"
VERSION=$(node -e "console.log(require('$ROOT/package.json').version)" 2>/dev/null || echo "0.0.0")

# .app 찾기
APP="$(find "$DIST" -maxdepth 3 -name 'easyclaude.app' -type d | head -1)"
if [ -z "$APP" ]; then
  echo "오류: easyclaude.app 없음. build-mac-app.sh 먼저 실행하세요." >&2
  exit 1
fi

echo "[build-mac-pkg] easyclaude v$VERSION"
echo "[build-mac-pkg] 앱: $APP"

TMP="$(mktemp -d)"
PKG_ROOT="$TMP/pkg-root"
SCRIPTS="$TMP/scripts"
RESOURCES="$TMP/resources"
mkdir -p "$PKG_ROOT/Applications" "$SCRIPTS" "$RESOURCES"

# 앱 복사
echo "[build-mac-pkg] 앱 복사 중..."
cp -r "$APP" "$PKG_ROOT/Applications/"

# postinstall — Claude Code CLI 설치
cat > "$SCRIPTS/postinstall" <<'POSTINSTALL'
#!/bin/bash
echo "=== easyclaude 설치 후 처리 ==="

# 이미 설치됐으면 스킵
if command -v claude >/dev/null 2>&1; then
  echo "✓ Claude Code CLI 이미 설치됨"
  exit 0
fi

echo "Claude Code CLI 설치 중..."

# npm 경로 탐색 (Homebrew arm64 / 시스템 / nvm 등)
NPM=""
for p in \
  /opt/homebrew/bin/npm \
  /usr/local/bin/npm \
  /opt/homebrew/opt/node/bin/npm \
  "$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node/" 2>/dev/null | sort -V | tail -1)/bin/npm"; do
  if [ -x "$p" ]; then NPM="$p"; break; fi
done
if [ -z "$NPM" ]; then
  NPM="$(command -v npm 2>/dev/null || true)"
fi

if [ -n "$NPM" ] && [ -x "$NPM" ]; then
  "$NPM" install -g @anthropic-ai/claude-code && \
    echo "✓ Claude Code CLI 설치 완료" && exit 0
fi

# Homebrew 있으면 시도
if command -v brew >/dev/null 2>&1; then
  brew install node 2>/dev/null && \
    npm install -g @anthropic-ai/claude-code && \
    echo "✓ Claude Code CLI 설치 완료" && exit 0
fi

echo ""
echo "⚠ Claude Code CLI 자동 설치에 실패했습니다."
echo "  다음 중 하나로 수동 설치 후 easyclaude를 사용하세요:"
echo "    npm install -g @anthropic-ai/claude-code"
echo "    또는: https://claude.ai/download"
exit 0
POSTINSTALL
chmod +x "$SCRIPTS/postinstall"

# welcome 텍스트 (설치 마법사 소개 화면)
cat > "$RESOURCES/welcome.html" <<HTML
<!DOCTYPE html>
<html>
<body style="font-family:-apple-system;padding:20px">
  <h2>easyclaude v${VERSION}</h2>
  <p>Claude Code를 브라우저에서 멀티 세션으로 사용할 수 있는 워크벤치입니다.</p>
  <p>설치 후 <b>easyclaude.app</b>을 실행하면 브라우저에서 바로 사용할 수 있습니다.</p>
  <p style="color:#666;font-size:13px">Claude Code CLI가 없는 경우 설치 과정에서 자동으로 설치합니다.</p>
</body>
</html>
HTML

# 컴포넌트 pkg 생성
COMPONENT_PKG="$TMP/easyclaude-component.pkg"
echo "[build-mac-pkg] pkgbuild..."
pkgbuild \
  --root "$PKG_ROOT" \
  --scripts "$SCRIPTS" \
  --identifier "kr.philtoday.easyclaude" \
  --version "$VERSION" \
  --install-location "/" \
  "$COMPONENT_PKG"

# 최종 pkg (distribution)
PKG_OUT="$DIST/easyclaude-mac-v${VERSION}.pkg"
echo "[build-mac-pkg] productbuild..."
productbuild \
  --distribution <(cat <<DIST_XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="1">
  <title>easyclaude v${VERSION}</title>
  <welcome file="welcome.html" mime-type="text/html"/>
  <options customize="never" require-scripts="false" hostArchitectures="arm64"/>
  <pkg-ref id="kr.philtoday.easyclaude"/>
  <choices-outline>
    <line choice="default">
      <line choice="kr.philtoday.easyclaude"/>
    </line>
  </choices-outline>
  <choice id="default"/>
  <choice id="kr.philtoday.easyclaude" visible="false">
    <pkg-ref id="kr.philtoday.easyclaude"/>
  </choice>
  <pkg-ref id="kr.philtoday.easyclaude" version="${VERSION}" onConclusion="none">easyclaude-component.pkg</pkg-ref>
</installer-gui-script>
DIST_XML
  ) \
  --resources "$RESOURCES" \
  --package-path "$TMP" \
  "$PKG_OUT"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  pkg 빌드 완료!"
echo "╠══════════════════════════════════════╣"
echo "║  파일: $(basename "$PKG_OUT")"
echo "║  위치: $PKG_OUT"
echo "╠══════════════════════════════════════╣"
echo "║  설치 내용:"
echo "║    /Applications/easyclaude.app"
echo "║    Claude Code CLI (없으면 자동 설치)"
echo "╚══════════════════════════════════════╝"

rm -rf "$TMP"
