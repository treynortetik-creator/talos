#!/usr/bin/env bash
# Local CI: runs the same jobs as .github/workflows/ci.yml on this Mac and posts the result to GitHub as commit
# statuses (context `local-ci/<job>`), so a PR shows green or red without spending Actions minutes.
# Added 2026-10-29 when the account ran out of Actions minutes; it stays the default afterwards (ci.yml is now manual-only, `gh workflow run CI --ref <branch>` still runs it in the cloud). docs/CI-LOCAL.md has the details.
#
#   scripts/ci-local.sh --pr 39                 # test the PR's head commit
#   scripts/ci-local.sh --ref feat/x            # any branch, tag or sha (pushed or local)
#   env: TALOS_CI_FORCE_DESKTOP=1 (or true/yes/on) runs the desktop job even when no desktop path changed
#        (a commit that is already on origin/main is its own merge-base, so its diff is empty and the gate cannot decide: the desktop
#        and mobile jobs run on it without any flag, on a push, a dispatch or a hand run)
#        CI_SLOTS=3 runs at once · CI_MAX_LOAD=14: a new run waits while the 5-min load average is above it (0 = off)
#        TALOS_CI_CACHE: this dir instead of ~/.cache/talos-ci · TALOS_CI_IMAGE_PORT, TALOS_CI_PW_PORT: slot 1's ports · CI_WORKERS
#   options: --jobs check,mod,browser,image,desktop,mobile (default all) · --latest (also the advisory latest-CLI mod run)
#            --full (no job is skipped for lack of affected files; a run with --jobs or --no-status never skips either)
#            --no-status (don't post to GitHub) · --keep (keep the scratch worktree) · --reap (stop what dead runs left, then exit)
#   env for a run on a shared runner (all optional; docs/CI-LOCAL.md, "On the self-hosted runner"): CI_REPO=owner/name (skip `gh repo view`),
#        CI_SETTLE=1 (ci-runner.sh sets it for a main push run only: wait for a quiet head first, scripts/ci-local/settle.sh;
#        TALOS_CI_SETTLE_S, TALOS_CI_SETTLE_MAX_S, TALOS_CI_SETTLE_POLL_S, TALOS_CI_SETTLE_STALE_S; CI_PUSHED_AT: when the head was
#        pushed), CI_STATUS_WHERE (the words in a status, default this machine's own name), CI_STATUS_URL (its link), CI_SHA_FILE (the sha tested,
#        written here), CI_WT_BASE (where scratch worktrees go), CI_SLEEP_GUARD=1 (fail jobs of a run the Mac slept through; default is a warning)
#
# Up to CI_SLOTS runs go at once. Each holds a slot (~/.cache/talos-ci/locks/slot-N) and gets its own scratch worktree, temp dir (~/.cache/talos-ci/tmp/talos-ci-sN), Playwright port, image-test port and container, so your checkout is never
# touched and runs never share a port. A step that needs a machine-wide resource that can't be split (the desktop build, browser downloads, starting colima) takes a mutex for just that step. A queued run re-resolves the PR head once it has
# its slot, so it never tests a stale commit; statuses go to the commit actually tested. Logs: ~/.cache/talos-ci/logs/ (logs/hostile/ and logs/nightly/ for those runs).
# Inside a run the install and build happen once, then mod, image and the Swift jobs go beside check, and browser after it.
# Exit 0 only if all passed.
set -uo pipefail
# Every file a job makes is changed only by its owner, whatever the runner's default: talos-ci's systemd user manager gave
# its runner 0002, so the jobs' temp folders were group-writable and every rooted-kit check (rightly) refused them: 36 tests
# red on Titan that pass everywhere else (the first check-titan shadow run, 58caeb6).
umask 022

# The parts of this script live in scripts/ci-local/ beside it and are sourced below (the jobs' before any wait). All of them are checked here,
# first: a copy of ci-local.sh without them stops before it does anything (it never half-runs).
CI_LOCAL_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ci-local"
for _ci_part in locks turn machine settle jobs-check jobs-mod-browser jobs-image jobs-swift; do
  [ -r "$CI_LOCAL_LIB/$_ci_part.sh" ] || { echo "ci-local: $CI_LOCAL_LIB/$_ci_part.sh is missing: ci-local.sh needs the scripts/ci-local/ folder beside it" >&2; exit 64; }
  # a part that does not parse would stop the run half-way through, where it is sourced: stop here instead
  bash -n "$CI_LOCAL_LIB/$_ci_part.sh" || { echo "ci-local: $CI_LOCAL_LIB/$_ci_part.sh does not parse" >&2; exit 64; }
done

# git never waits for a person: no terminal prompt, no credential manager window, no ssh passphrase question (Titan's runner
# hung 4 h 23 m in a fetch that asked for a credential nobody was there to give). Exported, so every git below and in the jobs
# gets it; a network call also has stdin from /dev/null and a time limit (ci_git_net).
export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never
# ssh in batch mode, unless the owner chose an ssh command of their own (GIT_SSH_COMMAND, GIT_SSH, core.sshCommand)
[ -n "${GIT_SSH_COMMAND:-}${GIT_SSH:-}" ] || [ -n "$(git config --get core.sshCommand 2>/dev/null)" ] ||
  export GIT_SSH_COMMAND="ssh -o BatchMode=yes"

# ---------- locks ----------
# A lock is a directory made with mkdir (the atomic step) holding `owner`: pid, process start time, nonce. Release renames
# the directory away before deleting it, so nobody ever sees a half-removed lock. The rule everything below keeps: only one
# process at a time may believe it holds a lock, however long any of them stalls (load, a stopped process, a sleeping Mac).
#
# A lock whose owner is dead is taken over, never deleted. The waiter makes a claim, `<lock>/takeover-<owner key>.<n>`, then
# re-checks that the owner is still the dead one (the lock may have been released and retaken since it looked) and writes
# itself in. A claim is a symlink whose target names the claimer: `ln -s` is atomic and refuses an existing name, so one
# waiter wins each claim and nobody can see it half-written. A claim is never taken from a live claimer, however old it
# is. Age proves nothing: a claimer stalled past a time limit wakes up and writes, and then two runs hold the slot. When a
# claimer has died, the next waiter makes claim n+1 instead of removing claim n, so nobody ever removes a live claim by
# mistake. The first owner of a lock is written with `ln`, which refuses to replace one, so a creator that stalled past
# CI_LOCK_GRACE loses to the waiter that took over, instead of overwriting it.
CI_SLOTS="${CI_SLOTS:-3}" CI_MAX_LOAD="${CI_MAX_LOAD:-14}"
# The most full suites (runs) at once on this machine, whatever CI_SLOTS asks: a per-machine setting (the runner's .env), 2 by
# default. Three at once on Lemnos took 3400-4000 s a run against 1000-2000 s (2026-11-13). Not a whole number >= 1: the default.
CI_MAX_SUITES="${CI_MAX_SUITES:-2}"
case "$CI_MAX_SUITES" in '' | *[!0-9]* | 0) CI_MAX_SUITES=2 ;; esac
case "$CI_SLOTS" in '' | *[!0-9]*) ;; *) [ "$CI_SLOTS" -le "$CI_MAX_SUITES" ] || CI_SLOTS="$CI_MAX_SUITES" ;; esac
# The Playwright port of slot N is base + step * (N - 1) (ci_slot_env; TALOS_CI_PW_PORT moves the base). apps/web/playwright.config.ts
# reads these three lines (apps/web/test/helpers/pw-port.ts) and refuses those ports outside a slot run, so a run by hand cannot
# take a port a slot is about to bind. PORT_SLOTS is the most slots the runners are sized for ("Sizing" in docs/CI-LOCAL.md).
CI_PW_PORT_BASE=4873
CI_PW_PORT_STEP=10
CI_PW_PORT_SLOTS=6
CI_POLL="${CI_POLL:-5}" CI_LOCK_TIMEOUT="${CI_LOCK_TIMEOUT:-3600}"
# The time limits of the mobile job's simulator steps (ci_ios_test). They hold the machine-wide `desktop` mutex, and a run waiting
# for it gives up after CI_LOCK_TIMEOUT, so the worst case of the steps must stay under it: 6 simctl calls (the device list,
# runtime list and create, the check listing, two shutdowns) and 4 boot waits or test runs (the Busy retry doubles them).
# 6 x 120 + 4 x 600 = 3120 s, under the 3600 s above.
# scripts/ci-local-runner.test.ts checks the sum against the timeout, so raising a limit without the timeout goes red.
CI_SIMCTL_LIMIT="${CI_SIMCTL_LIMIT:-120}" CI_XCODE_TEST_LIMIT="${CI_XCODE_TEST_LIMIT:-600}"
CI_LOCK_GRACE="${CI_LOCK_GRACE:-30}" # seconds a lock may exist without an owner before a waiter may give it one
CI_NONCE="$$-$RANDOM$RANDOM-$(date +%s)"
CI_HELD="" CI_SLOT="" CI_MARKER=""

. "$CI_LOCAL_LIB/locks.sh"

. "$CI_LOCAL_LIB/machine.sh"

. "$CI_LOCAL_LIB/settle.sh"

# Sourced (the tests do this): stop here, with only the functions above defined.
if (return 0 2>/dev/null); then return 0; fi

# The jobs' parts are read now, before the slot and commit waits (an hour at most): a checkout pulled meanwhile (a hand run from
# a builder's own tree) must not hand this run newer job code. They hold functions and fixed values only, so reading them
# here, not where the jobs are started, changes nothing else.
. "$CI_LOCAL_LIB/jobs-check.sh"
. "$CI_LOCAL_LIB/jobs-mod-browser.sh"
. "$CI_LOCAL_LIB/jobs-image.sh"
. "$CI_LOCAL_LIB/jobs-swift.sh"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="${TALOS_CI_CACHE:-$HOME/.cache/talos-ci}"
unset _ci_held # internal (report() sets it): an exported one must never hold back a post
unset TALOS_CI_CACHE # for this run only: the tests start this script themselves, under a fake HOME, and must not inherit it
LOGS="$(ci_logs_dir "$CACHE")"; mkdir -p "$LOGS" # this kind of run's logs (ci_logs_dir): a hostile or nightly run never touches a push run's

