#!/usr/bin/env bash
# The machine's fleet name, for anything the gate writes or suggests where others can read it (a handoff branch, the push
# lease's wait ref). It comes only from TALOS_MACHINE and must be one of the fleet's names: a host name can carry a person's
# name, and refs and branches on origin must never (the privacy rule). Unset or unknown: one plain line, and no name.
#
#   . scripts/talos-machine.sh; me="$(talos_machine)" || exit 1
TALOS_FLEET='cyclops lemnos delphi hestia titan'
talos_machine() {
  local m="${TALOS_MACHINE:-}"
  case "$m" in
    '' | *[!a-z]*) ;; # one lowercase word, or it is not a fleet name
    *) case " $TALOS_FLEET " in *" $m "*)
      printf '%s\n' "$m"
      return 0
      ;;
    esac ;;
  esac
  # the value itself is not repeated: it may be a host name
  printf 'gate: set TALOS_MACHINE to this machine'"'"'s fleet name (one of: %s), never its host name\n' "$TALOS_FLEET" >&2
  return 1
}

# ---- how long a test may take on this machine ---------------------------------------------------------------------------------
# Shared by scripts/gate.sh and scripts/ci-local.sh, so the gate and CI pick a factor by one rule. Every test budget is multiplied
# by TALOS_TEST_TIME_FACTOR (vitest.config.ts, apps/bridge/scripts/test-parallel.ts, the testkit's t(ms)); one set already wins.
#   factor = max(core floor, clamp(ceil(load / cores), 1, 4))
#   core floor  3 on 4 cores or fewer, else 1 (the rule from before the load term: a factor is never lower than that was).
#   load        the larger of the 1- and 5-minute load averages, read once when the gate or the CI job starts. A load average counts
#               the processes wanting a core, so load / cores is about how many times slower than idle a CPU-bound test runs. The
#               1-minute figure alone drops within a minute of a CI run ending and hides a load that is still there; the 5-minute
#               one alone lags a load that has just started. Taking the larger errs toward a longer budget, which only delays a
#               real hang being caught, where a short one fails a good test (4 gate refusals on 11-25 at a load of 40 to 140 on 18
#               cores, at factor 1: heavy-lock 66 s against 60, ci-runner 46.7 s against 30).
#   cap 4       a budget four times as long still catches a hang; past that a hang costs more than the flake does.
# The cores this process may use: nproc honours a CPU affinity limit (taskset), getconf does not and is the fallback where there is
# no nproc (macOS). Apple silicon counts its efficiency cores too, and tests on them run several times slower: an M1 Air reports 8
# and has 4 performance cores, so its gate ran at factor 1 and timing tests failed under load. There the performance cores are the
# count (hw.perflevel0.physicalcpu; a Mac without performance levels, or another system, has no such key and keeps nproc). Only on
# a small one, though (8 cores or fewer in all): a base M5's 4 performance cores sit beside 6 efficiency cores, and that machine is
# fast.
all_cores() { nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0; }
cores_here() {
  local all p
  all="$(all_cores)"
  p="$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null)"
  case "$p" in '' | *[!0-9]* ) p="" ;; esac
  case "$all" in '' | *[!0-9]* ) all=0 ;; esac
  if [ -n "$p" ] && [ "$all" -le 8 ]; then echo "$p"; else echo "$all"; fi
}
# load_peak: the larger of the 1- and 5-minute load averages as a number, or nothing where neither can be read (then the core
# floor stands alone). GATE_LOAD is a test's own reading ("1.5" or "1.5 2.5"), never set otherwise: no test loads the machine.
load_peak() {
  local raw
  if [ -n "${GATE_LOAD:-}" ]; then
    raw="$GATE_LOAD"
  else
    raw="$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}')" # macOS: { 1.20 1.50 1.80 }
    [ -n "$raw" ] || raw="$(cut -d' ' -f1,2 /proc/loadavg 2>/dev/null)" # Linux
  fi
  printf '%s\n' "$raw" | awk '{ m = -1; for (i = 1; i <= 2 && i <= NF; i++) if ($i ~ /^[0-9]+(\.[0-9]+)?$/ && $i + 0 > m) m = $i + 0; if (m >= 0) print m }'
}
# talos_time_factor <cores, a number>: sets TALOS_TEST_TIME_FACTOR (the caller exports it) unless one is already set, and
# TIME_FACTOR_WHY, the reason in a few words. Call once, at the start: the factor is one number for the whole run.
talos_time_factor() {
  local cores="$1" floor=1 load f
  if [ -n "${TALOS_TEST_TIME_FACTOR:-}" ]; then
    TIME_FACTOR_WHY="TALOS_TEST_TIME_FACTOR was already set"
    return 0
  fi
  [ "$cores" -gt 4 ] || floor=3
  load="$(load_peak)"
  if [ -z "$load" ]; then
    TALOS_TEST_TIME_FACTOR="$floor"
    TIME_FACTOR_WHY="$cores cores, load unreadable: the core floor $floor"
    return 0
  fi
  f="$(awk -v l="$load" -v c="$cores" -v fl="$floor" 'BEGIN { n = int(l / c); if (n < l / c) n++; if (n < 1) n = 1; if (n > 4) n = 4; print (n > fl ? n : fl) }')"
  TALOS_TEST_TIME_FACTOR="$f"
  TIME_FACTOR_WHY="load $load on $cores cores (core floor $floor, cap 4), sampled at the start"
}
