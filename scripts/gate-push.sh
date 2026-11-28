#!/usr/bin/env bash
# The one way to push (scripts/gate.sh --push [--full] [<remote> [<branch>]], default origin main): rebase, gate (the fast gate,
# gate.sh --fast, unless --full), then push under a short lease, and when main moved meanwhile, rebase and gate again without
# running the whole gate twice for nothing.
#   1. Refuses with a rebase in progress or uncommitted changes (the gate checks the files on disk).
#   2. Fetches, rebases onto <remote>/<branch> and runs the gate, holding NO lease: a slow machine's gate (20-45 min) never
#      makes the others wait. What passed is recorded in .git/talos-gate.pass: the tree, the base, the plan and the sha256 of
#      gate.sh and pre-push.sh. The pre-push hook trusts that stamp for that exact tree (and runs the gate itself for
#      anything else), so the push does not run the gate a second time.
#   3. Takes the push lease, refs/locks/push on the remote (advisory: a plain push ignores it): a parentless commit with an
#      empty tree whose message names the machine and the time it runs out. Taken and renewed with --force-with-lease, so two
#      machines cannot both hold it; one that ran out is taken over. Released at the end, and on Ctrl-C. A remote that
#      refuses the ref means no lease: the push goes on. A machine that has to wait (up to 60 min) says so in its own wait
#      ref, refs/locks/wait/<machine> (when it began waiting, refreshed while it waits): a free lease goes to the live
#      waiter that began first, so a machine that just let it go queues behind the ones already waiting.
#   4. Under the lease: fetches. When the branch moved since the gate, rebases and looks at what the new commits brought:
#      when it is words only (docs/, a top-level .md), none of it is this change's, and this change plans no scripts test
#      (those read the tree), only typecheck, lint, personal, size and timing run again, under the lease (CI runs every suite after
#      the merge); otherwise the lease is let go, the whole touched set runs again without it, and the machine queues again
#      with the place it had. Then pushes the gated commit by its sha (a commit made while the gate ran
#      refuses the push). A push still rejected because the branch moved goes round again: at most 3 tries; a rebase that
#      fails stops at once. A file both sides changed is let through when it is words no test reads (rebase_clean).
#   A test the gate fails that is failing on main's tip already, by main's CI, and that this change does not touch is excused,
#   said, stamped and logged (excuse_prepare here, scripts/gate-excuse.sh in the gate; docs/CI-MACHINES.md).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 2

# --from <remote>/handoff/<machine>/<name>: land another machine's handed-off work (pre-push.sh lets a handoff branch
# through with only the personal-data check). Its commits are taken from that branch, rebased onto main (authors kept),
# gated in full like any change, pushed to main by sha, and the handoff branch is deleted. This checkout goes back to the
# branch it was on.
FROM=""
FROM_GIVEN=0
ARGS=()
RED_MAIN=0
# The gate it runs: the fast one (gate.sh --fast: it runs the full gate itself for a change on its keep-out list, and says why;
# CI runs everything after the push), or with --full the full gate, as before.
GATE_MODE=--fast
while [ $# -gt 0 ]; do # --from, --red-main and --full anywhere among the arguments
  if [ "$1" = --red-main ]; then
    RED_MAIN=1
    shift
  elif [ "$1" = --full ]; then
    GATE_MODE=""
    export GATE_FULL=1 # the pre-push hook takes no flags: it reads this, if it runs the gate itself
    shift
  elif [ "$1" = --from ]; then
    FROM_GIVEN=1
    FROM="${2:-}"
    shift 2 2>/dev/null || shift
  else
    ARGS+=("$1")
    shift
  fi
done
[ -z "$FROM" ] || export GATE_LANDING_HANDOFF=1 # gate.sh does not tell a landing machine to hand the work off again
REMOTE="${ARGS[0]:-origin}"
BRANCH="${ARGS[1]:-main}"
LOCK=refs/locks/push
# the machine's name in the lease and the wait queue.
# It is the fleet name (scripts/talos-machine.sh), never the host name: the name goes onto origin (refs/locks/wait/<machine>,
# the lease's machine= line), and a host name can carry a person's name. Unset or unknown: one line, and nothing is pushed.
[ -f scripts/talos-machine.sh ] || {
  echo "gate-push: REFUSED: scripts/talos-machine.sh is missing: this checkout is incomplete" >&2
  exit 1
}
# shellcheck source=scripts/talos-machine.sh
. scripts/talos-machine.sh
# File names compared as the Mac's disk compares them (case and Unicode folded): the landing check and the rebase-clean pass.
# Read here, from this checkout, before anything else is checked out: a handoff's own copy never decides about itself.
[ -f scripts/path-fold.sh ] || {
  echo "gate-push: REFUSED: scripts/path-fold.sh is missing: this checkout is incomplete" >&2
  exit 1
}
# shellcheck source=scripts/path-fold.sh
. scripts/path-fold.sh; . scripts/gate/swift-race.sh
MACHINE="$(talos_machine)" || exit 1
LEASE_S="${GATE_PUSH_LEASE_S:-600}"     # how long a lease holds (at least; see the last gate time below)
RENEW_EVERY_S="${GATE_PUSH_RENEW_EVERY_S:-240}" # while the gate runs, the lease is renewed this often
WAIT_S="${GATE_PUSH_WAIT_S:-3600}"      # how long to wait for the lease (waiting is cheap: the gate already ran)
WAITER_REFRESH_S="${GATE_PUSH_WAITER_REFRESH_S:-60}" # a waiter says it is still there this often
WAITER_STALE_S="${GATE_PUSH_WAITER_STALE_S:-180}"     # a wait ref not refreshed for this long is a waiter that is gone
POLL_S="${GATE_PUSH_POLL_S:-15}"
TRIES=3
GIT_DIR_ABS="$(git rev-parse --absolute-git-dir)"
STAMP="$GIT_DIR_ABS/talos-gate.pass"
EMPTY_TREE="$(git hash-object -t tree /dev/null)"
GATE_TIME="$GIT_DIR_ABS/talos-gate.time" # how long the last gate took on this machine, in seconds
LEASE_FILE="$GIT_DIR_ABS/talos-push.lease" # the lease held now, as the renewer leaves it
# a machine whose gate is slow asks for a longer lease: twice its last gate, from 10 minutes up to an hour
if [ -z "${GATE_PUSH_LEASE_S:-}" ]; then
  last="$(cat "$GATE_TIME" 2>/dev/null)"
  case "$last" in '' | *[!0-9]* | ??????*) ;; *) [ $((last * 2)) -le "$LEASE_S" ] || LEASE_S=$((last * 2)) ;; esac
  [ "$LEASE_S" -le 3600 ] || LEASE_S=3600
fi

say() { printf 'gate-push: %s\n' "$*" >&2; }
HANDOFF_REF="" HANDOFF_SHA="" STAMPED_IDS="" BACK_TO="" # --from: the handoff branch being landed, and the branch this checkout goes back to
handoff_back() { [ -z "$BACK_TO" ] || git -c core.hooksPath=/dev/null checkout -q "$BACK_TO" 2>/dev/null || say "could not go back to $BACK_TO"; }
refuse() {
  say "REFUSED: $*"
  exit 1
}
# sha256 of a file, or of stdin: shasum on macOS, sha256sum on Linux; nothing printed is a failure, never an empty match
sha256() { { shasum -a 256 "$1" 2>/dev/null || sha256sum "$1" 2>/dev/null; } | cut -d' ' -f1; }
sha256_of() { { shasum -a 256 2>/dev/null || sha256sum 2>/dev/null; } | cut -d' ' -f1; }
# the gate's own code, one sha: scripts/gate.sh, then every file under scripts/gate/ in byte order (a change to any of them is
# another gate); nothing printed when gate.sh is missing. The pre-push hook computes it the same way (scripts/pre-push.sh).
gate_sha() {
  local f
  [ -f scripts/gate.sh ] || return 0
  { cat scripts/gate.sh; find scripts/gate -type f 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do cat "$f"; done; } | sha256_of
}
rebasing() { [ -d "$GIT_DIR_ABS/rebase-merge" ] || [ -d "$GIT_DIR_ABS/rebase-apply" ]; }