# The slot temp dir lives beside the slot's lock, under $HOME, because holding the lock is what makes it ours to empty. It
# used to be $TMPDIR/talos-ci-sN: a run under another HOME has other locks and the same $TMPDIR, so every `pnpm test` in a
# builder's checkout (ci-local-slots.test.ts runs this script with a fake HOME) deleted the live temp dir of real slot 1.
# The scratch worktrees go under CI_WT_BASE when set (a runner whose $TMPDIR is wiped between jobs sets it to its cache).
LOCKS="$CACHE/locks" CI_TMP_BASE="$CACHE/tmp" WT_BASE="${CI_WT_BASE:-${TMPDIR:-/tmp}}"
CI_RUNS="$CACHE/runs"
PR="" REF="" JOBS="check,mod,browser,image,desktop,mobile" JOBS_SET=0 FULL=0 LATEST=0 STATUS=1 KEEP=0 REAP=0 PIN_SHA="" PREFLIGHT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --pr) PR="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --sha) PIN_SHA="$2"; shift 2
      case "$PIN_SHA" in *[!0-9a-f]* | '') echo "ci-local: --sha takes a full commit sha" >&2; exit 64 ;; esac
      [ "${#PIN_SHA}" = 40 ] || { echo "ci-local: --sha takes a full commit sha" >&2; exit 64; } ;;
    --jobs) JOBS="$2"; JOBS_SET=1; shift 2
      case ",$JOBS," in *,fast,*) echo "ci-local: fast is not a job: report-ci/fast comes with check" >&2; exit 64 ;; esac ;;
    --full) FULL=1; shift ;;
    --latest) LATEST=1; shift ;;
    --no-status) STATUS=0; shift ;;
    --keep) KEEP=1; shift ;;
    --reap) REAP=1; shift ;;
    --preflight) PREFLIGHT=1; shift ;; # only the owner-machine check (ci-runner.sh preflight), then exit
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "ci-local: unknown argument $1" >&2; exit 64 ;;
  esac
done
case "$CI_SLOTS" in '' | *[!0-9]* | 0) echo "ci-local: CI_SLOTS must be a whole number >= 1" >&2; exit 64 ;; esac
# Where the statuses go (ci_context). The part and report-only jobs never under local-ci/: a pass there would count in the verdict.
case "${CI_STATUS_PREFIX:-local-ci}" in local-ci | ci-part | report-ci) ;;
  *) echo "ci-local: CI_STATUS_PREFIX is local-ci, ci-part or report-ci, not '$CI_STATUS_PREFIX'" >&2; exit 64 ;; esac
# CI_NIGHTLY=1 (the nightly, from ci-runner.sh): every context of this run is under nightly-ci/ (ci_ns), never local-ci/*
case "${CI_NIGHTLY:-}" in '' | 1) ;; *) echo "ci-local: CI_NIGHTLY is 1 or empty, not '$CI_NIGHTLY'" >&2; exit 64 ;; esac
# CI_HOSTILE=1 (the hostile nightly): under hostile-ci/ instead, with the conditions of scripts/ci-local/hostile.sh
case "${CI_HOSTILE:-}" in '' | 1) ;; *) echo "ci-local: CI_HOSTILE is 1 or empty, not '$CI_HOSTILE'" >&2; exit 64 ;; esac
# CI_REMOTE_JOBS: the jobs another machine of the run posts (phase B: image on Titan, docs/CI-MACHINES.md). They are left out
# here: not run, nothing posted, so this run never answers a context the other machine owns. The rest is a default run: its
# skips are planned as before (a --jobs list would turn them off). If that machine does not answer, ci-runner.sh fallback takes
# the job over in a run of its own.
for _j in $(printf '%s' "${CI_REMOTE_JOBS:-}" | tr ',' ' '); do
  case "$_j" in check | mod | browser | image | desktop | mobile) ;;
    *) echo "ci-local: CI_REMOTE_JOBS holds the six jobs only, not '$_j'" >&2; exit 64 ;; esac
done
# CI_FALLBACK_NOTES: why this run answers a job for another machine (ci-runner.sh fallback), "job=note;job=note" with notes like
# "titan did not answer"; each one ends that job's final status as " (fallback: <note>)".
if [ -n "${CI_FALLBACK_NOTES:-}" ] && ! printf '%s' "$CI_FALLBACK_NOTES" | grep -Eqx '[a-z0-9-]+=[a-z0-9 -]+(;[a-z0-9-]+=[a-z0-9 -]+)*'; then
  echo "ci-local: CI_FALLBACK_NOTES is job=note pairs joined by ;, not '$CI_FALLBACK_NOTES'" >&2; exit 64
fi
# CI_SHARD_TOOLS: the tools of the machine that runs each bridge shard, from the plan ("tmux|": shard 1's machine has tmux), so
# every machine deals the same piles (test-parallel.ts --pile-tools; docs/CI-MACHINES.md, "Tools a test file needs").
case "${CI_SHARD_TOOLS:-}" in *[!a-z,\|]*) echo "ci-local: CI_SHARD_TOOLS is tool lists joined by |, not '$CI_SHARD_TOOLS'" >&2; exit 64 ;; esac
# On the owner's own Mac (Delphi, CI_OWNER_MACHINE=1 in its runner's .env) the run refuses, before its slot and before any status,
# unless the wall around the live Talos is there (docs/CI-MACHINES.md, "Delphi: never touch the live Talos"): the runner's user is
# not an admin, cannot list the owner's home (CI_LIVE_HOME, default /Users/$CI_LIVE_OWNER) or the owner's tmux folder
# (CI_LIVE_TMUX, default /private/tmp/tmux-<owner's uid>), has no claude or chronos on PATH, and is not inside tmux. A check
# that the setup is right, not a second wall: the separate user is the wall.
ci_owner_preflight() {
  local owner="${CI_LIVE_OWNER:-}" home tmux
  local uid rc
  [ -n "$owner" ] || { echo "CI_LIVE_OWNER is not set, so the owner's folders cannot be checked"; return 1; }
  uid="$(id -u "$owner" 2>/dev/null)" || { echo "there is no user $owner on this machine, so nothing could be checked"; return 1; }
  home="${CI_LIVE_HOME:-/Users/$owner}"
  [ -d "$home" ] || { echo "no home at $home for $owner, so nothing could be checked"; return 1; }
  tmux="${CI_LIVE_TMUX:-/private/tmp/tmux-$uid}"
  dseditgroup -o checkmember -m "$(id -un)" admin >/dev/null 2>&1
  rc=$?
  case "$rc" in
    0) echo "this user is in the admin group"; return 1 ;;
    67) ;; # not a member
    *) echo "could not check admin membership (dseditgroup exit $rc)"; return 1 ;;
  esac
  if ls "$home" >/dev/null 2>&1; then echo "the owner's home ($home) can be listed"; return 1; fi
  for f in "$home/.config/talos" "$home/Library/Application Support/Talos" "$home/.claude"; do
    if ls "$f" >/dev/null 2>&1; then echo "the owner's $f can be read"; return 1; fi
  done
  if ls "$tmux" >/dev/null 2>&1; then echo "the owner's tmux folder ($tmux) can be listed"; return 1; fi
  for f in claude chronos; do if command -v "$f" >/dev/null 2>&1; then echo "$f is on PATH ($(command -v "$f"))"; return 1; fi; done
  if [ -n "${TMUX:-}" ]; then echo "TMUX is set: this run is inside a tmux session"; return 1; fi
}
if [ "${CI_OWNER_MACHINE:-0}" = 1 ]; then
  _why="$(ci_owner_preflight)" || { echo "ci-local: refusing on the owner's machine: $_why" >&2; exit 1; }
fi
if [ "$PREFLIGHT" = 1 ]; then
  if [ "${CI_OWNER_MACHINE:-0}" = 1 ]; then echo "ci-local: the owner's machine: the wall is there"; else echo "ci-local: not the owner's machine; nothing to check"; fi
  exit 0
