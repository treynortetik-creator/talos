#!/usr/bin/env bash
# Installs Talos.app into ~/Applications (no admin prompt). With tmux the agent keeps running when the old app quits and
# the new app re-attaches (DESKTOP-SPEC 6.5); with the owned-pty fallback host the agent stops when Talos quits.
# Private development: rebuild locally, then run this.
#   install.sh [--app PATH] [--dest DIR] [--no-open] [--no-quit] [--no-relay-wait] [--new-identity]
#   install.sh --from-release <https URL | path of a .zip> --sha256 <hex> --team <TEAM ID> [--dest DIR] [...as above]
#   install.sh --from-release <...> --sha256 <hex> --team <TEAM ID> --check-only
#   install.sh --rollback [--dest DIR] [--no-open] [--no-quit]
#     --app   the built bundle (default: apps/desktop/.build/app/Talos.app, from build-app.sh). Must be Talos
#             (CFBundleIdentifier app.talos.desktop).
#     --dest  where to install (default: ~/Applications). System folders (/Applications, /System, /Library, /usr ...)
#             are refused, after resolving "..", symlinks and folders that don't exist yet.
#     --no-quit  don't ask a running Talos to quit first (tests)
#     --rollback  put the one kept previous version back (see below); takes no --app
#     --no-relay-wait  install without waiting for the relay (below)
#     --from-release  install the prebuilt app (release-app.sh) instead of a local build; takes no --app. Downloaded over https
#             only (or copied from a local path) into a private temp folder, then, before anything else happens, in this order:
#             its sha256 must be the one given with --sha256; the zip must hold Talos.app and nothing else; the app must pass
#             codesign --verify --strict --deep; Gatekeeper (spctl --assess --type execute) must accept it as notarized
#             Developer ID; and its signature must satisfy a Developer ID Application requirement (Apple's anchor, the
#             Developer ID intermediate and leaf markers) for team TEAM and app.talos.desktop, where TEAM comes from --team (or
#             TALOS_RELEASE_TEAM), never from the app itself. The signature, Gatekeeper and requirement checks run again on the
#             staged copy inside the lock, after the relay wait, just before it is moved into place. Any failure: exit 9,
#             nothing installed. codesign, spctl, shasum, ditto and curl are called by full path. After the install it records this clone as the one the app uses
#             (~/Library/Application Support/Talos/checkout), because a prebuilt app carries no clone path of its own.
#     --check-only  with --from-release: run every check on the release (sha256, the zip's contents, codesign, Gatekeeper, the team)
#             and stop there, exit 0 when it checks out; nothing is installed, quit, opened or recorded. The app's own updater runs
#             this before it waits for a quiet moment, so a release that would be refused is never waited for.
#     --new-identity  allow an app signed by another identity than the installed Talos (below)
# Another identity: an app whose designated requirement (codesign -d -r-) differs from the installed Talos's is refused (exit
# 10, nothing changed) unless --new-identity is given, because macOS keeps Screen Recording and Accessibility tied to the old
# requirement: Talos would show as allowed and be refused. With --new-identity it installs and says how to grant them again.
# --rollback to a kept version signed by another identity is refused the same way (exit 10) unless --new-identity.
# An installed Talos signed ad hoc has a new requirement after every build anyway, so replacing one is never refused.
# Waiting for the relay: before it changes anything, an install waits until the relay this Mac is paired with serves the same
# build or a newer one (relay-wait.mjs: its /healthz, checked every 15 s for up to 10 min), so the web app it serves never meets a
# newer Mac and shows "newer than this app". Still behind at the limit, unreachable, or a bad answer: it stops with one line and
# exit 8, nothing changed. A Mac with no relay set skips the wait and says so, and needs no node for it (the settings are read here
# with plutil first; node runs only when a relay may be set). A relay set but no node: it installs, and one line says the relay's
# version was not checked. --rollback never waits.
# The download flag: after a --from-release install whose every check passed (the sha256 given, the zip's contents, the signature,
# Gatekeeper's notarized Developer ID answer and the --team requirement, on the staged copy too), macOS's download flag
# (com.apple.quarantine) is removed from the installed copy only, and one line says what was checked. With the flag left on, macOS
# asks "downloaded from the Internet... Open?" and runs Talos from a temporary copy (App Translocation), where the updater cannot
# swap it. It is never removed from a local --app build, from the zip given, or after any check failed.
# One step back: each install that replaces a Talos keeps that replaced copy as <dest>/.Talos.app.previous (one copy, and only
# if it still passes codesign --verify; the name does not end in .app, so macOS does not list it as a second Talos).
# `--rollback` swaps that copy into Talos.app with the same quit, swap and reopen as an install, and the version it replaced
# becomes the kept copy, so a second `--rollback` goes forward again. It refuses a kept copy that is a link, is not Talos or
# does not verify, and changes nothing when it refuses.
# Exit codes: 0 done; 1 the bundle is missing, not Talos or does not verify; 2 a system folder; 3 install: Talos did not quit,
# rollback: no previous version is kept; 4 something that is not Talos is in the way; 5 the swap failed and the old copy was put
# back; 6 rollback: Talos did not quit; 7 another install or rollback is running in the same folder; 8 the relay is not on this
# build yet, or could not be checked (nothing was changed); 9 --from-release: the download or one of its checks failed (nothing
# was changed); 10 the app is signed by another identity and --new-identity was not given (nothing was changed); 64 bad arguments.
# A run that is stopped between the two renames puts the old copy back on its way out. If it is killed outright (SIGKILL, power
# loss) Talos.app is missing until this script runs again, in either mode: it puts the copy back before doing anything else.
# It replaces only an existing *Talos* (same bundle id) and refuses anything else called Talos.app. It never touches login
# items, ~/.config/talos or the agent's tmux server, in either mode; the only process it speaks to is Talos itself, by bundle id, to ask it to quit.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HERE/.build/app/Talos.app" DEST="$HOME/Applications" OPEN=1 QUIT=1 MODE=install APP_GIVEN=0 RELAY_WAIT=1
RELEASE="" PIN="" TEAM="${TALOS_RELEASE_TEAM:-}" NEW_IDENTITY=0 REL_TMP="" CHECK_ONLY=0
WANT_ID="app.talos.desktop"
# The tools that decide what is installed, by full path: a program of the same name earlier on PATH is never asked.
CODESIGN=/usr/bin/codesign SPCTL=/usr/sbin/spctl SHASUM=/usr/bin/shasum DITTO=/usr/bin/ditto CURL=/usr/bin/curl
XATTR=/usr/bin/xattr PLUTIL=/usr/bin/plutil
# Set only once release_checks has passed on the staged copy, inside the lock: the one thing that lets the download flag go.
RELEASE_VERIFIED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --app) [ $# -ge 2 ] || { echo "install: --app needs a path" >&2; exit 64; }; APP="$2"; APP_GIVEN=1; shift 2 ;;
    --dest) [ $# -ge 2 ] || { echo "install: --dest needs a folder" >&2; exit 64; }; DEST="$2"; shift 2 ;;
    --rollback) MODE=rollback; shift ;;
    --no-open) OPEN=0; shift ;;
    --no-quit) QUIT=0; shift ;;
    --no-relay-wait) RELAY_WAIT=0; shift ;;
    --from-release) [ $# -ge 2 ] || { echo "install: --from-release needs a URL or a path" >&2; exit 64; }; RELEASE="$2"; shift 2 ;;
    --sha256) [ $# -ge 2 ] || { echo "install: --sha256 needs the zip's sha256" >&2; exit 64; }; PIN="$2"; shift 2 ;;
    --team) [ $# -ge 2 ] || { echo "install: --team needs a team id" >&2; exit 64; }; TEAM="$2"; shift 2 ;;
    --new-identity) NEW_IDENTITY=1; shift ;;
    --check-only) CHECK_ONLY=1; shift ;;
    *) echo "install: unknown argument $1" >&2; exit 64 ;;
  esac
