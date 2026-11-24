# scripts/ci-local/turn.sh: a gate's heavy hold and a CI run never overlap on one machine. Sourced by locks.sh; not run on its own.
# docs/CI-LOCAL.md ("Gate and CI take turns") has the whole rule. In short, two classes take turns:
#   CI    a whole ci-local.sh run: it holds locks/slot-N from ci_acquire_slot to its cleanup (install, build, e2e and the image job
#         take no suites slot, so the run is the unit, not a slot hold)
#   gate  a hold of one of the gate slots, K+1..N, of the suites mutex (anything heavy-lock.sh runs)
# A new run and a new gate hold each ask first, under one short lock (locks/mutex-turn) that is kept through the caller's own take
# of its slot, so the look and the take are one step. The answer is no while a living holder of the other class exists (its owner
# is checked as every lock's is: a holder whose process is gone counts for nothing) and while a waiter of the other class that came
# earlier is queued (CI runs wait in locks.queue/admit, gates in locks.queue/suites; a `jump` gate goes before CI waiters). Nobody
# is stopped, and a run that was admitted is never held up: its own holds and cleanup never ask.
# A run that waits ONLY for a part on another machine does not hold the turn (ci_fold_wait: the fold loops of check and browser mark
# it, per job, in the run's record; the run is idle while every job of it that has not ended is marked): a waiting gate may go. A job
# that goes back to heavy work (a take-back) first takes the turn again (ci_fold_resume): it waits while a gate holds the machine,
# and nothing is stopped; past CI_TURN_MAX_S it goes ahead, loudly, as a new run does.
# A gate's wait is the mutex's own deadline (exit 75). A CI run fails OPEN: past CI_TURN_MAX_S it goes ahead beside the gate, loudly
# (a log line and an alert), because an untested main commit is worse than a noisy run.
CI_TURN_T0="" CI_TURN_ALERTED="" CI_TURN_SAYS="" CI_TURN_BASE="" CI_TURN_HELD="" CI_TURN_DIR=""
ci_turn_on() { # ci_turn_on <locks dir>: 0 when the turns apply (two heavy slots or more, not switched off)
  local cache
  cache="$(dirname "$1")"
  [ "${CI_TURN:-}" != 0 ] || return 1
  [ ! -e "$cache/turn-off" ] || return 1
  [ "$(ci_heavy_slots "$cache")" -ge 2 ]
}
ci_turn_enter() { # ci_turn_enter <locks dir>: take locks/mutex-turn, asking for up to 3 s; 0 = held (ci_turn_leave lets go)
  local l="$1/mutex-turn" n=0
  mkdir -p "$1" 2>/dev/null
  while [ "$n" -lt 60 ]; do
    if ci_lock_try "$l" turn; then
      CI_HELD="${CI_HELD%"$l"$'\n'}" # not in the list ci_release_all walks: one look a poll would make it thousands of lines (ci_release_all asks CI_TURN_HELD)
      CI_TURN_DIR="$l" CI_TURN_HELD=1
      return 0
    fi
    sleep 0.05
    n=$((n + 1))
  done
  return 1
}
ci_turn_leave() { [ -z "$CI_TURN_HELD" ] || ci_lock_release "$CI_TURN_DIR"; CI_TURN_HELD=""; return 0; }
ci_turn_holders() { # ci_turn_holders <locks dir> <ci|gate>: "pid N (what, since T)" for each living holder of that class, one a line
  local locks="$1" l k o cache n nci
  cache="$(dirname "$locks")"
  if [ "$2" = ci ]; then
    for l in "$locks"/slot-[0-9]*; do
      case "${l##*/slot-}" in '' | *[!0-9]*) continue ;; esac
      o="$(ci_owner "$l")"
      { [ -n "$o" ] && ci_owner_alive "$o"; } || continue
      ci_turn_run_idle "$cache" "$o" && continue # it waits only for a part on another machine: no heavy step of its own is going
      printf 'pid %s (%s, since %s)\n' "$(printf '%s\n' "$o" | sed -n 1p)" "$(head -1 "$l/what" 2>/dev/null | cut -c1-70)" "$(ci_since "$l/owner")"
    done
  else
    n="$(ci_heavy_slots "$cache")"
    nci="$(ci_ci_slots "$cache" "$n")"
    for l in "$locks"/mutex-suites-[0-9]*; do
      k="${l##*/mutex-suites-}"
      case "$k" in '' | *[!0-9]*) continue ;; esac
      [ "$k" -gt "$nci" ] || continue
      o="$(ci_owner "$l")"
      { [ -n "$o" ] && ci_owner_alive "$o"; } || continue
      printf 'pid %s (%s, since %s)\n' "$(printf '%s\n' "$o" | sed -n 1p)" "$(head -1 "$l/what" 2>/dev/null | cut -c1-70)" "$(ci_since "$l/owner")"
    done
  fi
}
ci_turn_ahead() { # ci_turn_ahead <locks dir> <ci|gate> <my ticket> <my jump>: the waiters of the OTHER class that go before this
  # ticket (a jump gate goes before every CI waiter; a gate waiter that jumps goes before every CI run), "pid N (what)", one a line
  local locks="$1" mine="${3##*/}" t q name
  [ -n "$mine" ] || mine="~" # no ticket: everybody else is ahead
  if [ "$2" = gate ]; then q="$locks.queue/admit"; else q="$locks.queue/suites"; fi
  [ -d "$q" ] || return 0
  [ "$2" != gate ] || [ "$4" != jump ] || return 0
  while IFS= read -r t; do
    [ -n "$t" ] && [ "$t" != "$3" ] || continue
    name="${t##*/}"
    if [ "$2" = ci ]; then
      [ "$(ci_ticket_kind "$t")" != ci ] || continue
      [ "$(ci_ticket_kind "$t")" = jump ] || [[ "$name" < "$mine" ]] || continue
    else
      [[ "$name" < "$mine" ]] || continue
      # a scheduled run (the nightly, the hostile nightly) never makes a gate wait: it leaves a free slot to a push run that is queued
      # (ci_acquire_slot), and that run waits for the gates queued before it, so a gate that waited for the scheduled run would close a cycle
      ! ci_ticket_sched "$t" || continue
    fi
    printf 'pid %s (%s)\n' "$(sed -n 1p "$t")" "$(sed -n 4p "$t" | cut -c1-70)"
  done <<ORDER
$(ci_queue_order "$q" "$q/none")
ORDER
}
ci_turn_join() { awk 'NF { printf "%s%s", (n++ ? "; " : ""), $0 }'; } # lines to one: "a; b"
ci_turn_check() { # ci_turn_check <locks dir> <ci|gate> <my ticket> <my jump>: sets CI_TURN_SAYS and returns 1 when this class must wait
  local locks="$1" other h a
  [ "$2" = ci ] && other=gate || other=ci
  h="$(ci_turn_holders "$locks" "$other" | ci_turn_join)"
  a="$(ci_turn_ahead "$locks" "$2" "$3" "$4" | ci_turn_join)"
  if [ -n "$h" ] && [ "$2" = gate ]; then CI_TURN_BASE="CI runs hold the machine ($h), and nothing is stopped: this gate goes when they have finished"
  elif [ -n "$h" ]; then CI_TURN_BASE="a gate holds the machine ($h), and nothing is stopped: this run starts when it has finished"
  elif [ -n "$a" ] && [ "$2" = gate ]; then CI_TURN_BASE="CI runs queued before this gate go first ($a)"
  elif [ -n "$a" ]; then CI_TURN_BASE="gates queued before this run go first ($a)"
  else CI_TURN_BASE=""; CI_TURN_SAYS=""; return 0; fi
  return 1
}
ci_turn_alert() { # ci_turn_alert <locks dir> <text> [beside]: ONE alert file for this wait (a file in <cache>/alerts, as ci-alerts.sh watch
  # passes on); a CI run that goes ahead beside a gate has its own (beside)
  local a b p tag="turn${3:+-$3}"
  a="$(dirname "$1")/alerts"
  b="$a/$CI_TURN_T0-$tag-$$.txt" p="$a/.$CI_TURN_T0-$tag-$$.part"
  if [ -n "${3:-}" ]; then :; else [ -z "$CI_TURN_ALERTED" ] || return 0; CI_TURN_ALERTED=1; fi
  mkdir -p "$a" 2>/dev/null && printf 'HEAVY TURN: %s\nThe log: %s/logs/lock-waits.tsv (kind turn); who holds the machine: scripts/heavy-lock.sh status\n' "$2" "$(dirname "$1")" > "$p" 2>/dev/null &&
    ln "$p" "$b" 2>/dev/null
  rm -f "$p" 2>/dev/null
  return 0
}
ci_turn_waited() { echo $(($(date +%s) - ${CI_TURN_T0:-$(date +%s)})); }
ci_turn_note() { # ci_turn_note <locks dir> <ci|gate>: after a refusal: the wait's clock, the line's minutes (it changes every 5 min, so
  # the waiter says it again), and the one alert after TALOS_TURN_ALERT_S (1200 s)
  local w al="${TALOS_TURN_ALERT_S:-1200}"
  case "$al" in '' | *[!0-9]*) al=1200 ;; esac
  [ -n "$CI_TURN_T0" ] || CI_TURN_T0="$(date +%s)"
  w="$(ci_turn_waited)"
  [ -n "$CI_TURN_BASE" ] || CI_TURN_BASE="the turn lock is busy (held by pid $(ci_owner "$1/mutex-turn" | sed -n 1p))" # a busy lock is a wait too (its clock runs, so a CI run still fails open); the line before it stays
  CI_TURN_SAYS="$CI_TURN_BASE"
  [ "$w" -lt 300 ] || CI_TURN_SAYS="$CI_TURN_BASE (waiting $((w / 300 * 5)) min)"
  [ "$w" -lt "$al" ] || ci_turn_alert "$1" "$2 has waited $((w / 60)) min for its turn: $CI_TURN_SAYS"
  return 0
}
ci_turn_overdue() { # a CI run that has waited CI_TURN_MAX_S (3000 s) goes ahead beside the gate: said loudly, with the alert
  local max="${CI_TURN_MAX_S:-3000}"
  case "$max" in '' | *[!0-9]*) max=3000 ;; esac
  [ -n "$CI_TURN_T0" ] && [ "$(ci_turn_waited)" -ge "$max" ]
}
ci_turn_done() { # ci_turn_done <locks dir> <what> <got|timed out|ran beside>: a wait of 1 s or more is a row (kind turn); the clock resets
  [ -z "$CI_TURN_T0" ] || ci_wait_log "$1" turn "$2" "$CI_TURN_T0" "$3" turn
  CI_TURN_T0="" CI_TURN_ALERTED="" CI_TURN_BASE=""
  return 0
}
ci_turn_gate_enter() { # ci_turn_gate_enter <locks dir> <my ticket> <my jump>: 0 = this gate may take its slot now, with the turn lock
  # HELD (the caller takes its slot, then ci_turn_leave); 1 = wait, CI_TURN_SAYS says for whom
  if ci_turn_enter "$1"; then
    ci_turn_check "$1" gate "$2" "$3" && return 0
    ci_turn_leave
  fi
  ci_turn_note "$1" "a gate ($(printf '%s' "${CI_MUTEX_WHAT:-?}" | cut -c1-60))"
  return 1
}
ci_turn_ci_enter() { # ci_turn_ci_enter <locks dir> <my ticket> <what>: the same for a new CI run
  if ci_turn_enter "$1"; then
    ci_turn_check "$1" ci "$2" "" && return 0
    ci_turn_leave
  fi
  ci_turn_note "$1" "CI run $3"
  return 1
}
ci_turn_status() { # ci_turn_status <locks dir>: for heavy-lock.sh status
  local locks="$1" h w t
  ci_turn_on "$locks" || { echo "turns: off (one heavy slot, CI_TURN=0 or a turn-off file)"; return 0; }
  h="$(ci_turn_idle_runs "$locks")"
  [ -z "$h" ] || echo "turns: CI runs waiting only for a part (they do not hold the turn): $(printf '%s\n' "$h" | ci_turn_join)"
  h="$(ci_turn_holders "$locks" ci)"
  if [ -n "$h" ]; then echo "turns: CI's: $(printf '%s\n' "$h" | ci_turn_join)"
  else
    h="$(ci_turn_holders "$locks" gate)"
    if [ -n "$h" ]; then echo "turns: the gates': $(printf '%s\n' "$h" | ci_turn_join)"; else echo "turns: nobody holds the machine"; fi
  fi
  w=""
  for t in "$locks.queue/admit"/*; do
    case "$t" in *.part) continue ;; esac
    [ -f "$t" ] || continue
    ci_owner_alive "$(sed -n 1,3p "$t")" || continue
    w="$w${w:+; }pid $(sed -n 1p "$t") ($(sed -n 4p "$t"))"
  done
  [ -z "$w" ] || echo "  CI runs waiting for their turn: $w"
  return 0
}
ci_fold_wait() { : > "$1/folding-$2" 2>/dev/null; return 0; } # ci_fold_wait <results dir> <job>: the job now waits only for a part on another machine
ci_fold_end() { rm -f "$1/folding-$2"; return 0; } # the wait is over and what follows is light (the part's answer is read, a status posted)
ci_turn_run_idle() { # ci_turn_run_idle <cache dir> <owner text of a run slot>: 0 when every job of that run that has not ended is marked
  # as waiting on a part (its record: runs/<nonce>/jobs lists them, results/<job> is there once one has ended). No record, or no job
  # listed yet (setup, or an older ci-local.sh): not idle, so the run holds the turn as it always did.
  local rd j n=0 nonce
  nonce="$(printf '%s\n' "$2" | sed -n 3p)"
  [ -n "$nonce" ] && rd="$1/runs/$nonce" && [ -s "$rd/jobs" ] || return 1
  while IFS= read -r j; do
    [ -n "$j" ] || continue
    [ ! -f "$rd/results/$j" ] || continue
    [ -f "$rd/results/folding-$j" ] || return 1
    n=$((n + 1))
  done < "$rd/jobs"
  [ "$n" -gt 0 ]
}
ci_fold_resume() { # ci_fold_resume <results dir> <job> <locks dir>: this job is about to do heavy work again (a part taken back): take the
  # turn again. Under the turn lock the marker is cleared at once: from then on a gate that looks sees a run that holds, so gates that come
  # later wait behind it (they cannot keep pushing the take-back past the cap), while the take-back itself waits, said and never killed, for the
  # gates that hold the machine now (a hold ends: a gate never waits for CI in the middle of one). Past CI_TURN_MAX_S it goes ahead beside
  # them, loudly, with one alert. A run inside a holder (ci_suites_nested: it runs inside a gate's hold), or turns off: the marker is just cleared.
  local rd="$1" job="$2" locks="$3" h line said="" max="${CI_TURN_MAX_S:-3000}" t0
  case "$max" in '' | *[!0-9]*) max=3000 ;; esac
  # (not TALOS_CI_NESTED: ci-local.sh sets that for every run once it has its slot; a run started inside a holder is ci_suites_nested)
  if ! ci_turn_on "$locks" || ci_suites_nested "$locks"; then ci_fold_end "$rd" "$job"; return 0; fi
  t0="$(date +%s)"
  while :; do
    if ci_turn_enter "$locks"; then
      ci_fold_end "$rd" "$job"
      h="$(ci_turn_holders "$locks" gate | ci_turn_join)"
      ci_turn_leave
      if [ -z "$h" ]; then
        [ -z "$said" ] || echo "ci-local: $job goes on: no gate holds the machine now" >&2
        return 0
      fi
      line="$job waits to go on: a gate holds the machine ($h), and nothing is stopped"
    else
      line="$job waits to go on: the turn lock is busy"
    fi
    if [ $(($(date +%s) - t0)) -ge "$max" ]; then
      ci_fold_end "$rd" "$job"
      echo "ci-local: $job resumed beside a gate after $((($(date +%s) - t0) / 60)) min (CI_TURN_MAX_S): $line" >&2
      CI_TURN_T0="$t0" ci_turn_alert "$locks" "CI job $job resumed beside a gate after $((($(date +%s) - t0) / 60)) min of waiting for its turn (CI_TURN_MAX_S): $line" "beside-$job"
      return 0
    fi
    [ "$line" = "$said" ] || { echo "ci-local: $line" >&2; said="$line"; }
    sleep "${CI_POLL:-5}"
  done
}
ci_turn_idle_runs() { # ci_turn_idle_runs <locks dir>: "pid N (what, since T)" for each living run that waits only for a part
  local locks="$1" l o
  for l in "$locks"/slot-[0-9]*; do
    case "${l##*/slot-}" in '' | *[!0-9]*) continue ;; esac
    o="$(ci_owner "$l")"
    { [ -n "$o" ] && ci_owner_alive "$o"; } || continue
    ci_turn_run_idle "$(dirname "$locks")" "$o" || continue
    printf 'pid %s (%s, since %s)\n' "$(printf '%s\n' "$o" | sed -n 1p)" "$(head -1 "$l/what" 2>/dev/null | cut -c1-70)" "$(ci_since "$l/owner")"
  done
}
# A scheduled run (the nightly or the hostile nightly: CI_NIGHTLY=1, CI_HOSTILE=1) says so on line 7 of its ticket ("sched"). It goes after
# every other CI ticket, and never takes a free slot while one of those is queued: a push to main is judged first. Nothing running is
# stopped for it, and a scheduled step that already runs finishes (its own per-file limit ends a stuck test).
ci_scheduled_run() { [ "${CI_NIGHTLY:-}" = 1 ] || [ "${CI_HOSTILE:-}" = 1 ]; } # ci-local.sh keeps both as shell variables for its jobs (export -n)
ci_ticket_sched() { [ "$(sed -n 7p "$1" 2>/dev/null)" = sched ]; } # ci_ticket_sched <ticket>
ci_push_queued() { # ci_push_queued <queue dir> <my ticket>: 0 when a living CI ticket that is not scheduled, and not mine, is queued
  local t
  while IFS= read -r t; do
    [ -n "$t" ] && [ "$t" != "$2" ] && [ "$(ci_ticket_kind "$t")" = ci ] && ! ci_ticket_sched "$t" && return 0
  done <<ORDER
$(ci_queue_order "$1" "$2")
ORDER
  return 1
}
# A part (a run with CI_STATUS_PREFIX=ci-part: check on Titan, a bridge shard) that queues for a lock on its own machine says so, so
# the run that folds it does not count that time against its wait (jobs-check.sh, part_lockwait; docs/CI-MACHINES.md, "A part queued
# for a lock"). A job has no token, so it only writes the file CI_LOCKWAIT_FILE (a plain variable of the job's shell, set in run_job for a
# part; never exported, a test run inside the job must not write it): "<since> <last beat> <what it waits for>", tab-separated, each
# poll while a wait lasts. The main shell posts the status from it (part_beat_post), and stops when ci_part_beat_end removes it.
CI_BEAT_SINCE="" CI_BEAT_WHAT=""
ci_part_beat() { # ci_part_beat [what]: a lock wait goes on; what it waits for is kept from the call that gave it
  [ -n "${CI_LOCKWAIT_FILE:-}" ] || return 0
  [ -n "$CI_BEAT_SINCE" ] || CI_BEAT_SINCE=$(date +%s)
  [ -z "${1:-}" ] || CI_BEAT_WHAT="${1//[$'\t\r\n']/ }"
  printf '%s\t%s\t%s\n' "$CI_BEAT_SINCE" "$(date +%s)" "$CI_BEAT_WHAT" > "$CI_LOCKWAIT_FILE.new" 2>/dev/null &&
    mv -f "$CI_LOCKWAIT_FILE.new" "$CI_LOCKWAIT_FILE" 2>/dev/null || true # whole or not at all: the main shell reads it at any moment
}
ci_part_beat_end() { # the wait is over (the lock is had, or not had in time)
  [ -z "$CI_BEAT_SINCE" ] || rm -f "$CI_LOCKWAIT_FILE" 2>/dev/null
  CI_BEAT_SINCE="" CI_BEAT_WHAT=""
  return 0
}
