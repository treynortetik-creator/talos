#!/usr/bin/env bash
# Lemnos's side of re-running browser with its part (docs/CI-MACHINES.md, "The e2e packages on Titan"): a late step of the `ci`
# job that fails when Titan's `browser-e2e` job does, so "Re-run failed jobs" of the part re-runs Lemnos's browser too, and the
# re-run part has a browser of its own attempt to fold into. Job conclusions decide nothing about a commit (its statuses do).
#
# The other way needs nothing: browser re-run without the part finds no answer in its attempt, and ci-local.sh takes the
# packages back after CI_BROWSER_E2E_WAIT (slower, correct). So Titan never waits for Lemnos (it has one runner).
#
#   ci-pair.sh part  exit 1 at once when a step of the part's job failed, or when its job ended without success; exit 0 when it
#        concluded success, or never started (Titan off or busy: close cancels it, and "Re-run failed jobs" takes a cancelled job
#        anyway). While it works, it waits (the step's own timeout bounds that).
#
# The same for check-titan (CI_PART_JOB=check-titan, CI_TITAN_CHECK=on: the ci job then sets CI_CHECK_PART), so a re-run of
# that part re-runs Lemnos's check too; in shadow its red never fails Lemnos's job.
# Only when Lemnos folds the part (CI_TITAN_BROWSER=e2e with its wait: the ci job then sets CI_BROWSER_E2E_PART): in e2e-shadow
# the part is report-only, and its red (run 43549764317: Titan's infra) must never fail Lemnos's job. Without it: exit 0.
# GitHub unreadable five times in a row: exit 1 (a re-run then takes both). Input (env): GITHUB_REPOSITORY, GITHUB_RUN_ID,
# GH_TOKEN; CI_BROWSER_E2E_PART; CI_PART_JOB, the part's job exactly as the jobs API lists it; CI_PAIR_POLL (30 s).
set -uo pipefail

poll="${CI_PAIR_POLL:-30}"
case "$poll" in '' | *[!0-9]* | 0*) echo "ci-pair: CI_PAIR_POLL is whole seconds, at least 1" >&2; exit 64 ;; esac
[ "${1:-}" = part ] || { echo "usage: ci-pair.sh part" >&2; exit 64; }
# which fold pairs with which part: check-titan with check's (CI_CHECK_PART, CI_TITAN_CHECK=on), else browser-e2e with browser's
case "${CI_PART_JOB:-}" in check-titan) fold="${CI_CHECK_PART:-}" ;; *) fold="${CI_BROWSER_E2E_PART:-}" ;; esac
[ -n "$fold" ] || { echo "ci-pair: this run does not fold the part (not e2e, or check not on Titan); nothing to pair"; exit 0; }
for v in GITHUB_REPOSITORY GITHUB_RUN_ID CI_PART_JOB; do
  [ -n "${!v:-}" ] || { echo "ci-pair: $v is not set" >&2; exit 64; }
done

# One line per job of the run: name, status, conclusion, the first step that failed
jobs_now() {
  gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/jobs?per_page=100" \
    --jq '.jobs[] | [.name, .status, (.conclusion // ""), ([(.steps // [])[] | select(.conclusion == "failure") | .name] | first // "")] | @tsv'
}
field() { awk -F'\t' -v n="$2" -v c="$3" '$1 == n { print $c; exit }' <<<"$1"; } # field <jobs> <job name> <column>

m="$CI_PART_JOB" unread=0
while :; do
  if ! all="$(jobs_now 2>/dev/null)"; then
    unread=$((unread + 1))
    [ "$unread" -lt 5 ] || { echo "ci-pair: the run's jobs could not be read; this job fails, so a re-run takes both"; exit 1; }
    sleep "$poll"
    continue
  fi
  unread=0
  st="$(field "$all" "$m" 2)" concl="$(field "$all" "$m" 3)" bad="$(field "$all" "$m" 4)"
  if [ -n "$bad" ]; then
    echo "ci-pair: $m's step '$bad' failed: this job fails too, so \"Re-run failed jobs\" re-runs Lemnos's job with it"
    exit 1
  fi
  case "$st" in
    completed)
      [ "$concl" = success ] && { echo "ci-pair: $m concluded success"; exit 0; }
      echo "ci-pair: $m ended '$concl': this job fails too, so \"Re-run failed jobs\" re-runs Lemnos's job with it"
      exit 1 ;;
    in_progress) ;;
    *) echo "ci-pair: $m never started ('${st:-not listed}'): nothing to pair"; exit 0 ;;
  esac
  sleep "$poll"
done
