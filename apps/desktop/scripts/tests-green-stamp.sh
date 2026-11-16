#!/usr/bin/env bash
# tests-green-stamp.sh: prints one hash for what a green test.sh run proves: the commit, every change to it (tracked edits and the
# untracked files git does not ignore) and the canary flag. ci.sh exports it after its own green run, and guards-test.sh reuses that
# run only when it prints the same hash, so the suite is not run twice for one tree. Outside a git checkout it prints nothing and
# exits 1: no stamp, no reuse.
set -euo pipefail
cd "$(dirname "$0")/../../.."
head="$(git rev-parse HEAD 2>/dev/null)" || exit 1
{
  echo "$head"
  git diff HEAD --binary
  git ls-files -o --exclude-standard -z | xargs -0 shasum -a 256 --
  echo "canary=${TALOS_CANARY_FAIL:-0}"
} | shasum -a 256 | cut -d' ' -f1
