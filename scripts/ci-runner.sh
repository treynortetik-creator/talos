#!/usr/bin/env bash
# The glue between .github/workflows/ci-runner.yml and scripts/ci-local.sh, on the self-hosted runner (label talos-ci).
# Logic lives here, not in the workflow, so scripts/ci-runner.test.ts can run it. docs/CI-LOCAL.md, "On the self-hosted runner".
#
#   ci-runner.sh guard   refuse anything that is not a same-repo PR, a push to main or a dispatch of a plain ref (exit 1, says why)
#   ci-runner.sh tools   which pinned tools the runner already has at the pinned version (lines for $GITHUB_OUTPUT)
#   ci-runner.sh size    CI_SLOTS and CI_MAX_LOAD for this machine, from its cores and memory now (lines for $GITHUB_ENV)
#   ci-runner.sh run     guard, then scripts/ci-local.sh --pr N (or --ref REF; --ref <the pushed sha> for a push) with the runner's settings
#   ci-runner.sh sweep   after the run, even a cancelled one: close any status of THIS workflow run that is still pending
#   ci-runner.sh verdict [N]   the last verdict on main: the newest of the last N commits (default 20, at most 100) with all six
#                        local-ci/* statuses final, whether each passed, and the newer commits that have none, and why.
#                        Exit 0 green, 1 red, 2 no verdict in the window or GitHub could not be read. Needs gh, and
#                        GITHUB_REPOSITORY (or CI_REPO), else `gh repo view`.
#
# Input is environment only (the workflow passes the event's fields as env, never spliced into a command line):
#   GITHUB_EVENT_NAME, GITHUB_REPOSITORY, GITHUB_REF and GITHUB_SHA (push), PR_NUMBER, PR_HEAD_SHA, PR_HEAD_REPO, INPUT_REF, INPUT_JOBS (dispatch only), GH_TOKEN, CI_STATUS_URL, CI_SHA_FILE
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# ---------- guard ----------
ci_guard() {
  local repo="${GITHUB_REPOSITORY:-}" ref
  case "${GITHUB_EVENT_NAME:-}" in
    pull_request)
      case "${PR_NUMBER:-}" in '' | *[!0-9]*) echo "ci-runner: refusing: PR number '${PR_NUMBER:-}' is not a number" >&2; return 1 ;; esac
      case "${PR_HEAD_SHA:-}" in
        *[!0-9a-f]* | '') echo "ci-runner: refusing: PR head '${PR_HEAD_SHA:-}' is not a commit sha" >&2; return 1 ;;
      esac
      [ "${#PR_HEAD_SHA}" = 40 ] || { echo "ci-runner: refusing: PR head '$PR_HEAD_SHA' is not a full sha" >&2; return 1; }
      # A fork's head repo is another repository. An empty one (a deleted fork) fails closed, the same way.
      if [ -z "$repo" ] || [ "$(lower "${PR_HEAD_REPO:-}")" != "$(lower "$repo")" ]; then
        echo "ci-runner: refusing: PR #$PR_NUMBER comes from '${PR_HEAD_REPO:-an unknown repository}', not from $repo. This runner only tests branches of $repo." >&2
        return 1
      fi ;;
    push)
      # Only main, and only as a full commit sha: the run tests that exact commit, never "whatever main is by then". The
      # workflow's `branches: [main]` filter says the same; this holds if that filter is ever edited away.
      [ "${GITHUB_REF:-}" = refs/heads/main ] || { echo "ci-runner: refusing: a push to '${GITHUB_REF:-}', only refs/heads/main is tested on push" >&2; return 1; }
      case "${GITHUB_SHA:-}" in *[!0-9a-f]* | '') echo "ci-runner: refusing: pushed commit '${GITHUB_SHA:-}' is not a commit sha" >&2; return 1 ;; esac
      [ "${#GITHUB_SHA}" = 40 ] || { echo "ci-runner: refusing: pushed commit '$GITHUB_SHA' is not a full sha" >&2; return 1; }
      [ -n "$repo" ] || { echo "ci-runner: refusing: GITHUB_REPOSITORY is not set" >&2; return 1; } ;;
    workflow_dispatch)
      ref="${INPUT_REF:-}"
      # It becomes an argument of ci-local.sh and a git revision: no leading dash (an option), no spaces or shell characters.
      case "$ref" in '' | -* | *[!A-Za-z0-9._/-]* | *..* | *//*) echo "ci-runner: refusing: ref '$ref' is not a plain branch, tag or sha" >&2; return 1 ;; esac
      [ "${#ref}" -le 200 ] || { echo "ci-runner: refusing: ref is too long" >&2; return 1; }
      # Optional: a comma list of job names for a quick look at one job (ci-local.sh --jobs). Only the real jobs: a typo would
      # otherwise run as a job that does not exist and leave a red `local-ci/<typo>` status on the commit.
      if [ -n "${INPUT_JOBS:-}" ]; then
        local j
        case "$INPUT_JOBS" in *[!a-z,]* | ,* | *, | *,,*) echo "ci-runner: refusing: jobs '$INPUT_JOBS' is not a comma list of job names" >&2; return 1 ;; esac
        for j in $(printf '%s' "$INPUT_JOBS" | tr ',' ' '); do
          case "$j" in check | mod | browser | image | desktop | mobile) ;;
            *) echo "ci-runner: refusing: '$j' is not a job (check, mod, browser, image, desktop, mobile)" >&2; return 1 ;; esac
        done
      fi ;;
    *) echo "ci-runner: refusing: '${GITHUB_EVENT_NAME:-}' is not an event this runner handles" >&2; return 1 ;;
  esac
}

