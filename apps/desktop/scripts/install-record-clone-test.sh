#!/usr/bin/env bash
# install.sh records the clone it runs from only when none is recorded (or the recorded one is gone), or when --use-this-clone says so.
# Runs install.sh's own record-clone block (between its "# record-clone" markers) with a temp HOME, so nothing real is read or written.
# Usage: install-record-clone-test.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1" >&2; fail=1; }
T="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$T"' EXIT
BLOCK="$T/block.sh"
sed -n '/^# record-clone: begin/,/^# record-clone: end/p' "$HERE/scripts/install.sh" > "$BLOCK"
[ "$(wc -l < "$BLOCK")" -gt 10 ] && ok "the block was found in install.sh" || { bad "the record-clone block is missing from install.sh"; exit 1; }

# A whole clone, as the block checks one (HERE/../.. is the clone, so the script lives at <clone>/apps/desktop/scripts).
mkclone() { mkdir -p "$1/apps/bridge/src" "$1/plugins/talos-app-mod" "$1/apps/desktop"; : > "$1/install.sh"; : > "$1/apps/bridge/src/cli.ts"; }
A="$T/clone-a"; B="$T/clone-b"; mkclone "$A"; mkclone "$B"

# one run of the block as install.sh would reach it: HOME is the temp one, the running script is in clone $1, $2 is --use-this-clone's value
run() {
  local clone="$1" use="$2"
  HOME="$T/home" TALOS_APP_HOME="$T/talos-home" HERE="$clone/apps/desktop" MODE=install TARGET=/nonexistent USE_THIS_CLONE="$use" TALOS_TEST_CLONE_UNSAFE="${UNSAFE-}" bash -c '
    plist_val() { :; }
    . "'"$BLOCK"'"' 2>&1
}
REC="$T/home/Library/Application Support/app.talos.desktop/checkout"
OLDREC="$T/home/Library/Application Support/Talos/checkout"

out="$(run "$A" 0)"
[ "$(cat "$REC")" = "$A" ] && [ "$(cat "$OLDREC")" = "$A" ] && ok "nothing recorded yet: this clone is recorded" || bad "first record: $out"

out="$(run "$B" 0)"
[ "$(cat "$REC")" = "$A" ] && ok "another checkout does not repoint the recorded clone" || bad "the record moved to $(cat "$REC")"
echo "$out" | grep -q "kept the clone Talos already uses ($A)" && echo "$out" | grep -q -- "--use-this-clone" \
  && ok "and says which clone is kept, which one ran, and how to switch" || bad "silent keep: $out"
[ "$(cat "$OLDREC")" = "$A" ] && ok "the old folder's record is untouched too" || bad "old record: $(cat "$OLDREC")"

out="$(run "$B" 1)"
[ "$(cat "$REC")" = "$B" ] && echo "$out" | grep -q "it used $A before" && ok "--use-this-clone switches, and says what it used before" || bad "switch: $out"

rm -rf "$B/plugins"
out="$(run "$A" 0)"
[ "$(cat "$REC")" = "$A" ] && ok "a recorded clone that is no longer whole is replaced" || bad "stale record kept: $(cat "$REC") $out"

out="$(run "$A" 0)"
[ "$(cat "$REC")" = "$A" ] && echo "$out" | grep -q "will use this clone" && ok "the same clone again: recorded as before" || bad "same clone: $out"

# A planted record: any program running as the owner can write the record file, so what it names is kept only when it passes the app's rules.
plant() { printf '%s\n' "$1" > "$REC"; chmod 600 "$REC"; }
expect_replaced() {  # $1 what was planted (a path), $2 the case
  local out; out="$(run "$A" 0)"
  [ "$(cat "$REC")" = "$A" ] && ok "$2: not kept, the record is written as before" || bad "$2: kept $(cat "$REC") $out"
}
plant "$B"; mkclone "$B"; chmod 700 "$B"
ln -s "$B" "$T/link-to-b"; plant "$T/link-to-b"; expect_replaced x "a recorded path that goes through a link"
plant "$B"; chmod 777 "$B"; expect_replaced x "a recorded clone any user can write to"; chmod 700 "$B"
plant "$B"; chmod 664 "$REC"; expect_replaced x "a record file other users can write"
plant "$B"; chmod 666 "$B/install.sh"; expect_replaced x "a recorded install.sh other users can write"; chmod 644 "$B/install.sh"
mkclone "$T/home/Library/Application Support/app.talos.desktop/inside"; plant "$T/home/Library/Application Support/app.talos.desktop/inside"
expect_replaced x "a recorded clone inside the app's own support folder"
plant "relative/path"; expect_replaced x "a recorded path that is not absolute"
plant "$B"; out="$(run "$A" 0)"; [ "$(cat "$REC")" = "$B" ] && ok "control: the same record, all rules met, is kept" || bad "control: $out"
UNSAFE="/var/folders /private/var/folders /tmp /private/tmp"
plant "$B"; out="$(run "$A" 0)"; [ "$(cat "$REC")" = "$A" ] && ok "a recorded clone in a temp folder is not kept (the default roots)" || bad "temp root kept: $out"
unset UNSAFE

# the folders agent sessions work in (desktop.json agent_dir, each thread's config.json cwd, the Talos home): never a kept clone
mkdir -p "$T/home/Library/Application Support/Talos" "$T/talos-home"
AGENT="$T/agent"; THREAD="$T/threadcwd"; mkclone "$AGENT"; mkclone "$THREAD"; chmod 700 "$AGENT" "$THREAD"
printf '{"agent_dir":"%s","env":{}}' "$AGENT" > "$T/home/Library/Application Support/Talos/desktop.json"
printf '{"threads":{"t1":{"kind":"x","cwd":"%s"},"t2":{"cwd": "/nowhere/else"}}}' "$THREAD" > "$T/talos-home/config.json"
plant "$AGENT"; expect_replaced x "a recorded clone that is the agent folder (desktop.json agent_dir)"
plant "$THREAD"; expect_replaced x "a recorded clone that is a thread's own folder (config.json cwd)"
mkdir -p "$AGENT/sub"; mkclone "$AGENT/sub"; chmod 700 "$AGENT/sub"; plant "$AGENT/sub"; expect_replaced x "a recorded clone inside the agent folder"
mkclone "$T/talos-home/clone"; chmod 700 "$T/talos-home/clone"; plant "$T/talos-home/clone"; expect_replaced x "a recorded clone inside the Talos home"
plant "$B"; out="$(run "$A" 0)"; [ "$(cat "$REC")" = "$B" ] && ok "control: another folder is still kept with those roots set" || bad "control 2: $out"

exit $fail
