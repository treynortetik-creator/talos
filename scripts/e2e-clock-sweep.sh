#!/usr/bin/env bash
# Proves e2e/tests/schedules.spec.ts does not depend on the time: the whole spec, with the suite's clock (E2E_NOW,
# e2e/harness/clock.ts) started at every hour of a plain day and on both sides of both clock changes in the scheduler's
# zone (America/New_York). Exit 0 only if every run passed. Takes about 7 minutes per instant / E2E_SWEEP_JOBS.
#
#   scripts/e2e-clock-sweep.sh                               # all 30 instants
#   scripts/e2e-clock-sweep.sh 2026-11-17T12:10:00Z ...      # just these
#   env: E2E_SWEEP_JOBS=3 runs at once · E2E_SWEEP_OUT=dir keeps logs there (default: a new temp dir)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JOBS="${E2E_SWEEP_JOBS:-3}"
OUT="${E2E_SWEEP_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/e2e-sweep.XXXX")}"
mkdir -p "$OUT"

if [ $# -gt 0 ]; then
  INSTANTS=("$@")
else
  INSTANTS=()
  # 2026-11-17 is a plain Tuesday: 05:10Z is 00:10 in New York, so this walks one local day from just after midnight.
  for h in 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20 21 22 23; do INSTANTS+=("2026-11-17T$h:10:00Z"); done
  for h in 00 01 02 03 04; do INSTANTS+=("2026-11-18T$h:10:00Z"); done
  INSTANTS+=(
    2026-11-01T05:30:00Z # 01:30 EDT, the first 01:30 of the morning the clocks go back
    2026-11-01T06:30:00Z # 01:30 EST, the second
    2026-11-01T16:00:00Z # 11:00 EST, later on the 25-hour day
    2027-03-14T06:30:00Z # 01:30 EST, the last half hour before the clocks go forward
    2027-03-14T07:30:00Z # 03:30 EDT, just after
    2027-03-14T15:00:00Z # 11:00 EDT, later on the 23-hour day
  )
fi

echo "building once for all runs"
(cd "$ROOT" && VITE_FAKE='' pnpm --filter @talos-app/relay --filter @talos-app/web build) > "$OUT/build.log" 2>&1 \
  || { echo "build failed: $OUT/build.log" >&2; exit 1; }

one() { # one <instant>: prints "<instant> <exit code>"
  local at="$1" id log rc
  id="$(printf '%s' "$at" | tr -d ':-')"
  log="$OUT/$id.log"
  mkdir -p "$OUT/$id/tmp"
  (cd "$ROOT/e2e" && TMPDIR="$OUT/$id/tmp" E2E_NOW="$at" E2E_SKIP_BUILD=1 \
    pnpm exec playwright test tests/schedules.spec.ts --output "$OUT/$id/results") > "$log" 2>&1
  rc=$?
  echo "$at exit=$rc $(grep -E '^ +[0-9]+ (passed|failed)' "$log" | tr -s ' ' | tr '\n' ' ')"
  [ "$rc" = 0 ] && rm -rf "${OUT:?}/${id:?}"
  return "$rc"
}
export -f one
export OUT ROOT

printf '%s\n' "${INSTANTS[@]}" | xargs -P "$JOBS" -I{} bash -c 'one "$1"' _ {} | tee "$OUT/results.txt"
fails="$(grep -c -v 'exit=0 ' "$OUT/results.txt")"
total="$(wc -l < "$OUT/results.txt" | tr -d ' ')"
echo "$((total - fails))/$total instants passed; logs: $OUT"
[ "$total" = "${#INSTANTS[@]}" ] && [ "$fails" = 0 ]