# ---------- tools ----------
# The pins are the ones ci.yml uses: node from .nvmrc, bun from the `bun-version:` line in ci.yml, pnpm from "packageManager".
ci_pin_node() { tr -d 'v \r\n' < "${1:-$ROOT}/.nvmrc"; }
ci_pin_bun() { sed -n 's/^ *bun-version: *\([0-9][0-9.]*\).*/\1/p' "${1:-$ROOT}/.github/workflows/ci.yml" | head -1; }
ci_pin_pnpm() { sed -n 's/.*"packageManager": *"pnpm@\([0-9][0-9.]*\)[^"]*".*/\1/p' "${1:-$ROOT}/package.json" | head -1; }
ci_have_node() { node --version 2>/dev/null | tr -d 'v \r\n'; }
ci_have_bun() { bun --version 2>/dev/null | tr -d ' \r\n'; }
ci_have_pnpm() { pnpm --version 2>/dev/null | tr -d ' \r\n'; }
ci_node_matches() { # ci_node_matches <pin> <have>: a pin of "24" means any 24.x, as setup-node reads .nvmrc
  [ -n "$1" ] && [ -n "$2" ] && { [ "$1" = "$2" ] || case "$2" in "$1".*) true ;; *) false ;; esac; }
}
ci_tools() { # prints need_<tool>=true|false; a tool that is missing, or at another version, is "needed" (the workflow sets it up)
  local pn pb pp
  pn="$(ci_pin_node "$1")" pb="$(ci_pin_bun "$1")" pp="$(ci_pin_pnpm "$1")"
  [ -n "$pn" ] && [ -n "$pb" ] && [ -n "$pp" ] || { echo "ci-runner: cannot read the tool pins (.nvmrc, ci.yml, package.json)" >&2; return 1; }
  if ci_node_matches "$pn" "$(ci_have_node)"; then echo "need_node=false"; else echo "need_node=true"; fi
  if [ "$pb" = "$(ci_have_bun)" ]; then echo "need_bun=false"; else echo "need_bun=true"; fi
  if [ "$pp" = "$(ci_have_pnpm)" ]; then echo "need_pnpm=false"; else echo "need_pnpm=true"; fi
  echo "pin_node=$pn"; echo "pin_bun=$pb"; echo "pin_pnpm=$pp"
}

