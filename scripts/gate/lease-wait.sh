# shellcheck shell=bash
# Sourced by scripts/gate-push.sh. Definitions only: the queue for the push lease, and the wait for it (lease_take).
#
# A Ctrl-C (or TERM) while it waits must end the run, and cleanly (the EXIT trap lets the wait ref go). bash can lose one: a
# trap that comes due while the shell itself is in the middle of a $(...) fails to parse ("unexpected EOF while looking for
# matching `)'", bash 5.2) and its exit never runs: the wait polled on for good, or bash aborted ("bad jump") with no EXIT trap;
# bash 3.2 drops the whole loop instead. So the wait runs no $(...) and no child in the shell itself: each step runs in the
# background, its output to a file, and the shell waits for it with the wait builtin, which a trapped signal always
# interrupts. While WAITING the INT/TERM trap (gate-push.sh) only notes the signal (STOPPED); the wait then ends the run
# itself, 130. A step may or may not die of the Ctrl-C (bash 5.2 resets a trapped INT to the default in a background
# function, but a simple command run in the background ignores it, and a child may handle it), so a stop decides: a step that
# writes (-w, -l) is finished first (a wait ref pushed after the EXIT trap took it away would stay), a read is cut short
# at once, with everything under it (a look that hangs on the network must not hold the exit up). The time is one `date`
# and then $SECONDS (bash 3.2 has no printf %(%s)T).
STOPPED="" WAITING="" NOW=0 EPOCH0=0 SECONDS0=0
STEP_OUT="$GIT_DIR_ABS/talos-push.step.$$" # a step's output (gate-push.sh's EXIT trap removes it)
wait_step() { # wait_step [-w|-l] <out file> <command...>: the command in the background, its output to the file; its status
  local kind="" out job rc
  case "$1" in -w | -l) kind="$1" && shift ;; esac # -w: a step that writes; -l: the take of the lease (lease_put)
  out="$1"
  shift
  [ -z "$STOPPED" ] || exit 130
  "$@" </dev/null >"$out" &
  job=$!
  wait "$job"
  rc=$?
  [ -z "$STOPPED" ] || {
    if [ -z "$kind" ]; then (step_kill TERM "$job"); exit 130; fi
    while kill -0 "$job" 2>/dev/null; do wait "$job"; done
    [ "$kind" != -l ] || lease_kept "$out"
    exit 130
  }
  return "$rc"
}
# step_kill <signal> <pid>: that process and everything under it, each frozen first so that none starts anything new. TERM
# for a step (git takes its lock files away on TERM; KILL could leave one behind and break the next fetch).
step_kill() {
  local all="" next="$2" cur p
  while [ -n "$next" ]; do
    cur="$next" next=""
    for p in $cur; do
      kill -STOP "$p" 2>/dev/null || continue
      all="$all $p"
      next="$next $(pgrep -P "$p")"
    done
  done
  [ -n "$all" ] || return 0
  kill -"$1" $all 2>/dev/null
  kill -CONT $all 2>/dev/null
}
# A stop while the lease was being taken: its push may have landed (the step finished it, or died after it), so the lease
# that is there now is held when it is this run's (its sha printed, or its machine and pid), and the EXIT trap lets it go.
# Exiting with it unnoted left refs/locks/push held by a dead run until it ran out (10-60 min).
lease_kept() {
  local who pid
  LEASE=""
  read -r LEASE <"$1"
  [ -z "$LEASE" ] || return 0
  LEASE="$(lease_seen)"
  [ -n "$LEASE" ] || return 0
  IFS="|" read -r _ who pid <<<"$(lease_info "$LEASE")"
  [ "$who" = "$MACHINE" ] && [ "$pid" = "$$" ] || LEASE=""
}
nap() { # the poll's sleep: a stop ends it at once
  local job
  [ -z "$STOPPED" ] || exit 130
  sleep "$POLL_S" </dev/null >/dev/null 2>&1 &
  job=$!
  [ -z "$STOPPED" ] || { kill "$job" 2>/dev/null; exit 130; } # a stop that came just before the nap began
  wait "$job"
  [ -z "$STOPPED" ] || { kill "$job" 2>/dev/null; exit 130; }
}
now_s() { NOW=$((EPOCH0 + SECONDS - SECONDS0)); } # seconds since 1970, no fork
# ---- the queue: who waits for the lease, and since when --------------------------------------------------------------------
WAIT_REF="refs/locks/wait/$MACHINE"
WAIT_SINCE="" # when this run began waiting (seconds since 1970); empty while it is not in the queue
FIRST_SINCE="" # when this run first began waiting: a machine that let the lease go to gate again keeps its place
WAIT_PUT=0    # when its wait ref was last written
waiter_put() { # writes this machine's wait ref: since WAIT_SINCE, seen now (a step: the caller notes WAIT_PUT)
  local new
  new="$(printf 'talos push wait\n\nmachine=%s\nsince=%s\nseen=%s\npid=%s\n%s' "$MACHINE" "$WAIT_SINCE" "$(date +%s)" "$$" \
    "${RED_SHA:+red_main=$RED_SHA
}" | git commit-tree "$EMPTY_TREE")" || return 1
  git push -q --force "$REMOTE" "$new:$WAIT_REF" >/dev/null 2>&1 || return 1
}
waiter_join() { # in the queue from now (once), and still there (refreshed every WAITER_REFRESH_S); NOW is set
  if [ -z "$WAIT_SINCE" ]; then
    WAIT_SINCE="${FIRST_SINCE:-$NOW}"
    FIRST_SINCE="$WAIT_SINCE"
  elif [ $((NOW - WAIT_PUT)) -lt "$WAITER_REFRESH_S" ]; then
    return 0
  fi
  if wait_step -w /dev/null waiter_put; then WAIT_PUT=$NOW; fi
  return 0
}
waiter_leave() {
  [ -n "$WAIT_SINCE" ] || return 0
  git push -q "$REMOTE" ":$WAIT_REF" >/dev/null 2>&1 || true
  WAIT_SINCE=""
}
# The live waiter (seen within WAITER_STALE_S) that began before <since>, or before at the same second with a smaller name:
# printed when there is one, nothing when this machine is first in line. A queue that cannot be read puts nobody ahead.
waiter_ahead() {
  local since="$1" now ref name s seen claim theirs_red mine_red
  now=$(date +%s)
  git fetch -q --prune "$REMOTE" "+refs/locks/wait/*:refs/talos-wait/*" >/dev/null 2>&1 || return 0
  for ref in $(git for-each-ref --format='%(refname)' refs/talos-wait/ 2>/dev/null); do
    name="${ref#refs/talos-wait/}"
    [ "$name" != "$MACHINE" ] || continue
    s="$(git log -1 --format=%B "$ref" 2>/dev/null | sed -n 's/^since=//p' | head -1)"
    seen="$(git log -1 --format=%B "$ref" 2>/dev/null | sed -n 's/^seen=//p' | head -1)"
    case "$s$seen" in '' | *[!0-9]*) continue ;; esac
    [ ${#s} -le 11 ] && [ ${#seen} -le 11 ] || continue
    # live: seen lately, and not from the future (a clock far ahead, or a forged ref, must not block the queue for good)
    [ $((now - seen)) -lt "$WAITER_STALE_S" ] && [ $((seen - now)) -le 120 ] && [ $((s - now)) -le 120 ] || continue
    # a red-main claim counts only when it names the red this machine reads from the statuses itself
    claim="$(git log -1 --format=%B "$ref" 2>/dev/null | sed -n 's/^red_main=//p' | head -1)"
    # a claim, and main's verdict not looked up yet: the parent looks (once per run) and asks again
    if [ -n "$claim" ] && [ "$RED_LOOKED" = 0 ]; then
      echo "?red"
      return 0
    fi
    theirs_red=0
    if [ -n "$claim" ] && [ -n "$RED_CACHE" ] && [ "$claim" = "${RED_CACHE%% *}" ]; then theirs_red=1; fi
    mine_red=0
    [ -z "$RED_SHA" ] || mine_red=1
    if [ "$theirs_red" = 1 ] && [ "$mine_red" = 0 ]; then
      echo "$name red $claim"
      return 0
    fi
    [ "$mine_red" = 1 ] && [ "$theirs_red" = 0 ] && continue
    if [ "$s" -lt "$since" ] || { [ "$s" = "$since" ] && [ "$(printf '%s\n%s\n' "$name" "$MACHINE" | LC_ALL=C sort | head -1)" = "$name" ]; }; then
      echo "$name"
      return 0
    fi
  done
}
lease_look() { # one look at the lease: "<sha>|<until>|<machine>|<pid>"; the fields empty when there is none, or it is ours
  local seen
  seen="$(lease_seen)"
  if [ -n "$seen" ] && [ "$seen" != "$LEASE" ]; then printf '%s|%s\n' "$seen" "$(lease_info "$seen")"; else printf '%s|||\n' "$seen"; fi
}
say_held() { # say_held <who> <pid> <held since> <until> <waited>
  say "the push lease is held by ${1:-another machine} (pid ${2:-?}, seen holding it since $(iso_of "$3"), until $(iso_of "$4")); waited ${5}s: waiting"
}
lease_wait_done() { # leaving the wait: the trap exits at once again, and a stop noted meanwhile ends the run here
  WAITING=""
  rm -f "$STEP_OUT"
  [ -z "$STOPPED" ] || exit 130
}

LEASE_WAITED=0 # seconds this run has spent waiting for the lease, across requeues (its gates do not count)
lease_take() {
  local waited=0 tries=0 seen until who pid got ahead red_ahead holder="" held_since=0 t0 claim
  WAITING=1
  wait_step "$STEP_OUT" date +%s
  read -r EPOCH0 <"$STEP_OUT"
  SECONDS0=$SECONDS
  now_s
  t0=$NOW
  while :; do
    [ -z "$STOPPED" ] || exit 130
    now_s
    waited=$((LEASE_WAITED + NOW - t0)) # by the clock: the looks take time too
    seen="" until="" who="" pid=""
    wait_step "$STEP_OUT" lease_look
    IFS="|" read -r seen until who pid <"$STEP_OUT"
    now_s
    if [ -n "$seen" ] && [ "$seen" != "$LEASE" ]; then
      # its own lease, left behind by a release that failed: take it over, never wait on itself
      if [ "$who" = "$MACHINE" ] && [ "$pid" = "$$" ]; then until=""; fi
      if [ -n "$until" ] && [ "$until" -gt "$NOW" ] 2>/dev/null; then
        [ "$waited" -lt "$WAIT_S" ] || refuse "the push lease is held by ${who:-another machine} until $(iso_of "$until"); try again then"
        waiter_join
        # who, how long this run has seen them hold it, and how long it has waited: a jam is visible without asking
        [ "$holder" = "${who:-?}:${pid:-?}" ] || { holder="${who:-?}:${pid:-?}"; held_since=$NOW; }
        wait_step /dev/null say_held "$who" "$pid" "$held_since" "$until" "$waited"
        nap
        continue
      fi
    fi
    # free (or run out): first come, first served among the machines waiting for it, a checked red-main claim first
    ahead=""
    wait_step "$STEP_OUT" waiter_ahead "${WAIT_SINCE:-${FIRST_SINCE:-$NOW}}"
    read -r ahead <"$STEP_OUT"
    if [ "$ahead" = "?red" ]; then # a waiter claims main is red: look it up here, once per run (waiter_ahead is a step)
      RED_CACHE=""
      wait_step "$STEP_OUT" red_verdict
      read -r RED_CACHE <"$STEP_OUT"
      RED_LOOKED=1
      ahead=""
      wait_step "$STEP_OUT" waiter_ahead "${WAIT_SINCE:-${FIRST_SINCE:-$NOW}}"
      read -r ahead <"$STEP_OUT"
    fi
    red_ahead=0
    case "$ahead" in *" red "*)
      red_ahead=1
      claim="${ahead##* }"
      case " $RED_SAID " in *" ${ahead%% *} "*) ;; *)
        say "${ahead%% *} goes ahead: main is red at ${claim:0:7}"
        RED_SAID="$RED_SAID ${ahead%% *}"
        ;;
      esac
      ahead="${ahead%% *}"
      ;;
    esac
    if [ -n "$ahead" ]; then
      [ "$waited" -lt "$WAIT_S" ] || refuse "the push lease is free, but $ahead goes first; try again later"
      waiter_join
      [ "$red_ahead" = 1 ] || say "the push lease is free, but $ahead has waited longer: letting it go first"
      nap
      continue
    fi
    [ -z "$seen" ] || [ "$seen" = "$LEASE" ] || [ -z "${until:-}" ] || say "the lease of ${who:-another machine} ran out: taking it over"
    if wait_step -l "$STEP_OUT" lease_put "${seen:-}"; then
      read -r got <"$STEP_OUT"
      LEASE="$got"
      now_s
      LEASE_UNTIL=$((NOW + LEASE_S)) # set here: lease_put runs in a step
      LEASE_WAITED=$((LEASE_WAITED + NOW - t0))
      lease_wait_done
      waiter_leave
      return 0
    fi
    # lost a race for it (it changed between the look and the take), or the remote will not take the ref: a few more
    # looks, a poll apart, then on without a lease (it is advisory)
    tries=$((tries + 1))
    if [ "$tries" -ge 3 ]; then
      lease_wait_done
      say "could not take $LOCK on $REMOTE: pushing without a lease"
      return 0
    fi
    nap
  done
  # the loop ends only by the return or an exit above: here it was cut off (a trap bash lost, say). Nothing goes on.
  lease_wait_done
  refuse "the wait for the push lease was cut off: nothing pushed"
}
