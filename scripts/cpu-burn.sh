#!/usr/bin/env bash
# The one sanctioned way to load a machine for flake hunting: runs <cmd> while N CPU burners spin, always inside the machine's
# heavy lock (scripts/heavy-lock.sh), so a burn queues behind CI like any heavy job and never saturates a CI run beside it.
#
#   scripts/cpu-burn.sh [--cores N] [--seconds S] -- <cmd...>
#
# --cores: burners to start (default: every logical core). --seconds: the whole run's limit (default and most 600; a larger
# value is cut to 600): past it, <cmd> and the burners are stopped and the exit is 142. Otherwise the exit is <cmd>'s own.
# Not inside the heavy lock's holder: re-runs itself through `heavy-lock.sh run cpu-burn -- ...`; when the lock can't be had
# it says so on one line, exits 75 and never burns. The burners run in a process group of their own, stopped (TERM, then
# KILL after 5 s) on every way out: <cmd> done or failed, the time limit, or a TERM, INT or HUP to this script.
# CPU_BURN_LOCK names another heavy-lock.sh, and CPU_BURN_IDLE=1 makes the burners sleep instead of spin (the tests use both).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SELF="$HERE/$(basename "$0")"
LOCKSH="${CPU_BURN_LOCK:-$HERE/heavy-lock.sh}"
MAX=600

usage() {
  sed -n '5p' "$0" | sed 's/^# *//' >&2
  exit 64
}

cores="" secs=$MAX
while [ $# -gt 0 ]; do
  case "$1" in
    --cores) cores="${2:-}" && shift 2 || usage ;;
    --seconds) secs="${2:-}" && shift 2 || usage ;;
    --) shift && break ;;
    *) usage ;;
  esac
done
[ $# -gt 0 ] || usage
case "$secs" in '' | *[!0-9]* | 0) usage ;; esac
[ "$secs" -le "$MAX" ] || {
  echo "cpu-burn: --seconds $secs is over the cap; using $MAX" >&2
  secs=$MAX
}
if [ -z "$cores" ]; then
  cores="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || echo 1)"
fi
case "$cores" in '' | *[!0-9]* | 0) usage ;; esac

if ! "$LOCKSH" held 2>/dev/null; then
  if [ -n "${CPU_BURN_MARK:-}" ]; then # already re-run through the lock and still not its holder: never burn unlocked
    echo "cpu-burn: refused: not inside the heavy lock's holder" >&2
    exit 75
  fi
  # Through the lock. The mark tells a lock that was never had (75 from heavy-lock.sh) from a <cmd> that itself exited 75.
  mark="$(mktemp "${TMPDIR:-/tmp}/cpu-burn.XXXXXX")" || exit 1
  CPU_BURN_MARK="$mark" "$LOCKSH" run cpu-burn -- "$SELF" --cores "$cores" --seconds "$secs" -- "$@" &
  lpid=$!
  trap 'kill -TERM "$lpid" 2>/dev/null' TERM INT HUP
  while :; do
    wait "$lpid"
    rc=$?
    kill -0 "$lpid" 2>/dev/null || break # a trapped signal ends wait early; wait again until the lock run is done
  done
  started="$(cat "$mark" 2>/dev/null)"
  rm -f "$mark"
  if [ "$rc" -eq 75 ] && [ -z "$started" ]; then
    echo "cpu-burn: refused: could not get the heavy lock (scripts/heavy-lock.sh status shows who holds it); nothing burned" >&2
  fi
  exit "$rc"
fi
[ -z "${CPU_BURN_MARK:-}" ] || echo started > "$CPU_BURN_MARK"

BURN_PG="" CMD_PG=""
stop_group() { # stop_group <pgid>: TERM the group, KILL whatever is left after 5 s
  local g="$1" n=0
  [ -n "$g" ] || return 0
  kill -TERM -- "-$g" 2>/dev/null
  while kill -0 -- "-$g" 2>/dev/null && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
  kill -KILL -- "-$g" 2>/dev/null
  wait "$g" 2>/dev/null
}
stop_all() {
  stop_group "$CMD_PG"
  CMD_PG=""
  stop_group "$BURN_PG"
  BURN_PG=""
}
trap 'stop_all; exit 143' TERM
trap 'stop_all; exit 130' INT
trap 'stop_all; exit 129' HUP
trap 'stop_all' EXIT

set -m
if [ "${CPU_BURN_IDLE:-}" = 1 ]; then
  (for _ in $(seq "$cores"); do (while :; do sleep 1; done) & done; wait) &
else
  (for _ in $(seq "$cores"); do (while :; do :; done) & done; wait) &
fi
BURN_PG=$!
"$@" &
CMD_PG=$!
set +m
echo "cpu-burn: $cores burners (group $BURN_PG), up to $secs s: $*" >&2

start=$SECONDS
while kill -0 "$CMD_PG" 2>/dev/null; do
  if [ $((SECONDS - start)) -ge "$secs" ]; then
    echo "cpu-burn: $secs s are up; stopping" >&2
    stop_all
    exit 142
  fi
  sleep 0.2
done
wait "$CMD_PG"
rc=$?
CMD_PG=""
stop_all
exit "$rc"
