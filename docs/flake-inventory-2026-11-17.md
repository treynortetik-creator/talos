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
| 1+1+1 (fixed)      | 11-19 | hub-run: config edit seen within 3 s / 1 s (watch of home): now 8 s, inside the 10 s poll               |
| 3                  | 11-15 | child-wait-sites: Chronos adapter timeout; discovery `version` deadline                                 |
| 2                  | 11-16 | cc-c1: elided Allow kept with the exact note                                                            |
| 1                  | 11-16 | server: a second live bridge stops the first via the PID file                                           |
| 1 each             | 11-14 | apps/reference-servers (system monitor); install-path (second checkout)                                 |
| 1                  | 11-15 | schedules/wake-me.test.ts (the whole file)                                                              |
| 1                  | 11-16 | undo points before delivery: was a real bug, fixed 3fc391303                                            |
| 1                  | 11-20 | peer/link.test.ts "one paste links both directions": 5 s test timeout (load). FIXED (below)             |
| 1                  | 11-20 | run-in-pane.test.ts "signed on a phone, with no click": the owner's line not seen in 15 s (load)        |

peer/link.test.ts (11-20, Cyclops): "one paste links both directions" › "link, accept, collect, then a message each way" hit the
runner's 5 s per-test timeout once, in a full `bun test` of apps/bridge (cyclops/talos-using at 072f906b, a change to instruction
text only, which this test does not read) that took about 23 minutes at load 4.7 from other sessions on this Mac (8 cores). The
next full run (45ac947c, about 23 minutes at load 3.8 to 4.2) passed it; it passed alone once, run to read the cause and not
counted. First guess: the test's own budget is longer than the runner's. It starts two full installs (a FakeRelay and a bridge
harness each), runs `peer link` and `peer accept` in-process, then `pollUntil` allows 6 s plus a 2 s wait for A to collect
(link.test.ts:73-80), against the 5 s default. Under load the installs and the collect fill the 5 s before the poll's own
deadline. To check: time the test's phases under cpu-burn. Likely fix: a per-test timeout above the poll budget (scaled by
TALOS_TEST_TIME_FACTOR), or a collect that is driven, not polled. FIXED 2026-11-20 (Cyclops, the commit "peer/link.test.ts: the
runner's limit sits above the test's own budgets"): red first by a forced 4.9 s slow first poll, inside the test's own 6 s budget
("timed out after 5000ms"); the file's default timeout is now t(40 s), above its longest budget (two installs, POLL_MS, three
WAIT_MS waits), and the poll's trailing 2 s wait is a plain check after the driven loop. The same forced slow start then passes,
and the file passed 8 of 8 under cpu-burn.

run-in-pane (11-20, Cyclops): the whole bridge suite in the gate push of timing burn-down 1 (this Mac, factor 3) at load 13 to 15
on 4 cores, raised by Cyclops's own second builder running tests and cpu-burn beside the gate (its fault, not the test's alone). The
wait was 5000 x waitScale 3 = 15 s. Passed 5/5 alone right after. Not rerun here: handed to Delphi. The file has 18 timing-lint hits;
it goes in a burn-down batch next.

### C. Web (Playwright and vitest)

| count   | last      | test                                                                                                                        | note                                    |
| ------- | --------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 3+2+2+2 | 11-17     | threads/follow-new-text.spec.ts (iphone, pixel, desktop: rereading while a reply streams; reply from another device far up) | FIXED 11-17/18 (below)                  |
| 4       | 11-17     | memory/clio-graph.spec.ts [pixel]                                                                                           | real app bug, fixed by Cyclops 96f23894 |
| 2+1     | 11-16     | threads/copy-button.spec.ts [iphone] dense rows; 44x44 hit area                                                             | FIXED 11-17/18 (below)                  |
| 1 each  | 11-16..17 | schedules offline cold start, themes 375 px, composer scroll-end, review/v2-drive-review F7, Developer page fence           |                                         |
| 1       | 11-17     | cards/permission-explain.test.tsx (vitest) Deny sends the kill                                                              |                                         |
| 1       | 11-19     | bugreport/bug-open-speed.spec.ts:51 [iphone] one tap: the sheet is up at once                                               | load only; Titan root-causing           |
| 1       | 11-19     | schedules/relay.spec.ts:78 [iphone] a change on the Mac pushes one schedule.status, one re-fetch                            | load only; Titan root-causing           |
| 2       | 11-20     | threads/stop-line.spec.ts:232 [iphone] scrolled up, the line appearing moved the view 22 px (CI db37abb6, both tries)       | defensive app fix (below)               |

