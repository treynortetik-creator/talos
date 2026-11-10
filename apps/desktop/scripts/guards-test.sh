#!/usr/bin/env bash
# Shell-level guard tests for the desktop scripts (run by ci.sh). Each case proves a gate really gates.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
FAIL=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; FAIL=1; }
warn() { echo "  warn $1"; } # reported, never fails by default (docs/CI-LOCAL.md, "The personal-data scan")

# Positive controls first: the gates must be able to pass, or "fails" below proves nothing.
# 0a. clean tests are green
CTL_OUT="$(mktemp)"
if bash scripts/test.sh >"$CTL_OUT" 2>&1; then ok "control: test.sh green with the canary off"
else bad "control: test.sh is red with the canary off"; grep -E '✘|error:|Expectation failed|^↳' "$CTL_OUT" | grep -vE '^↳ (Testing Library|Target Platform)' | head -40; fi
rm -f "$CTL_OUT"
# 0b. a clean build passes (selftest included)
CTL="$(mktemp -d)"
export TALOS_IDENTITY_NAME="talos-test-no-such-identity"   # never touch (or depend on) the owner's real identity
if bash scripts/build-app.sh --out "$CTL" >/dev/null 2>&1; then ok "control: build-app.sh green"; else bad "control: build-app.sh red without any fault"; fi
APP="$CTL/Talos.app"
# 0c. the clone the app was built from is stamped as its physical path (the app refuses a link), and the script says so
WANT="$(cd ../.. && pwd -P)"
GOT="$(/usr/libexec/PlistBuddy -c "Print :TalosCheckout" "$APP/Contents/Info.plist" 2>/dev/null || true)"
if [ "$GOT" = "$WANT" ]; then ok "build-app.sh stamps the clone's path"; else bad "build-app.sh stamped '$GOT', wanted '$WANT'"; fi
if grep -q 'plutil -replace TalosCheckout -string "$(cd "$REPO" && pwd -P)"' scripts/build-app.sh; then ok "the stamp is the physical path"; else bad "build-app.sh stamps a logical path"; fi
# 0d. a clone path with a single quote, a double quote and spaces is stamped exactly. build-app.sh runs from a copy in such a path, with a
#     stand-in `swift` (the build succeeds and the "binary" is /usr/bin/true) so the case needs no real build; every line after that is
#     the real script. No backslash in the path: node refuses to run scripts/version.mjs from one, whatever the stamp does.
QR="$(mktemp -d)"
QCLONE="$QR/it's a \"quoted\" clone"
mkdir -p "$QCLONE/apps/desktop" "$QCLONE/scripts" "$QR/bin"
cp ../../package.json "$QCLONE/package.json"; cp ../../scripts/version.mjs "$QCLONE/scripts/version.mjs"
cp -R scripts "$QCLONE/apps/desktop/scripts"
ln -s "$HERE/../../assets" "$QCLONE/assets"; ln -s "$HERE/Resources" "$QCLONE/apps/desktop/Resources"; ln -s "$HERE/Sources" "$QCLONE/apps/desktop/Sources"
cp /usr/bin/true "$QR/bin/TalosDesktop"
printf '#!/bin/sh\n[ "$1" = build ] && case " $* " in *" --show-bin-path "*) echo "%s" ;; esac\nexit 0\n' "$QR/bin" > "$QR/bin/swift"; chmod +x "$QR/bin/swift"
QWANT="$(cd "$QCLONE" && pwd -P)"
if PATH="$QR/bin:$PATH" APP_VERSION=1.0.0 bash "$QCLONE/apps/desktop/scripts/build-app.sh" --out "$QR/out" >"$QR/build.log" 2>&1; then
  QGOT="$(plutil -extract TalosCheckout raw -o - "$QR/out/Talos.app/Contents/Info.plist" 2>/dev/null || true)"
  if [ "$QGOT" = "$QWANT" ]; then ok "a clone path with quotes and spaces is stamped exactly"; else bad "stamped '$QGOT', wanted '$QWANT'"; fi