# ---------- size ----------
# ci-local.sh's own defaults (3 slots, load 14) were set by hand for a 10-core Mac. A slot needs about 5 cores and 12 GB
# (two runs at once already use the 10 cores of that Mac); the load limit is 1.4 per core, which is 14 there.
ci_size() { # ci_size <cores> <memory in GB>: "slots max_load"
  local cores="$1" gb="$2" by_cpu by_mem slots
  by_cpu=$((cores / 5)) by_mem=$((gb / 12))
  slots=$((by_cpu < by_mem ? by_cpu : by_mem))
  [ "$slots" -ge 1 ] || slots=1
  [ "$slots" -le 6 ] || slots=6
  echo "$slots $((cores * 7 / 5))"
}
ci_cores() { sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null; }
ci_mem_gb() {
  local b k
  if b="$(sysctl -n hw.memsize 2>/dev/null)" && [ -n "$b" ]; then echo $((b / 1073741824))
  elif k="$(sed -n 's/^MemTotal: *\([0-9]*\) kB.*/\1/p' /proc/meminfo 2>/dev/null)" && [ -n "$k" ]; then echo $((k / 1048576))
  else return 1; fi
}
ci_size_env() { # lines for $GITHUB_ENV; a value already set in the environment is the owner's and is not replaced
  local c m s l
  if c="$(ci_cores)" && m="$(ci_mem_gb)" && [ -n "$c" ] && [ -n "$m" ]; then
    read -r s l <<EOF
$(ci_size "$c" "$m")
EOF
    echo "ci-runner: $c cores, $m GB: CI_SLOTS=${CI_SLOTS:-$s} CI_MAX_LOAD=${CI_MAX_LOAD:-$l}" >&2
  else
    s=1 l=0 # can't read the machine: the safest numbers, never a guess upward
    echo "ci-runner: cannot read cores or memory; one slot, no load limit" >&2
  fi
  [ -n "${CI_SLOTS:-}" ] || echo "CI_SLOTS=$s"
  [ -n "${CI_MAX_LOAD:-}" ] || echo "CI_MAX_LOAD=$l"
}

