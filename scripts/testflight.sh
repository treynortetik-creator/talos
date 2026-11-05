#!/usr/bin/env bash
# Archive the iPhone app from a clean checkout and upload it to TestFlight.
#
#   ASC_KEY_PATH=... ASC_KEY_ID=... ASC_ISSUER_ID=... DEVELOPMENT_TEAM=... TALOS_BUNDLE_ID=... \
#   TALOS_RELAY_URL=https://... [TALOS_RELAY_HOST=relay-host] scripts/testflight.sh [--dry-run]
#
# Everything private comes from the environment, never from git: the App Store Connect API key (path, Key ID, Issuer ID),
# the team, the bundle id and the relay origin. The key file must live OUTSIDE this repo. See docs/ios.md.
#
# TALOS_RELAY_HOST is the relay's bare host (no https://, no path), the same value as the relay's RP_ID. Leave it unset and it is
# taken from TALOS_RELAY_URL; set both and they must agree (the script refuses a mismatch). It is always passed to xcodebuild:
# the build runs in a throwaway checkout that has no Local.xcconfig, so without it a push build (TALOS_APP_ENTITLEMENTS =
# App/AppPush.entitlements) would be signed for the placeholder host unset.invalid and the passkey prompt would be refused.
#
# The build is made from a throwaway worktree of $TESTFLIGHT_REF (default origin/main), so uncommitted work in your
# checkout never ships. The build number is a UTC timestamp (YYYYMMDDHHMM), so every upload is higher than the last.
set -euo pipefail
set +x

usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; }

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

# Push and passkeys in the app need the relay host in the entitlement (Signing.xcconfig); the throwaway checkout below has no
# Local.xcconfig to supply it, so it has to come from here. It is the host of TALOS_RELAY_URL unless you set TALOS_RELAY_HOST,
# and when you set both they must agree: the app would otherwise load one relay and be associated with another.
url_host="${TALOS_RELAY_URL#*://}"; url_host="${url_host%%[/?#]*}"; url_host="${url_host##*@}"; url_host="${url_host%%:*}"
url_host="$(printf '%s' "$url_host" | tr '[:upper:]' '[:lower:]')"
relay_host="${TALOS_RELAY_HOST:-}"
if [ -n "$relay_host" ]; then
  case "$relay_host" in
    *://*|*/*|*[[:space:]]*|*:*|unset.invalid) echo "testflight: TALOS_RELAY_HOST must be the bare host only (no https://, no path, no port), for example relay.example.com; got '$relay_host'" >&2; exit 64 ;;
  esac
  [ "$(printf '%s' "$relay_host" | tr '[:upper:]' '[:lower:]')" = "$url_host" ] || {
    echo "testflight: TALOS_RELAY_HOST ($relay_host) does not match the host of TALOS_RELAY_URL ($url_host). Unset TALOS_RELAY_HOST to use the URL's host." >&2; exit 64; }
fi
[ -n "$url_host" ] || { echo "testflight: could not read a host from TALOS_RELAY_URL ($TALOS_RELAY_URL)" >&2; exit 64; }
relay_host="$url_host"

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
settings+=(TALOS_RELAY_HOST="$relay_host")

xcodebuild archive \
  -project apps/mobile/ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$work/Talos.xcarchive" \
  "${auth[@]}" "${settings[@]}"

xcodebuild -exportArchive -archivePath "$work/Talos.xcarchive" \
  -exportOptionsPlist "$work/ExportOptions.plist" -exportPath "$work/export" "${auth[@]}"

echo "testflight: uploaded build $build from $sha. It shows in App Store Connect after processing (usually 5 to 30 minutes)."
