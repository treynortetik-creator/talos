# scripts/ci-local/jobs-swift.sh: the desktop and mobile (Swift) jobs. Part of scripts/ci-local.sh, which sources it before any wait (functions and
# fixed values only, unchanged from when they were in ci-local.sh). Not run on its own.
# The Mac app (apps/desktop, SwiftPM + Command Line Tools, no Xcode). On a machine without Swift it skips with a clear
# message and counts as passed: a Linux box or a fresh checkout without the toolchain must not block the JS jobs.
SKIPPED=() SKIP_WHY="swift is not installed"
job_desktop() {
  local log="$1"
  if ! command -v swift >/dev/null 2>&1; then
    echo "SKIPPED: swift is not installed on this machine, so the desktop app was not built or tested" | tee -a "$log"
    SKIPPED+=(desktop)
    return 0
  fi
  # Path gating (fails closed): only the gate's explicit exit 1 skips. Exit 0, an error (2), a failed merge-base or a
  # missing gate script all run the job. TALOS_CI_FORCE_DESKTOP=1|true|yes|on forces a run (kept for
  # apps/desktop/scripts/review-d0-test.sh and the ci-local tests, which use it as their control; ci-local.sh does not export it).
  local base rc=2 force="${TALOS_CI_FORCE_DESKTOP:-0}"
  base="$(git merge-base origin/main "$SHA" 2>/dev/null)" || base=""
  # A commit already on origin/main is its own merge-base: the diff is empty, so "no changes" would be a lie about code nobody
  # tested. The gate cannot decide there, so the job runs (a push to main, a dispatch of a main commit, a hand run).
  [ "$base" != "$SHA" ] || { base=""; echo "desktop gate: $SHORT is already on origin/main, nothing to diff against; running the job" >> "$log"; }
  # The gate runs from OUR copy ($ROOT, the checkout running ci-local), never from the PR's tree: a PR forked before the
  # gate existed has none, and a PR must not be able to edit its own gate. It diffs in the cwd, which is the worktree.
  if [ -n "$base" ]; then bash "$ROOT/scripts/ci-desktop-gate.sh" "$base" "$SHA"; rc=$?; fi
  case "$(printf '%s' "$force" | tr '[:upper:]' '[:lower:]')" in 1|true|yes|on) rc=0 ;; esac
  if [ "$rc" = 1 ]; then
    echo "skipped (no desktop changes)" | tee -a "$log"
    SKIPPED+=(desktop); SKIP_WHY="no desktop changes"
    return 0
  fi
  if [ ! -f apps/desktop/scripts/ci.sh ]; then   # a commit forked before the desktop app existed
    echo "skipped (commit has no desktop app)" | tee -a "$log"
    SKIPPED+=(desktop); SKIP_WHY="commit has no desktop app"
    return 0
  fi
  [ "$rc" = 0 ] || echo "desktop gate could not decide (exit $rc); running the desktop job" >> "$log"
  if ! ci_tmux_ok; then
    echo "FAILED: no usable tmux (3.2 or newer) at /opt/homebrew/bin, /usr/local/bin or /usr/bin on this machine. The desktop tests would skip every tmux suite (about 130 tests: tmux hosting, the worker manager, the OC3 reviews) and still end green. Install tmux (brew install tmux) and re-run." | tee -a "$log"
    return 1
  fi
  mkdir -p "$CACHE/swiftpm"
  # Window-opening integration tests run only when the architect sets TALOS_GUI_TESTS=1 in a logged-in session; it is
  # passed through, never set here (Chronos and headless runs must not open windows).
  # TALOS_SIGN_ID=- : CI apps are always ad-hoc signed, so CI never touches the login keychain or the owner's identity key.
  # The shared SwiftPM scratch (incremental builds), the GUI session and the review tests' keychains are one per Mac,
  # so the desktop job holds a mutex: one desktop build at a time, whatever the slots.
  # Its pty use, while ci.sh runs under the mutex: the peak of /dev/ttys* and the limit, in its log and in timings.tsv (pty=peak/max).
  local rc peak
  TALOS_SIGN_ID=- TALOS_GUI_TESTS="${TALOS_GUI_TESTS:-0}" TALOS_SWIFTPM_CACHE="$CACHE/swiftpm" TALOS_SWIFT_SCRATCH="$CACHE/desktop-build" \
    run "$log" ci_mutex "$LOCKS" desktop ci_pty_during "$RESULTS/desktop.ptypeak" bash apps/desktop/scripts/ci.sh "$WT/.desktop-out"
  rc=$?
  peak="$(cat "$RESULTS/desktop.ptypeak" 2>/dev/null)"
  if [ -n "$peak" ]; then
    echo "pty: peak $peak /dev/ttys* while the desktop job ran; kern.tty.ptmx_max $(ci_pty_max)" >> "$log"
    printf 'pty=%s/%s\n' "$peak" "$(ci_pty_max)" > "$RESULTS/desktop.pty"
  fi
  return $rc
}