fi
case "$JOBS" in */*) echo "ci-local: a job name has no slash: '$JOBS'" >&2; exit 64 ;; esac
case "${CI_PART_WAIT:-120}" in '' | *[!0-9]*) echo "ci-local: CI_PART_WAIT is whole seconds" >&2; exit 64 ;; esac
case "${CI_PART_POLL:-30}" in '' | .* | *.*.* | *[!0-9.]*) echo "ci-local: CI_PART_POLL is seconds" >&2; exit 64 ;; esac
for _v in CI_PART_BEAT CI_PART_BEAT_STALE CI_PART_LOCK_WAIT_MAX; do # a part queued for a lock (jobs-check.sh, part_lockwait)
  case "${!_v:-0}" in *[!0-9]*) echo "ci-local: $_v is whole seconds" >&2; exit 64 ;; esac
done
# a status a beat, and GitHub keeps 1,000 for a context of a commit: never faster than every 10 s, from anywhere (a runner's .env, the
# workflow, a variable); the tests' own seam is a function of the script's copy, never a knob (jobs-check.sh, part_beat_secs)
[ "$((10#${CI_PART_BEAT:-30}))" -ge 10 ] && [ "$((10#${CI_PART_BEAT_STALE:-1}))" -ge 1 ] ||
  { echo "ci-local: CI_PART_BEAT is 10 seconds or more, CI_PART_BEAT_STALE 1 or more" >&2; exit 64; }
# CI_REMOTE_PARTS: the parts of check another machine runs, "<part>:<machine> ..." (the plan's gating parts; a part in shadow is
# not listed, so it runs here too). Machine names are the workflow job names, read from the jobs API.
for _p in ${CI_REMOTE_PARTS:-}; do
  case "${_p%%:*}:${_p#*:}" in
    bridge-shard-1:* | bridge-shard-2:* | vitest:*) ;;
    *) echo "ci-local: CI_REMOTE_PARTS: '$_p' is not <bridge-shard-1|bridge-shard-2|vitest>:<machine>" >&2; exit 64 ;;
  esac
  case "${_p#*:}" in '' | *[!a-z0-9-]* | "$_p") echo "ci-local: CI_REMOTE_PARTS: '$_p' names no machine" >&2; exit 64 ;; esac
  case " ${_seen:-} " in *" ${_p%%:*} "*) echo "ci-local: CI_REMOTE_PARTS lists ${_p%%:*} twice" >&2; exit 64 ;; esac
  _seen="${_seen:-} ${_p%%:*}"
done
if [ "${CI_STATUS_PREFIX:-local-ci}" = local-ci ]; then
  for _j in $(printf '%s' "$JOBS" | tr ',' ' '); do
    case "$_j" in bridge-shard-1 | bridge-shard-2 | vitest | linux | stock-mac | browser-e2e)
      echo "ci-local: $_j cannot post under local-ci/: run it with CI_STATUS_PREFIX=ci-part (a part of check) or report-ci" >&2
      exit 64 ;;
    esac
  done
fi
if [ "$REAP" = 1 ]; then ci_reap_dead_runs "$CI_RUNS" "$LOCKS"; echo "ci-local: nothing left by dead runs"; exit 0; fi

resolve() { # the commit to test: what the PR's head (or the ref) points at now
  if [ -n "$PR" ]; then
    # Into a ref of our own, never FETCH_HEAD: runs in other slots fetch into this same checkout at the same time.
    local ref="refs/talos-ci/run-$CI_NONCE" sha
    ci_git_net fetch -q --no-write-fetch-head origin "+refs/pull/$PR/head:$ref" || return 1
    sha="$(git rev-parse --verify "$ref^{commit}")"
    git update-ref -d "$ref"
    [ -n "$sha" ] && echo "$sha"
  else
    git rev-parse --verify "${REF:-HEAD}^{commit}" 2>/dev/null || git rev-parse --verify "origin/$REF^{commit}"
  fi
}
cant_resolve() { if [ -n "$PR" ]; then echo "ci-local: cannot fetch PR $PR" >&2; else echo "ci-local: unknown ref $REF" >&2; fi; }

cd "$ROOT"
ci_git_net fetch -q origin || true
SHA="$(resolve)" || { cant_resolve; exit 1; }
pinned() { # --sha: the plan fixed the commit for every machine; a PR or ref that points elsewhere now has a newer run of its own
  local what="${REF:-HEAD}"
  [ -z "$PIN_SHA" ] || [ "$1" = "$PIN_SHA" ] && return 0
  [ -z "$PR" ] || what="PR $PR"
  echo "ci-local: $what is now ${1:0:7}, not the planned ${PIN_SHA:0:7}; a newer run tests it. Nothing tested, nothing posted."
  exit 0
}
pinned "$SHA"
SLUG="${CI_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)}"
[ -z "$SLUG" ] && STATUS=0
WHERE="$(ci_where)" # what a status says it ran on: the machine's own name (CI_STATUS_WHERE overrides it)
# These are for this script only. Left exported they reach every job: the test suites run ci-local.sh copies of their own (a fake
# repo, a fake gh) and would post to the real repository's commit, write the real CI_SHA_FILE and say "ci-runner". Like TALOS_CI_CACHE
# above they stay readable here and in the subshells, and no child process gets them.
export -n CI_REPO CI_STATUS_WHERE CI_STATUS_URL CI_SHA_FILE CI_WT_BASE CI_SLEEP_GUARD TALOS_CI_FORCE_DESKTOP CI_ATTEMPT_URL CI_STATUS_PREFIX CI_REMOTE_JOBS CI_SHARD_TOOLS CI_FALLBACK_NOTES CI_BROWSER_E2E_PART CI_BROWSER_E2E_WAIT CI_PART_E2E_WORKERS CI_BROWSER_E2E_SHADOW CI_CHECK_PART CI_CHECK_WAIT CI_NIGHTLY CI_HOSTILE CI_SETTLE CI_PUSHED_AT CI_MOD_REAL CI_TITAN_PART
case "${CI_RUN_ID:-}" in *[!0-9]*) echo "ci-local: CI_RUN_ID is a run number, not '$CI_RUN_ID'" >&2; exit 64 ;; esac
# CI_BROWSER_E2E_PART=<machine> (CI_TITAN_BROWSER=e2e, docs/CI-MACHINES.md, "The e2e packages on Titan"): every e2e package but
# the web one runs on that machine as ci-part/browser-e2e, so this run's browser job runs protocol and web only and folds that
# part in, the way check folds its parts: its green or red is browser's; no answer by CI_BROWSER_E2E_WAIT seconds after this
# run's own suites end (or its job ended without one, or it refused) and those packages run here after all. The wait has no
# default: without it, or without a way to read the part, every package runs here, as today. The attempt link must be one whole
# attempt of this run ("<...>/runs/<CI_RUN_ID>/attempts/<n>#"): the part's rows are matched by prefix, and a shorter link would
# take another attempt's green.
case "${CI_BROWSER_E2E_PART:-}" in *[!a-z0-9-]*) echo "ci-local: CI_BROWSER_E2E_PART is a machine (its workflow job name), not '$CI_BROWSER_E2E_PART'" >&2; exit 64 ;; esac
case "${CI_BROWSER_E2E_WAIT:-}" in *[!0-9]*) echo "ci-local: CI_BROWSER_E2E_WAIT is whole seconds" >&2; exit 64 ;; esac
case "${CI_PART_E2E_WORKERS:-}" in *[!0-9]* | 0) echo "ci-local: CI_PART_E2E_WORKERS is a whole number >= 1" >&2; exit 64 ;; esac
if [ -n "${CI_BROWSER_E2E_PART:-}" ] && { [ "$STATUS" != 1 ] || [ -z "${CI_RUN_ID:-}" ] || [ -z "${CI_BROWSER_E2E_WAIT:-}" ] ||
  ! printf '%s' "${CI_ATTEMPT_URL:-}" | grep -Eqx "https?://[^[:space:]]+/runs/${CI_RUN_ID}/attempts/[0-9]+#"; }; then
  echo "ci-local: CI_BROWSER_E2E_PART given, but no CI_BROWSER_E2E_WAIT or no way to read the part; browser runs every e2e package here"
  CI_BROWSER_E2E_PART=""
fi
# CI_CHECK_PART=<machine> (CI_TITAN_CHECK=on, docs/CI-MACHINES.md, "check on Titan"): that machine runs check as ci-part/check;
# this run's check runs the macOS-only tests and folds the part, taking check back (today's) when it gives no answer
# CI_CHECK_WAIT seconds after the other jobs end (job_check). The same rules as the e2e part's: no wait, or no way to read
# it, and check runs here as today.
case "${CI_CHECK_PART:-}" in *[!a-z0-9-]*) echo "ci-local: CI_CHECK_PART is a machine (its workflow job name), not '$CI_CHECK_PART'" >&2; exit 64 ;; esac
case "${CI_CHECK_WAIT:-}" in *[!0-9]*) echo "ci-local: CI_CHECK_WAIT is whole seconds" >&2; exit 64 ;; esac
if [ -n "${CI_CHECK_PART:-}" ] && { [ "$STATUS" != 1 ] || [ -z "${CI_RUN_ID:-}" ] || [ -z "${CI_CHECK_WAIT:-}" ] ||
  [ "${CI_STATUS_PREFIX:-local-ci}" != local-ci ] ||
  ! printf '%s' "${CI_ATTEMPT_URL:-}" | grep -Eqx "https?://[^[:space:]]+/runs/${CI_RUN_ID}/attempts/[0-9]+#"; }; then
  echo "ci-local: CI_CHECK_PART given, but no CI_CHECK_WAIT or no way to read the part; check runs here"
  CI_CHECK_PART=""
fi

# The settle step (scripts/ci-local/settle.sh): a push run of main (ci-runner.sh sets CI_SETTLE=1 for that run alone) waits here, before
# a slot, a record or a job, for main's head to stay the same; a head that is no longer this run's sha is a newer push's to test.
# Never the nightly or the hostile nightly, whatever sets it.
if [ "${CI_SETTLE:-}" = 1 ] && [ -z "${CI_NIGHTLY:-}${CI_HOSTILE:-}" ]; then
  ci_settle_check || exit 64
  CI_SETTLE_NEWER=""
  ci_settle "$CACHE/settle-chain" "$SHA"
  if [ $? = 10 ]; then
    # the mark first: unmarked, the skip would look like "untested and fine", so a mark that GitHub will not take means a run
    if [ "$STATUS" != 1 ] || ci_post_status "$SLUG" "$SHA" report-ci/superseded success "not tested: superseded by ${CI_SETTLE_NEWER:0:7}; CI tests main's newest commit" "${CI_STATUS_URL:-}"; then
      echo "ci-local: settle: ${SHA:0:7} is superseded by ${CI_SETTLE_NEWER:0:7}; that run tests it. Nothing tested here."
      [ -z "${CI_SHA_FILE:-}" ] || printf '%s\n' "$CI_SETTLE_NEWER" > "$CI_SHA_FILE.superseded" # for the workflow's later steps (ci-runner.sh settled)
      exit 0
    fi
    echo "ci-local: settle: ${SHA:0:7} could not be marked superseded on GitHub; testing it"
  fi
fi
# A part machine of an attempt whose Lemnos run stood aside (it started with Lemnos, before the decision): nothing to test, nothing to post.
# (One that is already working is cancelled by the workflow, and posts no pass or failure meanwhile: ci_post_status.)
if [ "$STATUS" = 1 ] && [ -n "${CI_ATTEMPT_URL:-}" ] && ci_stood_aside "$SLUG" "$SHA"; then
  echo "ci-local: settle: this attempt stood aside for a newer push (report-ci/superseded on ${SHA:0:7}); nothing tested, nothing posted here"
  exit 0
fi

POSTFAIL=()
post() { # post <job> <state> <description>
  [ "$STATUS" = 1 ] || return 0
  # report() sets _ci_held (its own local) when the owning machine answered this job in this attempt: that answer stands
  [ "${_ci_held:-}" != 1 ] || { echo "ci-local: $1: answered first elsewhere in this attempt; $2 not posted"; return 0; }
  # It says why on stderr. A post that failed (after its one retry for a transport error) is loud: ::error:: now, a nonzero exit at
  # the end (POSTFAIL), never a green run with a context unposted. The run goes on, so the other jobs still report.
  ci_post_status "$SLUG" "$SHA" "$1" "$2" "$3" "${CI_STATUS_URL:-}" || {
    echo "::error::ci-local: status not posted: $(ci_context "$1") (${CI_POST_WHY:-gh failed}); this run cannot end green"
    POSTFAIL+=("$(ci_context "$1")")
  }
}

WT="" CONTAINER="" SLOT_TMP="" RUN_DIR="" WATCHDOG="" RESDIR=""
cleanup() {
  [ -z "$WATCHDOG" ] || kill -KILL "$WATCHDOG" 2>/dev/null # the watchdog ignores INT and TERM, see watch_run
  cd / # this shell's own working directory is the worktree
  # Stops every job that is still going and anything left in the worktree, answers any status still pending, removes the
  # worktree and temp dir (unless --keep), and deletes the record.
  [ -z "$RUN_DIR" ] || ci_end_run "$RUN_DIR" "$LOCKS" own
  if [ -n "$WT" ] && [ "$KEEP" = 0 ]; then git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "${WT:?}"; fi
  # With a record, ci_end_run removed the slot's temp dir before it let go of the slot. Doing it again here, after the slot is free,
  # could wipe the live temp dir of the next run that took the slot. Only a run that never made a record has it left.
  [ -z "$SLOT_TMP" ] || [ -n "$RUN_DIR" ] || { chmod -R u+w "${SLOT_TMP:?}" 2>/dev/null; rm -rf "${SLOT_TMP:?}"; }
  # Locks a job took inside its subshell (a mutex) are not in CI_HELD; they are ours all the same, and a cancelled run must not
  # leave one held. Nothing may still be running by now, so this is after the jobs are stopped.
  ci_release_owned "$LOCKS" "$(ci_me)"
  ci_release_all
}
trap cleanup EXIT
# INT or TERM is a stop from outside (a cancel, a job timeout, a stopped runner): the record says so, and what it never answered
# is closed as an error that says "not tested:" (ci_settle_list), which no verdict reads as red or green. A run killed outright gets no trap, and its watchdog or the sweep closes it as error.
trap '[ -z "$RUN_DIR" ] || { : > "$RUN_DIR/cancelled"; } 2>/dev/null; exit 130' INT TERM

ci_reap_dead_runs "$CI_RUNS" "$LOCKS" # whatever a run killed outright left behind, before this one asks for a slot
T_ASKED=$(date +%s)
ci_acquire_slot "$LOCKS" "${SHA:0:7}${PR:+ PR $PR}" || exit 1
wait_cut_unless "$LOCKS/slot-${CI_SLOT:-none}" "a free slot" # a wait that was cut off falls through to here, with no slot (jobs-check.sh)
export TALOS_CI_NESTED=1

# The run may have queued for a long time: test what the PR (or ref) points at now, and post statuses only for that.
ci_git_net fetch -q origin || true
NOW="$(resolve)" || { cant_resolve; exit 1; }
pinned "$NOW"
if [ "$NOW" != "$SHA" ]; then
  echo "ci-local: ${PR:+PR $PR }head moved while queued (${SHA:0:7} -> ${NOW:0:7}); testing ${NOW:0:7}"
  SHA="$NOW"
  printf '%s\n' "${SHA:0:7}${PR:+ PR $PR}" > "$LOCKS/slot-$CI_SLOT/what"
fi
SHORT="${SHA:0:7}"
[ -z "${CI_SHA_FILE:-}" ] || printf '%s\n' "$SHA" > "$CI_SHA_FILE" # the commit actually tested: whoever sweeps after a cancel needs it

# One run per commit at a time, whatever each one asked for. Two runs of one commit (queued for A, a push, queued for B) used to
# test B together; the later result won on GitHub, so a failure could turn green with no retry anyone asked for, and both
# truncated one log. A run that had to wait takes over the first one's result for each job it also ran, as long as both were
# asked to run the same way: --latest, --full, posting or not, a forced desktop job and GUI tests all change what a green means,
# and so does the status prefix: a report-ci or ci-part run's result is never a local-ci answer (it posted no local-ci status).
# Every other job it tests itself, without touching what the first one posted. If the first died, there is nothing to reuse.
# A run that finds no one ahead always tests fresh.
ci_flag() { case "$(printf '%s' "${1:-0}" | tr '[:upper:]' '[:lower:]')" in 1 | true | yes | on) echo 1 ;; *) echo 0 ;; esac; }
# --full too: a check without it leaves out the kit suites inside a rendered agent folder (step_vitest), so it does not answer one.
SETTINGS="$(ci_owner_key "$LATEST $STATUS $FULL $(ci_flag "${TALOS_CI_FORCE_DESKTOP:-0}") $(ci_flag "${TALOS_GUI_TESTS:-0}") ${CI_STATUS_PREFIX:-local-ci}${CI_NIGHTLY:+ nightly}${CI_HOSTILE:+ hostile}${CI_BROWSER_E2E_PART:+ e2e-part $CI_ATTEMPT_URL}${CI_CHECK_PART:+ check-part $CI_ATTEMPT_URL}")"
SHALOCK="$LOCKS/sha-$SHA" RESDIR="$CACHE/results/$SHA-$SETTINGS"
mkdir -p "$CACHE/results" && find "$CACHE/results" -mindepth 1 -maxdepth 1 -mtime +1 -exec rm -rf {} + 2>/dev/null
WAITED=0 SHADEADLINE=$(($(date +%s) + CI_LOCK_TIMEOUT))
until ci_lock_try "$SHALOCK" "slot $CI_SLOT"; do
  [ "$WAITED" = 1 ] || echo "ci-local: $SHORT is already being tested ($(cat "$SHALOCK/what" 2>/dev/null)); waiting for that result"
  WAITED=1
  [ "$(date +%s)" -lt "$SHADEADLINE" ] || { echo "ci-local: timed out waiting for the run testing $SHORT" >&2; exit 1; }
  sleep "$CI_POLL"
done
wait_cut_unless "$SHALOCK" "the run testing $SHORT" # the same, with the commit's lock not had
IFS=',' read -r -a WANT <<< "$JOBS"
if [ -n "${CI_REMOTE_JOBS:-}" ]; then
  _keep=()
  for j in "${WANT[@]}"; do
    case ",$CI_REMOTE_JOBS," in *",$j,"*) echo "ci-local: $j runs on another machine of this run (CI_REMOTE_JOBS); not run or posted here" ;; *) _keep+=("$j") ;; esac
  done
  [ ${#_keep[@]} -gt 0 ] || { echo "ci-local: every job of this run runs on another machine; nothing to do here"; exit 0; }
  WANT=("${_keep[@]}")
fi
BAD_BEFORE=""
if [ "$WAITED" = 1 ]; then
  LEFT=()
  for j in "${WANT[@]}"; do
    case "$(cat "$RESDIR/$j" 2>/dev/null)" in
      '' | refused) LEFT+=("$j") ;; # not tested there (a refusal is no answer)
      skip) [ "$FULL" = 0 ] || LEFT+=("$j") ;; # --full skips nothing, so a skipped job is not an answer to it
      0) ;;
      *) case " $BAD_BEFORE " in *" $j "*) ;; *) BAD_BEFORE="${BAD_BEFORE:+$BAD_BEFORE }$j" ;; esac ;;
    esac
  done
  if [ ${#LEFT[@]} -eq 0 ]; then
    [ -z "$BAD_BEFORE" ] && { echo "ci-local: all green ($SHORT): the run that tested it first passed; statuses are already posted"; exit 0; }
    echo "ci-local: FAILED ($SHORT): the run that tested it first failed ($BAD_BEFORE); statuses are already posted"
    exit 1
  fi
  [ ${#LEFT[@]} -eq ${#WANT[@]} ] || echo "ci-local: taking the first run's result for the jobs it tested; testing ${LEFT[*]}"
  WANT=("${LEFT[@]}")
else
  rm -rf "$RESDIR"
fi
mkdir -p "$RESDIR"

# A job none of whose inputs changed since that job last passed is not run. scripts/ci-affected.sh compares the commit, per job,
# with the last commit where THAT job passed (not just its parent: the inner commits of a push get no status; and whatever main's
# overall colour), and names the jobs the difference can reach. The rest are answered at once as success, "skipped: no <job>
# inputs changed since <sha>", which ci_classify (ci-runner.sh) reads as no failure and never as a pass. Only a run that runs
# every job by default and posts its answers does this: --jobs names exactly what to run, --full (every dispatch, and the
# nightly) runs all, and a run that posts nothing has nowhere to say a job was skipped. A run with TALOS_GUI_TESTS or
# TALOS_CI_FORCE_DESKTOP set, and a rerun of a commit that already has statuses, run every job. Anything unsure (no pass of that
# job in reach, GitHub unreadable, the script missing, an unknown path) runs the job. SKIP_WHYS[i] is the `why` of SKIP_JOBS[i].
SKIP_JOBS=() SKIP_WHYS=() KIT_SKIP=0 FAST_BASE=""
plan_skips() {
  local out affected j b keep=() skip=() whys=() f attempt
  [ "$FULL" = 0 ] && [ "$JOBS_SET" = 0 ] && [ "$STATUS" = 1 ] && [ -f "$ROOT/scripts/ci-affected.sh" ] || return 0
  # The GUI desktop tests read apps/web (the companion harness and the theme tokens), so a run that asks for them, or forces
  # the desktop job, skips nothing.
  [ "$(ci_flag "${TALOS_GUI_TESTS:-0}")" = 0 ] && [ "$(ci_flag "${TALOS_CI_FORCE_DESKTOP:-0}")" = 0 ] || return 0
  # Up to 30 sequential gh calls while this run holds a slot: a hung one is stopped after CI_PLAN_LIMIT (120 s) and every job runs.
  # Into a file, not a pipe: a gh left running by the stop would hold a pipe open, and the substitution would wait for it.
  f="$(mktemp)" || return 0
  # This attempt's own statuses are not an earlier run (ci-affected.sh, earlier_rows). CI_ATTEMPT_URL (not exported, see
  # export -n) is set only with a part on Delphi or Cyclops, or image on Titan (on); another machine of the run (Hestia alone,
  # a shadow Titan) also posts under the
  # attempt's link, so on the runner the link is made from GitHub's run variables when it is not set. Lemnos's own statuses
  # then link to the run itself, which never starts with an attempt's link, so with every switch off nothing changes.
  attempt="${CI_ATTEMPT_URL:-}"
  if [ -z "$attempt" ] && [ -n "${GITHUB_RUN_ID:-}" ] && [ -n "${GITHUB_RUN_ATTEMPT:-}" ]; then
    attempt="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-$SLUG}/actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT#"
  fi
  ci_with_limit "${CI_PLAN_LIMIT:-120}" env CI_ATTEMPT_URL="$attempt" bash "$ROOT/scripts/ci-affected.sh" plan "$SLUG" "$SHA" > "$f" 2>/dev/null || : > "$f"
  out="$(cat "$f")"
  rm -f "$f"
  affected="$(printf '%s\n' "$out" | sed -n 1p)"
  case " $affected " in *" check "*) ;; *) echo "ci-local: could not tell which jobs the change affects; running every job"; return 0 ;; esac
  echo "ci-local: $(printf '%s\n' "$out" | sed -n 2p)"
  # The install and kit tests in the check job: left out only on an explicit skip, compared with check's own last pass.
  FAST_BASE="$(printf '%s\n' "$out" | awk '$1 == "base" && $2 == "check" { print $3 }')" # report-ci/fast: --changed from here
  if [ "$(printf '%s\n' "$out" | sed -n 3p)" = "kit-tests: skip" ]; then
    KIT_SKIP=1
    echo "ci-local: install and kit tests skipped: nothing they run changed"
  fi
  # A job skips only on its own "skip <job> <sha>" line: missing from line 1 without one, it runs.
  for j in "${WANT[@]}"; do
    b="$(printf '%s\n' "$out" | awk -v j="$j" '$1 == "skip" && $2 == j { print $3 }')"
    case " $affected " in
      *" $j "*) keep+=("$j") ;;
      *) if [ -n "$b" ]; then skip+=("$j"); whys+=("no $j inputs changed since ${b:0:7}"); else keep+=("$j"); fi ;;
    esac
  done
  [ ${#keep[@]} -gt 0 ] || return 0 # nothing left to run (the first run of this commit did it): leave the list alone
  WANT=("${keep[@]}")
  SKIP_JOBS=(${skip[@]+"${skip[@]}"})
  SKIP_WHYS=(${whys[@]+"${whys[@]}"})
}
plan_skips; reuse_prepare # (jobs-check.sh: reuse_gate_step answers a step from the gate only for the first run of a commit here)

# The fast lane (job_fast): a run that tests check and posts its answers also posts report-ci/fast, about 3 minutes in. Not check
# as a part (ci-part/, report-ci/: Titan's check-titan): the run that owns check posts the fast lane, once.
if [ "$STATUS" = 1 ] && [ "${CI_STATUS_PREFIX:-local-ci}" = local-ci ]; then for j in "${WANT[@]}"; do [ "$j" != check ] || { WANT+=(fast); break; }; done; fi # (wants is defined later)

T_SLOT=$(date +%s)
# the hostile nightly: its temp folder (CI_TMP_BASE) and the other conditions, said here and kept for the report
if [ "${CI_HOSTILE:-}" = 1 ]; then . "$CI_LOCAL_LIB/hostile.sh" && ci_hostile_setup "$CACHE" "$SHORT" || exit 1; fi
ci_slot_env "$CI_SLOT"
{ chmod -R u+w "${SLOT_TMP:?}" 2>/dev/null; rm -rf "${SLOT_TMP:?}"; } && mkdir -p "$SLOT_TMP" || exit 1 # anything here was left by a run that died in this slot
export PW_PORT="$SLOT_PW_PORT" TMPDIR="$SLOT_TMP"
export TALOS_CI_SLOT_RUN=1 # beside PW_PORT: apps/web/playwright.config.ts accepts a slot port only with this
unset TALOS_CI_PW_PORT TALOS_CI_IMAGE_PORT # same reason as TALOS_CI_CACHE: used, and gone before any test sees them

# This run's record and results. They are per run, not per slot: nothing that outlives this run can write into the next one's.
RUN_DIR="$CI_RUNS/$CI_NONCE"
mkdir -p "$RUN_DIR" || exit 1
WT="$(mktemp -d "$WT_BASE/talos-ci-$SHORT.XXXX")" && [ -n "$WT" ] || { echo "ci-local: cannot make a scratch worktree under '$WT_BASE'" >&2; WT=""; exit 1; }
# The record says everything needed to clean up after this run, so the watchdog, a waiter and the next run can do it without us.
printf '%s\n' "$WT" > "$RUN_DIR/worktree"
ci_me > "$RUN_DIR/owner"
printf '%s\n' "$ROOT" > "$RUN_DIR/repo"
printf '%s\n' "$SLOT_TMP" > "$RUN_DIR/tmp"
[ "$KEEP" = 0 ] || : > "$RUN_DIR/keep"
git worktree add -q --detach "$WT" "$SHA" || exit 1

# If this shell is killed outright, no cleanup runs and jobs in groups of their own would carry on. So the watchdog, in a group of
# its own, does the cleanup instead. `kill -9` of the run, or of its process group, doesn't reach it.
# It ignores INT and TERM: a runner cancelling a job signals the step's own process (INT, then TERM, then KILL), and at the end of the
# job it kills whatever still carries the job's tracking id; the watchdog is the one that must outlive both signals. When the run is gone it does all the run's own cleanup would have: stops the jobs, answers pending statuses, removes the
# worktree and temp dir, and lets go of the run's locks (the slot, the commit, any mutex a job held).
watch_run() {
  trap '' INT TERM HUP
  while kill -0 "$1" 2>/dev/null; do sleep 1; done
  ci_end_run "$RUN_DIR" "$LOCKS" own
}
set -m
( cd / && watch_run "$$" ) </dev/null >/dev/null 2>&1 &
WATCHDOG=$!
set +m

# A shard part for a commit whose bridge runner has no --shard (older than the split): nothing to run here, nothing posted. The
# machine that runs check runs every rest file itself then (CI-MACHINES.md, "A commit older than --shard").
_keep=()
for j in "${WANT[@]}"; do
  case "$j" in
    bridge-shard-*) if ! grep -q -- '--shard' "$WT/apps/bridge/scripts/test-parallel.ts" 2>/dev/null; then
        echo "ci-local: $j: this commit's bridge runner has no --shard; nothing to run here"; continue
      fi ;;
  esac
  _keep+=("$j")
done
[ ${#_keep[@]} -gt 0 ] || { echo "ci-local: nothing left to run"; exit 0; }
WANT=("${_keep[@]}")
# Never post pending over a final status of this attempt: a context another machine of it already answered is not run here.
if [ "$STATUS" = 1 ] && [ -n "${CI_ATTEMPT_URL:-}" ]; then
  _keep=()
  for j in "${WANT[@]}"; do
    # the rows first, then the filter: a filter that stops early must not fail a pipe and lose the answer
    if _rows="$(ci_attempt_rows "$SLUG" "$SHA" "$(ci_context "$j")" "$CI_ATTEMPT_URL")"; then
      _final="$(printf '%s\n' "$_rows" | ci_attempt_final)"
    else _final=""; fi # unknown: run it
    if [ -n "$_final" ]; then echo "ci-local: $j: answered in this attempt ($_final); not run here"; else _keep+=("$j"); fi
  done
  [ ${#_keep[@]} -gt 0 ] || { echo "ci-local: every job of this run was answered in this attempt; nothing to do"; exit 0; }
  WANT=("${_keep[@]}")
fi
if [ "$STATUS" = 1 ]; then # written before the first post: whoever ends this run owes an answer for each of these
  # The context goes in the record: a run that ends this one (the watchdog, the next run's reaper) has another prefix of its own.
  # Readable by an older ci-local.sh too (runs of both share the cache): three header fields, and in `posted` only the bare job
  # whose context is the one a bare name always meant (local-ci/<job>, report-ci/fast). Any other context (ci-part/<part>,
  # report-ci/<job>) goes in `posted-contexts`, which an older ci-local.sh never opens: it reads every row of `posted` as a bare
  # job and would close ci-part/vitest as local-ci/ci-part/vitest, an extra local-ci/* status that makes the verdict red. The
  # attempt goes in a file of its own.
  printf '%s\n' "${CI_ATTEMPT_URL:-}" > "$RUN_DIR/attempt"
  _bare="" _own=""
  for j in "${WANT[@]}"; do
    _c="$(ci_context "$j")"
    if [ "$_c" = "$(CI_STATUS_PREFIX='' CI_NIGHTLY='' CI_HOSTILE='' ci_context "$j")" ]; then _bare="$_bare$SHA"$'\t'"$j"$'\n'; else _own="$_own$SHA"$'\t'"$_c"$'\n'; fi
  done
  _head="$(printf '%s\t%s\t%s' "$SLUG" "$WHERE" "${CI_STATUS_URL:-}")"
  [ -z "$_own" ] || printf '%s\n%s' "$_head" "$_own" > "$RUN_DIR/posted-contexts"
  [ -z "$_bare" ] || printf '%s\n%s' "$_head" "$_bare" > "$RUN_DIR/posted"
fi
for j in "${WANT[@]}"; do post "$j" pending "running on $WHERE"; done

run() { # run <log> <cmd...>: echo the step, append its output to the log, then how long it took
  local log="$1" t rc; shift
  kill -0 "$$" 2>/dev/null || return 1 # the run is gone (in a job, $$ is the run's shell): no more steps
  echo "+ $*" >> "$log"
  t=$(date +%s)
  "$@" >> "$log" 2>&1
  rc=$?
  echo "[step] $(($(date +%s) - t))s exit $rc: $*" >> "$log"
  return $rc
}

warn_step() { # warn_step <job> <log> <what it means> <cmd...>: a step that warns. A failure reaches the log and the job's result
  # line and status (report), and the job goes on.
  local j="$1" log="$2" what="$3" rc=0; shift 3
  run "$log" "$@" || rc=$?
  [ "$rc" = 0 ] || echo "warning: $what (exit $rc: $*)" | tee -a "$log" >> "$RESULTS/$j.warn"
  return 0
}

together() { # together <log> <fn...>: the steps side by side, each into its own file, added to the log whole when all end.
  # Steps that failed go last, so the reason is in the tail a failed job prints.
  local log="$1" f p pairs="" ok="" bad=""; shift
  for f in "$@"; do
    run "$log.$f" "$f" &
    pairs="$pairs $f:$!"
  done
  for p in $pairs; do
    if wait "${p##*:}"; then ok="$ok ${p%%:*}"; else bad="$bad ${p%%:*}"; fi
  done
  for f in $ok $bad; do cat "$log.$f" >> "$log"; rm -f "$log.$f"; done
  [ -z "$bad" ]
}

wants() { # wants <job...>: 0 if this run has any of them
  local a b
  for a in "$@"; do for b in "${WANT[@]}"; do [ "$a" = "$b" ] && return 0; done; done
  return 1
}

# Once per run, before the jobs: they all use one node_modules and one apps/web/dist + apps/relay/dist, and two jobs must
# not install or build into them at the same time. So the browser job's suites are told not to build (SKIP_BUILD,
# E2E_SKIP_BUILD; the bundles are the ones `pnpm build` made, byte for byte).
# A rerun of the same commit (a dispatch, a hand run) writes the same log names: the earlier log is moved to logs/prev/ first, as
# <short>-<job>.<when it was moved>.log, so it is not lost; the latest keeps its name, which is what everything else reads.
# logs/prev/ is outside the <short>-*.log names, so a red run's upload carries only the latest.
keep_prev_log() { # keep_prev_log <log>
  [ -s "$1" ] || return 0
  local base dest n=0
  base="$(basename "$1" .log).$(date +%Y%m%dT%H%M%S)"
  mkdir -p "$LOGS/prev"
  dest="$LOGS/prev/$base.log"
  while [ -e "$dest" ]; do n=$((n + 1)); dest="$LOGS/prev/$base-$n.log"; done
  mv "$1" "$dest"
}
SETUP_LOG="$LOGS/$SHORT-setup.log" SETUP_FAILED=""
setup_run() {
  keep_prev_log "$SETUP_LOG"
  : > "$SETUP_LOG"; for _j in "${WANT[@]}"; do rm -f "$LOGS/$SHORT-$_j.notrun"; done # a job of this run that ends before run_job shows no earlier lines
  wants check browser browser-e2e mobile bridge-shard-1 bridge-shard-2 vitest linux || return 0
  # the commit's own install and build scripts: code under test, so never the token this shell posts statuses with
  run "$SETUP_LOG" env -u GH_TOKEN -u GITHUB_TOKEN pnpm install --frozen-lockfile || { SETUP_FAILED="pnpm install"; return 1; }
  run "$SETUP_LOG" env -u GH_TOKEN -u GITHUB_TOKEN pnpm build || SETUP_FAILED="pnpm build"
}
setup_ok() { # a job's first step: a failed install or build fails every job that needed it, with the reason in its log
  [ -n "$SETUP_FAILED" ] || return 0; local l="$1"; shift # the rest: what the job could not run, for its NOT RUN lines
  { echo "setup failed: $SETUP_FAILED"; tail -40 "$SETUP_LOG"; } >> "$l"; not_run "$l" "setup failed: $SETUP_FAILED" "${@:-the steps of this job}"
  return 1
}

JOB_WAITED=0 # the seconds the job calling wait_for_job spent there, waiting (run_job keeps it apart from the job's own steps)
wait_for_job() { # wait_for_job <job> [marker]: until that job of this run has finished or left <marker>; at once if it isn't in the run
  wants "$1" || return 0
  local t=$(date +%s)
  ci_fold_wait "$RESULTS" "${CI_JOBNAME:-}" # it waits for another job, no heavy step of its own going: idle, not busy (turn.sh)
  until [ -f "$RESULTS/$1" ] || { [ -n "${2:-}" ] && [ -f "$RESULTS/$2" ]; } ||
    ! kill -0 "$(cat "$RESULTS/$1.group" 2>/dev/null)" 2>/dev/null; do sleep 1; done
  ci_fold_resume "$RESULTS" "${CI_JOBNAME:-}" "$LOCKS" # its turn begins: after any gate that holds the machine now
  JOB_WAITED=$((JOB_WAITED + $(date +%s) - t))
}

job_tmp() { # job_tmp <name>: a temp dir of the job's own inside the slot's, removed with it
  mkdir -p "$SLOT_TMP/$1" && export TMPDIR="$SLOT_TMP/$1"
}

# How many workers Vitest and the bun runner may each start: 40% of the cores (4 on this Mac). Vitest's own default is cores
# - 1, for a suite that has the machine to itself; these two now overlap. docs/CI-LOCAL.md has the measurements.
CI_CPUS="$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 8)"
CI_WORKERS="${CI_WORKERS:-$((CI_CPUS * 2 / 5 > 2 ? CI_CPUS * 2 / 5 : 2))}"
# The quiet group's bridge schedules files: one process per file, each in its own temp home with its own Chronos and no fixed port,
# and nothing else of the run is going, so a third of the cores (6 here) instead of the 40% above shared by three suites.
CI_SCHED_JOBS="${CI_SCHED_JOBS:-$((CI_CPUS / 3 > 2 ? CI_CPUS / 3 : 2))}"
CI_MEM_GB="$(ci_mem_gb)" # unreadable: 0, which ci_e2e_workers turns into 1 worker, never a guess upward

cd "$WT"
ci_bun_version() { bun --version 2>/dev/null | tr -d ' \r\n' | grep . || echo none; }
RUN_BUN="$(ci_bun_version)" # for timings.tsv: the bun this run started with
echo "ci-local: $SHORT ${PR:+(PR $PR) }slot $CI_SLOT/$CI_SLOTS, jobs: $JOBS"
ci_time_factor; setup_run # the factor first: the run's jobs read it
T_SETUP=$(date +%s)

RESULTS="$RUN_DIR/results"
mkdir -p "$RESULTS"
# check's parts on other machines: their answers can only be read with this attempt's link and a token, so without them every
# part runs here, as today
parts_poll() { # each part's state, from its ci-part/ statuses of this attempt and its machine's job
  local p m st rows jobs all ok=1
  jobs="$(gh api --paginate "repos/$SLUG/actions/runs/${CI_RUN_ID:-0}/jobs?per_page=100" --jq '.jobs[] | [.name, .status] | @tsv' 2>/dev/null)"
  all="$(ci_statuses "$SLUG" "$SHA")" || ok="" # one read for every part: polling must not spend the rate limit per part
  while read -r p m; do
    [ -n "$p" ] || continue
    rows="$(printf '%s\n' "$all" | ci_attempt_filter "$(ci_ns "ci-part/$p")" "$CI_ATTEMPT_URL")"
    if [ -z "$ok" ]; then st=gone # unreadable: take it here
    elif [ -n "$(printf '%s\n' "$rows" | ci_attempt_red)" ]; then st=fail
    elif printf '%s\n' "$rows" | awk -F'\t' '$1 == "success" { f = 1 } END { exit !f }'; then st=pass
    # its machine refused the part (a tool its pile needs is missing there: error under its own link): taken here at once,
    # whatever its job's state, and never a red or a pass (docs/CI-MACHINES.md, "Tools a test file needs")
    elif printf '%s\n' "$all" | ci_attempt_filter "$(ci_ns "ci-part/$p")" "$CI_ATTEMPT_URL" "$CI_ATTEMPT_URL$m" |
      awk -F'\t' '$1 == "error" { f = 1 } END { exit !f }'; then st=gone
    else
      case "$(printf '%s\n' "$jobs" | awk -F'\t' -v m="$m" '$1 == m { print $2; exit }')" in
        in_progress) st="$(part_lockwait "$rows" "$RESULTS/part-state-$p.seen")" ;; # working, or queued for a lock on its machine
        *) st=gone ;; # queued, waiting, completed without an answer, or unreadable: nobody is working on it
      esac
    fi
    printf '%s\n' "$st" > "$RESULTS/part-state-$p.new" && mv -f "$RESULTS/part-state-$p.new" "$RESULTS/part-state-$p"
  done < "$RESULTS/parts-wanted"
}
if [ -n "${CI_REMOTE_PARTS:-}" ] && wants check; then
  if [ "${CI_STATUS_PREFIX:-local-ci}" != local-ci ]; then
    echo "ci-local: check runs as a part here (${CI_STATUS_PREFIX}/): it has no parts of its own; CI_REMOTE_PARTS ignored"
  elif [ "$STATUS" = 1 ] && [ -n "${CI_ATTEMPT_URL:-}" ]; then
    for _p in $CI_REMOTE_PARTS; do printf '%s %s\n' "${_p%%:*}" "${_p#*:}"; done > "$RESULTS/parts-wanted"
    parts_poll
  else
    echo "ci-local: CI_REMOTE_PARTS given, but this run cannot read their statuses; check runs every part here"
  fi
fi
# The e2e part (CI_BROWSER_E2E_PART): its state in $RESULTS/e2e-part-state for the browser job, which has no token to read it
# (job_browser's browser_e2e_fold). pass or fail: its answer. working: its job is queued or running. gone: its job ended (or is
# not in the run) without an answer, or its machine refused it (an error under its own link). unread: GitHub could not be
# read. The job takes the packages back on gone at once, and on anything but pass or fail when its wait is over.
# The check part (CI_CHECK_PART) the same way, into $RESULTS/check-part-state, read from the start (job_check folds it).
e2e_part_poll() { fold_poll "$(ci_ns ci-part/browser-e2e)" "$CI_BROWSER_E2E_PART" e2e-part-state E2E_GONE; }
check_part_poll() { fold_poll "$(ci_ns ci-part/check)" "$CI_CHECK_PART" check-part-state CHECK_GONE; }
fold_poll() { # fold_poll <part context> <machine> <state file> <its "gone" counter>
  local c="$1" m="$2" all rows jobs st n="${!4}"
  if ! all="$(ci_statuses "$SLUG" "$SHA")"; then st=unread
  else
    rows="$(printf '%s\n' "$all" | ci_attempt_filter "$c" "$CI_ATTEMPT_URL")"
    if [ -n "$(printf '%s\n' "$rows" | ci_attempt_red)" ]; then st=fail
    # a success that says "skipped" (no inputs changed there) ran nothing: no answer for this run
    elif printf '%s\n' "$rows" | awk -F'\t' '$1 == "success" && index($2, "skipped") != 1 { f = 1 } END { exit !f }'; then st=pass
    # refused on its machine: an error ("not tested: ...") under the part's own link of this attempt
    elif printf '%s\n' "$all" | awk -F'\t' -v c="$c" -v l="$CI_ATTEMPT_URL$m" \
      '$1 == c && $2 == "error" && $3 == l { f = 1 } END { exit !f }'; then st=gone
    elif ! jobs="$(gh api --paginate "repos/$SLUG/actions/runs/$CI_RUN_ID/jobs?per_page=100" --jq '.jobs[] | [.name, .status] | @tsv' 2>/dev/null)"; then st=unread
    else
      case "$(printf '%s\n' "$jobs" | awk -F'\t' -v m="$m" '$1 == m { print $2; exit }')" in
        in_progress | queued | waiting | pending | requested) st=working ;;
        *) st=gone ;;
      esac
      # gone from the job list (its job ended, or its name is not there) must be seen twice in a row: a list read a moment early
      # must not take the packages back on one look
      if [ "$st" = gone ]; then n=$((n + 1)); [ "$n" -ge 2 ] || st=working; else n=0; fi
      [ "$st" != working ] || st="$(part_lockwait "$rows" "$RESULTS/$3.seen")" # working, or queued for a lock on its machine
    fi
  fi
  [ "$st" != unread ] || n=0 # "twice in a row" means two readable looks with nothing between
  printf -v "$4" '%s' "$n"
  printf '%s\n' "$st" > "$RESULTS/$3.new" && mv -f "$RESULTS/$3.new" "$RESULTS/$3"
}
E2E_POLLED=0 E2E_GONE=0 CHECK_POLLED=0 CHECK_GONE=0
noted() { # noted <job> <text>: the status text cut to 140 characters, ending with why this run answers it (CI_FALLBACK_NOTES)
  local n
  n="$(printf '%s' "${CI_FALLBACK_NOTES:-}" | tr ';' '\n' | awk -F= -v j="$1" '$1 == j { print " (fallback: " $2 ")"; exit }')"
  printf '%s%s' "$(printf '%s' "$2" | cut -c1-$((140 - ${#n})))" "$n"
}
run_job() { # run_job <job>: one job start to finish; leaves "<exit code> <seconds> <why it skipped>" in $RESULTS/<job>
  local j="$1" log="$LOGS/$SHORT-$j.log" start rc=1 why=""
  keep_prev_log "$log"
  : > "$log"; : > "${log%.log}.notrun" # the NOT RUN lines of this run (not_run, jobs-check.sh): what a report reads
  echo "bun: $(ci_bun_version) ($(command -v bun 2>/dev/null || echo not on PATH))" >> "$log" # the bun this job runs
  # Where this job's test runners write each test that failed once and passed when run again ("<test>\t<file>"); report() reads it.
  export CI_FLAKE_FILE="$RESULTS/$j.flaky"
  # where a part's lock wait is written for the main shell to post (turn.sh, ci_part_beat); a plain variable, never exported
  if [ "${CI_STATUS_PREFIX:-local-ci}" = ci-part ] && [ "$STATUS" = 1 ]; then CI_LOCKWAIT_FILE="$RESULTS/$j.lockwait"; else CI_LOCKWAIT_FILE=""; fi
  : > "$CI_FLAKE_FILE"
  # check's per-test file (scripts/ci-test-results.ts): Vitest's and the bun runner's reports, gathered after the suites. Only
  # check's: the jobs after it in the same group must not inherit them.
  if [ "$j" = check ]; then
    # the root its files are named from: the worktree (a Vitest run inside a package, the contract suite, has its own root)
    export CI_TEST_RESULTS_DIR="$RESULTS/check-tests" TALOS_TEST_JUNIT_DIR="$RESULTS/check-tests/bun" \
      CI_TEST_RESULTS_ROOT="$(cd "$WT" && pwd -P)" # physical, as Vitest's module ids are: a symlinked path would give ../.. names
    rm -rf "$CI_TEST_RESULTS_DIR" && mkdir -p "$CI_TEST_RESULTS_DIR"
  else
    unset CI_TEST_RESULTS_DIR TALOS_TEST_JUNIT_DIR CI_TEST_RESULTS_ROOT
  fi
  start=$(date +%s) JOB_WAITED=0
  if declare -F "job_$j" >/dev/null; then "job_$j" "$log"; rc=$?; fi
  [[ " ${SKIPPED[*]:-} " == *" $j "* ]] && why="$SKIP_WHY"
  echo "$JOB_WAITED" > "$RESULTS/$j.waited" # before the result: report reads both once the result is there
  printf '%s %s %s\n' "$rc" "$(($(date +%s) - start))" "$why" > "$RESULTS/$j.part"
  mv -f "$RESULTS/$j.part" "$RESULTS/$j"
}
start_jobs() { # start_jobs <job...>: these jobs, one after another, as one background group of processes of their own
  local j
  set -m # each background group gets its own process group, so a cancelled run can stop all of it
  (
    set +m
    # Only this shell posts statuses: a pass a job (test code, a browser) could post by hand for any commit would be one nobody tested.
    unset GH_TOKEN GITHUB_TOKEN
    [ "${CI_HOSTILE:-}" != 1 ] || ci_hostile_env # the hostile nightly's clock shift and time zone, for the jobs only
    for j in "${@:2}"; do ci_fold_wait "$RESULTS" "$j"; done # a job behind another of its group has not begun: idle, not busy (turn.sh)
    for j in "$@"; do
      CI_JOBNAME="$j" # for ci_yield and wait_for_job (turn.sh)
      [ "$j" = "$1" ] || ci_fold_resume "$RESULTS" "$j" "$LOCKS" # a job behind another begins its turn now
      case "$j" in
        desktop | mobile) # a build wants every core: after this run's quiet suites. The jobs of a run overlap now (one slot of CI's each,
          # up to TALOS_CI_SLOTS), but two Swift jobs never do: each takes the desktop mutex, and no slot inside it, around its Swift
          # steps (job_desktop around ci.sh, job_mobile around its steps), never a slot while it waits
          wait_for_job check quiet-done
          run_job "$j" ;;
        *) run_job "$j" ;;
      esac
    done
  ) </dev/null &
  set +m
  printf '%s %s\n' "$!" "$(ci_proc_start $!)" >> "$RUN_DIR/groups"
  for j in "$@"; do echo "$!" > "$RESULTS/$j.group"; done
}
report() { # report <job> <exit code> <seconds> <why it skipped>
  local j="$1" rc="$2" secs="$3" why="${4:-}" log="$LOGS/$SHORT-$1.log" slept=0 woke warned="" retried="" n=0 t f rows red answered=0 fb=0 _ci_held="" _all _ok _top parts="" _p _m
  # Its own steps against its wall time: a job that waited for another (browser for check) says so, and timings.tsv keeps both.
  local waited steps took
  waited="$(cat "$RESULTS/$j.waited" 2>/dev/null)"
  case "$waited" in '' | *[!0-9]*) waited=0 ;; esac
  steps=$((secs > waited ? secs - waited : 0))
  took="${secs}s"
  [ "$waited" = 0 ] || took="${secs}s: ${steps}s of its own steps, ${waited}s waiting for another job"
  [ -n "$why" ] || JOB_TIMES="${JOB_TIMES:+$JOB_TIMES,}$j=$secs/$steps"
  # A job that "passed" while the Mac slept gets a warning: see ci_slept_since. CI_SLEEP_GUARD=1 makes it a failure instead.
  # Skips don't depend on the Mac being awake.
  if [ "$rc" = 0 ] && [ -z "$why" ] && ci_slept_since "$T_SLOT"; then
    woke="the Mac slept during this run (last wake $(ci_wake_epoch 2>/dev/null || echo unknown), run began $T_SLOT)"
    case "${CI_SLEEP_GUARD:-0}" in
      1 | on | yes | true) echo "$woke; a pass cannot be trusted. Re-run." >> "$log"; rc=1 slept=1 ;;
      *) echo "warning: $woke" | tee -a "$log" >> "$RESULTS/$j.warn" ;;
    esac
  fi
  case ";${CI_FALLBACK_NOTES:-};" in *";$j="*) fb=1 ;; esac # this run took the job back from another machine (ci-runner.sh fallback)
  # Right before the final post, the attempt's other answers (two answers for one context): another machine's red of this attempt
  # makes this one red with the first red's words; a pass after another pass of it posts nothing more (the first green stands).
  if [ "$STATUS" = 1 ] && [ -n "${CI_ATTEMPT_URL:-}" ] && [ -z "$why" ]; then
    if ! rows="$(ci_attempt_rows "$SLUG" "$SHA" "$(ci_context "$j")" "$CI_ATTEMPT_URL")"; then
      # another machine's red could be there, unseen: never post a green over it
      [ "$rc" != 0 ] || echo "could not read this attempt's statuses; re-run" > "$RESULTS/$j.why" # keep a failure's own why
      rc=1
    fi
    red="$(printf '%s\n' "$rows" | ci_attempt_red)"
    if [ -n "$red" ]; then
      rc=1 && printf '%s\n' "$red" > "$RESULTS/$j.why" && echo "  ! $j: this attempt already has a red for it: $red"
    elif [ "$fb" = 1 ] && _all="$(ci_statuses "$SLUG" "$SHA")" &&
      _ok="$(printf '%s\n' "$_all" | awk -F'\t' -v c="$(ci_context "$j")" -v a="$CI_ATTEMPT_URL" -v own="${CI_STATUS_URL:-}" \
        '$1 == c && $2 == "success" && index($3, a) == 1 && $3 != own { print $3 "\t" $4; exit }')" && [ -n "$_ok" ]; then
      # A take-back never posts over the owner's pass, whichever of the two statuses is newer (the owner can answer between the
      # start check and this run's own pending, or later): this run's result, a failure included, is logged below, not posted.
      answered=1 _ci_held=1
      _top="$(printf '%s\n' "$_all" | awk -F'\t' -v c="$(ci_context "$j")" '$1 == c { print $2 "\t" $3; exit }')"
      # this run's pending is on top of the owner's pass: the pass goes on top again, in the owner's own words and link
      [ "$_top" != "pending"$'\t'"${CI_STATUS_URL:-}" ] || ci_post_status "$SLUG" "$SHA" "$j" success "${_ok#*$'\t'}" "${_ok%%$'\t'*}" || true
    elif [ "$rc" = 0 ] && [ -n "$(printf '%s\n' "$rows" | ci_attempt_final)" ] &&
      ! ci_still_ours "$SLUG" "$SHA" "$(ci_context "$j")" "${CI_STATUS_URL:-}"; then
      answered=1 # another machine's final is the newest status: it stands. (If this run's pending is newer, this run answers.)
    fi
  fi
  # check's parts: right before check is posted, each part's statuses once more: a part red on its machine in this attempt fails
  # check, even if it also ran here and passed
  if [ "$j" = check ] && [ -f "$RESULTS/parts-wanted" ] && [ -z "$why" ]; then
    _ok=1 && _all="$(ci_statuses "$SLUG" "$SHA")" || _ok="" # one read for every part
    while read -r _p _m; do
      if [ -z "$_ok" ]; then
        [ "$rc" != 0 ] || { rc=1; echo "could not read the parts' statuses; re-run" > "$RESULTS/check.why"; }
        continue
      fi
      red="$(printf '%s\n' "$_all" | ci_attempt_filter "$(ci_ns "ci-part/$_p")" "$CI_ATTEMPT_URL" | ci_attempt_red)"
      [ -z "$red" ] || [ "$rc" != 0 ] || { rc=1; printf '%s failed on %s; see its run\n' "$(part_label "$_p" | sed 's/^shard/bridge shard/')" "$_m" > "$RESULTS/check.why"; }
    done < "$RESULTS/parts-wanted"
    [ ! -s "$RESULTS/check.where" ] || parts=" ($(head -1 "$RESULTS/check.where"))"
  fi
  # "not tested: ..." (nottested): posted as `error`, which no verdict reads as red or green
  local nottested=""
  # check with its part on Titan (CI_CHECK_PART): as browser with its e2e part, below
  if [ "$j" = check ] && [ -n "${CI_CHECK_PART:-}" ] && [ -z "$why" ]; then
    [ ! -s "$RESULTS/check.where" ] || parts=" ($(head -1 "$RESULTS/check.where"))"
    if _all="$(ci_statuses "$SLUG" "$SHA")"; then
      red="$(printf '%s\n' "$_all" | ci_attempt_filter "$(ci_ns ci-part/check)" "$CI_ATTEMPT_URL" | ci_attempt_red)"
      [ -z "$red" ] || [ "$rc" != 0 ] || { rc=1; echo "check failed on $CI_CHECK_PART; see its run" > "$RESULTS/check.why"; }
    elif [ "$rc" = 0 ]; then
      rc=1; nottested="not tested: check part status unreadable on GitHub; re-run"
    fi
  fi
  # browser with its e2e part (CI_BROWSER_E2E_PART): the job folded the part's answer or took the packages back (browser.where
  # says which). Right before the post, the part's statuses once more, as check reads its parts: a red of this attempt on the
  # part's machine fails browser even when the packages also ran here and passed.
  if [ "$j" = browser ] && [ -n "${CI_BROWSER_E2E_PART:-}" ] && [ -z "$why" ]; then
    [ ! -s "$RESULTS/browser.where" ] || parts=" ($(head -1 "$RESULTS/browser.where"))"
    if _all="$(ci_statuses "$SLUG" "$SHA")"; then
      red="$(printf '%s\n' "$_all" | ci_attempt_filter "$(ci_ns ci-part/browser-e2e)" "$CI_ATTEMPT_URL" | ci_attempt_red)"
      [ -z "$red" ] || [ "$rc" != 0 ] || { rc=1; echo "the browser-e2e part failed on $CI_BROWSER_E2E_PART; see its run" > "$RESULTS/browser.why"; }
    elif [ "$rc" = 0 ]; then
      rc=1; nottested="not tested: browser-e2e part status unreadable on GitHub; re-run"
    fi
  fi; titan_red_convert "$j" "$took" # a Titan part's red (machine.sh)
  # For a run of this commit waiting behind this one. A skip is stored as "skip", not 0: it is a pass for a run that may skip, and
  # no answer at all for a --full run, which skips nothing (see the wait above).
  # a refusal (a tool missing here) or a "not tested" is no answer for a run waiting behind this one: it tests the job itself
  if [ -s "$RESULTS/$j.refused" ] || [ -n "$nottested" ]; then echo refused > "$RESDIR/$j"
  elif [ "$rc" = 0 ] && [ -n "$why" ]; then echo skip > "$RESDIR/$j"; else printf '%s\n' "$rc" > "$RESDIR/$j"; fi
  # A test that failed once and passed when run again: green, but said so in the status, the run's output and the job's log, and
  # kept in logs/flakes.tsv (date, sha, job, test, file). Logged even when the job failed for another reason.
  # The log and output lines come after the result (below), so a red job's printed tail still shows why it failed.
  if [ -s "$RESULTS/$j.flaky" ]; then
    while IFS=$'\t' read -r t f; do
      [ -n "$t" ] || continue
      n=$((n + 1))
      printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$SHA" "$j" "$t" "$f" >> "$LOGS/flakes.tsv"
    done < "$RESULTS/$j.flaky"
    [ "$n" = 0 ] || retried=", passed on retry ($n flaky test$([ "$n" = 1 ] || echo s), see flakes.tsv)"
  fi
  if [ "$slept" = 1 ]; then
    echo "  ✗ $j ($took): the Mac slept during the run; not trusted, re-run"; post "$j" error "the Mac slept during the run; result not trusted, re-run"
    if [ "$_ci_held" = 1 ]; then HELD+=("$j"); else FAILED+=("$j"); fi
  elif [ -n "$nottested" ]; then
    echo "  ✗ $j ($took): $nottested"; post "$j" error "$nottested"
    if [ "$_ci_held" = 1 ]; then HELD+=("$j"); else FAILED+=("$j"); fi
  elif [ -s "$RESULTS/$j.refused" ]; then
    # a part this machine cannot run (a tool missing): error, never a red; the machine that runs check takes it over
    # not a failure (the run ends green if nothing else failed), but loud: a ::warning:: line in the job's GitHub log
    echo "  ! $j refused: $(head -1 "$RESULTS/$j.refused")"; post "$j" error "$(head -1 "$RESULTS/$j.refused" | cut -c1-140)"
    echo "::warning::ci-local: $(head -1 "$RESULTS/$j.refused")"
    REFUSED+=("$j")
  elif [ "$rc" != 0 ]; then
    echo "  ✗ $j ($took), log: $log"; tail -25 "$log" | sed 's/^/    /'
    if [ -s "$RESULTS/$j.why" ]; then post "$j" failure "$(noted "$j" "$(head -1 "$RESULTS/$j.why")")"
    else post "$j" failure "$(noted "$j" "failed on $WHERE; see ~/.cache/talos-ci/logs${LOGS#"$CACHE/logs"}/$SHORT-$j.log")"; fi
    # held: the owner's pass stands for this job, so this run does not end red (the log above is kept)
    if [ "$_ci_held" = 1 ]; then HELD+=("$j"); else FAILED+=("$j"); fi
  elif [ -n "$why" ]; then
    echo "  - $j skipped: $why (${secs}s)"
    case "$why" in
      "no $j inputs changed since "?*) post "$j" success "skipped: $why" ;; # the words ci_classify reads as "not affected"
      *) post "$j" success "skipped ($why)" ;;
    esac
  else
    if [ -s "$RESULTS/$j.warn" ]; then warned=", with warnings (see its log)"; sed 's/^/  ! /' "$RESULTS/$j.warn"; fi; reuse_report "$j" # a step the gate answered is said, never a plain pass
    if [ "$answered" = 1 ]; then echo "  ✓ $j ($took): answered first elsewhere in this attempt; nothing posted"
    else echo "  ✓ $j ($took)"; post "$j" success "$(noted "$j" "$(titan_pass_say "$j" "$fb" "$log")passed on $WHERE in ${secs}s$REUSE_SAYS$parts$retried$warned")"; titan_report_green "$j" "$secs"; fi
  fi
  if [ "$n" -gt 0 ]; then
    while IFS=$'\t' read -r t f; do
      [ -n "$t" ] || continue
      echo "passed on retry: $t ($f)" >> "$log"
      echo "  ! $j: passed on retry: $t ($f)"
    done < "$RESULTS/$j.flaky"
  fi
  mkdir -p "$RUN_DIR/reported" && : > "$RUN_DIR/reported/$j" # answered: a later cancel has nothing to settle for this job
}

for i in ${SKIP_JOBS[@]+"${!SKIP_JOBS[@]}"}; do report "${SKIP_JOBS[$i]}" 0 0 "${SKIP_WHYS[$i]}"; done

# Every job at once (the browser job waits for check, see job_browser), except the two Swift jobs: they share a SwiftPM cache and a
# build of them wants every core, so the iPhone shell waits for the Mac app.
UNIQUE="" SWIFT=()
# the run's jobs, for the turn (scripts/ci-local/turn.sh): a run whose every job that has not ended waits on a part of another machine
# does not hold the turn from a gate; a job is marked while it waits (ci_fold_wait in its fold loops)
printf '%s\n' "${WANT[@]}" | awk '!seen[$0]++' > "$RUN_DIR/jobs"
for j in "${WANT[@]}"; do
  case " $UNIQUE " in *" $j "*) continue ;; esac
  UNIQUE="$UNIQUE $j"
  case "$j" in
    desktop | mobile) SWIFT+=("$j") ;;
    image) CONTAINER="talos-ci-s$CI_SLOT-$SHORT-$$"; printf '%s\n' "$CONTAINER" > "$RUN_DIR/container"; start_jobs "$j" ;;
    *) start_jobs "$j" ;;
  esac
done
[ ${#SWIFT[@]} -eq 0 ] || start_jobs "${SWIFT[@]}"

# Results as they come. A job that died without leaving one (killed from outside) is a failure, never a pass.
# While check runs with parts on other machines, this shell (it has the token; the jobs don't) keeps their states up to date.
FAILED=() HELD=() REFUSED=() WAITING="$UNIQUE" PART_POLLED=0 JOB_TIMES=""
while [ -n "${WAITING// /}" ]; do
  STILL=""
  for j in $WAITING; do
    # read, not $(cat): no $(...) in this loop while it only waits, see after its done
    if [ -f "$RESULTS/$j" ] || ! { read -r _grp < "$RESULTS/$j.group" && kill -0 "$_grp"; } 2>/dev/null; then
      if [ -f "$RESULTS/$j" ]; then
        read -r rc secs why < "$RESULTS/$j"
        report "$j" "$rc" "$secs" "$why"
      else
        echo "the job died without a result" >> "$LOGS/$SHORT-$j.log"
        report "$j" 1 "$(($(date +%s) - T_SETUP))"
      fi
    else
      STILL="$STILL $j"
    fi
  done
  WAITING="$STILL"
  _poll="${CI_PART_POLL:-30}" _poll="${_poll%.*}" # every CI_PART_POLL seconds (30), whole seconds: this loop ticks once a second
  if [ -f "$RESULTS/parts-wanted" ] && [ ! -f "$RESULTS/check" ] && [ $(($(date +%s) - PART_POLLED)) -ge "${_poll:-0}" ]; then
    parts_poll; PART_POLLED=$(date +%s)
  fi
  # the e2e part's state for the browser job, from when that job asks for it (its web suites are over) until it ends; before
  # then nobody reads it, and reading it then would spend the rate limit for nothing
  if [ -n "${CI_BROWSER_E2E_PART:-}" ] && [ -f "$RESULTS/e2e-part-asked" ] && [ ! -f "$RESULTS/browser" ] &&
    [[ " $WAITING " == *" browser "* ]] && [ $(($(date +%s) - E2E_POLLED)) -ge "${_poll:-0}" ]; then
    e2e_part_poll; E2E_POLLED=$(date +%s)
  fi
  if [ -n "${CI_CHECK_PART:-}" ] && [ ! -f "$RESULTS/check" ] && [[ " $WAITING " == *" check "* ]] &&
    [ $(($(date +%s) - CHECK_POLLED)) -ge "${_poll:-0}" ]; then
    check_part_poll; CHECK_POLLED=$(date +%s)
  fi
  part_beat_post # a part queued for a lock says so (jobs-check.sh)
  [ -z "${WAITING// /}" ] || sleep 1
done
[ -z "${WAITING// /}" ] || wait_cut_off # the loop ends with every job reported; anything else is a cut (jobs-check.sh)

T_DONE=$(date +%s)
echo "ci-local: timing: waited $((T_SLOT - T_ASKED))s, setup $((T_SETUP - T_SLOT))s, jobs $((T_DONE - T_SETUP))s"
# timings.tsv: date, sha, slot, jobs, waited, setup, jobs' wall time, failures, then each job that ran as <job>=<wall>/<own steps>
# seconds (its wall time less the time it waited for another job: browser's wall includes the whole of check), then the desktop
# job's pty use, pty=<peak /dev/ttys*>/<kern.tty.ptmx_max>, or - when it did not run (appended: older rows have nine columns),
# then the bun the run started with, bun=<version> (bun=none without one; appended: older rows have ten columns), then the
# seconds of Chronos's suite inside check, chronos=<seconds> or chronos=- when it did not run (appended: older rows have eleven), then
# reused=<job>:<gate step> for each job that took a step from the gate's result (reuse_timings), or reused=- (appended: twelve columns before).
_pty="$(cat "$RESULTS/desktop.pty" 2>/dev/null)"
_chronos="$(cat "$RESULTS/chronos.secs" 2>/dev/null)"
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$SHORT" "$CI_SLOT" "$JOBS" \
  "$((T_SLOT - T_ASKED))" "$((T_SETUP - T_SLOT))" "$((T_DONE - T_SETUP))" "${#FAILED[@]}" "$JOB_TIMES" "${_pty:--}" "bun=$RUN_BUN" \
  "chronos=${_chronos:--}" "$(reuse_timings)" >> "$LOGS/timings.tsv"
[ ${#HELD[@]} -eq 0 ] || echo "::warning::ci-local: failed here, not posted: the owning machine's pass for this attempt stands: ${HELD[*]} ($SHORT)"
if [ ${#FAILED[@]} -eq 0 ] && [ -z "$BAD_BEFORE" ] && [ ${#POSTFAIL[@]} -gt 0 ]; then
  echo "ci-local: FAILED: the jobs passed, but these statuses were not posted: ${POSTFAIL[*]} ($SHORT)"; exit 1
fi
if [ ${#FAILED[@]} -eq 0 ] && [ -z "$BAD_BEFORE" ]; then
  [ ${#REFUSED[@]} -eq 0 ] || { echo "ci-local: nothing failed; refused, not tested here (see each one's line above): ${REFUSED[*]} ($SHORT)"; exit 0; }
  echo "ci-local: all green ($SHORT)"; exit 0
fi
echo "ci-local: FAILED: ${BAD_BEFORE:+$BAD_BEFORE }${FAILED[*]:-} ($SHORT)"; exit 1