stop-line :232 (11-20, Cyclops): red on ci-runner (macOS 26) at db37abb6, a CI-scripts-only commit. Both tries moved 22 px when the
line appeared. Titan was offline, so the browser suite ran on ci-runner beside the full check. It never reproduced: about 235 runs on
macOS 15 and macOS 26, quiet and under cpu-burn. A probe logged no scrollTop write and no scroll event; only the new line changed. The
one mechanism that moves scrollTop without a write is CSS scroll anchoring, so the line and the live region after it are now
`overflow-anchor: none` (rows keep theirs), pinned in the spec. Cause unproven: if it comes back, capture a trace on ci-runner.

### D. Scripts (gate and CI tooling)

| count        | last      | test                                                                                                                                                                                                                             | note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2            | 11-17     | gate-push.test.ts 60 s timeouts                                                                                                                                                                                                  | root cause fixed 94710fee1 (setConfig ignored the time factor)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 1            | 11-17     | test-parallel.test.ts: hang kills its children (child alive)                                                                                                                                                                     | suspect a real gap: `ps` 10 s cap leaves children unkilled; also in known-flakes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 1+1          | 11-17     | kit-tests test-update.sh, test-plugin.sh (killed at the 290 s cap)                                                                                                                                                               | load                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| known-flakes | —         | cpu-burn.test.ts x2                                                                                                                                                                                                              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 1 each       | 11-14..16 | ci-local-runner-status, ci-alert, gate.test, root-install-flags                                                                                                                                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2            | 11-20     | kit-tests test-action-rules.sh "a shipped rule is slow on pathological input" (and test-hub-fence.sh, which runs it)                                                                                                             | Hestia (Linux), under the gate's vitest-related load beside root-install*: 0.57 s over its budget; passes alone on the branch (2/2) and on main. A wall-clock budget under parallel load (Hestia)                                                                                                                                                                                                                                                                                                                                                                                                      |
| 1            | 11-20     | kit-tests test-memory-reflex.sh: "speed: median under 150 ms, worst under 600 ms" (median 170 ms, worst 302 ms over 59 runs)                                                                                                     | Cyclops (Mac), `npx vitest run --project scripts` by hand (no gate, so `TALOS_TEST_TIME_FACTOR` unset: factor 1, the 150 ms limit), the whole scripts project running in parallel at the time (120 files; the machine's 15-minute load average was 9.55 a few minutes earlier). Passed alone in the next kit-tests run (36/36); that is not counted as a fix. First guess: the same fixed speed budget 5e2234aa scaled, run here without the factor, and measured beside 100+ other test files. A run by hand needs the factor the gate sets (3 on a small Mac) CLOSED 11-20, not a test fault (below) |
| 1            | 11-20     | kit-tests test-hub-fence.sh (which runs test-action-rules.sh): "a shipped rule is slow on pathological input", then killed at the 290 s kit-run cap                                                                              | Cyclops (Mac), the same parallel run, 451 s for kit-tests alone. Passed alone in the next kit-tests run (36/36); that is not counted as a fix. First guess: load, the sweep over every shipped rule in test-action-rules.sh (486299bf scaled its 0.5 s limit by the factor, which was unset in this run) beside the rest of the scripts project; the same row as Hestia's above. Needs the factor set, or a longer look at which rule is slow when the machine is busy CLOSED 11-20, not a test fault (below)                                                                                          |
| 1            | 11-20     | root-install-v1-gate.test.ts "the kit self-test passes in the upgraded folder": 842 s, it runs the kit self-test (the two rows above), same load (Cyclops quiet run, load 3 rising to 18) CLOSED 11-20, not a test fault (below) |
| every run    | 11-20     | root-install.test.ts "a dry run on a fresh home…", root-install-v1.test.ts "is recognized, and without --apply…" (also -flags, -preflight)                                                                                       | Mac-only (xcode-select, swift, the Mac install steps): fail on every Linux run, main included (Hestia). Should be skipped on non-Mac, not fail; until then a Linux pre-push --full can't pass a change that pulls them in (Hestia)                                                                                                                                                                                                                                                                                                                                                                     |

Kit rows closed 11-20 (Cyclops, with Pantheon): the three Cyclops rows above (memory-reflex, hub-fence, the root-install kit self-test)
came from one manual `npx vitest run --project scripts`, run outside the heavy lock at factor 1 under heavy load (the rows give 9.55 and 3 rising to 18; the run's own log later showed 15 to 24), not from a gate.
Their budgets already scale with TALOS_TEST_TIME_FACTOR, and a gate run cannot meet that load on this Mac: every gate holds
`scripts/heavy-lock.sh` (one slot here, TALOS_HEAVY_SLOTS=1), and a gate hold and a CI run take turns (heavy-lock.sh, "take turns";
scripts/ci-local/turn.sh). The gate's factor is by cores, not load (gate.sh, TALOS_TEST_TIME_FACTOR), and stays so unless a real gate
run is refused this way. Hestia's row (a gate on Linux) stays open.

### E. e2e

| count       | last  | test                                                                                                                              |
| ----------- | ----- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1           | 11-15 | schedules.spec stall: a background run that never starts                                                                          |
| 1           | 11-15 | apps.spec E17 two apps each wait for their own card                                                                               |
| 1 (3 total) | 11-14 | bridge-oversize-card: card.create over 256 KiB                                                                                    |
| 1           | 11-19 | apps.spec E10 fullscreen keeps the same frame (load)                                                                              |
| 1+1         | 11-20 | old-client.spec:74 Run hands the agent the script once: the 10 s "Sent…" wait. APP BUG, fixed 836f73bd (below)                    |
| 1           | 11-19 | Sub-thread launch suite + nothingIsMadeInsideAParentFolderNoSessionMayUse (40.8 s on CI at beda269; 0.25 s / 24 s locally, green) |
| 1           | 11-20 | MainSafetyTests.aClickWhileATmuxClientIsTypingPressesNothing (8.8 s on CI at 77181e7; 0.6 s locally, green)                       |

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

### Fixed 11-20 (Delphi), Swift, red main at 95b24c3

Both ROOT-FIXED in 05eb23ef, test only (the app is as designed); each shown red first, then 20 of 20 quiet and 20 of 20 beside 14 busy loops.

- `SubThreadLaunchTests.nothingIsMadeInsideAParentFolderNoSessionMayUse`: ROOT-FIXED in 05eb23ef. The rig rewrote config.json after the manager was already ticking, and a tick reads the config once, so one running at that moment took the sub's wake under the old config and started a session (CI: state live, starts 1). The whole config, and the folders it points at, are written before ticking starts.
- `PointerOwedEnterTests.aLineThatIsGoneFromTheBoxIsTypedAgainNotEntered(how: session)`: ROOT-FIXED in 05eb23ef. A fixed 0.6 s wait before the owner cleared the box; an emptied box counts as "gone" only after a tick has seen our line in it (`unseenSince`), so a late tick on a loaded machine made the test clear it first. It waits for `lineSeenByManager()` now.
- Preventive, same file, `how: restored`: its fixed 1 s pause after the app comes back now waits for the same look (`lineSeenByManager()`). Not a seen flake and not shown red: the restored copy's first tick runs inside `comeBack`, so the look has already happened and the variant passed 12 of 12 beside 14 busy loops with the pause removed. The wait states the condition instead of a time.

### Fixed 11-20 (Delphi), iPhone app race

- `RelayTrustControllerTests.testNothingLoadsAndNoWatchdogRunsUntilTheFirstCheckAnswers` (:111): an app race (late didFinish of offline.html), ROOT-FIXED in this commit. While the first check is held the gate cancels Capacitor's first relay load, so Capacitor loads offline.html; under load its didFinish could arrive after `loadRelay` had started the real load, and `pageDidFinish` read the web view's current url (already the relay), so it stopped the launch watchdog and a relay that then stalled never showed the offline page. `loadRelay` keeps its WKNavigation, the gate passes the finishing (and committing, and failing) navigation, and only that navigation counts as the relay page. Test: `testALateFinishOfAnEarlierPageDoesNotCountAsTheRelayPageFinishing`, shown red first.

- `RelayTrustControllerTests` (the late-finish tests), red on main 25e156056 under load: the first fix cleared the pending relay navigation when its load failed, so a failed relay load (fast in the test host) re-opened the race: the late finish of an earlier page counted as the relay page again and stopped the watchdog. Fixed in this commit: the pending navigation is kept until its own finish or the next `loadRelay`, and the offline page after a failure is told apart by its url. Test `testARelayLoadThatFailsDoesNotLetALateFinishOfAnEarlierPageStopTheWatchdog`, shown red first. The :111 and :134 failures were a second cause, found from the state the assertion now prints (`paused=true appState=2`): a simulator test host that is not in front reports background, and the watchdog is paused by design then. The tests now set the app state (`TalosBridgeViewController.applicationState`), and one test pins the pause.

### Web rows checked 11-20 (Cyclops)

Each run with `scripts/cpu-burn.sh` on this Mac (8 cores), all three projects unless said, no retries.

- threads/follow-new-text.spec.ts: fixed at the cause after its last sighting (11-17): the reading is taken after the fonts
  load and compares the row in view, not scrollTop (f18ee825, 524fddac); closing the keyboard clears "scrolled up" (a1b4eccf);
  the measured bottom room is gone (e5bcecd9). 240 runs at 1x and 192 at 3x burners per core: 0 failures.
- threads/copy-button.spec.ts: fixed after its last sighting (11-16): every hit-area box read in one synchronous read, so a
  list still scrolling cannot fake an overlap (7262879e, bf9ee62e). 230 runs at 2x: 0 failures.
- themes 375 px and composer scroll-end: fixed 11-17 (7ed1ecf0, 244c4d42: a GET retried once on ECONNRESET by the specs' own
  proxy; a8807a13: offsets compared after the fonts load).
- review/v2-drive-review F7, settings/developer fence, cards/permission-explain (vitest) Deny, schedules/offline-cold-start
  (vitest): one sighting each, nothing changed since, not reproduced (Playwright 90 runs at 2x; vitest 10 rounds at 2x). Open
  with no evidence; a next failure must keep its trace.
- e2e old-client.spec:74 (11-19, again 11-20): an APP bug. The Run line said "Queued · sends when you're back online" until
  the page had handled the relay's ack, and handling it waited on the ack's IndexedDB delete, which took over 10 s on a loaded
  machine; the agent had the Run within 4 s. Reproduced on the saved bundle web-bundle-ca87cf72 by holding the relay's ack
  frames (Playwright routeWebSocket). Fixed 836f73bd: an ack updates the queue and the row's receipt before the delete; the
  line says Queued only offline, "Sending…" with the ack pending, Sent once acked; the spec waits up to 60 s for Sent (saved
  bundles from before the fix keep the old line until they handle the ack). The first attempt (0e61c6ff) moved the wait to the
  agent and missed the cause. Follow-up 1ef6aabd: a deleted, failed queued Run says it was removed.
- Sleeps B, web (this commit's parent): clio-graph (the wheel, the first fit, the panel slide, the pointer releases),
  threads-pr60 (focus after the reorder is drawn), review-scroll (polls the jump back), permission-sheet (waits for the new
  message's unread count, the banner's own trigger, before checking no banner shows; proved not vacuous by removing the app's
  guards: each removal fails it), agents/screenshots and settings/developer (animations done). v2-drive-recheck.spec.ts:311
  went with the voice archive. Left: permission-sheet's shared `settle()` (two frames and 150 ms).

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

old-client.spec:74 (11-19): refused the sign-in card's landing on Delphi at 14:52 MST, while a full gate (check-updates) and the owner's
0.1.6 app build ran beside it; the "Sent…" status was not visible within 10 s. The same spec passed 4/4 in about 20 s on the branch and on
main at ca35a226e in the gate's clean environment. Root fix: Cyclops.

### Unidentified (Titan, 11-19)

| count | last  | step                 | what was seen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----- | ----- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | 11-19 | tests (bridge files) | Pre-push gate of titan/chronos-import (f3a27a4b, the apps/chronos import), on Titan WSL under load (Chronos's own 572-test suite was running at the same time). The serial `bun test --timeout=5000` over the about 156 bridge files the plan picked by basename failed once. The test name is LOST: the push command kept only the REFUSED line, and the gate writes no log of its own. It did not reproduce: the same 156 files passed in the parallel runner (6 jobs), and the next full pre-push passed. Since then, Titan's pushes keep the gate's whole output in a file. |

### Unidentified (Cyclops, 11-21)

| count | last  | step                                                     | what was seen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----- | ----- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | 11-21 | tests (web browser specs, own specs on WebKit and Pixel) | `apps/web/test/cards/permission-sheet.spec.ts` "the sheet owns the screen: fixed to the visual viewport, above the thread and its chrome" [pixel], in the full pre-push gate of one-tap phase 1 (then handed off as `handoff/cyclops/one-tap-1`). All five `elementFromPoint` probes (four corners and the now-playing pill's spot) found an element outside the approval sheet, while its size and `position: fixed` were right. It did not reproduce: 10/10 alone, 30/30 under `scripts/cpu-burn.sh`, 69/69 with all of the change's specs together on Pixel. Guess, unproven: a Radix layer mounted after the sheet (Radix gives every older dismissable layer `pointer-events: none`, and `elementFromPoint` skips those), or the sheet measured before Radix gave it `pointer-events: auto`. Next time: keep the error context and log `document.elementFromPoint(2, 2)` and the sheet's computed `pointer-events` in the failure message. Owner: Cyclops. |
