#!/usr/bin/env bash
# Guard test for gui-tests.sh: a window-opening run that ends early, fails, or matches nothing must never read as a pass. Uses a
# fake runner in place of `swift test`, so it needs no window server.
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; FAIL=1; }
T="$(mktemp -d)"

mk() { printf '#!/bin/bash\n%s\n' "$2" >"$T/$1"; chmod +x "$T/$1"; }
run() { TALOS_GUI_TEST_RUNNER="$T/$1" bash scripts/gui-tests.sh >"$T/out" 2>&1; }

mk good 'echo "✔ Test a() passed after 0.1 seconds."; echo "✔ Test run with 4 tests in 1 suite passed after 0.5 seconds."; exit 0'
mk early 'echo "◇ Test run started."; exit 0'
mk red 'echo "✘ Test run with 4 tests in 1 suite failed after 0.5 seconds with 1 issue."; exit 1'
mk redsummary 'echo "✘ Test run with 4 tests in 1 suite failed after 0.5 seconds with 1 issue."; exit 0'
mk none 'echo "✔ Test run with 0 tests in 0 suites passed after 0.0 seconds."; exit 0'
mk allskipped 'echo "➜ Test a() skipped."; echo "✔ Test run with 2 tests in 1 suite passed after 0.001 seconds."; exit 0'
mk gated_skip 'case "$*" in *.SnapshotTests*|*.ScreenShotTests*) echo "➜ Test a() skipped."; echo "✔ Test run with 1 test in 1 suite passed after 0.001 seconds."; exit 0;; esac; echo "✔ Test a() passed after 0.1 seconds."; echo "✔ Test run with 1 test in 1 suite passed after 0.1 seconds."'
mk only_one_bad 'case "$*" in *CompanionLiveGuiTests*) echo "◇ Test run started."; exit 0;; esac; echo "✔ Test a() passed after 0.1 seconds."; echo "✔ Test run with 1 test in 1 suite passed after 0.1 seconds."'
mk needs_env 'if [ "$TALOS_GUI_TESTS" != 1 ]; then echo "✘ gate off"; exit 1; fi; echo "✔ Test a() passed after 0.1 seconds."; echo "✔ Test run with 1 test in 1 suite passed after 0.1 seconds."'
mk redcomment 'echo "◇ Test run started."; echo "↳ Testing Library Version: 2403"; echo "↳ Target Platform: arm64e-apple-macos14.0"; echo "✘ Test a() recorded an issue at A.swift:9:5: Expectation failed: n == 4"; echo "↳ start_failed: the tmux socket was gone"; echo "✘ Test run with 1 test in 1 suite failed after 0.1 seconds with 1 issue."; exit 1'
mk eater 'cat >/dev/null; echo "✔ Test a() passed after 0.1 seconds."; echo "✔ Test run with 1 test in 1 suite passed after 0.1 seconds."'

[ "$(bash scripts/gui-tests.sh --list | wc -l | tr -d ' ')" -ge 20 ] && ok "lists the suites" || bad "suite list is short: $(bash scripts/gui-tests.sh --list | wc -l)"
bash scripts/gui-tests.sh --list | grep -qx CrashAlertChainGuiTests && ok "lists the alert chain suite" || bad "alert chain suite missing from the list"

run good && ok "control: a proper summary passes" || { bad "control: a proper summary failed"; cat "$T/out"; }
run early && bad "exit 0 with no summary counted as a pass" || { grep -q "never printed the run summary" "$T/out" && ok "exit 0 with no summary fails" || bad "failed for the wrong reason"; }
run red && bad "a red run counted as a pass" || ok "a red run fails"
# A red names the real error: the ↳ comment a test attaches to its expectation is kept, the run's header lines are not.
run redcomment
grep -q "↳ start_failed: the tmux socket was gone" "$T/out" && ok "a red keeps the test's own comment line" || { bad "a red dropped the test's comment line"; cat "$T/out"; }
grep -q "Testing Library" "$T/out" && bad "the run header's ↳ lines are shown as if they were errors" || ok "the run header's ↳ lines are left out"
run redsummary && bad "a failed summary with exit 0 counted as a pass" || ok "a failed summary fails even at exit 0"
run none && bad "a filter that matched no tests counted as a pass" || ok "an empty run fails"
run only_one_bad && bad "one suite ending early did not fail the whole run" || { grep -q "FAIL CompanionLiveGuiTests" "$T/out" && ok "one early-ending suite fails the run and is named" || bad "the early suite was not named"; }
run needs_env && ok "a run only passes with the GUI gate on" || bad "the gate is not set on the child process"
run allskipped && bad "a suite whose tests were all skipped counted as a pass" || { grep -q "every test was skipped" "$T/out" && ok "an all-skipped suite fails and says why" || bad "failed for the wrong reason"; }
run gated_skip && { grep -q "skip SnapshotTests" "$T/out" && ok "the env-gated suites are listed as skipped, not passed" || bad "gated skips not listed"; } || bad "gated suites that skip by design failed the run"
grep -q "suites passed, 2 skipped" "$T/out" && ok "the closing line counts the skipped suites" || bad "closing line hides the skips"
# A runner that reads its stdin must not take the rest of the suite list with it: every listed suite is still run.
n="$(bash scripts/gui-tests.sh --list | wc -l | tr -d ' ')"
run eater && grep -q "gui-tests: $n suites passed" "$T/out" && ok "a runner that reads stdin still gets every suite run ($n)" || { bad "a runner that reads stdin cut the run short"; tail -3 "$T/out"; }
rm -rf "$T"
[ "$FAIL" = 0 ] && echo "gui-tests-test: all ok" || { echo "gui-tests-test: FAILED"; exit 1; }