done
if [ "$MODE" = rollback ] && [ "$APP_GIVEN" = 1 ]; then
  echo "install: --rollback puts the kept previous version back and takes no --app" >&2; exit 64
fi
[ "$CHECK_ONLY" = 0 ] || [ -n "$RELEASE" ] || { echo "install: --check-only checks a release and needs --from-release" >&2; exit 64; }
if [ -n "$RELEASE" ]; then
  [ "$MODE" = install ] || { echo "install: --rollback takes no --from-release" >&2; exit 64; }
  [ "$APP_GIVEN" = 0 ] || { echo "install: --from-release installs the prebuilt app and takes no --app" >&2; exit 64; }
  PIN="$(printf '%s' "$PIN" | tr 'A-F' 'a-f')"
  [[ "$PIN" =~ ^[0-9a-f]{64}$ ]] || { echo "install: --from-release needs --sha256 with the zip's sha256 (64 hex characters), from the release's .sha256 file or the run sheet" >&2; exit 64; }
  [[ "$TEAM" =~ ^[A-Z0-9]{10}$ ]] || { echo "install: --from-release needs --team with the publisher's Apple team id (10 capital letters and digits), from the run sheet" >&2; exit 64; }
  case "$RELEASE" in
    https://*) ;;
    *://*) echo "install: --from-release downloads over https only" >&2; exit 64 ;;
  esac
