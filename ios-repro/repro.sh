#!/bin/bash
# The iPhone "black screen after a while in the background" repro, on a simulator.
#
#   ios-repro/repro.sh setup                 create a simulator, start the stub relay, build and install the app against it
#   ios-repro/repro.sh run <scenario> <tag>  run one scenario; screenshots land in ios-repro/shots/<tag>-<scenario>-<t>s.png
#   ios-repro/repro.sh teardown              stop the stub relay and delete the simulator
#
# Scenarios (each: open the app, send it to the background, break something, bring it back, take screenshots over time):
#   killed      the web content process is killed in the background
#   slow-relay  the web content process is killed in the background while the relay does not answer   <- the dead screen
#   suspended-kill  the same kill, while the app itself is stopped the way iOS suspends it
#   frozen      the web content process is frozen (SIGSTOP) in the background                          <- seconds of black
#   gpu-frozen  WebKit's GPU process is frozen in the background
#   memory      a memory-pressure notice is sent while in the background
#   idle        ten minutes in the background, nothing broken (TALOS_REPRO_IDLE seconds, default 620)
#
# To compare before and after: build `origin/main` and the branch in turn (setup builds whatever is checked out), and run
# the same scenario with tags `before` and `after`. Everything is found by parent pid; nothing outside the simulator is touched.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PORT="${TALOS_REPRO_PORT:-48771}"
STATE="$HERE/.state"; mkdir -p "$STATE" "$HERE/shots"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

stub_start() {
  if [ -f "$STATE/stub.pid" ] && kill -0 "$(cat "$STATE/stub.pid")" 2>/dev/null; then return; fi
  nohup python3 "$HERE/stub-relay.py" "$PORT" >"$STATE/stub.log" 2>&1 &
  echo $! >"$STATE/stub.pid"; sleep 1
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" || { echo "stub relay did not start (see $STATE/stub.log)"; exit 1; }
}
stub_pid() { cat "$STATE/stub.pid"; }

setup() {
  if [ -z "${SIM:-}" ]; then
    local rt; rt="$(xcrun simctl list runtimes | grep -o 'com.apple.CoreSimulator.SimRuntime.iOS-[0-9-]*' | tail -1)"
    SIM="$(xcrun simctl create talos-black-resume "${TALOS_REPRO_DEVICE:-iPhone 17}" "$rt")"; echo "$SIM" >"$HERE/.sim-udid"
  fi
  xcrun simctl boot "$SIM" 2>/dev/null || true
  xcrun simctl bootstatus "$SIM" -b >/dev/null
  xcrun simctl ui "$SIM" appearance dark   # a blank web view is black in dark mode, white in light
  stub_start
  (cd "$ROOT/apps/mobile" && TALOS_RELAY_URL="http://localhost:$PORT" pnpm cap:sync >/dev/null && pnpm xcodegen >/dev/null)
  (cd "$ROOT/apps/mobile/ios/App" && xcodebuild -project App.xcodeproj -scheme App -destination "id=$SIM" \
     -derivedDataPath "$ROOT/.dd" CODE_SIGNING_ALLOWED=NO build >"$STATE/build.log" 2>&1) || { tail -20 "$STATE/build.log"; exit 1; }
  xcrun simctl terminate "$SIM" "$APP_ID" 2>/dev/null || true
  xcrun simctl install "$SIM" "$ROOT/.dd/Build/Products/Debug-iphonesimulator/App.app"
  echo "ready: simulator $SIM, stub relay on $PORT"
}

run() {
  local scenario="$1" tag="$2" times="1 4 9 15" out="$HERE/shots/$2-$1"
  stub_start
  kill -CONT "$(stub_pid)" 2>/dev/null || true
  xcrun simctl terminate "$SIM" "$APP_ID" 2>/dev/null || true
  foreground; sleep 6
  shot "$out-0-loaded.png"
  background 4
  case "$scenario" in
    killed)     kill -9 "$(webkit_pid WebContent)" ;;
    slow-relay) kill -STOP "$(stub_pid)"; kill -9 "$(webkit_pid WebContent)"; times="1 4 9 15 30" ;;
    suspended-kill) # the app itself is stopped (as iOS suspends it) when the web content process dies, then woken
                APP="$(app_pid)"; kill -STOP "$APP"; sleep 1; kill -9 "$(webkit_pid WebContent)"; sleep 2; kill -CONT "$APP" ;;
    frozen)     FROZEN="$(webkit_pid WebContent)"; kill -STOP "$FROZEN" ;;
    gpu-frozen) FROZEN="$(webkit_pid GPU)"; kill -STOP "$FROZEN" ;;
    memory)     xcrun simctl spawn "$SIM" notifyutil -p com.apple.system.memorystatus
                xcrun simctl spawn "$SIM" notifyutil -p UISimulatedMemoryWarningNotification ;;
    idle)       sleep "${TALOS_REPRO_IDLE:-620}" ;;
    *) echo "unknown scenario $scenario"; exit 2 ;;
  esac
  sleep 2
  foreground
  local t0 t; t0=$(date +%s)
  for t in $times; do
    while [ $(( $(date +%s) - t0 )) -lt "$t" ]; do sleep 0.2; done
    shot "$out-${t}s.png"
  done
  if [ "$scenario" = slow-relay ]; then
    # The offline page's own "Try again" is the way back once the relay answers; the relay is let go here so the next run starts clean.
    kill -CONT "$(stub_pid)"
  fi
  # A frozen process the app let go of is still stopped: end it.
  if [ -n "${FROZEN:-}" ]; then kill -9 "$FROZEN" 2>/dev/null || true; fi
  if command -v magick >/dev/null; then
    # shellcheck disable=SC2046
    magick $(for t in $times; do echo "$out-${t}s.png"; done) -resize 25% +append "$out-strip.png" && echo "strip $out-strip.png"
  fi
}

teardown() {
  [ -f "$STATE/stub.pid" ] && { kill -CONT "$(stub_pid)" 2>/dev/null; kill "$(stub_pid)" 2>/dev/null; rm -f "$STATE/stub.pid"; } || true
  [ -n "${SIM:-}" ] && { xcrun simctl shutdown "$SIM" 2>/dev/null || true; xcrun simctl delete "$SIM" 2>/dev/null || true; rm -f "$HERE/.sim-udid"; }
  echo "torn down"
}

case "${1:-}" in
  setup) setup ;;
  run) run "${2:?scenario}" "${3:?tag}" ;;
  teardown) teardown ;;
  *) sed -n '2,19p' "$0"; exit 2 ;;
esac
