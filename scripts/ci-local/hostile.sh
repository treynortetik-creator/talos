# The hostile nightly's conditions (docs/CI-MACHINES.md, "The hostile nightly"), sourced by ci-local.sh only when CI_HOSTILE=1.
# shellcheck shell=bash
# The run tests main under conditions the normal runs never see, to find time bombs and environment assumptions before users
# do: the clock about 30 days ahead, a far time zone, a temp folder with a space in its path, and CPU load. Every condition is
# said in the run's log and written to <cache>/hostile/<sha7>.conditions, which the alert step copies into the report.
#
#   ci_hostile_setup <cache> <sha7>  before the slot's temp folder is made: picks the conditions, sets CI_TMP_BASE, says them
#   ci_hostile_env                   in each job's shell: exports the clock shift and the time zone to everything the job runs
#   ci_hostile_with_load <locks> <cmd...>  ci_mutex's suites hold: <cmd> with a CPU burner beside it (scripts/cpu-burn.sh, half
#                                    the cores, at most 600 s, under the group time limit), stopped and checked when <cmd> ends
CI_HOSTILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CI_HOSTILE_CLOCK_MS=2592000000 # 30 days
CI_HOSTILE_FILE="" CI_HOSTILE_TZ=""

ci_hostile_setup() {
  local cache="$1" short="$2" shim="$CI_HOSTILE_DIR/hostile-clock.cjs" cores
  mkdir -p "$cache/hostile" || return 1
  CI_HOSTILE_FILE="$cache/hostile/$short"
  : > "$CI_HOSTILE_FILE.load" || return 1
  # far from UTC on both sides, a different one on alternate days of the month: UTC+14 on odd days, UTC-11 on even ones
  case "$(date -u +%d)" in *[13579]) CI_HOSTILE_TZ=Pacific/Kiritimati ;; *) CI_HOSTILE_TZ=Pacific/Pago_Pago ;; esac
  # a fresh folder (the slot's temp folder is emptied first) with a space in its path, under the cache: not /tmp, not /var/folders
  CI_TMP_BASE="$cache/hostile tmp"
  # NODE_OPTIONS is split on spaces, so the preload's path must have none (the runner's checkout never has)
  case "$shim" in *[[:space:]]*) CI_HOSTILE_CLOCK_MS=0 ;; esac
  cores=$(($(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || echo 2) / 2))
  [ "$cores" -ge 1 ] || cores=1
  CI_HOSTILE_CORES="$cores"
  {
    if [ "$CI_HOSTILE_CLOCK_MS" != 0 ]; then
      echo "clock: +30 days for JavaScript (Date.now and new Date, through NODE_OPTIONS=--require and BUN_OPTIONS=--preload of scripts/ci-local/hostile-clock.cjs); not shifted: timers, performance.now, Swift, the shell's date, file times, bun's worker threads"
    else
      echo "clock: NOT shifted (the preload's path has a space: $shim)"
    fi
    echo "time zone: TZ=$CI_HOSTILE_TZ ($(TZ=$CI_HOSTILE_TZ date +%z)), for every process the jobs start"
    echo "temp folder: TMPDIR under '$CI_TMP_BASE' (a space in the path, emptied first)"
    echo "load: $cores CPU burner(s) (half the cores, scripts/cpu-burn.sh) while this run holds the heavy lock, at most 600 s per hold"
  } > "$CI_HOSTILE_FILE.conditions" || return 1
  sed 's/^/ci-local: hostile: /' "$CI_HOSTILE_FILE.conditions"
}

ci_hostile_env() {
  export TZ="$CI_HOSTILE_TZ"
  [ "$CI_HOSTILE_CLOCK_MS" != 0 ] || return 0
  local shim="$CI_HOSTILE_DIR/hostile-clock.cjs"
  export TALOS_HOSTILE_CLOCK_MS="$CI_HOSTILE_CLOCK_MS"
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=$shim" BUN_OPTIONS="${BUN_OPTIONS:+$BUN_OPTIONS }--preload=$shim"
}

# The burner is scripts/cpu-burn.sh (the one sanctioned load), started inside this hold: it asks heavy-lock.sh whether it runs
# in the holder (TALOS_CI_CACHE points it at this run's locks) and refuses at once otherwise (HEAVY_LOCK_TIMEOUT=1), so it
# never burns while a push run or a gate holds the lock. Around it, the group time limit (600 s; TERM, then KILL after 5 s).
CI_HOSTILE_LIMIT='$t=shift; $p=fork; if(!$p){setpgrp(0,0); exec @ARGV} $SIG{ALRM}=sub{kill "TERM",-$p; sleep 5; kill "KILL",-$p; exit 142}; alarm $t; waitpid($p,0); exit($? & 127 ? 128+($? & 127) : $? >> 8)'
ci_hostile_with_load() {
  local locks="$1" err pid rc
  shift
  err="$(mktemp "${TMPDIR:-/tmp}/hostile-burn.XXXXXX")" || { "$@"; return; }
  TALOS_CI_CACHE="$(dirname "$locks")" HEAVY_LOCK_TIMEOUT=1 perl -e "$CI_HOSTILE_LIMIT" 600 \
    bash "${CI_HOSTILE_BURN:-$CI_HOSTILE_DIR/../cpu-burn.sh}" --cores "${CI_HOSTILE_CORES:-1}" --seconds 600 -- sleep 600 \
    </dev/null >/dev/null 2>"$err" &
  pid=$!
  "$@"
  rc=$?
  ci_hostile_burn_stop "$pid" "$err"
  rm -f "$err"
  return $rc
}
# ci_hostile_burn_stop <perl pid> <burner's stderr>: TERM to the burner (the perl's child; it stops its burners itself), then a
# look by process group that nothing of it is left (any left are KILLed), one line in the run's load record and on stderr.
ci_hostile_burn_stop() {
  local pid="$1" err="$2" kid="" g n=0 left="" line
  # it says its burners' group once they are up; wait for that (or for it to end, refused) so a stop never lands mid-start
  while kill -0 "$pid" 2>/dev/null && ! grep -q 'burners (group ' "$err" 2>/dev/null && [ "$n" -lt 100 ]; do sleep 0.1; n=$((n + 1)); done
  kid="$(pgrep -P "$pid" 2>/dev/null | head -1)"
  [ -z "$kid" ] || kill -TERM "$kid" 2>/dev/null
  wait "$pid" 2>/dev/null
  g="$(sed -n 's/.*burners (group \([0-9][0-9]*\)).*/\1/p' "$err" | head -1)"
  for n in $g $kid; do
    if kill -0 -- "-$n" 2>/dev/null; then left="$left $n"; kill -KILL -- "-$n" 2>/dev/null; fi
  done
  if [ -z "$g" ]; then line="load: not applied to this hold ($(grep -m1 'cpu-burn' "$err" 2>/dev/null || echo 'the burner did not start'))"
  elif [ -n "$left" ]; then line="load: burner stopped; group(s)$left were still there and were killed"
  else line="load: burner stopped, none left (group $g)"; fi
  echo "ci-local: hostile: $line" >&2
  [ -z "$CI_HOSTILE_FILE" ] || echo "$line" >> "$CI_HOSTILE_FILE.load"
}
