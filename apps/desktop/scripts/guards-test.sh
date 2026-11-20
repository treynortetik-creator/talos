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
# 0a. clean tests are green. ci.sh has just run them on this tree (TALOS_DESKTOP_TESTS_GREEN, its stamp of the tree and the canary
#     flag); only the same stamp reuses that run. Otherwise they run here, with the same one rerun of a failed test that ci.sh gives.
CTL_OUT="$(mktemp)"
STAMP="$(bash scripts/tests-green-stamp.sh || true)"
if [ -n "$STAMP" ] && [ "${TALOS_DESKTOP_TESTS_GREEN:-}" = "$STAMP" ]; then ok "control: test.sh green with the canary off (ci.sh's run on this tree)"
elif bash ../../scripts/ci-swift-retry.sh bash scripts/test.sh >"$CTL_OUT" 2>&1; then ok "control: test.sh green with the canary off"
else bad "control: test.sh is red with the canary off"; grep -E '✘|error:|Expectation failed|^↳' "$CTL_OUT" | grep -vE '^↳ (Testing Library|Target Platform)' | head -40; fi
rm -f "$CTL_OUT"
# 0b. a clean build passes (selftest included)
CTL="$(mktemp -d)"
export TALOS_IDENTITY_NAME="talos-test-no-such-identity"   # never touch (or depend on) the owner's real identity
export TALOS_SIGN_ID=-   # ad hoc on purpose: build-app.sh refuses a silent ad hoc fallback
if bash scripts/build-app.sh --out "$CTL" >/dev/null 2>&1; then ok "control: build-app.sh green"; else bad "control: build-app.sh red without any fault"; fi
APP="$CTL/Talos.app"
# 0b2. the built app carries the thread sessions' permission hook and its helper: the kit's own text, read-only, inside the signature
for f in permission-relay.py _talos_common.py thread-state.py compaction-guard.py; do
  B="$APP/Contents/Resources/talos-hooks/$f"
  if cmp -s "../../kit/hooks/$f" "$B" && [ "$(stat -f %Lp "$B" 2>/dev/null)" = 444 ]; then ok "the app bundles $f, read-only"; else bad "the app's talos-hooks/$f is missing, differs from the kit, or can be written to"; fi
done
if grep -q "Resources/talos-hooks/permission-relay.py" "$APP/Contents/_CodeSignature/CodeResources" 2>/dev/null; then ok "the bundled hook is in the app's signature"; else bad "the bundled hook is not sealed by the app's signature"; fi
if "$APP/Contents/MacOS/Talos" --selftest 2>/dev/null | grep -q '"worker_hook":"ok"'; then ok "the built app's own check of its hook passes (real bundle, real signature)"; else bad "the built app does not accept its own bundled hook"; fi
# and that check is real: the same app with its hook edited after signing refuses it, and its selftest fails
TAMPER="$(mktemp -d)"; cp -R "$APP" "$TAMPER/Talos.app"
chmod u+w "$TAMPER/Talos.app/Contents/Resources/talos-hooks/permission-relay.py"; echo "# edited" >> "$TAMPER/Talos.app/Contents/Resources/talos-hooks/permission-relay.py"; chmod 0444 "$TAMPER/Talos.app/Contents/Resources/talos-hooks/permission-relay.py"
TOUT="$("$TAMPER/Talos.app/Contents/MacOS/Talos" --selftest 2>/dev/null)"; TRC=$?
if [ "$TRC" != 0 ] && printf '%s' "$TOUT" | grep -q "code signature does not check out"; then ok "an app whose bundled hook was edited after signing refuses it"; else bad "an edited bundled hook passed the app's own check (exit $TRC)"; fi
rm -rf "$TAMPER"
# the built app's read-only update report, from its real entry point: help (with the agent-folder sentence) and a usage error, both
# before anything is read (a full run reads the owner's own desktop.json, so it is driven from the Swift suite with temp homes instead)
UHELP="$("$APP/Contents/MacOS/Talos" --update-check --help 2>/dev/null)"; URC=$?
if [ "$URC" = 0 ] && printf '%s' "$UHELP" | grep -qF "a session started in the agent folder picks up an edit to that folder's instruction files at its next restart; restart it to apply the edit now."; then ok "Talos --update-check --help: exit 0 with the agent-folder note"; else bad "Talos --update-check --help: exit $URC or the agent-folder note is missing"; fi
UOUT="$("$APP/Contents/MacOS/Talos" --update-check --no-such-flag 2>&1)"; URC=$?
if [ "$URC" = 2 ] && [ "$(printf '%s\n' "$UOUT" | wc -l | tr -d ' ')" = 1 ] && ! printf '%s' "$UOUT" | grep -q "no-such-flag"; then ok "Talos --update-check with an unknown argument: exit 2, one line, the argument not echoed"; else bad "Talos --update-check usage error: exit $URC, output: $UOUT"; fi
# the app's source for the hook is the bundle, never the checkout it was built from
if grep -q 'o.permissionHook = WorkerHook.appSource' Sources/TalosDesktop/SupervisorController.swift && ! grep -rnE 'kit/hooks|kitPath' Sources >/dev/null; then ok "the hook's source is the app bundle, and no source names kit/hooks"; else bad "a source still names the checkout's kit/hooks for the permission hook"; fi
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
ln -s "$HERE/../../kit" "$QCLONE/kit"; ln -s "$HERE/../../assets" "$QCLONE/assets"; ln -s "$HERE/Resources" "$QCLONE/apps/desktop/Resources"; ln -s "$HERE/Sources" "$QCLONE/apps/desktop/Sources"
cp /usr/bin/true "$QR/bin/TalosDesktop"
printf '#!/bin/sh\n[ "$1" = build ] && case " $* " in *" --show-bin-path "*) echo "%s" ;; esac\nexit 0\n' "$QR/bin" > "$QR/bin/swift"; chmod +x "$QR/bin/swift"
QWANT="$(cd "$QCLONE" && pwd -P)"
# (not a git checkout, so the hooks are named by folder: this case is about the stamp)
if PATH="$QR/bin:$PATH" APP_VERSION=1.0.0 TALOS_HOOKS_SRC="$HERE/../../kit/hooks" bash "$QCLONE/apps/desktop/scripts/build-app.sh" --out "$QR/out" >"$QR/build.log" 2>&1; then
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