fi
plist_val() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null || true; }
plist_id() { plist_val "$1" CFBundleIdentifier; }
# "0.9.0 (build 12.3, abc1234)": the sha only when the bundle's Info.plist carries one (TalosGitSha).
describe() {
  local v b s
  v="$(plist_val "$1" CFBundleShortVersionString)"; b="$(plist_val "$1" CFBundleVersion)"; s="$(plist_val "$1" TalosGitSha)"
  printf '%s (build %s%s)' "${v:-unknown version}" "${b:-unknown}" "${s:+, $s}"
}
designated() { "$CODESIGN" -d -r- "$1" 2>&1 | grep designated || true; }
# A real folder (never a link, at the top or at Contents) that is Talos by bundle id.
is_talos_dir() {
  [ -d "$1" ] && [ ! -L "$1" ] && [ ! -L "$1/Contents" ] && [ ! -L "$1/Contents/Info.plist" ] && [ "$(plist_id "$1")" = "$WANT_ID" ]
}
is_good_talos() { is_talos_dir "$1" && "$CODESIGN" --verify --strict "$1" 2>/dev/null; }
# Test-only fault points (install-test.sh): TALOS_INSTALL_TEST_FAULT=<point> fails there, term:<point> sends this script
# SIGTERM there, kill:<point> SIGKILLs it there. Points: after-move-aside, after-swap, mid-rotate.
fault() {
  case "${TALOS_INSTALL_TEST_FAULT:-}" in
    "$1") echo "install: test fault at $1" >&2; exit 70 ;;
    "term:$1") kill -TERM $$; sleep 5 ;;
    "kill:$1") kill -KILL $$; sleep 5 ;;
  esac
  return 0
}
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

TARGET="$DEST/Talos.app" NEW="$DEST/.Talos.app.new" OLD="$DEST/.Talos.app.old" PREV="$DEST/.Talos.app.previous"
LOCK="$DEST/.Talos.app.lock" LOCKED=0 STAGED=0

