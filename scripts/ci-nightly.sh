#!/bin/bash
# Dispatches the nightly or the hostile nightly of ci-runner.yml, as its GitHub schedule would, but on time (GitHub starts schedules
# 6-12 h late). docs/CI-MACHINES.md, "The nightly by hand, and on time".
#
#   scripts/ci-nightly.sh nightly|hostile
#
# Run by launchd on the lead's Mac from a checkout of main: com.talos.ci-nightly at 02:17 (nightly) and com.talos.ci-hostile at 04:43
# (hostile) local time; two jobs, so a Mac asleep through both fires both on wake and neither is lost.
# The dispatch runs as the repository owner's account, chosen by name (scripts/ci-runner/gh-account.sh; CI_GH_USER names another),
# never gh's active one: on 2026-11-19 the active account was a work login and the hostile dispatch failed, "HTTP 404: workflow
# ci-runner.yml not found". The repository: CI_REPO, else this checkout's github.com origin.
# Every run is one line in <cache>/logs/ci-nightly.log (TALOS_CI_CACHE, default ~/.cache/talos-ci). A run that dispatched nothing (no
# repository, no account, gh failed) also writes one alert for the lead in <cache>/alerts (ci-alerts.sh watch passes it on), so a
# night without its run is never silent (one alert per kind and night, so a second failed night is said too). launchd fires on wake,
# often before the network is back: each try has a time limit (CI_NIGHTLY_LIMIT_S, 120 s, the whole process group), and a failed try
# is retried (CI_NIGHTLY_TRIES, 3, CI_NIGHTLY_PAUSE_S, 45 s apart). A LaunchAgent (it needs the user's HOME and gh login).
# Exit: 0 dispatched, 64 usage, 1 nothing dispatched.
set -u
kind="${1:-}"
case "$kind" in nightly | hostile) ;; *) echo "usage: ci-nightly.sh nightly|hostile" >&2; exit 64 ;; esac
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" # launchd's PATH has no Homebrew; one already given goes first
HERE="$(cd "$(dirname "$0")" && pwd)"
cache="${TALOS_CI_CACHE:-${HOME:-/nonexistent}/.cache/talos-ci}"
log="$cache/logs/ci-nightly.log"
mkdir -p "${log%/*}" "$cache/alerts"
# shellcheck source=ci-runner/gh-account.sh
. "$HERE/ci-runner/gh-account.sh"

said() { printf '%s %s: exit %s: %s\n' "$(date '+%F %H:%M:%S')" "$kind" "$1" "$2" >> "$log"; }
night="$(date +%F)"
fail() { # <why>: logged, an alert for the lead (one per kind and night), exit 1
  said 1 "$1"
  ci_gh_problem "$cache" "nightly-$kind-$night" "the $kind dispatch of ci-runner.yml did not run on $night (scripts/ci-nightly.sh), so that night has no $kind run: $1" 2>/dev/null
  exit 1
}
# limited <seconds> <cmd...>: the command in its own process group, the whole group stopped at the limit (exit 142); a gh hung on a
# connection that died across sleep never holds the job, which launchd would not start again while it runs
limited() {
  # shellcheck disable=SC2016
  perl -e '$t=shift; $p=fork; if(!$p){setpgrp(0,0); exec @ARGV} $SIG{ALRM}=sub{kill "TERM",-$p; sleep 5; kill "KILL",-$p; exit 142}; alarm $t; waitpid($p,0); exit($? & 127 ? 128+($? & 127) : $? >> 8)' "$@"
}

repo="${CI_REPO:-$(ci_gh_origin_repo "$HERE/..")}"
[ -n "$repo" ] || fail "no repository: set CI_REPO=<owner>/<name>, or run this from a checkout whose origin is on github.com"
tok="$(ci_gh_token "$repo" 2>"$cache/.ci-nightly-gh.err")" || fail "$(tail -1 "$cache/.ci-nightly-gh.err" 2>/dev/null)"
tries="${CI_NIGHTLY_TRIES:-3}" pause="${CI_NIGHTLY_PAUSE_S:-45}" limit="${CI_NIGHTLY_LIMIT_S:-120}" try=1
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# dispatched_since_start: a try that timed out may have reached GitHub (only the answer was lost): a second dispatch would run the
# whole nightly twice (its concurrency group never cancels), so before trying again, look for a dispatch made since this run began
dispatched_since_start() {
  local n
  n="$(GH_TOKEN="$tok" limited "$limit" gh run list --repo "$repo" --workflow ci-runner.yml --event workflow_dispatch \
    --created ">=$started" --json databaseId --jq length </dev/null 2>/dev/null)" || return 1
  [ "${n:-0}" -gt 0 ] 2>/dev/null
}
done_ok() { # <what to log>
  said 0 "$1"
  rm -f "$cache/alerts/said/gh-nightly-$kind-"* # this night's and any earlier failed night's
  exit 0
}
while :; do
  if out="$(GH_TOKEN="$tok" limited "$limit" gh workflow run ci-runner.yml --repo "$repo" --ref main -f nightly="$kind" </dev/null 2>&1)"; then
    done_ok "$out"
  else
    rc=$?
  fi
  if [ "$rc" = 142 ]; then
    out="no answer from GitHub within $limit s"
    ! dispatched_since_start || done_ok "dispatched (the answer timed out, but GitHub lists the run)"
  fi
  [ "$try" -lt "$tries" ] || break
  said 1 "try $try of $tries failed, again in $pause s: $(printf '%s' "$out" | tail -1)"
  try=$((try + 1))
  sleep "$pause"
done
fail "gh workflow run failed $tries times: $(printf '%s' "$out" | tail -1)"
