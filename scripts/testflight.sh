#!/usr/bin/env bash
# Archive the iPhone app from a clean checkout and upload it to TestFlight.
#
#   ASC_KEY_PATH=... ASC_KEY_ID=... ASC_ISSUER_ID=... DEVELOPMENT_TEAM=... TALOS_BUNDLE_ID=... \
#   TALOS_RELAY_URL=https://... scripts/testflight.sh [--dry-run]
#
# Everything private comes from the environment, never from git: the App Store Connect API key (path, Key ID, Issuer ID),
# the team, the bundle id and the relay origin. The key file must live OUTSIDE this repo. See docs/ios.md.
#
# The build is made from a throwaway worktree of $TESTFLIGHT_REF (default origin/main), so uncommitted work in your
# checkout never ships. The build number is a UTC timestamp (YYYYMMDDHHMM), so every upload is higher than the last.
set -euo pipefail
set +x

usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; }

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "testflight: unknown argument: $arg" >&2; usage >&2; exit 64 ;;
  esac
done

missing=()
for v in ASC_KEY_PATH ASC_KEY_ID ASC_ISSUER_ID DEVELOPMENT_TEAM TALOS_BUNDLE_ID TALOS_RELAY_URL; do
  [ -n "${!v:-}" ] || missing+=("$v")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "testflight: set these environment variables first (see docs/ios.md): ${missing[*]}" >&2
  exit 64
fi

repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
key="$(cd "$(dirname "$ASC_KEY_PATH")" 2>/dev/null && pwd -P)/$(basename "$ASC_KEY_PATH")" || {
  echo "testflight: ASC_KEY_PATH does not point at a file" >&2; exit 66; }
[ -f "$key" ] || { echo "testflight: ASC_KEY_PATH does not point at a file" >&2; exit 66; }
case "$key" in
  "$repo"/*) echo "testflight: the API key must live outside the repo checkout" >&2; exit 65 ;;
esac
for tool in xcodebuild xcodegen pnpm git; do
  command -v "$tool" >/dev/null || { echo "testflight: $tool not found on PATH" >&2; exit 69; }
done

ref="${TESTFLIGHT_REF:-origin/main}"
git -C "$repo" fetch -q origin
sha="$(git -C "$repo" rev-parse --verify "$ref^{commit}")"
build="$(date -u +%Y%m%d%H%M)"
echo "testflight: ref $ref ($sha), build number $build"
[ "$DRY_RUN" = 1 ] && { echo "testflight: dry run, stopping before checkout, archive and upload"; exit 0; }

work="$(mktemp -d "${TMPDIR:-/tmp}/talos-testflight.XXXXXX")"
cleanup() { git -C "$repo" worktree remove --force "$work/src" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

git -C "$repo" worktree add --detach "$work/src" "$sha" >/dev/null
cd "$work/src"
pnpm install --frozen-lockfile
(cd apps/mobile && TALOS_RELAY_URL="$TALOS_RELAY_URL" pnpm cap:sync && cd ios/App && xcodegen generate --spec project.yml)

cat > "$work/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$DEVELOPMENT_TEAM</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
</dict></plist>
PLIST

auth=(-allowProvisioningUpdates -authenticationKeyPath "$key" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
settings=(DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" TALOS_BUNDLE_ID="$TALOS_BUNDLE_ID" CURRENT_PROJECT_VERSION="$build")
[ -z "${TALOS_APP_ENTITLEMENTS:-}" ] || settings+=(TALOS_APP_ENTITLEMENTS="$TALOS_APP_ENTITLEMENTS")

xcodebuild archive \
  -project apps/mobile/ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$work/Talos.xcarchive" \
  "${auth[@]}" "${settings[@]}"

xcodebuild -exportArchive -archivePath "$work/Talos.xcarchive" \
  -exportOptionsPlist "$work/ExportOptions.plist" -exportPath "$work/export" "${auth[@]}"

echo "testflight: uploaded build $build from $sha. It shows in App Store Connect after processing (usually 5 to 30 minutes)."