# The prebuilt app: fetched into a folder only this user can read, and checked there before any of the install below sees it.
# Every check works on that private copy, so the file that was checked is the file that is installed.
release_refuse() { echo "install: stopped, nothing was installed: $1" >&2; exit 9; }
# Who may have made it: Developer ID Application (Apple's Developer ID intermediate and leaf markers), the publisher's team from
# --team (never from the app), and Talos's bundle id.
release_requirement() {
  printf '=anchor apple generic and identifier "%s" and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "%s"' "$WANT_ID" "$TEAM"
}
# The checks on an unpacked app: run on the private copy after the download, and again on the staged copy inside the lock, after
# the relay wait, so the bytes that are moved into place are the bytes that were checked.
release_checks() {
  local app="$1" assess
  "$CODESIGN" --verify --strict --deep "$app" 2>/dev/null \
    || release_refuse "the app's signature does not check out (unsigned, or changed after signing)"
  # Gatekeeper's own answer, as on a Mac that downloaded it: notarized Developer ID, stapled or looked up online.
  assess="$("$SPCTL" --assess --type execute --verbose=2 "$app" 2>&1)" \
    || release_refuse "Gatekeeper refuses the app; it is not notarized by Apple ($(printf '%s' "$assess" | head -1))"
  case "$assess" in *"source=Notarized Developer ID"*) ;; *) release_refuse "Gatekeeper did not accept the app as notarized Developer ID" ;; esac
  "$CODESIGN" --verify --strict -R "$(release_requirement)" "$app" 2>/dev/null \
    || release_refuse "the app is not signed with a Developer ID of team $TEAM through Apple's certificates"
  case "$(designated "$app")" in
    *"anchor apple generic"*) ;;
    *) release_refuse "the app's designated requirement does not ask for Apple's certificates (macOS ties permissions to it)" ;;
  esac
}
fetch_release() {
  local zip x entries assess
  REL_TMP="$(mktemp -d "${TMPDIR:-/tmp}/talos-release.XXXXXX")" || release_refuse "could not make a temp folder"
  chmod 0700 "$REL_TMP"
  zip="$REL_TMP/release.zip"
  case "$RELEASE" in
    https://*)
      [ -x "$CURL" ] || release_refuse "$CURL is needed to download the release"
      echo "install: downloading the prebuilt Talos"
      # https only, redirects included; a size cap; time limits so a stalled server ends the run instead of hanging it
      "$CURL" --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL --max-filesize 314572800 --connect-timeout 30 --max-time 900 \
        -o "$zip" "$RELEASE" || release_refuse "the download failed (curl exit $?)"
      ;;
    *)
      [ -f "$RELEASE" ] || release_refuse "$RELEASE is not a file"
      cp "$RELEASE" "$zip" || release_refuse "could not copy $RELEASE"
      ;;
  esac
  [ "$("$SHASUM" -a 256 "$zip" | awk '{print $1}')" = "$PIN" ] \
    || release_refuse "the download's sha256 is not the one given with --sha256 (a different or damaged file)"
  x="$REL_TMP/x"
  mkdir "$x"
  "$DITTO" -x -k "$zip" "$x" 2>/dev/null || release_refuse "the release is not a zip ditto can open"
  entries="$(ls -A "$x")"
  [ "$entries" = "Talos.app" ] && [ -d "$x/Talos.app" ] && [ ! -L "$x/Talos.app" ] \
    || release_refuse "the zip does not hold Talos.app alone"
  release_checks "$x/Talos.app"
  APP="$x/Talos.app"
  echo "install: the prebuilt Talos checks out: sha256 as given, notarized, signed by team $TEAM"
}

trap '[ -z "$REL_TMP" ] || rm -rf "$REL_TMP"' EXIT
[ -z "$RELEASE" ] || fetch_release
if [ "$CHECK_ONLY" = 1 ]; then echo "install: --check-only: the release checks out; nothing was installed"; exit 0; fi

if [ "$MODE" = install ]; then
  [ -d "$APP" ] || { echo "install: $APP not found (run scripts/build-app.sh first)" >&2; exit 1; }
  [ "$(plist_id "$APP")" = "$WANT_ID" ] || { echo "install: $APP is not Talos (bundle id $(plist_id "$APP"), expected $WANT_ID)" >&2; exit 1; }
  "$CODESIGN" --verify --strict "$APP" 2>/dev/null || { echo "install: $APP does not pass codesign --verify" >&2; exit 1; }
fi
# Something is already called Talos.app: replace it only if it is Talos.
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  if [ -L "$TARGET" ] || [ "$(plist_id "$TARGET")" != "$WANT_ID" ]; then
    echo "install: $TARGET exists and is not Talos ($WANT_ID); not touching it" >&2; exit 4
  fi
fi
# Another signer: macOS keeps Screen Recording and Accessibility tied to the installed Talos's requirement. Checked here, so a
# refusal comes before the relay wait, and again inside the lock, where nothing else can swap Talos.app in between.
REGRANT=0
identity_check() {
  local old_dr new_dr incoming="$APP"
  REGRANT=0
  [ "$MODE" = rollback ] && incoming="$PREV"
  is_talos_dir "$TARGET" && is_talos_dir "$incoming" || return 0
  old_dr="$(designated "$TARGET")" new_dr="$(designated "$incoming")"
  [ "$old_dr" != "$new_dr" ] || return 0
  case "$old_dr" in *'cdhash H"'*) return 0 ;; esac  # ad hoc: its requirement changed with every build, nothing carried over
  if [ "$NEW_IDENTITY" = 0 ]; then
    echo "install: stopped, nothing was $([ "$MODE" = rollback ] && echo "rolled back" || echo installed): $([ "$MODE" = rollback ] && echo "the kept previous version" || echo "this Talos") is signed by another identity than the installed one. macOS keeps Screen Recording and Accessibility tied to the old signature, so they would show as on and not work. Run again with --new-identity to install it; then, in System Settings → Privacy & Security, remove Talos from Screen & System Audio Recording and from Accessibility (select it, press −) and press Grant in Talos's Permissions again." >&2
    exit 10
  fi
  REGRANT=1
}
identity_check
if [ "$MODE" = rollback ] && [ ! -d "$DEST" ]; then
  echo "install: no previous version is kept in $DEST (the folder does not exist); nothing was changed" >&2; exit 3
