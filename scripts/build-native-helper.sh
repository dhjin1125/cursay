#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/native/build/Codex Voice Control.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
EXECUTABLE="$MACOS/Codex Voice Control"
SOURCE="$ROOT/native/Sources/CodexVoiceActionHelper/main.swift"

if [[ "${CURSAY_FORCE_NATIVE_REBUILD:-0}" != "1" ]] \
  && [[ -x "$EXECUTABLE" ]] \
  && [[ "$EXECUTABLE" -nt "$SOURCE" ]] \
  && [[ "$CONTENTS/Info.plist" -nt "$ROOT/native/Info.plist" ]] \
  && codesign --verify --strict "$APP" >/dev/null 2>&1; then
  exit 0
fi

source "$ROOT/scripts/codesign-config.sh"

rm -rf "$APP"
mkdir -p "$MACOS"
cp "$ROOT/native/Info.plist" "$CONTENTS/Info.plist"

swiftc \
  -O \
  -target arm64-apple-macos13.0 \
  -framework Cocoa \
  -framework ApplicationServices \
  -framework Network \
  "$SOURCE" \
  -o "$EXECUTABLE"

chmod 755 "$MACOS/Codex Voice Control"
cvc_sign_adhoc \
  "$APP" \
  "$CVC_NATIVE_HELPER_IDENTIFIER" \
  "$CVC_NATIVE_HELPER_REQUIREMENT" \
  >/dev/null

codesign --verify --strict --verbose=2 "$APP"
cvc_assert_designated_requirement "$APP" "$CVC_NATIVE_HELPER_REQUIREMENT"
