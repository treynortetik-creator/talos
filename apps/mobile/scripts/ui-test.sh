#!/usr/bin/env bash
# ui-test.sh: the iPhone shell's UI tests (docs/ios.md "UI tests"). Drives the real shell on a simulator: the + menu and the photo and
# file pickers (apps/mobile/ios/AppUITests), against a local fixture page, never a real relay.
#
#   bash apps/mobile/scripts/ui-test.sh          # builds, runs, prints "ui-test: N passed, M failed (S s)"
#
# What it does: a dedicated simulator ("Talos UI Test", created on first use) is erased, booted and seeded (two PNGs in Photos, one
# text file in Files > On My iPhone); the shell is built with the relay origin set to http://127.0.0.1:$TALOS_UITEST_PORT, where a
# throwaway Node server (ui-test/fixture-server.ts) serves the composer fixture page; xcodebuild runs the AppUI scheme. No Apple
# identity is used (CODE_SIGNING_ALLOWED=NO). It leaves the gitignored capacitor.config.json as it found it.
# Environment: TALOS_UITEST_PORT (default 18791), TALOS_UITEST_DEVICE_TYPE (default: newest plain "iPhone NN" on the newest iOS runtime),
# TALOS_UITEST_KEEP=1 (leave the simulator booted afterwards).
set -uo pipefail
START=$SECONDS
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE="$(cd "$HERE/.." && pwd)"
IOS="$MOBILE/ios"
PORT="${TALOS_UITEST_PORT:-18791}"
NAME="Talos UI Test"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/talos-ui-test.XXXXXX")"
DD="$IOS/App/DerivedData/ui"   # gitignored (ios/.gitignore: App/DerivedData)
CFG="${TALOS_UITEST_CONFIG:-$IOS/App/App/capacitor.config.json}"   # the override is for the script's own test
# The backup sits beside the file under fixed names, so a run killed before its cleanup (SIGKILL) is recovered by the next one.
# ...but never inside App/App: xcodegen would pick a file there up as a bundled resource
BAKDIR="${TALOS_UITEST_BACKUP_DIR:-$IOS/.ui-test-backup}"; mkdir -p "$BAKDIR"
BAK="$BAKDIR/capacitor.config.json.orig"; NONE="$BAKDIR/capacitor.config.json.none"
SERVER_PID=""
UDID=""
die() { echo "ui-test: $*" >&2; exit 2; }

restore_cfg() {
  if [ -f "$BAK" ]; then mv -f "$BAK" "$CFG"; rm -f "$NONE"
  elif [ -f "$NONE" ]; then rm -f "$CFG" "$NONE"; fi
}
if [ -f "$BAK" ] || [ -f "$NONE" ]; then echo "ui-test: a previous run was killed before it restored capacitor.config.json; restoring it"; restore_cfg; fi
# No backup but the fixture origin is already in the file: it cannot be told apart from a real config, so say so rather than keep it.
if [ -f "$CFG" ] && grep -q '"url": *"http://127.0.0.1:[0-9]*"' "$CFG"; then
  die "$CFG points at a local 127.0.0.1 relay (a killed UI-test run, or your own dev build). Run 'TALOS_RELAY_URL=<your relay> pnpm --filter @talos-app/mobile cap:sync' to make it right, then run this again."
