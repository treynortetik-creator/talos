#!/usr/bin/env bash
# Tests the prebuilt-app path: build-app.sh's refusal of a silent ad hoc build, and install.sh --from-release with local zips (a
# wrong sha256, an unsigned app, an app Gatekeeper does not accept as notarized, the wrong team, a changed signing identity).
# Every install runs with a temp HOME, a temp TMPDIR, a temp --dest and stub osascript/open/tmux/launchctl, as install-test.sh does.
# Usage: release-install-test.sh <path to a built Talos.app>
#
# install.sh calls codesign, spctl, shasum, ditto and curl by full path, so nothing on PATH can stand in for them. Gatekeeper's check
# is run for real (an ad hoc or Apple Development signed app is refused by the real spctl). To reach the checks after it, some cases
# run a COPY of install.sh (beside it, removed at the end) with one line changed, and say so in their name:
#   "past Gatekeeper"  the copy's SPCTL is a stub that answers as it does for a notarized Developer ID app;
#   "Apple Development as Developer ID"  also, the copy's requirement takes Apple Development's intermediate marker in place of
#                     Developer ID's two (no Developer ID identity exists on a test Mac); team, anchor and bundle id are unchanged;
#   "stub curl", "swapped during the wait"  as they say.
# Each copy is checked to differ from install.sh in exactly the line it means to change.
# The cases that need a signature through Apple's certificates (SECURITY_CASES of them) run only when TALOS_TEST_APPLE_SIGN_ID names
# such an identity in this Mac's keychain ("Apple Development: ..." or "Developer ID Application: ..."), named explicitly by the person
# running it; ci.sh passes on only what is set. Without it they print a loud SKIPPED line. Nothing here or in ci.sh picks an identity.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
BASE_APP="${1:?usage: release-install-test.sh <Talos.app>}"
INSTALL="$HERE/scripts/install.sh"
BUILD="$HERE/scripts/build-app.sh"
CLONE="$(cd "$HERE/../.." && pwd -P)"
fail=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1" >&2; fail=1; }
skip() { echo "  skip $1"; }
T="$(mktemp -d)"
# the copies of install.sh this run makes beside it (copy_with) carry this run's pid in their names
trap 'chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"; rm -f "$HERE"/scripts/.install-under-test-*-$$.sh' EXIT
unset TALOS_APP_HOME TALOS_RELEASE_TEAM

