#!/usr/bin/env bash
# Builds Talos.app with SwiftPM + the Command Line Tools only (no Xcode, no .xcodeproj).
#   build-app.sh [--release] [--out DIR] [--universal] [--no-checkout-stamp] [--hardened]
#     default out: apps/desktop/.build/app
#     --universal          one binary for Apple Silicon and Intel (arm64 + x86_64)
#     --no-checkout-stamp  leave out TalosCheckout (the path of this clone): a prebuilt app for another Mac, where install.sh
#                          records that Mac's own clone instead (release-app.sh)
#     --bundle-tools       put the pinned bun and tmux (and their licences) inside the app: Contents/Helpers, Contents/Resources/licenses
#                          (bundle-tools.sh; release-app.sh turns it on). A debug build leaves them out: it runs on a dev Mac.
#     --hardened           sign with the hardened runtime and a secure timestamp (needs a real identity; release-app.sh)
#     --release builds carry no path of this Mac (no /Users/<name>, no checkout path); release-app.sh checks (path-leak-check.sh).
# Signs with $TALOS_SIGN_ID if set, else the "Talos Local Signing" identity if present (scripts/make-signing-identity.sh).
# With neither it stops before building: an ad hoc build looks like a new app to macOS after every rebuild, so privacy grants
# reset and the launch seal cannot be read. TALOS_SIGN_ID=- asks for ad hoc on purpose (tests and CI). TALOS_REQUIRE_SIGN_ID=1
# also refuses the local identity: only the one named in TALOS_SIGN_ID is used (release-app.sh sets it).
# Ends with `codesign --verify --strict` and `Talos --selftest`; either failing makes this script fail.
# Env: TALOS_COMPANION_SRC, TALOS_MENUBAR_SRC, TALOS_HOOKS_SRC (other folders for the bundled art and hooks; guards-test.sh only).
# The hooks are otherwise taken from the checked-out commit, never the working tree, and a working tree that differs fails the build.
# Env: TALOS_SWIFTPM_CACHE, TALOS_SWIFT_SCRATCH (CI uses both). TALOS_SOURCE_COMMIT, TALOS_SOURCE_SHA256: stamped as TalosSourceCommit and TalosSourceSHA256 (release-app.sh).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
cd "$HERE"

CONFIG=debug OUT="$HERE/.build/app" UNIVERSAL=0 STAMP_CHECKOUT=1 HARDENED=0 BUNDLE_TOOLS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --release) CONFIG=release; shift ;;
    --out) [ $# -ge 2 ] || { echo "build-app: --out needs a folder" >&2; exit 64; }; OUT="$2"; shift 2 ;;
    --universal) UNIVERSAL=1; shift ;;
    --no-checkout-stamp) STAMP_CHECKOUT=0; shift ;;
    --hardened) HARDENED=1; shift ;;
    --bundle-tools) BUNDLE_TOOLS=1; shift ;;
    *) echo "build-app: unknown argument $1" >&2; exit 64 ;;
  esac
done

# Signing identity, decided before anything is built: explicit, then the local self-signed one, never a silent ad hoc.
IDENTITY_NAME="${TALOS_IDENTITY_NAME:-Talos Local Signing}"
ID="${TALOS_SIGN_ID:-}"
if [ -z "$ID" ]; then
  if [ -n "${TALOS_REQUIRE_SIGN_ID:-}" ]; then
    echo "build-app: stopped before building: TALOS_REQUIRE_SIGN_ID is set, so only the identity named in TALOS_SIGN_ID is used, and TALOS_SIGN_ID is empty" >&2
    exit 65
  fi
  # The list is read whole, then matched: `security ... | grep -q` under pipefail fails when grep stops early and security dies
  # writing the rest (SIGPIPE), which read as "no identity" now and then.
  IDS="$(security find-identity -v -p codesigning 2>/dev/null || true)"
  if case "$IDS" in *"\"$IDENTITY_NAME\""*) true ;; *) false ;; esac; then
    ID="$IDENTITY_NAME"
  else
    echo "build-app: stopped before building: no signing identity on this Mac. Run bash apps/desktop/scripts/make-signing-identity.sh once (it asks for your login password one time), then build again. Without one the app would be signed ad hoc, and macOS would forget its privacy permissions after every rebuild. To build ad hoc anyway (tests, CI), set TALOS_SIGN_ID=-" >&2
    exit 65
  fi