fi
[ -z "${TALOS_UITEST_RECOVER_ONLY:-}" ] || exit 0   # for the script's own test
# The Apple tools and the port only after that: recovering the config needs neither, and the script's own test runs that part on
# Linux CI, where xcodegen does not exist (main's check went red at bd49bc03 when these came first)
for tool in xcodegen xcodebuild xcrun node pnpm python3; do command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"; done
curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/" && die "port $PORT is already in use (set TALOS_UITEST_PORT)"
if [ -f "$CFG" ]; then cp "$CFG" "$BAK"; else : > "$NONE"; fi
cleanup() {
  [ -z "$SERVER_PID" ] || kill "$SERVER_PID" 2>/dev/null
  restore_cfg
  if [ -n "$UDID" ] && [ "${TALOS_UITEST_KEEP:-0}" != 1 ]; then xcrun simctl shutdown "$UDID" >/dev/null 2>&1; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- the simulator: a dedicated one, so seeding never touches anyone's own photos
UDID="$(xcrun simctl list devices -j | python3 -c '
import json, sys
name = sys.argv[1]
for devices in json.load(sys.stdin)["devices"].values():
    for d in devices:
        if d["name"] == name and d.get("isAvailable"):
            print(d["udid"]); sys.exit(0)' "$NAME")"
if [ -z "$UDID" ]; then
  # The newest iOS runtime, and on it the newest plain "iPhone NN" it supports (a device type the runtime does not support is refused).
  pick="$(xcrun simctl list runtimes -j | python3 -c '
import json, re, sys
r = [x for x in json.load(sys.stdin)["runtimes"] if x.get("isAvailable") and x["identifier"].split(".")[-1].startswith("iOS")]
r.sort(key=lambda x: [int(p) for p in x["version"].split(".")], reverse=True)
for rt in r:
    t = [d for d in rt.get("supportedDeviceTypes", []) if re.fullmatch(r"iPhone \d+", d["name"])]
    t.sort(key=lambda d: int(d["name"].split()[1]))
    if t:
        print(rt["identifier"], t[-1]["identifier"]); break
')"
  [ -n "$pick" ] || die "no iOS simulator runtime with a plain iPhone device type is installed"
  runtime="${pick%% *}"; dtype="${TALOS_UITEST_DEVICE_TYPE:-${pick##* }}"
  UDID="$(xcrun simctl create "$NAME" "$dtype" "$runtime")" || die "could not create the simulator"
  echo "ui-test: created simulator $NAME ($UDID)"
fi
xcrun simctl shutdown "$UDID" >/dev/null 2>&1
xcrun simctl erase "$UDID" || die "could not erase the simulator"
xcrun simctl boot "$UDID" || die "could not boot the simulator"
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || die "the simulator did not finish booting"

# --- seed: two PNGs of different size and colour (newest in the picker), one file in On My iPhone
python3 - "$WORK" <<'PY'
import struct, sys, zlib
def png(path, w, h, rgb):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
png(sys.argv[1] + "/talos-ui-red.png", 200, 200, (220, 40, 40))
png(sys.argv[1] + "/talos-ui-blue.png", 300, 200, (40, 60, 220))
PY
xcrun simctl addmedia "$UDID" "$WORK/talos-ui-red.png" "$WORK/talos-ui-blue.png" || die "could not add the test photos"
DATA="$HOME/Library/Developer/CoreSimulator/Devices/$UDID/data/Containers/Shared/AppGroup"
LOCAL=""
for g in "$DATA"/*/; do
  if strings "$g.com.apple.mobile_container_manager.metadata.plist" 2>/dev/null | grep -q 'group.com.apple.FileProvider.LocalStorage'; then LOCAL="$g"; break; fi
done
[ -n "$LOCAL" ] || die "the simulator has no On My iPhone storage (group.com.apple.FileProvider.LocalStorage)"
mkdir -p "$LOCAL/File Provider Storage"
printf 'talos ui test file\n' > "$LOCAL/File Provider Storage/talos-ui-note.txt"   # 19 bytes: the test checks the size

# --- the origin the shell loads: built in, so cap sync and the build both see this port
( cd "$MOBILE" && TALOS_RELAY_URL="http://127.0.0.1:$PORT" TALOS_DEV_CLEARTEXT=1 pnpm cap:sync >"$WORK/sync.log" 2>&1 ) || { cat "$WORK/sync.log"; die "cap sync failed"; }
( cd "$MOBILE" && pnpm xcodegen >"$WORK/xcodegen.log" 2>&1 ) || { cat "$WORK/xcodegen.log"; die "xcodegen failed"; }
node "$MOBILE/ui-test/fixture-server.ts" "$PORT" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" && break; sleep 0.1; done
curl -s --max-time 2 "http://127.0.0.1:$PORT/" | grep -q 'Composer fixture' || { cat "$WORK/server.log"; die "the fixture server did not start"; }

# --- run
LOG="$WORK/xcodebuild.log"
xcodebuild -project "$IOS/App/App.xcodeproj" -scheme AppUI -destination "id=$UDID" -derivedDataPath "$DD" \
  CODE_SIGNING_ALLOWED=NO test >"$LOG" 2>&1
rc=$?
grep -E "^Test Case .* (passed|failed)|error:" "$LOG" | sed -E "s/^Test Case '-\[AppUITests\.//; s/\]' / /" | cut -c1-240
passed=$(grep -cE "^Test Case .* passed" "$LOG")
failed=$(grep -cE "^Test Case .* failed" "$LOG")
if [ "$rc" != 0 ] && [ "$failed" = 0 ]; then echo "ui-test: xcodebuild failed before any test ran (exit $rc); last lines:"; tail -25 "$LOG"; fi
echo "ui-test: $passed passed, $failed failed ($((SECONDS - START)) s)"
[ "$rc" = 0 ] && [ "$failed" = 0 ] && [ "$passed" -gt 0 ]