# patch_ids <range>: the commit count of the range, then each commit's `git patch-id --stable` id, oldest first; nothing and a
# failure when git cannot say. No diff driver, textconv or external diff runs (a handoff's .gitattributes is not code to run here).
patch_ids() {
  local n ids
  n="$(git rev-list --count "$1")" || return 1
  ids="$(git log --reverse --no-merges --no-color --no-notes --no-ext-diff --no-textconv -p "$1" | git patch-id --stable | cut -d' ' -f1)" || return 1
  printf '%s\n%s\n' "$n" "$ids"
}
# stamp_ok <tip sha>: 0 when the remote holds refs/personal-ok/<tip>, fetched into refs/personal-ok-remote/<tip>, as an annotated
# tag (git cat-file -t: tag) whose peeled commit is exactly <tip>. Otherwise 1, and one phrase on stdout for the refusal when a
# stamp exists but is not right (nothing printed when there is none).
stamp_ok() {
  local sha="$1" ref typ peeled
  ref="refs/personal-ok-remote/$sha"
  printf '%s\n' "$sha" | grep -Eqx '[0-9a-f]{40}' || return 1
  git update-ref -d "$ref" >/dev/null 2>&1
  GIT_TERMINAL_PROMPT=0 git fetch -q --no-tags "$REMOTE" "+refs/personal-ok/$sha:$ref" </dev/null >/dev/null 2>&1 || return 1
  typ="$(git cat-file -t "$ref" 2>/dev/null)"
  [ "$typ" = tag ] || { echo "its personal-ok stamp is not an annotated tag"; return 1; }
  peeled="$(git rev-parse --verify -q "$ref^{commit}" 2>/dev/null)"
  [ "$peeled" = "$sha" ] || { echo "its personal-ok stamp is not for this exact commit"; return 1; }
  return 0
}

# ---- the lease ------------------------------------------------------------------------------------------------------------
LEASE=""       # the lease commit this run holds
LEASE_UNTIL=0  # when it runs out (seconds since 1970)
iso_of() { date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "$1"; }
lease_seen() { git ls-remote "$REMOTE" "$LOCK" 2>/dev/null | cut -f1; }
lease_field() { # lease_field <sha> <key>: a key=value line of the lease's message
  git fetch -q "$REMOTE" "$LOCK" 2>/dev/null
  git log -1 --format=%B "$1" 2>/dev/null | sed -n "s/^$2=//p" | head -1
}
lease_info() { # lease_info <sha>: "<until>|<machine>|<pid>" from one fetch (a field may be empty)
  local msg
  git fetch -q "$REMOTE" "$LOCK" 2>/dev/null
  msg="$(git log -1 --format=%B "$1" 2>/dev/null)"
  printf '%s|%s|%s\n' "$(sed -n 's/^until=//p' <<<"$msg" | head -1)" "$(sed -n 's/^machine=//p' <<<"$msg" | head -1)" \
    "$(sed -n 's/^pid=//p' <<<"$msg" | head -1)"
}
lease_put() { # lease_put <expected sha or ''>: a new lease over exactly that one; prints the new sha on success
  local new until
  until=$(($(date +%s) + LEASE_S))
  new="$(printf 'talos push lease\n\nmachine=%s\nuntil=%s\nuntil_iso=%s\npid=%s\n' "$MACHINE" "$until" "$(iso_of "$until")" "$$" |
    git commit-tree "$EMPTY_TREE")" || return 2
  # tests: say a put has begun, then take a while, so a stop lands inside it: a renewal before its push, the take after its
  # push has landed
  if [ -n "${IN_RENEWER:-}" ]; then
    [ -z "${GATE_PUSH_TEST_PUT_MARK:-}" ] || : >"$GATE_PUSH_TEST_PUT_MARK"
    [ -z "${GATE_PUSH_TEST_PUT_DELAY_S:-}" ] || sleep "$GATE_PUSH_TEST_PUT_DELAY_S"
  fi
  git push -q --force-with-lease="$LOCK:$1" "$REMOTE" "$new:$LOCK" >/dev/null 2>&1 || return 1
  if [ -z "${IN_RENEWER:-}" ]; then
    [ -z "${GATE_PUSH_TEST_TAKE_MARK:-}" ] || : >"$GATE_PUSH_TEST_TAKE_MARK"
    [ -z "${GATE_PUSH_TEST_TAKE_DELAY_S:-}" ] || sleep "$GATE_PUSH_TEST_TAKE_DELAY_S"
  fi
  echo "$new"
}
# ---- main's verdict: is it red? (for --red-main, and to check another machine's claim) ---------------------------------------
# Red means the newest of the last 20 commits on main whose CI statuses (local-ci/* and report-ci/*, gating or not) are all
# finished has a local-ci/* one that failed. A report-only (report-ci/*) failure is never red: it does not gate, so it must not
# put a --red-main push ahead of the queue. Read from GitHub's statuses, never from anyone's word. Prints "<sha> <failed contexts>"
# when red; nothing when green, unknown or unreadable (unknown is never red). One look per run, kept. A commit CI never
# tested is no verdict and is walked past: no local-ci/ status (nothing yet, or only report-ci/superseded), or, with no
# failure, a local-ci/ status that says "not tested:" (its run was cancelled; that error is never a failure).
RED_SHA="" RED_SAID="" RED_CACHE="" RED_LOOKED=0 RED_MARKER="" RED_MARKED=0
# why the last look found no red: "unreadable <sha7>", "green <sha7>" or "none" (no finished run in reach). red_verdict runs in a
# subshell or a background step, so it leaves this in a file, as the renewer does LEASE_FILE; only --red-main's refusal reads it
RED_WHY_FILE="$GIT_DIR_ABS/talos-red.why"
# owner/name of a GitHub remote; an https address may carry credentials (https://<user or token>@github.com/...), never echoed
repo_slug() { git remote get-url "$REMOTE" 2>/dev/null | sed -nE 's#^(https://([^/@]*@)?github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+/[^/]+)$#\3#p' | sed 's/\.git$//'; }
stand_in_ok() {
  local f u
  f="$(git remote get-url "$REMOTE" 2>/dev/null)" && [ -d "$f" ] || return 1
  while IFS= read -r u; do [ "$u" = "$f" ] || return 1; done < <(git remote get-url --push --all "$REMOTE" 2>/dev/null)
}
statuses_of() { # <sha>: "<context><TAB><state><TAB><description>" lines, the latest per context
  local slug dir
  dir="${GATE_PUSH_TEST_STATUSES:-}"
  # the tests' statuses, only for a remote whose fetch and every push address are one local folder: a real push always
  # reads GitHub (a local mirror to fetch from with GitHub to push to does not count)
  if [ -n "$dir" ] && stand_in_ok; then
    [ ! -e "$dir/$1.unreadable" ] || return 1
    cat "$dir/$1" 2>/dev/null
    return 0
  fi
  slug="$(repo_slug)"
  [ -n "$slug" ] || return 1
  perl -e 'alarm shift; exec @ARGV or exit 127' 30 gh api "repos/$slug/commits/$1/status?per_page=100" --jq '.statuses[] | [.context, .state, .description] | @tsv' 2>/dev/null
}
red_verdict() {
  local sha rows ci failed
  echo none >"$RED_WHY_FILE" 2>/dev/null
  for sha in $(git rev-list --first-parent -n 20 "refs/remotes/$REMOTE/$BRANCH" 2>/dev/null); do
    rows="$(statuses_of "$sha")" || { echo "unreadable ${sha:0:7}" >"$RED_WHY_FILE" 2>/dev/null; return 0; }
    ci="$(grep -E '^(local-ci|report-ci)/' <<<"$rows")"
    grep -q '^local-ci/' <<<"$ci" || continue # no CI run on this commit (nothing yet, or skipped as superseded)
    ! awk -F'\t' '$2 == "pending" { f = 1 } END { exit !f }' <<<"$ci" || continue # not finished
    failed="$(awk -F'\t' '$1 ~ /^local-ci\// && ($2 == "failure" || $2 == "error") && index($3, "not tested:") != 1 { print $1 }' <<<"$ci" | paste -sd, -)"
    [ -n "$failed" ] || ! awk -F'\t' '$1 ~ /^local-ci\// && index($3, "not tested:") == 1 { f = 1 } END { exit !f }' <<<"$ci" ||
      continue # cancelled before it reported: not tested
    [ -z "$failed" ] || echo "$sha $failed"
    [ -n "$failed" ] || echo "green ${sha:0:7}" >"$RED_WHY_FILE" 2>/dev/null
    return 0 # the newest finished run decides, red or green
  done
}