# The iPhone shell (apps/mobile; IOS-SPEC section 7). Runs only when the diff touches apps/mobile, the native bridge
# schema, the TypeScript half of the push seal (the Swift tests read its vectors) or this script (fails closed: an unknown merge-base runs it, and so does a commit already on origin/main). Needs Swift; builds for the simulator when Xcode is
# present, unsigned, with DerivedData in the scratch worktree (deleted with it).
ci_xcode_ok() { local t; for t in ${CI_XCODE_TOOLS:-xcodegen xcodebuild}; do command -v "$t" >/dev/null 2>&1 || return 1; done; }
job_mobile() {
  local log="$1" base
  if ! command -v swift >/dev/null 2>&1; then
    echo "SKIPPED: swift is not installed on this machine" | tee -a "$log"
    SKIPPED+=(mobile); SKIP_WHY="swift is not installed"
    return 0
  fi
  base="$(git merge-base origin/main "$SHA" 2>/dev/null)" || base=""
  # A commit already on origin/main is its own merge-base: an empty diff is not "no mobile changes", so the job runs.
  [ "$base" != "$SHA" ] || base=""
  if [ -n "$base" ] && git diff --quiet --no-renames "$base" "$SHA" -- \
      apps/mobile/ packages/protocol/src/native.ts scripts/native-fixtures.ts scripts/ci-local.sh \
      packages/protocol/src/push-rich.ts packages/protocol/src/push.ts packages/protocol/fixtures/push-rich; then
    echo "skipped (no mobile changes)" | tee -a "$log"
    SKIPPED+=(mobile); SKIP_WHY="no mobile changes"
    return 0
  fi
  [ -d apps/mobile/ios/App ] || { echo "skipped (commit has no iPhone shell)" | tee -a "$log"; SKIPPED+=(mobile); SKIP_WHY="commit has no iPhone shell"; return 0; }
  # The JS steps hold one of CI's slots. The Swift steps hold the desktop mutex and no slot (a slot inside it made the desktop job wait behind check's quiet group: 809 s became 2233 s): two Swift
  # jobs (of one run or two) never run at once (they share the SwiftPM cache, the simulator and the ptys), and one that waits for the
  # mutex holds no slot, so it never holds back check's suites. The desktop job does the same around ci.sh.
  ci_mutex "$LOCKS" suites mobile_js_steps "$log" || return 1
  ci_mutex "$LOCKS" desktop mobile_swift_steps "$log"
}
mobile_js_steps() { # mobile_js_steps <log>: setup, typecheck and the Vitest of the iPhone shell
  local log="$1"
  setup_ok "$log" &&
  run "$log" pnpm --filter @talos-app/mobile typecheck &&
  run "$log" pnpm --filter @talos-app/mobile test
}
mobile_swift_steps() { # mobile_swift_steps <log>: the Swift packages, the generated project and the simulator build and tests
  local log="$1"
  mkdir -p "$CACHE/swiftpm"
  local pkg
  # ci-swift-retry.sh: a failed test runs once more, alone (--filter); a pass then is "passed on retry"
  for pkg in BridgeGuard TalosAudioCore TalosCrashCore TalosPushCore TalosRelayCore; do
    run "$log" bash -c "cd apps/mobile/ios/$pkg && bash '$ROOT/scripts/ci-swift-retry.sh' swift test --cache-path '$CACHE/swiftpm'" || return 1
  done
  run "$log" env TALOS_SWIFTPM_CACHE="$CACHE/swiftpm" bash "$ROOT/scripts/ci-swift-retry.sh" bash apps/mobile/ios/TalosShareCore/test.sh || return 1
  if ci_xcode_ok; then
    # A dummy relay: the generated capacitor.config.json is gitignored and only has to exist for the build.
    TALOS_RELAY_URL=https://relay.example.com run "$log" pnpm --filter @talos-app/mobile cap:sync &&
    run "$log" pnpm --filter @talos-app/mobile check:generated &&
    run "$log" git diff --exit-code -- apps/mobile/ios ':!apps/mobile/ios/App/CapApp-SPM/Package.swift' &&
    run "$log" xcodebuild -project apps/mobile/ios/App/App.xcodeproj -scheme App \
      -destination 'generic/platform=iOS Simulator' -derivedDataPath "$WT/.dd" CODE_SIGNING_ALLOWED=NO build || return 1
    # The tests that run inside the app (AppTests: the real Keychain, sign-out). They need a simulator; none is a failure.
    local dest; dest="$(ci_ios_sim_dest 2>> "$log")"
    [ -n "$dest" ] || { echo "FAILED: no iPhone simulator is installed or could be made, so the app's own tests (AppTests) did not run. Install an iOS runtime in Xcode or set TALOS_IOS_SIM." | tee -a "$log"; return 1; }
    ci_ios_test "$log" "${dest##*=}" xcodebuild -project apps/mobile/ios/App/App.xcodeproj -scheme App -destination "$dest" -derivedDataPath "$WT/.dd" test || return 1
  else
    # Never a pass: the generated-project check and the simulator build are the point of this job. On a Mac it is a failure
    # (the runner lacks a tool); elsewhere the job is recorded as skipped, which no verdict counts as passed.
    if [ "$(uname -s)" = Darwin ]; then
      echo "FAILED: xcodegen or xcodebuild is not on PATH, so the generated project and the simulator build were not checked. Install xcodegen (brew install xcodegen) and Xcode, and re-run." | tee -a "$log"
      return 1
    fi
    echo "skipped (xcodegen or xcodebuild is not installed; the generated-project check and the simulator build did not run)" | tee -a "$log"
    SKIPPED+=(mobile); SKIP_WHY="xcodegen or xcodebuild is not installed"
  fi
}
