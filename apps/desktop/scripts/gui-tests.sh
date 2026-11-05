#!/usr/bin/env bash
# Runs the window-opening Swift tests (TalosDesktopGuiTests), one test process per suite, in a logged-in session.
#
# Why one process per suite: these suites share AppKit, which does not tear down cleanly twice in a process, and an AppKit nested
# event loop has ended a whole test process with exit(0) and no summary (see Tests/TalosDesktopGuiTests/Support.swift). So a run only
# counts when ALL of this holds for the suite's process: it exited 0, it printed Swift Testing's closing summary line saying the
# run passed, and that at least one test in it actually passed. Swift Testing counts a skipped test in its summary ("Test run with
# 2 tests ... passed"), so the gate is the per-test "✔ Test name passed" lines (not the closing "Test run" line): a suite whose tests were all skipped (its gate was off)
# fails, except the suites in ENV_GATED, which need an extra env var (a page URL, a shot folder, a recording length) and are listed as skipped. A process that exits 0 without the summary is a failure, never a pass.
#
#   gui-tests.sh            run every suite
#   gui-tests.sh --list     print the suite names and stop
# Env: TALOS_GUI_TEST_RUNNER (default `bash scripts/test.sh`) is the command that runs `swift test`; the guard test swaps it.
set -uo pipefail
cd "$(dirname "$0")/.."

suites() {
  # The type declared right after each top-level @Suite line (other attributes may sit between them). A suite written inside
  # `extension X { ... }` runs as part of X, so only X is listed.
  awk '/^extension [A-Za-z0-9_]+ *\{/ { inext = 1; next }
       /^\}/ { inext = 0 }
       /^@Suite/ { want = !inext; next }
       want && match($0, /(struct|final class|class|enum) [A-Za-z0-9_]+/) {
         n = substr($0, RSTART, RLENGTH); sub(/^.* /, "", n); print n; want = 0 }' Tests/TalosDesktopGuiTests/*.swift | sort -u
}

if [ "${1:-}" = "--list" ]; then suites; exit 0; fi

names="$(suites)"
[ -n "$names" ] || { echo "gui-tests: found no suites in Tests/TalosDesktopGuiTests" >&2; exit 2; }
runner="${TALOS_GUI_TEST_RUNNER:-bash scripts/test.sh}"
# Suites that skip by design unless their own env var is set (TALOS_SNAPSHOT_URL, TALOS_SHOT_DIR, TALOS_IDLE_RECORD).
ENV_GATED=" SnapshotTests ScreenShotTests CompanionIdleRecordGuiTests "
listed="$(printf '%s\n' "$names" | wc -l | tr -d ' ')"
fail=0 ran=0 skipped=0
while IFS= read -r name; do
  out="$(mktemp)"
  # The runner gets no stdin: it would otherwise read the rest of the suite list from the here-string below, and the loop would
  # end early with every suite it did run green.
  # shellcheck disable=SC2086
  TALOS_GUI_TESTS=1 $runner --filter "TalosDesktopGuiTests\\.${name}\\b" >"$out" 2>&1 </dev/null
  rc=$?
  summary="$(grep -E 'Test run with [0-9]+ tests? ' "$out" | tail -1)"
  if [ "$rc" -ne 0 ]; then
    echo "  FAIL $name: the test process exited $rc"; grep -E '✘|error:|Expectation failed' "$out" | head -10; fail=1
  elif [ -z "$summary" ]; then
    echo "  FAIL $name: the process exited 0 but never printed the run summary (it ended early)"; tail -5 "$out"; fail=1
  elif ! printf '%s' "$summary" | grep -q ' passed '; then
    echo "  FAIL $name: $summary"; fail=1
  elif printf '%s' "$summary" | grep -qE 'Test run with 0 tests'; then
    echo "  FAIL $name: the filter matched no tests"; fail=1
  elif [ "$(grep -E '^✔ Test ' "$out" | grep -vc '^✔ Test run ')" = 0 ]; then
    if [[ "$ENV_GATED" == *" $name "* ]]; then
      echo "  skip $name: every test was skipped (needs its own env var)"; skipped=$((skipped + 1))
    else
      echo "  FAIL $name: every test was skipped, so nothing ran (is the GUI gate on?)"; fail=1
    fi
  else
    echo "  ok   $name: $(printf '%s' "$summary" | sed -E 's/^[^T]*//')"; ran=$((ran + 1))
  fi
  rm -f "$out"
done <<<"$names"
[ "$fail" = 0 ] || exit 1
# Every listed suite must have been run (or listed as skipped): a loop that ended early is a failure, not a smaller pass.
[ $((ran + skipped)) = "$listed" ] || { echo "gui-tests: FAIL: $listed suites are listed but only $((ran + skipped)) were run"; exit 1; }
echo "gui-tests: $ran suites passed, $skipped skipped"