fi
# May a relay be set in this Mac's Talos settings? The places relay-wait.mjs reads (configuredRelay there): desktop.json `relay_url`
# unless empty, "auto" or the placeholder; then TALOS_APP_RELAY_URL in bridge.env under the app home (desktop.json `env`, then
# $TALOS_APP_HOME, then ~/.config/talos/app). Read with plutil, so a Mac that was never paired needs no node. It only ever says "no"
# when it is sure: a file it cannot read or parse counts as "maybe", and then relay-wait.mjs decides. The address is never printed.
relay_maybe_set() {
  local cfg="$HOME/Library/Application Support/Talos/desktop.json" url="" apphome="" envf
  if [ -e "$cfg" ]; then
    [ -r "$cfg" ] && "$PLUTIL" -convert json -o /dev/null "$cfg" >/dev/null 2>&1 || return 0
    if "$PLUTIL" -extract relay_url raw -expect string -o - "$cfg" >/dev/null 2>&1; then
      url="$("$PLUTIL" -extract relay_url raw -expect string -o - "$cfg" 2>/dev/null)"
    fi
    url="$(printf '%s' "$url" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    # as relay-wait.mjs: empty and "auto" as written; the placeholder with any leading or trailing slashes
    case "$url" in '' | auto) ;; *) [ "$(printf '%s' "$url" | sed -e 's:^/*::' -e 's:/*$::')" = https://relay.example.com ] || return 0 ;; esac
    apphome="$("$PLUTIL" -extract env.TALOS_APP_HOME raw -expect string -o - "$cfg" 2>/dev/null || true)"
  fi
  [ -n "$apphome" ] || apphome="${TALOS_APP_HOME:-}"
  [ -n "$apphome" ] || apphome="$HOME/.config/talos/app"
  case "$apphome" in "~") apphome="$HOME" ;; "~/"*) apphome="$HOME/${apphome#"~/"}" ;; esac
  envf="$apphome/bridge.env"
  [ -e "$envf" ] || return 1
  [ -r "$envf" ] || return 0
  # envValue in relay-wait.mjs: `export`, quotes and a " #" comment allowed; the last TALOS_APP_RELAY_URL line wins, an empty one unsets
  awk '
    { line = $0; sub(/\r$/, "", line); gsub(/^[ \t]+|[ \t]+$/, "", line) }
    line == "" || line ~ /^#/ { next }
    { if (line ~ /^export /) { line = substr(line, 8); gsub(/^[ \t]+/, "", line) }
      eq = index(line, "="); if (eq == 0) next
      key = substr(line, 1, eq - 1); gsub(/[ \t]+$/, "", key); if (key != "TALOS_APP_RELAY_URL") next
      v = substr(line, eq + 1); gsub(/^[ \t]+|[ \t]+$/, "", v)
      q = substr(v, 1, 1)
      if ((q == "\"" || q == "'\''") && index(substr(v, 2), q) > 0) v = substr(v, 2, index(substr(v, 2), q) - 1)
      else if (index(v, " #") > 0) { v = substr(v, 1, index(v, " #") - 1); gsub(/[ \t]+$/, "", v) }
      found = v }
    END { exit (found == "" ? 1 : 0) }' "$envf"
  case $? in 0) return 0 ;; 1) return 1 ;; *) return 0 ;; esac
}
# The relay first, before anything here is changed. The address stays inside relay-wait.mjs: it reads it from this Mac's Talos
# settings itself, and never prints it or takes it on its command line.
if [ "$MODE" = install ]; then
  if [ "$RELAY_WAIT" = 0 ]; then
    echo "install: --no-relay-wait: installing without checking which version the relay serves"
  elif ! relay_maybe_set; then
    echo "install: no relay is set in this Mac's Talos settings (not paired), so the wait for the relay's version is skipped"
  elif ! command -v node >/dev/null 2>&1; then
    # never a failed install for want of node: the app runs without it; only this check needs it
    echo "install: node was not found, so the relay's version was not checked; installing anyway (if the phone then shows \"newer than this app\", the relay needs its update)" >&2
  else
    CHECKOUT="$(plist_val "$APP" TalosCheckout)"
    [ -d "$CHECKOUT" ] || CHECKOUT="$(cd "$HERE/../.." && pwd)"
    CHECKED_SHA="$(plist_val "$APP" TalosGitSha)"
    node "$HERE/scripts/relay-wait.mjs" "$CHECKED_SHA" "$CHECKOUT" || {
      rc=$?
      [ "$rc" = 8 ] || echo "install: stopped, nothing was installed: the relay check itself failed (exit $rc); run this again later, or pass --no-relay-wait to install anyway" >&2
      exit 8
    }
    # The wait can be long: a rebuild in the meantime would install a commit the relay was never checked against.
    if [ "$(plist_val "$APP" TalosGitSha)" != "$CHECKED_SHA" ]; then
      echo "install: stopped, nothing was installed: the build at $APP changed while it waited for the relay (it was ${CHECKED_SHA:-unstamped}, now $(plist_val "$APP" TalosGitSha)); run this again" >&2
      exit 8
    fi
  fi
