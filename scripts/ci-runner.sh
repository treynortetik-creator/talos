#!/usr/bin/env bash
# The glue between .github/workflows/ci-runner.yml and scripts/ci-local.sh, on the self-hosted runner (label talos-ci).
# Logic lives here, not in the workflow, so scripts/ci-runner.test.ts can run it. docs/CI-LOCAL.md, "On the self-hosted runner".
#
#   ci-runner.sh guard   refuse anything that is not a same-repo PR, a push to main or a dispatch of a plain ref (exit 1, says why)
#   ci-runner.sh tools   which pinned tools the runner already has at the pinned version (lines for $GITHUB_OUTPUT)
#   ci-runner.sh size    CI_SLOTS and CI_MAX_LOAD for this machine, from its cores and memory now (lines for $GITHUB_ENV)
#   ci-runner.sh run     guard, then scripts/ci-local.sh --pr N (or --ref REF; --ref <the pushed sha> for a push, plus --full nightly) with the runner's settings
#   ci-runner.sh plan    the split over machines (docs/CI-MACHINES.md): the commit, fixed once, and each machine's jobs from the
#                        repository's switches CI_DELPHI, CI_CYCLOPS (on, shadow), CI_HESTIA (on) (lines for $GITHUB_OUTPUT)
#   ci-runner.sh fallback  after Lemnos's own run: the gating jobs handed to another machine (CI_FALLBACK, "<machine>:<job,...>")
#                        that this attempt has no final answer for, taken here in one ci-local.sh call
#   ci-runner.sh preflight  on the owner's Mac (CI_OWNER_MACHINE=1): exit 1, with the reason, unless the wall around the live Talos
#                        is there (the same check as ci-local.sh's)
#   ci-runner.sh dispatch-wait  a dispatch, before its run: waits behind a newer push run of main containing it; superseded when
#                        that run gave a verdict, unless run_anyway (superseded=true|false for $GITHUB_OUTPUT)
#   ci-runner.sh sweep   after the run, even a cancelled one: close any status of THIS workflow run that is still pending
#   ci-runner.sh logs    every run: its per-test files into CI_TESTS_OUT; a red or not-tested run's own logs too, into CI_LOGS_OUT
#   ci-runner.sh verdict [N]   the last verdict on main: the newest of the last N commits (default 20, at most 100) with all six
#                        local-ci/* statuses final, whether each passed, and the newer commits that have none, and why.
#                        Exit 0 green, 1 red, 2 no verdict in the window or GitHub could not be read. Needs gh, and
#                        GITHUB_REPOSITORY (or CI_REPO), else `gh repo view`.
#   ci-runner.sh green   a push run of main only: when its commit reads green (all six), fast-forward refs/heads/green to it;
#                        never backwards, never forced; a green that is not its ancestor is refused (scripts/ci-runner/green.sh)
#
# Input is environment only (the workflow passes the event's fields as env, never spliced into a command line):
#   GITHUB_EVENT_NAME, GITHUB_REPOSITORY, GITHUB_REF and GITHUB_SHA (push, schedule), PR_NUMBER, PR_HEAD_SHA, PR_HEAD_REPO, PR_DRAFT, INPUT_REF, INPUT_JOBS (dispatch only), GH_TOKEN, CI_STATUS_URL, CI_SHA_FILE, CI_LOGS_OUT
#   and for the split: CI_PLAN_SHA (plan's commit), CI_RUN_JOBS (a part or report-only machine's jobs), CI_REMOTE_PARTS (Lemnos),
#   CI_ATTEMPT_URL, GITHUB_RUN_ID, CI_FALLBACK, CI_REMOTE_DEADLINE (900 s), CI_RUN_STARTED, CI_DELPHI, CI_CYCLOPS, CI_HESTIA,
#   and for Titan: CI_TITAN_IMAGE, CI_TITAN_BROWSER and CI_BROWSER_E2E_WAIT (plan), CI_RUN_PREFIX, CI_REMOTE_JOBS, CI_PART_E2E_WORKERS
#   (its browser-e2e part), CI_BROWSER_E2E_PART, CI_BROWSER_E2E_WAIT and CI_BROWSER_E2E_SHADOW (Lemnos's own run only)
#   ci-runner.sh e2e-shadow  CI_TITAN_BROWSER=e2e-shadow: Titan's part beside Lemnos's own non-web e2e result, one row of
#                        e2e-shadow.tsv (scripts/ci-runner/e2e-shadow.sh)
#   ci-runner.sh check-shadow  CI_TITAN_CHECK=shadow: Titan's check-titan beside Lemnos's check, test by test, one row of
#                        check-shadow.tsv (scripts/ci-runner/check-shadow.sh). check on Titan: CI_TITAN_CHECK, CI_CHECK_WAIT (plan),
#                        CI_CHECK_PART and CI_CHECK_WAIT (Lemnos's own run only)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# The nightly (a schedule run) posts under nightly-ci/ only, never over a commit's local-ci/* or report-ci/* (a push run's verdict
# is final); exported for ci-local.sh. ci_ns <context> is locks.sh's (scripts/ci-runner.test.ts checks that the two agree).
# The hostile nightly (CI_HOSTILE=1, from the workflow: its own schedule or a dispatch with hostile) posts under hostile-ci/.
# A dispatch with nightly=nightly|hostile (CI_DISPATCH_NIGHTLY, from the workflow) is that nightly by hand, on the same path as its
# schedule: from here on it is a schedule event (the skips, main-only guard, --full, nightly-ci/ or hostile-ci/, the alert). It is
# remembered in CI_DISPATCH_NIGHTLY, which scripts/ci-runner/schedule.sh reads to keep a day's schedule of that kind from running twice.
case "${GITHUB_EVENT_NAME:-}:${CI_DISPATCH_NIGHTLY:-}" in
  workflow_dispatch:nightly) GITHUB_EVENT_NAME=schedule ;;
  workflow_dispatch:hostile) GITHUB_EVENT_NAME=schedule CI_HOSTILE=1; export CI_HOSTILE ;;
  *) unset CI_DISPATCH_NIGHTLY ;;
