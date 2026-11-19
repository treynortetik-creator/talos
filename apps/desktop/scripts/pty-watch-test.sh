#!/usr/bin/env bash
# Guard test for pty-watch.sh: a test process that holds too many pty masters fails the run, a modest one passes, a failing command
# keeps its own exit code, and a passing run whose test process was never seen does not read as clean. A small python stands in for
# `swift test`'s test process (it opens real ptys), so this needs no Swift build.
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; FAIL=1; }
T="$(mktemp -d -t talos-ptywatch-)"
trap 'rm -rf "$T"' EXIT

# A "test process": opens $1 ptys, holds them $2 seconds, exits $3. Its script's name is what the watcher looks for.
cat >"$T/fake-test-helper.py" <<'EOF'
import os, sys, time
n, hold, rc = int(sys.argv[1]), float(sys.argv[2]), int(sys.argv[3])
keep = [os.openpty() for _ in range(n)]
time.sleep(hold)
sys.exit(rc)
EOF
# The runner is a parent of the test process, as `swift test` is of swiftpm-testing-helper.
run() { TALOS_PTY_WATCH_PROC="fake-test-helper" TALOS_PTY_PEAK_MAX="$1" TALOS_PTY_WATCH_INTERVAL=0.2 \
  bash scripts/pty-watch.sh bash -c 'python3 "$0" "$@" & wait $!' "$T/fake-test-helper.py" "$2" "$3" "$4" >"$T/out" 2>&1; }

run 10 2 2 0 && grep -q "ok   pty watch: peak 2 " "$T/out" && ok "control: 2 ptys under a limit of 10 pass, with the peak said" || { bad "control failed"; cat "$T/out"; }
run 10 30 2 0 && { bad "30 ptys over a limit of 10 passed"; cat "$T/out"; } || { grep -q "held 30 pty masters at its peak (limit 10" "$T/out" && ok "a peak over the limit fails and says how many" || { bad "failed for the wrong reason"; cat "$T/out"; }; }
run 10 2 2 3; rc=$?
[ "$rc" = 3 ] && ok "a failing command keeps its own exit code" || { bad "exit code $rc, wanted 3"; cat "$T/out"; }
run 10 30 2 3; rc=$?
[ "$rc" = 3 ] && grep -q "held 30" "$T/out" && ok "over the limit and failing: the command's code, and the pty line too" || { bad "exit $rc"; cat "$T/out"; }
TALOS_PTY_WATCH_PROC="never-there" bash scripts/pty-watch.sh true >"$T/out" 2>&1 && { bad "an unmeasured passing run passed"; cat "$T/out"; } ||
  { grep -q "no 'never-there' process was ever seen" "$T/out" && ok "a passing run that was never measured fails" || { bad "wrong reason"; cat "$T/out"; }; }
TALOS_PTY_WATCH_PROC="never-there" bash scripts/pty-watch.sh false >"$T/out" 2>&1; rc=$?
[ "$rc" = 1 ] && ! grep -q FAIL "$T/out" && ok "an unmeasured failing run keeps its own failure" || { bad "exit $rc"; cat "$T/out"; }
TALOS_PTY_PEAK_MAX=abc bash scripts/pty-watch.sh true >"$T/out" 2>&1; rc=$?
[ "$rc" = 2 ] && ok "a limit that is not a number is refused" || bad "bad limit gave $rc"
# Nothing it started is left behind (the holder is the watched command's own child).
[ -z "$(ps -Ao command= | grep -F "$T/fake-test-helper.py" | grep -v grep)" ] && ok "no holder left running" || bad "a holder outlived its run"

[ "$FAIL" = 0 ] && echo "pty-watch-test: all passed" || { echo "pty-watch-test: FAILED"; exit 1; }
