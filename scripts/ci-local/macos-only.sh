#!/usr/bin/env bash
# scripts/ci-local/macos-only.sh [repo]: every test file check runs that means something only (or partly) on macOS, one per line
# as "<runner> <path>", the path repo-relative, sorted. With CI_TITAN_CHECK=on (docs/CI-MACHINES.md, "check on Titan") Titan's
# Linux check skips them, so Lemnos runs them in its own check (job_check's subset), each through check's own runner:
#   bun       the bridge's files (apps/bridge, bun's own names: apps/bridge/scripts/test-parallel.ts findTestFiles)
#   vitest    the root Vitest projects' files (vitest.config.ts: each project's test folder, and all of scripts/)
#   contract  the bridge's contract suite (apps/bridge/vitest.contract.config.ts: test-contract/**/*.vitest.ts)
# Not a hand-kept list: every such file that names a macOS-only thing, by one grep. scripts/ci-local-check-titan.test.ts checks
# this list against that grep over every file check runs (as Vitest and the bun runner list them), and fails on a file with a
# darwin gate outside it.
set -uo pipefail
cd "${1:-.}" 2>/dev/null || exit 0
# The last line: what a test that drives the installers' Mac branch names (a run with Chronos, the scheduler harness, the kit self-test and its
# copy), or the tag "mac-list:". Such a test passes on Linux through stubs and can break on a Mac alone (2026-11-22: 12 of them did).
RE='darwin|apfs|APFS|clonefile|F_GETPATH|/usr/bin/security|launchctl|xcrun|sw_vers|osascript|mdls|ditto|codesign|pbcopy'
RE="$RE|chronos: true|--with-chronos'|root-install-sched-harness|talos_copy_kit|test-install.sh|mac-list:"
# list <runner> <file-name regex> <dir...>: the files under those dirs (no node_modules, no .git) that the runner takes and that
# match RE. A grep that fails (2: unreadable): exit 1, never a quietly short list.
list() {
  local runner="$1" name="$2" out d dirs=()
  shift 2
  for d in "$@"; do [ ! -d "$d" ] || dirs+=("$d"); done
  [ ${#dirs[@]} -gt 0 ] || return 0
  out="$(grep -rlE "$RE" "${dirs[@]}" --exclude-dir=node_modules --exclude-dir=.git)"
  [ $? -le 1 ] || return 1
  [ -z "$out" ] || printf '%s\n' "$out" | { grep -E "$name" || true; } | sed "s#^#$runner #"
}
all="$(
  list bun '(\.test|_test|\.spec|_spec)\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$' apps/bridge &&
    list contract '^apps/bridge/test-contract/.*\.vitest\.ts$' apps/bridge/test-contract &&
    list vitest '\.test\.ts$' packages/protocol/test packages/testkit/test packages/integrations/test apps/relay/test \
      apps/mobile/test scripts &&
    list vitest '\.test\.(ts|tsx)$' apps/web/test
)" || exit 1
[ -z "$all" ] || printf '%s\n' "$all" | LC_ALL=C sort