esac
[ "${GITHUB_EVENT_NAME:-}" != schedule ] || export CI_NIGHTLY=1
ci_ns() { local ns=nightly-ci; if [ "${CI_HOSTILE:-}" = 1 ]; then ns=hostile-ci; elif [ "${CI_NIGHTLY:-}" != 1 ]; then printf '%s\n' "$1"; return 0; fi
  case "$1" in local-ci/*) printf '%s/%s\n' "$ns" "${1#local-ci/}" ;; ci-part/*) printf '%s/part-%s\n' "$ns" "${1#ci-part/}" ;;
    report-ci/*) printf '%s/report-%s\n' "$ns" "${1#report-ci/}" ;; *) printf '%s\n' "$1" ;; esac; }

# git never waits for a person: no terminal prompt, no credential manager window, no ssh passphrase question (Titan's runner
# hung 4 h 23 m in a fetch that asked for a credential nobody was there to give). Exported, so ci-local.sh and every git get it.
export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never
# ssh in batch mode, unless the owner chose an ssh command of their own (GIT_SSH_COMMAND, GIT_SSH, core.sshCommand)
[ -n "${GIT_SSH_COMMAND:-}${GIT_SSH:-}" ] || [ -n "$(git config --get core.sshCommand 2>/dev/null)" ] ||
  export GIT_SSH_COMMAND="ssh -o BatchMode=yes"
# ci_git_net <dir> <git args...>: a git call that talks to origin (fetch, ls-remote), with stdin from /dev/null and stopped after
# CI_GIT_LIMIT (300 s); its output is the call's. When it fails it says which remote and the likely reason, with git's own last
# line, and prints the link without any user or token in it.
ci_git_net() {
  local dir="$1" rc url err last gd locks="" lim="${CI_GIT_LIMIT:-300}"
  case "$lim" in '' | *[!0-9]* | 0) lim=300 ;; esac
  shift
  err="$(mktemp)" || err=/dev/null
  # A perl in front of git: git in a process group of its own, made from both sides (no moment where a stop misses it), and
  # at CI_GIT_LIMIT the whole group (git and its helpers: git-remote-https, a credential helper, ssh) gets TERM, on which git
  # removes its .lock files, then after 5 s KILL. Only that group, which this call made; never by name. The perl is in front,
  # not in the background: it holds the limit even if this shell is killed, and a TERM, INT or HUP it gets is passed on.
  [ "$err" = /dev/null ] || : > "$err.start" # when the call began: a lock file newer than this is the call's (git writes $err)
  perl -MPOSIX=WNOHANG -e '
    my $lim = shift;
    my $pid = fork() // die "fork: $!\n";
    if (!$pid) { setpgrp(0, 0); exec @ARGV or die "exec: $!\n" }
    setpgrp($pid, $pid);
    my ($timed, $reaped, $st) = (0, 0, 0);
    my $stop = sub {
      kill "TERM", -$pid;
      for (1 .. 50) {
        if (!$reaped && waitpid($pid, WNOHANG) == $pid) { $reaped = 1; $st = $? }
        last unless kill 0, -$pid;
        select(undef, undef, undef, 0.1);
      }
      kill "KILL", -$pid;
    };
    $SIG{ALRM} = sub { $timed = 1; $stop->() };
    $SIG{$_} = sub { $stop->(); exit 143 } for qw(TERM INT HUP);
    alarm $lim;
    until ($reaped) {
      my $r = waitpid($pid, 0);
      if ($r == $pid) { $reaped = 1; $st = $? } elsif ($r == -1 && $!{ECHILD}) { last }
    }
    alarm 0;
    exit 142 if $timed;
    exit($st & 127 ? 128 + ($st & 127) : $st >> 8);
  ' "$lim" git -C "$dir" "$@" < /dev/null 2> "$err"
  rc=$?
  if [ "$rc" = 142 ] && [ "$err" != /dev/null ]; then
    # a lock file the call left (made after it began): named, not removed, since another git may own it. Both git dirs: in a
    # linked worktree shallow.lock, packed-refs.lock and the ref locks are in the common one.
    for gd in "$(git -C "$dir" rev-parse --absolute-git-dir 2>/dev/null)" "$(cd "$dir" && cd "$(git rev-parse --git-common-dir)" && pwd -P 2>/dev/null)"; do
      [ -n "$gd" ] && [ -d "$gd" ] || continue
      locks="$locks$(find "$gd" -path "$gd/objects" -prune -o -name '*.lock' -newer "$err.start" -print 2>/dev/null)"$'\n'
    done
    locks="$(printf '%s' "$locks" | sed '/^$/d' | sort -u | tr '\n' ' ')"
  fi
  last="$(tail -1 "$err" 2>/dev/null)"
  [ "$err" = /dev/null ] || rm -f "$err" "$err.start"
  [ "$rc" != 0 ] || return 0
  url="$(git -C "$dir" config --get remote.origin.url 2>/dev/null | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/]*@#\1#')"
  if [ "$rc" = 142 ]; then
    echo "ci-runner: git $1 of ${url:-origin} stopped after ${lim}s with no answer: no credential? (git may not ask for one here)${locks:+; it left ${locks% } (not removed: another git may own it)}" >&2
  else
    echo "ci-runner: git $1 of ${url:-origin} failed (exit $rc): no credential? (git may not ask for one here)${last:+; git said: $last}" >&2
  fi
  return "$rc"
}

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
      fi
      # the workflow's `if` skips a draft; this holds for a job copied without that `if`
      [ "${PR_DRAFT:-false}" != true ] || { echo "ci-runner: refusing: PR #$PR_NUMBER is a draft" >&2; return 1; } ;;
    push | schedule)
      # The nightly schedule is GitHub's run of main's tip, so it passes the same checks as a push to main.
      # Only main, and only as a full commit sha: the run tests that exact commit, never "whatever main is by then". The
      # workflow's `branches: [main]` filter says the same; this holds if that filter is ever edited away.
      [ "${GITHUB_REF:-}" = refs/heads/main ] || { echo "ci-runner: refusing: a ${GITHUB_EVENT_NAME} to '${GITHUB_REF:-}', only refs/heads/main is tested on push or schedule" >&2; return 1; }
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
  # A part or report-only machine's jobs (from plan): only those jobs, and of one kind, since one run posts under one prefix.
  if [ -n "${CI_RUN_JOBS:-}" ]; then
    case "$CI_RUN_JOBS" in
      bridge-shard-1 | bridge-shard-2 | vitest | bridge-shard-1,vitest | vitest,bridge-shard-1 | bridge-shard-1,bridge-shard-2 | \
        bridge-shard-2,bridge-shard-1 | bridge-shard-2,vitest | vitest,bridge-shard-2 | bridge-shard-1,bridge-shard-2,vitest | linux | image | browser-e2e | check) ;;
      *) echo "ci-runner: refusing: CI_RUN_JOBS '$CI_RUN_JOBS' is not a list of check's parts, or one of linux, image, browser-e2e, check (Titan)" >&2; return 1 ;;
    esac
  fi
}

# ci_split_checks <run|fallback>: the inputs of the split (docs/CI-MACHINES.md), checked before anything is read or run. A part
# machine and fallback need the planned commit; the planned commit must be the event's own (a PR's head, the pushed commit); the
# attempt link ends in "#" (else attempts/1 would also match attempts/10); the fallback's numbers are numbers.
ci_split_checks() {
  local sha
  if [ -n "${CI_PLAN_SHA:-}" ]; then
    case "$CI_PLAN_SHA" in *[!0-9a-f]* | '') echo "ci-runner: refusing: the planned commit '$CI_PLAN_SHA' is not a sha" >&2; return 1 ;; esac
    [ "${#CI_PLAN_SHA}" = 40 ] || { echo "ci-runner: refusing: the planned commit '$CI_PLAN_SHA' is not a full sha" >&2; return 1; }
    case "${GITHUB_EVENT_NAME:-}" in pull_request) sha="${PR_HEAD_SHA:-}" ;; push | schedule) sha="${GITHUB_SHA:-}" ;; *) sha="$CI_PLAN_SHA" ;; esac
    [ "$sha" = "$CI_PLAN_SHA" ] || { echo "ci-runner: refusing: the planned commit ${CI_PLAN_SHA:0:7} is not the pushed commit or PR head (${sha:0:7})" >&2; return 1; }
  elif [ -n "${CI_RUN_JOBS:-}" ] || [ "$1" = fallback ]; then
    echo "ci-runner: refusing: a part machine and fallback test only the planned commit (CI_PLAN_SHA)" >&2; return 1
  fi
  case "${CI_ATTEMPT_URL:-}" in '' | *'#') ;; *) echo "ci-runner: refusing: CI_ATTEMPT_URL must end in #" >&2; return 1 ;; esac
  # the jobs another machine runs (phase B: image on Titan), which Lemnos leaves out; only with a planned commit
  case "${CI_REMOTE_JOBS:-}" in '' | image) ;; *) echo "ci-runner: refusing: CI_REMOTE_JOBS '$CI_REMOTE_JOBS' is not image" >&2; return 1 ;; esac
  [ -z "${CI_REMOTE_JOBS:-}" ] || [ -n "${CI_PLAN_SHA:-}" ] || { echo "ci-runner: refusing: CI_REMOTE_JOBS needs the planned commit (CI_PLAN_SHA)" >&2; return 1; }
  case "${CI_REMOTE_DEADLINE:-900}" in '' | *[!0-9]*) echo "ci-runner: refusing: CI_REMOTE_DEADLINE is whole seconds" >&2; return 1 ;; esac
  case "${CI_FALLBACK_POLL:-30}" in '' | *[!0-9]* | 0*) echo "ci-runner: refusing: CI_FALLBACK_POLL is whole seconds, at least 1" >&2; return 1 ;; esac
}

# ---------- plan ----------
# The split over machines (docs/CI-MACHINES.md): one commit for every machine of this run, and which machine runs what. Lemnos
# keeps planning its own skips (ci-local.sh), so with every switch off the run is today's. A switch on sends work elsewhere and
# Lemnos folds it in (remote_parts); shadow runs it there as well, only recorded (ci-part/*), and Lemnos runs it too.
# ci_known_tools <list>: the tools test-parallel.ts knows (only tmux), comma-joined, from a list split on commas and spaces
ci_known_tools() { printf '%s\n' "$1" | tr ', ' '\n\n' | grep -x tmux | sort -u | paste -sd, -; }
ci_plan() {
  local marker sha parts="" delphi="" cyclops="" hestia="" check=1 titan="" titan_prefix="" remote_jobs="" fallback="" browser_e2e="" e2e_wait="" shard_tools="" t1 t2
  ci_guard || return 1
  case "${GITHUB_EVENT_NAME:-}" in
    pull_request) sha="$PR_HEAD_SHA" ;;
    push | schedule) sha="$GITHUB_SHA" ;;
    *)
      ci_git_net "$ROOT" fetch -q origin || true
      # a branch of origin first: a tag (or a local branch) of the same name must not take its place
      sha="$(git -C "$ROOT" rev-parse --verify -q "refs/remotes/origin/$INPUT_REF^{commit}" || git -C "$ROOT" rev-parse --verify -q "$INPUT_REF^{commit}")" ||
        { echo "ci-runner: plan: '$INPUT_REF' is no commit of this repository" >&2; return 1; }
      [ -z "${INPUT_JOBS:-}" ] || case ",$INPUT_JOBS," in *,check,*) ;; *) check=0 ;; esac ;;
  esac
  if [ "$check" = 1 ]; then
    case "${CI_DELPHI:-}" in on | shadow) delphi=bridge-shard-1,vitest ;; esac
    [ "${CI_DELPHI:-}" != on ] || parts="bridge-shard-1:delphi vitest:delphi"
    case "${CI_CYCLOPS:-}" in on | shadow) cyclops=bridge-shard-2 ;; esac
    [ "${CI_CYCLOPS:-}" != on ] || parts="${parts:+$parts }bridge-shard-2:cyclops"
  fi
  [ "${CI_HESTIA:-}" != on ] || hestia=linux
  # The tools of the machine that runs each bridge shard (docs/CI-MACHINES.md, "Tools a test file needs"), so every machine
  # deals the same piles and a file that needs tmux goes to one that has it: Lemnos has tmux; Delphi and Cyclops have what the
  # repository variables CI_TOOLS_DELPHI and CI_TOOLS_CYCLOPS say (unset or empty: nothing), known tools only. Only when a
  # shard goes to another machine (on or shadow); with every switch off Lemnos runs every rest file itself, unsharded.
  # A pile Lemnos gates takes Lemnos's tools: with any shard on, a shard that is not on (off, or shadow) is Lemnos's to run.
  # With every shard in shadow, each pile takes its machine's tools: the shadow runs then show what `on` would do.
  if [ -n "$delphi$cyclops" ]; then
    t1=tmux t2=tmux
    local mode=shadow
    case "${CI_DELPHI:-}:${CI_CYCLOPS:-}" in on:* | *:on) mode=on ;; esac
    case "${CI_DELPHI:-}" in on) t1="$(ci_known_tools "${CI_TOOLS_DELPHI:-}")" ;; shadow) [ "$mode" = on ] || t1="$(ci_known_tools "${CI_TOOLS_DELPHI:-}")" ;; esac
    case "${CI_CYCLOPS:-}" in on) t2="$(ci_known_tools "${CI_TOOLS_CYCLOPS:-}")" ;; shadow) [ "$mode" = on ] || t2="$(ci_known_tools "${CI_TOOLS_CYCLOPS:-}")" ;; esac
    shard_tools="$t1|$t2"
  fi
  # Titan (phase B): image. on: local-ci/image on Titan, left out on Lemnos (remote_jobs), taken over if Titan does not answer
  # (fallback); shadow: report-ci/image only. A dispatch: only the jobs its list has (or all).
  ci_wants() { [ "${GITHUB_EVENT_NAME:-}" != workflow_dispatch ] || [ -z "${INPUT_JOBS:-}" ] || case ",$INPUT_JOBS," in *",$1,"*) true ;; *) false ;; esac; }
  case "${CI_TITAN_IMAGE:-}" in on | shadow) ! ci_wants image || { titan=image titan_prefix=report-ci; [ "$CI_TITAN_IMAGE" != on ] || titan_prefix=local-ci remote_jobs=image; } ;; esac
  [ -z "$remote_jobs" ] || fallback="titan:$remote_jobs"
  # Titan's browser-e2e part (phase C revised, docs/CI-MACHINES.md, "The e2e packages on Titan"): browser_e2e is its prefix.
  # e2e-shadow: report-ci, and Lemnos's browser runs everything (compared after, ci-runner.sh e2e-shadow); e2e: ci-part, folded
  # into Lemnos's browser, only with a positive CI_BROWSER_E2E_WAIT (e2e_wait). Never in remote_jobs or the fallback: if Titan
  # does not answer, ci-local.sh's fold takes the packages back itself, so the fallback must not run browser a second time.
  local w="${CI_BROWSER_E2E_WAIT:-}"
  case "${CI_TITAN_BROWSER:-}" in '' | off) ;;
    e2e-shadow) ! ci_wants browser || browser_e2e=report-ci ;;
    e2e)
      if [ -z "$w" ]; then echo "CI_TITAN_BROWSER=e2e but CI_BROWSER_E2E_WAIT is not set; browser runs everything on Lemnos" >&2
      elif case "$w" in *[!0-9]*) true ;; *) [ "${#w}" -gt 6 ] || [ $((10#$w)) = 0 ] ;; esac; then
        echo "CI_TITAN_BROWSER=e2e but CI_BROWSER_E2E_WAIT '$w' is not a positive number of seconds; browser runs everything on Lemnos" >&2
      elif ci_wants browser; then browser_e2e=ci-part e2e_wait=$((10#$w)); fi ;;
    *) echo "::warning::plan: CI_TITAN_BROWSER '$CI_TITAN_BROWSER' is not off, e2e-shadow or e2e; taken as off (browser runs everything on Lemnos)" >&2 ;;
  esac
  # check on Titan (docs/CI-MACHINES.md, "check on Titan"): check_titan is the check-titan part's prefix. shadow: report-ci, and
  # Lemnos runs its whole check (compared after, ci-runner.sh check-shadow); on: ci-part, folded into Lemnos's check, only with a
  # positive CI_CHECK_WAIT (check_wait). Never in remote_jobs or the fallback: ci-local.sh's fold takes check back itself.
  local cw="${CI_CHECK_WAIT:-}" check_titan="" check_wait=""
  case "${CI_TITAN_CHECK:-}" in '' | off) ;;
    shadow) ! ci_wants check || check_titan=report-ci ;;
    on)
      if [ -z "$cw" ]; then echo "CI_TITAN_CHECK=on but CI_CHECK_WAIT is not set; check runs on Lemnos" >&2
      elif case "$cw" in *[!0-9]*) true ;; *) [ "${#cw}" -gt 6 ] || [ $((10#$cw)) = 0 ] ;; esac; then
        echo "CI_TITAN_CHECK=on but CI_CHECK_WAIT '$cw' is not a positive number of seconds; check runs on Lemnos" >&2
      elif ci_wants check; then check_titan=ci-part check_wait=$((10#$cw)); fi ;;
    *) echo "::warning::plan: CI_TITAN_CHECK '$CI_TITAN_CHECK' is not off, shadow or on; taken as off (check runs on Lemnos)" >&2 ;;
  esac
  # on: the newest check-shadow row's runs_nowhere_in_on (skipped on Titan, outside the macOS-only list: nothing runs them now).
  # A line for the lead, never a block.
  local cs rn
  if [ "$check_titan" = ci-part ] && cs="$(ci_cache_dir 2>/dev/null)/logs/check-shadow.tsv" && [ -f "$cs" ]; then
    rn="$(awk -F'\t' 'NR == 1 { for (i = 1; i <= NF; i++) { if ($i == "runs_nowhere_in_on") c = i; if ($i == "detail") d = i }; next }
      { v = c ? $c : ""; w = d ? $d : "" } END { print v "\t" w }' "$cs")"
    case "${rn%%$'\t'*}" in '' | 0 | *[!0-9]*) ;; *) echo "::warning::plan: CI_TITAN_CHECK=on, but the newest check shadow has ${rn%%$'\t'*} test(s) skipped on Titan outside the macOS-only list: they run nowhere now (${rn#*$'\t'})" >&2 ;; esac
  fi
  # Titan has the whole check: Delphi's and Cyclops's parts (on or shadow) would be for a check Lemnos no longer runs
  if [ "$check_titan" = ci-part ] && [ -n "$delphi$cyclops" ]; then
    echo "::warning::plan: CI_TITAN_CHECK=on, so check's parts on Delphi and Cyclops do not run; a take-back runs them on Lemnos" >&2
    parts="" delphi="" cyclops="" shard_tools=""
  fi
  # the hostile nightly runs everything on Lemnos, where its conditions are made: no part goes to another machine
  [ "${CI_HOSTILE:-}" != 1 ] || parts="" delphi="" cyclops="" hestia="" titan="" titan_prefix="" remote_jobs="" fallback="" browser_e2e="" e2e_wait="" shard_tools="" check_titan="" check_wait=""
  # a schedule on a local day a dispatched nightly of its kind already started does nothing (ci_schedule_skip, scripts/ci-runner/schedule.sh):
  # the other machines' runners cannot see this machine's marker, so nothing is handed to them and their jobs do not run
  if [ "${GITHUB_EVENT_NAME:-}" = schedule ] && [ -z "${CI_DISPATCH_NIGHTLY:-}" ] && . "$HERE/ci-runner/schedule.sh" &&
    marker="$(ci_dispatch_marker "$([ "${CI_HOSTILE:-}" = 1 ] && echo hostile || echo nightly)")" && [ -e "$marker" ]; then
    parts="" delphi="" cyclops="" hestia="" titan="" titan_prefix="" remote_jobs="" fallback="" browser_e2e="" e2e_wait="" shard_tools="" check_titan="" check_wait=""
  fi
  printf 'sha=%s\nremote_parts=%s\ndelphi=%s\ncyclops=%s\nhestia=%s\ntitan=%s\ntitan_prefix=%s\nremote_jobs=%s\nfallback=%s\nbrowser_e2e=%s\ne2e_wait=%s\nshard_tools=%s\ncheck_titan=%s\ncheck_wait=%s\n' \
    "$sha" "$parts" "$delphi" "$cyclops" "$hestia" "$titan" "$titan_prefix" "$remote_jobs" "$fallback" "$browser_e2e" "$e2e_wait" "$shard_tools" "$check_titan" "$check_wait"
}

# The answer this workflow attempt already has for a context: the state of its oldest final status (a failure wins), or nothing.
# Read from the commit's full status list (the combined status keeps only the newest per context). Exit 1 when unreadable.
# Another machine's `error` (a link that is not this job's CI_STATUS_URL) is no answer: a machine stopped mid-job closes its
# pending as error, and the job is taken over so a verdict still lands. A failure is an answer; this job's own error too. A
# cancelled machine's "not tested:" error is no answer either, whoever posted it.
ci_attempt_final() { # ci_attempt_final <repo> <sha> <context> <attempt>
  local all
  all="$(gh api --paginate "repos/$1/commits/$2/statuses?per_page=100" \
    --jq '.[] | [.context, .state, (.target_url // ""), (.description // "")] | @tsv' 2>/dev/null)" || return 1
  printf '%s\n' "$all" | awk -F'\t' -v c="$3" -v a="$4" -v own="${CI_STATUS_URL:-}" \
    '$1 == c && index($3, a) == 1 && $2 != "pending" && !($2 == "error" && $3 != own) && index($4, "not tested:") != 1 { s = (s == "failure" ? s : $2) } END { print s }'
}
ci_attempt_errored() { # ci_attempt_errored <repo> <sha> <context> <link>: 0 if that context has an error under exactly this link
  gh api --paginate "repos/$1/commits/$2/statuses?per_page=100" --jq '.[] | [.context, .state, (.target_url // "")] | @tsv' \
    2>/dev/null | awk -F'\t' -v c="$3" -v l="$4" '$1 == c && $2 == "error" && $3 == l { f = 1 } END { exit !f }'
}

# ---------- tools ----------
# The pins are the ones ci.yml uses: node from .nvmrc, bun from the `bun-version:` line in ci.yml, pnpm from "packageManager".
ci_pin_node() { tr -d 'v \r\n' < "${1:-$ROOT}/.nvmrc"; }
ci_pin_bun() { sed -n 's/^ *bun-version: *\([0-9][0-9.]*\).*/\1/p' "${1:-$ROOT}/.github/workflows/ci.yml" | head -1; }
ci_pin_pnpm() { sed -n 's/.*"packageManager": *"pnpm@\([0-9][0-9.]*\)[^"]*".*/\1/p' "${1:-$ROOT}/package.json" | head -1; }
ci_have_node() { node --version 2>/dev/null | tr -d 'v \r\n'; }
ci_have_bun() { bun --version 2>/dev/null | tr -d ' \r\n'; }
ci_bun_at() { "$1" --version 2>/dev/null | tr -d ' \r\n'; }
ci_have_pnpm() { pnpm --version 2>/dev/null | tr -d ' \r\n'; }
ci_node_matches() { # ci_node_matches <pin> <have>: a pin of "24" means any 24.x, as setup-node reads .nvmrc
  [ -n "$1" ] && [ -n "$2" ] && { [ "$1" = "$2" ] || case "$2" in "$1".*) true ;; *) false ;; esac; }
}
ci_tools() { # prints need_<tool>=true|false; a tool that is missing, or at another version, is "needed" (the workflow sets it up)
  local pn pb pp c
  pn="$(ci_pin_node "$1")" pb="$(ci_pin_bun "$1")" pp="$(ci_pin_pnpm "$1")"
  [ -n "$pn" ] && [ -n "$pb" ] && [ -n "$pp" ] || { echo "ci-runner: cannot read the tool pins (.nvmrc, ci.yml, package.json)" >&2; return 1; }
  if ci_node_matches "$pn" "$(ci_have_node)"; then echo "need_node=false"; else echo "need_node=true"; fi
  # the cache's own copy of the pinned bun (ci_bun_pinned) counts as having it: the run uses that copy, whatever is on PATH
  if [ "$pb" = "$(ci_have_bun)" ] || { c="$(ci_cache_dir 2>/dev/null)" && [ "$pb" = "$(ci_bun_at "$c/bun-bin/$pb/bun")" ]; }; then
    echo "need_bun=false"
  else echo "need_bun=true"; fi
  if [ "$pp" = "$(ci_have_pnpm)" ]; then echo "need_pnpm=false"; else echo "need_pnpm=true"; fi
  echo "pin_node=$pn"; echo "pin_bun=$pb"; echo "pin_pnpm=$pp"
}
# ci_bun_pinned <cache>: the folder of the cache's own copy of the pinned bun (made from the bun on PATH when that is the pin), for
# the front of PATH. A job never runs ~/.bun/bin/bun itself: that file is the owner's (and setup-bun's) and is replaced in place
# by an upgrade, so a run that started on one version ended on another (2026-11-14: 1.3.11 and 1.4.4 in one check). The copy is
# one folder per version, written once with a rename and never changed. Exit 1 when neither the copy nor PATH's bun is the pin.
ci_bun_pinned() {
  local pin dir src tmp have
  pin="$(ci_pin_bun)"
  [ -n "$pin" ] || { echo "ci-runner: cannot read the bun pin (ci.yml)" >&2; return 1; }
  dir="$1/bun-bin/$pin"
  if [ "$(ci_bun_at "$dir/bun")" != "$pin" ]; then
    have="$(ci_have_bun)" src="$(command -v bun 2>/dev/null)"
    [ "$have" = "$pin" ] && [ -f "$src" ] ||
      { echo "ci-runner: bun ${have:-is missing}${src:+ ($src)}, not the pinned $pin" >&2; return 1; }
    mkdir -p "$dir" && tmp="$(mktemp "$dir/.bun.XXXXXX")" || return 1
    if ! { cp "$src" "$tmp" && chmod 755 "$tmp" && mv -f "$tmp" "$dir/bun"; }; then
      rm -f "$tmp"
      echo "ci-runner: cannot copy $src into $dir" >&2
      return 1
    fi
    [ "$(ci_bun_at "$dir/bun")" = "$pin" ] || { echo "ci-runner: the copy $dir/bun does not run as bun $pin" >&2; return 1; }
  fi
  [ -L "$dir/bunx" ] || ln -s bun "$dir/bunx" 2>/dev/null || [ -L "$dir/bunx" ] || return 1
  printf '%s\n' "$dir"
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

# ---------- a scheduled run's own skips: in scripts/ci-runner/schedule.sh (ci_schedule_skip) ----------

# ---------- run ----------
# ci_pr_gone: exit 0 (and says so) when this PR run has nothing to test any more, so nothing is tested or posted.
ci_pr_gone() {
  local head
  # A job that sat in the queue (the runner was offline) can be a run for a commit that is no longer the PR's head. The newer
  # push has its own run; this one says so and posts nothing. (Without this, ci-local would test the newer head twice.)
  if head="$(ci_git_net "$ROOT" ls-remote origin "refs/pull/$PR_NUMBER/head" | cut -f1)" && [ -n "$head" ] && [ "$head" != "$PR_HEAD_SHA" ]; then
    echo "ci-runner: PR #$PR_NUMBER moved on (${PR_HEAD_SHA:0:7} -> ${head:0:7}) while this run waited for the runner; the newer push has its own run. Nothing tested, nothing posted."
    return 0
  fi
  # A job that waited in the queue (the runner was offline) can come back for a PR that was closed or merged meanwhile. It would
  # post a pending, then a result, over whatever the PR already has. If GitHub can't say, it runs: the head check above passed.
  if [ "$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER" --jq .state 2>/dev/null)" = closed ]; then
    echo "ci-runner: PR #$PR_NUMBER is closed; nothing tested, nothing posted."
    return 0
  fi
  return 1
}
ci_run() {
  local cache local_ci="${CI_LOCAL_SCRIPT:-$HERE/ci-local.sh}" args sha
  unset CI_SETTLE # asked for below, by a main push run alone
  ci_guard || return 1
  if [ "${GITHUB_EVENT_NAME:-}" = schedule ] && . "$HERE/ci-runner/schedule.sh" && ci_schedule_skip; then return 0; fi # skipped (scripts/ci-runner/schedule.sh)
  ci_split_checks run || return 1
  # No run splits browser with the browser-mac part any more (phase C revised): so never with CI_BROWSER_E2E_PART either, which
  # ci-local.sh refuses. The e2e part's knobs are Lemnos's own run's (plan), its workers the part's.
  unset CI_BROWSER_MAC_PART CI_PUSH_BEFORE
  [ -z "${CI_RUN_JOBS:-}" ] || unset CI_BROWSER_E2E_PART CI_BROWSER_E2E_WAIT CI_BROWSER_E2E_SHADOW CI_CHECK_PART CI_CHECK_WAIT
  [ "${CI_RUN_JOBS:-}" = browser-e2e ] || unset CI_PART_E2E_WORKERS
  [ -n "${GH_TOKEN:-}" ] || { echo "ci-runner: GH_TOKEN is not set, so no status could be posted" >&2; return 1; }
  [ -n "${GITHUB_REPOSITORY:-}" ] || { echo "ci-runner: GITHUB_REPOSITORY is not set" >&2; return 1; }
  cache="$(ci_cache_dir)" || return 1
  mkdir -p "$cache/wt" || return 1
  if [ "${GITHUB_EVENT_NAME:-}" = pull_request ]; then
    ! ci_pr_gone || return 0
    args=(--pr "$PR_NUMBER")
  elif [ "${GITHUB_EVENT_NAME:-}" = push ]; then
    # The sha the push made main, not the branch name: a second push while this one waits or runs must not change what is tested
    # (the workflow's concurrency keeps only the newest waiting run, and that run has its own sha).
    args=(--ref "$GITHUB_SHA")
    ! ci_settle_want || export CI_SETTLE=1
    # No force flags: ci-local.sh runs the desktop and mobile jobs for any commit already on origin/main (its own merge-base).
    # An exported flag would reach every job and the tests they run.
  elif [ "${GITHUB_EVENT_NAME:-}" = schedule ]; then
    # The nightly: main's tip as it was when the run started, with every job and every test (--full). It is the run that keeps
    # the skips honest (the kit suites inside a rendered agent folder run only on --full), without waiting for a dispatch.
    args=(--ref "$GITHUB_SHA" --full)
    # The bridge's folder-flip security fuzz (apps/bridge/test/review-memory-recheck.test.ts) runs 60 s here, 8 s on every push.
    export TALOS_FUZZ_MS=60000
  else
    # A dispatch is the owner asking by hand: every job runs (--full), whatever the diff says. This is also the full run that keeps
    # a chain of "skipped: no <job> inputs changed" honest; ci-local.sh skips on a push or a PR only.
    # with a planned commit, that commit: the branch may have moved since plan, and a dispatch has no newer run to test it
    args=(--ref "${CI_PLAN_SHA:-$INPUT_REF}" --full)
    [ -z "${INPUT_JOBS:-}" ] || [ -n "${CI_RUN_JOBS:-}" ] || args+=(--jobs "$INPUT_JOBS")
  fi
  # The split (docs/CI-MACHINES.md): every machine tests the commit the plan fixed (--sha)
  [ -z "${CI_PLAN_SHA:-}" ] || args=("${args[0]}" "${args[1]}" --sha "$CI_PLAN_SHA" "${args[@]:2}")
  [ -n "${CI_RUN_ID:-}" ] || [ -z "${GITHUB_RUN_ID:-}" ] || export CI_RUN_ID="$GITHUB_RUN_ID"
  if [ -n "${CI_RUN_JOBS:-}" ]; then
    # A part or report-only machine: its jobs, under their own prefix. One that starts after check was answered in this attempt
    # (Lemnos took its part) has nothing to add.
    sha="$CI_PLAN_SHA"
    # Titan's image: local-ci/ when it gates (on), report-ci/ in shadow; its browser-e2e part: ci-part/ (e2e) or report-ci/
    # (e2e-shadow). plan says which
    if [ "$CI_RUN_JOBS" = image ]; then
      case "${CI_RUN_PREFIX:-}" in local-ci | report-ci) ;; *) echo "ci-runner: refusing: CI_RUN_PREFIX '${CI_RUN_PREFIX:-}' is not local-ci or report-ci" >&2; return 1 ;; esac
    elif [ "$CI_RUN_JOBS" = browser-e2e ] || [ "$CI_RUN_JOBS" = check ]; then
      case "${CI_RUN_PREFIX:-}" in ci-part | report-ci) ;; *) echo "ci-runner: refusing: CI_RUN_PREFIX '${CI_RUN_PREFIX:-}' is not ci-part or report-ci" >&2; return 1 ;; esac
    fi
    # what a late start would answer was already answered in this attempt (Lemnos took it): nothing to add
    _owes=""
    # (the e2e part folds into browser: once browser is answered, nobody reads it; in shadow it is the comparison's, so it runs)
    case "$CI_RUN_JOBS" in linux) ;; image) [ "$CI_RUN_PREFIX" != local-ci ] || _owes=local-ci/image ;;
      browser-e2e) [ "$CI_RUN_PREFIX" != ci-part ] || _owes=local-ci/browser ;;
      check) [ "$CI_RUN_PREFIX" != ci-part ] || _owes=local-ci/check ;; *) _owes=local-ci/check ;; esac
    if [ -n "$_owes" ] && [ -n "${CI_ATTEMPT_URL:-}" ] &&
      [ -n "$(ci_attempt_final "$GITHUB_REPOSITORY" "$sha" "$(ci_ns "$_owes")" "$CI_ATTEMPT_URL")" ]; then
      echo "ci-runner: ${_owes#local-ci/} is already answered in this attempt; nothing to test here"
      return 0
    fi
    case "$CI_RUN_JOBS" in linux) export CI_STATUS_PREFIX=report-ci ;; image | browser-e2e | check) export CI_STATUS_PREFIX="$CI_RUN_PREFIX" ;; *) export CI_STATUS_PREFIX=ci-part ;; esac
    args+=(--jobs "$CI_RUN_JOBS")
  fi
  ci_exec_local "$cache" "$local_ci" "${args[@]}"
}

