#!/usr/bin/env bash
# Builds the prebuilt Talos.app that a second Mac installs instead of building: Developer ID signed with the hardened runtime and a
# secure timestamp, notarized by Apple, the ticket stapled, zipped, with a .sha256 file and a small manifest beside the zip.
#   release-app.sh [--out DIR] [--arch universal|arm64] [--no-notarize]
#     --out          where the zip, its .sha256 and the manifest go (default: apps/desktop/.build/release)
#     --arch         universal (default: arm64 + x86_64, one binary) or arm64 (Apple Silicon only; an Intel Mac refuses to open it)
#     --no-notarize  a local trial: signed and hardened, but not sent to Apple. The zip is named ...-UNNOTARIZED.zip and the
#                    manifest says "notarized": false; install.sh --from-release refuses it (Gatekeeper does not accept it).
# Env (read here, never printed):
#   TALOS_RELEASE_SIGN_ID  the signing identity, as `security find-identity -v -p codesigning` lists it, e.g.
#                          "Developer ID Application: <name> (<TEAM>)". Required. Only a Developer ID Application identity can be
#                          notarized; another one is fine for --no-notarize.
#   ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID  the App Store Connect API key notarytool signs in with: the path of the .p8 file,
#                          its key id and the issuer id. Required unless --no-notarize. Only the path is passed on; the key's
#                          contents are never read or printed here.
# Exit codes: 0 done; 1 a step failed (it says which); 64 bad arguments; 65 something it needs is missing (identity, key, tool).
# The build itself is build-app.sh (--release --no-checkout-stamp --hardened, --universal for universal): the same checks, the
# same sealed hooks, and the app's own --selftest, run on the hardened build.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/.build/release" ARCH=universal NOTARIZE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || { echo "release-app: --out needs a folder" >&2; exit 64; }; OUT="$2"; shift 2 ;;
    --arch)
      [ $# -ge 2 ] || { echo "release-app: --arch needs universal or arm64" >&2; exit 64; }
      case "$2" in universal|arm64) ARCH="$2" ;; *) echo "release-app: --arch is universal or arm64, not $2" >&2; exit 64 ;; esac
      shift 2 ;;
    --no-notarize) NOTARIZE=0; shift ;;
    *) echo "release-app: unknown argument $1" >&2; exit 64 ;;
  esac
done
say() { echo "release-app: $*"; }
die() { echo "release-app: $*" >&2; exit "${2:-1}"; }

# What it needs, all checked before the build starts.
ID="${TALOS_RELEASE_SIGN_ID:-}"
[ -n "$ID" ] || die "set TALOS_RELEASE_SIGN_ID to the signing identity (\"Developer ID Application: ...\")" 65
[ "$ID" != "-" ] || die "a release cannot be signed ad hoc; TALOS_RELEASE_SIGN_ID must name a real identity" 65
IDS="$(security find-identity -v -p codesigning 2>/dev/null || true)"  # read whole: a grep -q pipe can SIGPIPE under pipefail
case "$IDS" in *"\"$ID\""*) true ;; *) false ;; esac \
  || die "no valid codesigning identity called \"$ID\" in this Mac's keychains (security find-identity -v -p codesigning)" 65
if [ "$NOTARIZE" = 1 ]; then
  case "$ID" in "Developer ID Application: "*) ;; *) die "only a \"Developer ID Application\" identity can be notarized; use --no-notarize for a trial with \"$ID\"" 65 ;; esac
  for v in ASC_KEY_PATH ASC_KEY_ID ASC_ISSUER_ID; do [ -n "${!v:-}" ] || die "set $v (the App Store Connect API key notarytool uses), or pass --no-notarize" 65; done
  [ -f "$ASC_KEY_PATH" ] && [ -r "$ASC_KEY_PATH" ] || die "ASC_KEY_PATH does not name a readable file" 65
  xcrun --find notarytool >/dev/null 2>&1 || die "xcrun notarytool is not available (it comes with the Command Line Tools 13 or newer)" 65
  xcrun --find stapler >/dev/null 2>&1 || die "xcrun stapler is not available" 65
  # A release is a commit someone can look at: nothing uncommitted goes into a notarized build.
  [ -z "$(git -C "$REPO" status --porcelain 2>/dev/null)" ] || die "the working tree has uncommitted changes; commit them first (or --no-notarize for a trial)" 65
fi

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd -P)"
WORK="$OUT/work"
rm -rf "$WORK"
mkdir -p "$WORK"
BUILD_ARGS=(--release --out "$WORK" --no-checkout-stamp --hardened)
[ "$ARCH" = universal ] && BUILD_ARGS+=(--universal)
say "building ($ARCH, hardened runtime, signed by the identity in TALOS_RELEASE_SIGN_ID)"
TALOS_SIGN_ID="$ID" TALOS_REQUIRE_SIGN_ID=1 bash "$HERE/scripts/build-app.sh" "${BUILD_ARGS[@]}"
APP="$WORK/Talos.app"
[ -d "$APP" ] || die "build-app.sh finished but $APP is not there"

# No path of the builder's Mac inside any Mach-O (all slices): refuse before anything goes to Apple.
bash "$HERE/scripts/path-leak-check.sh" "$APP" "$REPO" || die "the build carries paths of this Mac (see the line above); nothing was sent to Apple" 1