# the queue for the lease, and the wait for it (lease_take): a Ctrl-C while it waits always ends the run there
. scripts/gate/lease-wait.sh
lease_renew() { # before it can run out: a new lease over the one held
  local got
  [ -n "$LEASE" ] || return 0
  [ $((LEASE_UNTIL - $(date +%s))) -gt $((LEASE_S / 2)) ] && return 0
  if got="$(lease_put "$LEASE")"; then
    LEASE="$got"
    LEASE_UNTIL=$(($(date +%s) + LEASE_S))
    return 0
  fi
  # not where we left it: a renewal of our own may have moved it (this machine, this run): adopt that one and renew it
  local seen who pid
  seen="$(lease_seen)"
  IFS="|" read -r _ who pid <<<"$( [ -n "$seen" ] && lease_info "$seen")"
  if [ -n "$seen" ] && [ "$who" = "$MACHINE" ] && [ "$pid" = "$$" ] && got="$(lease_put "$seen")"; then
    LEASE="$got"
    LEASE_UNTIL=$(($(date +%s) + LEASE_S))
  else
    say "the push lease could not be renewed (another machine may hold it now): going on without it"
    LEASE=""
  fi
}
# While the gate runs (it can take longer than the lease), a background loop renews the lease every RENEW_EVERY_S, over
# exactly the one it last set (--force-with-lease), and writes the new one to LEASE_FILE. Lost (another machine took it): it
# says so, empties the file and stops; the gate goes on without a lease and nothing of the other machine's is touched. It is
# stopped after the gate and on any exit; a renewal it is in the middle of is finished first (TERM waits for it).
RENEWER=""
renewer_start() {
  [ -n "$LEASE" ] || return 0
  printf '%s\n' "$LEASE" >"$LEASE_FILE"
  rm -f "$LEASE_FILE.stop" "$LEASE_FILE.busy"
  (
    nap="" stop="" IN_RENEWER=1
    # Stopped: only marked here. A renewal in flight (its push may already have moved the lease) is finished and written to
    # LEASE_FILE first, so the release that follows names the lease that is really there; exiting in the middle left the
    # old one in the file, the release then failed, and the lease stayed held until it ran out. The nap goes at once.
    # The stop file says it too: a TERM that comes while this shell is in a $(...) can be lost (see lease-wait.sh). The busy
    # file is there while a renewal is in flight, so renewer_stop knows what it may end at once.
    trap 'stop=1; [ -z "$nap" ] || kill "$nap" 2>/dev/null' TERM
    while [ -z "$stop" ] && [ ! -e "$LEASE_FILE.stop" ]; do
      sleep "$RENEW_EVERY_S" </dev/null >/dev/null 2>&1 &
      nap=$!
      [ -z "$stop" ] && [ ! -e "$LEASE_FILE.stop" ] || kill "$nap" 2>/dev/null # a stop that came just before the nap began
      wait "$nap"
      nap=""
      [ -z "$stop" ] && [ ! -e "$LEASE_FILE.stop" ] || break
      : >"$LEASE_FILE.busy"
      cur="$(cat "$LEASE_FILE" 2>/dev/null)"
      [ -n "$cur" ] || { rm -f "$LEASE_FILE.busy"; exit 0; }
      if got="$(lease_put "$cur")"; then
        printf '%s\n' "$got" >"$LEASE_FILE.tmp" && mv "$LEASE_FILE.tmp" "$LEASE_FILE"
      else
        say "the push lease was lost while the gate ran (another machine holds it now): going on without it"
        : >"$LEASE_FILE"
        rm -f "$LEASE_FILE.busy"
        exit 0
      fi
      rm -f "$LEASE_FILE.busy"
    done
    exit 0
  ) &
  RENEWER=$!
}
renewer_stop() {
  local n=0
  [ -n "$RENEWER" ] || return 0
  : >"$LEASE_FILE.stop"
  kill "$RENEWER" 2>/dev/null
  # Bounded: a renewer that lost its TERM must not hold this up for good (nor the EXIT trap). A renewal in flight is given
  # up to 60 s to finish; a renewer that is only napping gets 1 s to see the stop, then it and its nap are ended.
  while kill -0 "$RENEWER" 2>/dev/null; do
    if [ "$n" -ge 600 ] || { [ "$n" -ge 10 ] && [ ! -e "$LEASE_FILE.busy" ]; }; then
      (step_kill KILL "$RENEWER")
      break
    fi
    sleep 0.1
    n=$((n + 1))
  done
  wait "$RENEWER" 2>/dev/null
  RENEWER=""
  LEASE="$(cat "$LEASE_FILE" 2>/dev/null)"
  rm -f "$LEASE_FILE" "$LEASE_FILE.stop" "$LEASE_FILE.busy"
  [ -z "$LEASE" ] || LEASE_UNTIL=$(($(date +%s) + LEASE_S / 2)) # not known exactly here: renew before the push to be sure
}
lease_release() {
  local seen who pid
  [ -n "$LEASE" ] || return 0
  if git push -q --force-with-lease="$LOCK:$LEASE" "$REMOTE" ":$LOCK" >/dev/null 2>&1; then
    LEASE=""
    return 0
  fi
  # not the one we think we hold: when what is there is still ours (this machine, this run), it goes too, by its own sha;
  # another machine's is left alone. Kept when the delete fails: the next take sees it is ours and takes it over.
  seen="$(lease_seen)"
  [ -n "$seen" ] || { LEASE=""; return 0; }
  IFS="|" read -r _ who pid <<<"$(lease_info "$seen")"
  if [ "$who" = "$MACHINE" ] && [ "$pid" = "$$" ] &&
    git push -q --force-with-lease="$LOCK:$seen" "$REMOTE" ":$LOCK" >/dev/null 2>&1; then
    LEASE=""
  elif [ "$who" != "$MACHINE" ] || [ "$pid" != "$$" ]; then
    LEASE="" # another machine's now: nothing of ours to let go
  fi
}
trap 'renewer_stop; lease_release; waiter_leave; handoff_back; rm -f "$STEP_OUT"' EXIT
# while it waits for the lease the trap only notes the signal, and the wait ends the run (scripts/gate/lease-wait.sh)
trap 'STOPPED=1; [ -n "$WAITING" ] || exit 130' INT TERM

# ---- one pass of the gate, stamped ----------------------------------------------------------------------------------------
plan_of() { bash scripts/gate.sh --plan --base "$1" 2>/dev/null; }
gate_and_stamp() { # gate_and_stamp <base> <full|cheap> <sha>: gates the tree of <sha>, which must still be HEAD and on disk after
  local base="$1" mode="$2" sha="$3" plan t0=$SECONDS jump=""
  # a checked red-main fix goes ahead of queued CI, the only gate that does: those CI runs judge the commits it turns green
  if [ "$mode" != cheap ] && [ "$RED_MAIN" = 1 ] && [ -n "${RED_SHA:-}" ]; then
    jump=1
    say "red-main: this gate goes ahead of queued CI for the heavy lock (a running job is never stopped)"
  fi
  if [ "$mode" = cheap ]; then bash scripts/gate.sh --base "$base" --checks-only || refuse "the gate failed (above)"
  else
    if [ -n "$GATE_MODE" ]; then say "the fast gate where this change allows it (gate.sh --fast says which, and why); --full for the full gate"
    else say "the full gate (--full)"; fi
    # failures already red on main's tip: what main's CI names failing goes to the gate, which may excuse them (gate-excuse.sh)
    local ex=() why=""
    EXCUSED="" EXCUSED_MAIN=""
    if why="$(excuse_prepare)"; then ex=(GATE_EXCUSE_MAIN="$EXCUSE_MAIN" GATE_EXCUSE_OUT="$EXCUSE_OUT"); fi
    env ${ex[@]+"${ex[@]}"} HEAVY_LOCK_PUSH=1 HEAVY_LOCK_JUMP="$jump" bash scripts/gate.sh --base "$base" ${GATE_MODE:+"$GATE_MODE"} ||
      refuse "the gate failed (above)${why:+; no failure could be excused: $why}"
    if [ "${#ex[@]}" -gt 0 ] && [ -s "$EXCUSE_OUT" ]; then
      EXCUSED="$(cat "$EXCUSE_OUT")" EXCUSED_MAIN="$(sed -n '1s/^sha=//p' "$EXCUSE_MAIN")"
      say "$(excused_line)"
    fi
    rm -f "$EXCUSE_MAIN" "$EXCUSE_OUT"
  fi
  # a commit, or an edit to a tracked file, made while the gate ran was not gated: nothing is pushed then
  [ "$(git rev-parse HEAD)" = "$sha" ] || refuse "HEAD moved while the gate ran (a commit made meanwhile was not gated): run it again"
  [ -z "$(git status --porcelain --untracked-files=no)" ] || refuse "tracked files changed while the gate ran: commit or stash them, then run it again"
  [ "$mode" = cheap ] || printf '%s\n' "$((SECONDS - t0))" >"$GATE_TIME" # a full touched gate's time sizes the next lease
  if [ "$mode" != cheap ]; then GATE_SECS=$((GATE_SECS + SECONDS - t0)); GATE_BASES="${GATE_BASES:+$GATE_BASES,}$base"; fi # for push_log
  # the plan the stamp carries: one that could not be made is no stamp, and no push (the hook would compare against nothing)
  plan="$(plan_of "$base")" && [ -n "$plan" ] || refuse "the gate passed, but its plan could not be printed for the stamp: nothing is pushed"
  {
    echo "tree=$(git rev-parse "$sha^{tree}")"
    echo "base=$base"
    echo "plan=$(printf '%s' "$plan" | sha256_of)"
    echo "gate=$(gate_sha)"
    echo "hook=$(sha256 scripts/pre-push.sh)"
    echo "mode=$mode"
    echo "at=$(date +%s)"
    # what passed only by the excuse, and the main it was red on (the full gate's; a cheap pass after it keeps them)
    [ -z "$EXCUSED" ] || { echo "excused_main=$EXCUSED_MAIN"; printf '%s\n' "$EXCUSED" | sed 's/^/excused=/'; }
  } >"$STAMP.tmp" && mv "$STAMP.tmp" "$STAMP"
}

