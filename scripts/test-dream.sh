#!/usr/bin/env bash
# test-dream.sh -- the nightly dream cycle (scripts/dream/*). Runs the unittest suite against a FAKE agent folder in
# a temp dir (the test copies scripts/dream into it), with a throwaway HOME and XDG dirs. Never touches the real wiki,
# ~/.config, ~/.local, launchd or the network. Final line: "dream: PASS n FAIL m"; nonzero exit on any failure.
export PYTHONDONTWRITEBYTECODE=1
set -uo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)" || exit 2
case "$T" in /*/*) ;; *) echo "suspicious temp dir '$T'" >&2; exit 2 ;; esac
trap 'rm -rf "$T"' EXIT
export HOME="$T/home" XDG_CONFIG_HOME="$T/cfg" XDG_STATE_HOME="$T/state" XDG_DATA_HOME="$T/data" TMPDIR="$T"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$XDG_DATA_HOME"
unset TALOS_UNATTENDED CHRONOS_RUN

LOG="$T/unittest.log"
python3 -W ignore "$KIT/scripts/dream/tests/test_dream.py" >"$LOG" 2>&1
RC=$?
grep -E '^(test_|FAIL|ERROR| *\.\.\.)|\.\.\. (ok|FAIL|ERROR|skipped)' "$LOG" | sed 's/^/  /'
if [ "$RC" -ne 0 ]; then echo; sed -n '/^======/,$p' "$LOG" | head -80; fi
RAN="$(grep -oE '^Ran [0-9]+' "$LOG" | tail -1 | grep -oE '[0-9]+')"
BAD="$(grep -E '^FAILED \(' "$LOG" | grep -oE '[0-9]+' | awk '{s+=$1} END{print s+0}')"
BAD="${BAD:-0}"
RAN="${RAN:-0}"
PASS=$((RAN - BAD))
if [ "$RAN" -eq 0 ]; then BAD=$((BAD + 1)); fi
echo
echo "dream: PASS $PASS FAIL $BAD"
[ "$RC" -eq 0 ] && [ "$BAD" -eq 0 ]
