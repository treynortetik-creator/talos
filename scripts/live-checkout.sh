#!/usr/bin/env bash
# The live Talos bridge checkout (the clone the Mac app's bridge runs from) and its guard (.githooks/live-guard.sh).
#   scripts/live-checkout.sh mark            mark THIS clone as live, at its current commit
#   scripts/live-checkout.sh deploy <sha>    fetch, move the live clone to <sha> detached, install its dependencies, update the marker
#   scripts/live-checkout.sh status          the marked commit and HEAD
# Run it from the live clone itself. A worktree refuses: worktrees are never live.
set -euo pipefail
gd="$(git rev-parse --git-dir)"; cd "$(git rev-parse --show-toplevel)"
[ "$(git rev-parse --git-common-dir)" = "$gd" ] || { echo "live-checkout: this is a worktree; run it in the live clone" >&2; exit 2; }
marker="$gd/talos-live"
case "${1:-}" in
  mark) git rev-parse HEAD > "$marker"; echo "live-checkout: marked live at $(cut -c1-12 "$marker")" ;;
  status) echo "marked: $( [ -f "$marker" ] && cut -c1-12 "$marker" || echo none )  HEAD: $(git rev-parse --short=12 HEAD)" ;;
  deploy)
    sha="${2:?usage: live-checkout.sh deploy <sha>}"
    [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "live-checkout: the live clone has local changes; refusing" >&2; exit 3; }
    GIT_TERMINAL_PROMPT=0 git fetch -q origin
    full="$(git rev-parse --verify "$sha^{commit}")"
    TALOS_LIVE_DEPLOY=1 git checkout -q --detach "$full"
    echo "$full" > "$marker"   # before the install: a failed install must not leave the marker on the old commit
    pnpm install --frozen-lockfile >/dev/null
    echo "live-checkout: live clone now on ${full:0:12}" ;;
  *) echo "usage: live-checkout.sh mark | status | deploy <sha>" >&2; exit 64 ;;
esac
