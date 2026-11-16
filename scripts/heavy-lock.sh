#!/usr/bin/env bash
# The machine's one heavy-work lock, for anything that isn't a ci-local job: the gate's suites, the desktop Swift suites, stress
# loops, evals. It is ci-local's suites mutex (locks/mutex-suites under ~/.cache/talos-ci, or TALOS_CI_CACHE), taken through the
# same ci_mutex, so a gate never runs its tests beside CI's, nor two of these beside each other.
#
#   scripts/heavy-lock.sh run <name> -- <cmd...>   run cmd holding the lock; waits its turn (CI first, then first come first served)
#   scripts/heavy-lock.sh status                   who holds it (pid, what, since when) and who waits, in the order they go
#   scripts/heavy-lock.sh held [desktop]           exit 0 if this process already runs inside the lock's (or desktop's) holder
#   scripts/heavy-lock.sh desktop <name> -- <cmd...>  run cmd holding the desktop mutex (locks/mutex-desktop), the one CI's desktop
#                                                  job holds: one Swift desktop suite on the machine at a time (two exhaust the
#                                                  ptys, kern.tty.ptmx_max, and tmux fails to fork). Not the heavy lock; no guard.
#
# A waiter says whom it waits for. A holder that dies frees the lock: the next waiter takes it over (the pid and its start time
# are checked, so a reused pid is no holder) and first stops the dead holder's command, which ran in a process group recorded
# for exactly that. A run inside a holder (a gate in a CI job, ci.sh inside the gate) passes straight through. Before the job
# starts, the guard may hold it back (scripts/ci-local/locks.sh, ci_guard). Exit: the command's own, or 75 when the lock could
# not be had within HEAVY_LOCK_TIMEOUT seconds (default 3600); a command that itself exits 75 reads the same, so a caller that
# must tell them apart runs one that doesn't. HEAVY_LOCK_POLL: seconds between looks (default 2).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CI_LOCAL_LIB="$HERE/ci-local"
CACHE="${TALOS_CI_CACHE:-$HOME/.cache/talos-ci}"
LOCKS="$CACHE/locks" CI_RUNS="$CACHE/runs"
CI_NONCE="$$-$RANDOM$RANDOM-$(date +%s)"
CI_HELD="" CI_SLOT="" CI_MARKER="" CI_MSG=heavy-lock
CI_POLL="${HEAVY_LOCK_POLL:-2}" CI_LOCK_TIMEOUT="${HEAVY_LOCK_TIMEOUT:-3600}" CI_LOCK_GRACE=30
# shellcheck source=ci-local/locks.sh
. "$CI_LOCAL_LIB/locks.sh"
LOCK="$LOCKS/mutex-suites"

usage() {
  sed -n '6,11p' "$0" | sed 's/^# *//' >&2
  exit 64
}

HL_PID="" HL_REC="" HL_STARTED=""
hl_stop() { # the command's whole group (TERM, then KILL after 5 s), then the record: a holder that is stopped stops its command
  local n=0
  if [ -n "$HL_PID" ]; then
    kill -TERM -- "-$HL_PID" 2>/dev/null
    while kill -0 -- "-$HL_PID" 2>/dev/null && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
    kill -KILL -- "-$HL_PID" 2>/dev/null
    wait "$HL_PID" 2>/dev/null
  fi
  [ -z "$HL_REC" ] || rm -rf "$HL_REC"
}
hl_hold() { # under the lock: the command in a process group of its own, in a run record, so a waiter that takes the lock from a
  # dead holder stops what it left running (ci_reap_run), and two heavy jobs never overlap
  local rc
  HL_STARTED=1
  printf '%s\0' "$@" > "$LOCK/argv" 2>/dev/null # the exact command, for status and the tests
  unset HEAVY_LOCK_JUMP HEAVY_LOCK_PUSH # this one ticket's; nothing the command starts (a CI run in its tests) inherits them
  HL_REC="$CI_RUNS/$CI_NONCE"
  mkdir -p "$HL_REC" && ci_me > "$HL_REC/owner"
  set -m
  "$@" &
  HL_PID=$!
  set +m
  printf '%s %s\n' "$HL_PID" "$(ci_proc_start "$HL_PID")" > "$HL_REC/groups"
  wait "$HL_PID"
  rc=$?
  HL_PID=""
  rm -rf "$HL_REC"
  HL_REC=""
  return $rc
}

hl_run() { # hl_run <mutex: suites|desktop> <name> -- <cmd...>
  local mutex="$1" name="${2:-}"
  shift
  LOCK="$LOCKS/mutex-$mutex"
  [ -n "$name" ] || usage
  shift
  [ "${1:-}" = -- ] && shift
  [ $# -gt 0 ] || usage
  if ci_mutex_nested "$LOCK"; then exec "$@"; fi # inside the holder already: no second hold, no wait
  trap 'hl_stop; ci_release_all; exit 143' TERM INT HUP
  trap 'ci_release_all' EXIT
  CI_MUTEX_WHAT="$name: $*" CI_MUTEX_JOB="$name"
  ci_mutex "$LOCKS" "$mutex" hl_hold "$@"
  local rc=$?
  # the command never started: the lock was not had in time (ci_mutex said so), which is 75, never the command's own code
  [ -n "$HL_STARTED" ] || return 75
  return $rc
}

hl_status() {
  local owner pid t
  owner="$(ci_owner "$LOCK")"
  pid="$(printf '%s\n' "$owner" | sed -n 1p)"
  if [ -z "$pid" ]; then
    echo "heavy lock: free"
  else
    printf 'heavy lock: held by pid %s (%s, since %s)' "$pid" "$(head -1 "$LOCK/what" 2>/dev/null)" "$(ci_since "$LOCK/owner")"
    ci_owner_alive "$owner" || printf ' (that holder is gone: the next waiter takes it over)'
    echo
  fi
  # the order they go in (ci_queue_order: a jump, then CI, then the rest as they came), each with its kind
  local q="$LOCKS.queue/suites" n=0
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    n=$((n + 1))
    printf '  waiting %s: pid %s (%s), %s\n' "$n" "$(sed -n 1p "$t")" "$(sed -n 4p "$t")" "$(ci_ticket_kind "$t")"
  done <<ORDER
$( [ -d "$q" ] && ci_queue_order "$q" "$q/none")
ORDER
}

case "${1:-}" in
  run) shift && hl_run suites "$@" ;;
  desktop) shift && hl_run desktop "$@" ;;
  status) hl_status ;;
  held) case "${2:-}" in '') ci_mutex_nested "$LOCK" ;; desktop) ci_mutex_nested "$LOCKS/mutex-desktop" ;; *) usage ;; esac ;;
  *) usage ;;
esac