# ---- failures already red on main (docs/CI-MACHINES.md, "Failures already red on main") ------------------------------------
# excuse_prepare: the tests failing on main's tip, from its newest finished CI verdict (red_verdict: GitHub's statuses) and that
# run's own logs on this machine, read by the alert's parser (scripts/ci-alert-tests.pl), written to EXCUSE_MAIN for the gate
# as "<test><TAB><its file>" (gate-excuse.pl reads the file from the same log: a bun test's name alone does not say which file,
# and two files may hold one name). A test whose file the log does not say is left out. Fails closed, printing why: main not
# red (or its statuses unreadable), a red local-ci job whose log is not here or names no test. A report-ci red names none.
EXCUSE_MAIN="$GIT_DIR_ABS/talos-gate.main-red" EXCUSE_OUT="$GIT_DIR_ABS/talos-gate.excused" EXCUSED="" EXCUSED_MAIN=""
excuse_prepare() {
  local v sha ctx job log names pairs all="" cache="${TALOS_CI_CACHE:-$HOME/.cache/talos-ci}" roots
  rm -f "$EXCUSE_MAIN" "$EXCUSE_OUT"
  [ -f scripts/ci-alert-tests.pl ] && [ -f scripts/gate-excuse.pl ] || { echo "the log readers are missing"; return 1; }
  v="$(red_verdict)"
  [ -n "$v" ] || { echo "main has no red verdict (its newest finished CI run passed, or its statuses could not be read)"; return 1; }
  sha="${v%% *}"
  roots="$(sed -n 's/^VITEST_ROOTS="\(.*\)"$/\1/p' scripts/gate.sh)" # the gate's Vitest roots: names in the gate's one form
  for ctx in $(tr ',' ' ' <<<"${v#* }"); do
    case "$ctx" in local-ci/*) ;; *) continue ;; esac
    job="${ctx#local-ci/}"
    case "$job" in '' | *[!A-Za-z0-9._-]*) echo "main's red job $ctx is not a job name this can read"; return 1 ;; esac
    log="$cache/logs/${sha:0:7}-$job.log"
    # shellcheck disable=SC2086 # the roots, one argument each
    names="$(perl scripts/ci-alert-tests.pl "$log" 2>/dev/null | perl scripts/gate-excuse.pl --canon $roots)"
    [ -f "$log" ] && [ -n "$names" ] || { echo "main's red job $job at ${sha:0:7} names no failing test here ($log)"; return 1; }
    # each test the alert names, with the file the same log says it is in
    # shellcheck disable=SC2086
    pairs="$(perl scripts/gate-excuse.pl "$log" $roots | awk -F'\t' 'NR == FNR { a[$0]; next } $1 == "test" && $3 != "" && ($2 in a) { print $2 "\t" $3 }' \
      <(printf '%s\n' "$names") -)"
    [ -z "$pairs" ] || all="$all$pairs"$'\n'
  done
  [ -n "$all" ] || { echo "main is red at ${sha:0:7}, but no failing test of its local-ci jobs (${v#* }) can be told by name and file here"; return 1; }
  { echo "sha=$sha"; printf '%s' "$all" | LC_ALL=C sort -u; } >"$EXCUSE_MAIN" || { echo "main's failing tests could not be written down"; return 1; }
}
excused_line() { # the one line that says what was excused, and why
  printf 'EXCUSED %s failure(s), failing on main at %s (its newest finished CI verdict) and not reached directly by this change: %s' \
    "$(printf '%s\n' "$EXCUSED" | grep -c .)" "${EXCUSED_MAIN:0:7}" "$(printf '%s\n' "$EXCUSED" | awk -F'\t' 'NF { printf "%s%s (%s)", s, $1, $2; s = "; " }')"
}

# After the rebase onto <new>, when the branch moved there from <old>: cheap only when what it brought is words (docs/, a
# Markdown file at the top), none of it is this change's, and this change runs no test suite at all (tests in every project
# read docs from disk). Anything else, or a diff that cannot be read, is the full touched set.
# The first of the new commits (<old>..<new>) to touch <path...>, or the newest of them: "<sha7> <subject>".
first_touch() {
  local c
  c="$(git --literal-pathspecs log --reverse --format='%h %s' "$1..$2" -- "${@:3}" 2>/dev/null | head -1)"
  [ -n "$c" ] || c="$(git log -1 --format='%h %s' "$2" 2>/dev/null)"
  printf '%s' "${c:-$2}"
}

# changed_names <git diff args...>: the paths that differ, one per line, read NUL-separated (-z) so that none is ever git's quoted
# C string (a non-ASCII letter, a tab, a quote or a backslash in a name; for non-ASCII, whatever core.quotePath says), which the
# patterns below would not match. A name with a newline in it cannot be one line: exit 3, and every caller fails closed. (A name
# holding byte 036, the stand-in for a newline here, is taken for one: a refusal too, never a pass.)
changed_names() {
  local out
  out="$(git diff -z --no-renames --name-only "$@" | tr '\n\000' '\036\n')" || return 1
  case "$out" in *$'\036'*) return 3 ;; esac
  printf '%s\n' "$out"
}

# race_mode <old> <new>: how to treat this change when main moved from <old> to <new> under its gate. Prints "full: <why>"
# or "cheap: <why>", the why naming the commit that decided it. cheap: its passing run stands and only typecheck, lint,
# personal, size and timing run again, under the lease. full: the touched set runs again, without the lease. Any doubt is full.
race_mode() {
  local old="$1" new="$2" f mine plan theirs n suites
  plan="$(plan_of "$new")" && [ -n "$plan" ] || { echo "full: no plan for this change (main moved to $(first_touch "$old" "$new"))"; return; }
  mine="$(changed_names "$new" HEAD)" ||
    { echo "full: cannot list this change (main moved to $(first_touch "$old" "$new"))"; return; }
  theirs="$(changed_names "$old" "$new")" ||
    { echo "full: cannot list the new commits (main moved to $(first_touch "$old" "$new"))"; return; }
  [ -n "$theirs" ] || { echo "full: the new commits change no file ($(first_touch "$old" "$new"))"; return; }
  n="$(git rev-list --count "$old..$new" 2>/dev/null || echo '?')"
  f="$(swift_touched "$plan" "$theirs")" && { echo "full: $(first_touch "$old" "$new" "$f") changes $f, in a Swift package this change builds"; return; }
  # A change only to the e2e package (its specs, harness or config) was gated by running those specs on the old base. When
  # every new commit is in a place the specs never run or build (an allow-list: words, the Windows, Mac and iPhone apps,
  # evals, CI config, the shell scripts and their tests), what they saw is unchanged and the passing run stands: the cheap
  # checks only. Anything else (the product, packages, the kit, vendored tools, build scripts, configs) runs them again.
  # (Without this, a harness change on a busy main ran the whole e2e suite again for every unrelated commit.)
  if [ -n "$mine" ] && ! grep -qv '^e2e/' <<<"$mine"; then
    if f="$(grep -Evm1 '^(docs/.*|[^/]+\.md|apps/(windows|desktop|mobile)/.*|evals/.*|\.github/.*|scripts/[^/]+\.sh|scripts/[^/]+\.test\.ts)$' <<<"$theirs")"; then
      echo "full: $(first_touch "$old" "$new" "$f") changes $f, which the e2e specs run or build"
      return
    fi
    echo "cheap: an e2e-only change, and the $n new commit(s) touch nothing the specs run"
    return
  fi
  # a change that ran any suite: the new commits may reach it (tests read and import across the tree), so it runs again
  suites="$(grep -Ev $'^(typecheck|lint|personal|size|timing|swift build \\(.*|swift parse \\(.*|\t.*)$' <<<"$plan" | paste -sd, -)"
  if [ -n "$suites" ]; then
    echo "full: $n new commit(s), first $(first_touch "$old" "$new"), and this change ran ${suites}"
    return
  fi
  # words only on this side: the new commits run again only when they touch the same file, or anything but words
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if grep -Fxq -- "$f" <<<"$mine"; then echo "full: $(first_touch "$old" "$new" "$f") changes $f too"; return; fi
    case "$f" in
      docs/*) ;;
      */*) echo "full: $(first_touch "$old" "$new" "$f") changes $f" && return ;;
      *.md) ;;
      *) echo "full: $(first_touch "$old" "$new" "$f") changes $f" && return ;;
    esac
  done <<<"$theirs"
  echo "cheap: words on both sides, none the same file ($n new commit(s))"
}

