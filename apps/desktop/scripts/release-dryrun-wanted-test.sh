#!/usr/bin/env bash
# Tests release-dryrun-wanted.sh in a throwaway git repo shaped like the checkout: a release script, the entitlements and the root
# package.json each ask for the dry run; a Swift source or a test script does not; no git history means run; the env switch forces it.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
fail=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1" >&2; fail=1; }
T="$(mktemp -d "${TMPDIR:-/tmp}/talos-dryrun-wanted-XXXXXX")"; trap 'rm -rf "$T"' EXIT
R="$T/r"; mkdir -p "$R/apps/desktop/scripts" "$R/apps/desktop/Sources" "$R/apps/desktop/Resources"
cp "$HERE/release-dryrun-wanted.sh" "$R/apps/desktop/scripts/"
cd "$R" && git init -q . && git config user.email t@example.com && git config user.name t
for f in apps/desktop/scripts/build-app.sh apps/desktop/scripts/other-test.sh apps/desktop/Sources/A.swift apps/desktop/Resources/entitlements-bun.plist package.json; do echo 0 > "$f"; done
git add -A && git commit -qm base && B="$(git rev-parse HEAD)"
W() { env -u TALOS_RELEASE_DRYRUN bash apps/desktop/scripts/release-dryrun-wanted.sh "$B" >/dev/null 2>&1; }
touch_commit() { echo "$RANDOM" >> "$1"; git add -A && git commit -qm c; }
git checkout -q -b b1; touch_commit apps/desktop/Sources/A.swift; touch_commit apps/desktop/scripts/other-test.sh
W; [ $? = 1 ] && ok "a Swift source and a test script do not ask for it (exit 1)" || bad "unrelated change asked for the dry run"
touch_commit apps/desktop/scripts/build-app.sh
W; [ $? = 0 ] && ok "build-app.sh asks for it" || bad "build-app.sh did not"
git reset -q --hard "$B"; touch_commit apps/desktop/Resources/entitlements-bun.plist
W; [ $? = 0 ] && ok "an entitlements file asks for it" || bad "entitlements did not"
git reset -q --hard "$B"; touch_commit package.json
W; [ $? = 0 ] && ok "the root package.json (a version bump) asks for it" || bad "package.json did not"
git reset -q --hard "$B"; touch_commit apps/desktop/Sources/A.swift
TALOS_RELEASE_DRYRUN=1 bash apps/desktop/scripts/release-dryrun-wanted.sh "$B" >/dev/null 2>&1; [ $? = 0 ] && ok "TALOS_RELEASE_DRYRUN=1 forces it" || bad "env switch ignored"
bash apps/desktop/scripts/release-dryrun-wanted.sh deadbeefdeadbeef >/dev/null 2>&1; [ $? = 0 ] && ok "a base git cannot resolve means run it (fails closed)" || bad "unknown base skipped the dry run"
[ $fail = 0 ] && echo "release-dryrun-wanted-test: all passed" || { echo "release-dryrun-wanted-test: FAILED" >&2; exit 1; }