# ---------- cache ----------
# Locks, logs, scratch worktrees and temp dirs must outlive a job and a cancelled one: the runner wipes its _work folder and
# $RUNNER_TEMP, so none of it may be under them. It is the runner user's own cache, the same one the owner's hand runs use.
ci_cache_dir() {
  local c w
  [ -n "${HOME:-}" ] || { echo "ci-runner: HOME is not set; the runner must run as a user with a home" >&2; return 1; }
  c="${TALOS_CI_CACHE:-$HOME/.cache/talos-ci}"
  case "$c" in /?*) ;; *) echo "ci-runner: cache dir '$c' is not an absolute path" >&2; return 1 ;; esac
  for w in "${GITHUB_WORKSPACE:-}" "${RUNNER_WORKSPACE:-}" "${RUNNER_TEMP:-}" "$([ -n "${RUNNER_TEMP:-}" ] && dirname "$RUNNER_TEMP")"; do
    [ -n "$w" ] || continue
    case "$c/" in "$w"/* | "$w/") echo "ci-runner: cache dir '$c' is inside '$w', which the runner wipes" >&2; return 1 ;; esac
  done
  printf '%s\n' "$c"
}

# ---------- run ----------
ci_run() {
  local cache local_ci="${CI_LOCAL_SCRIPT:-$HERE/ci-local.sh}" head args
  ci_guard || return 1
  [ -n "${GH_TOKEN:-}" ] || { echo "ci-runner: GH_TOKEN is not set, so no status could be posted" >&2; return 1; }
  [ -n "${GITHUB_REPOSITORY:-}" ] || { echo "ci-runner: GITHUB_REPOSITORY is not set" >&2; return 1; }
  cache="$(ci_cache_dir)" || return 1
  mkdir -p "$cache/wt" || return 1
  if [ "${GITHUB_EVENT_NAME:-}" = pull_request ]; then
    # A job that sat in the queue (the runner was offline) can be a run for a commit that is no longer the PR's head. The newer
    # push has its own run; this one says so and posts nothing. (Without this, ci-local would test the newer head twice.)
    if head="$(git -C "$ROOT" ls-remote origin "refs/pull/$PR_NUMBER/head" 2>/dev/null | cut -f1)" && [ -n "$head" ] && [ "$head" != "$PR_HEAD_SHA" ]; then
      echo "ci-runner: PR #$PR_NUMBER moved on (${PR_HEAD_SHA:0:7} -> ${head:0:7}) while this run waited for the runner; the newer push has its own run. Nothing tested, nothing posted."
      return 0
    fi
    # A job that waited in the queue (the runner was offline) can come back for a PR that was closed or merged meanwhile. It would
    # post a pending, then a result, over whatever the PR already has. If GitHub can't say, it runs: the head check above passed.
    if [ "$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER" --jq .state 2>/dev/null)" = closed ]; then
      echo "ci-runner: PR #$PR_NUMBER is closed; nothing tested, nothing posted."
      return 0
    fi
    args=(--pr "$PR_NUMBER")
  elif [ "${GITHUB_EVENT_NAME:-}" = push ]; then
    # The sha the push made main, not the branch name: a second push while this one waits or runs must not change what is tested
    # (the workflow's concurrency keeps only the newest waiting run, and that run has its own sha).
    args=(--ref "$GITHUB_SHA")
    # No force flags: ci-local.sh runs the desktop and mobile jobs for any commit already on origin/main (its own merge-base).
    # An exported flag would reach every job and the tests they run.
  else
    # A dispatch is the owner asking by hand: every job runs (--full), whatever the diff says. This is also the full run that keeps
    # a chain of "skipped: no affected files" honest; ci-local.sh skips on a push or a PR only.
    args=(--ref "$INPUT_REF" --full)
    [ -z "${INPUT_JOBS:-}" ] || args+=(--jobs "$INPUT_JOBS")
  fi
  # No sleep while it works. Plugged in, -s stops system sleep, -i idle sleep, -m disk sleep; on battery with the lid shut the Mac
  # sleeps whatever this says, and ci-local.sh then warns on the jobs of that run (ci_slept_since; CI_SLEEP_GUARD=1 fails them).
  if command -v caffeinate >/dev/null 2>&1; then caffeinate -i -m -s -w $$ >/dev/null 2>&1 & fi
  export CI_REPO="$GITHUB_REPOSITORY" CI_STATUS_WHERE="${CI_STATUS_WHERE:-ci-runner}" CI_WT_BASE="$cache/wt" TALOS_CI_CACHE="$cache"
  # exec: this process becomes ci-local.sh. A runner signals only the one process it started for the step, never its children, so
  # the workflow's `run:` must exec this script too (a wrapper shell in between would take the signal and leave ci-local.sh running).
  exec bash "$local_ci" "${args[@]}"
}

# ---------- sweep ----------
ci_sweep() {
  local sha url repo rows ctx state turl n=0
  [ -n "${CI_SHA_FILE:-}" ] && [ -s "$CI_SHA_FILE" ] || { echo "ci-runner: no run got as far as a commit; no status was posted"; return 0; }
  sha="$(head -1 "$CI_SHA_FILE")" url="${CI_STATUS_URL:-}" repo="${GITHUB_REPOSITORY:-}"
  case "$sha" in *[!0-9a-f]* | '') echo "ci-runner: $CI_SHA_FILE does not hold a commit sha; nothing swept" >&2; return 1 ;; esac
  [ -n "$sha" ] && [ -n "$url" ] && [ -n "$repo" ] || { echo "ci-runner: sweep needs the sha, CI_STATUS_URL and GITHUB_REPOSITORY" >&2; return 1; }
  if ! rows="$(gh api --paginate "repos/$repo/commits/$sha/status?per_page=100" --jq '.statuses[] | [.context, .state, .target_url] | @tsv' 2>/dev/null)"; then
    echo "::warning::ci-runner: could not read the statuses of ${sha:0:7}; any still pending from this run are left as they are"
    return 0
  fi
  while IFS=$'\t' read -r ctx state turl; do
    case "$ctx" in local-ci/*) ;; *) continue ;; esac
    # Only a status THIS workflow run posted: the other path (the owner's Mac) and a newer run share these contexts.
    [ "$state" = pending ] && [ "$turl" = "$url" ] || continue
    gh api -X POST "repos/$repo/statuses/$sha" -f state=error -f context="$ctx" \
      -f description="run on ${CI_STATUS_WHERE:-ci-runner} ended before this job reported (cancelled or interrupted); re-run" \
      -f target_url="$url" >/dev/null 2>&1 && n=$((n + 1))
  done <<EOF
$rows
EOF
  echo "ci-runner: closed $n status(es) left pending by this run on ${sha:0:7}"
}

# ---------- verdict ----------
# The six contexts ci-local.sh posts for a full run. A verdict needs every one of them; a missing one is no verdict, so a commit
# that stubs a job or shortens JOBS in ci-local.sh cannot read as green here, whatever it does to its own run.
CI_CONTEXTS="check mod browser image desktop mobile"

# ci_classify: reads "context<TAB>state<TAB>description" lines on stdin (the statuses of one commit, the latest per context) and
# prints "<class><TAB><detail>". Classes, most to least blocking:
#   none         no local-ci/* status at all
#   pending      at least one still pending (the run is not over; failed jobs so far are named)
#   red          nothing pending and at least one job failed, whatever else is missing, skipped or errored
#   partial      some of the six never posted
#   skipped      a "success" whose description is not "passed on ...": a skipped job is no verdict. The one exception is
#                exactly "skipped: no affected files" on a job other than check (ci-affected.sh: nothing the job reads changed
#                since the last green commit); it is not a pass, so it is listed apart, but it does not stop a verdict.
#   interrupted  an error state (cancelled, interrupted or slept through; the run asked for a re-run)
#   green        all six final, each "passed on ..." (or skipped for that one reason)
ci_classify() {
  local ctx state desc c n=0 missing="" pending="" skipped="" errored="" failed="" passed="" unaffected="" seen=" "
  while IFS=$'\t' read -r ctx state desc; do
    case "$ctx" in local-ci/*) ;; *) continue ;; esac
    c="${ctx#local-ci/}"
    case "$seen" in *" $c "*) continue ;; esac # the first one wins: the API lists the newest first
    seen="$seen$c "
    n=$((n + 1))
    case "$state" in
      pending) pending="$pending $c" ;;
      success) case "$desc" in
        "passed on "*) passed="$passed $c" ;;
        "skipped: no affected files") if [ "$c" = check ]; then skipped="$skipped $c"; else unaffected="$unaffected $c"; fi ;;
        *) skipped="$skipped $c" ;;
      esac ;;
      failure) failed="$failed $c" ;;
      *) errored="$errored $c" ;; # error, or a state this script does not know: never a pass
    esac
  done
  for c in $CI_CONTEXTS; do case "$seen" in *" $c "*) ;; *) missing="$missing $c" ;; esac; done
  [ "$n" -gt 0 ] || { printf 'none\tno local-ci status\n'; return 0; }
  # A job that failed is named in every class below: a failure is information even while other jobs are unfinished.
  local f="${failed:+; failed:$failed}"
  [ -z "$pending" ] || { printf 'pending\tstill pending:%s%s\n' "$pending" "$f"; return 0; }
  # Nothing is running any more: one final failure is the verdict, whatever else is missing, skipped or interrupted.
  if [ -n "$failed" ]; then
    local other=""
    [ -z "$missing" ] || other="$other; never reported:$missing"
    [ -z "$skipped" ] || other="$other; skipped:$skipped"
    [ -z "$errored" ] || other="$other; error state:$errored"
    printf 'red\tfailed:%s; passed:%s%s\n' "$failed" "${passed:- none}" "$other"
    return 0
  fi
  [ -z "$missing" ] || { printf 'partial\tnever reported:%s\n' "$missing"; return 0; }
  [ -z "$skipped" ] || { printf 'skipped\tskipped, not passed:%s\n' "$skipped"; return 0; }
  [ -z "$errored" ] || { printf 'interrupted\terror state:%s\n' "$errored"; return 0; }
  printf 'green\tpassed:%s%s\n' "$passed" "${unaffected:+; skipped, no affected files:$unaffected}"
}

# ci_run_note <repo> <sha>: why a commit with no status at all has none, from the workflow runs GitHub lists for it.
ci_run_note() {
  local rows ev st concl n=0 live=0 cancelled=0 other=""
  if ! rows="$(gh api "repos/$1/actions/runs?head_sha=$2&per_page=30" --jq '.workflow_runs[] | select(.path == ".github/workflows/ci-runner.yml") | [.event, .status, .conclusion] | @tsv' 2>/dev/null)"; then
    echo "could not read its workflow runs"; return 0
  fi
  while IFS=$'\t' read -r ev st concl; do
    [ -n "$ev" ] || continue
    n=$((n + 1))
    case "$st" in
      completed) case "$concl" in cancelled) cancelled=1 ;; *) other="$concl" ;; esac ;;
      *) live=1 ;;
    esac
  done <<ROWS
$rows
ROWS
  if [ "$live" = 1 ]; then echo "not tested yet: its run is queued or running"
  elif [ "$cancelled" = 1 ]; then echo "never tested: its run was cancelled (a newer push took its place in the queue, or someone cancelled it)"
  elif [ "$n" -gt 0 ]; then echo "its run ended ($other) before any status was posted"
  else echo "no run found: an inner commit of a multi-commit push (only the tip of a push is tested), or the runner is down or offline, or the workflow did not start"; fi
}

ci_verdict() {
  local repo="${GITHUB_REPOSITORY:-${CI_REPO:-}}" n="${1:-20}" shas sha rows cls detail short line after="" found="" rc=2 pass widened="" tip running
  case "$n" in '' | *[!0-9]* | 0) echo "ci-runner: verdict: '$n' is not a number of commits" >&2; return 2 ;; esac
  [ "$n" -le 100 ] || n=100
  command -v gh >/dev/null 2>&1 || { echo "ci-runner: verdict: gh is not installed" >&2; return 2; }
  [ -n "$repo" ] || repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)" || repo=""
  [ -n "$repo" ] || { echo "ci-runner: verdict: no repository (set GITHUB_REPOSITORY)" >&2; return 2; }
  if ! shas="$(gh api "repos/$repo/commits?sha=main&per_page=$n" --jq '.[].sha' 2>/dev/null)" || [ -z "$shas" ]; then
    echo "ci-runner: verdict: could not list the commits of main in $repo; this is not 'no verdict', GitHub was not read" >&2
    return 2
  fi
  tip="${shas%%$'\n'*}" tip="${tip:0:7}" running=0
  for pass in 1 2; do
  if [ "$pass" = 2 ]; then
    # Nothing in the window: a push of more than N commits leaves the last verdict just past it. Look further, up to 100.
    [ -z "$found" ] && [ "$n" -lt 100 ] || break
    widened=1
    if ! shas="$(gh api "repos/$repo/commits?sha=main&per_page=100" --jq '.[].sha' 2>/dev/null)"; then
      echo "ci-runner: verdict: could not widen the window past $n commits; this is not 'no verdict', GitHub was not read" >&2
      return 2
    fi
    shas="$(printf '%s\n' "$shas" | tail -n +$((n + 1)))"
    [ -n "$shas" ] || break
  fi
  for sha in $shas; do
    short="${sha:0:7}"
    if ! rows="$(gh api --paginate "repos/$repo/commits/$sha/status?per_page=100" --jq '.statuses[] | [.context, .state, .description] | @tsv' 2>/dev/null)"; then
      echo "ci-runner: verdict: could not read the statuses of $short; this is not 'no verdict', GitHub was not read" >&2
      return 2
    fi
    line="$(printf '%s\n' "$rows" | ci_classify)"
    cls="${line%%$'\t'*}" detail="${line#*$'\t'}"
    case "$cls" in
      green | red) found="$short|$cls|$detail" ;;
      none) after="$after  $short  no verdict, no status at all: $(ci_run_note "$repo" "$sha")"$'\n' ;;
      pending) running=$((running + 1)); after="$after  $short  no verdict yet, $detail (running, or the runner died and left them pending)"$'\n' ;;
      partial) after="$after  $short  no verdict, $detail"$'\n' ;;
      skipped) after="$after  $short  no verdict, $detail (a skipped job is never green)"$'\n' ;;
      *) after="$after  $short  no verdict, $detail (cancelled or interrupted; re-run)"$'\n' ;;
    esac
    [ -z "$found" ] || break
  done
  done
  echo "main of $repo, newest $n commits${widened:+ (no verdict in them, so it looked further back, up to 100)}:"
  if [ -n "$found" ]; then
    IFS='|' read -r short cls detail <<ROWS
$found
ROWS
    if [ "$cls" = green ]; then
      case "$detail" in
        *"no affected files"*) echo "last verdict: $short GREEN (no job failed; $detail)" ;;
        *) echo "last verdict: $short GREEN (all six passed; $detail)" ;;
      esac
      rc=0
    else echo "last verdict: $short RED ($detail)"; rc=1; fi
    # The exit code is about the newest commit that has a verdict, which is not always main's tip: say which one it is.
    if [ "$short" = "$tip" ]; then echo "main tip: $tip is the verdict commit; exit $rc speaks for main as it stands"
    else
      echo "main tip: $tip is newer than the verdict commit $short; exit $rc is about $short, not main's tip:" \
        "$(if [ "$running" -gt 0 ]; then echo "$running newer commit$([ "$running" = 1 ] && echo " is" || echo "s are") still running (or the runner died), so main may change"; else echo "none of the newer commits has a pending status"; fi)"
    fi
  else
    echo "last verdict: none in the last $([ -n "$widened" ] && echo "100 (or all there are)" || echo "$n") commits"
  fi
  if [ -n "$after" ]; then echo "newer commits with no verdict (newest first):"; printf '%s' "$after"
  else echo "newer commits with no verdict: none"; fi
  return $rc
}

# Sourced (the tests do this): only the functions above.
if (return 0 2>/dev/null); then return 0; fi

case "${1:-}" in
  guard) ci_guard ;;
  tools) ci_tools "$ROOT" ;;
  size) ci_size_env ;;
  run) ci_run ;;
  sweep) ci_sweep ;;
  verdict) ci_verdict "${2:-}" ;;
  *) sed -n '2,16p' "$0"; exit 64 ;;
esac
