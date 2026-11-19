#!/usr/bin/env bash
# release-dryrun-wanted.sh [base]: must ci.sh run the release dry run (release-dryrun.sh, a universal build, about two to three minutes cold)?
#   exit 0  run it: TALOS_RELEASE_DRYRUN=1, or the change since the merge-base with origin/main (or <base>) touches a release script,
#           the entitlements, the package manifest or the root version file; and also whenever git cannot say (fail closed)
#   exit 1  skip it: the change touches none of those
# The list: build-app.sh, release-app.sh, bundle-tools.sh, path-leak-check.sh, nested-code.sh, release-dryrun*.sh, Package.swift,
# Resources/entitlements*.plist, and the root package.json (a version bump is a cut).
set -uo pipefail
cd "$(dirname "$0")/.."
case "${TALOS_RELEASE_DRYRUN:-0}" in 1|true|yes|on) exit 0 ;; esac
base="${1:-}"
[ -n "$base" ] || base="$(git merge-base origin/main HEAD 2>/dev/null)" || exit 0
[ -n "$base" ] || exit 0
[ "$base" != "$(git rev-parse HEAD 2>/dev/null)" ] || exit 0   # already on main: nothing to diff, so the answer is run
files="$(git diff --name-only --no-renames "$base" HEAD -- . ../../package.json 2>/dev/null)" || exit 0
while IFS= read -r f; do
  case "$f" in
    package.json|apps/desktop/Package.swift|apps/desktop/Resources/entitlements*.plist) exit 0 ;;
    apps/desktop/scripts/build-app.sh|apps/desktop/scripts/release-app.sh|apps/desktop/scripts/bundle-tools.sh|apps/desktop/scripts/path-leak-check.sh|apps/desktop/scripts/nested-code.sh|apps/desktop/scripts/release-dryrun*.sh) exit 0 ;;
  esac
done <<< "$files"
exit 1
