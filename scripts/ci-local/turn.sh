# scripts/ci-local/turn.sh: a gate's heavy hold and a CI run never overlap on one machine. Sourced by locks.sh; not run on its own.
# docs/CI-LOCAL.md ("Gate and CI take turns") has the whole rule. In short, two classes take turns:
#   CI    a whole ci-local.sh run: it holds locks/slot-N from ci_acquire_slot to its cleanup (install, build, e2e and the image job
#         take no suites slot, so the run is the unit, not a slot hold)
#   gate  a hold of one of the gate slots, K+1..N, of the suites mutex (anything heavy-lock.sh runs)
# A new run and a new gate hold each ask first, under one short lock (locks/mutex-turn) that is kept through the caller's own take
# of its slot, so the look and the take are one step. The answer is no while a living holder of the other class exists (its owner
# is checked as every lock's is: a holder whose process is gone counts for nothing) and while a waiter of the other class that goes
# first is queued (CI runs wait in locks.queue/admit, gates in locks.queue/suites). A waiting gate goes
# BEFORE a waiting CI run (a gate's wait behind the previous push's CI run was most of the time a push took); a CI run goes first only
# once it is starved: it has waited behind CI_TURN_PASS_MAX gates (2, counted in locks.queue/gate-passes) or CI_TURN_PASS_MAX_S seconds
# (1800), whichever comes first (ci_turn_starved); a `jump` gate goes before every CI waiter, starved or not, and a scheduled run (the
# nightly) is never starved and never makes a gate wait. Nobody is stopped, and a run that was admitted is never held up: its own holds
# and cleanup never ask.
# Line 7 of a ticket: a CI run's (locks.queue/admit) is "sched" (a scheduled run) or "caps N S" (its starvation caps, ci_turn_caps); a gate's
# (locks.queue/suites) is "turn2", which says its waiter knows the cap: a CI run defers only to such gates, and to gates of the older code that
# queued before it (else each would wait for the other until a cap).
# A run that waits ONLY for a part on another machine does not hold the turn (ci_fold_wait: the fold loops of check and browser mark
# it, per job, in the run's record; the run is idle while every job of it that has not ended is marked): a waiting gate may go. A job
# that goes back to heavy work (a take-back) first takes the turn again (ci_fold_resume): it waits while a gate holds the machine,
# and nothing is stopped; past CI_TURN_MAX_S it goes ahead, loudly, as a new run does.
# A CI run that holds a run slot gives the machine up to a waiting gate between whole holds (ci_yield, called by ci_mutex before a CI job
# takes a heavy-lock slot or the desktop mutex): a job that finds a gate waiting or holding takes no slot, marks itself idle as a fold wait
# does (the same folding-<job> file, with the run's first-yield time and caps in it), keeps its place in the queue, and asks again each poll.
# The run is idle once every job of it that has not ended is marked (a job waiting for another job, wait_for_job, and the second job of a
# group that has not begun are marked too), so a gate waits for the holds that are on, never for the rest of the run. A hold is never cut:
# nothing is held when a job yields, and a quiet or exclusive group, which is one hold, is never left in the middle. The caps are the
# queued run's, once per run: after CI_TURN_PASS_MAX gates have passed it while it yielded, or CI_TURN_PASS_MAX_S seconds after its first
# yield (results/yield-since, results/yield-passes), its markers stop counting: the run holds the turn again, the gates that wait are
# behind it, and the job goes on after any gate that holds now (ci_fold_resume). A gate's wait is the mutex's own deadline (exit 75). A CI run fails OPEN: past CI_TURN_MAX_S it goes ahead beside the gate, loudly
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
ci_turn_holders() { # ci_turn_holders <locks dir> <ci|gate> [nosched]: "pid N (what, since T)" for each living holder of that class, one a line
  # (nosched: the CI runs a scheduled run holds - the file `sched` in its slot - are left out)
  local locks="$1" l k o cache n nci
  cache="$(dirname "$locks")"
  if [ "$2" = ci ]; then
    for l in "$locks"/slot-[0-9]*; do
      case "${l##*/slot-}" in '' | *[!0-9]*) continue ;; esac
      [ -z "${3:-}" ] || [ ! -e "$l/sched" ] || continue
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
ci_turn_now() { printf '%s' "${CI_TURN_NOW:-$(date +%s)}"; } # seconds; CI_TURN_NOW is the tests' clock
ci_turn_ticket_time() { # ci_turn_ticket_time <ticket>: the time in its name (<%017.6f time>.<pid>.<random>); fails for any other name
  local n="${1##*/}"
  n="${n%.*}" n="${n%.*}"
  case "$n" in '' | .* | *[!0-9.]*) return 1 ;; esac
  printf '%s' "$n"
}
ci_turn_num() { # ci_turn_num <value> <default>: the value when it is a whole number, else the default
  case "$1" in '' | *[!0-9]*) printf '%s' "$2" ;; *) printf '%s' "$1" ;; esac
}
ci_turn_caps() { # ci_turn_caps <CI ticket>: "<gates> <seconds>", the starvation caps of that run. Line 7 of its ticket says what it asked
  # for ("caps N S", written by ci_acquire_slot from CI_TURN_PASS_MAX and CI_TURN_PASS_MAX_S), so a gate and the run read the same numbers,
  # whatever each one's environment; a ticket with none (an older ci-local.sh, a hand-made one) takes the reader's own, then 2 and 1800.
  local l7 a b c
  l7="$(sed -n 7p "$1" 2>/dev/null)"
  case "$l7" in
    "caps "[0-9]*" "[0-9]*) read -r a b c <<CAPS