fi
if [ "$HARDENED" = 1 ] && [ "$ID" = "-" ]; then
  echo "build-app: --hardened needs a real signing identity in TALOS_SIGN_ID, not ad hoc" >&2
  exit 65
fi
command -v swift >/dev/null || { echo "build-app: swift is not installed" >&2; exit 127; }

ARGS=(-c "$CONFIG")
[ "$UNIVERSAL" = 1 ] && ARGS+=(--arch arm64 --arch x86_64)
[ -n "${TALOS_SWIFTPM_CACHE:-}" ] && ARGS+=(--cache-path "$TALOS_SWIFTPM_CACHE")
[ -n "${TALOS_SWIFT_SCRATCH:-}" ] && ARGS+=(--scratch-path "$TALOS_SWIFT_SCRATCH")

# A release carries no path of this Mac: the compiler maps the checkout and the home folder to neutral names, and the linker
# leaves out its debug map (the N_OSO/N_SO symbol entries, which hold the absolute object and source paths of the build).
if [ "$CONFIG" = release ]; then
  CHECKOUT_REAL="$(cd "$REPO" && pwd -P)"
  ARGS+=(-Xswiftc -file-prefix-map -Xswiftc "$CHECKOUT_REAL=/talos" -Xcc "-ffile-prefix-map=$CHECKOUT_REAL=/talos")
  [ "$REPO" != "$CHECKOUT_REAL" ] && ARGS+=(-Xswiftc -file-prefix-map -Xswiftc "$REPO=/talos")
  [ -n "${HOME:-}" ] && [ "$HOME" != "/" ] && ARGS+=(-Xswiftc -file-prefix-map -Xswiftc "$HOME=/home/builder" -Xcc "-ffile-prefix-map=$HOME=/home/builder")
  ARGS+=(-Xlinker -S)
fi

swift build ${ARGS[@]+"${ARGS[@]}"}
BIN="$(swift build ${ARGS[@]+"${ARGS[@]}"} --show-bin-path)/TalosDesktop"
[ -x "$BIN" ] || { echo "build-app: built binary not found at $BIN" >&2; exit 1; }

VERSION="$(node -p 'require(process.argv[1]).version' "$REPO/package.json")"
BUILD="$(node "$REPO/scripts/version.mjs")"
# CFBundleVersion allows digits and dots only; keep the git-describe text out of it.
BUILD_NUM="$(printf '%s' "$BUILD" | tr -c '0-9.' '.' | sed -E 's/\.+/./g; s/^\.//; s/\.$//')"
[ -n "$BUILD_NUM" ] || BUILD_NUM=1

APP="$OUT/Talos.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Talos"
# A release names no folder of the build Mac in its load commands either: SwiftPM adds the toolchain's back-deploy runtime folder
# as an LC_RPATH (on a Mac whose Xcode sits under the home folder, that path holds the user's name). The app needs none of it at
# its deployment target (the OS carries the Swift runtime), so every rpath into an Xcode toolchain or the home folder goes, in
# every slice; /usr/lib/swift and @loader_path stay. scripts/rpath-scrub-test.sh holds this.
if [ "$CONFIG" = release ]; then
  bash "$(dirname "$0")/rpath-scrub.sh" "$APP/Contents/MacOS/Talos" || { echo "build-app: could not take the build Mac's rpaths out of the app" >&2; exit 1; }
