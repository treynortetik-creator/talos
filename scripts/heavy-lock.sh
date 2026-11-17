#!/usr/bin/env bash
# The machine's heavy-work lock, for anything that isn't a ci-local job: the gate's suites, the desktop Swift suites, load loops,
# evals. It is ci-local's suites mutex (locks/mutex-suites under ~/.cache/talos-ci, or TALOS_CI_CACHE), taken through the same
# ci_mutex, so a gate never runs its tests beside more than the machine's heavy slots allow.
#
# The lock is N slots wide (scripts/ci-local/locks.sh, ci_heavy_slots): TALOS_HEAVY_SLOTS, else the first line of
# <cache>/heavy-slots, else 4; 1 is one holder at a time, as it always was. Slot 1 is locks/mutex-suites, which an older copy of this
# script still takes; with 2 slots or more the first K (TALOS_CI_SLOTS, 2) are CI's alone (a ci-local job never waits behind a gate,
# and the jobs of a run overlap), and what this script runs goes in slots K+1..N (locks/mutex-suites-<K+1> ... -N): the first one that is free, in turn among the others who wait for them (CI first
# applies only with one slot, where CI and gates share it). During a rollout an older copy of this script (a worktree not yet
# rebased) still takes slot 1 and CI waits for it, as before. A holder's command gets its slot's own ports, tmux names and scratch
# folder: TALOS_HEAVY_SLOT=<k>, from which PW_PORT (the web specs' preview server), TALOS_TEST_TMUX_PREFIX (the tests' tmux sockets)
# and, with more than one slot, TMPDIR (a folder of its own, emptied at the start and removed at the end) follow. Slot k has preview
# port 4173 + 10 * (k - 1); with one slot that is 4173, the port a plain run uses.
#
#   scripts/heavy-lock.sh run <name> -- <cmd...>   run cmd holding a slot; waits its turn
#   scripts/heavy-lock.sh status                   who holds each slot (pid, what, since when) and who waits, in the order they go
#   scripts/heavy-lock.sh held [desktop]           exit 0 if this process already runs inside a holder (or desktop's)
#   scripts/heavy-lock.sh desktop <name> -- <cmd...>  run cmd holding the desktop mutex (locks/mutex-desktop), the one CI's desktop
#                                                  job holds: one Swift desktop suite on the machine at a time (two exhaust the
#                                                  ptys, kern.tty.ptmx_max, and tmux fails to fork). Always ONE, whatever the slots
#                                                  above; not the heavy lock; no guard.
#
# A waiter says whom it waits for. A holder that dies frees its slot: the next waiter takes it over (the pid and its start time
# are checked, so a reused pid is no holder) and first stops the dead holder's command, which ran in a process group recorded
# for exactly that. A run inside a holder (a gate in a CI job, ci.sh inside the gate) passes straight through. Before the job
# starts, the guard may hold it back (scripts/ci-local/locks.sh, ci_guard). Exit: the command's own, or 75 when the lock could
# not be had within HEAVY_LOCK_TIMEOUT seconds (default 3600; 0 means no limit, and a push gate, HEAVY_LOCK_PUSH, which gate-push.sh
# sets, waits up to 14400, four hours, unless HEAVY_LOCK_TIMEOUT says otherwise: a push keeps its place through a long queue); a command that itself exits
# 75 reads the same, so a caller that must tell them apart runs one that doesn't. HEAVY_LOCK_POLL: seconds between looks (default 2).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CI_LOCAL_LIB="$HERE/ci-local"
CACHE="${TALOS_CI_CACHE:-$HOME/.cache/talos-ci}"
LOCKS="$CACHE/locks" CI_RUNS="$CACHE/runs"
CI_NONCE="$$-$RANDOM$RANDOM-$(date +%s)"
CI_HELD="" CI_SLOT="" CI_MARKER="" CI_MSG=heavy-lock
if [ -n "${HEAVY_LOCK_TIMEOUT:-}" ]; then CI_LOCK_TIMEOUT="$HEAVY_LOCK_TIMEOUT"
elif [ -n "${HEAVY_LOCK_PUSH:-}" ]; then CI_LOCK_TIMEOUT=14400
else CI_LOCK_TIMEOUT=3600; fi
CI_POLL="${HEAVY_LOCK_POLL:-2}" CI_LOCK_GRACE=30
# shellcheck source=ci-local/locks.sh
. "$CI_LOCAL_LIB/locks.sh"
LOCK="$LOCKS/mutex-suites"