# ---- the rebase-clean pass (docs/CI-MACHINES.md, "Rebase-clean pass") -----------------------------------------------------
# When race_mode says full, one more look: a clean rebase (rebase_onto stops on a conflict), no new main commit touching a file of
# this change, and none touching a gate-wide input (scripts/gate-wide-inputs.txt: the gate itself and the build and test config; any
# other gate input refuses only on a shared file) means the passing gate stands: only the cheap
# checks run, and the push says so, in its output and in <cache>/logs/rebase-pass.tsv with the main commits it skipped a full gate
# over, so a later red main can be traced to it. Anything else is a refusal: the full gate, as before, waiting behind CI like any
# gate however often it is refused (only a checked red-main gate goes ahead of CI).
PASS_LOG="${TALOS_CI_CACHE:-$HOME/.cache/talos-ci}/logs/rebase-pass.tsv"
SKIPPED_OVER="" # the main commits this run's rebase-clean passes skipped a full gate over
pass_log() { # pass_log <pass|pass-words|refused|excused> <sha> <commits> <detail>: UTC time, machine, kind, sha, commits, detail. Append only.
  mkdir -p "$(dirname "$PASS_LOG")" 2>/dev/null || return 0
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$MACHINE" "$1" "$2" "$3" "$(printf '%s' "$4" | tr '\t\n' '  ')" \
    >>"$PASS_LOG" 2>/dev/null || true
}
GATE_SECS=0 GATE_BASES="" # the seconds all this run's full gates took (heavy-lock wait included) and the base each ran on
push_log() { # push_log <sha> <requeues> <races>: one row in lock-waits.tsv when a push lands, for scripts/push-latency.ts (lock wait, gate, re-gates apart)
  local f="${TALOS_CI_CACHE:-$HOME/.cache/talos-ci}/logs/lock-waits.tsv"
  mkdir -p "$(dirname "$f")" 2>/dev/null || return 0
  # gate=<folder>: the label of this checkout's own lock rows (gate.sh: gate (<folder>)), so another builder's gate on the same base is not counted
  printf '%s\tpush\tpushed %s requeues=%s races=%s gate=%s bases=%s\t%s\tgot\tpushed\n' "$(date -u +%FT%TZ)" "$1" "$2" "$3" \
    "$(basename "$PWD" | tr -c 'A-Za-z0-9._\n-' '_')" "$GATE_BASES" "$GATE_SECS" >>"$f" 2>/dev/null || true
}
rebase_clean() { # rebase_clean <old> <new>, after the rebase onto <new>: 0 when the pass applies; prints why, either way
  local old="$1" new="$2" mine theirs pats f rc left n words
  # The GATE-WIDE list (scripts/gate-wide-inputs.txt: the gate itself and the build and test config, the part of the gate inputs
  # that changes how every test runs) as it was on <old>, the main the gate passed on: neither a new main commit nor this change
  # can loosen it for this push (an edit to it is itself gate-wide). Any other gate input (another script, a scripts/*.test.ts, a
  # workflow) refuses only on a file this change shares, which the loop below already checks.
  pats="$(git show "$old:scripts/gate-wide-inputs.txt" 2>/dev/null | grep -v '^#' | grep -v '^[[:space:]]*$')"
  [ -n "$pats" ] || { echo "no gate-wide list (scripts/gate-wide-inputs.txt) on the main the gate passed on: fails closed"; return 1; }
  mine="$(changed_names "$new" HEAD)" && [ -n "$mine" ] ||
    { echo "cannot list this change"; return 1; }
  theirs="$(changed_names "$old" "$new")" && [ -n "$theirs" ] ||
    { echo "cannot list the new commits, or they change no file"; return 1; }
  f="$(swift_touched "$(plan_of "$new")" "$theirs")" && { echo "$(first_touch "$old" "$new" "$f") changes $f, in a Swift package this change builds"; return 1; }
  # Both compared folded (path-fold.sh): on a Mac "Scripts/x.sh" is scripts/x.sh, and an "é" composed or not is one file.
  # changed_names has refused a name with a newline, so a line is a name: NUL-separated again for the one node process.
  # A file both sides changed is a refusal, but for words (a Markdown file under docs/, or at the top) that no test reads: those
  # were merged by the rebase without a conflict (rebase_onto stops on one), and nothing the gate ran reads them. Each shared
  # name is taken off the new commits' list in turn, so every one of them is looked at.
  left="$theirs" words=()
  while [ -n "$left" ]; do
    f="$(printf '%s\n' "$left" | tr '\n' '\000' | path_fold same <(printf '%s\n' "$mine" | tr '\n' '\000'))"
    rc=$?
    [ "$rc" != 1 ] || break
    [ "$rc" = 0 ] || { echo "this change's files could not be compared: fails closed"; return 1; }
    case "$f" in
      docs/*.md) ;;
      */*) echo "$(first_touch "$old" "$new" "$f") changes $f, a file of this change" && return 1 ;;
      *.md) ;;
      *) echo "$(first_touch "$old" "$new" "$f") changes $f, a file of this change" && return 1 ;;
    esac
    # spelled the same on both sides (the readers are asked by name, and docs/SETUP.md is one exact name), and not a protected
    # path (docs/protected-paths.txt as <old> has it, a line naming the file or a folder above it; one that cannot be read lets
    # no words through)
    grep -Fxq -- "$f" <<<"$mine" ||
      { echo "$(first_touch "$old" "$new" "$f") changes $f, a file of this change (spelled otherwise here)"; return 1; }
    git show "$old:docs/protected-paths.txt" >/dev/null 2>&1 && ! git show "$old:docs/protected-paths.txt" |
      sed 's#^[[:space:]]*##; s#/*[[:space:]]*$##' | awk -v f="$f" '$0 != "" && $0 !~ /^#/ && (f == $0 || index(f, $0 "/") == 1) { h = 1 } END { exit !h }' ||
      { echo "$(first_touch "$old" "$new" "$f") changes $f, a file of this change and a protected path (or the list cannot be read)"; return 1; }
    words+=("$f")
    left="$(printf '%s\n' "$left" | grep -Fxv -- "$f")"
  done
  f="$(printf '%s\n' "$theirs" | tr '\n' '\000' | path_fold inputs <(printf '%s\n' "$pats"))"
  rc=$?
  [ "$rc" = 0 ] || [ "$rc" = 1 ] || { echo "the gate-wide list could not be read or matched: fails closed"; return 1; }
  [ "$rc" != 0 ] || { echo "$(first_touch "$old" "$new" "$f") changes $f, a gate-wide input"; return 1; }
  n="$(git rev-list --count "$old..$new" 2>/dev/null || echo '?')"
  if [ "${#words[@]}" -gt 0 ]; then
    # the gate's own rules say which tests read them (gate.sh --readers: by name, by a gate-reads pattern, the bridge suite's
    # docs); one that does, or an answer that cannot be had, is the refusal it was before
    f="$(bash scripts/gate.sh --readers "${words[@]}" 2>/dev/null)" ||
      { echo "$(first_touch "$old" "$new" "${words[0]}") changes ${words[0]}, a file of this change, and its readers could not be listed"; return 1; }
    if [ -n "$f" ]; then
      f="$(head -1 <<<"$f")"
      echo "$(first_touch "$old" "$new" "${f##* <- }") changes ${f##* <- }, a file of this change that a test reads (${f% <- *})"
      return 1
    fi
    echo "$n main commit(s), none touching a gate-wide input; shared with this change only words no test reads: $(printf '%s, ' "${words[@]}" | sed 's/, $//')"
    return 0
  fi
  echo "$n main commit(s), none touching a file of this change or a gate-wide input"
}

