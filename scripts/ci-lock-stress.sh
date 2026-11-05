#!/usr/bin/env bash
# Stresses the lock code of a copy of ci-local.sh and counts rounds where two LIVE processes believed they held one lock.
# Compare two versions: `git show <sha>:scripts/ci-local.sh > /tmp/old.sh`, then run this on each, beside real load.
#
#   scripts/ci-lock-stress.sh <copy of ci-local.sh> [rounds]     # exit 0 only if no round had two live holders
#
# stalled-claimer  a process that holds a takeover claim stalls past the grace period just before writing itself in
# stalled-creator  a process that has just made the lock stalls past the grace period just before writing itself in
# plain-load       10 racers for a dead owner's lock, nothing forced, grace period 1 s: load makes the stalls
# A short grace period is how this reaches in seconds what takes a 30-second stall with the default.
set -uo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
if [ "${1:-}" = --child ]; then LIB="$2"; else
  LIB="$(cd "$(dirname "${1:?usage: ci-lock-stress.sh <copy of ci-local.sh> [rounds]}")" && pwd)/$(basename "$1")"
  ROUNDS="${2:-10}"
  export CI_LOCK_GRACE=1
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/lock-stress.XXXXXX")"
  trap 'rm -rf "$WORK"' EXIT
  BAD=0
fi

# Every contender is its own process (`child`): a lock's owner is a pid, and a subshell keeps its parent's.
child() { bash "$SELF" --child "$LIB" "$@"; }
if [ "${1:-}" = --child ]; then
  shift 2
  . "$LIB"
  hold() { # hold <dir> <seconds>: a holder keeps a file while it believes it owns the lock; finding another's is a double hold
    if ls "$1" | grep -q '^held\.'; then echo double >> "$1/doubles"; fi
    : > "$1/held.$$"
    sleep "$2"
    rm -f "$1/held.$$"
  }
  case "$1" in
    dead) ci_lock_try "$2" dead ;;
    racer) # racer <lock> <dir> <name> <seconds to keep trying>
      end=$(($(date +%s) + $5))
      while [ "$(date +%s)" -le "$end" ]; do
        if ci_lock_try "$2" "$4"; then hold "$3" 4; exit 0; fi
        sleep 0.05
      done ;;
    staller) # staller <lock> <dir>: both ways a process can write itself in wait for <dir>/go
      for f in ci_write_owner ci_new_owner; do
        declare -F "$f" >/dev/null || continue
        eval "real_$f() $(declare -f "$f" | sed 1d)"
        eval "$f() { touch '$3/stalled'; until [ -f '$3/go' ]; do sleep 0.02; done; real_$f \"\$@\"; }"
      done
      if ci_lock_try "$2" staller; then hold "$3" 5; fi ;;
  esac
  exit 0
fi

stalled_round() { # stalled_round <claimer|creator> <dir>
  local D="$2" L="$2/slot-1" i
  if [ "$1" = claimer ]; then child dead "$L" 2>/dev/null; fi
  child staller "$L" "$D" 2>/dev/null &
  until [ -f "$D/stalled" ]; do sleep 0.02; done
  sleep 1.2
  for i in 1 2 3 4; do child racer "$L" "$D" "w$i" 2 2>/dev/null & done
  sleep 2
  : > "$D/go"
  wait
}
plain_round() { # plain_round <dir>
  local D="$1" L="$1/slot-1" i
  child dead "$L" 2>/dev/null
  for i in 1 2 3 4 5 6 7 8 9 10; do child racer "$L" "$D" "r$i" 1 2>/dev/null & done
  wait
}
report() { # report <name> <rounds with a double hold> <rounds>
  echo "$1: $2 of $3 rounds had two live holders"
  [ "$2" = 0 ] || BAD=1
}

for scenario in stalled-claimer stalled-creator plain-load; do
  doubles=0
  for r in $(seq 1 "$ROUNDS"); do
    D="$WORK/$scenario-$r"
    mkdir "$D"
    case "$scenario" in
      stalled-claimer) stalled_round claimer "$D" ;;
      stalled-creator) stalled_round creator "$D" ;;
      plain-load) plain_round "$D" ;;
    esac
    [ ! -f "$D/doubles" ] || doubles=$((doubles + 1))
  done
  report "$scenario" "$doubles" "$ROUNDS"
done
exit $BAD