# The signature, read back: strict and deep, the hardened runtime flag, a secure timestamp, a team, no clone path inside.
codesign --verify --strict --deep --verbose=1 "$APP" || die "codesign --verify --strict --deep failed on the build"
INFO="$(codesign -dv --verbose=4 "$APP" 2>&1)"
printf '%s\n' "$INFO" | grep -qE '^CodeDirectory .*flags=0x[0-9a-f]*\([^)]*runtime' || die "the build is not signed with the hardened runtime"
printf '%s\n' "$INFO" | grep -q '^Timestamp=' || die "the signature has no secure timestamp (codesign --timestamp needs Apple's timestamp server)"
TEAM="$(printf '%s\n' "$INFO" | sed -n 's/^TeamIdentifier=//p')"
case "$TEAM" in ''|"not set") die "the signature carries no team id (a self-signed identity cannot make a release)" ;; esac
# The release entitlements are in the signature (without them the hardened runtime refuses Apple Events, the microphone, the camera,
# Contacts and Photos with no prompt).
ENTS="$(codesign -d --entitlements - --xml "$APP" 2>/dev/null)"
for k in $(sed -n 's/.*<key>\(com\.apple\.security\.[a-z.-]*\)<\/key>.*/\1/p' "$HERE/Resources/entitlements-release.plist"); do
  case "$ENTS" in *"<key>$k</key><true/>"*) ;; *) die "the signature does not carry the entitlement $k" ;; esac
done
/usr/libexec/PlistBuddy -c 'Print :TalosCheckout' "$APP/Contents/Info.plist" >/dev/null 2>&1 \
  && die "the build carries TalosCheckout (a path on this Mac); a prebuilt app must not"
GOT_ARCHS="$(lipo -archs "$APP/Contents/MacOS/Talos")"
if [ "$ARCH" = universal ]; then
  case " $GOT_ARCHS " in *" arm64 "*) ;; *) die "the universal build has no arm64 slice ($GOT_ARCHS)" ;; esac
  case " $GOT_ARCHS " in *" x86_64 "*) ;; *) die "the universal build has no x86_64 slice ($GOT_ARCHS)" ;; esac
fi

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
BUILD_NUM="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist")"
GIT_SHA="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
BASE="Talos-$VERSION-$ARCH"
[ "$NOTARIZE" = 1 ] || BASE="$BASE-UNNOTARIZED"
ZIP="$OUT/$BASE.zip"

STAPLED=false
if [ "$NOTARIZE" = 1 ]; then
  SUBMIT="$WORK/submit.zip"
  ditto -c -k --keepParent "$APP" "$SUBMIT"
  say "sending the build to Apple's notary service and waiting for its answer (usually a few minutes)"
  # Only the key's path, id and issuer go on the command line; its contents stay in the file.
  RESULT="$WORK/notary.json"
  if ! xcrun notarytool submit "$SUBMIT" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" \
      --wait --timeout 45m --output-format json > "$RESULT"; then
    die "notarytool submit failed (its answer is in $RESULT)"
  fi
  STATUS="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(r.status||""))' "$RESULT")"
  SUB_ID="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(r.id||""))' "$RESULT")"
  if [ "$STATUS" != Accepted ]; then
    if [[ "$SUB_ID" =~ ^[A-Za-z0-9-]+$ ]]; then
      xcrun notarytool log "$SUB_ID" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" "$WORK/notary-log.json" >/dev/null 2>&1 || true
    fi
    die "Apple did not accept the build (status: ${STATUS:-none}); the reasons are in $WORK/notary-log.json"
  fi
  say "notarized (submission $SUB_ID)"
  xcrun stapler staple "$APP" || die "stapler could not staple the ticket to the app"
  xcrun stapler validate "$APP" || die "the stapled ticket does not validate"
  STAPLED=true
  # What a Mac that downloads it will ask: Gatekeeper must accept it as notarized Developer ID.
  ASSESS="$(spctl --assess --type execute --verbose=2 "$APP" 2>&1)" || die "Gatekeeper refuses the notarized build: $ASSESS"
  case "$ASSESS" in *"source=Notarized Developer ID"*) ;; *) die "Gatekeeper accepted the build but not as notarized Developer ID: $ASSESS" ;; esac
  codesign --verify --strict --deep "$APP" || die "the app no longer verifies after stapling"
fi

rm -f "$ZIP" "$ZIP.sha256" "$OUT/$BASE.manifest.json"
ditto -c -k --keepParent "$APP" "$ZIP"
SHA="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
printf '%s  %s\n' "$SHA" "$(basename "$ZIP")" > "$ZIP.sha256"
NOTARIZED="$([ "$NOTARIZE" = 1 ] && echo true || echo false)"
M_VERSION="$VERSION" M_BUILD="$BUILD_NUM" M_SHA="$GIT_SHA" M_ZIP="$(basename "$ZIP")" M_ZIPSHA="$SHA" M_ARCH="$ARCH" \
M_ARCHS="$GOT_ARCHS" M_TEAM="$TEAM" M_NOTARIZED="$NOTARIZED" M_STAPLED="$STAPLED" node -e '
const e = process.env
const m = {
  app: "Talos.app", bundle_id: "app.talos.desktop", version: e.M_VERSION, build: e.M_BUILD, git_sha: e.M_SHA, source_sha: e.M_SHA,
  zip: e.M_ZIP, sha256: e.M_ZIPSHA, arch: e.M_ARCH, slices: e.M_ARCHS.split(/\s+/).filter(Boolean), team_id: e.M_TEAM,
  hardened_runtime: true, notarized: e.M_NOTARIZED === "true", stapled: e.M_STAPLED === "true",
  built_at: new Date().toISOString(),
}
process.stdout.write(JSON.stringify(m, null, 2) + "\n")' > "$OUT/$BASE.manifest.json"
rm -rf "$WORK"
say "zip:      $ZIP"
say "sha256:   $SHA"
say "manifest: $OUT/$BASE.manifest.json"
say "team:     $TEAM ($GOT_ARCHS; notarized: $NOTARIZED)"
say "install on another Mac, from its own clone: bash apps/desktop/scripts/install.sh --from-release <https url of the zip> --sha256 $SHA --team $TEAM"