# pass_readers <old> <new>, after the rebase onto <new>, for a gate that stands (the rebase-clean pass, or race_mode's cheap): the
# tests that read files of this change or of the new main commits still run (a doc test that cites relay test names met a rename
# only in CI: a code file's readers are planned for no code change). gate.sh --readers is asked about each side apart and every
# test either names runs (vitest, under the lease's renewer). Refused, to the full gate: a reader in apps/bridge or apps/relay or a
# marked Playwright spec (heavy lock); both sides reaching the bridge suite (a "whole bridge suite" line, or a changed bridge test)
# with no bridge test run on the two together; a failing test; a list that cannot be had, or more than GATE_PUSH_READERS_MAX files.
# spec_readers <old> <file>...: "<spec> <- <file>" (the first) for a Playwright spec (*.spec.ts) with a `// gate-reads: <pattern>...`
# line (the guards' mark: case patterns, * matches /) that matches a file. --readers cannot report a spec (it searches *.test.ts, and
# a spec names no path of the code it drives), so a spec that must re-run when a file changes carries the mark. Marks are the union
# of those on <old> and on HEAD, so neither side can drop one and loosen its own push. Exit 0: one is read (printed); 1: none;
# 2: git could not say (a failing git grep, an unreadable spec), which the caller refuses on.
spec_readers() {
  local old="$1" rev out rc sp path text f p
  shift
  for rev in "$old" HEAD; do
    out="$(git grep -lE '^// gate-reads:' "$rev" -- '*.spec.ts' 2>/dev/null)"
    rc=$?
    [ "$rc" = 0 ] || [ "$rc" = 1 ] || return 2 # 1 is "no match"; anything else is git failing, never "no spec"
    while IFS= read -r sp; do # "<rev>:<path>"
      [ -n "$sp" ] || continue
      path="${sp#*:}"
      text="$(git show "$sp" 2>/dev/null)" || return 2
      for p in $(printf '%s\n' "$text" | sed -n 's#^// gate-reads:##p'); do
        for f in "$@"; do
          # shellcheck disable=SC2254 # $p unquoted on purpose: it is the pattern
          case "$f" in $p) printf '%s <- %s\n' "$path" "$f"; return 0 ;; esac
        done
      done
    done <<<"$out"
  done
  return 1
}
READERS_MAX="${GATE_PUSH_READERS_MAX:-150}"
readers_of() { # readers_of <file>...: gate.sh --readers' answer, asked twice at most (a search killed under load answers the second time)
  local o
  o="$(bash scripts/gate.sh --readers "$@" 2>/dev/null)" || { sleep 2; o="$(bash scripts/gate.sh --readers "$@" 2>/dev/null)"; } || return 1
  printf '%s\n' "$o"
}
pass_readers() {
  local mine theirs mf=() tf=() all f out_m out_t tests=() t bm=0 bt=0 rc
  mine="$(changed_names "$2" HEAD)" && theirs="$(changed_names "$1" "$2")" ||
    { echo "cannot list this change or the new commits, so which tests read their files cannot be told: fails closed"; return 1; }
  while IFS= read -r f; do [ -n "$f" ] && mf+=("$f"); done < <(printf '%s\n' "$mine" | LC_ALL=C sort -u)
  while IFS= read -r f; do [ -n "$f" ] && tf+=("$f"); done < <(printf '%s\n' "$theirs" | LC_ALL=C sort -u)
  [ "${#mf[@]}" -gt 0 ] && [ "${#tf[@]}" -gt 0 ] || { echo "no file to ask the readers about: fails closed"; return 1; }
  all="$(printf '%s\n%s\n' "$mine" "$theirs" | LC_ALL=C sort -u | grep -c .)"
  [ "$all" -le "$READERS_MAX" ] ||
    { echo "$all files in this change and the new main commits: too many to ask which tests read them (more than $READERS_MAX)"; return 1; }
  out_m="$(readers_of "${mf[@]}")" && out_t="$(readers_of "${tf[@]}")" ||
    { echo "which tests read these files could not be told (gate.sh --readers failed): fails closed"; return 1; }
  grep -q '^the whole bridge suite <- ' <<<"$out_m" && bm=1
  grep -q '^the whole bridge suite <- ' <<<"$out_t" && bt=1
  # a changed bridge test runs itself, so --readers says nothing of the suite for it; it is still the bridge
  for f in "${mf[@]}"; do case "$f" in apps/bridge/test/*.test.ts) bm=1 ;; esac; done
  for f in "${tf[@]}"; do case "$f" in apps/bridge/test/*.test.ts) bt=1 ;; esac; done
  [ "$bm" = 0 ] || [ "$bt" = 0 ] || { echo "both this change and main's new commits reach the bridge suite: the full gate runs it on the two together"; return 1; }
  # a Playwright spec that reads a file of either side (its own mark) runs only under the heavy lock, in CI's browser jobs
  set -f
  t="$(spec_readers "$1" "${mf[@]}" "${tf[@]}")"
  rc=$?
  set +f
  [ "$rc" != 2 ] || { echo "which Playwright specs read these files could not be told (git grep failed): fails closed"; return 1; }
  [ -z "$t" ] || { echo "${t%% <- *} (a Playwright spec) reads ${t##* <- }, a file of this change or of the new main commits, and needs the heavy lock: the pass does not apply"; return 1; }
  while IFS= read -r t; do [ -n "$t" ] && tests+=("$t"); done < <(printf '%s\n%s\n' "$out_m" "$out_t" | sed -n 's/ <- .*$//p' | grep -vx 'the whole bridge suite' | LC_ALL=C sort -u)
  [ "${#tests[@]}" -gt 0 ] || { echo "no test reads them"; return 0; }
  for t in "${tests[@]}"; do
    case "$t" in apps/bridge/* | apps/relay/*)
      echo "$t reads files of this change or of the new main commits and needs the heavy lock: the pass does not apply"
      return 1
      ;;
    esac
  done
  pnpm exec vitest run "${tests[@]}" >&2 </dev/null ||
    { echo "a test that reads files of this change or of the new main commits failed ($(printf '%s, ' "${tests[@]}" | sed 's/, $//'))"; return 1; }
  echo "${#tests[@]} test(s) that read them passed"
}

ROUTE_HINT="Push a plain branch instead; the landing machine reads the scripts/ diff itself and lands it by cherry-pick (that read is the trust step)."
# handoff_belt <main sha>: 0 when HEAD equals <main> in every gate input (<main>'s list); else prints why, returns 1
handoff_belt() {
  local pats f rc
  pats="$(git show "$1:scripts/gate-inputs.txt" 2>/dev/null)" && [ -n "$pats" ] || { echo "(no gate-inputs list on ${1:0:7})"; return 1; }
  f="$(path_fold_git <(printf '%s\n' "$pats") diff -z --name-only --no-renames "$1" HEAD --)"
  rc=$?
  [ "$rc" = 1 ] && return 0
  if [ "$rc" = 0 ]; then echo "$f, a gate input"; else echo "(the trees could not be compared: exit $rc)"; fi
  return 1
}

# tests: what race_mode says for <old>,<new> (scripts/gate-push.test.ts), and nothing else
if [ -n "${GATE_PUSH_PRINT_RACE:-}" ]; then
  out="$(race_mode "${GATE_PUSH_PRINT_RACE%%,*}" "${GATE_PUSH_PRINT_RACE#*,}")"
  if [ -n "${GATE_PUSH_PRINT_RACE_WHY:-}" ]; then echo "$out"; else echo "${out%%:*}"; fi
  exit 0
fi

# tests: what rebase_clean says for <old>,<new> (scripts/gate-paths.test.ts), and its exit, and nothing else
if [ -n "${GATE_PUSH_PRINT_CLEAN:-}" ]; then
  rc=0
  rebase_clean "${GATE_PUSH_PRINT_CLEAN%%,*}" "${GATE_PUSH_PRINT_CLEAN#*,}" || rc=$?
  echo "rc=$rc"
  exit 0
fi

# tests: what handoff_belt says for HEAD against <main> (scripts/gate-paths.test.ts), and its exit, and nothing else
if [ -n "${GATE_PUSH_PRINT_BELT:-}" ]; then
  rc=0
  handoff_belt "$GATE_PUSH_PRINT_BELT" || rc=$?
  echo "rc=$rc"
  exit 0
fi

# ---- the push -------------------------------------------------------------------------------------------------------------
rebasing && refuse "a rebase is in progress: finish or abort it first"
[ -z "$(git status --porcelain --untracked-files=no)" ] || refuse "there are uncommitted changes: the gate checks the files on disk, so commit or stash them"

TRACK="refs/remotes/$REMOTE/$BRANCH"
git fetch -q "$REMOTE" "$BRANCH" 2>/dev/null || true
[ "$FROM_GIVEN" = 0 ] || [ -n "$FROM" ] || refuse "--from takes $REMOTE/handoff/<machine>/<name>, and none was given"
if [ -n "$FROM" ]; then
  # <remote>/handoff/<machine>/<name> exactly: never main, never any other branch
  printf '%s\n' "$FROM" | grep -Eqx "$REMOTE/handoff/[A-Za-z0-9._-]{1,63}/[A-Za-z0-9._-]{1,80}" ||
    refuse "--from takes $REMOTE/handoff/<machine>/<name>, not $FROM"
  HANDOFF_REF="refs/heads/${FROM#"$REMOTE"/}"
  git fetch -q "$REMOTE" "+$HANDOFF_REF:refs/remotes/$FROM" || refuse "cannot fetch $FROM"
  BACK_TO="$(git symbolic-ref -q --short HEAD || git rev-parse HEAD)"
  HANDOFF_SHA="$(git rev-parse "refs/remotes/$FROM")"
  # the handing machine may have scanned with the generic rules only: landing is where the private list must run. A machine
  # without it (Lemnos, Titan: by design, and it never goes to them) lands the handoff only on Delphi's personal-ok stamp
  # (stamp_ok), and then only while the rebase keeps every commit's patch-id (patch_ids, checked in rebase_onto).
  common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || common=""
  if [ ! -f scripts/personal-denylist.txt ] && { [ -z "$common" ] || [ ! -f "$(dirname "$common")/scripts/personal-denylist.txt" ]; } &&
    [ -z "${CHECK_EXTRA_RULES:-}" ]; then
    # The stamp, from the remote only: refs/personal-ok/<tip> is an ANNOTATED TAG object (not a branch, not a lightweight tag),
    # and `git rev-parse <tag>^{commit}` is the tip, all 40 hex. The private-list machine's stamp script (check-ref-personal.sh over
    # merge-base..tip, every commit's files and message; stamps only on exit 0) scans the tip with the private list and pushes
    # it. Fetched into a ref of this machine's own, refs/personal-ok-remote/<tip>, after any ref of that name is dropped: a local
    # ref (someone may have made one by hand) is never read as the stamp.
    why="$(stamp_ok "$HANDOFF_SHA")" ||
      refuse "landing a handoff needs the private list (scripts/personal-denylist.txt): this machine has none${why:+ and $why}, so another one lands it"
    STAMPED_IDS="$(patch_ids "$(git merge-base "$TRACK" "$HANDOFF_SHA" 2>/dev/null || echo "$TRACK")..$HANDOFF_SHA")" && [ -n "$STAMPED_IDS" ] ||
      refuse "landing a handoff needs the private list (scripts/personal-denylist.txt): this machine has none, and the patch-ids of $FROM could not be read, so another one lands it"
    say "no private list here: landing $FROM on Delphi's personal-ok stamp (${HANDOFF_SHA:0:7}); the rebase must keep every patch-id"
  fi
  # The push path itself is never handed off: the landing machine would check it with the handoff's own versions. "The push
  # path" is the one list, scripts/gate-inputs.txt (everything the gate sources, runs or reads its verdict from), as main has
  # it (never the handoff's copy), matched folded (path-fold.sh): a new "Scripts/x.sh" or a Kelvin-sign "pac<K>age.json" is
  # that file on a Mac's disk.
  # Every commit of the handoff is read, not the net diff: the rebase below replays each commit (and drops merges), so a gate
  # input one commit changes and a later one (or a merge) puts back would be on disk, and run, all the same (Fable R1-1). A
  # handoff holds no merge commit at all.
  hb="$(git merge-base "$TRACK" "$HANDOFF_SHA" 2>/dev/null)" || hb="$TRACK"
  touched="$(changed_names "$hb" "$HANDOFF_SHA")" ||
    refuse "cannot list what $FROM changes (or a file name in it holds a newline)"
  merges="$(git rev-list --merges "$hb..$HANDOFF_SHA")" || refuse "cannot list the commits of $FROM"
  [ -z "$merges" ] ||
    refuse "$FROM holds a merge commit (${merges:0:7}): a handoff is a straight line of commits on main (rebase it, then hand it off again)"
  pats="$(git show "$TRACK:scripts/gate-inputs.txt" 2>/dev/null)" && [ -n "$pats" ] ||
    refuse "no gate-inputs list (scripts/gate-inputs.txt) on $REMOTE/$BRANCH: what $FROM may change cannot be told, so it is not landed"
  f="$(path_fold_range <(printf '%s\n' "$pats") "$hb..$HANDOFF_SHA")"
  rc=$?
  [ "$rc" = 0 ] || [ "$rc" = 1 ] || refuse "what $FROM changes could not be checked against the gate-inputs list (exit $rc): it is not landed"
  [ "$rc" != 0 ] ||
    refuse "$FROM changes the push path ($f, a gate input: scripts/gate-inputs.txt), so it is not landed as a handoff. $ROUTE_HINT"
  # no git hook runs while landing (checkout, rebase, going back): .githooks is the tree's own, and a hook is code (Fable R1-2)
  git -c core.hooksPath=/dev/null checkout -q --detach "$HANDOFF_SHA" || refuse "cannot check out $FROM"
  # the author and subject are the handoff's own text: control characters (ESC included) shown as "?", never sent to the terminal
  say "landing $FROM ($(git log -1 --format='%h %an: %s' HEAD | LC_ALL=C tr '\000-\037\177' '?'))"
fi
handoff_done() { # the handoff landed: its branch goes, only if it still holds what was landed (a later commit is kept)
  [ -n "$HANDOFF_REF" ] || return 0
  if git push -q --force-with-lease="$HANDOFF_REF:$HANDOFF_SHA" "$REMOTE" ":$HANDOFF_REF" >/dev/null 2>&1; then
    say "deleted $FROM"
  else
    say "landed, but $FROM was not deleted (it moved since, or the remote refused): look at it"
  fi
}

rebase_onto() { # rebase_onto <sha>: or stop, with the rebase taken back. No git hook runs in it (Fable R1-2).
  local why
  if ! git -c core.hooksPath=/dev/null rebase -q "$1" >/dev/null 2>&1; then
    git -c core.hooksPath=/dev/null rebase --abort >/dev/null 2>&1
    refuse "the rebase onto $REMOTE/$BRANCH failed (a conflict, or a file in the way): rebase by hand, then push again"
  fi
  # a stamped handoff (no private list here): Delphi scanned these exact commits, so the rebase must have replayed each one with
  # the same patch-id, in order and in number (a commit that changed under it, or was dropped as already applied, was not
  # scanned as it now is). The same check after every rebase, the requeue rebase in the lease loop included.
  [ -z "$STAMPED_IDS" ] || [ "$(patch_ids "$1..HEAD")" = "$STAMPED_IDS" ] ||
    refuse "the rebase changed the stamped commits; a machine with the private list lands it"
  # a handoff, rebased: the belt. Whatever the checks above missed, the tree the gate is about to run may differ from main in
  # no gate input (main's list, names folded): git's own compare of the two trees.
  [ -z "$FROM" ] || why="$(handoff_belt "$1")" || refuse "after the rebase, $FROM differs from $REMOTE/$BRANCH in $why: it is not landed. $ROUTE_HINT"
}
fetch_tip() {
  git fetch -q "$REMOTE" "$BRANCH" || refuse "cannot fetch $REMOTE $BRANCH"
  git rev-parse --verify -q "$TRACK" || refuse "no $TRACK"
}

# the gate, with no lease held: however long it takes, nobody waits on it
base="$(fetch_tip)" || exit 1
# --red-main: a fix for a red main goes first in the queue, once per machine per red, and only when the statuses say red
if [ "$RED_MAIN" = 1 ]; then
  RED_CACHE="$(red_verdict)"
  RED_LOOKED=1
  if [ -z "$RED_CACHE" ]; then
    read -r why_word why_sha <"$RED_WHY_FILE" 2>/dev/null || why_word=""
    case "$why_word" in
      unreadable) refuse "--red-main: GitHub's statuses of main could not be read (at ${why_sha:-?}; gh api, or no GitHub remote): wait in line" ;;
      green) refuse "--red-main: main is not red: its newest finished CI run (${why_sha:-?}) has no failed status: wait in line" ;;
      *) refuse "--red-main: main is not red: no finished CI run on its last 20 commits: wait in line" ;;
    esac
  fi
  RED_SHA="${RED_CACHE%% *}"
  RED_MARKER="refs/locks/red-main/$MACHINE/$RED_SHA"
  if git ls-remote --exit-code "$REMOTE" "$RED_MARKER" >/dev/null 2>&1; then
    refuse "--red-main: $MACHINE went first once already for the red at ${RED_SHA:0:7}; push without --red-main to wait in line"
  fi
  say "red-main: $MACHINE goes first for red ${RED_SHA:0:7} (${RED_CACHE#* })"
fi
red_mark() { # the jump is spent once the lease is taken with it: recorded then, so a gate that failed first spends nothing
  local failed m
  [ -n "$RED_SHA" ] && [ "$RED_MARKED" = 0 ] && [ -n "$LEASE" ] || return 0
  failed="$(printf '%s' "${RED_CACHE#* }" | tr -c 'A-Za-z0-9._/,-' '-' | cut -c1-255)"
  m="$(printf 'talos red-main\n\nmachine=%s\nred=%s\nfailed=%s\nat=%s\n' "$MACHINE" "$RED_SHA" "${failed:--}" "$(date +%s)" |
    git commit-tree "$EMPTY_TREE")" && git push -q "$REMOTE" "$m:$RED_MARKER" >/dev/null 2>&1 || {
    # another run of this machine recorded it first (two worktrees at once): the cap holds, this one claims no more
    if git ls-remote --exit-code "$REMOTE" "$RED_MARKER" >/dev/null 2>&1; then
      say "red-main: another run of $MACHINE already went first for this red; this one waits in line from here"
      RED_SHA=""
    else
      say "red-main: could not record the jump ($RED_MARKER); going on"
    fi
  }
  RED_MARKED=1
}
# this machine's old jump records, for a red no longer within what red_verdict reads, can never matter again: gone
red_prune() {
  local keep r sha
  keep="$(git rev-list --first-parent -n 20 "refs/remotes/$REMOTE/$BRANCH" 2>/dev/null)"
  for r in $(git ls-remote "$REMOTE" "refs/locks/red-main/$MACHINE/*" 2>/dev/null | cut -f2); do
    sha="${r##*/}"
    grep -Fxq -- "$sha" <<<"$keep" || git push -q "$REMOTE" ":$r" >/dev/null 2>&1 || true
  done
}
red_prune
rebase_onto "$base"
sha="$(git rev-parse HEAD)"
[ "$sha" != "$base" ] || { say "nothing to push: HEAD is $REMOTE/$BRANCH"; handoff_done; exit 0; }
gate_and_stamp "$base" full "$sha"

