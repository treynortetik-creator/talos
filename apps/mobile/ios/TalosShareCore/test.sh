#!/usr/bin/env bash
# Runs TalosShareCore's swift-testing suites. Same flags as apps/desktop/scripts/test.sh: without Xcode, the Command Line
# Tools ship Testing.framework outside the default search path, so add it.
#   test.sh            fixture tests; the live tests skip and say why
#   test.sh --live     also start a local relay from apps/relay's own test harness (never a deployed one) and run
#                      the live tests against it over http://127.0.0.1
# Other args go to `swift test`. Env: TALOS_SWIFTPM_CACHE, TALOS_SWIFT_SCRATCH.
set -euo pipefail
cd "$(dirname "$0")"
command -v swift >/dev/null || { echo "test.sh: swift is not installed" >&2; exit 127; }

LIVE=0
PASS=()
for a in "$@"; do if [ "$a" = "--live" ]; then LIVE=1; else PASS+=("$a"); fi; done

ARGS=()
[ -n "${TALOS_SWIFTPM_CACHE:-}" ] && ARGS+=(--cache-path "$TALOS_SWIFTPM_CACHE")
[ -n "${TALOS_SWIFT_SCRATCH:-}" ] && ARGS+=(--scratch-path "$TALOS_SWIFT_SCRATCH")

F=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
if ! xcodebuild -version >/dev/null 2>&1 && [ -d "$F" ]; then
  ARGS+=(-Xswiftc -F -Xswiftc "$F" -Xlinker -F -Xlinker "$F" -Xlinker -rpath -Xlinker "$F")
fi

if [ "$LIVE" = 1 ]; then
  ROOT="$(cd ../../../.. && pwd)"
  [ -d "$ROOT/node_modules" ] || { echo "test.sh --live: run pnpm install first" >&2; exit 1; }
  OUT="$(mktemp)"; ERR="$(mktemp)"
  node --experimental-transform-types scripts/live-relay.ts >"$OUT" 2>"$ERR" &
  RELAY_PID=$!
  trap 'kill "$RELAY_PID" 2>/dev/null || true; rm -f "$OUT" "$ERR"' EXIT
  for _ in $(seq 1 60); do [ -s "$OUT" ] && break; kill -0 "$RELAY_PID" 2>/dev/null || break; sleep 0.5; done
  [ -s "$OUT" ] || { echo "test.sh --live: the local relay did not start" >&2; grep -v ExperimentalWarning "$ERR" >&2 || true; exit 1; }
  export TALOS_LIVE_CONFIG="$OUT"
  echo "test.sh: live tests against a local relay at $(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['relay'])" "$OUT")"
fi

swift test ${ARGS[@]+"${ARGS[@]}"} ${PASS[@]+"${PASS[@]}"}
