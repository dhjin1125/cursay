#!/usr/bin/env bash

# Keep these requirements independent of a build's ad-hoc CDHash. macOS TCC
# stores the designated requirement when Accessibility/Microphone access is
# granted, so a CDHash-only requirement makes every rebuild look like a new app.
readonly CVC_MAIN_IDENTIFIER="local.minkyu.CodexVoiceControl"
readonly CVC_NATIVE_HELPER_IDENTIFIER="local.minkyu.CodexVoiceActionHelper"

readonly CVC_MAIN_REQUIREMENT="designated => identifier \"$CVC_MAIN_IDENTIFIER\""
readonly CVC_NATIVE_HELPER_REQUIREMENT="designated => identifier \"$CVC_NATIVE_HELPER_IDENTIFIER\""

cvc_sign_adhoc() {
  local bundle="$1"
  local identifier="$2"
  local requirement="$3"

  codesign \
    --force \
    --sign - \
    --timestamp=none \
    --identifier "$identifier" \
    --requirements "=$requirement" \
    "$bundle"
}

cvc_designated_requirement() {
  local bundle="$1"

  codesign -d -r- "$bundle" 2>&1 \
    | sed -n 's/^# //; /^designated => /p' \
    | tail -1
}

cvc_assert_designated_requirement() {
  local bundle="$1"
  local expected="$2"
  local actual

  actual="$(cvc_designated_requirement "$bundle")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Unexpected designated requirement for $bundle" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   ${actual:-<missing>}" >&2
    return 1
  fi
}
