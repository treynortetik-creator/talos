#!/usr/bin/env bash
# Builds Talos.app with SwiftPM + the Command Line Tools only (no Xcode, no .xcodeproj).
#   build-app.sh [--release] [--out DIR]       default out: apps/desktop/.build/app
# Signs with $TALOS_SIGN_ID if set, else the "Talos Local Signing" identity if present, else ad hoc. Ends with
# `codesign --verify --strict` and `Talos --selftest`; either failing makes this script fail.
# Env: TALOS_SWIFTPM_CACHE, TALOS_SWIFT_SCRATCH (CI uses both).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
cd "$HERE"

CONFIG=debug OUT="$HERE/.build/app"
while [ $# -gt 0 ]; do
  case "$1" in
    --release) CONFIG=release; shift ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "build-app: unknown argument $1" >&2; exit 64 ;;
  esac
done
command -v swift >/dev/null || { echo "build-app: swift is not installed" >&2; exit 127; }

ARGS=(-c "$CONFIG")
[ -n "${TALOS_SWIFTPM_CACHE:-}" ] && ARGS+=(--cache-path "$TALOS_SWIFTPM_CACHE")
[ -n "${TALOS_SWIFT_SCRATCH:-}" ] && ARGS+=(--scratch-path "$TALOS_SWIFT_SCRATCH")

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
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD_NUM/" Resources/Info.plist.template > "$APP/Contents/Info.plist"
# The clone this app was built from: Create, Adopt and Choose run its install.sh and bridge (the path may hold any character, so it goes in with plutil, which takes the value as one argument; not sed, and not PlistBuddy, whose command string has quotes of its own). The physical path: the app refuses a clone that is a link.
plutil -replace TalosCheckout -string "$(cd "$REPO" && pwd -P)" "$APP/Contents/Info.plist"
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

# Signing identity: explicit, then the local self-signed one (scripts/make-signing-identity.sh), then ad hoc.
IDENTITY_NAME="${TALOS_IDENTITY_NAME:-Talos Local Signing}"
ID="${TALOS_SIGN_ID:-}"
if [ -z "$ID" ] && security find-identity -v -p codesigning 2>/dev/null | grep -qF "\"$IDENTITY_NAME\""; then
  ID="$IDENTITY_NAME"
fi
[ -n "$ID" ] || ID="-"
codesign --force --sign "$ID" --entitlements Resources/entitlements.plist "$APP"
codesign --verify --strict --verbose=1 "$APP"
echo "signed: $([ "$ID" = "-" ] && echo 'ad hoc' || echo "$ID")"

"$APP/Contents/MacOS/Talos" --selftest
echo "built: $APP"
