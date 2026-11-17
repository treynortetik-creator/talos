# ci-runner.sh's main-queue part (sourced by it for `run`, `fallback`, `settled`, `superseded` and `dispatch-wait`; moved out so ci-runner.sh
# stays under 1,000 lines): what a main push run and a dispatch do about the other runs of main's one concurrency group.
# shellcheck shell=bash
# ---------- settle: does this push run wait for a quiet head, and did it stand aside? ----------
# docs/CI-MACHINES.md, "A main run waits for a quiet head (settle)". The waiting itself is ci-local.sh's (scripts/ci-local/settle.sh).
# ci_settle_want: should this main push run wait for a quiet head (scripts/ci-local/settle.sh)? Not a part machine's run (CI_RUN_JOBS),
# not the hostile nightly, not a re-run (attempt 2 or later: "Re-run all jobs" on an older commit asks for that commit to be tested),
# not while main is red (the fix for a red main is tested at once). GitHub unreadable: it waits.
ci_settle_want() {
  local out rc
  { [ -z "${CI_RUN_JOBS:-}" ] && [ "${CI_HOSTILE:-}" != 1 ]; } || return 1
  case "${GITHUB_RUN_ATTEMPT:-1}" in '' | *[!0-9]*) ;; *) [ "${GITHUB_RUN_ATTEMPT:-1}" -le 1 ] || { echo "ci-runner: attempt ${GITHUB_RUN_ATTEMPT:-1} of this run is a re-run: no wait for a quiet head"; return 1; } ;; esac
  out="$(ci_verdict 20 2>/dev/null)" && rc=0 || rc=$?
  [ "$rc" != 1 ] || { echo "ci-runner: main is red ($(printf '%s\n' "$out" | sed -n 's/^last verdict: //p')): no wait for a quiet head"; return 1; }
}
# ci_settled: "superseded=true" when ci-local.sh's settle step stood aside for a newer push (it leaves <CI_SHA_FILE>.superseded), else false
ci_settled() { if [ -s "${CI_SHA_FILE:-/nonexistent}.superseded" ]; then echo superseded=true; else echo superseded=false; fi; }

# ---------- superseded: the commits of main this push's run makes CI skip ----------
# GitHub keeps one run waiting in the main concurrency group and cancels the older waiting one, so a busy hour tests some commits
# of main and not others. A push run marks each commit between its own and the last one with any local-ci status (20 at most)
# report-ci/superseded, success with "not tested: superseded by <sha7>; CI tests main's newest commit": the verdict ignores
# report-ci/*, and a skip never looks like "untested and fine". A commit already marked is left alone. Push runs only.
ci_superseded_mark() {
  local repo="${GITHUB_REPOSITORY:-}" sha="${CI_PLAN_SHA:-${GITHUB_SHA:-}}" c rows marked=0
  [ "${GITHUB_EVENT_NAME:-}" = push ] || { echo "ci-runner: superseded: not a push run; nothing to mark"; return 0; }
  [ -n "$repo" ] && [ -n "$sha" ] || { echo "ci-runner: superseded: needs GITHUB_REPOSITORY and the commit"; return 0; }
  for c in $(git rev-list --first-parent -n 21 "$sha" 2>/dev/null | tail -n +2); do
    rows="$(gh api --paginate "repos/$repo/commits/$c/status?per_page=100" --jq '.statuses[] | [.context, .state] | @tsv' </dev/null 2>/dev/null)" ||
      { echo "ci-runner: superseded: the statuses of ${c:0:7} could not be read; stopped"; break; }
    ! printf '%s\n' "$rows" | grep -q '^local-ci/' || break # tested (or being tested): the walk ends here
    ! printf '%s\n' "$rows" | grep -q '^report-ci/superseded' || continue
    gh api -X POST "repos/$repo/statuses/$c" -f state=success -f context=report-ci/superseded \
      -f description="not tested: superseded by ${sha:0:7}; CI tests main's newest commit" </dev/null >/dev/null 2>&1 &&
      marked=$((marked + 1))
  done
  echo "ci-runner: superseded: $marked commit(s) of main marked as not tested"
  return 0
}

