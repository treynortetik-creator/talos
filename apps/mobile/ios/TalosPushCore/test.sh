#!/usr/bin/env bash
# Runs TalosPushCore's XCTest suite (no UIKit; runs on any Mac with Swift).
set -euo pipefail
cd "$(dirname "$0")"
command -v swift >/dev/null || { echo "test.sh: swift is not installed" >&2; exit 127; }
exec swift test "$@"
