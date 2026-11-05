#!/usr/bin/env bash
# Everything the desktop job runs, in order: unit tests, packed release app (signed, verified, selftest), guard tests.
# Used by scripts/ci-local.sh (job_desktop) and runnable by hand.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-.build/ci-app}"
if [ "${TALOS_GUI_TESTS:-0}" = 1 ]; then
  # A logged-in session that allows windows: the window-opening suites run one process each (gui-tests.sh fails a process that ends
  # early), and the main run keeps the gate off so nothing runs twice.
  TALOS_GUI_TESTS=0 bash scripts/test.sh
  bash scripts/gui-tests.sh
else
  bash scripts/test.sh
fi
# The tests that starve the dispatch pool run alone, so they cannot fail the suites beside them.
bash scripts/starvation-tests.sh
bash scripts/gui-tests-test.sh
bash scripts/build-app.sh --release --out "$OUT"
# The art inside the packed app must load too, not only the copy in the source tree.
TALOS_BUILT_APP="$OUT/Talos.app" bash scripts/test.sh --filter BuiltAppArt
bash scripts/guards-test.sh
bash scripts/install-test.sh "$OUT/Talos.app"
bash scripts/review-d6-install-test.sh
[ ! -f scripts/review-d0-test.sh ] || bash scripts/review-d0-test.sh
[ ! -f scripts/review-d0-recheck-test.sh ] || bash scripts/review-d0-recheck-test.sh