usage() {
  sed -n '16,22p' "$0" | sed 's/^# *//' >&2
  exit 64
}

HL_PID="" HL_REC="" HL_STARTED="" HL_TMP="" HL_MUTEX=suites
hl_tmp_drop() { # the slot's scratch folder: ours to empty while we hold the slot (chmod first: a read-only folder a test left must not jam it)
  [ -z "$HL_TMP" ] || { chmod -R u+w "$HL_TMP" 2>/dev/null; rm -rf "$HL_TMP"; }
  HL_TMP=""
}
hl_stop() { # the command's whole group (INT, then TERM, then KILL after 5 s), then the record: a holder that is stopped stops its command
  # INT first: Playwright tears its web server down on INT only, and starts it in a group of its own, which this group's TERM and KILL
  # never reach (an orphaned preview server held its port and broke the next run); hl_reap_preview is the net under that
  # The INT wait is longer than the gate's own (scripts/gate/group-run.pl, GATE_STOP_WAIT, 5 s): its stop sequence, INT to Playwright then
  # TERM, must have run its course before this TERM reaches it, derived from the same variable so the two cannot drift.
  local n=0 intwait
  intwait="$(awk -v w="${GATE_STOP_WAIT:-5}" 'BEGIN { w += 0; print int((w + 2) * 10) }')"
  if [ -n "$HL_PID" ]; then
    kill -INT -- "-$HL_PID" 2>/dev/null
    while kill -0 -- "-$HL_PID" 2>/dev/null && [ "$n" -lt "$intwait" ]; do sleep 0.1; n=$((n + 1)); done
    kill -TERM -- "-$HL_PID" 2>/dev/null
    n=0
    while kill -0 -- "-$HL_PID" 2>/dev/null && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
    kill -KILL -- "-$HL_PID" 2>/dev/null
    wait "$HL_PID" 2>/dev/null
  fi
  hl_reap_preview
  hl_tmp_drop
  [ -z "$HL_REC" ] || rm -rf "$HL_REC"
}
# The slot's web preview port (PW_PORT) is the slot's own. A `vite preview` on it whose run is gone (hl_reap_preview) is what a stopped
# or killed run left behind: stopped, so the next hold's web specs can bind it. One whose parent lives is someone's run (a builder's by
# hand on 4173, say): never touched, and said loudly at the start of a hold, naming who has the port, instead of a web spec failing on it.
HL_PORT=""
hl_port_pids() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -Fp 2>/dev/null | sed -n 's/^p//p'; }
hl_checkouts() { # the folders a Talos checkout is in: this one and every worktree of its repository, real paths, one a line
  local top w
  top="$(cd "$HERE/.." && pwd -P)"
  { printf '%s\n' "$top"; git -C "$top" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p'; } | while IFS= read -r w; do
    (cd "$w" 2>/dev/null && pwd -P)
  done
}
hl_in_checkout() { # hl_in_checkout <folder>: 0 when it is in one of those
  local d="$1" w
  while IFS= read -r w; do
    [ -n "$w" ] || continue
    case "$d/" in "$w"/*) return 0 ;; esac
  done <<CHECKOUTS
$(hl_checkouts)
CHECKOUTS
  return 1
}
hl_reaper() { # hl_reaper <pid>: 0 when it is what adopts an orphan: pid 1, or a subreaper (on Linux an orphan goes to the nearest one,
  # systemd --user, tini; launchd on a Mac), by its command's name
  local c
  [ "$1" = 1 ] && return 0
  c="$(ps -o comm= -p "$1" 2>/dev/null)"
  case "${c##*/}" in systemd | init | tini | dumb-init | launchd) return 0 ;; esac
  return 1
}
hl_reap_preview() { # the orphans on HL_PORT. What runs is `sh -c "vite build && pnpm exec vite preview ..."`, then pnpm, then node:
  # when the run goes only that shell, the leader of the group, is re-parented to pid 1; the server keeps its pnpm as parent. So it is
  # an orphan when its group's leader is gone or has pid 1 for parent, whatever the server's own parent is. And only when it is
  # `vite preview` with `--port <this port>` whole, with its working folder in a Talos checkout: another project's preview is not ours.
  local pid pg lp cmd cwd n
  [ -n "$HL_PORT" ] && command -v lsof > /dev/null 2>&1 || return 0
  for pid in $(hl_port_pids "$HL_PORT"); do
    cmd="$(ps -o command= -p "$pid" 2>/dev/null)"
    case "$cmd " in *vite*preview*"--port $HL_PORT "*) ;; *) continue ;; esac
    pg="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
    [ -n "$pg" ] || continue
    lp="$(ps -o ppid= -p "$pg" 2>/dev/null | tr -d ' ')"
    { [ -z "$lp" ] || hl_reaper "$lp"; } || continue # the leader lives under a living parent: a run in progress
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    [ -n "$cwd" ] && hl_in_checkout "$cwd" || continue
    echo "heavy-lock: stopping an orphaned preview server (pid $pid) on port $HL_PORT, left by a run that was stopped" >&2
    kill -TERM "$pid" 2>/dev/null
    n=0
    while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 30 ]; do sleep 0.1; n=$((n + 1)); done
    kill -KILL "$pid" 2>/dev/null
  done
  return 0
}
hl_port_taken() { # whoever still has the slot's port: said on stderr, the command runs on
  local pid
  [ -n "$HL_PORT" ] && command -v lsof > /dev/null 2>&1 || return 0
  for pid in $(hl_port_pids "$HL_PORT"); do
    echo "heavy-lock: warning: port $HL_PORT, slot ${TALOS_HEAVY_SLOT:-?}'s web preview port, is in use by pid $pid ($(ps -o command= -p "$pid" 2>/dev/null | cut -c1-100)); the web specs will fail on it" >&2
  done
  return 0
}
# What only this slot's command may use (the ports and names the suites bind, the folder they write to), all from the slot number:
#   PW_PORT                  the web specs' preview server: 4173 + 10 * (slot - 1) (TALOS_HEAVY_PW_PORT moves the base). CI's slots bind
#                            4873 and up (ci_slot_env), so a gate and a CI run never share one; slot 1 is the port a plain run uses.
#   TALOS_TEST_TMUX_PREFIX   the start of the name of every tmux socket (-L) a test makes: talos-test-s<slot>; never `talos`
#   TMPDIR                   with more than one slot: <cache>/tmp/talos-hv-s<slot> (TALOS_HEAVY_TMP moves the base), emptied now and
#                            removed at the end, and named in the run record so a waiter that takes the slot from a dead holder
#                            removes it. One slot: untouched, as before. Short on purpose: a test home's hub.sock lives under it.
hl_slot_env() { # hl_slot_env <slot> <slots>
  local k="$1" n="$2" base
  export TALOS_HEAVY_SLOT="$k"
  export PW_PORT=$((${TALOS_HEAVY_PW_PORT:-4173} + (k - 1) * 10))
  HL_PORT="$PW_PORT"
  export TALOS_TEST_TMUX_PREFIX="talos-test-s$k"
  [ "$n" -gt 1 ] || return 0
  base="${TALOS_HEAVY_TMP:-$CACHE/tmp}"
  HL_TMP="$base/talos-hv-s$k"
  { chmod -R u+w "$HL_TMP" 2>/dev/null; rm -rf "$HL_TMP"; } && mkdir -p "$HL_TMP" || { HL_TMP=""; return 0; }
  printf '%s\n' "$HL_TMP" > "$HL_REC/tmp"
  export TMPDIR="$HL_TMP"
}
hl_hold() { # under the lock: the command in a process group of its own, in a run record, so a waiter that takes the lock from a
  # dead holder stops what it left running (ci_reap_run), and two heavy jobs never overlap
  local rc
  HL_STARTED=1
  LOCK="${CI_LOCK_HELD:-$LOCK}" # the slot this hold has
  printf '%s\0' "$@" > "$LOCK/argv" 2>/dev/null # the exact command, for status and the tests
  unset HEAVY_LOCK_JUMP HEAVY_LOCK_PUSH # this one ticket's; nothing the command starts (a CI run in its tests) inherits them
  HL_REC="$CI_RUNS/$CI_NONCE"
  mkdir -p "$HL_REC" && ci_me > "$HL_REC/owner"
  if [ "$HL_MUTEX" = suites ]; then
    hl_slot_env "${CI_HEAVY_SLOT:-1}" "$(ci_heavy_slots "$CACHE")"
    hl_reap_preview
    hl_port_taken
  fi
  set -m
  "$@" &
  HL_PID=$!
  set +m
  printf '%s %s\n' "$HL_PID" "$(ci_proc_start "$HL_PID")" > "$HL_REC/groups"
  wait "$HL_PID"
  rc=$?
  HL_PID=""
  hl_reap_preview
  hl_tmp_drop
  rm -rf "$HL_REC"
  HL_REC=""
  return $rc
}

