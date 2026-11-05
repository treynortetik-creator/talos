#!/usr/bin/env bash
# ci-desktop-gate.sh <base> <head>: must the desktop job run?
#   exit 0  the change touches something the desktop build or its CI reads: run it
#   exit 1  no such change: the job may be skipped (the ONLY value that allows a skip)
#   exit 2  error (no base, unknown commit, git failure): the caller must run the job, never skip it
# Watched: apps/desktop/, the native bridge schema and its fixture script, the two bridge files desktop tests read
# (claude-env.ts, the pinned worker instructions), the brand icon, package.json (version), scripts/version.mjs, and the gate
# and ci-local.sh themselves (a PR editing the gate must not skip its own check).
# Uses `git diff --quiet -- <pathspecs>`: no output parsing (so no quoting problems with odd file names) and no pipe
# (so no SIGPIPE on a big diff). --no-renames counts both sides of a rename.
set -uo pipefail
base="${1:-}" head="${2:-HEAD}"
[ -n "$base" ] || exit 2
git diff --quiet --no-renames "$base" "$head" -- \
  apps/desktop/ packages/protocol/src/native.ts scripts/native-fixtures.ts assets/brand/talos-icon-1024.png \
  apps/bridge/src/claude-env.ts apps/bridge/test/fixtures/agent-instructions/worker.txt \
  package.json scripts/version.mjs scripts/ci-desktop-gate.sh scripts/ci-local.sh
case $? in
  0) exit 1 ;;  # identical: skip allowed
  1) exit 0 ;;  # differs: run
  *) exit 2 ;;
esac
