#!/usr/bin/env bash
# Proves .githooks/live-guard.sh: a marked clone is put back and refused; the deploy path moves it; worktrees and unmarked clones are untouched.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"; T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT; fails=0
ok() { echo "  ok   $1"; }; bad() { echo "  FAIL $1"; fails=$((fails+1)); }
git -C "$T" init -q live && cd "$T/live" && git config user.email alex@example.com && git config user.name "Alex Example"
mkdir -p .githooks scripts && cp "$REPO/.githooks/live-guard.sh" "$REPO/.githooks/post-checkout" "$REPO/.githooks/post-merge" .githooks/ && cp "$REPO/scripts/live-checkout.sh" scripts/
git config core.hooksPath .githooks; git add -A && git commit -qm one && A=$(git rev-parse HEAD)
echo two > f && git add f && git commit -qm two && B=$(git rev-parse HEAD)
git checkout -q --detach "$A" 2>/dev/null
# unmarked: free to move
git checkout -q --detach "$B" 2>/dev/null; [ "$(git rev-parse HEAD)" = "$B" ] && ok "an unmarked clone moves freely" || bad "unmarked clone"
echo "$A" > .git/talos-live
out="$(git checkout -q --detach "$B" 2>&1)"; rc=$?
[ "$(git rev-parse HEAD)" = "$A" ] && [ $rc != 0 ] && case "$out" in *REFUSED*"back on"*) true ;; *) false ;; esac && ok "a marked clone is put back and refused" || bad "marked clone: rc=$rc head=$(git rev-parse --short HEAD) out=$out"
out="$(git checkout -q main 2>&1 || git checkout -q master 2>&1)"; [ "$(git rev-parse HEAD)" = "$A" ] && ok "checking out a branch is put back too" || bad "branch checkout: $(git rev-parse --short HEAD)"
TALOS_LIVE_DEPLOY=1 git checkout -q --detach "$B" 2>/dev/null; [ "$(git rev-parse HEAD)" = "$B" ] && ok "the deploy flag lets it move (no loop: one checkout)" || bad "deploy flag"
TALOS_LIVE_DEPLOY=1 git checkout -q --detach "$A" 2>/dev/null
git worktree add -q --detach "$T/wt" "$B" 2>/dev/null; git -C "$T/wt" checkout -q --detach "$A" 2>/dev/null; [ "$(git -C "$T/wt" rev-parse HEAD)" = "$A" ] && [ "$(git rev-parse HEAD)" = "$A" ] && ok "a worktree of the live clone is never touched" || bad "worktree"
out="$(cd "$T/wt" && bash scripts/live-checkout.sh status 2>&1)"; rc=$?; [ $rc = 2 ] && ok "live-checkout.sh refuses in a worktree" || bad "worktree refusal rc=$rc"
echo "garbled" > .git/talos-live; out="$(TALOS_LIVE_DEPLOY= git checkout -q --detach "$B" 2>&1)"; rc=$?
[ $rc != 0 ] && case "$out" in *"marker"*"broken"*) true ;; *) false ;; esac && ! case "$out" in *"back on"*) true ;; *) false ;; esac && ok "a broken marker refuses and says so, with no put-back attempt" || bad "broken marker: rc=$rc out=$out"
echo "  $([ $fails = 0 ] && echo 'live-guard: all passed' || echo "live-guard: $fails failed")"; exit $fails
