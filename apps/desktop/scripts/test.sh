#!/usr/bin/env bash
# Runs the swift-testing suites. Without Xcode, the Command Line Tools ship Testing.framework outside the default
# search path, so add it (XCTest is unavailable under CLT; every test here uses swift-testing).
# Extra args go to `swift test`. Env: TALOS_SWIFTPM_CACHE, TALOS_SWIFT_SCRATCH (CI uses both).
set -euo pipefail
cd "$(dirname "$0")/.."
command -v swift >/dev/null || { echo "test.sh: swift is not installed" >&2; exit 127; }

ARGS=()
[ -n "${TALOS_SWIFTPM_CACHE:-}" ] && ARGS+=(--cache-path "$TALOS_SWIFTPM_CACHE")
[ -n "${TALOS_SWIFT_SCRATCH:-}" ] && ARGS+=(--scratch-path "$TALOS_SWIFT_SCRATCH")

F=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
if ! xcodebuild -version >/dev/null 2>&1 && [ -d "$F" ]; then
  ARGS+=(-Xswiftc -F -Xswiftc "$F" -Xlinker -F -Xlinker "$F" -Xlinker -rpath -Xlinker "$F")
fi

exec swift test ${ARGS[@]+"${ARGS[@]}"} "$@"