# ci_exec_local <cache> <ci-local.sh> <args...>: become ci-local.sh with the runner's settings (run and fallback).
ci_exec_local() {
  local cache="$1" local_ci="$2" bun_dir
  shift 2
  # every job runs the pinned bun from the cache's own copy, never whatever ~/.bun/bin/bun has become meanwhile
  bun_dir="$(ci_bun_pinned "$cache")" || return 1
  export PATH="$bun_dir:$PATH"
  echo "ci-runner: bun: $(ci_have_bun) ($bun_dir/bun)"
  # No sleep while it works. Plugged in, -s stops system sleep, -i idle sleep, -m disk sleep; on battery with the lid shut the Mac
  # sleeps whatever this says, and ci-local.sh then warns on the jobs of that run (ci_slept_since; CI_SLEEP_GUARD=1 fails them).
  if command -v caffeinate >/dev/null 2>&1; then caffeinate -i -m -s -w $$ >/dev/null 2>&1 & fi
  export CI_REPO="$GITHUB_REPOSITORY" CI_STATUS_WHERE="${CI_STATUS_WHERE:-ci-runner}" CI_WT_BASE="$cache/wt" TALOS_CI_CACHE="$cache"
  # Bun's package cache and Playwright's browsers live in the cache too when it has them, beside the slots' temp folders: one
  # folder the Mac's antivirus can be told to skip, instead of ~/.bun and ~/Library/Caches that every run churns through.
  [ -d "$cache/bun-cache" ] && export BUN_INSTALL_CACHE_DIR="${BUN_INSTALL_CACHE_DIR:-$cache/bun-cache}"
  [ -d "$cache/ms-playwright" ] && export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$cache/ms-playwright}"
  # exec: this process becomes ci-local.sh. A runner signals only the one process it started for the step, never its children, so
  # the workflow's `run:` must exec this script too (a wrapper shell in between would take the signal and leave ci-local.sh running).
  exec bash "$local_ci" "$@"
}