fi
[ "$MODE" = rollback ] || mkdir -p "$DEST"

# One install or rollback at a time per folder: mkdir is the atomic claim. A lock whose owner is gone is taken over.
take_lock() {
  local owner
  if ! mkdir "$LOCK" 2>/dev/null; then
    [ -e "$LOCK" ] || [ -L "$LOCK" ] || { echo "install: cannot write to $DEST; nothing was changed" >&2; exit 1; }
    owner="$(cat "$LOCK/pid" 2>/dev/null || true)"
    case "$owner" in ''|*[!0-9]*) owner="" ;; esac
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
      echo "install: another install or rollback (pid $owner) is running in $DEST; nothing was changed" >&2; exit 7
    fi
    rm -rf "$LOCK"
    mkdir "$LOCK" 2>/dev/null || { echo "install: another install or rollback is running in $DEST; nothing was changed" >&2; exit 7; }
  fi
  LOCKED=1
  echo $$ > "$LOCK/pid"
}
# An interrupted swap left no Talos.app but the copy that was set aside: put it back.
put_back() {
  if [ ! -e "$TARGET" ] && [ ! -L "$TARGET" ] && is_talos_dir "$OLD"; then
    mv "$OLD" "$TARGET" && echo "install: an interrupted swap was undone; $TARGET is the copy that was there before" >&2
  fi
  return 0
}
# The copy that was set aside becomes the one kept previous version, if it is still a good Talos; otherwise it is dropped
# and whatever was kept before stays.
keep_old_as_previous() {
  [ -e "$OLD" ] || [ -L "$OLD" ] || return 0
  if is_good_talos "$OLD"; then
    rm -rf "$PREV"
    fault mid-rotate
    mv "$OLD" "$PREV"
  else
    echo "install: the copy that was replaced does not pass codesign --verify, so it is not kept as the previous version" >&2
    rm -rf "$OLD"
  fi
}
on_exit() {
  local rc=$?
  trap - EXIT
  [ -z "$REL_TMP" ] || rm -rf "$REL_TMP"
  if [ "$LOCKED" = 1 ]; then
    if [ "$rc" != 0 ]; then
      put_back || true
      [ "$STAGED" = 1 ] && rm -rf "$NEW"
      # Stopped after the swap: the incoming copy is in place and verified, so finish keeping the one it replaced.
      if [ -d "$TARGET" ]; then ( keep_old_as_previous ) || true; fi
    fi
    rm -rf "$LOCK"
  fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
take_lock
# Finish what an earlier, killed run left: first the missing Talos.app, then the copy it had set aside.
put_back
if [ -d "$TARGET" ]; then keep_old_as_previous; fi
identity_check

if [ "$MODE" = install ]; then
  rm -rf "$NEW"
  STAGED=1
  "$DITTO" "$APP" "$NEW"
  "$CODESIGN" --verify --strict "$NEW" || { echo "install: the copy failed verification" >&2; exit 1; }
  # a prebuilt app: every check again, on the copy that is about to be moved into place (after the relay wait)
  [ -z "$RELEASE" ] || release_checks "$NEW"
  [ "$(designated "$NEW")" = "$(designated "$APP")" ] || { echo "install: the copy's designated requirement differs from the build's" >&2; exit 1; }
  # release_checks exits on any failure, so reaching here with a release means every check passed on the copy that is moved in
  [ -z "$RELEASE" ] || RELEASE_VERIFIED=1
  INCOMING="$NEW"
else
  # Nothing is changed unless the kept copy is a real folder, is Talos and still verifies.
  if [ ! -e "$PREV" ] && [ ! -L "$PREV" ]; then
    echo "install: no previous version is kept at $PREV (one is kept each time an install replaces a Talos); nothing was changed" >&2; exit 3
  fi
  if [ -L "$PREV" ] || [ -L "$PREV/Contents" ] || [ -L "$PREV/Contents/Info.plist" ]; then
    echo "install: $PREV is a link, not the copy this script keeps; nothing was changed" >&2; exit 4
  fi
  if ! is_talos_dir "$PREV"; then
    echo "install: $PREV is not Talos (bundle id \"$(plist_id "$PREV")\", expected $WANT_ID); nothing was changed" >&2; exit 4
  fi
  "$CODESIGN" --verify --strict "$PREV" 2>/dev/null || { echo "install: $PREV does not pass codesign --verify (changed or unsigned); nothing was changed" >&2; exit 1; }
  INCOMING="$PREV"
fi

if [ "$QUIT" = 1 ] && is_running; then
  # `is running` never launches the app; the quit goes to Talos by bundle id and nothing else. This covers a first install
  # while a dev build is running too (otherwise `open` would start a second copy).
  echo "install: asking the running Talos to quit (a tmux agent keeps running; one in an owned pty stops)"
  osascript -e "tell application id \"$WANT_ID\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do is_running || break; sleep 0.5; done
  if is_running; then
    echo "install: Talos did not quit; quit it from its menu and run this again" >&2
    if [ "$MODE" = rollback ]; then exit 6; fi
    exit 3
  fi
fi

# Swap, with the way back kept: the old copy is set aside until the incoming one is in place and verifies; a failure, or a
# signal, puts it back (on_exit). Only then does the old copy become the kept previous version.
rm -rf "$OLD"
if [ -d "$TARGET" ]; then mv "$TARGET" "$OLD"; fi
fault after-move-aside
if ! mv "$INCOMING" "$TARGET"; then
  echo "install: couldn't put the $([ "$MODE" = rollback ] && echo previous || echo new) copy in place; restoring the old one" >&2
  [ -d "$OLD" ] && mv "$OLD" "$TARGET"
  exit 5
fi
STAGED=0
if ! "$CODESIGN" --verify --strict "$TARGET" 2>/dev/null; then
  echo "install: the copy in place does not verify; restoring the old one" >&2
  if [ "$MODE" = rollback ]; then mv "$TARGET" "$PREV"; else rm -rf "$TARGET"; fi
  [ -d "$OLD" ] && mv "$OLD" "$TARGET"
  exit 5
fi
fault after-swap
keep_old_as_previous
# The download flag goes only from a release whose every check passed (sha256 pinned, notarized, signed by the pinned team), only
# from the copy now in place, never from the zip given and never from a local build. One line says what was checked; a flag that
# could not be removed is said too, since macOS would then ask and run Talos from a temporary copy.
if [ "$MODE" = install ] && [ -n "$RELEASE" ] && [ "$RELEASE_VERIFIED" = 1 ] && [ -n "$PIN" ] && [ -n "$TEAM" ]; then
  flag_rc=0
  "$XATTR" -drs com.apple.quarantine "$TARGET" 2>/dev/null || flag_rc=$?
  # A file the app ships read-only (the guard hooks are 0444) refuses the removal with EACCES: make it writable for the owner,
  # remove the flag, put its mode back. The mode is not part of the code signature; the signature is checked again below.
  if [ "$flag_rc" != 0 ]; then
    flag_rc=0
    while IFS= read -r -d '' ro; do
      mode="$(/usr/bin/stat -f %Lp "$ro")" || { flag_rc=1; continue; }
      /bin/chmod u+w "$ro" && "$XATTR" -ds com.apple.quarantine "$ro" 2>/dev/null || flag_rc=1
      /bin/chmod "$mode" "$ro" || flag_rc=1
    done < <(/usr/bin/find "$TARGET" -type f -xattrname com.apple.quarantine -print0 2>/dev/null)
    # (no second -drs: it fails with EACCES on a read-only file even when the flag is already gone; the find below is the check)
    "$CODESIGN" --verify --strict "$TARGET" 2>/dev/null || flag_rc=1
  fi
  flag_left="$(/usr/bin/find "$TARGET" -xattrname com.apple.quarantine -print -quit 2>/dev/null)" || flag_rc=1
  if [ "$flag_rc" = 0 ] && [ -z "$flag_left" ]; then
    echo "install: checked: sha256 matches, notarized by Apple, signed by team $TEAM; removed the download flag, so macOS opens Talos in place without asking"
  else
    echo "install: warning: checked: sha256 matches, notarized by Apple, signed by team $TEAM; but the download flag could not be removed from $TARGET, so macOS will ask before it opens Talos and may run it from a temporary copy, where updates cannot install. Remove it with: xattr -dr com.apple.quarantine \"$TARGET\"" >&2
  fi
fi
echo "install: $TARGET"
if is_talos_dir "$PREV"; then KEPT="$(describe "$PREV") is kept as the previous version (install.sh --rollback puts it back)"
else KEPT="no previous version is kept"; fi
echo "install: $([ "$MODE" = rollback ] && echo "rolled back; ")now installed: $(describe "$TARGET"); $KEPT"
if [ "$REGRANT" = 1 ]; then
  echo "install: Talos is now signed by another identity. In System Settings → Privacy & Security → Screen & System Audio Recording, and again in Accessibility: select Talos, press −, then press Grant in Talos's Permissions (Setup) again. macOS keeps the old signature on those rows until they are removed."
fi
# A prebuilt app carries no clone path (release-app.sh), so this clone is recorded as the one it uses for Create, Adopt and
# Choose. A local build names its own clone in Info.plist, which the app prefers; the file is then left as it is.
if [ "$MODE" = install ] && [ -z "$(plist_val "$TARGET" TalosCheckout)" ]; then
  CLONE="$(cd "$HERE/../.." && pwd -P)"
  if [ -f "$CLONE/install.sh" ] && [ -f "$CLONE/apps/bridge/src/cli.ts" ] && [ -d "$CLONE/plugins/talos-app-mod" ]; then
    SUPPORT="$HOME/Library/Application Support/Talos"
    if mkdir -p "$SUPPORT" && printf '%s\n' "$CLONE" > "$SUPPORT/.checkout.$$" && mv -f "$SUPPORT/.checkout.$$" "$SUPPORT/checkout"; then
      echo "install: Talos will use this clone ($CLONE) for its agent folder setup"
    else
      rm -f "$SUPPORT/.checkout.$$"
      echo "install: warning: could not record this clone in $SUPPORT/checkout; Create, Adopt and Choose in Talos will say they cannot find a clone" >&2
    fi
  else
    echo "install: warning: $CLONE is not a whole Talos clone, so it was not recorded; run this script from your clone of the Talos repo" >&2
  fi
fi
# The relaunched app must not inherit another session's identity: run from a thread session, this script's environment holds
# TALOS_APP_WORKER_THREAD (with the role and the nonce) and Claude Code's session variables, and Main's bridge refused to be the live
# bridge because of them (2026-11-09). Main's own environment is built from the login shell and desktop.json, never from this one.
if [ "$OPEN" = 1 ]; then
  scrub=(-u TALOS_APP_WORKER_THREAD -u TALOS_SESSION_ROLE -u TALOS_APP_WORKER_NONCE -u CLAUDECODE -u CLAUDE_PID)
  # What a worker launch sets for itself (WorkerSpec): the claude.ai connectors switch, and the no-channel state dirs (the owner's own stay).
  scrub+=(-u ENABLE_CLAUDEAI_MCP_SERVERS)
  case "${TELEGRAM_STATE_DIR:-}" in */workers/_nochannel) scrub+=(-u TELEGRAM_STATE_DIR) ;; esac
  case "${IMESSAGE_STATE_DIR:-}" in */workers/_nochannel) scrub+=(-u IMESSAGE_STATE_DIR) ;; esac
  while IFS= read -r name; do [ -n "$name" ] && scrub+=(-u "$name"); done < <(env | sed -n 's/^\(CLAUDE_CODE_[A-Za-z0-9_]*\)=.*/\1/p')
  if [ -n "${TALOS_APP_WORKER_THREAD:-}${TALOS_APP_WORKER_NONCE:-}" ] || [ "${TALOS_SESSION_ROLE:-}" = worker ]; then
    echo "install: run from a thread session; its identity (TALOS_APP_WORKER_THREAD, TALOS_SESSION_ROLE, the worker nonce) and Claude Code's session variables are scrubbed from the relaunch"
  fi
  env "${scrub[@]}" open "$TARGET"
fi
exit 0
