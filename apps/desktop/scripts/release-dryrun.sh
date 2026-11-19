#!/usr/bin/env bash
# release-dryrun.sh [--out DIR]: the release build's own steps without a Developer ID or Apple, so the bugs a real cut finds are found
# on an ordinary run instead. One universal build with the pinned bun and tmux bundled (build-app.sh --release --universal
# --bundle-tools --no-checkout-stamp, signed ad hoc: TALOS_SIGN_ID=-, no hardened runtime, no notarization), then:
#   1. the nested-code listing (nested-code.sh) is exactly the two helpers, each one clean path, each really universal (both slices)
#   2. every nested helper carries a valid signature
#   3. path-leak-check.sh on the result (what release-app.sh runs before it sends anything to Apple)
# Env: TALOS_TOOLS_CACHE (the bundle-tools downloads and the built tmux; set it to a folder that outlives the run, or the run
# downloads and builds tmux again). Exit 0 all held; 1 a step failed (it says which); 64 bad arguments.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || { echo "release-dryrun: --out needs a folder" >&2; exit 64; }; OUT="$2"; shift 2 ;;
    *) echo "release-dryrun: unknown argument $1" >&2; exit 64 ;;
  esac
done
REPO="$(cd ../.. && pwd)"
OWN=0
if [ -z "$OUT" ]; then OUT="$(mktemp -d "${TMPDIR:-/tmp}/talos-release-dryrun-XXXXXX")"; OWN=1; fi
[ "$OWN" = 0 ] || trap 'rm -rf "$OUT"' EXIT
APP="$OUT/Talos.app"
die() { echo "release-dryrun: $*" >&2; exit 1; }
t0=$(date +%s)
TALOS_SIGN_ID=- bash scripts/build-app.sh --release --universal --bundle-tools --no-checkout-stamp --out "$OUT" || die "the universal build failed"
[ -d "$APP" ] || die "the build finished but $APP is not there"
echo "release-dryrun: build took $(( $(date +%s) - t0 ))s"
listed="$(bash scripts/nested-code.sh "$APP")" || die "nested-code.sh failed"
want="$APP/Contents/Helpers/bun
$APP/Contents/Helpers/tmux"
[ "$listed" = "$want" ] || die "the nested code listing is not exactly bun and tmux (a path may be garbled):
$listed"
while IFS= read -r f; do
  archs="$(lipo -archs "$f" 2>&1)" || die "$(basename "$f") is not a Mach-O lipo can read: $archs"
  case " $archs " in *" arm64 "*) ;; *) die "$(basename "$f") has no arm64 slice (has: $archs)" ;; esac
  case " $archs " in *" x86_64 "*) ;; *) die "$(basename "$f") has no x86_64 slice (has: $archs)" ;; esac
  codesign --verify --strict "$f" 2>&1 || die "$(basename "$f") has no valid signature"
done <<< "$listed"
bash scripts/path-leak-check.sh "$APP" "$REPO" || die "the build carries paths of this Mac (see above)"
echo "release-dryrun: ok in $(( $(date +%s) - t0 ))s"