# ---------- fallback ----------
# After Lemnos's own ci-local.sh (green or red): each gating job handed to another machine (CI_FALLBACK, "<machine>:<job,...>"
# per machine, from plan) that has no final answer in this attempt is run here: at once when its machine never picked its job up
# or ended without answering, after CI_REMOTE_DEADLINE (900 s from the run's start) when it is still working. All of them in one
# ci-local.sh call. GitHub never moves a queued job to another runner, so this is the only way a machine that is off still gets
# a verdict (docs/CI-MACHINES.md, "How Lemnos decides"). A job in CI_DECLINE_JOBS (this machine's own setting, a comma list) is
# never taken: when its machine has no answer, an `error` is posted on it instead (after the deadline, or at once when its machine
# is not working on it), so the context never stays pending.
ci_fallback() {
  local spec m list j st final take="" declined="" waiting started deadline now cache local_ci="${CI_LOCAL_SCRIPT:-$HERE/ci-local.sh}" jobs sha
  local notes="" why
  if [ "${GITHUB_EVENT_NAME:-}" = schedule ] && . "$HERE/ci-runner/schedule.sh" && ci_schedule_skip; then return 0; fi # skipped (scripts/ci-runner/schedule.sh)
  [ -n "${CI_FALLBACK:-}" ] || { echo "ci-runner: fallback: nothing was handed to another machine"; return 0; }
  [ "$(ci_settled)" != superseded=true ] || { echo "ci-runner: fallback: this run stood aside for a newer push (settle); nothing is taken over"; return 0; }
  for spec in $CI_FALLBACK; do
    case "$spec" in
      *[!a-z0-9:,-]* | :* | *: | *, | *,,* | *:*:*) echo "ci-runner: fallback: '$spec' is not <machine>:<job,...>" >&2; return 1 ;;
      *:*) ;; *) echo "ci-runner: fallback: '$spec' is not <machine>:<job,...>" >&2; return 1 ;;
    esac
    for j in $(printf '%s' "${spec#*:}" | tr ',' ' '); do
      case "$j" in check | mod | browser | image | desktop | mobile) ;; *) echo "ci-runner: fallback: '$j' is not a job" >&2; return 1 ;; esac
    done
  done
  case "${CI_DECLINE_JOBS:-}" in
    *[!a-z,]* | ,* | *, | *,,*) echo "ci-runner: fallback: CI_DECLINE_JOBS '$CI_DECLINE_JOBS' is not <job,...>" >&2; return 1 ;;
  esac
  for j in $(printf '%s' "${CI_DECLINE_JOBS:-}" | tr ',' ' '); do
    case "$j" in check | mod | browser | image | desktop | mobile) ;; *) echo "ci-runner: fallback: CI_DECLINE_JOBS '$j' is not a job" >&2; return 1 ;; esac
  done
  ci_guard || return 1
  ci_split_checks fallback || return 1
  [ -n "${CI_ATTEMPT_URL:-}" ] || { echo "ci-runner: fallback needs CI_ATTEMPT_URL" >&2; return 1; }
  sha="$CI_PLAN_SHA"
  started="${CI_RUN_STARTED:-$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/${GITHUB_RUN_ID:-0}" --jq .run_started_at 2>/dev/null)}"
  started="$(date -u -d "$started" +%s 2>/dev/null || date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$started" +%s 2>/dev/null || date +%s)"
  deadline=$((started + 10#${CI_REMOTE_DEADLINE:-900}))
  while :; do
    take="" declined="" waiting=0 now=$(date +%s)
    jobs="$(gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs/${GITHUB_RUN_ID:-0}/jobs?per_page=100" --jq '.jobs[] | [.name, .status] | @tsv' 2>/dev/null)"
    for spec in $CI_FALLBACK; do
      m="${spec%%:*}" list="${spec#*:}"
      st="$(printf '%s\n' "$jobs" | awk -F'\t' -v m="$m" '$1 == m { print $2; exit }')"
      for j in $(printf '%s' "$list" | tr ',' ' '); do
        final="$(ci_attempt_final "$GITHUB_REPOSITORY" "$sha" "$(ci_ns "local-ci/$j")" "$CI_ATTEMPT_URL")" || final=""
        [ -z "$final" ] || continue # answered in this attempt, by anyone
        if [ "$st" = in_progress ] && [ "$now" -lt "$deadline" ]; then waiting=1; continue; fi
        case ",${CI_DECLINE_JOBS:-}," in *",$j,"*) declined="${declined:+$declined }$j:$m"; continue ;; esac # never taken here
        take="${take:+$take,}$j" # queued (never picked up), completed without an answer, unreadable, or past the deadline
      done
    done
    [ "$waiting" = 1 ] || break
    sleep "${CI_FALLBACK_POLL:-30}"
  done
  [ -n "$take" ] || [ -n "$declined" ] || { echo "ci-runner: fallback: every job handed elsewhere is answered in this attempt"; return 0; }
  # A PR that moved on or was closed: the run step and the other machine tested nothing for it, and neither does this.
  if [ "${GITHUB_EVENT_NAME:-}" = pull_request ] && ci_pr_gone; then return 0; fi
  local declfail=0
  for spec in $declined; do
    j="${spec%%:*}" m="${spec#*:}"
    echo "ci-runner: fallback: $j is declined here (CI_DECLINE_JOBS) and $m did not answer; posting error, not running it"
    gh api -X POST "repos/$GITHUB_REPOSITORY/statuses/$sha" -f state=error -f context="$(ci_ns "local-ci/$j")" \
      -f description="not run: this machine declines $j (CI_DECLINE_JOBS) and $m did not answer" \
      -f target_url="${CI_STATUS_URL:-$CI_ATTEMPT_URL}" >/dev/null 2>&1 || {
        # a gating context left unreported is no quiet skip: with nothing to take back this step fails (when a job is taken, the exec
        # below makes this process ci-local.sh, so the ::error:: line is what remains)
        echo "::error::ci-runner: fallback: could not post the error for local-ci/$j; it stays unreported" >&2
        declfail=1
      }
  done
  [ -n "$take" ] || return "$declfail"
  echo "ci-runner: fallback: taking $take here"
  # why each one is answered here, for the end of its status (ci-local.sh): "titan errored" (it closed its pending as an error:
  # stopped or cancelled), "titan did not answer in time" (still working at the deadline), else "titan did not answer"
  for spec in $CI_FALLBACK; do
    m="${spec%%:*}"
    st="$(printf '%s\n' "$jobs" | awk -F'\t' -v m="$m" '$1 == m { print $2; exit }')"
    for j in $(printf '%s' "${spec#*:}" | tr ',' ' '); do
      case ",$take," in *",$j,"*) ;; *) continue ;; esac
      if ci_attempt_errored "$GITHUB_REPOSITORY" "$sha" "$(ci_ns "local-ci/$j")" "$CI_ATTEMPT_URL$m"; then why="$m errored"
      elif [ "$st" = in_progress ]; then why="$m did not answer in time"
      else why="$m did not answer"; fi
      notes="${notes:+$notes;}$j=$why"
    done
  done
  export CI_FALLBACK_NOTES="$notes"
  # what Lemnos's run left out for another machine is not left out again; a browser here is all of it, never folded or split
  unset CI_REMOTE_JOBS CI_BROWSER_MAC_PART CI_PUSH_BEFORE CI_BROWSER_E2E_PART CI_BROWSER_E2E_WAIT CI_BROWSER_E2E_SHADOW CI_CHECK_PART CI_CHECK_WAIT
  cache="$(ci_cache_dir)" || return 1
  mkdir -p "$cache/wt" || return 1
  # the nightly and a dispatch are full runs (and the nightly's fuzz is the long one), as Lemnos's own run was
  case "${GITHUB_EVENT_NAME:-}" in
    schedule) export TALOS_FUZZ_MS=60000; ci_exec_local "$cache" "$local_ci" --ref "$sha" --sha "$sha" --full --jobs "$take" ;;
    workflow_dispatch) ci_exec_local "$cache" "$local_ci" --ref "$sha" --sha "$sha" --full --jobs "$take" ;;
    # a PR's head is fetched from the PR (ci-local --pr) and pinned to the planned commit, as the run step did
    pull_request) ci_exec_local "$cache" "$local_ci" --pr "$PR_NUMBER" --sha "$sha" --jobs "$take" ;;
    *) ci_exec_local "$cache" "$local_ci" --ref "$sha" --sha "$sha" --jobs "$take" ;;
  esac
}

