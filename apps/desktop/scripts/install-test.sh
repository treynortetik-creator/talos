#!/usr/bin/env bash
# Tests install.sh against the packed app (ci.sh builds it): installs into a temp folder, twice (over an existing copy),
# with a private tmux session standing in for the agent. Never installs to /Applications or ~/Applications, never
# opens the app, never changes login items. Usage: install-test.sh <path to a built Talos.app>
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:?usage: install-test.sh <Talos.app>}"
fail=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1" >&2; fail=1; }
T="$(mktemp -d)"
SOCK="talos-test-install-$$-$RANDOM"
TMUX_BIN="$(command -v tmux || true)"
cleanup() { [ -n "$TMUX_BIN" ] && "$TMUX_BIN" -L "$SOCK" kill-server 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
[ -n "$TMUX_BIN" ] && "$TMUX_BIN" -L "$SOCK" new-session -d -s agent -- sleep 120

bash "$HERE/scripts/install.sh" --app "$APP" --dest "$T/dest" --no-open --no-quit >/dev/null 2>&1 && ok "installs" || bad "install failed"
codesign --verify --strict "$T/dest/Talos.app" 2>/dev/null && ok "installed copy verifies" || bad "installed copy does not verify"
[ "$(codesign -d -r- "$T/dest/Talos.app" 2>&1 | grep designated)" = "$(codesign -d -r- "$APP" 2>&1 | grep designated)" ] \
  && ok "same designated requirement as the build" || bad "designated requirement changed"

bash "$HERE/scripts/install.sh" --app "$APP" --dest "$T/dest" --no-open --no-quit >/dev/null 2>&1 && ok "installs over an existing copy" || bad "reinstall failed"
[ -d "$T/dest/Talos.app" ] && [ ! -e "$T/dest/.Talos.app.new" ] && [ ! -e "$T/dest/.Talos.app.old" ] && ok "no leftovers" || bad "leftover temp bundles"

if [ -n "$TMUX_BIN" ]; then
  "$TMUX_BIN" -L "$SOCK" has-session -t agent 2>/dev/null && ok "the tmux agent survived two installs" || bad "the tmux agent died"
else
  echo "  skip tmux survival (no tmux)"
fi

bash "$HERE/scripts/install.sh" --app "$APP" --dest /Applications --no-open --no-quit >/dev/null 2>&1
[ $? = 2 ] && ok "refuses /Applications" || bad "did not refuse /Applications"
[ ! -e /Applications/Talos.app ] || echo "  note: /Applications/Talos.app exists from before this test"
bash "$HERE/scripts/install.sh" --app "$T/nope.app" --dest "$T/d2" --no-open >/dev/null 2>&1
[ $? = 1 ] && ok "missing app is an error" || bad "missing app not refused"
ln -s /Applications "$T/applink"
bash "$HERE/scripts/install.sh" --app "$APP" --dest "$T/applink/sub" --no-open --no-quit >/dev/null 2>&1
[ $? = 2 ] && ok "a symlink into /Applications is refused" || bad "a symlink into /Applications got through"
echo "x" > "$T/fake" ; mkdir -p "$T/fake.app/Contents"; cp "$APP/Contents/Info.plist" "$T/fake.app/Contents/"
bash "$HERE/scripts/install.sh" --app "$T/fake.app" --dest "$T/d3" --no-open --no-quit >/dev/null 2>&1
[ $? = 1 ] && [ ! -e "$T/d3/Talos.app" ] && ok "an unsigned bundle is refused and nothing is installed" || bad "unsigned bundle was installed"
exit $fail
