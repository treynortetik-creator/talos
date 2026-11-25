#!/usr/bin/env bash
# Everything the desktop job runs, in order: unit tests, packed release app (signed, verified, selftest), guard tests.
# Used by scripts/ci-local.sh (job_desktop) and runnable by hand.
set -euo pipefail
# The desktop mutex first (scripts/heavy-lock.sh desktop, the one CI's desktop job holds): one Swift desktop suite on the machine at a
# time, whoever runs it (two at once exhaust the ptys and tmux fails to fork). It comes before the heavy lock, so a waiter for the mutex
# holds no slot, and a hand run and a CI job (which holds only the mutex) never wait for each other on a machine with one slot. Inside a CI job its desktop job holds it. Then this same script again, with every argument exactly as given.
HEAVY_LOCK="$(dirname "$0")/../../../scripts/heavy-lock.sh"
if [ -f "$HEAVY_LOCK" ] && [ "${TALOS_CI_SLOT_RUN:-}" != 1 ] && ! bash "$HEAVY_LOCK" held desktop; then
  exec bash "$HEAVY_LOCK" desktop "desktop ci.sh" -- bash "$0" "$@"
fi
# Then the machine's heavy lock (scripts/heavy-lock.sh), inside the mutex: unless it already runs inside the lock's holder or inside a CI
# job (every ci-local exports TALOS_CI_SLOT_RUN=1, and its desktop job holds a slot; an older ci-local says so only that way).
if [ -f "$HEAVY_LOCK" ] && [ "${TALOS_CI_SLOT_RUN:-}" != 1 ] && ! bash "$HEAVY_LOCK" held; then
  exec bash "$HEAVY_LOCK" run "desktop ci.sh" -- bash "$0" "$@"
fi
cd "$(dirname "$0")/.."
OUT="${1:-.build/ci-app}"
STAMP="$(bash scripts/tests-green-stamp.sh || true)"  # the tree the suite runs on, taken before it runs
# This job stops at its first red step, but never quietly: every step after it is a line `NOT RUN: <step> (<red one> failed)` in the
# log (scripts/ci-runner/alert.sh lists them), so a report never reads as if what did not run had passed. Running them anyway is
# not safe: guards-test.sh's control reuses the green-tests stamp, and with no green run it would run the whole suite again, and
# the install and release steps want the app that build-app.sh made. The names are the ones scripts/ci-local/jobs-swift.sh lists
# (DESKTOP_STEPS), for a run that never started this script.
FIRST_RED=""
step() { # step <name> <command...>
  local name="$1"
  shift
  if [ -n "$FIRST_RED" ]; then
    echo "NOT RUN: $name ($FIRST_RED failed)"
    # the file beside the job log that a report reads (ci-local's not_run: scripts/ci-local/jobs-check.sh); only ci-local gives it
    [ -z "${CI_NOTRUN_FILE:-}" ] || echo "NOT RUN: $name ($FIRST_RED failed)" >> "$CI_NOTRUN_FILE"
    return 0
  fi
  "$@" || FIRST_RED="$name"
}
release_dryrun() {
  if bash scripts/release-dryrun-wanted.sh; then bash scripts/release-dryrun.sh
  else echo "release-dryrun: not run (no release script, entitlements or version changed)"; fi
}
# The main run is watched for pty masters its test process keeps (pty-watch.sh).
if [ "${TALOS_GUI_TESTS:-0}" = 1 ]; then
  # A logged-in session that allows windows: the window-opening suites run one process each (gui-tests.sh fails a process that ends
  # early), and the main run keeps the gate off so nothing runs twice.
  step test.sh env TALOS_GUI_TESTS=0 bash scripts/pty-watch.sh bash ../../scripts/ci-swift-retry.sh bash scripts/test.sh
  step gui-tests.sh bash scripts/gui-tests.sh
else
  # ci-swift-retry.sh runs test.sh once: no retries.
  step test.sh bash scripts/pty-watch.sh bash ../../scripts/ci-swift-retry.sh bash scripts/test.sh
fi
step pty-watch-test.sh bash scripts/pty-watch-test.sh
# green on this tree: guards-test.sh's control reuses it instead of running the whole suite again
export TALOS_DESKTOP_TESTS_GREEN="$STAMP"
# The tests that starve the dispatch pool run alone, so they cannot fail the suites beside them.
step starvation-tests.sh bash scripts/starvation-tests.sh
step gui-tests-test.sh bash scripts/gui-tests-test.sh
step build-app.sh bash scripts/build-app.sh --release --out "$OUT"
# The art inside the packed app must load too, not only the copy in the source tree.
step "test.sh(BuiltAppArt)" env TALOS_BUILT_APP="$OUT/Talos.app" bash scripts/test.sh --filter BuiltAppArt
# guards-test.sh runs six scripts of its own (auto-update-apply-test.sh and the others in its name here): a NOT RUN line names them
step "guards-test.sh(auto-update-apply-test.sh,release-publish-test.sh,path-leak-test.sh,nested-code-test.sh,bundle-modes-check-test.sh,rpath-scrub-test.sh)" bash scripts/guards-test.sh
step install-test.sh bash scripts/install-test.sh "$OUT/Talos.app"
# The prebuilt-app security cases need a signature through Apple's certificates. They run ONLY with an identity named explicitly in
# TALOS_TEST_APPLE_SIGN_ID (the owner's own Talos identity); nothing here picks one from the keychain, because the first match on a
# Mac can belong to someone else (an employer's certificate must never sign anything for Talos). Unset: the test prints a loud
# SKIPPED line with the count, and CI never touches an identity (scripts/ci-local/jobs-swift.sh signs everything ad hoc).
step release-install-test.sh bash scripts/release-install-test.sh "$OUT/Talos.app"
step review-d6-install-test.sh bash scripts/review-d6-install-test.sh
step bundle-tools-test.sh bash scripts/bundle-tools-test.sh
# The release's own steps with no Developer ID: a universal build with the bundled tools, ad hoc, the nested-code listing, the
# path-leak check. Only when a release script, the entitlements or the version changed (release-dryrun-wanted.sh); TALOS_RELEASE_DRYRUN=1 forces it.
step release-dryrun-wanted-test.sh bash scripts/release-dryrun-wanted-test.sh
step release-dryrun.sh release_dryrun
step install-record-clone-test.sh bash scripts/install-record-clone-test.sh
step relay-wait-test.sh bash scripts/relay-wait-test.sh
[ ! -f scripts/review-d0-test.sh ] || step review-d0-test.sh bash scripts/review-d0-test.sh
[ ! -f scripts/review-d0-recheck-test.sh ] || step review-d0-recheck-test.sh bash scripts/review-d0-recheck-test.sh
[ -z "$FIRST_RED" ]
