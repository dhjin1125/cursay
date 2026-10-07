#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="$ROOT/assets"
SOURCE="$ASSETS/icon-1024.png"
ICONSET="$ASSETS/AppIcon.iconset"
TRAY="$ASSETS/tray-template.png"
TRAY_RETINA="$ASSETS/tray-template@2x.png"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

mkdir -p "$ASSETS"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"

swift "$ROOT/scripts/generate-icon.swift" \
  "$TEMP_DIR/icon.png" \
  "$TEMP_DIR/tray.png" \
  "$TEMP_DIR/tray@2x.png"
sips -z 1024 1024 "$TEMP_DIR/icon.png" --out "$SOURCE" >/dev/null
sips -z 18 18 "$TEMP_DIR/tray.png" --out "$TRAY" >/dev/null
sips -z 36 36 "$TEMP_DIR/tray@2x.png" --out "$TRAY_RETINA" >/dev/null

make_icon() {
  local pixels="$1"
  local name="$2"
  sips -z "$pixels" "$pixels" "$SOURCE" --out "$ICONSET/$name" >/dev/null
}

make_icon 16 icon_16x16.png
make_icon 32 icon_16x16@2x.png
make_icon 32 icon_32x32.png
make_icon 64 icon_32x32@2x.png
make_icon 128 icon_128x128.png
make_icon 256 icon_128x128@2x.png
make_icon 256 icon_256x256.png
make_icon 512 icon_256x256@2x.png
make_icon 512 icon_512x512.png
cp "$SOURCE" "$ICONSET/icon_512x512@2x.png"

iconutil -c icns "$ICONSET" -o "$ASSETS/icon.icns"