else bad "build-app.sh failed in a clone path with quotes and spaces"; tail -5 "$QR/build.log"; fi
rm -rf "$QR"

# 1. a deliberately failing swift-testing case must make test.sh exit non-zero
if TALOS_CANARY_FAIL=1 bash scripts/test.sh >/dev/null 2>&1; then bad "canary: test.sh stayed green with a failing test"; else ok "canary: failing test turns test.sh red"; fi

# 2. build-app.sh must fail when --selftest fails
OUT="$(mktemp -d)"
if TALOS_SELFTEST_FORCE_FAIL=1 bash scripts/build-app.sh --out "$OUT" >/dev/null 2>&1; then bad "build-app.sh passed although --selftest failed"; else ok "build-app.sh fails when --selftest fails"; fi
rm -rf "$OUT"

# 2b. build-app.sh must fail when any companion sheet is absent (the character would fall back to the app icon at runtime)
CART="$(mktemp -d)"; cp -R Resources/companion "$CART/companion"; rm "$CART/companion/talos-2x.png"
OUT="$(mktemp -d)"
if TALOS_COMPANION_SRC="$CART/companion" bash scripts/build-app.sh --out "$OUT" >/dev/null 2>&1; then bad "build-app.sh passed with talos-2x.png missing"; else ok "build-app.sh fails when a companion sheet is missing"; fi
rm -rf "$CART" "$OUT"

# 2c. the same for the menu-bar pictures
MART="$(mktemp -d)"; cp -R Resources/menubar "$MART/menubar"; rm "$MART/menubar/talos-ok-2x.png"
OUT="$(mktemp -d)"
if TALOS_MENUBAR_SRC="$MART/menubar" bash scripts/build-app.sh --out "$OUT" >/dev/null 2>&1; then bad "build-app.sh passed with talos-ok-2x.png missing"; else ok "build-app.sh fails when a menu-bar picture is missing"; fi
rm -rf "$MART" "$OUT"

# 2b. the Mac popup's answer button asks the controller only after the real-click check (a scripted press of the button must do nothing)
if awk '/func answerClicked/ {f=1} f && /isRealClick\(/ {g=1} f && /onClick\(/ {if (g) ok=1; exit} END {exit !ok}' Sources/TalosDesktop/NeedsYouPopup.swift; then ok "answerClicked checks isRealClick before onClick"; else bad "answerClicked reaches onClick without isRealClick first"; fi
if [ "$(grep -c 'onClick(' Sources/TalosDesktop/NeedsYouPopup.swift | tr -d ' ')" -le 3 ] && ! grep -n 'coordinator.click' Sources/TalosDesktop/NeedsYouPopup.swift | grep -v 'onClick' | grep -v 'self?.coordinator.click(dialogId: id, button: i)' | grep -q .; then ok "coordinator.click is reached only from the panel's onClick"; else bad "coordinator.click has another caller"; fi

# 3. no absolute home paths and no real hosts in apps/desktop. A "real host" is a plausible hostname (dotted labels, an
#    alphabetic TLD); only the IANA-reserved names (RFC 2606 / 6761: example.com/net/org and subdomains, .example, .invalid,
#    .test, .localhost) and a few project hosts are allowed. Test fixtures that are not hostnames at all ("https://.") don't count.
if grep -rIn --exclude-dir=.build --exclude-dir=.git --exclude=guards-test.sh -E '/Users/[A-Za-z]' . ; then warn "absolute /Users/ path in apps/desktop"; else ok "no absolute /Users/ paths"; fi
HOSTS="$(grep -rIhoE --exclude-dir=.build --exclude-dir=.git --exclude=guards-test.sh 'https?://[A-Za-z0-9._-]+' . | sed -E 's#https?://##' | sort -u \
  | grep -E '^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+\.?[A-Za-z]{2,}$|^[A-Za-z0-9-]+\.[A-Za-z]{2,}$' \
  | grep -Ev '^(localhost|127\.0\.0\.1|github\.com|www\.apple\.com|swift\.org|www\.w3\.org|code\.claude\.com)$' \
  | grep -Eiv '(^|\.)example\.(com|net|org)$|\.(example|invalid|test|localhost)$' || true)"
