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

| count    | last         | test                                                                                                        | file                            |
| -------- | ------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 27       | 11-16        | aCursorMovedByTheOwnerStillGetsTheLabelClickedAndNothingElse                                                | NeedsYouPopupTests.swift        |
| 13       | 11-17        | switchedOffNothingRestartsAndSwitchedOnItWaitsForTheNextRelease                                             | WorkerUpdateRestartTests.swift  |
| 7        | 11-17        | anUpdateRestartsEachStaleSessionOnceOneAtATime…                                                             | WorkerUpdateRestartTests.swift  |
| 9        | 11-17        | aWarmWorkersPointerIsDroppedAfter90Seconds                                                                  | PointerOwedTests.swift          |
| 8        | 11-17        | FINDING_theCrashLoopCountSurvivesARelaunch                                                                  | ReviewOC3IntegrationTests.swift |
| 8+3+3    | 11-17        | aNeedsYouWorkerIsNotIdleParked, aDialogOnALiveWorkerIsFlaggedToo, aDialogThatHasNotHeldStillIsNotFlaggedYet | WorkerDialogTests.swift         |
| 6        | 11-16        | theSameAskBackAfterAThreeSecondFlickerKeepsItsOneLine                                                       | PromptRelay322Tests.swift       |
| 4        | 11-15        | theLastOutcomeSurvivesAnAppRelaunch                                                                         | MainRestartCheckTests.swift     |
| 4        | 11-15        | aLiveSessionThatEndsByItselfIsCounted                                                                       | WorkerCrashCountTests.swift     |
| 4        | 11-15        | aKilledSessionIsGone                                                                                        | WorkerUnknownTests.swift        |
| 4        | 11-15        | aToolPermissionPromptOnALiveWorkerNotifiesItsOwnThreadOnce                                                  | PromptRelayTests.swift          |
| 3        | 11-16        | aScreenThatChangedBetweenTheDecisionAndTheEnterGetsNoEnter                                                  | DevChannelsAcceptTests.swift    |
| 2        | 11-17        | aLineThatIsGoneFromTheBoxIsTypedAgainNotEntered                                                             | PointerOwedEnterTests.swift     |
| 1-2 each | 11-14..11-17 | 22 more (FINDING_aCrashLeavesNothingInTheGroup, aTapWalksToTheSignedRowFirst, aKilledServerIsGone, …)       | same target                     |

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