fi
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD_NUM/" Resources/Info.plist.template > "$APP/Contents/Info.plist"
# The clone this app was built from: Create, Adopt and Choose run its install.sh and bridge (the path may hold any character, so it goes in with plutil, which takes the value as one argument; not sed, and not PlistBuddy, whose command string has quotes of its own). The physical path: the app refuses a clone that is a link.
# A prebuilt app (--no-checkout-stamp) carries none: the Mac it is installed on records its own clone (install.sh).
[ "$STAMP_CHECKOUT" = 0 ] || plutil -replace TalosCheckout -string "$(cd "$REPO" && pwd -P)" "$APP/Contents/Info.plist"
# The commit it was built from, so install.sh can say which build is installed and which is kept. Left out (not guessed) when
# this is not a git checkout.
GIT_SHA="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || true)"
[ -z "$GIT_SHA" ] || plutil -replace TalosGitSha -string "$GIT_SHA" "$APP/Contents/Info.plist"
# The public commit this release was made from (release-app.sh passes it): the app clones the public repository at its tag and
# requires that commit, so the code it fetches is pinned by this signed app. A build without it refuses to fetch code by itself.
if [ -n "${TALOS_SOURCE_COMMIT:-}" ]; then
  [[ "$TALOS_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "build-app: TALOS_SOURCE_COMMIT is not a 40-digit commit id" >&2; exit 64; }
  plutil -replace TalosSourceCommit -string "$TALOS_SOURCE_COMMIT" "$APP/Contents/Info.plist"
fi
# sha256 of the source tarball the release publishes (talos-source-<tag>.tar.gz, made by release-app.sh): the app downloads that asset
# and checks this hash before it unpacks anything
if [ -n "${TALOS_SOURCE_SHA256:-}" ]; then
  [[ "$TALOS_SOURCE_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "build-app: TALOS_SOURCE_SHA256 is not a SHA-256 value" >&2; exit 64; }
  plutil -replace TalosSourceSHA256 -string "$TALOS_SOURCE_SHA256" "$APP/Contents/Info.plist"
fi
plutil -lint "$APP/Contents/Info.plist" >/dev/null

# Icon: committed .icns if present, else made from the brand PNG with sips + iconutil.
if [ -f Resources/Talos.icns ]; then
  cp Resources/Talos.icns "$APP/Contents/Resources/Talos.icns"
else
  SRC="$REPO/assets/brand/talos-icon-1024.png"
  SET="$(mktemp -d)/Talos.iconset"; mkdir -p "$SET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$SRC" --out "$SET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) "$SRC" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$SET" -o "$APP/Contents/Resources/Talos.icns"
  rm -rf "$(dirname "$SET")"
fi

cp Resources/tmux.conf "$APP/Contents/Resources/tmux.conf"
# The updater's last step (AutoUpdater), run from a copy so the checkout it moves never holds the script that is running.
cp scripts/auto-update-apply.sh "$APP/Contents/Resources/auto-update-apply.sh"

# The desktop companion's atlases. Copied before codesign so they are sealed into the bundle. They are committed, so absent is a
# broken checkout and the build fails: shipping without them gave an app icon on an orange square where the character belongs.
# TALOS_COMPANION_SRC points the gate at another folder (scripts/guards-test.sh uses it to prove the gate gates).
COMPANION_SRC="${TALOS_COMPANION_SRC:-Resources/companion}"
COMPANION_FILES="companion.json"
for sheet in talos talos-ext talos-life talos-loops ember mini mini-ember; do
  for scale in 1x 2x; do COMPANION_FILES="$COMPANION_FILES $sheet-$scale.png"; done
done
for f in $COMPANION_FILES; do
  if [ ! -s "$COMPANION_SRC/$f" ]; then
    echo "build-app: $COMPANION_SRC/$f is missing or empty; the companion would ship without its art" >&2
    exit 1
  fi
done
rm -rf "$APP/Contents/Resources/companion"
mkdir -p "$APP/Contents/Resources/companion"
for f in $COMPANION_FILES; do
  cp "$COMPANION_SRC/$f" "$APP/Contents/Resources/companion/$f"
  if ! cmp -s "$COMPANION_SRC/$f" "$APP/Contents/Resources/companion/$f"; then
    echo "build-app: $f in the bundle differs from $COMPANION_SRC" >&2
    exit 1
  fi
done

# The menu-bar icon's pictures (Talos's head per state, 1x and 2x). Same rule as the companion: committed, so absent is a broken
# checkout and the build fails. The states to require are read from the Swift mapping, so a new state or a typo cannot ship the
# text fallback; every picture in the folder is bundled. TALOS_MENUBAR_SRC points the gate at another folder (guards-test.sh uses it).
MENUBAR_SRC="${TALOS_MENUBAR_SRC:-Resources/menubar}"
MENUBAR_ASSETS="$(sed -n 's/.*return "\(talos-[a-z-]*\)".*/\1/p' Sources/TalosDesktopCore/MenuBarIcon.swift)"
if [ -z "$MENUBAR_ASSETS" ]; then
  echo "build-app: no menu-bar pictures are named in Sources/TalosDesktopCore/MenuBarIcon.swift" >&2
  exit 1
fi
for asset in $MENUBAR_ASSETS; do
  for scale in 1x 2x; do
    if [ ! -s "$MENUBAR_SRC/$asset-$scale.png" ]; then
      echo "build-app: $MENUBAR_SRC/$asset-$scale.png is missing or empty; the menu bar would have no picture of Talos" >&2
      exit 1
    fi
  done
done
rm -rf "$APP/Contents/Resources/menubar"
mkdir -p "$APP/Contents/Resources/menubar"
for src in "$MENUBAR_SRC"/*.png; do
  f="$(basename "$src")"
  cp "$src" "$APP/Contents/Resources/menubar/$f"
  if ! cmp -s "$src" "$APP/Contents/Resources/menubar/$f"; then
    echo "build-app: $f in the bundle differs from $MENUBAR_SRC" >&2
    exit 1
  fi
done

# The tools a clean Mac lacks: bun and tmux, pinned and checksummed (bundle-tools.sh), beside their licences. Copied before codesign.
# The nested-code pass below signs them with the app's identity; bun alone gets its engine's entitlements.
if [ "$BUNDLE_TOOLS" = 1 ]; then
  TOOLS_TMP="$(mktemp -d "${TMPDIR:-/tmp}/talos-build-tools-XXXXXX")"
  TOOLS_ARCH=arm64; [ "$UNIVERSAL" = 1 ] && TOOLS_ARCH=universal
  bash scripts/bundle-tools.sh --out "$TOOLS_TMP/out" --arch "$TOOLS_ARCH" || { rm -rf "$TOOLS_TMP"; echo "build-app: the bundled tools could not be made" >&2; exit 1; }
  mkdir -p "$APP/Contents/Helpers" "$APP/Contents/Resources/licenses"
  cp "$TOOLS_TMP/out/bin/bun" "$TOOLS_TMP/out/bin/tmux" "$APP/Contents/Helpers/"
  cp "$TOOLS_TMP/out/licenses/"* "$APP/Contents/Resources/licenses/"
  # Claude Code's installer, exactly as pinned, read-only and sealed by the signature (ClaudeInstaller runs this copy)
  cp "$TOOLS_TMP/out/claude-install.sh" "$APP/Contents/Resources/claude-install.sh"; chmod 0444 "$APP/Contents/Resources/claude-install.sh"
  rm -rf "$TOOLS_TMP"
fi

# The thread sessions' permission hook and the helper it imports, plus the thread-state hook (thread-state.py) and the compaction guard
# it shares its carry with (the app stages those two beside the permission hook the same way: WorkerHookState.swift, both or neither).
# Copied before codesign so they are sealed into the bundle, and read-only (0444): the app takes the hook from here and from nowhere else (WorkerHookSource.swift), because a thread working in
# the checkout could edit the kit's copy, which is the script that answers its own approval prompts.
# For the same reason the files are NOT read from the working tree: they are the ones the checked-out commit holds
# (`git cat-file blob HEAD:kit/hooks/...`), and the build is refused when the working tree's copy is not that same text. An edit
# a thread session left in kit/hooks, never committed and never reviewed, would otherwise be sealed into the app and trusted by it.
# No git checkout (an unpacked archive) has no commit to take them from: the build is refused, and says how to name a folder.
# Absent is a broken checkout and the build fails: the app would refuse to start any thread session. TALOS_HOOKS_SRC names a
# folder to take them from instead, as they are (scripts/guards-test.sh uses it to prove the gate gates; a build from an archive).
HOOKS_OUT="$APP/Contents/Resources/talos-hooks"
rm -rf "$HOOKS_OUT"
mkdir -p "$HOOKS_OUT"
# whatever the umask: the app refuses a hook folder another account can write (WorkerHookSource.swift)
chmod 0755 "$HOOKS_OUT"
for f in permission-relay.py _talos_common.py thread-state.py compaction-guard.py; do
  if [ -n "${TALOS_HOOKS_SRC:-}" ]; then
    if [ ! -s "$TALOS_HOOKS_SRC/$f" ] || [ -L "$TALOS_HOOKS_SRC/$f" ]; then
      echo "build-app: $TALOS_HOOKS_SRC/$f is missing, empty or a link; thread sessions would have no permission hook" >&2
      exit 1
    fi
    echo "build-app: taking $f from TALOS_HOOKS_SRC ($TALOS_HOOKS_SRC), not from the checked-out commit" >&2
    cp "$TALOS_HOOKS_SRC/$f" "$HOOKS_OUT/$f"
    WANT="$TALOS_HOOKS_SRC/$f"
  else
    if ! git -C "$REPO" rev-parse --verify -q HEAD >/dev/null 2>&1; then
      echo "build-app: $REPO is not a git checkout, so there is no commit to take kit/hooks/$f from; set TALOS_HOOKS_SRC to a folder that holds the hooks you trust" >&2
      exit 1
    fi
    # a plain file in the commit (never a link or a submodule), and its bytes exactly as committed
    case "$(git -C "$REPO" ls-tree HEAD -- "kit/hooks/$f" | awk '{print $1 " " $2}')" in
      "100644 blob" | "100755 blob") ;;
      *) echo "build-app: kit/hooks/$f is not a plain file in the checked-out commit; thread sessions would have no permission hook" >&2; exit 1 ;;
    esac
    if ! git -C "$REPO" cat-file blob "HEAD:kit/hooks/$f" > "$HOOKS_OUT/$f" || [ ! -s "$HOOKS_OUT/$f" ]; then
      echo "build-app: kit/hooks/$f could not be read from the checked-out commit, or is empty" >&2
      exit 1
    fi
    if [ -L "$REPO/kit/hooks/$f" ] || ! cmp -s "$REPO/kit/hooks/$f" "$HOOKS_OUT/$f"; then
      echo "build-app: kit/hooks/$f in the working tree is not the file the checked-out commit holds (edited, missing or a link). The app seals and trusts this file, so it is only taken as committed: commit the change, or put the file back with 'git checkout -- kit/hooks/$f', then build again" >&2
      exit 1
    fi
    WANT="$REPO/kit/hooks/$f"
  fi
  chmod 0444 "$HOOKS_OUT/$f"
  if ! cmp -s "$WANT" "$HOOKS_OUT/$f" || [ "$(stat -f %Lp "$HOOKS_OUT/$f")" != 444 ]; then
    echo "build-app: $f in the bundle differs from its source, or is not read-only" >&2
    exit 1
  fi
done

# Signing (the identity was chosen at the top). Hardened: the runtime flag and a secure timestamp, which notarization requires.
SIGN=(codesign --force --sign "$ID")
[ "$HARDENED" = 1 ] && SIGN+=(--options runtime --timestamp)
# Any other Mach-O in the bundle is signed first, deepest first, so the outer signature seals signed code (inside-out). Today the
# bundle holds one Mach-O (Contents/MacOS/Talos); this keeps a later helper or framework from shipping unsigned.
while IFS= read -r nested; do
  [ -n "$nested" ] || continue
  echo "build-app: signing nested code $nested"
  case "$nested" in
    */Contents/Helpers/bun) "${SIGN[@]}" --entitlements Resources/entitlements-bun.plist "$nested" ;;
    *) "${SIGN[@]}" "$nested" ;;
  esac
done < <(bash scripts/nested-code.sh "$APP")  # the list is nested-code.sh, tested by nested-code-test.sh
# The hardened build takes the release entitlements: the resources a local build has without asking (Resources/entitlements-release.plist).
ENTITLEMENTS=Resources/entitlements.plist
[ "$HARDENED" = 1 ] && ENTITLEMENTS=Resources/entitlements-release.plist
"${SIGN[@]}" --entitlements "$ENTITLEMENTS" "$APP"
codesign --verify --strict --verbose=1 "$APP"
echo "signed: $([ "$ID" = "-" ] && echo 'ad hoc' || echo "$ID")$([ "$HARDENED" = 1 ] && echo ', hardened runtime')"

# After signing: the hook is still in place and read-only, and the signature covers it (the selftest below asks the app itself,
# through the same check every thread session's start makes).
if [ "$(stat -f %Lp "$HOOKS_OUT")" != 755 ]; then
  echo "build-app: $HOOKS_OUT is not a folder only its owner can write (0755) after signing" >&2
  exit 1
fi
for f in permission-relay.py _talos_common.py thread-state.py compaction-guard.py; do
  if [ ! -s "$HOOKS_OUT/$f" ] || [ "$(stat -f %Lp "$HOOKS_OUT/$f")" != 444 ]; then
    echo "build-app: $HOOKS_OUT/$f is missing or not read-only after signing" >&2
    exit 1
  fi
done

"$APP/Contents/MacOS/Talos" --selftest
echo "built: $APP"
