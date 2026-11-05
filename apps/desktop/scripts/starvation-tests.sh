#!/usr/bin/env bash
# Runs the tests that starve the process-wide dispatch pool, alone in their own test process. Starving every core would make
# suites running beside them fail for no reason of their own, so the normal run (scripts/test.sh) skips them; they switch on
# with TALOS_STARVATION_TESTS=1, which this script sets.
#
# A run only counts when the process exited 0 and at least one test in it actually passed (a skipped test is counted in Swift
# Testing's summary, so the per-test "✔ Test ... passed" lines are what is checked).
# Env: TALOS_STARVATION_TEST_RUNNER (default `bash scripts/test.sh`) is the command that runs `swift test`.
set -uo pipefail
cd "$(dirname "$0")/.."
runner="${TALOS_STARVATION_TEST_RUNNER:-bash scripts/test.sh}"
out="$(mktemp)"
trap 'rm -f "$out"' EXIT
# shellcheck disable=SC2086
TALOS_STARVATION_TESTS=1 $runner --filter 'DispatchPoolIsStarved' >"$out" 2>&1 </dev/null
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "  FAIL starvation tests: the test process exited $rc"; grep -E '✘|error:|Expectation failed' "$out" | head -10; exit 1
fi
if [ "$(grep -E '^✔ Test ' "$out" | grep -vc '^✔ Test run ')" = 0 ]; then
  echo "  FAIL starvation tests: nothing ran (every test was skipped, or the filter matched none)"; tail -5 "$out"; exit 1
fi
echo "  ok   starvation tests: $(grep -E 'Test run with' "$out" | tail -1 | sed -E 's/^[^T]*//')"