if [ -n "$HOSTS" ]; then echo "$HOSTS"; bad "unexpected host in apps/desktop"; else ok "no real hosts"; fi

# 4. pnpm must not see the package (no package.json)
if [ -e package.json ]; then bad "apps/desktop has a package.json"; else ok "no package.json"; fi

# 5. Info.plist: every 4.9 purpose string present and non-empty, no URL scheme, mic text per spec, plutil clean
PL="$APP/Contents/Info.plist"
if plutil -lint "$PL" >/dev/null 2>&1; then ok "plutil -lint passes"; else bad "Info.plist does not lint"; fi
KEYS="NSDesktopFolderUsageDescription NSDocumentsFolderUsageDescription NSDownloadsFolderUsageDescription NSNetworkVolumesUsageDescription NSRemovableVolumesUsageDescription NSFileProviderDomainUsageDescription NSAppleEventsUsageDescription NSMicrophoneUsageDescription NSCameraUsageDescription NSContactsUsageDescription NSPhotoLibraryUsageDescription NSAppleMusicUsageDescription NSAppDataUsageDescription"
MISSING=""
for k in $KEYS; do
  v="$(/usr/libexec/PlistBuddy -c "Print :$k" "$PL" 2>/dev/null || true)"
  [ -n "${v// /}" ] || MISSING="$MISSING $k"
done
if [ -z "$MISSING" ]; then ok "all purpose strings present and non-empty"; else bad "purpose strings missing/empty:$MISSING"; fi
if /usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes" "$PL" >/dev/null 2>&1; then bad "CFBundleURLTypes still registered"; else ok "no URL scheme"; fi
MIC="$(/usr/libexec/PlistBuddy -c "Print :NSMicrophoneUsageDescription" "$PL" 2>/dev/null || true)"
if [ "$MIC" = "Your Talos agent runs inside this app and may use the microphone." ]; then ok "microphone text per spec"; else bad "microphone text wrong: $MIC"; fi

# 6. tmux.conf ships in the bundle with the 4.6 settings
TC="$APP/Contents/Resources/tmux.conf"
tmux_ok() { [ -f "$TC" ] || return 1; for want in "remain-on-exit on" "status off" "history-limit 50000" "default-terminal" "mouse on"; do grep -q "$want" "$TC" || return 1; done; }
if tmux_ok; then ok "tmux.conf bundled with 4.6 settings"; else bad "tmux.conf missing or incomplete in bundle"; fi

# 7. signing: no identity present -> ad hoc (cdhash); the identity script behaves on the no-identity path
if codesign -d -r- "$APP" 2>&1 | grep -q 'cdhash'; then ok "no identity: ad hoc signature (cdhash)"; else bad "expected ad hoc signature"; fi
KC="$(mktemp -d)/guard.keychain-db"; security create-keychain -p guardpw "$KC" >/dev/null 2>&1
export TALOS_KEYCHAIN="$KC" TALOS_KEYCHAIN_PASSWORD=guardpw
if bash scripts/make-signing-identity.sh --status >/dev/null 2>&1; then bad "--status says present for a name that cannot exist"; else ok "make-signing-identity --status: absent -> non-zero"; fi
if bash scripts/make-signing-identity.sh --remove >/dev/null 2>&1; then ok "make-signing-identity --remove: absent is a clean no-op"; else bad "--remove failed when nothing to remove"; fi
bash scripts/make-signing-identity.sh --no-trust >/dev/null 2>&1; bash scripts/make-signing-identity.sh --no-trust >/dev/null 2>&1
N="$(security find-certificate -a -c "$TALOS_IDENTITY_NAME" "$KC" 2>/dev/null | grep -c '^keychain:' || true)"
if [ "$N" = 1 ]; then ok "make-signing-identity twice -> one identity"; else bad "make-signing-identity twice -> $N certificates"; fi
bash scripts/make-signing-identity.sh --remove >/dev/null 2>&1
N="$(security find-certificate -a -c "$TALOS_IDENTITY_NAME" "$KC" 2>/dev/null | grep -c '^keychain:' || true)"
if [ "$N" = 0 ]; then ok "--remove deletes it"; else bad "--remove left $N certificates"; fi
security delete-keychain "$KC" >/dev/null 2>&1; unset TALOS_KEYCHAIN TALOS_KEYCHAIN_PASSWORD
rm -rf "$CTL"

