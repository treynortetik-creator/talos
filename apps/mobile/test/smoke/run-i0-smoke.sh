#!/usr/bin/env bash
# I0 reviewer simulator smoke (PR #51). Builds the shell against a fake relay at http://localhost:8787, runs the probe
# page in i0_smoke_server.py and prints which probes got native code to set their cookie.
#   usage: run-i0-smoke.sh <simulator-udid> [prod]   ("prod" = allowNavigation without the port, as a real https relay)
#   then:  run again with MIC=1 to probe the media-capture grant + backgrounding.
# A probe "got through" iff its cookie name is in the final_cookie line. Expected-and-OK: t1_main_positive_control,
# t8b_after_pushback, t2b_sameorigin_iframe_parent_handle (same-origin script reaching the top window's handler).
# Anything named t*p_*prompt* proves Capacitor's prompt() cookie channel bypasses the bridge wrapper.
set -euo pipefail
UDID="${1:?simulator udid}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MOBILE="$HERE/../.."
OUT="${OUT:-$(mktemp -d)}"
cd "$MOBILE"
TALOS_RELAY_URL=http://localhost:8787 pnpm cap:sync >/dev/null
if [ "${2:-}" = prod ]; then sed -i '' 's/"localhost:8787"/"localhost"/' ios/App/App/capacitor.config.json; fi
(cd ios/App && xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
  -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath "$OUT/DD" CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO \
  build >"$OUT/build.log" 2>&1)
MODE=""; [ "${MIC:-}" = 1 ] && MODE=mic
python3 -I "$HERE/i0_smoke_server.py" "$OUT/log.jsonl" 8787 $MODE & S1=$!
python3 -I "$HERE/i0_smoke_server.py" "$OUT/log.jsonl" 8788 $MODE & S2=$!
trap 'kill $S1 $S2' EXIT
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null
xcrun simctl terminate "$UDID" app.talos.shell 2>/dev/null || true
xcrun simctl uninstall "$UDID" app.talos.shell 2>/dev/null || true
xcrun simctl install "$UDID" "$OUT/DD/Build/Products/Debug-iphonesimulator/App.app"
xcrun simctl privacy "$UDID" grant microphone app.talos.shell
xcrun simctl launch "$UDID" app.talos.shell
sleep 25
if [ -n "$MODE" ]; then
  xcrun simctl launch "$UDID" com.apple.Preferences >/dev/null; sleep 8; xcrun simctl launch "$UDID" app.talos.shell >/dev/null; sleep 4
fi
python3 - "$OUT/log.jsonl" <<'EOF'
import json, sys
for l in open(sys.argv[1]):
    r = json.loads(l); rep = r.get("report", {})
    if rep: print(rep.get("t"), json.dumps(rep)[:240])
    else: print("REQ", r["host"], r["path"][:50], "cookie=" + r["cookie"], r["ua"][-30:])
EOF
echo "log: $OUT/log.jsonl"