# 2d. the same for the thread sessions' permission hook: a kit without it fails the build
HK="$(mktemp -d)"; cp ../../kit/hooks/_talos_common.py "$HK/"
OUT="$(mktemp -d)"
if TALOS_HOOKS_SRC="$HK" bash scripts/build-app.sh --out "$OUT" >/dev/null 2>&1; then bad "build-app.sh passed with permission-relay.py missing"; else ok "build-app.sh fails when the permission hook is missing"; fi
rm -rf "$HK" "$OUT"
# and a kit without the thread-state hook's files fails it too (the app would stage a session with none, silently)
HK="$(mktemp -d)"; cp ../../kit/hooks/_talos_common.py ../../kit/hooks/permission-relay.py ../../kit/hooks/thread-state.py "$HK/"
OUT="$(mktemp -d)"
if TALOS_HOOKS_SRC="$HK" bash scripts/build-app.sh --out "$OUT" >/dev/null 2>&1; then bad "build-app.sh passed with compaction-guard.py missing"; else ok "build-app.sh fails when a thread-state hook file is missing"; fi
rm -rf "$HK" "$OUT"

# 2e. the bundled hook is the checked-out commit's, never the working tree's: an edit left in kit/hooks (a thread session working in the
#     checkout edits files there without a prompt) fails the build and names the file; with the file put back the build passes again (0b).
#     The edit is made on a copy's inode and the committed text is put back whatever happens.
KH="../../kit/hooks/_talos_common.py"; KEEP="$(mktemp)"; cp -p "$KH" "$KEEP"
restore_kit_hook() { cp -p "$KEEP" "$KH"; rm -f "$KEEP"; }
trap restore_kit_hook EXIT
echo "# left by a thread session" >> "$KH"
OUT="$(mktemp -d)"
EOUT="$(bash scripts/build-app.sh --out "$OUT" 2>&1)"; ERC=$?
restore_kit_hook; trap - EXIT
if [ "$ERC" != 0 ] && printf '%s' "$EOUT" | grep -q "kit/hooks/_talos_common.py in the working tree is not the file the checked-out commit holds"; then ok "build-app.sh refuses a kit hook edited in the working tree"; else bad "build-app.sh sealed a kit hook edited in the working tree (exit $ERC)"; fi
if [ -e "$OUT/Talos.app/Contents/_CodeSignature" ]; then bad "an app was signed with the edited hook in it"; else ok "and no app was signed with it"; fi
if git -C ../.. diff --quiet -- kit/hooks; then ok "the kit hooks are as committed again"; else bad "guards-test left kit/hooks changed"; fi
rm -rf "$OUT"

# 2b. the Mac popup's answer button asks the controller only after the real-click check (a scripted press of the button must do nothing)
if awk '/func answerClicked/ {f=1} f && /isRealClick\(/ {g=1} f && /onClick\(/ {if (g) ok=1; exit} END {exit !ok}' Sources/TalosDesktop/NeedsYouPopup.swift; then ok "answerClicked checks isRealClick before onClick"; else bad "answerClicked reaches onClick without isRealClick first"; fi
# and that check reads the event's source (process id and source state), so a click a program posted is not the owner's
if awk '/static func isRealClick\(/ {f=1} f && /eventSourceUnixProcessID/ {p=1} f && /eventSourceStateID/ {s=1} f && /^  }/ {exit} END {exit !(p && s)}' Sources/TalosDesktop/NeedsYouPopup.swift \
  && grep -qF 'onButton && sourcePid == 0 && sourceStateId == hidSystemStateId' Sources/TalosDesktopCore/NeedsYouPopupModel.swift; then ok "isRealClick reads the event source and the pure check uses it"; else bad "isRealClick does not check where the click came from"; fi
