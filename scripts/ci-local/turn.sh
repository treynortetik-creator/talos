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
