#!/usr/bin/env bash
# Runs a command (the desktop Swift suite) and watches how many pty masters (/dev/ptmx) its test process holds, every second. The
# machine has 511 in all (kern.tty.ptmx_max), shared with every terminal and tmux on it, and a test process that keeps the masters of
# finished terminals open runs the machine out: forks then fail with "Device not configured" (OBSERVED 2026-11-19: one parallel
# run held 495, of which only a handful belonged to a live child).
#
# The count is the peak over the run, not what is left at its end: the test process is gone by then, and a late close that frees
# everything at once (the 2026-11-19 case) leaves nothing at the end to see. A healthy parallel run peaks well below the limit (live
# terminals hold up to three descriptors each); one that drifts climbs past it. Fails when:
#   - the peak is above TALOS_PTY_PEAK_MAX (default 64), with the samples around the peak printed;
#   - the command passed but the test process was never seen (an unmeasured run is not a clean one).
# The command's own exit code is kept when it fails.
#
#   scripts/pty-watch.sh <cmd...>
# Env: TALOS_PTY_PEAK_MAX; TALOS_PTY_WATCH_PROC, the test process's command to look for among the command's descendants
# (default swiftpm-testing-helper); TALOS_PTY_WATCH_INTERVAL (seconds, default 1).
set -uo pipefail
MAX="${TALOS_PTY_PEAK_MAX:-64}"
PROC="${TALOS_PTY_WATCH_PROC:-swiftpm-testing-helper}"
INTERVAL="${TALOS_PTY_WATCH_INTERVAL:-1}"
[ "$#" -gt 0 ] || { echo "usage: pty-watch.sh <cmd...>" >&2; exit 2; }
case "$MAX" in '' | *[!0-9]*) echo "pty-watch: TALOS_PTY_PEAK_MAX must be a whole number, got '$MAX'" >&2; exit 2 ;; esac

LOG="$(mktemp -t talos-ptywatch-)"
trap 'rm -f "$LOG"' EXIT

"$@" &
CMD=$!
# Stopping the watcher stops the command too, never leaving a test run behind it.
trap 'kill -TERM "$CMD" 2>/dev/null; wait "$CMD" 2>/dev/null; exit 143' TERM INT HUP

# Every descendant of $1 whose command contains $PROC, from one ps listing (no pgrep loops).
watched() {
  ps -Ao pid=,ppid=,command= | awk -v root="$1" -v want="$PROC" '
    { pid[NR] = $1; ppid[NR] = $2; $1 = ""; $2 = ""; cmd[NR] = $0 }
    END {
      inTree[root] = 1
      do { grew = 0; for (i = 1; i <= NR; i++) if (!(pid[i] in inTree) && (ppid[i] in inTree)) { inTree[pid[i]] = 1; grew = 1 } } while (grew)
      for (i = 1; i <= NR; i++) if ((pid[i] in inTree) && pid[i] != root && index(cmd[i], want)) print pid[i]
    }'
}

while kill -0 "$CMD" 2>/dev/null; do
  for p in $(watched "$CMD"); do
    n="$(lsof -n -P -p "$p" 2>/dev/null | grep -c '/dev/ptmx')"
    echo "$(date +%H:%M:%S) pid=$p ptmx=$n" >>"$LOG"
  done
  sleep "$INTERVAL"
done
wait "$CMD"
rc=$?

samples="$(wc -l <"$LOG" | tr -d ' ')"
peak="$(awk -F'ptmx=' '{ if ($2 + 0 > m) m = $2 + 0 } END { print m + 0 }' "$LOG")"
if [ "$samples" = 0 ]; then
  if [ "$rc" = 0 ]; then
    echo "  FAIL pty watch: the command passed but no '$PROC' process was ever seen, so its ptys were not measured"
    exit 1
  fi
  exit "$rc"
fi
if [ "$peak" -gt "$MAX" ]; then
  echo "  FAIL pty watch: the test process held $peak pty masters at its peak (limit $MAX of the machine's $(sysctl -n kern.tty.ptmx_max 2>/dev/null || echo '?'))."
  echo "       Finished terminals whose masters are not closed. Samples up to the peak:"
  awk -F'ptmx=' -v m="$peak" '{ print "       " $0 } $2 + 0 == m { exit }' "$LOG" | tail -15
  [ "$rc" = 0 ] && exit 1
  exit "$rc"
fi
echo "  ok   pty watch: peak $peak pty masters held by the test process ($samples samples, limit $MAX)"
exit "$rc"