# ---------- dispatch-wait: a dispatch never runs beside a newer push run of main that contains its commit ----------
# docs/CI-MACHINES.md, "Lemnos guards". A dispatch for S waits while a push run of a newer main commit containing S has its Lemnos
# job running (not one with no runner yet: this job holds a runner while it waits); a verdict there closes S as superseded
# (report-ci/superseded, "not tested:"), unless run_anyway. GitHub unreadable, or CI_DISPATCH_MAX_WAIT (7200 s) gone: it runs.
ci_contains() { git -C "$ROOT" merge-base --is-ancestor "$2" "$1" 2>/dev/null; } # ci_contains <newer> <sha>: is sha in newer's history
ci_dispatch_wait() {
  local repo="${GITHUB_REPOSITORY:-}" out="${GITHUB_OUTPUT:-/dev/null}" sha rows id h st waited="" going verdict="" cls deadline poll
  local anyway="$(lower "${INPUT_RUN_ANYWAY:-false}")"
  if [ "${GITHUB_EVENT_NAME:-}" != workflow_dispatch ] || [ "${CI_HOSTILE:-}" = 1 ]; then
    echo "ci-runner: dispatch-wait: not a dispatch (or a hostile one, which is never superseded); nothing to wait for"
    echo "superseded=false" >>"$out"
    return 0
  fi
  sha="${CI_PLAN_SHA:-}"
  [ -n "$sha" ] || sha="$(git -C "$ROOT" rev-parse --verify -q "${INPUT_REF:-}^{commit}" 2>/dev/null ||
    git -C "$ROOT" rev-parse --verify -q "origin/${INPUT_REF:-}^{commit}" 2>/dev/null)"
  if [ -z "$sha" ] || [ -z "$repo" ]; then
    echo "ci-runner: dispatch-wait: no commit or repository to look for; the dispatch runs"
    echo "superseded=false" >>"$out"
    return 0
  fi
  poll="${CI_DISPATCH_POLL:-60}" deadline="${CI_DISPATCH_MAX_WAIT:-7200}"
  printf '%s' "$poll" | grep -Eq '^[0-9]+(\.[0-9]+)?$' || poll=60
  case "$deadline" in '' | *[!0-9]*) deadline=7200 ;; esac
  deadline=$(($(date +%s) + 10#$deadline))
  while :; do
    if ! rows="$(gh api "repos/$repo/actions/workflows/ci-runner.yml/runs?event=push&branch=main&per_page=30" \
      --jq '.workflow_runs[] | select(.status != "completed") | [.id, .head_sha] | @tsv' </dev/null 2>/dev/null)"; then
      echo "ci-runner: dispatch-wait: could not list the push runs of main; the dispatch runs"
      break
    fi
    going=""
    while IFS=$'\t' read -r id h; do
      [ -n "$id" ] && [ -n "$h" ] && [ "$h" != "$sha" ] || continue
      # a commit newer than this checkout is fetched, quietly; one that still cannot be read is not waited on
      git -C "$ROOT" cat-file -e "$h^{commit}" 2>/dev/null || ci_git_net "$ROOT" fetch -q origin main >/dev/null 2>&1 || true
      ci_contains "$h" "$sha" || continue
      st="$(gh api "repos/$repo/actions/runs/$id/jobs?per_page=100" --jq '.jobs[] | select(.name == "local-ci on ci-runner") | .status' </dev/null 2>/dev/null | head -1)"
      if [ "$st" != in_progress ]; then
        echo "ci-runner: dispatch-wait: the push run of ${h:0:7} contains ${sha:0:7}, but its Lemnos job is not running (${st:-unknown}; not started on a runner yet, or done): not waiting on it"
        continue
      fi
      going="$going $h"
      case " $waited " in *" $h "*) ;; *) waited="$waited $h"
        echo "ci-runner: dispatch-wait: waiting behind the push run of ${h:0:7} (it contains ${sha:0:7}): a dispatch never runs beside it" ;; esac
    done <<ROWS
$rows
ROWS
    [ -n "$going" ] || break
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "ci-runner: dispatch-wait: waited the most it may (CI_DISPATCH_MAX_WAIT ${CI_DISPATCH_MAX_WAIT:-7200} s); the dispatch runs"
      echo "superseded=false" >>"$out"
      return 0
    fi
    sleep "$poll"
  done
  for h in $waited; do
    rows="$(gh api --paginate "repos/$repo/commits/$h/status?per_page=100" --jq '.statuses[] | [.context, .state, .description] | @tsv' </dev/null 2>/dev/null)" || continue
    cls="$(printf '%s\n' "$rows" | ci_classify)"
    case "${cls%%$'\t'*}" in green | red) verdict="$h ${cls%%$'\t'*}" ;; esac
  done
  if [ -z "$verdict" ]; then
    [ -z "$waited" ] || echo "ci-runner: dispatch-wait: the run it waited behind gave no verdict; the dispatch runs"
    echo "superseded=false" >>"$out"
    return 0
  fi
  h="${verdict%% *}"
  case "$anyway" in true | 1 | yes | on)
    echo "ci-runner: dispatch-wait: ${h:0:7} has a verdict (${verdict#* }), but this dispatch asked for run_anyway: it runs"
    echo "superseded=false" >>"$out"; return 0 ;;
  esac
  # unmarked, a skip would look like "untested and fine": when the mark cannot be posted, the dispatch runs instead
  if ! gh api -X POST "repos/$repo/statuses/$sha" -f state=success -f context=report-ci/superseded \
    -f description="not tested: superseded by ${h:0:7}, whose push run gave main a verdict; dispatch with run_anyway to test it" </dev/null >/dev/null 2>&1; then
    echo "ci-runner: dispatch-wait: ${h:0:7} gave a verdict, but ${sha:0:7} could not be marked superseded on GitHub; the dispatch runs"
    echo "superseded=false" >>"$out"
    return 0
  fi
  echo "ci-runner: dispatch-wait: ${h:0:7} contains ${sha:0:7} and its run gave main a verdict (${verdict#* }): this dispatch is closed as superseded, not tested"
  echo "superseded=true" >>"$out"
  return 0
}