# 8. CI path gating (scripts/ci-desktop-gate.sh at the repo root)
GATE="$HERE/../../scripts/ci-desktop-gate.sh"
G="$(mktemp -d)"; git -C "$G" init -q -b main; git -C "$G" config user.email t@example.com; git -C "$G" config user.name t
mkdir -p "$G/apps/web" "$G/apps/desktop" "$G/packages/protocol/src" "$G/scripts" "$G/other" "$G/apps/bridge/src" "$G/apps/bridge/test/fixtures/agent-instructions"
echo a > "$G/apps/web/a.txt"; echo b > "$G/apps/desktop/b.txt"; echo c > "$G/packages/protocol/src/native.ts"; echo d > "$G/other/moveme.txt"; echo e > "$G/scripts/native-fixtures.ts"
echo f > "$G/apps/bridge/src/claude-env.ts"; echo g > "$G/apps/bridge/test/fixtures/agent-instructions/worker.txt"; echo h > "$G/apps/bridge/src/server.ts"
git -C "$G" add -A; git -C "$G" commit -qm base; BASE="$(git -C "$G" rev-parse HEAD)"
gate() { (cd "$G" && bash "$GATE" "$BASE" HEAD >/dev/null 2>&1); }
echo a2 > "$G/apps/web/a.txt"; git -C "$G" commit -qam web
if gate; then bad "gate ran desktop for a web-only change"; else ok "web-only change -> skipped"; fi
echo c2 > "$G/packages/protocol/src/native.ts"; git -C "$G" commit -qam native
if gate; then ok "native.ts change -> runs"; else bad "native.ts change did not run desktop"; fi
# desktop tests read these two bridge files (ClaudeEnvScrubTests, FallbackPreambleTests); other bridge files do not run desktop
for f in apps/bridge/src/claude-env.ts apps/bridge/test/fixtures/agent-instructions/worker.txt; do
  git -C "$G" reset -q --hard "$BASE"; echo x >> "$G/$f"; git -C "$G" commit -qam bridge
  if gate; then ok "$f change -> runs"; else bad "$f change did not run desktop"; fi
done
git -C "$G" reset -q --hard "$BASE"; echo x >> "$G/apps/bridge/src/server.ts"; git -C "$G" commit -qam bridge-other
if gate; then bad "gate ran desktop for another bridge file"; else ok "another bridge file -> skipped"; fi
git -C "$G" reset -q --hard "$BASE"; git -C "$G" mv other/moveme.txt apps/desktop/moveme.txt; git -C "$G" commit -qm rename
if gate; then ok "rename into apps/desktop -> runs"; else bad "gate fooled by a rename into apps/desktop"; fi
git -C "$G" reset -q --hard "$BASE"; git -C "$G" mv apps/desktop/b.txt other/b.txt; git -C "$G" commit -qm rename-out
if gate; then ok "rename out of apps/desktop -> runs"; else bad "gate fooled by a rename out of apps/desktop"; fi
rm -rf "$G"

exit $FAIL
