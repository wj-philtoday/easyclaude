#!/usr/bin/env bash
# easyclaude macOS 아이콘 빌더 — mac에서 한 번 실행.
# client/logo.svg → AppIcon.icns → .app 에 복사.
# 사전 조건: 이미 build-mac-app.sh 로 .app 이 dist/ 에 있어야 함.
set -e

HERE="$(dirname "$(readlink -f "$0")")"
ROOT="$(dirname "$HERE")"
DIST="$ROOT/dist"

# dist 안의 .app 찾기
APP="$(find "$DIST" -maxdepth 3 -name 'easyclaude.app' | head -1)"
if [ -z "$APP" ]; then
  echo "오류: dist/ 안에 easyclaude.app 이 없습니다. 먼저 'easyclaude build-mac' 실행." >&2
  exit 1
fi

SVG="$ROOT/client/logo.svg"
if [ ! -f "$SVG" ]; then
  echo "오류: client/logo.svg 없음" >&2
  exit 1
fi

TMP="$(mktemp -d)"
ICONSET="$TMP/AppIcon.iconset"
mkdir -p "$ICONSET"

echo "[build-mac-icon] SVG → PNG (여러 크기)..."
for size in 16 32 64 128 256 512 1024; do
  # sips는 png→png. SVG는 rsvg 또는 qlmanage. 여기선 qlmanage (macOS 기본) 사용.
  # qlmanage가 없으면 오류 안내.
  out="$TMP/icon_${size}.png"
  if command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w "$size" -h "$size" "$SVG" -o "$out"
  elif command -v convert >/dev/null 2>&1; then
    convert -background none -resize "${size}x${size}" "$SVG" "$out"
  else
    # Automator / sips 로 우회 (svg → pdf → png)
    # 간단히 qlmanage 사용
    qlmanage -t -s "$size" -o "$TMP" "$SVG" 2>/dev/null || true
    mv "$TMP/logo.svg.png" "$out" 2>/dev/null || true
  fi
  if [ ! -f "$out" ]; then
    echo "WARNING: size $size 생성 실패 — rsvg-convert 또는 ImageMagick 설치 권장"
    continue
  fi
  # iconset 형식에 맞게 복사
  case "$size" in
    16)   cp "$out" "$ICONSET/icon_16x16.png";    cp "$out" "$ICONSET/icon_16x16@1x.png"   ;;
    32)   cp "$out" "$ICONSET/icon_16x16@2x.png"; cp "$out" "$ICONSET/icon_32x32.png"      ;;
    64)   cp "$out" "$ICONSET/icon_32x32@2x.png"                                            ;;
    128)  cp "$out" "$ICONSET/icon_128x128.png";  cp "$out" "$ICONSET/icon_128x128@1x.png" ;;
    256)  cp "$out" "$ICONSET/icon_128x128@2x.png"; cp "$out" "$ICONSET/icon_256x256.png"  ;;
    512)  cp "$out" "$ICONSET/icon_256x256@2x.png"; cp "$out" "$ICONSET/icon_512x512.png"  ;;
    1024) cp "$out" "$ICONSET/icon_512x512@2x.png"                                          ;;
  esac
done

echo "[build-mac-icon] iconutil .icns 생성..."
ICNS="$TMP/AppIcon.icns"
iconutil -c icns -o "$ICNS" "$ICONSET"

# .app 에 설치
RES="$APP/Contents/Resources"
mkdir -p "$RES"
cp "$ICNS" "$RES/AppIcon.icns"
echo "[build-mac-icon] 완료 → $RES/AppIcon.icns"

# zip 이 있으면 업데이트 안내
ZIP="$(find "$DIST" -maxdepth 1 -name '*.zip' | head -1)"
if [ -n "$ZIP" ]; then
  echo ""
  echo "zip을 다시 만들려면: easyclaude build-mac"
  echo "(아이콘 먼저 적용 후 zip 재생성하면 반영됨)"
fi

rm -rf "$TMP"
