# Timing lint: baseline, 2026-11-20

`scripts/timing-lint.ts` finds the test timing that fails on a loaded machine (the class fixed 13 times in 7 days, about 6
refused gates; last: ace76cd5, `apps/bridge/test/peer/link.test.ts`). The gate runs it on **added and changed lines only**
(`scripts/gate.sh`, step `timing`, also in `--checks-only`), so the code below blocks nobody until someone touches it. This is
the count of what is already there, taken on `main` at ace76cd5 with `node scripts/timing-lint.ts --strict --summary` (1,649
test files scanned).

## What it reports

| rule           | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | fails the gate    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `unscaled`     | a literal timeout or wait not scaled by `TALOS_TEST_TIME_FACTOR`: `test(n, fn, ms)`, `setDefaultTimeout`, `vi.setConfig({ testTimeout, hookTimeout })`, `{ timeout: ms }` in a wait, assertion or test call, `vi.waitFor(fn, ms)` and testing-library's `waitFor`, `eventually(fn, ms)`, `sleep(ms)` / `wait(ms)` / `Bun.sleep(ms)`, `new Promise(r => setTimeout(r, ms))`, `setTimeout(ms)` from `node:timers/promises`, `page.waitForTimeout(ms)`, `test.setTimeout(ms)`, `expect.poll`/`toPass({ timeout })`, `const end = Date.now() + ms`, shell `sleep n` in kit tests | yes               |
| `speed`        | a fixed limit on a measured time (`expect(elapsed).toBeLessThan(150)`, python `assert dt < 1`); a ratio of two times measured on the same machine is not one                                                                                                                                                                                                                                                                                                                                                                                                                 | yes               |
| `empty-reason` | `// timing-ok:` with nothing after it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | yes               |
| `exceeds`      | the waits that must run one after another inside one test add up to more than its timeout; the testkit's `waitFor` counts at its real `waitScale` (3 x its timeout, 9 s with none), the bridge's `eventually` at its own timeout (10 s with none)                                                                                                                                                                                                                                                                                                                            | yes               |
| `cannot-prove` | waits in loops, branches, callbacks or `Promise.all` might push a test over (`--strict` only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | never in the gate |
| `long-advance` | a fake-clock `advance` over an hour: use `clock.jump()` or `clock.set()` (7d1846cf)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | warning only      |

Passes: `t(n)`, `scaled(n)`, `n * F`, `timeFactor()`, a named constant defined from one of those, 50 ms or less (a yield),
and a line (or the line after a `// timing-ok: <reason>` comment) whose reason says why the time is the behaviour: a negative
window, a product deadline.

### How each runner's effective timeout is found

| runner                                                     | where the default comes from                                                                                                                                                                                                                                                                                                   | scaled by the factor?                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| bun test (`apps/bridge`)                                   | the gate runs `bun test --timeout=$((5000 * F))` (`scripts/gate.sh`, "tests (bridge files)"); the lint uses 5 s. The whole-suite runner (`test-parallel.ts`) uses 20 s x F and `package.json` 30 s, so 5 s is the tightest one that has refused pushes. A file's `setDefaultTimeout(n)` or a test's third argument replaces it | the gate scales the 5 s; a file's own number must scale itself with `t()` |
| vitest (`scripts`, `apps/web`, `apps/relay`, `packages/*`) | `vitest.config.ts`: `testTimeout` 30 s x F, `hookTimeout` 10 s x F, every project. A file's `vi.setConfig` replaces it (94710fee, bf7be8a1)                                                                                                                                                                                    | the config scales; a `setConfig` or `{ timeout }` in a file does not      |
| Playwright, `apps/web`                                     | `apps/web/playwright.config.ts` sets no `timeout`, so Playwright's 30 s and `expect` 5 s apply                                                                                                                                                                                                                                 | **no**: nothing reads the factor                                          |
| Playwright, `e2e`                                          | `e2e/playwright.config.ts`: `timeout: 90_000`, `expect: { timeout: 10_000 }`                                                                                                                                                                                                                                                   | **no**                                                                    |

So Playwright specs get no help from the factor at all, and every explicit `{ timeout: n }` or `waitForTimeout(n)` there is a
literal that does not scale; `t()` from `@talos-app/testkit` is the way, and the config budgets stay as they are (the lint
reads them as 30 s and 90 s at factor 1).

The testkit's `waitFor` multiplies its timeout by `waitScale()` (`TALOS_TEST_WAIT_SCALE`, default 3), a separate knob from the
time factor, so a literal there is not flagged by rule (a); rule (b) counts it at 3 x. `vi.waitFor` and testing-library's
`waitFor` (told apart by the file's imports) and the bridge's `eventually` (no multiplier) are flagged.

### On `--changed`

A hit is reported when its own line is added or changed, when the test's body changed (rule (b)), or when a line it depends on
changed: the definition of a constant its wait uses (`const WAIT_MS = t(6000)` becoming `6000`), or the timeout it runs under
(`setDefaultTimeout`, `vi.setConfig`, `test.setTimeout`, `describe.configure`, the test's third argument), which re-checks every
test under it. A renamed file (`git diff -M`) is judged on the lines the rename's diff adds or changes, not as new.

## Baseline

| package           |    total | unscaled | speed | exceeds | cannot-prove | long-advance |
| ----------------- | -------: | -------: | ----: | ------: | -----------: | -----------: |
| apps/bridge       |     1222 |      491 |    40 |     620 |           43 |           28 |
| apps/relay        |      455 |      379 |     0 |      53 |            3 |           20 |
| apps/web          |      305 |      282 |     3 |      17 |            3 |            0 |
| scripts           |      252 |      227 |    25 |       0 |            0 |            0 |
| e2e               |      119 |      117 |     1 |       1 |            0 |            0 |
| kit               |       13 |       13 |     0 |       0 |            0 |            0 |
| packages/protocol |        6 |        5 |     1 |       0 |            0 |            0 |
| packages/testkit  |        2 |        2 |     0 |       0 |            0 |            0 |
| apps/mobile       |        1 |        1 |     0 |       0 |            0 |            0 |
| **all**           | **2375** |     1517 |    70 |     691 |           49 |           48 |

Without `--strict` (what the gate counts) there are 2,326 hits: `cannot-prove` (49) is the only difference. No `empty-reason`
hit exists yet. The 48 `long-advance` lines are warnings, so the gate would refuse on 2,278 existing lines if it read them all.

### The 20 files with the most hits

| file                                                   | hits | by rule                                                         |
| ------------------------------------------------------ | ---: | --------------------------------------------------------------- |
| `apps/bridge/test/dialog-card.test.ts`                 |   67 | unscaled 22, exceeds 45                                         |
| `scripts/windows-distro.test.ts`                       |   32 | unscaled 22, speed 10                                           |
| `apps/bridge/test/action-rule-asks.test.ts`            |   30 | exceeds 5, unscaled 16, cannot-prove 8, speed 1                 |
| `apps/bridge/test/router-main-handover.test.ts`        |   30 | exceeds 14, unscaled 15, cannot-prove 1                         |
| `apps/bridge/test/delivery-failures.test.ts`           |   29 | exceeds 20, unscaled 9                                          |
| `apps/bridge/test/child-wait-sites.test.ts`            |   28 | speed 9, unscaled 19                                            |
| `apps/relay/test/core/health.test.ts`                  |   28 | unscaled 23, exceeds 3, long-advance 1, cannot-prove 1          |
| `apps/bridge/test/permission-hook.test.ts`             |   27 | unscaled 16, exceeds 8, cannot-prove 3                          |
| `e2e/tests/schedules.spec.ts`                          |   27 | unscaled 26, exceeds 1                                          |
| `apps/bridge/test/problems.test.ts`                    |   26 | exceeds 12, unscaled 8, cannot-prove 1, long-advance 4, speed 1 |
| `apps/bridge/test/screen-consent.test.ts`              |   23 | exceeds 11, speed 1, unscaled 10, cannot-prove 1                |
| `apps/relay/test/apps/app-frames.test.ts`              |   22 | unscaled 21, exceeds 1                                          |
| `scripts/root-install-v1-review.test.ts`               |   21 | unscaled 21                                                     |
| `apps/bridge/test/server.test.ts`                      |   20 | unscaled 12, exceeds 5, cannot-prove 3                          |
| `apps/bridge/test/real-claude-permission-hook.test.ts` |   19 | unscaled 16, exceeds 3                                          |
| `apps/relay/test/core/outbox.test.ts`                  |   19 | unscaled 8, exceeds 11                                          |
| `apps/bridge/test/heartbeat/wake-service.test.ts`      |   18 | exceeds 16, long-advance 2                                      |
| `apps/bridge/test/permission-mode.test.ts`             |   18 | exceeds 15, unscaled 3                                          |
| `apps/bridge/test/run-in-pane.test.ts`                 |   18 | exceeds 16, unscaled 2                                          |
| `apps/bridge/test/undo-delivery.test.ts`               |   18 | exceeds 14, unscaled 4                                          |

Reading the numbers: `apps/bridge` is 51 % of the hits and 620 of the 691 `exceeds`: those tests add up to more waiting than
the 5 s `bun test` limit the gate gives them, counting the testkit's `waitFor` at its real `waitScale` (3 x its timeout; a
`waitFor(…, 4000)` twice is 24 s, a `waitFor` with no timeout is 9 s). That is the ace76cd5 shape, and the list to fix first:
those are the tests that time out with no message saying which step was slow. (The first version of the lint counted a
`waitFor` at its nominal timeout and reported 247; the count above is the real one.)

## The "sleeps used as fixes" sites (flake inventory, class B)

`docs/flake-inventory-2026-11-17.md`, "Sleeps used as fixes", lists about 40 sites where a fixed wait stands in for a condition.
Cross-reference against the lint (hits now in the file; "sleeps" is the subset that is a `setTimeout`, `sleep` or
`waitForTimeout`). The lint flags a wait for being fixed and unscaled; it cannot tell a class B sleep (should poll) from a
class A negative window or a class C pacing wait, so the sleeps column is where to look.

| site (inventory)                                                                              | file now                                        | status                                                                                                          | hits | sleeps |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---: | -----: |
| bridge `lifecycle.test.ts:196`                                                                | `apps/bridge/test/lifecycle.test.ts`            | open                                                                                                            |    8 |      3 |
| bridge sleep before `eventually`: notify                                                      | `apps/bridge/test/notify.test.ts`               | open                                                                                                            |    6 |      3 |
| security                                                                                      | `apps/bridge/test/security.test.ts`             | open                                                                                                            |   11 |      6 |
| messages                                                                                      | `apps/bridge/test/messages.test.ts`             | open                                                                                                            |    6 |      1 |
| review-fixes                                                                                  | `apps/bridge/test/review-fixes.test.ts`         | open                                                                                                            |   15 |      7 |
| v2-v0                                                                                         | `apps/bridge/test/v2-v0.test.ts`                | open                                                                                                            |    9 |      4 |
| health                                                                                        | `apps/bridge/test/health.test.ts`               | open                                                                                                            |    9 |      2 |
| `voice.test.ts:135` (asserts nothing)                                                         | gone                                            | converted: the voice input archive removed it (2026-11-19)                                                      |    - |      - |
| relay core: session                                                                           | `apps/relay/test/core/session.test.ts`          | open                                                                                                            |   18 |      7 |
| health                                                                                        | `apps/relay/test/core/health.test.ts`           | open                                                                                                            |   28 |     12 |
| health-recheck                                                                                | `apps/relay/test/core/health-recheck.test.ts`   | open                                                                                                            |    5 |      2 |
| health-review                                                                                 | `apps/relay/test/core/health-review.test.ts`    | open                                                                                                            |   16 |     11 |
| schedules                                                                                     | `apps/relay/test/core/schedules.test.ts`        | open                                                                                                            |   17 |     11 |
| disk-low                                                                                      | `apps/relay/test/core/disk-low.test.ts`         | open                                                                                                            |    9 |      6 |
| web `v2-drive-recheck.spec.ts:311`                                                            | `apps/web/test/review/v2-drive-recheck.spec.ts` | converted (went with the voice archive); one 800 ms wait left at :278                                           |    1 |      1 |
| web `clio-graph.spec.ts:100`                                                                  | `apps/web/test/memory/clio-graph.spec.ts`       | converted (761b6bb1: wheel, first fit, panel slide, pointer releases); its explicit `{ timeout }` values remain |    5 |      0 |
| web `threads-pr60.spec.ts:28`                                                                 | `apps/web/test/review/threads-pr60.spec.ts`     | converted (761b6bb1)                                                                                            |    0 |      0 |
| web `review-scroll.spec.ts:314`                                                               | `apps/web/test/shell/review-scroll.spec.ts`     | converted (761b6bb1: polls the jump back)                                                                       |    0 |      0 |
| web `permission-sheet.spec.ts:197`                                                            | `apps/web/test/cards/permission-sheet.spec.ts`  | converted (761b6bb1); the shared `settle()` (two frames and 150 ms) was left on purpose                         |    1 |      1 |
| web screenshot settles (agents/screenshots, settings/developer)                               | under `apps/web/test`                           | converted (761b6bb1: animations done)                                                                           |    0 |      0 |
| e2e`08-devices.spec.ts:96` (4 s)                                                              | `e2e/tests/08-devices.spec.ts`                  | open                                                                                                            |    2 |      2 |
| e2e`settings-switches.spec.ts:110`                                                            | `e2e/tests/journeys/settings-switches.spec.ts`  | open                                                                                                            |   10 |      5 |
| kit`test-permission-relay.sh:412-446`                                                         | `kit/scripts/test-permission-relay.sh`          | open                                                                                                            |    7 |      7 |
| desktop (Swift): `ScreenServerTests`, `OnboardingSignInTests`, `MainThreadAndNoticesGuiTests` | `apps/desktop`                                  | open, not scanned (Swift)                                                                                       |    - |      - |

Class A (negative windows, about 550 in bridge and relay, about 80 e2e and web at 1500 ms) are the bulk of the 1,517
`unscaled` hits. Most are correct as written and want `t()` or a `// timing-ok: a negative window` comment, not a poll.

## Cleaning up later

Run a whole suite by hand through the heavy lock, or with the gate's factor: `bash scripts/heavy-lock.sh run <name> -- npx vitest run
--project scripts`, or `TALOS_TEST_TIME_FACTOR=3 ...`. A bare full run beside other work sees loads the gate never does, and its
reds are not test faults (three kit rows, 11-20).

No mass fixing is part of this change. A way to take it down without a big bang:

1. **Touch it, fix it.** The gate already makes whoever edits a line or a test fix its hits. That alone drains the list at the
   rate the tree changes.
2. **`exceeds` first (691).** These time out with no message. Per file, one line fixes most: `setDefaultTimeout(t(40_000))`
   under the imports (bun), plus `t()` on the waits (ace76cd5 is the pattern). Start at `dialog-card`, `delivery-failures`,
   `wake-service`, `heartbeat/service`, `router-main-handover`.
3. **Whole-file `unscaled` by a codemod.** In a file where every `waitFor(…, N)` is a positive wait, `waitFor(x, N)` becomes
   `waitFor(x, t(N))` with `import { t } from '@talos-app/testkit'`. Do it a package at a time and run the package's tests under
   `scripts/cpu-burn.sh` load (never loop `yes`).
4. **Negative windows** get `// timing-ok: <what must not happen>` once the test is read, not blindly: a test-owned clock
   (`page.clock`, `fakeClock`) removes many of them (inventory, class A).
5. **`long-advance` (48):** replace with `clock.jump()` (each due timer fires once) or `clock.set()` (none must run).
6. **Speed budgets (70):** wrap with `t()`, or turn into a ratio against a baseline measured in the same test.
7. **Playwright** has no factor at all (see above): a `t()` on each explicit timeout is the only scaling there. Raising
   `playwright.config.ts` budgets by the factor would change `scripts/gate-inputs.txt` files (a full gate), so it is its own
   change.
8. Recount with `node scripts/timing-lint.ts --strict --summary` and replace this table.

Known limits: the lint reads text, not types. A wait passed through a helper's parameter (`pollUntil(h, ok, what)` with its
own `Date.now() + 6000` inside) is seen where the literal sits, not at the caller. Test timeouts are summed at factor 1; a
Playwright test whose `t()` waits grow with the factor against a timeout that does not is not caught. `--changed` flags
a hit when its own line changed (for `exceeds`: when any line of the test changed).