$l7
CAPS
      case "$b$c" in *[!0-9]*) ;; *) printf '%s %s' "$b" "$c"; return 0 ;; esac ;;
  esac
  printf '%s %s' "$(ci_turn_num "${CI_TURN_PASS_MAX:-}" 2)" "$(ci_turn_num "${CI_TURN_PASS_MAX_S:-}" 1800)"
}
ci_turn_starved() { # ci_turn_starved <locks dir> <CI ticket>: 0 when that CI run has waited behind its cap of gates (CI_TURN_PASS_MAX, 2), or
  # for its cap of seconds (CI_TURN_PASS_MAX_S, 1800; ci_turn_caps): from then on it goes before every gate that waits (but never before one
  # that holds, nor a `jump` gate). A gate is a pass when it took its slot while this ticket was queued (ci_turn_pass). A scheduled run is
  # never starved, and a ticket with no time in its name is not either: both wait for their own cap, CI_TURN_MAX_S.
  local ts nmax smax n
  ci_ticket_sched "$2" && return 1
  ts="$(ci_turn_ticket_time "$2")" || return 1
  read -r nmax smax <<CAPS
$(ci_turn_caps "$2")
CAPS
  [ $(($(ci_turn_now) - 10#${ts%%.*})) -lt "$smax" ] || return 0
  n="$(awk -v t="$ts" '$1 + 0 >= t + 0 { n++ } END { print n + 0 }' "$1.queue/gate-passes" 2>/dev/null)" # no record yet: awk prints nothing
  [ "${n:-0}" -ge "$nmax" ]
}
ci_turn_pass() { # ci_turn_pass <locks dir>: a gate has taken its slot (the turn lock is held): one pass for every CI run that is queued
  # (one line of the time in <locks>.queue/gate-passes). Lines older than the oldest queued CI ticket count for nobody and go; with no CI
  # run queued there is nothing to count, and the file goes. A ticket still being written (.part) is queued too: its time is already its own.
  local f="$1.queue/gate-passes" t n old="" now
  for t in "$(dirname "$1")"/runs/*/results/folding-*; do # a run that yields to gates (ci_yield): this gate is one pass for it, however many jobs yield
    [ -s "$t" ] && [ "${t%/*}" != "${n:-}" ] && ci_yield_live "${t%/*}" "$t" || continue
    n="${t%/*}"
    printf '%s\n' "$(ci_turn_now)" >> "$n/yield-passes"
  done
  n=""
  for t in "$1.queue/admit"/*; do
    [ -f "$t" ] || continue
    case "$t" in *.part) [ -z "$(find "$t" -mmin +1 2>/dev/null)" ] || continue ;; esac # a .part older than a minute is a writer that died
    n="$(ci_turn_ticket_time "${t%.part}")" || continue
    if [ -z "$old" ] || [[ "$n" < "$old" ]]; then old="$n"; fi
  done
  if [ -z "$old" ]; then rm -f "$f"; return 0; fi
  now="$(LC_ALL=C perl -MTime::HiRes=time -e 'printf "%017.6f", $ARGV[0] ne "" ? $ARGV[0] : time' "${CI_TURN_NOW:-}")"
  { [ ! -f "$f" ] || awk -v o="$old" '$1 + 0 >= o + 0' "$f"; printf '%s\n' "$now"; } > "$f.new" 2>/dev/null && mv -f "$f.new" "$f" 2>/dev/null
  return 0
}
ci_turn_ahead() { # ci_turn_ahead <locks dir> <ci|gate> <my ticket> <my jump>: the waiters of the OTHER class that go before this,
  # "pid N (what)", one a line. For a CI run: every gate that waits (a gate goes before a waiting CI run), unless the run is starved
  # (ci_turn_starved): then only a `jump` gate. For a gate: only the CI runs that are starved; a `jump` gate goes before every CI waiter.
  local locks="$1" t q starved="" mine="${3##*/}"
  [ -n "$mine" ] || mine="~" # no ticket: every gate of the old code is ahead
  if [ "$2" = gate ]; then q="$locks.queue/admit"; else q="$locks.queue/suites"; fi
  [ -d "$q" ] || return 0
  [ "$2" != gate ] || [ "$4" != jump ] || return 0
  if [ "$2" = ci ] && ci_turn_starved "$locks" "$3"; then starved=1; fi
  while IFS= read -r t; do
    [ -n "$t" ] && [ "$t" != "$3" ] || continue
    if [ "$2" = ci ]; then
      [ "$(ci_ticket_kind "$t")" != ci ] || continue
      if [ "$(ci_ticket_kind "$t")" != jump ]; then
        [ -z "$starved" ] || continue
        # a gate of the old code (no "turn2" on line 7 of its ticket) never makes a record of the passes and waits for CI queued before
        # it: this run defers to it only if it was queued first, as before, or each would wait for the other until a cap
        [ "$(sed -n 7p "$t")" = turn2 ] || [[ "${t##*/}" < "$mine" ]] || continue
      fi
    else
      # a scheduled run (the nightly, the hostile nightly) never makes a gate wait: it leaves a free slot to a push run that is queued
      # (ci_acquire_slot), and that run is starved only by gates, so a gate that waited for the scheduled run would close a cycle
      ! ci_ticket_sched "$t" || continue
      ci_turn_starved "$locks" "$t" || continue
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
  elif [ -n "$a" ] && [ "$2" = gate ]; then CI_TURN_BASE="CI runs that have waited behind enough gates or long enough go first ($a)"
  elif [ -n "$a" ]; then CI_TURN_BASE="gates that are queued go before this run ($a)"
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
    w="$w${w:+; }pid $(sed -n 1p "$t") ($(sed -n 4p "$t")$(! ci_turn_starved "$locks" "$t" || echo ', starved: goes next'))"
  done
  [ -z "$w" ] || echo "  CI runs waiting for their turn: $w"
  return 0
}
ci_fold_wait() { [ -z "$2" ] || : > "$1/folding-$2" 2>/dev/null; return 0; } # ci_fold_wait <results dir> <job>: the job now waits only for a part on another machine
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
    [ ! -s "$rd/results/folding-$j" ] || ci_yield_live "$rd/results" "$rd/results/folding-$j" || return 1 # a yield (ci_yield): idle while it counts
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
  [ -n "$job" ] || return 0
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
ci_yield_starved() { # ci_yield_starved <results dir>: 0 when the run has yielded to gates as long as its caps allow (results/yield-since: its first
  # yield's time and caps N S; results/yield-passes: a line for each gate that passed it meanwhile); 1 when it may still yield. A record that
  # cannot be read counts as starved: the run then holds the turn, as it did before it could yield.
  local t0 nmax smax n
  [ -e "$1/yield-since" ] || return 1
  read -r t0 nmax smax < "$1/yield-since" 2>/dev/null
  case "$t0$nmax$smax" in '' | *[!0-9]*) return 0 ;; esac
  [ $(($(ci_turn_now) - 10#$t0)) -lt "$smax" ] || return 0
  n="$(wc -l < "$1/yield-passes" 2>/dev/null)"
  [ "$((${n// /} + 0))" -ge "$nmax" ]
}
ci_yield_live() { # ci_yield_live <results dir> <marker file>: 0 while that yield marker counts: touched in the last 5 min (a job that yields asks every poll)
  # and the run not starved (a marker that is empty is a fold wait's: ci_turn_run_idle never asks)
  [ -z "$(find "$2" -mmin +5 2>/dev/null)" ] && ! ci_yield_starved "$1"
}
ci_yield_wanted() { # ci_yield_wanted <locks dir>: the gates that wait for the machine or hold it, "pid N (what)", one a line. A gate that waits
  # for a starved CI run (ci_turn_ahead) is left out: that run is queued for a run slot this run holds, so yielding to the gate would be a cycle
  local q="$1.queue/suites" t
  while IFS= read -r t; do
    [ -n "$t" ] && [ "$(ci_ticket_kind "$t")" != ci ] || continue
    [ -z "$(ci_turn_ahead "$1" gate "$t" "$(sed -n 5p "$t")")" ] || continue
    printf 'pid %s (%s)\n' "$(sed -n 1p "$t")" "$(sed -n 4p "$t" | cut -c1-70)"
  done <<ORDER
$( [ -d "$q" ] && ci_queue_order "$q" "$q/none")
ORDER
  ci_turn_holders "$1" gate
}
ci_yield() { # ci_yield <locks dir> <mutex name> <its queue ticket>: ci_yield_try, and whenever the job does not yield it has its ticket back
  local rc
  ci_yield_try "$@"
  rc=$?
  [ "$rc" = 0 ] || [ -z "${3:-}" ] || [ ! -f "$3.part" ] || mv -f "$3.part" "$3" 2>/dev/null # its place in line, kept: the name is the time it came
  return $rc
}
ci_yield_try() { # ci_yield_try <locks dir> <mutex name> <its queue ticket>: called by ci_mutex for a CI job that holds nothing and is about to ask for a slot of the
  # suites mutex or for the desktop mutex. 0 = it lets go now (CI_YIELD_SAYS says for whom); it is marked idle and asks again next poll, its place in
  # the queue kept. 1 = go on: no gate waits or holds, or the run's caps are used up (it first takes the turn back: ci_fold_resume waits
  # while a gate holds, kills nobody, and past CI_TURN_MAX_S goes ahead, loudly). Never inside a hold (TALOS_HELD_LOCKS): a hold is a whole unit.
  # While it yields its ticket is set aside as <ticket>.part (ci_queue_order skips it, the name and so its place in line stay): a job that
  # lets go must not hold up another run's exclusive group, which takes slots only when first in line, and wait with it for the same gate.
  local locks="$1" rd="${RESULTS:-}" job="${CI_JOBNAME:-}" f w tmp tk="${3:-}"
  case "$2" in suites | desktop) ;; *) return 1 ;; esac
  [ -n "$rd" ] && [ -n "$job" ] && [ -d "$rd" ] && [ -z "${TALOS_HELD_LOCKS:-}" ] || return 1
  f="$rd/folding-$job"
  [ ! -e "$f" ] || [ -s "$f" ] || return 1 # an empty marker is a fold wait's own
  if ci_turn_on "$locks"; then
    w="$(ci_yield_wanted "$locks" | ci_turn_join)"
    if [ -n "$w" ] && ! ci_yield_starved "$rd"; then
      if [ -s "$f" ]; then touch "$f" 2>/dev/null
      else
        ci_self # the jobs of a run are subshells of one shell: $$ is the same for all of them
        tmp="$rd/yield-since.$CI_SELF_PID.$RANDOM"
        if [ ! -e "$rd/yield-since" ]; then # the first yield of the run: its time and caps, made whole or not at all, by the first of its jobs
          printf '%s %s %s\n' "$(ci_turn_now)" "$(ci_turn_num "${CI_TURN_PASS_MAX:-}" 2)" "$(ci_turn_num "${CI_TURN_PASS_MAX_S:-}" 1800)" > "$tmp" 2>/dev/null &&
            ln "$tmp" "$rd/yield-since" 2>/dev/null
          rm -f "$tmp"
        fi
        { cp "$rd/yield-since" "$f.new" 2>/dev/null && [ -s "$f.new" ] && mv -f "$f.new" "$f" 2>/dev/null; } || { rm -f "$f.new"; return 1; } # never an empty marker: that reads as a fold wait
      fi
      [ -z "$tk" ] || [ ! -f "$tk" ] || mv -f "$tk" "$tk.part" 2>/dev/null
      CI_YIELD_SAYS="a gate waits for the machine ($w): this job takes no hold until it has had its turn, and then takes its place in line again"
      return 0
    fi
  fi
  if [ -s "$f" ]; then ci_fold_resume "$rd" "$job" "$locks"; fi
  return 1
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
ci_sched_yield() { # ci_sched_yield <locks dir> <my ticket>: 0 (CI_SCHED_SAYS says why) while a push run is queued or holds a run slot: a scheduled
  # run starts only on an empty queue (the gates, held or queued, it has already waited for: ci_turn_check). A run that waits only for a
  # part on another machine does not hold (ci_turn_holders), nor does another scheduled run (the nightly and the hostile one overlap).
  local h
  if ci_push_queued "$1.queue/admit" "$2"; then CI_SCHED_SAYS="a push run is queued"; return 0; fi
  h="$(ci_turn_holders "$1" ci nosched | ci_turn_join)"
  [ -n "$h" ] || return 1
  CI_SCHED_SAYS="a push run is on ($h)"
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