# The lease, for the minutes the push takes. A branch that moved meanwhile: words only that touch nothing of this change,
# the cheap checks under the lease; anything else lets the lease go, runs the touched set without it, and queues again
# with the place it had (a slow machine never holds the others up with a whole gate).
stamp_age() { local at; at="$(sed -n 's/^at=//p' "$STAMP" 2>/dev/null | head -1)"; case "$at" in '' | *[!0-9]*) echo 99999 ;; *) echo $(($(date +%s) - at)) ;; esac; }
requeues=0 races=0 PASS_WORDS=""
if [ -n "$FROM" ]; then
  SLOW_HINT="run scripts/gate.sh --push --from $FROM again when main is quieter, or on a faster machine"
else
  SLOW_HINT="hand it on: git push $REMOTE HEAD:refs/heads/handoff/$MACHINE/<name>, then a machine with the private list runs scripts/gate.sh --push --from $REMOTE/handoff/$MACHINE/<name> (a change to the push path itself cannot be handed off)"
fi
while :; do
  [ -n "$LEASE" ] || lease_take
  red_mark
  # the wait was long: what is checked out must still be what was gated
  [ "$(git rev-parse HEAD)" = "$sha" ] || refuse "HEAD moved while waiting for the lease (another branch checked out, or a commit): run it again"
  [ -z "$(git status --porcelain --untracked-files=no)" ] || refuse "tracked files changed while waiting for the lease: commit or stash them, then run it again"
  lease_renew
  new="$(fetch_tip)" || exit 1; [ "${GATE_PUSH_TRACE:-}" != 1 ] || say "trace: fetch_tip new=$new base=$base stamp_age=$(stamp_age) fresh_s=${GATE_PUSH_STAMP_FRESH_S:-1500} -> $(if [ "$new" != "$base" ]; then echo moved; elif [ "$(stamp_age)" -ge "${GATE_PUSH_STAMP_FRESH_S:-1500}" ]; then echo renew; else echo fresh; fi)" # a test asks: what decides the branch below
  if [ "$new" != "$base" ]; then
    rebase_onto "$new"
    why="$(race_mode "$base" "$new")"
    mode="${why%%:*}"
    old="$base"
    base="$new"
    sha="$(git rev-parse HEAD)"
    [ "$sha" != "$base" ] || { say "nothing to push: HEAD is $REMOTE/$BRANCH"; handoff_done; exit 0; }
    # only a plain "full": a race_mode that could not plan or list (or said nothing) keeps the full gate, no second look
    if [ "$mode" = full ] && case "$why" in "full: no plan"* | "full: cannot list"*) false ;; *) true ;; esac; then
      if clean="$(rebase_clean "$old" "$new")"; then
        mode=pass
        case "$clean" in *"only words no test reads"*) PASS_WORDS=1 ;; esac
      else
        pass_log refused "$sha" "$(git log --abbrev=7 --format=%h "$old..$new" 2>/dev/null | paste -sd, -)" "$clean"
        why="$why; the rebase-clean pass is refused: $clean"
      fi
    fi
    # a gate that stands (the pass, or cheap): the tests that read this change's and the new commits' files still run
    if [ "$mode" = cheap ] || [ "$mode" = pass ]; then
      renewer_start
      rd="$(pass_readers "$old" "$new")"
      rdrc=$?
      renewer_stop # no lease_renew here: the cheap checks below start their own renewer, and the renewal before the push follows
      if [ "$rdrc" != 0 ]; then
        pass_log refused "$sha" "$(git log --abbrev=7 --format=%h "$old..$new" 2>/dev/null | paste -sd, -)" "$rd"
        why="full: the readers of the combined files refuse it: $rd"
        mode=full
        PASS_WORDS=""
      fi
    fi
    if [ "$mode" != cheap ] && [ "$mode" != pass ]; then # anything not plainly cheap, an empty or garbled answer too, runs again
      requeues=$((requeues + 1))
      # bounded: on a busy main a slow machine would gate again forever; after two requeues it hands the work on instead
      [ "$requeues" -le 2 ] || refuse "main moved during each of $requeues gates, so this machine gates too slowly for it: $SLOW_HINT"
      say "the branch moved, and the new commits need the touched set again: letting the lease go while it runs (requeue $requeues of 2). Why: ${why#full: }"
      lease_release
      SKIPPED_OVER="" # the full gate runs on the new main: nothing skipped any more
      gate_and_stamp "$base" full "$sha"
      continue
    fi
    if [ "$mode" = pass ]; then
      commits="$(git log --abbrev=7 --format=%h "$old..$new" 2>/dev/null | paste -sd, -)"
      SKIPPED_OVER="${SKIPPED_OVER:+$SKIPPED_OVER,}$commits"
      say "rebase-clean pass: $clean; only typecheck, lint, personal, size and timing run again, and it pushes without a new full gate over: $commits"
    else
      say "the branch moved, but its passing run stands (${why#cheap: }): only typecheck, lint, personal, size and timing run again"
    fi
    renewer_start
    gate_and_stamp "$base" cheap "$sha"
    renewer_stop
    lease_renew
  elif [ "$(stamp_age)" -ge "${GATE_PUSH_STAMP_FRESH_S:-1500}" ]; then
    # the same tree on the same base passed the whole gate, but long ago for the hook (it trusts a stamp for 30 min):
    # the cheap checks again, under the lease, renew the stamp instead of the hook running the whole gate inside the push
    say "the gate passed $(stamp_age) s ago: the cheap checks again to renew its stamp"
    renewer_start
    gate_and_stamp "$base" cheap "$sha"
    renewer_stop
    lease_renew
  fi
  # the gated commit, by its sha: not whatever HEAD is by now
  git push "$REMOTE" "$sha:refs/heads/$BRANCH" >&2
  rc=$?
  if [ "$rc" = 0 ]; then
    if [ -n "$SKIPPED_OVER" ]; then
      pass_log "pass${PASS_WORDS:+-words}" "$sha" "$SKIPPED_OVER" "pushed with the cheap checks only, no full gate over these main commits${PASS_WORDS:+ (shared words files no test reads)}"
      say "pushed $sha by the rebase-clean pass: no full gate over main commit(s) $SKIPPED_OVER (logged in $PASS_LOG)${EXCUSED:+; $(excused_line)}"
    else
      say "pushed $sha${EXCUSED:+; $(excused_line)}"
    fi
    push_log "$sha" "$requeues" "$races"
    [ -z "$EXCUSED" ] || pass_log excused "$sha" "${EXCUSED_MAIN:0:7}" "$(printf '%s' "$EXCUSED" | tr '\t' ' ' | paste -sd';' -)"
    handoff_done
    exit 0
  fi
  # a lost race is the branch on the remote no longer being the base this was gated on; anything else is the answer
  now="$(git ls-remote "$REMOTE" "refs/heads/$BRANCH" 2>/dev/null | cut -f1)"
  [ -n "$now" ] && [ "$now" != "$base" ] || refuse "the push was refused (above)"
  races=$((races + 1))
  [ "$races" -lt "$TRIES" ] || refuse "the push lost the race to main $TRIES times"
done
# the loop ends only by an exit: here it was cut off (bash 3.2 drops the whole loop when it loses a trap)
[ -z "$STOPPED" ] || exit 130
refuse "the push loop was cut off (a signal bash lost?): run it again"
