#!/usr/bin/env bash
# Installs Talos.app into ~/Applications (no admin prompt). With tmux the agent keeps running when the old app quits and
# the new app re-attaches (DESKTOP-SPEC 6.5); with the owned-pty fallback host the agent stops when Talos quits.
# Private development: rebuild locally, then run this.
#   install.sh [--app PATH] [--dest DIR] [--no-open] [--no-quit]
#     --app   the built bundle (default: apps/desktop/.build/app/Talos.app, from build-app.sh). Must be Talos
#             (CFBundleIdentifier app.talos.desktop).
#     --dest  where to install (default: ~/Applications). System folders (/Applications, /System, /Library, /usr ...)
#             are refused, after resolving "..", symlinks and folders that don't exist yet.
#     --no-quit  don't ask a running Talos to quit first (tests)
# It replaces only an existing *Talos* (same bundle id) and refuses anything else called Talos.app. It never touches login
# items or the agent's tmux server; the only process it speaks to is Talos itself, by bundle id, to ask it to quit.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HERE/.build/app/Talos.app" DEST="$HOME/Applications" OPEN=1 QUIT=1
WANT_ID="app.talos.desktop"
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --dest) DEST="$2"; shift 2 ;;
    --no-open) OPEN=0; shift ;;
    --no-quit) QUIT=0; shift ;;
    *) echo "install: unknown argument $1" >&2; exit 64 ;;
  esac
done
plist_id() { /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null || true; }
is_running() { [ "$(osascript -e "application id \"$WANT_ID\" is running" 2>/dev/null || echo false)" = true ]; }

# Canonical destination: resolve the deepest existing ancestor with `pwd -P` (symlinks), then fold the rest lexically
# (".." included), so "/tmp/nope/../../System/x" is seen as /System/x. Builtins only: nothing is created before the check.
canonical() {
  local p="$1" d rest base
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
  d="$p"
  while [ ! -d "$d" ] && [ "$d" != / ]; do d="$(dirname "$d")"; done
  base="$(cd "$d" && pwd -P)"
  rest="${p#"$d"}"
  local -a stack=()
  local IFS=/ seg
  for seg in $base; do [ -n "$seg" ] && stack+=("$seg"); done
  for seg in $rest; do
    case "$seg" in
      ''|.) ;;
      ..) [ ${#stack[@]} -gt 0 ] && unset 'stack[${#stack[@]}-1]' ;;
      *) stack+=("$seg") ;;
    esac
  done
  printf '/%s' "${stack[@]+"${stack[@]}"}"; echo
}
# A ".." in --dest is refused outright: with a folder that doesn't exist yet its meaning depends on how the path resolves.
case "/$DEST/" in */../*) echo "install: --dest must not contain \"..\"" >&2; exit 2 ;; esac
CANON="$(canonical "$DEST")"
case "$CANON" in
  /|/Applications|/Applications/*|/System|/System/*|/Library|/Library/*|/usr|/usr/*|/bin|/bin/*|/sbin|/sbin/*|/etc|/etc/*|/private/etc|/private/etc/*|/var/root|/var/root/*|/private/var/root|/private/var/root/*)
    echo "install: $DEST resolves to $CANON, a system folder; this script installs per-user only" >&2; exit 2 ;;
esac

[ -d "$APP" ] || { echo "install: $APP not found (run scripts/build-app.sh first)" >&2; exit 1; }
[ "$(plist_id "$APP")" = "$WANT_ID" ] || { echo "install: $APP is not Talos (bundle id $(plist_id "$APP"), expected $WANT_ID)" >&2; exit 1; }
codesign --verify --strict "$APP" 2>/dev/null || { echo "install: $APP does not pass codesign --verify" >&2; exit 1; }

TARGET="$DEST/Talos.app" NEW="$DEST/.Talos.app.new" OLD="$DEST/.Talos.app.old"
# Something is already called Talos.app: replace it only if it is Talos.
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  if [ -L "$TARGET" ] || [ "$(plist_id "$TARGET")" != "$WANT_ID" ]; then
    echo "install: $TARGET exists and is not Talos ($WANT_ID); not touching it" >&2; exit 4
  fi
fi
mkdir -p "$DEST"
rm -rf "$NEW"
ditto "$APP" "$NEW"
codesign --verify --strict "$NEW" || { rm -rf "$NEW"; echo "install: the copy failed verification" >&2; exit 1; }

if [ "$QUIT" = 1 ] && is_running; then
  # `is running` never launches the app; the quit goes to Talos by bundle id and nothing else. This covers a first install
  # while a dev build is running too (otherwise `open` would start a second copy).
  echo "install: asking the running Talos to quit (a tmux agent keeps running; one in an owned pty stops)"
  osascript -e "tell application id \"$WANT_ID\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do is_running || break; sleep 0.5; done
  if is_running; then
    rm -rf "$NEW"; echo "install: Talos did not quit; quit it from its menu and run this again" >&2; exit 3
  fi
fi

# Swap with rollback: keep the old copy until the new one is in place; a failure puts it back.
rm -rf "$OLD"
if [ -d "$TARGET" ]; then mv "$TARGET" "$OLD"; fi
if ! mv "$NEW" "$TARGET"; then
  echo "install: couldn't put the new copy in place; restoring the old one" >&2
  [ -d "$OLD" ] && mv "$OLD" "$TARGET"
  rm -rf "$NEW"
  exit 5
fi
rm -rf "$OLD"
echo "install: $TARGET"
[ "$OPEN" = 1 ] && open "$TARGET"
exit 0
