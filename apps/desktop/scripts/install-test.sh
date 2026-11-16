#!/usr/bin/env bash
# Tests install.sh against the packed app (ci.sh builds it): installs into a temp folder, twice (over an existing copy),
# with a private tmux session standing in for the agent, then the kept previous version and `--rollback`. Never installs to
# /Applications or ~/Applications, never opens the app, never changes login items: every run of install.sh here gets a temp
# HOME and stub `osascript`, `open`, `tmux` and `launchctl` in front of the real ones, so no real Talos is asked anything.
# Usage: install-test.sh <path to a built Talos.app>
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:?usage: install-test.sh <Talos.app>}"
INSTALL="$HERE/scripts/install.sh"
fail=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1" >&2; fail=1; }
T="$(mktemp -d)"
SOCK="talos-test-install-$$-$RANDOM"
TMUX_BIN="$(command -v tmux || true)"
cleanup() { [ -n "$TMUX_BIN" ] && "$TMUX_BIN" -L "$SOCK" kill-server 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
# The relay wait (relay-wait-test.sh) reads the Mac's Talos settings: keep a session's real app home out of these runs.
unset TALOS_APP_HOME
[ -n "$TMUX_BIN" ] && "$TMUX_BIN" -L "$SOCK" new-session -d -s agent -- sleep 300

# Stubs: a "running Talos" is the file $STUBRUN, and a quit removes it. tmux and launchctl only log: install.sh must never call them.
STUB="$T/stub"; mkdir -p "$STUB"
cat > "$STUB/osascript" <<'S'
#!/bin/bash
echo "osascript $2" >> "$STUBLOG"
case "$2" in
  *"is running"*) [ -e "$STUBRUN" ] && echo true || echo false ;;
  *"to quit"*) rm -f "$STUBRUN" ;;