STUB="$T/stub"; mkdir -p "$STUB"
for name in open tmux launchctl osascript; do printf '#!/bin/bash\necho "%s $*" >> "$STUBLOG"\n' "$name" > "$STUB/$name"; done
export STUBLOG="$T/stub.log"
: > "$STUBLOG"
# Gatekeeper's answer for a notarized Developer ID app (only in the copies that say "past Gatekeeper").
GK="$T/gk"; mkdir -p "$GK"
printf '#!/bin/bash\nfor a; do p="$a"; done\necho "$p: accepted" >&2\necho "source=Notarized Developer ID" >&2\nexit 0\n' > "$GK/spctl"
chmod +x "$STUB"/* "$GK/spctl"
# copy_with <name> <python replace pairs as old\x1fnew lines...>: a copy of install.sh beside it with each pair replaced exactly once.
copy_with() {
  local name="$1" out; shift
  out="$HERE/scripts/.install-under-test-$name-$$.sh"
  python3 - "$INSTALL" "$out" "$@" <<'PYC' || { echo "  FAIL could not make the $name copy of install.sh" >&2; exit 1; }
import sys
src, out, pairs = sys.argv[1], sys.argv[2], sys.argv[3:]
s = open(src).read()
for p in pairs:
    old, new = p.split("\x1f")
    if s.count(old) != 1: sys.exit("not exactly one: " + old)
    s = s.replace(old, new)
open(out, "w").write(s)
PYC
  printf '%s' "$out"
}
DEVID_MARKERS='certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13]'
APPLEDEV_MARKER='certificate 1[field.1.2.840.113635.100.6.2.1]'
INSTALL_GK="$(copy_with gk "SPCTL=/usr/sbin/spctl"$'\x1f'"SPCTL=$GK/spctl")"
INSTALL_DEV="$(copy_with dev "SPCTL=/usr/sbin/spctl"$'\x1f'"SPCTL=$GK/spctl" "$DEVID_MARKERS"$'\x1f'"$APPLEDEV_MARKER")"
[ "$(diff "$INSTALL" "$INSTALL_GK" | grep -c '^>')" = 1 ] && [ "$(diff "$INSTALL" "$INSTALL_DEV" | grep -c '^>')" = 2 ] \
  || { echo "  FAIL the test copies of install.sh change more than the lines they mean to" >&2; exit 1; }
FAKEHOME="$T/home"
mkdir -p "$FAKEHOME/.config/talos" "$T/tmp"
echo '{"keep":"me"}' > "$FAKEHOME/.config/talos/desktop.json"
run() { HOME="$FAKEHOME" TMPDIR="$T/tmp" PATH="$STUB:$PATH" bash "$INSTALL" "$@"; }
run_gk() { HOME="$FAKEHOME" TMPDIR="$T/tmp" PATH="$STUB:$PATH" bash "$INSTALL_GK" "$@"; }
run_dev() { HOME="$FAKEHOME" TMPDIR="$T/tmp" PATH="$STUB:$PATH" bash "$INSTALL_DEV" "$@"; }
sha() { shasum -a 256 "$1" | awk '{print $1}'; }
snap() { find "$1" -mindepth 1 -exec stat -f '%N|%z|%m|%HT|%Y' {} + 2>/dev/null | LC_ALL=C sort | shasum | cut -d' ' -f1; }
no_temp_left() { [ -z "$(ls -A "$T/tmp")" ]; }
CHECKOUT_FILE="$FAKEHOME/Library/Application Support/app.talos.desktop/checkout"
OLD_CHECKOUT_FILE="$FAKEHOME/Library/Application Support/Talos/checkout"

# --- build-app.sh: no silent ad hoc ----------------------------------------------------------------------------------------------
# A stub swift logs and stops the build (exit 3), so each case shows whether the identity check let it reach the build at all.
echo "build-app.sh signing identity"
BS="$T/build-stub"; mkdir -p "$BS"
printf '#!/bin/bash\necho "swift $*" >> "%s/swift.log"\nexit 3\n' "$T" > "$BS/swift"
# the matching identity first, then a long list after it, as a keychain with many identities gives: a reader that stops at the
# first match must not turn "found" into "not found" (security dies of SIGPIPE writing the rest)
printf '#!/bin/bash\necho "  1) 0000000000000000000000000000000000000000 \\"talos-test-identity\\""\nfor i in $(seq 2 20000); do echo "  $i) 1111111111111111111111111111111111111111 \\"other identity $i\\""; done\necho "     20000 valid identities found"\n' > "$BS/security.one"
printf '#!/bin/bash\necho "     0 valid identities found"\n' > "$BS/security.none"
mkdir -p "$BS/one" "$BS/none"; cp "$BS/swift" "$BS/one/swift"; cp "$BS/swift" "$BS/none/swift"
cp "$BS/security.one" "$BS/one/security"; cp "$BS/security.none" "$BS/none/security"; chmod +x "$BS"/one/* "$BS"/none/*
build() {  # build <stub dir> <env...> -- <args...>
  local dir="$1"; shift
  local -a envs=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do envs+=("$1"); shift; done
  shift
  : > "$T/swift.log"
  env -u TALOS_SIGN_ID -u TALOS_REQUIRE_SIGN_ID TALOS_IDENTITY_NAME=talos-test-identity PATH="$dir:$PATH" "${envs[@]+"${envs[@]}"}" \
    bash "$BUILD" --out "$T/build-out" "$@" 2>&1
}
OUT="$(build "$BS/none" --)"; rc=$?
if [ "$rc" = 65 ] && [ ! -s "$T/swift.log" ] && [ ! -e "$T/build-out/Talos.app" ]; then
  case "$OUT" in *"make-signing-identity.sh"*"TALOS_SIGN_ID=-"*) ok "no identity: refused before building, naming make-signing-identity.sh and the ad hoc opt-in" ;; *) bad "no identity: refused without the right words: $OUT" ;; esac
else bad "no identity: exit $rc (want 65), swift ran: $(cat "$T/swift.log")"; fi
OUT="$(build "$BS/one" TALOS_REQUIRE_SIGN_ID=1 --)"; rc=$?
[ "$rc" = 65 ] && [ ! -s "$T/swift.log" ] && case "$OUT" in *TALOS_REQUIRE_SIGN_ID*) true ;; *) false ;; esac \
  && ok "TALOS_REQUIRE_SIGN_ID=1 refuses the local identity found in the keychain" || bad "TALOS_REQUIRE_SIGN_ID with a local identity: exit $rc: $OUT"
OUT="$(build "$BS/none" TALOS_SIGN_ID=- -- --hardened)"; rc=$?
[ "$rc" = 65 ] && [ ! -s "$T/swift.log" ] && ok "--hardened refuses ad hoc" || bad "--hardened with ad hoc: exit $rc: $OUT"
build "$BS/none" TALOS_SIGN_ID=- -- >/dev/null; rc=$?
[ "$rc" = 3 ] && grep -q '^swift build' "$T/swift.log" && ok "control: TALOS_SIGN_ID=- (ad hoc on purpose) goes on to the build" || bad "control: TALOS_SIGN_ID=- did not reach the build (exit $rc)"
build "$BS/one" --  >/dev/null; rc=$?
[ "$rc" = 3 ] && grep -q '^swift build' "$T/swift.log" && ok "control: the local identity, when present, goes on to the build" || bad "control: the local identity did not reach the build (exit $rc)"
build "$BS/none" TALOS_SIGN_ID=- -- --universal >/dev/null
grep -q -- '--arch arm64 --arch x86_64' "$T/swift.log" && ok "--universal builds arm64 and x86_64" || bad "--universal: $(cat "$T/swift.log")"

# make-signing-identity.sh --status with the identity first in a long list: "trusted", never "not trusted" because security died of
# SIGPIPE behind a reader that stopped early. A throwaway keychain path that does not exist; a stub security answers.
MS="$T/msi"; mkdir -p "$MS"
cat > "$MS/security" <<'S'
#!/bin/bash
case "$1" in
  find-certificate) echo "SHA-1 hash: ABCDEF0123456789ABCDEF0123456789ABCDEF01"; echo '    "labl"<blob>="talos-test-identity"' ;;
  find-identity) echo '  1) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "talos-test-identity"'
                 for i in $(seq 2 20000); do echo "  $i) 1111111111111111111111111111111111111111 \"other $i\""; done ;;
  *) exit 0 ;;
esac
S
chmod +x "$MS/security"
OUT="$(env -u TALOS_KEYCHAIN_PASSWORD TALOS_IDENTITY_NAME=talos-test-identity TALOS_KEYCHAIN="$MS/none.keychain-db" PATH="$MS:$PATH" \
  bash "$HERE/scripts/make-signing-identity.sh" --status 2>&1)"; rc=$?
[ "$rc" = 0 ] && case "$OUT" in *"present and trusted"*) true ;; *) false ;; esac \
  && ok "make-signing-identity.sh --status finds the identity at the top of a long list" || bad "make-signing-identity --status: exit $rc: $OUT"

# ci.sh passes on only an identity someone named; it never looks one up (the first one in a keychain may be an employer's)
! grep -q "find-identity" "$HERE/scripts/ci.sh" && ok "ci.sh never picks a signing identity from the keychain" || bad "ci.sh looks up a signing identity"

# --- fixtures --------------------------------------------------------------------------------------------------------------------
# A folder whose name has a space and quotes: the local-path form must take it whole.
Z="$T/rel \"it's\" here"; mkdir -p "$Z"
mkzip() {  # mkzip <app> <zip>
  rm -f "$2"; ditto -c -k --keepParent "$1" "$2"
}
ADHOC="$T/fx/adhoc/Talos.app"; mkdir -p "$(dirname "$ADHOC")"; ditto "$BASE_APP" "$ADHOC"; codesign --force -s - "$ADHOC" 2>/dev/null
UNSIGNED="$T/fx/unsigned/Talos.app"; mkdir -p "$(dirname "$UNSIGNED")"; ditto "$BASE_APP" "$UNSIGNED"; codesign --remove-signature "$UNSIGNED"
mkzip "$ADHOC" "$Z/adhoc.zip"; mkzip "$UNSIGNED" "$Z/unsigned.zip"
mkdir -p "$T/fx/two"; ditto "$ADHOC" "$T/fx/two/Talos.app"; echo extra > "$T/fx/two/README.txt"
(cd "$T/fx/two" && ditto -c -k . "$Z/two.zip")
head -c 4096 /dev/urandom > "$Z/notzip.zip"
TEAM_X="ZZZZZZZZZ9"

echo "install.sh --from-release: arguments (exit 64, nothing installed)"
args_refused() {  # args_refused <label> <args...>
  local label="$1" rc; shift
  run "$@" --dest "$T/d-args" --no-open --no-quit --no-relay-wait >/dev/null 2>&1; rc=$?
  [ "$rc" = 64 ] && [ ! -e "$T/d-args/Talos.app" ] && ok "$label" || bad "$label: exit $rc"
}
GOOD_SHA="$(sha "$Z/adhoc.zip")"
args_refused "no --sha256" --from-release "$Z/adhoc.zip" --team "$TEAM_X"
args_refused "a --sha256 that is not 64 hex characters" --from-release "$Z/adhoc.zip" --sha256 abc123 --team "$TEAM_X"
args_refused "no --team" --from-release "$Z/adhoc.zip" --sha256 "$GOOD_SHA"
args_refused "a --team that is not a team id" --from-release "$Z/adhoc.zip" --sha256 "$GOOD_SHA" --team 'x" or 1'
args_refused "an http:// URL" --from-release "http://example.invalid/Talos.zip" --sha256 "$GOOD_SHA" --team "$TEAM_X"
args_refused "an ftp:// URL" --from-release "ftp://example.invalid/Talos.zip" --sha256 "$GOOD_SHA" --team "$TEAM_X"
args_refused "with --app" --from-release "$Z/adhoc.zip" --sha256 "$GOOD_SHA" --team "$TEAM_X" --app "$ADHOC"
args_refused "with --rollback" --rollback --from-release "$Z/adhoc.zip" --sha256 "$GOOD_SHA" --team "$TEAM_X"

echo "install.sh --from-release: checks (exit 9, a reason, nothing installed, no temp folder left)"
refused() {  # refused <label> <runner> <words> <args...>
  local label="$1" runner="$2" words="$3" d="$T/d-$RANDOM" out rc; shift 3
  out="$("$runner" "$@" --dest "$d" --no-open --no-quit --no-relay-wait 2>&1)"; rc=$?
  if [ "$rc" = 9 ] && [ ! -e "$d/Talos.app" ] && [ ! -e "$CHECKOUT_FILE" ] && no_temp_left; then
    case "$out" in *"$words"*) ok "$label" ;; *) bad "$label: refused, but not with \"$words\": $out" ;; esac
  else bad "$label: exit $rc (want 9), installed: $([ -e "$d/Talos.app" ] && echo yes || echo no), temp: $(ls -A "$T/tmp" | tr '\n' ' ')"; fi
}
refused "a wrong sha256 is refused before the zip is opened" run "sha256 is not the one given" \
  --from-release "$Z/adhoc.zip" --sha256 "$(printf '%064d' 0)" --team "$TEAM_X"
refused "the sha256 is compared whatever its case" run "Gatekeeper refuses" \
  --from-release "$Z/adhoc.zip" --sha256 "$(printf '%s' "$GOOD_SHA" | tr 'a-f' 'A-F')" --team "$TEAM_X"
refused "a path that is not there" run "is not a file" --from-release "$Z/missing.zip" --sha256 "$GOOD_SHA" --team "$TEAM_X"
refused "a file that is not a zip (right sha256)" run "not a zip" --from-release "$Z/notzip.zip" --sha256 "$(sha "$Z/notzip.zip")" --team "$TEAM_X"
refused "a zip with something beside Talos.app" run "Talos.app alone" --from-release "$Z/two.zip" --sha256 "$(sha "$Z/two.zip")" --team "$TEAM_X"
refused "an unsigned app" run "signature does not check out" --from-release "$Z/unsigned.zip" --sha256 "$(sha "$Z/unsigned.zip")" --team "$TEAM_X"
refused "an ad hoc app is refused by the real Gatekeeper check (not notarized)" run "not notarized" \
  --from-release "$Z/adhoc.zip" --sha256 "$GOOD_SHA" --team "$TEAM_X"
refused "past Gatekeeper (stub): an ad hoc app is still refused, it is not signed through Apple's certificates" run_gk "not signed with a Developer ID of team" \
  --from-release "$Z/adhoc.zip" --sha256 "$GOOD_SHA" --team "$TEAM_X"
# The download path, with a stub curl that serves the zip: https is required for the URL and every redirect, and the downloaded
# file goes through the same checks (here the real Gatekeeper refuses it).
CS="$T/curl"; mkdir -p "$CS"
cat > "$CS/curl" <<'S'
#!/bin/bash
echo "curl $*" >> "$CURL_LOG"
while [ $# -gt 0 ]; do [ "$1" = -o ] && { cp "$CURL_SERVES" "$2"; exit 0; }; shift; done
exit 22
S
chmod +x "$CS/curl"
INSTALL_CURL="$(copy_with curl "CURL=/usr/bin/curl"$'\x1f'"CURL=$CS/curl")"
curl_run() { CURL_LOG="$T/curl.log" CURL_SERVES="$Z/adhoc.zip" HOME="$FAKEHOME" TMPDIR="$T/tmp" PATH="$STUB:$PATH" bash "$INSTALL_CURL" "$@"; }
# A curl (or spctl, codesign, shasum, ditto) first on PATH is never used: install.sh calls each by full path.
PATHCURL="$T/pathcurl"; mkdir -p "$PATHCURL"
for n in curl spctl codesign shasum ditto; do printf '#!/bin/bash\necho "%s $*" >> "%s/path-tools.log"\nexit 0\n' "$n" "$T" > "$PATHCURL/$n"; chmod +x "$PATHCURL/$n"; done
HOME="$FAKEHOME" TMPDIR="$T/tmp" PATH="$PATHCURL:$STUB:$PATH" bash "$INSTALL" --from-release "$Z/adhoc.zip" --sha256 "$GOOD_SHA" --team "$TEAM_X" \
  --dest "$T/d-path" --no-open --no-quit --no-relay-wait >/dev/null 2>&1; rc=$?
[ "$rc" = 9 ] && [ ! -s "$T/path-tools.log" ] && ok "tools earlier on PATH are never asked (codesign, spctl, shasum, ditto, curl by full path)" \
  || bad "a PATH tool was used, or the ad hoc app got past: exit $rc, $(cat "$T/path-tools.log" 2>/dev/null)"
refused "a download goes through the same checks" curl_run "not notarized" \
  --from-release "https://example.invalid/Talos.zip" --sha256 "$GOOD_SHA" --team "$TEAM_X"
grep -q -- "--proto =https --proto-redir =https" "$T/curl.log" && grep -q -- "--max-filesize" "$T/curl.log" && grep -q -- "--max-time" "$T/curl.log" \
  && ok "the download is https only, redirects included, with a size cap and a time limit" || bad "curl was called as: $(cat "$T/curl.log")"
printf '#!/bin/bash\nexit 7\n' > "$CS/curl"
refused "a failed download is said, not installed" curl_run "download failed" \
  --from-release "https://example.invalid/Talos.zip" --sha256 "$GOOD_SHA" --team "$TEAM_X"
[ ! -s "$STUBLOG" ] && ok "no refused run called tmux, launchctl, osascript or open" || bad "a refused run called: $(tr '\n' ';' < "$STUBLOG")"

# --- the download flag (com.apple.quarantine) ----------------------------------------------------------------------------------
# A browser marks the zip it saves; ditto carries the mark onto every file it unpacks, and macOS then asks "downloaded from the
# Internet... Open?" and runs the app from a temporary copy (App Translocation), where the updater cannot swap it. install.sh removes
# the mark from the installed copy only after every one of its checks passed, and nowhere else.
# "past every Apple check": a copy whose SPCTL is the Gatekeeper stub above and whose CODESIGN is a wrapper that runs the REAL
# codesign for everything but Apple's certificate chain: a -R requirement is taken as met when the real signature verifies (an
# unsigned or changed app still fails), and -d -r- names a Developer ID requirement for the team. No Developer ID exists on a test Mac.
echo "install.sh --from-release: the download flag"
QFLAG="0083;6550a000;Safari;5E3D2C1B-0A9F-4E8D-B7C6-A5F4E3D2C1B0"
quarantined() { [ -n "$(find "$1" -xattrname com.apple.quarantine -print -quit 2>/dev/null)" ]; }
CW="$T/cw"; mkdir -p "$CW"
cat > "$CW/codesign" <<'S'
#!/bin/bash
args=() skip=0 show_req=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in -R) skip=1 ;; -r-) show_req=1; args+=("$a") ;; *) args+=("$a") ;; esac
done
if [ "$show_req" = 1 ]; then
  /usr/bin/codesign "${args[@]}" >/dev/null 2>&1 || exit $?
  echo "designated => anchor apple generic and identifier \"app.talos.desktop\" and certificate leaf[subject.OU] = \"ZZZZZZZZZ9\""
  exit 0
fi
exec /usr/bin/codesign "${args[@]}"
S
chmod +x "$CW/codesign"
INSTALL_PASS="$(copy_with pass "SPCTL=/usr/sbin/spctl"$'\x1f'"SPCTL=$GK/spctl" "CODESIGN=/usr/bin/codesign"$'\x1f'"CODESIGN=$CW/codesign")"
[ "$(diff "$INSTALL" "$INSTALL_PASS" | grep -c '^>')" = 1 ] || { echo "  FAIL the past-every-check copy changes more than its line" >&2; exit 1; }
# the same, but Gatekeeper refuses the staged copy: the late checks inside the lock, after the first ones passed, fail
GKL="$T/gklate"; mkdir -p "$GKL"
printf '#!/bin/bash\nfor a; do p="$a"; done\ncase "$p" in *.Talos.app.new) echo "$p: rejected" >&2; exit 3 ;; esac\necho "$p: accepted" >&2\necho "source=Notarized Developer ID" >&2\n' > "$GKL/spctl"
chmod +x "$GKL/spctl"
INSTALL_PASS_LATE="$(copy_with passlate "SPCTL=/usr/sbin/spctl"$'\x1f'"SPCTL=$GKL/spctl" "CODESIGN=/usr/bin/codesign"$'\x1f'"CODESIGN=$CW/codesign")"
# the same, and xattr cannot remove anything (a flag that stays must be said, never reported as removed)
XS="$T/xs"; mkdir -p "$XS"; printf '#!/bin/bash\necho "xattr: [Errno 1] Operation not permitted" >&2\nexit 1\n' > "$XS/xattr"; chmod +x "$XS/xattr"
INSTALL_PASS_NOX="$(copy_with passnox "SPCTL=/usr/sbin/spctl"$'\x1f'"SPCTL=$GK/spctl" "CODESIGN=/usr/bin/codesign"$'\x1f'"CODESIGN=$CW/codesign" \
  "XATTR=/usr/bin/xattr"$'\x1f'"XATTR=$XS/xattr")"
NONODE="$STUB:/usr/bin:/bin:/usr/sbin:/sbin"
pass_run() { HOME="$FAKEHOME" TMPDIR="$T/tmp" PATH="$STUB:$PATH" bash "$INSTALL_PASS" "$@"; }
QZ="$T/Downloads"; mkdir -p "$QZ"
cp "$Z/adhoc.zip" "$QZ/Talos.zip"; xattr -w com.apple.quarantine "$QFLAG" "$QZ/Talos.zip"
QSHA="$(sha "$QZ/Talos.zip")"
QREL=(--from-release "$QZ/Talos.zip" --sha256 "$QSHA" --team "$TEAM_X")
QADHOC="$T/fx/qadhoc/Talos.app"; mkdir -p "$(dirname "$QADHOC")"; ditto "$ADHOC" "$QADHOC"; xattr -w com.apple.quarantine "$QFLAG" "$QADHOC"
quarantined "$QZ/Talos.zip" && quarantined "$QADHOC" || bad "the fixtures do not carry the download flag"

# The run sheet's command on a clean Mac: no node on PATH, never paired, no --no-relay-wait, the zip as a browser left it.
if PATH="$NONODE" command -v node >/dev/null; then skip "clean-Mac case: a node is in /usr/bin"
else
  D="$T/dq-clean"
  OUT="$(HOME="$FAKEHOME" TMPDIR="$T/tmp" PATH="$NONODE" bash "$INSTALL_PASS" "${QREL[@]}" --dest "$D" --no-open --no-quit 2>&1)"; rc=$?
  if [ "$rc" = 0 ] && [ -d "$D/Talos.app" ] && ! quarantined "$D/Talos.app" && codesign --verify --strict --deep "$D/Talos.app" 2>/dev/null; then
    case "$OUT" in
      *"no relay is set"*"checked: sha256 matches, notarized by Apple, signed by team $TEAM_X; removed the download flag"*)
        ok "clean Mac (no node, not paired), past every Apple check: installs, the download flag is gone, the copy verifies, one line says what was checked" ;;
      *) bad "clean Mac: installed, but the lines are not right: $OUT" ;;
    esac
  else bad "clean Mac: exit $rc, installed: $([ -d "$D/Talos.app" ] && echo yes || echo no), flag: $(quarantined "$D/Talos.app" && echo kept || echo gone): $OUT"; fi
  quarantined "$QZ/Talos.zip" && ok "the zip given keeps its download flag (only the installed copy is changed)" || bad "the zip given lost its download flag"
  no_temp_left && ok "no temp folder left after a good install" || bad "temp left: $(ls -A "$T/tmp")"
fi

# A file the app ships read-only (the guard hooks are 0444) carrying its own download flag: the flag comes off it too,
# its mode comes back, the copy still verifies, and no warning is printed (Cyclops's clean-Mac run, 2026-11-15).
if PATH="$NONODE" command -v node >/dev/null; then skip "read-only file case: a node is in /usr/bin"
else
  RO="$T/fx/ro/Talos.app"; mkdir -p "$(dirname "$RO")"; ditto "$ADHOC" "$RO"
  mkdir -p "$RO/Contents/Resources/ro-test"; echo "# guard" > "$RO/Contents/Resources/ro-test/hook.py"; chmod 0444 "$RO/Contents/Resources/ro-test/hook.py"
  codesign --force -s - "$RO" 2>/dev/null
  xattr -w com.apple.quarantine "$QFLAG" "$RO/Contents/Resources/ro-test/hook.py"
  mkzip "$RO" "$QZ/ro.zip"; xattr -w com.apple.quarantine "$QFLAG" "$QZ/ro.zip"
  D="$T/dq-ro"
  OUT="$(HOME="$FAKEHOME" TMPDIR="$T/tmp" PATH="$NONODE" bash "$INSTALL_PASS" --from-release "$QZ/ro.zip" --sha256 "$(sha "$QZ/ro.zip")" --team "$TEAM_X" --dest "$D" --no-open --no-quit 2>&1)"; rc=$?
  H="$D/Talos.app/Contents/Resources/ro-test/hook.py"
  if [ "$rc" = 0 ] && [ -f "$H" ] && ! quarantined "$D/Talos.app" && [ "$(stat -f %Lp "$H")" = 444 ] && codesign --verify --strict --deep "$D/Talos.app" 2>/dev/null; then
    case "$OUT" in
      *"could not be removed"*) bad "read-only file: the flag is gone but the warning was printed: $OUT" ;;
      *"removed the download flag"*) ok "a read-only file with its own download flag: flag removed, mode 0444 kept, the copy verifies, no warning" ;;
      *) bad "read-only file: installed, but the lines are not right: $OUT" ;;
    esac
  else bad "read-only file: exit $rc, flag: $(quarantined "$D/Talos.app" && echo kept || echo gone), mode: $(stat -f %Lp "$H" 2>/dev/null): $OUT"; fi
fi

# A local build (--app: no --sha256, no --team): the flag stays, and no line claims a check.
D="$T/dq-app"
OUT="$(run --app "$QADHOC" --dest "$D" --no-open --no-quit --no-relay-wait 2>&1)"; rc=$?
[ "$rc" = 0 ] && quarantined "$D/Talos.app" && case "$OUT" in *"download flag"*) false ;; *) true ;; esac \
  && ok "--app install (no --sha256, no --team): the download flag stays, nothing claims a check" || bad "--app: exit $rc, flag: $(quarantined "$D/Talos.app" && echo kept || echo gone): $OUT"

# A check that fails late (the staged copy, inside the lock, after the first checks passed) over a quarantined Talos already
# installed: nothing is installed and the copy that was there keeps its flag.
before="$(snap "$D")"
OUT="$(HOME="$FAKEHOME" TMPDIR="$T/tmp" PATH="$STUB:$PATH" bash "$INSTALL_PASS_LATE" "${QREL[@]}" --dest "$D" --no-open --no-quit --no-relay-wait 2>&1)"; rc=$?
[ "$rc" = 9 ] && quarantined "$D/Talos.app" && [ "$(snap "$D")" = "$before" ] && case "$OUT" in *"removed the download flag"*) false ;; *) true ;; esac \
  && ok "a check failing late: refused (9), nothing changed, the installed copy keeps its flag" || bad "late failure: exit $rc, flag: $(quarantined "$D/Talos.app" && echo kept || echo gone): $OUT"
# Refused by the real Gatekeeper (the plain install.sh): the same.
OUT="$(run "${QREL[@]}" --dest "$D" --no-open --no-quit --no-relay-wait 2>&1)"; rc=$?
[ "$rc" = 9 ] && quarantined "$D/Talos.app" && [ "$(snap "$D")" = "$before" ] && quarantined "$QZ/Talos.zip" \
  && ok "refused by the real Gatekeeper: nothing changed, every flag stays" || bad "Gatekeeper refusal: exit $rc: $OUT"
# A wrong sha256: the same.
OUT="$(pass_run --from-release "$QZ/Talos.zip" --sha256 "$(printf '%064d' 0)" --team "$TEAM_X" --dest "$D" --no-open --no-quit --no-relay-wait 2>&1)"; rc=$?
[ "$rc" = 9 ] && quarantined "$D/Talos.app" && [ "$(snap "$D")" = "$before" ] \
  && ok "a wrong sha256, past every Apple check otherwise: refused (9), the installed copy keeps its flag" || bad "wrong sha256: exit $rc: $OUT"
# Without --sha256 (or --team) nothing runs at all.
OUT="$(pass_run --from-release "$QZ/Talos.zip" --team "$TEAM_X" --dest "$D" --no-open --no-quit --no-relay-wait 2>&1)"; rc=$?
[ "$rc" = 64 ] && quarantined "$D/Talos.app" && [ "$(snap "$D")" = "$before" ] \
  && ok "no --sha256: refused (64), the installed copy keeps its flag" || bad "no --sha256: exit $rc: $OUT"
# The flag cannot be removed: installed, and said plainly (never "removed").
D="$T/dq-nox"
OUT="$(HOME="$FAKEHOME" TMPDIR="$T/tmp" PATH="$STUB:$PATH" bash "$INSTALL_PASS_NOX" "${QREL[@]}" --dest "$D" --no-open --no-quit --no-relay-wait 2>&1)"; rc=$?
[ "$rc" = 0 ] && quarantined "$D/Talos.app" && case "$OUT" in *"removed the download flag"*) false ;; *"download flag could not be removed"*"xattr -dr com.apple.quarantine"*) true ;; *) false ;; esac \
  && ok "a flag that cannot be removed is said, with the command, never reported as removed" || bad "xattr failing: exit $rc: $OUT"
rm -f "$CHECKOUT_FILE"

# --- through Apple's certificates --------------------------------------------------------------------------------------------------
SECURITY_CASES=13
SIGN_ID="${TALOS_TEST_APPLE_SIGN_ID:-}"
echo "install.sh --from-release: signed through Apple's certificates"
if [ -z "$SIGN_ID" ]; then
  echo "  !!!! SKIPPED: $SECURITY_CASES security cases (Developer ID requirement, team pin, a good install, the recorded clone, the identity" >&2
  echo "  !!!! refusal forward and back, the check after the wait): set TALOS_TEST_APPLE_SIGN_ID to an Apple Development or Developer ID identity" >&2
elif ! case "$(security find-identity -v -p codesigning 2>/dev/null || true)" in *"\"$SIGN_ID\""*) true ;; *) false ;; esac; then
  bad "TALOS_TEST_APPLE_SIGN_ID names no valid codesigning identity on this Mac"
else
  ran=0
  count() { ran=$((ran + 1)); }
  SIGNED="$T/fx/signed/Talos.app"; mkdir -p "$(dirname "$SIGNED")"; ditto "$BASE_APP" "$SIGNED"
  # what a prebuilt app is (release-app.sh builds with --no-checkout-stamp): no clone path in Info.plist, whatever the base carries
  /usr/libexec/PlistBuddy -c "Delete :TalosCheckout" "$SIGNED/Contents/Info.plist" 2>/dev/null
  /usr/libexec/PlistBuddy -c "Print :TalosCheckout" "$SIGNED/Contents/Info.plist" >/dev/null 2>&1 && bad "the fixture still carries TalosCheckout"
  codesign --force --options runtime --timestamp=none -s "$SIGN_ID" "$SIGNED" 2>/dev/null || bad "could not sign the fixture"
  TEAM="$(codesign -dv "$SIGNED" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
  [[ "$TEAM" =~ ^[A-Z0-9]{10}$ ]] || bad "the fixture's signature carries no team id"
  mkzip "$SIGNED" "$Z/signed.zip"; SSHA="$(sha "$Z/signed.zip")"
  REL=(--from-release "$Z/signed.zip" --sha256 "$SSHA" --team "$TEAM")
  count; refused "an app signed through Apple but not notarized is refused by the real Gatekeeper check" run "not notarized" "${REL[@]}"
  case "$SIGN_ID" in
    "Developer ID Application: "*) count; skip "the identity is a Developer ID: the not-Developer-ID case needs another kind" ;;
    *) count; refused "past Gatekeeper (stub): the right team but not a Developer ID certificate is refused (the real requirement)" run_gk "not signed with a Developer ID" "${REL[@]}" ;;
  esac
  count; refused "Apple Development as Developer ID, past Gatekeeper: another team is refused" run_dev "Developer ID of team $TEAM_X" \
    --from-release "$Z/signed.zip" --sha256 "$SSHA" --team "$TEAM_X"

  D="$T/dest-signed"
  OUT="$(run_dev "${REL[@]}" --dest "$D" --no-open --no-quit --no-relay-wait 2>&1)"; rc=$?
  count; if [ "$rc" = 0 ] && codesign --verify --strict --deep "$D/Talos.app" 2>/dev/null && no_temp_left; then
    ok "Apple Development as Developer ID, past Gatekeeper: the right team installs, the copy verifies, the temp folder is gone"
  else bad "the right team: exit $rc: $OUT"; fi
  count; [ "$(cat "$CHECKOUT_FILE" 2>/dev/null)" = "$CLONE" ] && ok "the clone it was run from is recorded for the app (Application Support/app.talos.desktop/checkout)" \
    || bad "the recorded clone is '$(cat "$CHECKOUT_FILE" 2>/dev/null)', wanted '$CLONE'"
  count; [ "$(cat "$OLD_CHECKOUT_FILE" 2>/dev/null)" = "$CLONE" ] && ok "and in the old Application Support/Talos folder, for an older app" \
    || bad "the old record is '$(cat "$OLD_CHECKOUT_FILE" 2>/dev/null)', wanted '$CLONE'"
  count; case "$OUT" in *"checks out"*"signed by team $TEAM"*) ok "it says what was checked" ;; *) bad "no line about the checks: $OUT" ;; esac

  # Swapped during the relay wait: the app in the private folder is replaced by an ad hoc one between the first checks and the
  # copy. The checks run again on the staged copy, so it is refused and nothing changes.
  INSTALL_SWAP="$(copy_with swap '  "$DITTO" "$APP" "$NEW"'$'\x1f''  codesign --force -s - "$APP" 2>/dev/null; "$DITTO" "$APP" "$NEW"' \
    "SPCTL=/usr/sbin/spctl"$'\x1f'"SPCTL=$GK/spctl" "$DEVID_MARKERS"$'\x1f'"$APPLEDEV_MARKER")"
  D3="$T/dest-swap"
  OUT="$(HOME="$FAKEHOME" TMPDIR="$T/tmp" PATH="$STUB:$PATH" bash "$INSTALL_SWAP" "${REL[@]}" --dest "$D3" --no-open --no-quit --no-relay-wait 2>&1)"; rc=$?
  count; [ "$rc" = 9 ] && [ ! -e "$D3/Talos.app" ] && [ ! -e "$D3/.Talos.app.new" ] && no_temp_left \
    && ok "swapped during the wait: the staged copy is checked again and refused, nothing installed" || bad "swap after the checks: exit $rc: $OUT"

  # The installed Talos is signed with another designated requirement (as a local build signed by "Talos Local Signing" is):
  # a release with its own requirement is refused without --new-identity, and nothing changes.
  codesign --force -s "$SIGN_ID" --timestamp=none \
    --requirements "=designated => identifier \"app.talos.desktop\" and anchor apple generic and certificate leaf[subject.OU] = \"$TEAM\"" \
    "$D/Talos.app" 2>/dev/null || bad "could not re-sign the installed copy"
  before="$(snap "$D")"
  OUT="$(run_dev "${REL[@]}" --dest "$D" --no-open --no-quit --no-relay-wait 2>&1)"; rc=$?
  count; [ "$rc" = 10 ] && [ "$(snap "$D")" = "$before" ] && case "$OUT" in *"--new-identity"*"Screen & System Audio Recording"*) true ;; *) false ;; esac \
    && ok "another signing identity is refused without --new-identity (exit 10), nothing changed, and it says how to re-grant" \
    || bad "identity change: exit $rc, changed: $([ "$(snap "$D")" = "$before" ] && echo no || echo yes): $OUT"
  before="$(snap "$D")"
  run --app "$ADHOC" --dest "$D" --no-open --no-quit --no-relay-wait >/dev/null 2>&1; rc=$?
  count; [ "$rc" = 10 ] && [ "$(snap "$D")" = "$before" ] && ok "the same refusal holds for a plain --app install" || bad "--app over another identity: exit $rc"
  OUT="$(run_dev "${REL[@]}" --dest "$D" --no-open --no-quit --no-relay-wait --new-identity 2>&1)"; rc=$?
  count; [ "$rc" = 0 ] && [ "$(codesign -d -r- "$D/Talos.app" 2>&1 | grep designated)" = "$(codesign -d -r- "$SIGNED" 2>&1 | grep designated)" ] \
    && case "$OUT" in *"another identity"*"press −"*) true ;; *) false ;; esac \
    && ok "with --new-identity it installs and says to remove the old rows and grant again" || bad "--new-identity: exit $rc: $OUT"

  # Back across signers: the kept previous (the re-signed copy) is another identity than the installed one. A rollback is refused
  # without --new-identity, the same as an install, and with it rolls back and prints the steps.
  before="$(snap "$D")"
  OUT="$(run --rollback --dest "$D" --no-open --no-quit 2>&1)"; rc=$?
  count; [ "$rc" = 10 ] && [ "$(snap "$D")" = "$before" ] && case "$OUT" in *"nothing was rolled back"*"--new-identity"*) true ;; *) false ;; esac \
    && ok "a rollback to a version signed by another identity is refused without --new-identity, nothing changed" || bad "rollback across signers: exit $rc: $OUT"
  OUT="$(run --rollback --dest "$D" --no-open --no-quit --new-identity 2>&1)"; rc=$?
  count; [ "$rc" = 0 ] && case "$OUT" in *"rolled back"*"another identity"*"press −"*) true ;; *) false ;; esac \
    && ok "with --new-identity the rollback goes ahead and prints the re-grant steps" || bad "rollback --new-identity: exit $rc: $OUT"

  # Control: over an ad hoc Talos (its requirement changes with every build) a new identity installs without the flag.
  D2="$T/dest-adhoc"; run --app "$ADHOC" --dest "$D2" --no-open --no-quit --no-relay-wait >/dev/null 2>&1
  run_dev "${REL[@]}" --dest "$D2" --no-open --no-quit --no-relay-wait >/dev/null 2>&1; rc=$?
  count; [ "$rc" = 0 ] && ok "control: replacing an ad hoc Talos needs no --new-identity" || bad "control: over ad hoc: exit $rc"
  [ "$ran" = "$SECURITY_CASES" ] || bad "ran $ran security cases, SECURITY_CASES says $SECURITY_CASES"
fi
[ "$(cat "$FAKEHOME/.config/talos/desktop.json")" = '{"keep":"me"}' ] && ok "~/.config/talos was left alone" || bad "desktop.json changed"

[ ! -e "$FAKEHOME/Applications" ] && ok "the default destination was never used" || bad "something was installed into HOME/Applications"
exit $fail
