#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/release/mac-arm64/Cursay.app}"
NATIVE_HELPER="$APP/Contents/Resources/native/Codex Voice Control.app"

source "$ROOT/scripts/codesign-config.sh"

if [[ ! -d "$APP" ]]; then
  echo "Packaged app not found: $APP" >&2
  exit 1
fi

# First sign Electron's complete nested bundle graph. Then replace the two TCC
# clients with stable designated requirements and reseal only the outer bundle.
codesign \
  --force \
  --deep \
  --sign - \
  --timestamp=none \
  "$APP"

if [[ ! -d "$NATIVE_HELPER" ]]; then
  echo "Packaged native helper not found: $NATIVE_HELPER" >&2
  exit 1
fi

cvc_sign_adhoc \
  "$NATIVE_HELPER" \
  "$CVC_NATIVE_HELPER_IDENTIFIER" \
  "$CVC_NATIVE_HELPER_REQUIREMENT"

cvc_sign_adhoc \
  "$APP" \
  "$CVC_MAIN_IDENTIFIER" \
  "$CVC_MAIN_REQUIREMENT"

codesign --verify --deep --strict --verbose=2 "$APP"
cvc_assert_designated_requirement "$APP" "$CVC_MAIN_REQUIREMENT"
cvc_assert_designated_requirement "$NATIVE_HELPER" "$CVC_NATIVE_HELPER_REQUIREMENT"
