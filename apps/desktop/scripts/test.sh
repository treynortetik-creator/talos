#!/usr/bin/env bash
# Runs the swift-testing suites. Without Xcode, the Command Line Tools ship Testing.framework outside the default
# search path, so add it (XCTest is unavailable under CLT; every test here uses swift-testing).
# Extra args go to `swift test`. Env: TALOS_SWIFTPM_CACHE, TALOS_SWIFT_SCRATCH (CI uses both).
set -euo pipefail
# Every swift test of the app holds the machine's desktop mutex (scripts/heavy-lock.sh desktop, the one CI's desktop job holds): two
# Swift suites at once can exhaust the ptys (kern.tty.ptmx_max is 511 for the whole machine) and tmux then fails to fork, so
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

# Swift Testing runs at most this many tests at once: two fewer than the cores. A synchronous test runs on a thread of the cooperative
# pool, which has one thread per core, and most of these tests wait in usleep. Once every one of those threads is asleep, macOS runs
# nothing queued on the shared default and utility queues (MEASURED 2026-11-19: with all 10 asleep, a block queued there did not run
# for 2 s; with 9 asleep it ran at once). SwiftTerm closes the descriptor it writes a terminal through on those queues
# (DispatchIO), so every terminal that finished meanwhile kept a /dev/ptmx open: 495 of the machine's 511 in one run, until a free
# thread came and closed them all at once. ci.sh watches the count (pty-watch.sh). Set the variable yourself to override.
if [ -z "${SWT_EXPERIMENTAL_MAXIMUM_PARALLELIZATION_WIDTH:-}" ]; then
  cores="$(sysctl -n hw.activecpu 2>/dev/null || echo 3)"
  width=$((cores - 2))
  [ "$width" -ge 1 ] || width=1
  export SWT_EXPERIMENTAL_MAXIMUM_PARALLELIZATION_WIDTH="$width"
fi

F=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
if ! xcodebuild -version >/dev/null 2>&1 && [ -d "$F" ]; then
  ARGS+=(-Xswiftc -F -Xswiftc "$F" -Xlinker -F -Xlinker "$F" -Xlinker -rpath -Xlinker "$F")
fi

exec swift test ${ARGS[@]+"${ARGS[@]}"} "$@"