if [ "$(grep -c 'onClick(' Sources/TalosDesktop/NeedsYouPopup.swift | tr -d ' ')" -le 3 ] && ! grep -n 'coordinator.click' Sources/TalosDesktop/NeedsYouPopup.swift | grep -v 'onClick' | grep -v 'self?.coordinator.click(dialogId: id, button: i)' | grep -q .; then ok "coordinator.click is reached only from the panel's onClick"; else bad "coordinator.click has another caller"; fi

# 3. no absolute home paths and no real hosts in apps/desktop. A "real host" is a plausible hostname (dotted labels, an
#    alphabetic TLD); only the IANA-reserved names (RFC 2606 / 6761: example.com/net/org and subdomains, .example, .invalid,
#    .test, .localhost), a few project hosts and the official sign-in and install pages the setup screen offers are
#    allowed. Test fixtures that are not hostnames at all ("https://.") don't count.
if grep -rIn --exclude-dir=.build --exclude-dir=.git --exclude=guards-test.sh -E '/Users/[A-Za-z]' . ; then warn "absolute /Users/ path in apps/desktop"; else ok "no absolute /Users/ paths"; fi
HOSTS="$(grep -rIhoE --exclude-dir=.build --exclude-dir=.git --exclude=guards-test.sh 'https?://[A-Za-z0-9._-]+' . | sed -E 's#https?://##' | sort -u \
  | grep -E '^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+\.?[A-Za-z]{2,}$|^[A-Za-z0-9-]+\.[A-Za-z]{2,}$' \
  | grep -Ev '^(localhost|127\.0\.0\.1|github\.com|www\.apple\.com|swift\.org|www\.w3\.org|code\.claude\.com|claude\.ai|claude\.com|console\.anthropic\.com|bun\.sh|brew\.sh)$' \
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

# The updater's last step and install.sh --check-only (temp repos and zips, stub pnpm/osascript/open; nothing real is touched).
AU_OUT="$(mktemp)"
if bash scripts/auto-update-apply-test.sh >"$AU_OUT" 2>&1; then ok "auto-update-apply-test.sh: $(grep -c '^  ok' "$AU_OUT") cases green"
else bad "auto-update-apply-test.sh is red"; grep 'FAIL' "$AU_OUT" | head -20; fi
rm -f "$AU_OUT"
RP_OUT="$(mktemp)"
if bash scripts/release-publish-test.sh >"$RP_OUT" 2>&1; then ok "release-publish-test.sh: $(grep -c '^  ok' "$RP_OUT") cases green"
else bad "release-publish-test.sh is red"; grep 'FAIL' "$RP_OUT" | head -20; fi
rm -f "$RP_OUT"
PL_OUT="$(mktemp)"
if bash scripts/path-leak-test.sh >"$PL_OUT" 2>&1; then ok "path-leak-test.sh: $(grep -c '^  ok' "$PL_OUT") cases green"
else bad "path-leak-test.sh is red"; grep 'FAIL' "$PL_OUT" | head -20; fi
rm -f "$PL_OUT"
NC_OUT="$(mktemp)"
if bash scripts/nested-code-test.sh >"$NC_OUT" 2>&1; then ok "nested-code-test.sh: $(grep -c '^  ok' "$NC_OUT") cases green"
else bad "nested-code-test.sh is red"; grep 'FAIL' "$NC_OUT" | head -20; fi
BM_OUT="$(mktemp)"
if bash scripts/bundle-modes-check-test.sh >"$BM_OUT" 2>&1; then ok "bundle-modes-check-test.sh: $(grep -c '^ok' "$BM_OUT") cases green"
else bad "bundle-modes-check-test.sh is red"; grep 'FAIL' "$BM_OUT" | head -20; fi
rm -f "$BM_OUT"
RS_OUT="$(mktemp "${TMPDIR:-/tmp}/talos-rpath-out-XXXXXX")"
if bash scripts/rpath-scrub-test.sh >"$RS_OUT" 2>&1; then ok "rpath-scrub-test.sh: $(grep -c '^  ok' "$RS_OUT") cases green"
else bad "rpath-scrub-test.sh is red"; grep 'FAIL' "$RS_OUT" | head -20; fi
rm -f "$RS_OUT"
rm -f "$NC_OUT"

exit $FAIL
