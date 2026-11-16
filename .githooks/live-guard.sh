#!/usr/bin/env bash
# The live-checkout guard, shared by post-checkout and post-merge. The clone the Mac's bridge runs from carries a marker file,
# <git dir>/talos-live, holding the deployed commit. In that clone only, anything that moves HEAD off the marked commit is put
# straight back and refused loudly. scripts/live-checkout.sh deploy is the one way to move it (it sets TALOS_LIVE_DEPLOY=1).
# A worktree has its own git dir, so worktrees never carry the marker and are never touched. `git reset` runs no hook: not covered.
set -u
marker="$(git rev-parse --git-dir 2>/dev/null)/talos-live"
[ -f "$marker" ] || exit 0
[ "${TALOS_LIVE_DEPLOY:-}" = 1 ] && exit 0
want="$(tr -d '[:space:]' < "$marker")"
have="$(git rev-parse HEAD 2>/dev/null)"
[ -n "$want" ] && [ "$have" = "$want" ] && exit 0
if ! printf '%s' "$want" | grep -qE '^[0-9a-f]{40}$'; then
  echo "live-guard: REFUSED. This is the LIVE Talos bridge checkout, but its marker $marker is broken (not a commit id)." >&2
  echo "live-guard: HEAD was NOT put back. Re-mark it at the deployed commit: scripts/live-checkout.sh mark" >&2
  exit 1
fi
echo "live-guard: REFUSED. This is the LIVE Talos bridge checkout (marked by $marker). It stays on the deployed commit ${want:0:12}." >&2
echo "live-guard: read code with 'git show origin/main:<path>' or a worktree; deploy with scripts/live-checkout.sh deploy <sha>." >&2
# put it back, with the deploy flag set so this hook does not run again on its own checkout (no loop)
if TALOS_LIVE_DEPLOY=1 git checkout -q --detach "$want" 2>/dev/null; then
  echo "live-guard: HEAD is back on ${want:0:12}." >&2
else
  echo "live-guard: could NOT put HEAD back on ${want:0:12} (local changes?). Fix it now: git checkout --detach $want" >&2
fi
exit 1
