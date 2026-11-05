#!/usr/bin/env bash
# Run by `pnpm install` (the root `prepare` script). Points git at .githooks, once, for this repo and all its worktrees:
# core.hooksPath lives in the config they share, and a relative path means "this worktree's own .githooks". A hook in a doc
# is a step an agent can skip; this one is simply there after the first install.
# Leaves alone: CI's scratch worktrees, anything that isn't this repo's own checkout (a Docker build, a copy unpacked inside
# another repo), a hooksPath someone set, and a repo with hooks of its own, because core.hooksPath would silently stop them.
# To stay off for good: `git config talos.nohooks true` (TALOS_NO_HOOKS=1 is for one install).
set -uo pipefail
[ "${TALOS_CI_NESTED:-0}" = 1 ] && exit 0
[ "${TALOS_NO_HOOKS:-0}" = 1 ] && exit 0
# pnpm runs this from the package root, so that must be the top of the checkout, not a folder inside some other repo.
[ "$(git rev-parse --show-toplevel 2>/dev/null)" = "$(pwd -P)" ] || exit 0
[ "$(git config --get talos.nohooks 2>/dev/null)" = true ] && exit 0
now="$(git config --get core.hooksPath 2>/dev/null || true)"
[ -z "$now" ] || exit 0
hooks="$(git rev-parse --git-common-dir)/hooks"
if [ -d "$hooks" ] && [ -n "$(ls -A "$hooks" | grep -v '\.sample$')" ]; then
  echo "install-hooks: $hooks has hooks of its own, so the pre-push hook stays off; merge them by hand to use both"
  exit 0
fi
git config core.hooksPath .githooks && echo "install-hooks: pre-push hook on (git push checks format, lint and types first)"
exit 0
