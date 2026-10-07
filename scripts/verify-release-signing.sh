#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/release/mac-arm64/Cursay.app}"
NATIVE_HELPER="$APP/Contents/Resources/native/Codex Voice Control.app"

source "$ROOT/scripts/codesign-config.sh"

codesign --verify --deep --strict --verbose=2 "$APP"
cvc_assert_designated_requirement "$APP" "$CVC_MAIN_REQUIREMENT"
cvc_assert_designated_requirement "$NATIVE_HELPER" "$CVC_NATIVE_HELPER_REQUIREMENT"

echo "Release signatures are valid and use stable designated requirements."