esac
S
for name in open tmux launchctl; do printf '#!/bin/bash\necho "%s $*" >> "$STUBLOG"\n' "$name" > "$STUB/$name"; done
chmod +x "$STUB"/*
export STUBLOG="$T/stub.log" STUBRUN="$T/running"
: > "$STUBLOG"
FAKEHOME="$T/home"
mkdir -p "$FAKEHOME/.config/talos" "$FAKEHOME/Library/LaunchAgents"
echo '{"keep":"me"}' > "$FAKEHOME/.config/talos/desktop.json"
echo keep > "$FAKEHOME/Library/LaunchAgents/app.talos.desktop.plist"
run() { HOME="$FAKEHOME" PATH="$STUB:$PATH" bash "$INSTALL" "$@"; }

# Everything under a folder: names, sizes, times, link targets. Any rename, write or delete inside changes it. The folder's own
# time is left out: a refused run still takes and drops its lock there, which is not a change to anything kept.
snap() { find "$1" -mindepth 1 -exec stat -f '%N|%z|%m|%HT|%Y' {} + 2>/dev/null | LC_ALL=C sort | shasum | cut -d' ' -f1; }
build_of() { /usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$1/Contents/Info.plist" 2>/dev/null; }
verifies() { codesign --verify --strict "$1" 2>/dev/null; }
no_temp() { [ ! -e "$1/.Talos.app.new" ] && [ ! -e "$1/.Talos.app.old" ] && [ ! -e "$1/.Talos.app.lock" ]; }

run --app "$APP" --dest "$T/dest" --no-open --no-quit >/dev/null 2>&1 && ok "installs" || bad "install failed"
verifies "$T/dest/Talos.app" && ok "installed copy verifies" || bad "installed copy does not verify"
[ "$(codesign -d -r- "$T/dest/Talos.app" 2>&1 | grep designated)" = "$(codesign -d -r- "$APP" 2>&1 | grep designated)" ] \
  && ok "same designated requirement as the build" || bad "designated requirement changed"
want_sha="$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || true)"
got_sha="$(/usr/libexec/PlistBuddy -c 'Print :TalosGitSha' "$APP/Contents/Info.plist" 2>/dev/null || true)"
if [ -z "$got_sha" ]; then bad "the build carries no TalosGitSha (build-app.sh stamps it)"
elif [ -n "$want_sha" ] && [ "$got_sha" != "$want_sha" ]; then echo "  note: the build's TalosGitSha $got_sha is not this checkout's HEAD $want_sha (built from another commit)"
else ok "the build carries its git sha (TalosGitSha $got_sha)"; fi
OUT="$(run --app "$APP" --dest "$T/dest-sha" --no-open --no-quit 2>&1)"
case "$OUT" in *"now installed: "*", $got_sha)"*) ok "the install line names the build's git sha" ;; *) bad "the install line does not name the git sha: $OUT" ;; esac
[ ! -e "$T/dest/.Talos.app.previous" ] && ok "a first install keeps no previous version" || bad "a first install left a previous version"

run --app "$APP" --dest "$T/dest" --no-open --no-quit >/dev/null 2>&1 && ok "installs over an existing copy" || bad "reinstall failed"
[ -d "$T/dest/Talos.app" ] && no_temp "$T/dest" && ok "no leftovers" || bad "leftover temp bundles"

if [ -n "$TMUX_BIN" ]; then
  "$TMUX_BIN" -L "$SOCK" has-session -t agent 2>/dev/null && ok "the tmux agent survived two installs" || bad "the tmux agent died"
else
  echo "  skip tmux survival (no tmux)"
fi

run --app "$APP" --dest /Applications --no-open --no-quit >/dev/null 2>&1
[ $? = 2 ] && ok "refuses /Applications" || bad "did not refuse /Applications"
[ ! -e /Applications/Talos.app ] || echo "  note: /Applications/Talos.app exists from before this test"
run --app "$T/nope.app" --dest "$T/d2" --no-open --no-quit >/dev/null 2>&1
[ $? = 1 ] && ok "missing app is an error" || bad "missing app not refused"
ln -s /Applications "$T/applink"
run --app "$APP" --dest "$T/applink/sub" --no-open --no-quit >/dev/null 2>&1
[ $? = 2 ] && ok "a symlink into /Applications is refused" || bad "a symlink into /Applications got through"
echo "x" > "$T/fake" ; mkdir -p "$T/fake.app/Contents"; cp "$APP/Contents/Info.plist" "$T/fake.app/Contents/"
run --app "$T/fake.app" --dest "$T/d3" --no-open --no-quit >/dev/null 2>&1
[ $? = 1 ] && [ ! -e "$T/d3/Talos.app" ] && ok "an unsigned bundle is refused and nothing is installed" || bad "unsigned bundle was installed"

# --- the kept previous version and --rollback -------------------------------------------------------------------------------
# Two builds that differ: A and B are copies of the packed app with their own CFBundleVersion (B also carries a git sha),
# re-signed ad hoc so the fixtures never need a keychain. They are only ever copied and verified, never run.
variant() {  # variant <dir> <CFBundleVersion> [git sha] [bundle id]
  mkdir -p "$(dirname "$1")"
  ditto "$APP" "$1" || return 1
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $2" "$1/Contents/Info.plist" || return 1
  /usr/libexec/PlistBuddy -c "Delete :TalosGitSha" "$1/Contents/Info.plist" 2>/dev/null   # the packed app's own; A and C carry none
  [ -z "${3:-}" ] || /usr/libexec/PlistBuddy -c "Add :TalosGitSha string $3" "$1/Contents/Info.plist" || return 1
  [ -z "${4:-}" ] || /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $4" "$1/Contents/Info.plist" || return 1
  codesign --force -s - "$1" 2>/dev/null && verifies "$1"
}
A="$T/a/Talos.app" B="$T/b/Talos.app" C="$T/c/Talos.app"
variant "$A" 7001.1 && variant "$B" 7002.2 abc1234 && variant "$C" 7003.3 || { echo "  FAIL could not make the test bundles" >&2; exit 1; }
VA=7001.1 VB=7002.2 VC=7003.3
D="$T/roll"; CUR="$D/Talos.app"; PREV="$D/.Talos.app.previous"
state() { echo "$(build_of "$CUR")/$(build_of "$PREV")"; }

echo "rollback"
run --rollback --dest "$T/never-made" --no-open --no-quit >/dev/null 2>&1
[ $? = 3 ] && [ ! -e "$T/never-made" ] && ok "rollback in a folder that does not exist exits 3 and creates nothing" || bad "rollback with no folder"
run --app "$A" --dest "$D" --no-open --no-quit >/dev/null 2>&1 || bad "install A failed"
before="$(snap "$D")"
OUT="$(run --rollback --dest "$D" --no-open --no-quit 2>&1)"; rc=$?
[ "$rc" = 3 ] && [ "$(snap "$D")" = "$before" ] && ok "rollback with no previous exits 3 and changes nothing" || bad "rollback with no previous: exit $rc, or the folder changed"
case "$OUT" in *"no previous version"*"nothing was changed"*) ok "and it says why" ;; *) bad "no clear message for a missing previous: $OUT" ;; esac

OUT="$(run --app "$B" --dest "$D" --no-open --no-quit 2>&1)" || bad "install B over A failed"
[ "$(state)" = "$VB/$VA" ] && ok "install A then B: B is installed, A is kept as previous" || bad "after A then B: $(state)"
verifies "$CUR" && verifies "$PREV" && no_temp "$D" && ok "both verify, no temp bundles" || bad "A/B do not verify or left temp bundles"
case "$OUT" in *"now installed: "*"(build $VB, abc1234)"*"(build $VA) is kept as the previous version"*) ok "the install says which build is installed (with its git sha) and which is kept" ;; *) bad "install summary line: $OUT" ;; esac

run --app "$C" --dest "$D" --no-open --no-quit >/dev/null 2>&1 || bad "install C over B failed"
[ "$(state)" = "$VC/$VB" ] && [ "$(ls -A "$D" | wc -l | tr -d ' ')" = 2 ] && ok "a third install keeps exactly one previous (B), A is gone" || bad "after C: $(state), $(ls -A "$D" | tr '\n' ' ')"
run --app "$B" --dest "$D" --no-open --no-quit >/dev/null 2>&1; run --rollback --dest "$D" --no-open --no-quit >/dev/null 2>&1
run --app "$A" --dest "$D" --no-open --no-quit >/dev/null 2>&1; run --app "$B" --dest "$D" --no-open --no-quit >/dev/null 2>&1
[ "$(state)" = "$VB/$VA" ] || bad "could not get back to B over A: $(state)"

: > "$STUBLOG"; home_before="$(snap "$FAKEHOME")"
OUT="$(run --rollback --dest "$D" --no-open --no-quit 2>&1)"; rc=$?
[ "$rc" = 0 ] && [ "$(state)" = "$VA/$VB" ] && ok "rollback: A is installed, B is kept as previous" || bad "after rollback: exit $rc, $(state)"
verifies "$CUR" && verifies "$PREV" && no_temp "$D" && ok "both verify after the rollback, no temp bundles" || bad "rollback left a bundle that does not verify, or temp bundles"
case "$OUT" in *"rolled back; now installed: "*"(build $VA)"*"(build $VB, abc1234) is kept as the previous version"*) ok "the rollback says which build is installed and which is kept" ;; *) bad "rollback summary line: $OUT" ;; esac
OUT="$(run --rollback --dest "$D" --no-open --no-quit 2>&1)"; rc=$?
[ "$rc" = 0 ] && [ "$(state)" = "$VB/$VA" ] && verifies "$CUR" && ok "rollback again goes forward: B is installed, A is kept" || bad "after the second rollback: exit $rc, $(state)"
[ "$(snap "$FAKEHOME")" = "$home_before" ] && ok "two rollbacks left ~/.config/talos and the login item alone" || bad "a rollback changed something under HOME"
[ ! -s "$STUBLOG" ] && ok "two rollbacks ran no tmux, launchctl, osascript or open (--no-open --no-quit)" || bad "a rollback called: $(tr '\n' ';' < "$STUBLOG")"
if [ -n "$TMUX_BIN" ]; then
  "$TMUX_BIN" -L "$SOCK" has-session -t agent 2>/dev/null && ok "the tmux agent survived the rollbacks" || bad "the tmux agent died in a rollback"
fi

# The same quit and reopen as an install: a running Talos is asked to quit by bundle id, and the app is opened after.
touch "$STUBRUN"; : > "$STUBLOG"
run --rollback --dest "$D" >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] && [ "$(state)" = "$VA/$VB" ] && grep -q 'tell application id "app.talos.desktop" to quit' "$STUBLOG" && grep -q "^open $CUR\$" "$STUBLOG" \
  && ok "without the flags a rollback quits the running Talos by bundle id and reopens it" || bad "rollback quit/reopen: exit $rc, $(tr '\n' ';' < "$STUBLOG")"
grep -q '^tmux\|^launchctl' "$STUBLOG" && bad "a rollback with quit and reopen called tmux or launchctl" || ok "and still calls neither tmux nor launchctl"
cat > "$STUB/osascript.stuck" <<'S'
#!/bin/bash
case "$2" in *"is running"*) echo true ;; esac
S
mkdir -p "$T/stuck"; cp "$STUB/osascript.stuck" "$T/stuck/osascript"; chmod +x "$T/stuck/osascript"
printf '#!/bin/bash\nexit 0\n' > "$T/stuck/sleep"; chmod +x "$T/stuck/sleep"
before="$(snap "$D")"
HOME="$FAKEHOME" PATH="$T/stuck:$STUB:$PATH" bash "$INSTALL" --rollback --dest "$D" --no-open >/dev/null 2>&1; rc=$?
[ "$rc" = 6 ] && [ "$(snap "$D")" = "$before" ] && ok "a Talos that will not quit stops the rollback (exit 6) with nothing changed" || bad "rollback over a Talos that will not quit: exit $rc"
rm -f "$STUBRUN"
run --rollback --dest "$D" --no-open --no-quit >/dev/null 2>&1
[ "$(state)" = "$VB/$VA" ] || bad "could not get back to B over A: $(state)"

echo "rollback refusals (each one: non-zero, a reason, nothing changed)"
refused() {  # refused <label> <expected exit> <words expected in the message> [install.sh args; default: the rollback]
  local label="$1" want="$2" words="$3" before out rc; shift 3
  [ $# -gt 0 ] || set -- --rollback --dest "$D" --no-open --no-quit
  before="$(snap "$D")"
  out="$(run "$@" 2>&1)"; rc=$?
  if [ "$rc" = "$want" ] && [ "$(snap "$D")" = "$before" ] && [ "$(build_of "$CUR")" = "$VB" ] && verifies "$CUR"; then
    case "$out" in *"$words"*) ok "$label" ;; *) bad "$label: refused, but the message does not say \"$words\": $out" ;; esac
  else bad "$label: exit $rc (want $want), or the folder changed"; fi
}
SAVED="$T/saved-previous"
mv "$PREV" "$SAVED"; ditto "$SAVED" "$PREV"; echo tampered >> "$PREV/Contents/Info.plist"
refused "a previous whose Info.plist was changed is refused" 1 "does not pass codesign --verify"
rm -rf "$PREV"; ditto "$SAVED" "$PREV"; echo tampered > "$PREV/Contents/Resources/added-later.txt"
refused "a previous with a file added to it is refused" 1 "does not pass codesign --verify"
rm -rf "$PREV"; ditto "$SAVED" "$PREV"; codesign --remove-signature "$PREV" 2>/dev/null
refused "an unsigned previous is refused" 1 "does not pass codesign --verify"
rm -rf "$PREV"; ln -s "$SAVED" "$PREV"
refused "a previous that is a link to a good Talos is refused" 4 "is a link"
rm -f "$PREV"; ditto "$SAVED" "$PREV"; mv "$PREV/Contents" "$T/real-contents"; ln -s "$T/real-contents" "$PREV/Contents"
refused "a previous whose Contents is a link is refused" 4 "is a link"
rm -rf "$PREV" "$T/real-contents"
variant "$PREV" 7009.9 "" com.example.other || bad "could not make the non-Talos bundle"
refused "a signed previous that is another app is refused" 4 "is not Talos"
rm -rf "$PREV"; mkdir -p "$PREV"; echo mine > "$PREV/notes.txt"
refused "a previous that is a plain folder is refused" 4 "is not Talos"
rm -rf "$PREV"; echo mine > "$PREV"
refused "a previous that is a plain file is refused" 4 "is not Talos"
rm -f "$PREV"; ditto "$SAVED" "$PREV"
refused "--rollback with --app is refused" 64 "takes no --app" --rollback --app "$A" --dest "$D" --no-open --no-quit
refused "--rollback into /Applications is refused" 2 "system folder" --rollback --dest /Applications --no-open --no-quit
refused "--rollback through a symlink into /Applications is refused" 2 "system folder" --rollback --dest "$T/applink/sub" --no-open --no-quit
# Another run holds the folder (a live pid in the lock): refused. A lock whose owner is gone is taken over.
mkdir "$D/.Talos.app.lock"; echo $$ > "$D/.Talos.app.lock/pid"
refused "a rollback while another run holds the folder is refused" 7 "is running in"
refused "an install while another run holds the folder is refused" 7 "is running in" --app "$C" --dest "$D" --no-open --no-quit
( exit 0 ) & gone=$!; wait "$gone"; echo "$gone" > "$D/.Talos.app.lock/pid"
run --rollback --dest "$D" --no-open --no-quit >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] && [ "$(state)" = "$VA/$VB" ] && no_temp "$D" && ok "a lock left by a run that is gone is taken over" || bad "stale lock: exit $rc, $(state)"
run --rollback --dest "$D" --no-open --no-quit >/dev/null 2>&1
# The installed Talos.app is not Talos: a rollback must not move it.
D2="$T/roll-other"; mkdir -p "$D2"; variant "$D2/Talos.app" 7009.9 "" com.example.other; ditto "$A" "$D2/.Talos.app.previous"
before="$(snap "$D2")"
run --rollback --dest "$D2" --no-open --no-quit >/dev/null 2>&1; rc=$?
[ "$rc" = 4 ] && [ "$(snap "$D2")" = "$before" ] && ok "a rollback over another app called Talos.app is refused, nothing changed" || bad "rollback replaced another vendor's Talos.app (exit $rc)"
rm -rf "$D2/Talos.app"; ln -s "$B" "$D2/Talos.app"; before="$(snap "$D2")"
run --rollback --dest "$D2" --no-open --no-quit >/dev/null 2>&1; rc=$?
[ "$rc" = 4 ] && [ "$(snap "$D2")" = "$before" ] && ok "a rollback over a Talos.app that is a link is refused, nothing changed" || bad "rollback replaced a linked Talos.app (exit $rc)"
# A folder this user cannot write to: an error of its own (not "another run"), nothing changed.
D3="$T/roll-readonly"; mkdir -p "$D3"; ditto "$B" "$D3/Talos.app"; ditto "$A" "$D3/.Talos.app.previous"; chmod 555 "$D3"; before="$(snap "$D3")"
OUT="$(run --rollback --dest "$D3" --no-open --no-quit 2>&1)"; rc=$?
chmod 755 "$D3"
case "$OUT" in *"cannot write to"*) said=1 ;; *) said=0 ;; esac
[ "$rc" = 1 ] && [ "$said" = 1 ] && [ "$(snap "$D3")" = "$before" ] && ok "a rollback in a read-only folder fails with its own message, nothing changed" || bad "read-only folder: exit $rc: $OUT"

echo "what is kept"
# The kept copy is replaced only by a good one: a current Talos that no longer verifies is dropped, the older good copy stays.
[ "$(state)" = "$VB/$VA" ] || bad "expected B over A before the broken-current case: $(state)"
echo tampered > "$CUR/Contents/Resources/added-later.txt"
OUT="$(run --app "$C" --dest "$D" --no-open --no-quit 2>&1)"; rc=$?
[ "$rc" = 0 ] && [ "$(state)" = "$VC/$VA" ] && verifies "$PREV" && no_temp "$D" && ok "installing over a Talos that no longer verifies keeps the older good previous (A), not the broken one" || bad "broken current: exit $rc, $(state)"
case "$OUT" in *"is not kept as the previous version"*) ok "and it says the broken copy was not kept" ;; *) bad "no note about the dropped copy: $OUT" ;; esac
# A stray link at the kept name is replaced by the install; what it points at is untouched.
rm -rf "$PREV"; ln -s "$SAVED" "$PREV"; saved_before="$(snap "$SAVED")"
run --app "$B" --dest "$D" --no-open --no-quit >/dev/null 2>&1
[ "$(state)" = "$VB/$VC" ] && [ ! -L "$PREV" ] && [ "$(snap "$SAVED")" = "$saved_before" ] && ok "an install replaces a link at the kept name without following it" || bad "link at the kept name: $(state)"
run --app "$A" --dest "$D" --no-open --no-quit >/dev/null 2>&1; run --app "$B" --dest "$D" --no-open --no-quit >/dev/null 2>&1

echo "stopped midway"
# Each case starts from B installed, A kept. `after-move-aside` is the point between the two renames.
midway() {  # midway <label> <fault> <expected exit> <expected state> [install.sh args; default: the rollback]
  local label="$1" f="$2" want="$3" st="$4" rc; shift 4
  [ $# -gt 0 ] || set -- --rollback --dest "$D" --no-open --no-quit
  [ "$(state)" = "$VB/$VA" ] || { bad "$label: did not start from B over A ($(state))"; return; }
  TALOS_INSTALL_TEST_FAULT="$f" run "$@" >/dev/null 2>&1; rc=$?
  if [ "$rc" = "$want" ] && [ -d "$CUR" ] && verifies "$CUR" && verifies "$PREV" && [ "$(state)" = "$st" ] && no_temp "$D"; then ok "$label"
  else bad "$label: exit $rc (want $want), state $(state) (want $st), $(ls -A "$D" | tr '\n' ' ')"; fi
}
reset() { run --app "$A" --dest "$D" --no-open --no-quit >/dev/null 2>&1; run --app "$B" --dest "$D" --no-open --no-quit >/dev/null 2>&1; }
midway "a rollback that fails between the renames leaves B installed and verifying, A kept" after-move-aside 70 "$VB/$VA"
midway "a rollback that gets SIGTERM between the renames puts B back" term:after-move-aside 143 "$VB/$VA"
midway "an install that fails between the renames leaves B installed and verifying, A kept" after-move-aside 70 "$VB/$VA" --app "$C" --dest "$D" --no-open --no-quit
midway "an install that gets SIGTERM between the renames puts B back" term:after-move-aside 143 "$VB/$VA" --app "$C" --dest "$D" --no-open --no-quit
# After the swap the new state stands: a stop there still ends with a verifying Talos.app and the replaced copy kept.
midway "a rollback stopped right after the swap finishes: A installed and verifying, B kept" after-swap 70 "$VA/$VB"
run --rollback --dest "$D" --no-open --no-quit >/dev/null 2>&1
TALOS_INSTALL_TEST_FAULT=kill:after-swap run --rollback --dest "$D" --no-open --no-quit >/dev/null 2>&1; rc=$?
[ "$rc" = 137 ] && [ "$(build_of "$CUR")" = "$VA" ] && verifies "$CUR" && ok "a rollback killed right after the swap: A is installed and verifies" || bad "SIGKILL after the swap: exit $rc, $(ls -A "$D" | tr '\n' ' ')"
run --rollback --dest "$D" --no-open --no-quit >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] && [ "$(state)" = "$VB/$VA" ] && no_temp "$D" && ok "the next rollback first keeps the set-aside copy (B), then swaps: B over A, nothing lost" || bad "rollback after SIGKILL after the swap: exit $rc, $(state)"

# SIGKILL cannot be caught: between the renames Talos.app is missing until install.sh runs again, which puts it back first.
TALOS_INSTALL_TEST_FAULT=kill:after-move-aside run --rollback --dest "$D" --no-open --no-quit >/dev/null 2>&1; rc=$?
[ "$rc" = 137 ] && [ ! -e "$CUR" ] && [ "$(build_of "$D/.Talos.app.old")" = "$VB" ] && [ "$(build_of "$PREV")" = "$VA" ] \
  && ok "SIGKILL between the renames: both bundles are still on disk (B set aside, A kept)" || bad "SIGKILL between renames: exit $rc, $(ls -A "$D" | tr '\n' ' ')"
OUT="$(run --rollback --dest "$D" --no-open --no-quit 2>&1)"; rc=$?
[ "$rc" = 0 ] && [ "$(state)" = "$VA/$VB" ] && verifies "$CUR" && verifies "$PREV" && no_temp "$D" && ok "the next rollback puts B back first, then rolls back: A over B, nothing lost" || bad "rollback after SIGKILL: exit $rc, $(state)"
case "$OUT" in *"interrupted swap was undone"*) ok "and it says it undid the interrupted swap" ;; *) bad "no note about the interrupted swap: $OUT" ;; esac
reset
TALOS_INSTALL_TEST_FAULT=kill:after-move-aside run --app "$C" --dest "$D" --no-open --no-quit >/dev/null 2>&1
run --app "$C" --dest "$D" --no-open --no-quit >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] && [ "$(state)" = "$VC/$VB" ] && verifies "$CUR" && verifies "$PREV" && no_temp "$D" && ok "an install killed between the renames, then run again: C over B" || bad "install after SIGKILL: exit $rc, $(state)"
reset
TALOS_INSTALL_TEST_FAULT=kill:mid-rotate run --app "$C" --dest "$D" --no-open --no-quit >/dev/null 2>&1; rc=$?
[ "$rc" = 137 ] && [ "$(build_of "$CUR")" = "$VC" ] && verifies "$CUR" && [ ! -e "$PREV" ] || bad "SIGKILL while keeping the old copy: exit $rc, $(ls -A "$D" | tr '\n' ' ')"
run --rollback --dest "$D" --no-open --no-quit >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] && [ "$(state)" = "$VB/$VC" ] && no_temp "$D" && ok "an install killed while keeping the old copy: the next rollback still finds B and puts it back" || bad "rollback after SIGKILL mid-keep: exit $rc, $(state)"

# Two rollbacks at once: one wins, one is refused (or both run in turn); never a missing or mixed-up bundle.
reset
run --rollback --dest "$D" --no-open --no-quit >"$T/r1.out" 2>&1 & p1=$!
run --rollback --dest "$D" --no-open --no-quit >"$T/r2.out" 2>&1 & p2=$!
wait "$p1"; r1=$?; wait "$p2"; r2=$?
case "$r1/$r2" in
  0/7|7/0) want="$VA/$VB" ;;
  0/0) want="$VB/$VA" ;;
  *) want="none" ;;
esac
[ "$(state)" = "$want" ] && verifies "$CUR" && verifies "$PREV" && no_temp "$D" && ok "two rollbacks at once (exits $r1 and $r2): both bundles intact, state $(state)" || bad "two rollbacks at once: exits $r1/$r2, state $(state), $(ls -A "$D" | tr '\n' ' ')"

[ ! -e "$FAKEHOME/Applications" ] && ok "the default destination was never used" || bad "something was installed into HOME/Applications"
if [ -n "$TMUX_BIN" ]; then
  "$TMUX_BIN" -L "$SOCK" has-session -t agent 2>/dev/null && ok "the tmux agent survived everything" || bad "the tmux agent died"
fi
exit $fail