# ---------- preflight ----------
ci_preflight() { bash "${CI_LOCAL_SCRIPT:-$HERE/ci-local.sh}" --preflight; }

# ---------- sweep ----------
ci_sweep() {
  local sha url repo rows newest row ctx state turl reported n=0 words
  [ -n "${CI_SHA_FILE:-}" ] && [ -s "$CI_SHA_FILE" ] || { echo "ci-runner: no run got as far as a commit; no status was posted"; return 0; }
  sha="$(head -1 "$CI_SHA_FILE")" url="${CI_STATUS_URL:-}" repo="${GITHUB_REPOSITORY:-}"
  case "$sha" in *[!0-9a-f]* | '') echo "ci-runner: $CI_SHA_FILE does not hold a commit sha; nothing swept" >&2; return 1 ;; esac
  [ -n "$sha" ] && [ -n "$url" ] && [ -n "$repo" ] || { echo "ci-runner: sweep needs the sha, CI_STATUS_URL and GITHUB_REPOSITORY" >&2; return 1; }
  if ! rows="$(gh api --paginate "repos/$repo/commits/$sha/status?per_page=100" --jq '.statuses[] | [.context, .state, .target_url] | @tsv' 2>/dev/null)"; then
    echo "::warning::ci-runner: could not read the statuses of ${sha:0:7}; any still pending from this run are left as they are"
    return 0
  fi
  # The combined read above can lag a write by a second or more: on Titan (0d3b391) a job posted success and the sweep, a second
  # later, still read its pending and wrote error over the green. Two guards, so a stale read never closes an answered status:
  # (a) ci_post_status writes down every answer it posted (CI_SHA_FILE.reported: commit, context, link); this run's are skipped.
  # (b) the newest-first list of every status (commits/<sha>/statuses) is read once; a context is closed only when its newest
  #     row there is still this run's pending. If that list can't be read, the combined read decides, as before.
  reported="${CI_SHA_FILE}.reported"
  # A cancelled job (job.status, passed in as CI_JOB_STATUS) was not tested: its pending closes as an error that says "not
  # tested:", which no verdict reads as red or green (like report-ci/superseded), and GitHub never shows green. Any other end
  # (it died) keeps the plain error.
  words="run on ${CI_STATUS_WHERE:-ci-runner} ended before this job reported (cancelled or interrupted); re-run"
  [ "${CI_JOB_STATUS:-}" != cancelled ] || words="not tested: run cancelled before this job reported (on ${CI_STATUS_WHERE:-ci-runner}); re-run"
  newest="$(gh api --paginate "repos/$repo/commits/$sha/statuses?per_page=100" --jq '.[] | [.context, .state, (.target_url // "")] | @tsv' 2>/dev/null \
    | awk -F'\t' '!seen[$1]++')" || newest=""
  while IFS=$'\t' read -r ctx state turl; do
    case "$ctx" in local-ci/* | report-ci/* | ci-part/* | nightly-ci/* | hostile-ci/*) ;; *) continue ;; esac # the six, report-only, parts, nightlies
    # Only a status THIS workflow run posted: the other path (the owner's Mac) and a newer run share these contexts.
    [ "$state" = pending ] && [ "$turl" = "$url" ] || continue
    if [ -s "$reported" ] && grep -qxF -- "$sha"$'\t'"$ctx"$'\t'"$url" "$reported"; then continue; fi # (a) this run answered it
    # (b) the list's newest row for it: answered since (by this run or another) means not ours to close. Still this run's
    # pending, or not in the list yet: close it.
    if [ -n "$newest" ]; then
      row="$(printf '%s\n' "$newest" | awk -F'\t' -v c="$ctx" '$1 == c { print $2 "\t" $3; exit }')"
      [ -z "$row" ] || [ "$row" = "pending"$'\t'"$url" ] || continue
    fi
    gh api -X POST "repos/$repo/statuses/$sha" -f state=error -f context="$ctx" -f description="$words" \
      -f target_url="$url" >/dev/null 2>&1 && n=$((n + 1))
  done <<EOF
$rows
EOF
  echo "ci-runner: closed $n status(es) left pending by this run on ${sha:0:7}"
  ci_sweep_earlier_linux "$repo" "$sha" "$url"
}

# ci_sweep_earlier_linux <repo> <sha> <this run's link>: on Hestia only (CI_RUN_JOBS=linux). Its gate can stop the runner while a
# job runs (docs/CI-MACHINES.md, "Only while the builder is idle"); that job's own sweep never runs and its report-ci/linux stays
# pending. So on this commit and the last 20 of main, a pending report-ci/linux whose link is another run of this workflow that
# has finished (its state read from GitHub: completed, and its workflow file ci-runner.yml) is closed as error, under that run's
# own link. A running run's, one whose state cannot be read, and any other context are left alone. Report-only: it blocks nothing.
ci_sweep_earlier_linux() {
  local repo="$1" sha="$2" url="$3" c rows ctx state turl id info seen=" " n=0
  [ "${CI_RUN_JOBS:-}" = linux ] || return 0
  for c in "$sha" $(gh api "repos/$repo/commits?sha=main&per_page=20" --jq '.[].sha' 2>/dev/null); do
    case "$c" in *[!0-9a-f]* | '') continue ;; esac
    case "$seen" in *" $c "*) continue ;; esac
    seen="$seen$c "
    rows="$(gh api --paginate "repos/$repo/commits/$c/status?per_page=100" --jq '.statuses[] | [.context, .state, (.target_url // "")] | @tsv' 2>/dev/null)" || continue
    while IFS=$'\t' read -r ctx state turl; do
      [ "$ctx" = "$(ci_ns report-ci/linux)" ] && [ "$state" = pending ] && [ "$turl" != "$url" ] || continue # its own kind only
      id="$(printf '%s' "$turl" | sed -nE "s#^https://[^/]+/$repo/actions/runs/([0-9]+)(/.*)?\$#\\1#p")"
      [ -n "$id" ] && [ "$id" != "${GITHUB_RUN_ID:-}" ] || continue
      if ! info="$(gh api "repos/$repo/actions/runs/$id" --jq '[.status, .path] | @tsv' 2>/dev/null)"; then
        echo "::warning::ci-runner: could not read run $id (it needs actions: read); its pending report-ci/linux on ${c:0:7} is left"
        continue
      fi
      [ "$info" = "completed"$'\t'".github/workflows/ci-runner.yml" ] || continue
      gh api -X POST "repos/$repo/statuses/$c" -f state=error -f context="$ctx" \
        -f description="the earlier Hestia run $id ended before it reported (its runner was stopped); re-run" \
        -f target_url="$turl" >/dev/null 2>&1 && n=$((n + 1))
    done <<EOF
$rows
EOF
  done
  echo "ci-runner: closed $n report-ci/linux status(es) left pending by earlier Hestia runs"
}

# ---------- logs: in scripts/ci-runner/logs.sh (ci_logs) ----------

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
#                exactly "skipped: no <job> inputs changed since <sha>" (or the older "skipped: no affected files") on a job other
#                than check (ci-affected.sh: nothing the job reads changed since that job last passed); it is not a pass, so it is
#                listed apart, but it does not stop a verdict.
#   interrupted  an error state (cancelled, interrupted or slept through; the run asked for a re-run)
#   green        all six final, each "passed on ..." (or skipped for that one reason). "passed on ..., passed on retry (...)" is a
#                pass too (a test failed once and passed when run again; ci-local.sh logs it in flakes.tsv); the detail names them.
ci_classify() {
  local ctx state desc c n=0 missing="" pending="" skipped="" errored="" failed="" passed="" unaffected="" retried="" seen=" "
  while IFS=$'\t' read -r ctx state desc; do
    case "$ctx" in local-ci/*) ;; *) continue ;; esac
    c="${ctx#local-ci/}"
    case " $CI_CONTEXTS " in *" $c "*) ;; *) continue ;; esac # only the six: an older script may post local-ci/fast
    case "$seen" in *" $c "*) continue ;; esac # the first one wins: the API lists the newest first
    seen="$seen$c "
    n=$((n + 1))
    case "$state" in
      pending) pending="$pending $c" ;;
      success) case "$desc" in
        "passed on "*) passed="$passed $c"; case "$desc" in *", passed on retry"*) retried="$retried $c" ;; esac ;;
        # the job's inputs did not change since it last passed (ci-affected.sh): the old words, or the new ones with that commit
        "skipped: no affected files" | "skipped: no $c inputs changed since "*)
          case "${desc#skipped: no affected files}" in
            *" since "*[!0-9a-f]* | *" since ") skipped="$skipped $c" ;; # the commit is not a sha: no verdict
            *) if [ "$c" = check ]; then skipped="$skipped $c"; else unaffected="$unaffected $c"; fi ;;
          esac ;;
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
  printf 'green\tpassed:%s%s%s\n' "$passed" "${unaffected:+; skipped, no affected files:$unaffected}" "${retried:+; passed on retry:$retried}"
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

# ---------- alert: in scripts/ci-runner/alert.sh (ci_alert, and ci_alert_age that untested uses too) ----------

# ---------- untested: main has had no finished verdict for 2 h while commits landed ----------
# The gap is timed from when the oldest untested commit landed (its committer date), so a commit pushed after a quiet day is
# not "untested" while CI is still on it. ONE message per gap (~/.cache/talos-ci/main-untested holds the last tested commit it
# was said for), in the same alerts folder: how long, how many commits, the last tested commit and how long ago its verdict was.
# It clears, silently, once a newer commit has a verdict. Run by the alert step and every 10 minutes by scripts/ci-alerts.sh
# watch (no CI needed, a few gh reads).
ci_untested() {
  local repo="${GITHUB_REPOSITORY:-treynortetik-creator/talos-app}" cache="${TALOS_CI_CACHE:-$HOME/.cache/talos-ci}"
  local after="${CI_UNTESTED_AFTER_S:-7200}" now list sha when rows line cls tested="" count=0 at iso age f oldest="" since
  now=$(date +%s) f="$cache/main-untested"
  list="$(gh api "repos/$repo/commits?sha=main&per_page=50" --jq '.[] | [.sha, .commit.committer.date] | @tsv' </dev/null 2>/dev/null)" || { echo "ci-runner: untested: main's commits could not be read"; return 0; }
  while IFS=$'\t' read -r sha when; do
    [ -n "$sha" ] || continue
    rows="$(gh api --paginate "repos/$repo/commits/$sha/status?per_page=100" --jq '.statuses[] | [.context, .state, .description, .updated_at] | @tsv' </dev/null 2>/dev/null)" || { echo "ci-runner: untested: the statuses of ${sha:0:7} could not be read"; return 0; }
    line="$(printf '%s\n' "$rows" | cut -f1-3 | ci_classify)"
    cls="${line%%$'\t'*}"
    case "$cls" in green | red) tested="$sha"; break ;; esac
    count=$((count + 1))
    oldest="$when" # newest first: the last one before the tested commit landed first
  done <<LIST
$list
LIST
  [ -n "$tested" ] || { echo "ci-runner: untested: no finished verdict in main's newest 50 commits"; return 0; }
  iso="$(printf '%s\n' "$rows" | awk -F'\t' '$1 ~ /^local-ci\// && $4 != "" { print $4 }' | sort | tail -1)"
  at="$(date -u -d "$iso" +%s 2>/dev/null || date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$iso" +%s 2>/dev/null)" || at=""
  [ -n "$at" ] || { echo "ci-runner: untested: when ${tested:0:7}'s verdict came is unknown"; return 0; }
  since=""
  [ "$count" = 0 ] || since="$(date -u -d "$oldest" +%s 2>/dev/null || date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$oldest" +%s 2>/dev/null)"
  if [ "$count" -gt 0 ] && [ -n "$since" ] && [ $((now - since)) -ge "$after" ]; then
    [ "$(cat "$f" 2>/dev/null)" != "$tested" ] || { echo "ci-runner: untested: already said for this gap"; return 0; }
    age="$(ci_alert_age $((now - at)))"
    mkdir -p "$cache/alerts" || return 0
    printf 'main UNTESTED: no finished verdict for %s while %s commit%s landed; last tested %s (%s, %s ago)\n' \
      "$(ci_alert_age $((now - since)))" "$count" "$([ "$count" = 1 ] || echo s)" "${tested:0:7}" "$cls" "$age" > "$cache/alerts/.$now-untested.part" &&
      mv -f "$cache/alerts/.$now-untested.part" "$cache/alerts/$now-${tested:0:7}-untested.txt"
    printf '%s\n' "$tested" > "$f"
    echo "ci-runner: untested: written for the lead: $count commits since ${tested:0:7}"
  else
    rm -f "$f" # no gap, or it closed
  fi
  return 0
}

# Sourced (the tests do this): only the functions above.
if (return 0 2>/dev/null); then return 0; fi

case "${1:-}" in
  guard) ci_guard ;;
  tools) ci_tools "$ROOT" ;;
  size) ci_size_env ;;
  run) . "$HERE/ci-runner/main-queue.sh" && ci_run ;;
  plan) ci_plan ;;
  fallback) . "$HERE/ci-runner/main-queue.sh" && ci_fallback ;;
  settled) . "$HERE/ci-runner/main-queue.sh" && ci_settled ;;
  preflight) ci_preflight ;;
  sweep) ci_sweep ;;
  logs) . "$HERE/ci-runner/logs.sh" && ci_logs ;;
  verdict) ci_verdict "${2:-}" ;;
  alert) . "$HERE/ci-runner/alert.sh" && { ci_alert; [ "${CI_HOSTILE:-}" = 1 ] || { ci_untested; ci_report_alert; }; } ;;
  untested) . "$HERE/ci-runner/alert.sh" && { ci_untested; ci_report_alert; } ;;
  e2e-shadow) . "$HERE/ci-runner/e2e-shadow.sh" && ci_e2e_shadow ;;
  check-shadow) . "$HERE/ci-runner/e2e-shadow.sh" && . "$HERE/ci-runner/check-shadow.sh" && ci_check_shadow ;;
  superseded) . "$HERE/ci-runner/main-queue.sh" && ci_superseded_mark ;;
  dispatch-wait) . "$HERE/ci-runner/main-queue.sh" && ci_dispatch_wait ;;
  green) . "$HERE/ci-runner/green.sh" && ci_green ;;
  *) sed -n '2,36p' "$0"; exit 64 ;;
esac