hl_run() { # hl_run <mutex: suites|desktop> <name> -- <cmd...>
  local mutex="$1" name="${2:-}"
  shift
  HL_MUTEX="$mutex"
  LOCK="$LOCKS/mutex-$mutex"
  [ -n "$name" ] || usage
  shift
  [ "${1:-}" = -- ] && shift
  [ $# -gt 0 ] || usage
  if [ "$mutex" = suites ]; then
    if ci_suites_nested "$LOCKS"; then exec "$@"; fi # inside a holder already: no second hold, no wait
  elif ci_mutex_nested "$LOCK"; then exec "$@"; fi
  trap 'hl_stop; ci_release_all; exit 143' TERM INT HUP
  trap 'ci_release_all' EXIT
  CI_MUTEX_WHAT="$name: $*" CI_MUTEX_JOB="$name"
  ci_mutex "$LOCKS" "$mutex" hl_hold "$@"
  local rc=$?
  # the command never started: the lock was not had in time (ci_mutex said so), which is 75, never the command's own code
  [ -n "$HL_STARTED" ] || return 75
  return $rc
}

hl_holder_line() { # hl_holder_line <lock dir>: "free", or "held by pid N (what, since T)", said when the holder is gone
  local lock="$1" owner pid
  owner="$(ci_owner "$lock")"
  pid="$(printf '%s\n' "$owner" | sed -n 1p)"
  if [ -z "$pid" ]; then
    printf 'free\n'
  else
    printf 'held by pid %s (%s, since %s)' "$pid" "$(head -1 "$lock/what" 2>/dev/null)" "$(ci_since "$lock/owner")"
    ci_owner_alive "$owner" || printf ' (that holder is gone: the next waiter takes it over)'
    echo
  fi
}
hl_status() {
  local t n max k l kci
  n="$(ci_heavy_slots "$CACHE")"
  max="$n"
  kci="$(ci_ci_slots "$CACHE" "$n")"
  for l in "$LOCKS"/mutex-suites-[0-9]*; do # a slot above today's number that is still held, from before it was lowered
    [ -d "$l" ] || continue
    k="${l##*-}"
    case "$k" in *[!0-9]*) continue ;; esac
    [ "$k" -le "$max" ] || max="$k"
  done
  if [ "$max" = 1 ]; then
    printf 'heavy lock: %s\n' "$(hl_holder_line "$LOCK")"
  else
    echo "heavy lock: $n slots"
    for ((k = 1; k <= max; k++)); do
      l="$(ci_suites_lock "$LOCKS" "$k")"
      [ "$k" -le "$n" ] || [ -d "$l" ] || continue
      printf '  slot %s%s: %s\n' "$k" "$([ "$k" -le "$kci" ] && echo " (CI's)")" "$(hl_holder_line "$l")"
    done
  fi
  # the order they go in (ci_queue_order: a jump, then CI, then the rest as they came), each with its kind
  local q="$LOCKS.queue/suites" c=0
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    c=$((c + 1))
    printf '  waiting %s: pid %s (%s), %s\n' "$c" "$(sed -n 1p "$t")" "$(sed -n 4p "$t")" "$(ci_ticket_kind "$t")"
  done <<ORDER
$( [ -d "$q" ] && ci_queue_order "$q" "$q/none")
ORDER
}

case "${1:-}" in
  run) shift && hl_run suites "$@" ;;
  desktop) shift && hl_run desktop "$@" ;;
  status) hl_status ;;
  held) case "${2:-}" in '') ci_suites_nested "$LOCKS" ;; desktop) ci_mutex_nested "$LOCKS/mutex-desktop" ;; *) usage ;; esac ;;
  *) usage ;;
esac
