# Flaky test inventory, 2026-11-17 (Lemnos)

Source: `~/.cache/talos-ci/logs/flakes.tsv` (375 lines since 11-11; 79 distinct tests and 199 lines since 11-14, the fixture below left out), `scripts/known-flakes.txt`, the CI job scripts.
Excluded: `test/flaky.test.ts` "second time lucky" (a fixture of scripts/ci-test-results.test.ts, not a real test).

## Rerun machinery (5 paths, not 2)

| #   | Where                                                                                                                                                | What it does                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `scripts/gate.sh` + `scripts/gate-flakes.sh`, list `scripts/known-flakes.txt`                                                                        | the gate reruns a listed test once (4 entries, all Lemnos, expiry 11-23: enroll file-watch pin, test-parallel hang-kill, cpu-burn x2)                                                                                                            |
| 2   | `scripts/ci-local/jobs-check.sh:16, :170`                                                                                                            | vitest `--retry=1` in CI check and the fast pass; `ci-flake-vitest.ts` logs "passed on retry"                                                                                                                                                    |
| 3   | `scripts/ci-local/jobs-check.sh` `bun_retry`                                                                                                         | bridge bun runner `--retry-failed`: a failed file runs once more                                                                                                                                                                                 |
| 4   | `scripts/ci-swift-retry.sh`                                                                                                                          | a failed `swift test` reruns only the failed tests once: desktop (`apps/desktop/scripts/ci.sh:23,27`) and the iOS packages (`scripts/ci-local/jobs-swift.sh:99,101`: BridgeGuard, TalosAudioCore, TalosCrashCore, TalosPushCore, TalosShareCore) |
| 5   | `apps/web/playwright.config.ts:29`, `e2e/playwright.config.ts:22`, `packages/protocol/playwright.config.ts:14`, `apps/relay/playwright.config.ts:17` | `retries: CI_FLAKE_FILE ? 1 : 0` (apps/web's mic project already has `retries: 0`)                                                                                                                                                               |

Keep: `flakes.tsv` logging and the reporters' failure records.

## Flaky tests seen since 11-14, grouped by suspected cause

count = flakes.tsv lines since 11-14; last = last seen (UTC).

### A. Desktop Swift integration tests (`apps/desktop/Tests/TalosDesktopIntegrationTests`) — 37 tests, 129 lines

Suspected: fixed waits against a real tmux and real processes, which lose under CPU load (load 13-42 here in gates).

| count    | last         | test                                                                                                        | file                              |
| -------- | ------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 27       | 11-16        | aCursorMovedByTheOwnerStillGetsTheLabelClickedAndNothingElse                                                | NeedsYouPopupTests.swift          |
| 13       | 11-17        | switchedOffNothingRestartsAndSwitchedOnItWaitsForTheNextRelease                                             | WorkerUpdateRestartTests.swift    |
| 7        | 11-17        | anUpdateRestartsEachStaleSessionOnceOneAtATime…                                                             | WorkerUpdateRestartTests.swift    |
| 1        | 11-19        | theSameAskBackAfterAThreeSecondFlickerKeepsItsOneLine (FIXED 11-18, below)                                  | PromptRelay322Tests.swift         |
| 9        | 11-17        | aWarmWorkersPointerIsDroppedAfter90Seconds                                                                  | PointerOwedTests.swift            |
| 8        | 11-17        | FINDING_theCrashLoopCountSurvivesARelaunch                                                                  | ReviewOC3IntegrationTests.swift   |
| 8+3+3    | 11-17        | aNeedsYouWorkerIsNotIdleParked, aDialogOnALiveWorkerIsFlaggedToo, aDialogThatHasNotHeldStillIsNotFlaggedYet | WorkerDialogTests.swift           |
| 6        | 11-16        | theSameAskBackAfterAThreeSecondFlickerKeepsItsOneLine                                                       | PromptRelay322Tests.swift         |
| 4        | 11-15        | theLastOutcomeSurvivesAnAppRelaunch                                                                         | MainRestartCheckTests.swift       |
| 4        | 11-15        | aLiveSessionThatEndsByItselfIsCounted                                                                       | WorkerCrashCountTests.swift       |
| 4        | 11-15        | aKilledSessionIsGone                                                                                        | WorkerUnknownTests.swift          |
| 4        | 11-15        | aToolPermissionPromptOnALiveWorkerNotifiesItsOwnThreadOnce                                                  | PromptRelayTests.swift            |
| 3        | 11-16        | aScreenThatChangedBetweenTheDecisionAndTheEnterGetsNoEnter                                                  | DevChannelsAcceptTests.swift      |
| 2        | 11-17        | aLineThatIsGoneFromTheBoxIsTypedAgainNotEntered                                                             | PointerOwedEnterTests.swift       |
| 1        | 11-18        | FINDING_aToolProcessThatLeftTheGroupDoesNotOutliveACrash                                                    | ReviewOC3R2IntegrationTests.swift |
| 1-2 each | 11-14..11-17 | 22 more (FINDING_aCrashLeavesNothingInTheGroup, aTapWalksToTheSignedRowFirst, aKilledServerIsGone, …)       | same target                       |

FIXED 11-18 (Delphi): `theSameAskBackAfterAThreeSecondFlickerKeepsItsOneLine` waited for the ask's words, not the whole ask held still; the manager's look could catch it half drawn. 1 run in 6 under load before, 0 in 16 after.

Open: `FINDING_aToolProcessThatLeftTheGroupDoesNotOutliveACrash` (ReviewOC3R2IntegrationTests.swift, the "parked" wait at :453) failed once on CI at a8bd0ac, one failure in about 563 desktop logs. Hypothesis: the test killed the worker while its pointer was still owed, so `runQueued` (WorkerPark.swift:61-62) started it again in the tick that parked it and "parked" never showed; the same race as ff0bbffc0. Not reproduced: 105 local runs, quiet and under an 18-core burn, 0 failures. Changed: the test waits for the typed pointer before the kill, and both "parked" waits in the file print `r.why` (state, error, starts). Status OPEN: closed only by a repro, or by a CI failure whose message shows the state. Owner: Lemnos.

Fixed (11-18): `aWarmWorkersPointerIsDroppedAfter90Seconds` (PointerOwedTests.swift). 27 failing CI desktop logs, 11-10 to 11-18 (always the two issues at `:211` and `:214`, the same two lines at `:181` and `:184` before 4a6637e30; none from the pty-exhausted c9a606d), "passed on retry" in the 11-18 nightly. Cause: TEST, not the app. The test waited for "a deadline on disk" (`owed().until != nil`) to know the first copy had taken the second wake, but the first message's own deadline can still be on disk while its tick ends, so the first copy could go (`appGone`) with the wake file still in the folder. The second copy then took that wake fresh: a wake's pointer is typed with no deadline check by design (a hand-off waits up to 15 minutes, `WorkerWakes.swift:36-38`), so it stayed held by the draft (`until` still set at `:211`) and was typed once the draft went (two lines at `:214`). Shown red by a variant that detaches before the second wake is taken: the same two failures and the same ~30 s. Fix: the test waits for the wake file to be gone and the deadline to be on disk. Status: fixed in the test; the app is as designed.

Fixed in the test, cause not proven (11-18): `afterTheWallClockIsSetBackTheSessionInUseIsNotTheCapsChoice` (WorkerFollowupsTests.swift). 5 failing CI logs: 4 at the "both quiet" precondition (`aa` read busy; e7d0f69 11-12, a641326 11-17, daf32f6 11-18, and c9a606d 11-18, which was pty-exhausted and is no evidence) and 1 (3d2d125, 11-17) where the cap parked `aa`, the session in use. The test slept a fixed 7 s of real time so tmux's real output times would catch up with a wall clock set back 5 s, then read one state snapshot, which is whichever tick last finished. The app's ranking is right (the cap ranks on the awake clock, `WorkerManager.swift:519`); a run with the ranking put back on the wall clock still fails this test. Not reproduced: about 35 parallel runs under a 14-core burn and one full-suite run under a 10-core burn, 0 failures, and the busy reading that failed the runs was not found. Change: the clocks are moved on in one step (`c.pass(7)`, no sleep) and the test waits for both states to read live. Status: test no longer waits on time; if it fails again its message shows the states, and the cause is still open.

Fixed (11-19), test only: `anUpdateRestartsEachStaleSessionOnceOneAtATimeResumingItAndNeverAsACrash` (WorkerUpdateRestartTests.swift). 28 failing CI desktop logs, 11-14 to 11-19. The 12 since the failure dump (`updateDump`, 3e0f70504) all read the same (the 16 earlier have no dump): one session `parked`, pgid 0, no pane, `afterPark nil`, `stopped_why restart`, an empty update queue, and `update_restart_queued thread=trip` twice in the audit. Cause (reproduced with a pause, and what all 12 dumps show): the test sets `release.value = "r2"` while the first update manager is still ticking, and only then makes the second one (`updatingManager` detaches the old one). In that gap the old manager sees the new release itself, queues both threads, SIGTERMs one for its restart (`update_restart`, `worker_parked`) and is detached; the restart that was to follow lives only in its memory (`afterPark`), so the second manager adopts a session parked with nobody left to restart it and says "restarted" for the other. The app is right: a manager that dies between the park and the start leaves the session to its next start, which takes the new spec anyway. Reproduced: a 0.7 s pause after `release.value = "r2"` (what a loaded Mac gives the gap) fails the old test every time with the CI signature (`starts 3`, one `parked`, trip queued twice); with the fix the same pause passes. Change: the old manager is detached before the release changes (the app quits before the new release exists), also before `r3`.

Fixed (11-19), test only: `theAutoConfirmEnterIsNotSwallowedByCopyMode` (ReviewD2ViewerTests.swift). 3 failing CI logs (04e36b9 11-11, 4c83073 11-15, 2df28d5 11-18), always `Expectation failed: sawMode`, which is the first assertion (the Enter assertion after it passed). Not the tmux SIGCHLD change 8db54967 (the earliest failing log, 11-11, predates it, and the nudge only delays a crash's report). Cause (shown by the instrumented reproduction below; the CI logs show only `sawMode`): the fake crashed 1 s after it started (`FAKE_CRASH_SECONDS`), the test attached the viewer after that, and on a loaded Mac attaching took longer than the crash: the whole crash-restart-Enter ran before the first wheel-up, the loop (`while starts < 2 || !running`) never ran, and the pane never entered copy mode (instrumented run: `iters=0 startsAtLoop=2`). The test's premise was never made. A run that does hit it is what the app's own guard turns into a long one (`auto_confirm_refused reason=clientsMayBeTyping`: the wheel counts as the owner typing, the Enter waits for it to stop). Reproduced: a 4 s pause before the attach fails the old test every time (`iters=0`, `sawMode=false`); 25 runs under a 3-core burn did not fail it without the pause. Change: the crash waits for a file (`FAKE_CRASH_ON_FILE`, the way MainResilienceTests do) which the test creates only once a wheel-up has put the pane in copy mode. The test cannot pass without its premise, and the Enter assertion is unchanged.

Open, not reproduced (11-19): `cleanExitsRestartAtTheFirstStepWithoutSpendingTheCrashLoop(kind: .tmux)` (MainResilienceTests.swift). One real failing CI log (2df28d5, 11-18): only `restartsInWindow == 0` failed (it was 1); the run reached 4 starts and running, the audit had its clean exits and the delays were [0.3, 0.3, 0.3]. The 11-11 failure (2fb1397, `start_failed: the agent exited immediately`) is another, older fault. A restart is counted (`Supervisor.doRestart`) only for an exit that was not read as a clean one and is not a retry; one such exit at attempt 0 has the same 0.3 s delay and so passes every other line. The likeliest reading is the tmux host reporting one exit with no code (the pane read dead before tmux had reaped it, 5 polls, `TmuxPtyHost.deadStatusPolls`, or the host read as lost) which Main takes for a crash. That is app behaviour under load, and not shown here: 12 runs under a 10-core burn and 53 under a 16-core burn (beside CI's other jobs), 0 failures. Pty exhaustion is possible but not shown: both failing runs (2df28d5 and 2fb1397, the 11-11 one a `start_failed`) peaked at 500 of 511 ptys (kern.tty.ptmx_max), but 84 of 184 desktop logs peak at 480 or more and most are green, and neither log has a fork or pty error near the failure. Change so far: the failed assertion now prints the audit, to tell these apart. Open: no load runs until the pty leak (swiftpm-testing-helper holding 498 of 511 ptys) is fixed; then check whether the failures stop.

### B. Bridge (bun) — file watches and slow `ps`

Suspected: file-watch latency (fseventsd ran at 107% CPU until the owner restarted it 11-16) and `ps` slow under load.

| count              | last  | test                                                                                                    |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------------- |
| 10                 | 11-14 | schedules/discovery-budget: one deadline for the whole discovery (fails fast, then a stalled `version`) |
| 6                  | 11-16 | v5-memory: a new file becomes searchable by itself while the watch is on                                |
| 4+2                | 11-15 | heartbeat/runner: record before input when ps is slow; wake cap                                         |
| 1 (17 since 11-11) | 11-16 | heartbeat/process-info: a slow ps does not stall the loop                                               |
| 1                  | 11-16 | enroll: the live bridge pins from the file watch (also in known-flakes)                                 |
| 1+1                | 11-16 | hub-run: config edit seen within 3 s / 1 s (watch of home)                                              |
| 3                  | 11-15 | child-wait-sites: Chronos adapter timeout; discovery `version` deadline                                 |
| 2                  | 11-16 | cc-c1: elided Allow kept with the exact note                                                            |
| 1                  | 11-16 | server: a second live bridge stops the first via the PID file                                           |
| 1 each             | 11-14 | apps/reference-servers (system monitor); install-path (second checkout)                                 |
| 1                  | 11-15 | schedules/wake-me.test.ts (the whole file)                                                              |
| 1                  | 11-16 | undo points before delivery: was a real bug, fixed 3fc391303                                            |

### C. Web (Playwright and vitest)

| count   | last      | test                                                                                                                        | note                                    |
| ------- | --------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 3+2+2+2 | 11-17     | threads/follow-new-text.spec.ts (iphone, pixel, desktop: rereading while a reply streams; reply from another device far up) | scroll-position race; app first         |
| 4       | 11-17     | memory/clio-graph.spec.ts [pixel]                                                                                           | real app bug, fixed by Cyclops 96f23894 |
| 2+1     | 11-16     | threads/copy-button.spec.ts [iphone] dense rows; 44x44 hit area                                                             | layout timing                           |
| 1 each  | 11-16..17 | schedules offline cold start, themes 375 px, composer scroll-end, review/v2-drive-review F7, Developer page fence           |                                         |
| 1       | 11-17     | cards/permission-explain.test.tsx (vitest) Deny sends the kill                                                              |                                         |
| 1       | 11-19     | bugreport/bug-open-speed.spec.ts:51 [iphone] one tap: the sheet is up at once                                               | load only; Titan root-causing           |
| 1       | 11-19     | schedules/relay.spec.ts:78 [iphone] a change on the Mac pushes one schedule.status, one re-fetch                            | load only; Titan root-causing           |

### D. Scripts (gate and CI tooling)

| count        | last      | test                                                               | note                                                                             |
| ------------ | --------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 2            | 11-17     | gate-push.test.ts 60 s timeouts                                    | root cause fixed 94710fee1 (setConfig ignored the time factor)                   |
| 1            | 11-17     | test-parallel.test.ts: hang kills its children (child alive)       | suspect a real gap: `ps` 10 s cap leaves children unkilled; also in known-flakes |
| 1+1          | 11-17     | kit-tests test-update.sh, test-plugin.sh (killed at the 290 s cap) | load                                                                             |
| known-flakes | —         | cpu-burn.test.ts x2                                                |                                                                                  |
| 1 each       | 11-14..16 | ci-local-runner-status, ci-alert, gate.test, root-install-flags    |                                                                                  |

### E. e2e

| count       | last  | test                                                     |
| ----------- | ----- | -------------------------------------------------------- |
| 1           | 11-15 | schedules.spec stall: a background run that never starts |
| 1           | 11-15 | apps.spec E17 two apps each wait for their own card      |
| 1 (3 total) | 11-14 | bridge-oversize-card: card.create over 256 KiB           |
| 1           | 11-19 | apps.spec E10 fullscreen keeps the same frame (load)     |

E10 (11-19, passed on retry): Titan, the e2e packages on 8 workers beside a live check-titan (a load measurement).

### Fixed 11-19 (Titan)

Each reproduced, or reasoned through where it would not reproduce, beside a 14-core burner; fixed at the cause, with no retries
and no longer limits. TEST unless said.

- schedules/discovery-budget (592144d9): the fake slept 1 s of the 3 s total, so the stalled sometimes never
  started; it fails at once now (15 of 15 under load).
- apps/reference-servers, system monitor (5f750623): the free port was closed before the monitor bound it; a monitor that finds
  it taken (it exits in 0.4 s) gets another port. Not reproduced.
- e2e bridge-oversize-card (61abe2b8): reconnects were counted over the whole bridge log, a first dial that missed under load
  included; counted from the card now. Not reproduced.
- web bugreport/bug-open-speed (b0caad35, 39e44684): a stopwatch, now frames and "picture not ready yet"; and two APP bugs: the
  8 s give-up could not land on a slow phone, and Preview moved 52 px on an iPhone.
- web schedules/relay.spec.ts:78 (ab4facd8, d9ae039b): the specs took a false "offline" flash for the page; and the APP drew
  that flash on every open.
- relay peer rotate, red main at 50b976cb (3a019fc3; the guard a634916c, 7d1846cf, 34540b43): a long fake-clock advance replayed
  days of relay timers past the server keep-alive; a test relay now keeps idle sockets, and an advance over 20,000 timers fails.

### Runner verdicts (not test flakes)

- **main d7d2d96, check, 11-19 (Lemnos): RUNNER, pty exhaustion.** The commit was Swift only; 5 bridge tests timed out (pane Run x2, file-card emoji 60 s, undo-card jcs 60 s, rollback killed at 20 s). The run's timings.tsv row says `pty=507/511`: the parallel desktop Swift run beside it leaked ptys. Root cause and fix: 9c0f495e7 (Delphi; parallel Swift Testing parked every cooperative thread, so SwiftTerm's closes never ran; now a width cap at cores-2 and a pty-watch guard). No rerun-to-green.

### Sleeps used as fixes

Sonnet survey of about 1,400 sleep and waitForTimeout hits; about 70 read in context, the rest screened. Classes: B = a fixed wait
for something that has a condition (should poll it); A = a negative window ("nothing more arrives"); C = the timing is the behaviour.

B, to convert to conditions (about 40 sites):

- bridge `lifecycle.test.ts:196` (poll psInfo); bridge sleep-before-`eventually` in notify, security, messages, review-fixes,
  v2-v0, health tests; `voice.test.ts:135` asserts nothing (delete)
- relay core: sleep-before-`vi.waitFor` in session, health, health-recheck, health-review, schedules, disk-low tests (delete the sleep)
- desktop: `ScreenServerTests.swift:380,399`, `OnboardingSignInTests.swift:119,143,232,334`, `MainThreadAndNoticesGuiTests.swift:293`
- web: `v2-drive-recheck.spec.ts:311`, `clio-graph.spec.ts:100`, `threads-pr60.spec.ts:28`, `review-scroll.spec.ts:314`,
  `permission-sheet.spec.ts:197` (vacuous without the wait), screenshot settles in clio-graph, agents/screenshots, settings/developer
- e2e: `08-devices.spec.ts:96` (4 s; wait until the old bridge is disconnected), `settings-switches.spec.ts:110`
- kit: `test-permission-relay.sh:412-446` fixed sleep 1.5-4 s (poll the hub log)

A, negative windows (about 550 bridge/relay, about 80 e2e/web at 1500 ms, Swift 1.5-4 s "well past the settle time"):

- queue-kill-reopen (`e2e/tests/journeys/queue-kill-reopen.spec.ts`): not flake fixes (one commit, 96a389bbb). Line 31 "dead app
  delivered nothing" is weak: the renderer is gone, and a live app reconnects at about 1 s with jitter, so 1500 ms would not catch
  it reliably; replace it with "the relay has no app socket". Lines 48 and 67 "only once": wait for pendingForBridge() === 0
  first (as relay-restart.spec.ts:109 does), then a short window.
- Swift wall-clock negatives (PromptRelayTests:93, WorkerDialogTests:220, WorkerTwinsTests:369, MainThreadAndNoticesGuiTests:330):
  a test-owned clock (as b31e467b3 did for the flicker test) removes them, and is the likely root of much of group A above.

C (pacing under test): long-press thresholds, apps.spec 5.6 s activation window, the enroll prompt's 500 ms guard. Fine;
page.clock would make the web ones deterministic.
