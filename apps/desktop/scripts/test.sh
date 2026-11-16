#!/usr/bin/env bash
# Runs the swift-testing suites. Without Xcode, the Command Line Tools ship Testing.framework outside the default
# search path, so add it (XCTest is unavailable under CLT; every test here uses swift-testing).
# Extra args go to `swift test`. Env: TALOS_SWIFTPM_CACHE, TALOS_SWIFT_SCRATCH (CI uses both).
set -euo pipefail
# Every swift test of the app holds the machine's desktop mutex (scripts/heavy-lock.sh desktop, the one CI's desktop job holds): two
# Swift suites at once exhaust the ptys (kern.tty.ptmx_max; one test process peaked at 437 of 511) and tmux then fails to fork, so
# tests report start_failed. Inside its holder (ci.sh, gui-tests.sh under it) or a CI job (TALOS_CI_SLOT_RUN=1) it passes through.
HEAVY_LOCK="$(dirname "$0")/../../../scripts/heavy-lock.sh"
if [ -f "$HEAVY_LOCK" ] && [ "${TALOS_CI_SLOT_RUN:-}" != 1 ] && ! bash "$HEAVY_LOCK" held desktop; then
  exec bash "$HEAVY_LOCK" desktop "desktop test.sh" -- bash "$0" "$@"
fi
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
