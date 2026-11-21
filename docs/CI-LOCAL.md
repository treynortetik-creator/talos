# Local CI (`scripts/ci-local.sh`)

Pull requests and pushes to `main` are checked on your own Macs, not in GitHub Actions (`.github/workflows/ci.yml` is manual-only). `ci-local.sh` runs
the same jobs and posts each result as a commit status, `local-ci/<job>`. A second machine can run the same
script from a workflow:

```bash
scripts/ci-local.sh --pr 39                 # the PR's head commit
scripts/ci-local.sh --ref feat/x            # any branch, tag or sha
scripts/ci-local.sh --pr 39 --jobs check,browser --no-status
```

The script is in parts: `scripts/ci-local.sh` (the options, the run itself, and the results) sources, in place, the files in
`scripts/ci-local/`: `locks.sh` (locks, run records, statuses, reaping, slots, the suites mutex), `machine.sh` (sleep and wake,
slot environment, network git, time limits, the iOS simulator), `settle.sh` (a main push run waits for a quiet head before any slot:
docs/CI-MACHINES.md, "A main run waits for a quiet head"), and one file per job group: `jobs-check.sh`,
`jobs-mod-browser.sh`, `jobs-image.sh`, `jobs-swift.sh`. A copy of `ci-local.sh` needs the `ci-local/` folder beside it; without
it the script stops at once (exit 64). The desktop gate (`ci-desktop-gate.sh`) watches the folder as it watches the script. The parts are read before any wait, so a run keeps
the job code it started with; the helpers it runs later (`ci-affected.sh`, `ci-desktop-gate.sh`, `ci-flake-vitest.ts`,
`ci-swift-retry.sh`) are still read from the checkout when used, so **do not `git pull` into a checkout while a hand run of
`ci-local.sh` from it is waiting** (the runners are not exposed: one job each, in a workspace nothing changes meanwhile).

Options: `--jobs check,mod,browser,image,desktop,mobile` (default all, exactly the ones named), `--full` (no job is skipped, see "Running only what a change can affect"), `--latest` (also the advisory latest-CLI mod run),
`--no-status` (post nothing), `--keep` (keep the scratch worktree), `--reap` (stop and clean up after runs that died, then exit). `TALOS_CI_FORCE_DESKTOP=1` runs the desktop job even
when no desktop path changed (only a hand run needs it; `apps/desktop/scripts/review-d0-test.sh` uses it as its control; `ci-local.sh` keeps it out of every job's environment). A commit that is already on `origin/main` runs the desktop and mobile jobs with no flag at all, unless "Running only what a change can affect" shows the change cannot reach them. Logs: `~/.cache/talos-ci/logs/<sha>-<job>.log`, plus `<sha>-setup.log`. A rerun of the same commit moves the earlier ones to `logs/prev/<sha>-<job>.<time>.log` first. Exit 0 only if every
job passed.

## Running only what a change can affect

A run used to start all six jobs for every commit, so a one-line docs change waited for Swift. `scripts/ci-local.sh` now asks
`scripts/ci-affected.sh` which jobs the change can reach, runs those, and answers the others at once.

| What changed (all of it)                                                                                          | Jobs that run                 |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `apps/web`, `docs`, `CHANGELOG.md`                                                                                | check, browser (+ mod, image) |
| `apps/bridge`, `apps/relay`                                                                                       | check, browser (+ mod, image) |
| `apps/desktop` only                                                                                               | check, desktop (+ mod, image) |
| `apps/mobile` only                                                                                                | check, mobile (+ mod, image)  |
| `packages/protocol`, `packages/testkit`, `scripts/`, `pnpm-lock.yaml`, root config, or any path not in this table | all six                       |

Mobile does not read the web app: its `package.json` says the shell loads the relay origin and ships no web assets, and its tests do read `apps/web` (`apps/mobile/test/config.test.ts` reads `../../web/src`), which is harmless: the `check` job runs that test and is never skipped. `mod` and `image` are short (3 s and 15 to 30 s) and nothing here proves they can be dropped, so they always run. A change that
spans classes runs the union: web and desktop together run check, browser, desktop (+ mod, image). One unknown path anywhere in
the change runs all six: the default is more, never less. Desktop is whatever `ci-desktop-gate.sh` says (it is still the one list
of desktop paths; `ci-affected.sh` asks it, so there is no second gate). So two bridge files also run desktop, because desktop
tests read them: `apps/bridge/src/claude-env.ts` and `apps/bridge/test/fixtures/agent-instructions/worker.txt`. Renames count
both paths (`--no-renames`) and a deleted file is a change. Names are read NUL-separated, so spaces, quotes and newlines in a path are one path.

**The base, per job.** Each job is compared with the last commit where **that job** passed, not with the parent and not with
the last all-green commit: another job's red says nothing about this job's inputs, so main's overall colour does not matter. The
inner commits of a push get no status ("Pushing to main"), so a parent can be a commit nobody tested. `ci-affected.sh plan`
starts at the parent of a commit that is on `origin/main` (at the merge-base with `origin/main` for a PR) and walks the
first-parent line back, at most 30 commits, reading each commit's statuses once. Per job, the nearest commit with a result for
that job decides: a final pass (`passed on ...`, `passed on retry` included, which the verdict also counts green) is its base;
`pending`, `failure` or `error` there means no base, and **that job runs**: a skip can never hide the job's own red, or a result
not in yet. A commit where the job has no status, or was skipped, is walked past, and what it changed counts, because the diff is
taken to the base. The job then skips only if `affected_jobs` (the path table above, the one list) says the diff from its base
cannot reach it; `check`, `mod` and `image` are reached by every diff, so they always run. Nothing found in 30 commits: that job
runs. GitHub not readable (`gh` failing is not "no status", for the head or for any commit on the walk), no repository, a missing
script: all six. The statuses are read from GitHub, so the base can come from either machine.

**A rerun runs everything.** If the commit being tested already has any `local-ci/*`, `ci-part/*` or `report-ci/*` status
of an earlier run, whatever its state, the plan is all six and no base is looked for. The statuses of this workflow attempt
(`CI_ATTEMPT_URL`, or on the runner the same link made from `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`) are not an earlier run (docs/CI-MACHINES.md, "The rerun rule and this attempt"). The statuses are the sign of an earlier run, and that run may have failed a job this
commit's own change cannot reach: a skip proved against a base that has gone green since would post `success` over that
failure. This covers the GitHub re-run button and `scripts/ci-local.sh --ref <sha>`. A first run posts its `pending`
statuses only after the plan, so it never sees its own.

**What a skipped job says.** The job is not started (it takes no mutex and no slot time) and the run posts `success` with the
description `skipped: no <job> inputs changed since <sha>`, the commit where that job last passed, and nothing before it (no
`pending`). It is not "passed on": `verdict` lists it apart ("skipped, no affected files") and treats a commit with such skips as a
verdict, **only when the description is exactly those words, for that job, with a commit sha, and the job is not `check`** (the
older words `skipped: no affected files` count the same way). Every other skip text ("skipped (swift is not installed)",
"skipped (no desktop changes)") is still no verdict. A skip chain is honest by induction: each skip is proved against a commit
where that job really ran and passed, and every change since is in the diff.

**When nothing is skipped.** `--full`; `--jobs` (it names exactly what to run); `--no-status` (a skip is a posted status, and a
run that posts nothing has nowhere to say it); `TALOS_GUI_TESTS=1` or `TALOS_CI_FORCE_DESKTOP=1` (the GUI desktop tests read
`apps/web`: the companion harness imports `apps/web/src`, and a test reads `apps/web/src/theme/tokens.css`); a rerun of a commit
that already has `local-ci/*` statuses (above); and every `workflow_dispatch` of the runner (`ci-runner.sh run` adds `--full`):
a manual trigger is the full run; and the nightly (`schedule`, 09:17 UTC), which tests main's tip with `--full` (and runs the
bridge's security fuzz for 60 s, `TALOS_FUZZ_MS=60000`, instead of 8 s), in its own
concurrency group that never cancels or is cancelled by a push run. `gh workflow run "CI runner" -f ref=main` is one by hand. A
waiting `--full` run never takes over a non-full run's result for the same commit (`--full` is part of that key). Pushes and
pull requests skip. The job-level gates in `job_desktop` and `job_mobile` are unchanged and still apply to a job that runs.

**The install and kit tests inside `check`.** `scripts/root-install*.test.ts` (one suite in four files, so vitest runs them side
by side: 155 s as one file, 56 s split) and `scripts/kit-tests.test.ts` (every `kit/scripts/test-*.sh`) are most of the vitest
step. `kit/scripts/test-default-agent.sh` runs `self-test.sh` on a rendered agent folder, and `self-test.sh` runs 17 of those same
suites again; `kit-tests.test.ts` sets `TALOS_SELF_TEST_SUITES=skip` so they run once (that script: 216 s before, 13 s after),
except on a `--full` run, which sets `TALOS_KIT_FULL_SELF_TEST=1` and keeps the second run inside the rendered folder. Beyond
that, `ci-affected.sh kit` says whether the change can reach these tests at all, and `plan` reports it as its third line. They are
left out (`--exclude`) only when the plan has a green base and every changed path is under `apps/web`, `apps/relay`,
`apps/mobile`, `apps/desktop`, `docs`, `CHANGELOG.md` or `scripts/`, except their own files: `root-install*.ts`,
`kit-tests.test.ts`, `kit-run.ts` and `size-report.ts` (a test fails if they import a helper not on that list). `install.sh`,
`kit/`, `plugins/`, `apps/bridge` (the CLI they call), `packages/`, the lockfile, root config and any unlisted path run them. The
check job still posts its own result, and its log says they were skipped. Everything in "When nothing is skipped" runs them too.

The earlier audit (`docs/CI-AUDIT-2026-10-31.md`) declined to skip beyond desktop and mobile because a skip is the one change that
can turn a real failure green. This is the owner's call to take it; the red-base rule, the exact-words rule and the full-run
trigger are what keep it from doing that. Tests: `scripts/ci-affected.test.ts`.

## Inside a run

`docs/CI-AUDIT-2026-10-31.md` has the measurements behind this. A run used to be its jobs one after another: half of a
21-minute run was a job waiting for its turn, and most of the rest was two suites asleep.

1. **Setup, once:** `pnpm install` and `pnpm build`, if any job needs them. The jobs share one `node_modules` and one
   `apps/web/dist` + `apps/relay/dist`, so nothing writes to those once the jobs start. The Playwright suites get
   `SKIP_BUILD=1` and `E2E_SKIP_BUILD=1`. If setup fails, every job that needed it fails, with the reason in its log.
2. **Jobs:** `check`, `mod` and `image` start together. `desktop` then `mobile` (they share a SwiftPM cache and a build wants
   every core) wait for `check`'s quiet group. `browser` waits for `check`. Results post as they finish. One red job does not
   stop the others. A job that dies without a result is red.
3. **Inside `check`:** the personal-data scan, which only warns, then the quick gates (types, lint, and `pnpm notices:check`: THIRD_PARTY_NOTICES.md must match what setup's web build
   bundles), then the quiet group: the contract suite, then the bridge's
   `test/schedules/` files, `CI_SCHED_JOBS` at a time (a third of the cores, biggest file first). Then the loud group side by side: the other bridge files 4 at once and
   Vitest. Output of the loud group goes to `<log>.<step>` while it runs and into the job log, whole, with failed steps
   last so the reason is in the tail a failed job prints. Last comes the known-vulnerability audit (`pnpm audit --prod
   --audit-level high`), which also only warns, because an advisory or a registry outage says nothing about this commit's code.
   A step that warns adds a `warning:` line to the log, a `!` line to the run's output and "with warnings" to the job's status,
   which still counts as a pass. The one-day wait before pnpm picks a new package version stays in force.
4. **The `suites` mutex:** the quiet group, the loud group and each Swift job hold one of CI's slots (the first K of the lock's
   slots, `TALOS_CI_SLOTS`, default 2: see "Heavy slots" below), so the jobs of a run overlap, up to K at once (check's loud group
   beside the desktop job, say). The quiet group holds all K, so nothing else of CI runs beside it. Two Swift jobs still never
   overlap, whichever runs they are of: each takes the desktop mutex, and no slot, around its Swift steps (the desktop
   job around `ci.sh`, the mobile job around its Swift packages and Xcode steps; its typecheck and Vitest hold a slot of their
   own). A slot inside the mutex made the desktop job wait behind check's quiet group and loud suites (809 s became 2,233 s), and the
   Swift jobs need no slot of their own: the mutex already keeps them one at a time. Gates have the slots above CI's.
   The e2e suite and the web specs don't take the mutex, so they can still sit beside another run's suites.
5. **Inside `browser`:** `pnpm test:e2e` as ever (relay, web specs, e2e suite), with the e2e suite on `ci_e2e_workers` workers: a worker is a relay, a bridge and a Chromium (about 3 cores and 6 GB), so it is the smaller of cores × 0.3 and GB ÷ 6, between 1 and 8. That is 3 on a 10-core Mac, which also runs builders (what it always ran) and 5 on 18 cores and 128 GB. Each test starts its own relay on its own port inside its worker, and the relay's auth state is per process, so workers share nothing; `E2E_WORKERS` in the environment still wins.

### A job can't outlive its run

A run that ends any way at all answers for itself: every status it posted pending gets an answer (a job that never reported is
closed as `error`, "cancelled or interrupted; re-run", never left pending), the scratch worktree and temp dir go, and every lock
it holds goes, including a mutex a job took inside its own subshell. The same cleanup is done by the watchdog if the run is
killed outright, by a waiter that takes a lock from a dead run, by the start of the next run, and by `ci-local.sh --reap`. The
record `runs/<nonce>` holds what that needs (`owner`, `worktree`, `tmp`, `repo`, `posted`, `posted-contexts`, `reported/`), so
no one needs the dead run's memory. `posted` lists the bare job names (`local-ci/<job>`, `report-ci/fast`), which every
`ci-local.sh` reads the same way; the contexts under another prefix (`ci-part/*`, and `report-ci/<job>` other than `fast`)
are in `posted-contexts`, which an older `ci-local.sh` never opens. It would read every row of `posted` as a bare job and
close `ci-part/vitest` as `local-ci/ci-part/vitest`, an extra `local-ci/*` status that turns the verdict red. An older reaper
removes the record with `posted-contexts` unread, so those statuses are left to the workflow's sweep (`ci-runner.sh sweep`).

Each run has a record, `~/.cache/talos-ci/runs/<nonce>`: its job process groups, worktree, container and results. Results are per
run, not per slot, so an orphan has nowhere to write that a later run reads. Four things enforce it:

- **The run's own cleanup**, for a cancel or a normal end: INT to each job group (Playwright tears its web server down on INT
  only), then TERM, then KILL.
- **Anything still working inside the worktree is killed**, whatever its process group: that is how a detached server goes. The
  match is on the working directory, never a port, because the tests run this script under a fake `HOME` with the same ports
  as real slots.
- **A watchdog** in a group of its own does the same if the run is killed outright, within a second.
- **Whoever takes a lock from a dead run stops that run first**, using its record. So a slot, a port or a mutex can't be shared
  with what a dead run left behind, even inside that second. `run` also refuses new steps once the run is gone.

Workers per suite (the web specs keep Playwright's default, 5):

| Suite      | Workers                      | Set by                          | Measured alone                                              |
| ---------- | ---------------------------- | ------------------------------- | ----------------------------------------------------------- |
| Vitest     | 4                            | `CI_WORKERS` (40% of the cores) | 9 workers 82 s · 5: 96 s · 3: 157 s                         |
| `bun test` | 4 processes                  | `CI_WORKERS`                    | 1 process 435 s · 4: 132 s                                  |
| schedules  | 6 processes (cores ÷ 3)      | `CI_SCHED_JOBS`                 | 1 process 579 s · 4: 154 s · 6: 118 s · 8: 113 s (18 cores) |
| e2e suite  | 3 on 10 cores, 5 on 18 cores | `E2E_WORKERS`                   | 1 worker 500 s · 3: 248 s · 5: 187 s                        |

Don't run these side by side to save a few minutes without many real runs behind it. `check` and `browser` used to look like
the obvious thing to overlap, and a run did take 7 minutes, but tests with short real-time waits on real child processes
failed: 3 s for a frame or a Chronos answer, 5 s for an element. Each order below was tried on real runs, on a Mac that also
had other CI runs and agents' tests on it:

| Order                                                                  | Runs | Green | What failed                                                                             |
| ---------------------------------------------------------------------- | ---- | ----- | --------------------------------------------------------------------------------------- |
| Everything at once, 5 workers each                                     | 1    | 0     | contract, iPhone pinch, Vitest wizard; load 26                                          |
| e2e then web, beside all four `check` suites                           | 3    | 1     | contract; one more failed on a long temp path of mine                                   |
| Contract first, then three suites together, beside the browser job     | 2    | 1     | `session-runner.test.ts`                                                                |
| Contract, `bun test` with capture, then Vitest, beside the browser job | 3    | 1     | `session-runner.test.ts`, two 5 s bun timeouts                                          |
| Quiet group beside e2e, then loud group beside web                     | 4    | 0     | e2e 3 s wait, `session-runner.test.ts`, iPhone image viewer, contract                   |
| One sensitive suite at a time, `browser` after `check` (now)           | 4    | 1     | iPhone `settings-home.spec.ts` deep links (05af6f1, f6a794b), Help chunk test (13a6db6) |

The `(now)` counts are only the runs of this order that I could name: three red on an iPhone browser test (05af6f1 and f6a794b
on the settings-home deep-link test, 13a6db6 on the Help chunk test; `logs/timings.tsv` has the first two with one job failed)
and one green, main b13081b1, run 41456311587 on 2026-11-02, all six jobs: browser 871 s, check 432 s, desktop 554 s, image
28 s, mobile 50 s, mod 3 s. Other runs of the same day are in `timings.tsv`; they are not counted because the file does not
say which order each one used. An earlier six-job green is described under "What the runs showed" below.

Starting a process is what gets slow on a loaded Mac: the CPU can be half idle while the load reads 20 or more. If those short
waits are ever made robust, or agents stop running suites on this Mac at the same time, overlapping `check` and `browser` is
the next 6 minutes to win: the side-by-side code (`together`, `wait_for_job`) stays for that.

Every run ends with `ci-local: timing: waited Ns, setup Ns, jobs Ns` and adds a line to `logs/timings.tsv`: date, sha, slot,
jobs, waited, setup, jobs' wall time, failures, then each job that ran as `<job>=<wall>/<own steps>` seconds. A job's wall
time includes any wait for another job (browser waits for the whole of check), so its own steps are the wall time less that
wait; the result line says both (`✓ browser (984s: 457s of its own steps, 527s waiting for another job)`). Each step's time
is in the job log as `[step] <seconds> exit <code>: <command>`, so the next audit needs no detective work. Each job log
starts with the bun it runs (`bun: 1.4.4 (<path>)`), and the row ends with the run's bun (`bun=1.4.4`; older rows lack it).
On the runner that bun is a copy of the pinned one kept in the cache (`bun-bin/<version>/`, scripts/ci-runner.sh
`ci_bun_pinned`), never `~/.bun/bin/bun`, which an upgrade replaces in place while a run is going.

`apps/bridge/scripts/test-parallel.ts` is the `bun test` runner: one process per file, one result per file, green only if every
file exited 0 and reported at least one test. Its default test timeout is 20 s, not 5: that timeout only catches hangs, and
fired on tests that passed every assertion but ran slowly beside other files. Explicit timeouts, waits and assertions stay as
written. A file also has a wall-clock limit, 5 minutes (`--file-timeout <seconds>` or `BUN_TEST_FILE_TIMEOUT`): bun's test
timeout cannot stop a file stuck in one synchronous call, so past the limit the runner kills that file's process tree, reports
the file red and carries on; a file still alive 10 s after the kill is red as "did not die after SIGKILL" and left behind.
`--shard K/N` runs pile K of N: the files (after `--only` and `--skip`) sorted biggest first and dealt each to the lightest pile so far, the same piles on every machine, every file in exactly one (`docs/CI-MACHINES.md`). `scripts/test-parallel.test.ts` also asks `bun test` which files it would run and compares, so a file can't drop
out of CI unnoticed. `pnpm test:bun` is still the plain one.

## Before you push

The flow: work in a worktree, run the gate (below), rebase on `main`, push. Full CI then runs on the newest `main` (see
"Pushing to main" below). A conflict resolved by hand gets one check of the changed code, with no loop.

### The builder skill: `talos-build`

The rules every builder follows (worktrees, tests first, heavy work and group time limits, the gate, handoffs, review tiers,
what a landing note carries) are one Claude Code project skill, `.claude/skills/talos-build/SKILL.md`. A builder brief says
"load talos-build" instead of pasting them. Claude Code loads project skills from `.claude/skills/` in the folder it starts
in and each parent up to the repository root, so any builder started inside a checkout or worktree of this repository has
it, on every system:

- **macOS and Linux:** start Claude Code in the repository root (or any folder of a worktree).
- **Windows:** use WSL. Clone the repository inside the WSL file system, and start Claude Code there, in the repository root.

There is nothing to install: pulling `main` brings the newest copy. The skill's own version line and changelog say what changed.

### The gate: `scripts/gate.sh`

One gate for every machine and every builder. It **refuses** on any failure, and when it cannot run at all (no node or pnpm on
PATH, no `node_modules`, a `pnpm-lock.yaml` newer than `node_modules`, or no bun when bridge tests are needed): a gate that
cannot run is not a pass. In order, stopping at the first that fails:

1. **typecheck**: `pnpm typecheck`, the whole workspace.
2. **lint**: `biome check .`, the whole tree.
3. **personal**: `scripts/check-no-personal.sh` on the working tree, with the private list (`scripts/personal-denylist.txt`) from
   this checkout or the main checkout of the repository. When there is none it says so, and only the generic rules run.
4. **size**: the production file size budget (`scripts/size-budget.test.ts`).
5. **suites**: the tests of what changed since the base (by default the merge base with `origin/main`), uncommitted and
   untracked files included. A file in a Vitest project goes to `vitest related`, which runs the tests that import it. A bridge
   source file runs the bridge test files that import it by name; a changed bridge test file runs itself. A change to
   `packages/protocol` or `packages/testkit` runs the whole bridge suite. A shell or Python script runs the tests that name it, and any file under `kit/`, or a script anywhere, also runs the tests
   that list its folder: they scan `kit/` or `kit/scripts` with a glob, git ls-tree and the like (kit-tests, kit-pipefail,
   kit-source). Those are found by grep, so a new folder-scanning test is picked up without a list to keep. A folder counts
   when it is two or more levels deep (the file's own, or one above it); of the top-level folders only `kit`, which its tests
   read whole. Never `apps` or `scripts`, which tests name only to build paths. `--plan` prints on stderr which test was picked
   for which folder.
   A changed e2e spec (`e2e/tests/`) runs itself, and a change to what every spec runs on (the e2e harness, its config or
   package) runs them all: Playwright, one worker, Chromium. The gate refuses when Playwright or its Chromium isn't
   installed. A docs-only change runs no suite.

`--full` runs every Vitest project, the whole bridge suite and every e2e spec instead of the touched ones. `--base <ref>` measures the change
against another ref. `--plan` prints the steps and the suites' files and runs nothing. `scripts/gate.test.ts` checks the
mapping.

### The fast gate: `scripts/gate.sh --fast`

The pre-push gate, with CI as the safety net: CI runs every suite on `main` after the push, and a red goes to a fixer. Push
gates waited a median 19 minutes for the heavy lock behind CI, and any bridge change ran all of the bridge suite (bun has no
`related`). `--fast` runs the four checks, `vitest related`, and of the bridge tests only:

- the changed bridge test files;
- the test files whose own quoted relative paths name a changed `apps/bridge/src` or `apps/bridge/test` file (`'../src/x.ts'`
  in an import, an export from, a dynamic import, a require or a spawned path). Direct importers only, written with the
  extension, as every bridge import is;
- the guards that read a changed file (`// gate-reads:`). A test that opens a file it does not import (a doc test, a scan of
  `apps/bridge/src`, an installer test) marks what it reads with that line, so a change to the file plans the test. The fast
  gate also plans, for a changed test file, the tests that name it (a doc test cites the titles of other tests), and the core
  installer tests (`root-install`, `install-bughunt`, `uninstall-bughunt`, `kit-update`: about a minute) for any change to
  `install.sh`, `kit/` or `scripts/`.
  Whenever the root installer's test is planned, the plan has one more step, `corepack-install`
  (`scripts/corepack-install-tests.sh`, `pnpm test:corepack-install`): `root-install`, `install-bughunt` and `uninstall-bughunt`
  again with a corepack pnpm first on `PATH`, as a Mac set up by `SETUP.md` has it (shims in a temp folder made for the run, with
  `corepack enable --install-directory`; the machine's own corepack and `PATH` are untouched, and the folder is removed). A
  harness fault that only a corepack pnpm shows reached main (KIT-8, 2026-11-16), because no CI machine has one first on `PATH`.
  No corepack fails the step ("corepack missing"); it never skips. CI's check job runs it as its own step, after the suites
  (`step_corepack_install`, left out with the install tests when `KIT_SKIP` says nothing they run changed), and the macOS-only
  subset that Lemnos runs for check on Titan ends with it.

Its personal-data step scans this change only: the changed files as they are on disk and the messages of its commits
(`base..HEAD`), with the same rules, the private list included, so a hit refuses exactly as before. The full gate scans the
whole tree. A change to only **test files** is fast whatever folder they sit in: `*.test.ts`, `*.test.tsx`, `*.spec.ts` and
Swift files under a `Tests/` folder (regular files, still there, named by no gate-input line but `^scripts/`). The gate-inputs
rule and the keep-out list are for the code a test checks, not the test, so a `scripts/*.test.ts` or a guard's own test no
longer forces the full gate. A test helper that is not a test file (`scripts/root-install-harness.ts`,
`apps/bridge/test/helpers.ts`, a fixture) still counts as code; the protected paths and the 60-file limit apply as before. Every
fall back to the full gate adds one line to `~/.cache/talos-ci/logs/fast-fallbacks.tsv` (`TALOS_CI_CACHE`): UTC time, machine,
sha, the printed reason and the changed files that tripped it, so the keep-out list can be cut by evidence. It runs no e2e or old-client step, and of the browser specs only the **changed spec files** (`apps/web/test/**/*.spec.ts`, still there; never a feature's folder of specs or the smoke set, which CI runs), each on every Playwright project that takes it: desktop, iphone and pixel; `iphone-se` as well for `cards/permission-sheet.spec.ts` (`--plan` prints them on stderr as `web projects: <spec> -> <projects>`). A change to more than `WEB_SPECS_MAX` (40) specs is the full gate; a deleted spec runs nothing. A fast gate with such a spec **takes the heavy lock** (the light checks run first, outside it; the suites it chose run inside it) and refuses when Chromium or WebKit is not installed; one with none **takes no heavy lock**: the bridge files run through `test-parallel.ts
--files`, 2 at a time (`GATE_FAST_JOBS`). Why direct only: `src/bridge.ts` reaches 317 of the 321 bridge source files, and 283
of the 371 bridge test files reach `bridge.ts` (through `test/helpers.ts` and four harnesses). Following imports further picks
about 283 test files for almost any source change (measured 2026-11-14), which is most of the suite.

It runs the full gate instead, and says why, for a change to: the keep-out list (`scripts/gate-fast-keepout.txt`: the protocol,
anything named for a guard, the plugin's hooks, the relay's sign-in and bug inbox, the pairing path, lock files), anything in
`scripts/gate-inputs.txt` (the push path, CI, package and tsconfig files), anything in `docs/protected-paths.txt`; a deleted
bridge file; a bridge file that is not a module (data, fixtures); anything else the bridge tests read outside the scan (the
testkit, the Mac app, `kit/`, examples); a module the bridge test preload loads; or a selection over 60 bridge test files.
The three lists are read as the base has them, so a change never takes itself off them, and one missing or empty there
runs the full gate. Paths the scan does not see (a path joined from parts, `join(dir, 'src', 'cli.ts')`) are CI's. The node
second count makes the same choice and the same list, or the gate refuses. `--plan --fast` prints `fast` or
`full-gate: <why>` first. Both counts of these rules are in `scripts/gate-fast.sh`; `scripts/gate-fast.test.ts` covers
them.

### Pushing: `scripts/gate.sh --push`

The one way builders and sessions push (`scripts/gate-push.sh`; `--push [--full] [<remote> [<branch>]]`, default origin main).
It gates with `--fast` (above), which runs the full gate by itself where it must; `--full` asks for the full gate. Never
`git push --no-verify`. It refuses with a rebase in progress or uncommitted changes, then:

1. **Takes the push lease**, `refs/locks/push` on the remote: a parentless commit with an empty tree whose message names the
   machine (`$TALOS_MACHINE`, else `hostname -s`) and when the lease runs out (10 minutes). It is taken and renewed with
   `--force-with-lease`, so two machines cannot both hold it. A lease another machine holds is waited on (every 15 s, up to
   20 minutes, saying who holds it); one that ran out is taken over. It is let go at the end, and on Ctrl-C. The lease is
   advisory: a plain push ignores it. It is not a branch, so it starts no CI run. The pre-push hook lets a `refs/locks/*` push
   through only when it is such a lease: `refs/locks/push`, an empty parentless commit whose message is exactly the lease's
   five lines (the machine name is cut to letters, digits and `._-`), so nothing else can ride on it past the personal-data
   check.
2. **Fetches, rebases and runs the gate**, then records what passed in `.git/talos-gate.pass`: the tree, the base, the plan
   and the sha256 of `gate.sh` and `pre-push.sh`. The pre-push hook trusts that stamp, and does not run the gate again, only
   for exactly that tree, base, plan and gate version, within 30 minutes. Anything else runs the gate in the hook as usual.
3. **Pushes the gated commit**, by its sha: a commit made, or a tracked file changed, while the gate ran refuses the push.
   A push rejected because the branch moved is rebased and tried again, up to 3 times; a rebase that fails stops at once.
   When the new commits are words only (under `docs/`, or a Markdown file at the top), none of them is this change's, and
   this change runs no test suite at all (tests in every project read docs from disk), **only typecheck, lint, personal,
   size and timing run again** (`gate.sh --checks-only`). That is not the full gate: it relies on CI, which runs every suite on `main`
   after the merge. Anything else, or a diff that cannot be read, runs the whole touched set again.

While the gate runs, a background loop renews the lease every 4 minutes (over exactly the one it set). If another machine
took it meanwhile, it says so and stops, and nothing of the other machine's is touched. The loop stops after the gate and on
any exit, Ctrl-C included. A lease lasts at least 10 minutes, or twice this machine's last full gate (`.git/talos-gate.time`),
up to an hour. It is advisory: what keeps `main` right is the gate and the force-with-lease on the push itself.

### The pre-push hook

`pnpm install` turns on a pre-push hook (`.githooks/pre-push`, `scripts/pre-push.sh`) for the repo and every worktree of it. It
fails closed; there is no warning-only mode. Run by a hook, not a doc, because agents skip steps. It does two things:

1. **The personal-data check of what is being pushed.** Every commit in the range: the files it changes, read from the commit,
   not the working tree, and its message. Commits already on the main of the remote being pushed to (`<remote>/main`) are not
   counted, so a push to a fork has not got origin's. For a merge, only the files that differ from every parent are read. So a
   value a later commit removes, an edit or a deletion on disk, or a push of another branch cannot hide it. When the hook cannot
   tell where the push starts, it reads the whole tree of the tip. Every commit is read, however many. Files go to the scanner
   in numbered folders, so two paths that differ only by case are each scanned on a disk that ignores case, and a pushed file
   named `.commit-message` cannot replace the message. The private list and the list of private documents,
   `scripts/private-docs.txt`, are gitignored and exist only in the owner's main checkout. The hook looks for them there when it
   runs in a worktree, and says so when there are none. A hit, or a missing `check-no-personal.sh`, refuses the push.
2. **The gate**, measured from where the push starts. The gate reads files on disk, so they must be the ones being pushed:
   uncommitted edits to the pushed files, or another branch checked out, refuse the push. When the hook cannot tell what the push
   contains (no `<remote>/main`, a new branch from nowhere), it runs `gate.sh --full`. Otherwise it runs the fast gate
   (`gate.sh --fast`, which falls back to the full gate where it must, and prints which gate ran and why), measured from the
   remote's old tip, or for a new branch from its merge base with `<remote>/main`. A hook takes no flags: `GATE_FULL=1 git push`
   runs the full gate, and `gate.sh --push --full` sets it for the push it makes.

**The `Verified:` trailer (observe mode).** Beside those two, `scripts/verified-trailer.sh` looks at each commit being pushed
(merges skipped, commits already on the remote's main not counted) for a `Verified:` trailer: what was driven and where the
evidence is, or `Verified: none - <reason>` (the verify skill, `.claude/skills/verify/SKILL.md`). `TALOS_VERIFIED_TRAILER` (or
`git config talos.verifiedTrailer`) is `off`, `observe` or `enforce`; the default is **observe**: one line per commit lacking it,
to stderr and to `<git common dir>/talos-verified-trailer.log` (`TALOS_VERIFIED_LOG` moves it), and it never refuses a push,
even when git errors inside the check. `enforce` refuses a push with a commit lacking it (or one that cannot be listed); it is
written and tested, and not switched on: the owner decides when.
It looks at the newest 20 commits of each pushed ref only (`TALOS_VERIFIED_MAX`), so a new branch with no remote main or a force push stays quick; it names at most 3 commits, then a count, and keeps its log to a few hundred lines.

`git push --no-verify` skips the hook; that is the owner's own override, never a builder's. `git config talos.nohooks true` keeps
it off for good; `TALOS_NO_HOOKS=1 pnpm install` is for one install. CI's scratch worktrees never install it, and neither does a
repo with hooks of its own in `.git/hooks`, because `core.hooksPath` would stop them.

## The personal-data scan

`pnpm check:personal` (`scripts/check-no-personal.sh`) looks for names, emails, chat ids and machine paths that do not belong in a
repository. It matches bytes (the C locale), whatever the caller's locale, so a Latin-1 line can't slip past. Each rule is
rewritten into bytes first: a non-ASCII letter in a case-insensitive rule matches both its cases, and `.` or a negated set
matches a whole non-ASCII character. A rule with a non-ASCII bracket set is refused (exit 2, naming its line); write those
letters as an alternation. The pre-push hook and the gate stop on a hit. Elsewhere it still warns by default: in the `check` job, in the cloud
workflow, and for `/Users/` paths in `apps/desktop/scripts/guards-test.sh`. To make those a hard stop too:

1. Run `bash scripts/check-no-personal.sh <path>` on the tree you want to check. It must exit 0. It loads the generic rules in
   `scripts/denylist.generic.txt`, plus any extra rules file named in `CHECK_EXTRA_RULES`.
2. `apps/desktop/scripts/guards-test.sh` must print no `warn` line.
3. Change the personal-data `warn_step` in `scripts/ci-local.sh` back to `run`, take `continue-on-error` off that step in
   `.github/workflows/ci.yml`, and change the `/Users/` guard in `apps/desktop/scripts/guards-test.sh` from `warn` back to `bad`.

### The personal-data watch

The private list (`scripts/personal-denylist.txt`) lives on one Mac only, so a push from any other machine passes the generic
rules alone. The watch closes that gap within minutes instead of at the next gate on that Mac.

- `scripts/check-ref-personal.sh <ref> [<base>]` checks every commit in base..ref, all parents, one at a time: the files the
  commit changed as committed, the list of its changed paths as text, and its message (not who made it: author, committer and
  tagger are not checked, the owner's ruling). A value added and removed again in one push, or inside a branch merged with
  `--no-ff`, is still found. The base defaults to the merge-base with main, or the commit's
  parent when it is already on main (so a merge brings in what it merged). `--tree <ref>` checks every file and path of one tree.
  Nothing is skipped: `node_modules`, lockfiles, PDFs and binaries are read (`check-no-personal.sh` with `CHECK_ALL_FILES=1`),
  UTF-16 text is converted first, a link is read as its link text and never followed, a name that is not UTF-8 is checked under
  a `%XX` name (so are `:`, `%` and control characters in any name, so a printed `path:line` is never cut wrong; a name part
  that escaping pushes past 200 bytes is written under a short hashed name and still shown escaped), a path that is
  absolute or has a `..` part refuses the commit (a `note:` and exit 2), and a file named like the private list is a hit by its name. The generic list alone keeps its
  old exclusions (its email and phone shapes match byte noise in images and lockfiles); the private list reads everything. A submodule entry prints a `note:` line. The files
  are copied out of git into a temp folder that is removed on exit; no worktree, index or ref is touched. The rules are the
  generic list, the private list found the way the gate finds it, and `CHECK_EXTRA_RULES`. One line per hit:
  `<sha12> <path>:<line> [<rule file> rule line N]`; a path that itself hits shows as `<path hidden #N>@<sha12>`. Exit 0 clean,
  1 hits, 2 an error.
- `scripts/personal-watch.sh --rules <main checkout>/scripts/personal-denylist.txt` fetches branches and tags every 120 s
  (`--interval`) into a bare cache clone of its own (`~/.cache/talos-personal-watch/repo`, `--home` to move it). It checks each
  new first-parent commit on main and each new or moved branch or tag (`handoff/*` included; an annotated tag's message too),
  and every ref's name as text. A hit prints one `personal-watch: HIT <kind>@<sha12> <sha12> <path>:<line> [<rule>]` line
  (`main`, `branch` or `tag`) and is appended to `hits.log`, once per ref, commit, path and line. No ref name is printed or
  stored: the state files key refs by a hash. Neither is git's own error text (it can carry the remote's address); it stays in
  `fetch.err` and `clone.err` beside the cache, readable by the owner only (the watch runs with `umask 077`).
- Failures are loud. Without the private list it refuses to start. A fetch that fails, or runs past 120 s
  (`PERSONAL_WATCH_FETCH_TIMEOUT`, killed with its whole process group), prints an `ERROR` line and runs again next pass. A main
  commit whose check fails (the `ERROR` line gives the checker's own value-free reason, never git's text) goes on an unchecked
  list: the watch moves on to later commits and tries it again every pass, saying
  so at most every 10 minutes (`PERSONAL_WATCH_ERROR_EVERY`) but always again. `--once` runs one pass (exit 0 clean, 1 a new hit,
  2 an error or a commit still unchecked).
- One watch per cache folder: a lock is taken with `mkdir`, and is stale only when its pid is gone, or when it has no pid and is
  older than 10 minutes. The first pass records the refs already there (`--scan-existing` checks them too). SIGTERM stops it
  cleanly.
- `--scan-main` checks every file and path of the current main tree once and prints the hits and a count (`main@<sha12>: 0
  hit(s)`; exit 0 only when main is clean). It works beside a running watch, on main as last fetched.
- Start it on the Mac that holds the list, from its main checkout:
  `bash scripts/personal-watch.sh --rules "$PWD/scripts/personal-denylist.txt"`, then relay its stdout (a Monitor or a
  `tail -f` of `hits.log`). Neither script prints the matched text: open the named rule line to see what it looks for.

## Several runs at once

| Setting               | Default                | Meaning                                                                                                                                                                     |
| --------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CI_SLOTS`            | 3                      | Runs that may go at once. Extra runs queue.                                                                                                                                 |
| `CI_MAX_LOAD`         | 14                     | A new run waits while the 5-minute load average is above this. `0` turns the check off.                                                                                     |
| `CI_LOCK_TIMEOUT`     | 3600                   | Seconds a run waits for a slot (or a job waits for a mutex) before giving up.                                                                                               |
| `TALOS_CI_PW_PORT`    | 4873                   | Slot 1's Playwright port; slot N uses this + 10·(N−1). Not usable by hand, see below.                                                                                       |
| `TALOS_CI_IMAGE_PORT` | 18080                  | Slot 1's image-test port base; slot N uses this + 100·(N−1).                                                                                                                |
| `TALOS_CI_CACHE`      | `~/.cache/talos-ci`    | Locks, logs and caches. A different one gives a separate set of slots, to try a change to this script beside real runs. The script unsets these three before any test runs. |
| `CI_WORKERS`          | 4                      | Workers per big suite, see above.                                                                                                                                           |
| `CI_REPO`             | from `gh repo view`    | `owner/name` to post statuses to; set, `gh repo view` is not called. The runner sets it.                                                                                    |
| `CI_STATUS_WHERE`     | the machine's own name | What a status says it ran on ("passed on ci-runner in 41s"); see "Reading statuses from two machines".                                                                      |
| `CI_STATUS_URL`       | none                   | Link on every status (`target_url`). The runner sets it to its workflow run.                                                                                                |
| `CI_SHA_FILE`         | none                   | The commit actually tested is written here once the run has its slot.                                                                                                       |
| `CI_WT_BASE`          | `$TMPDIR`              | Where scratch worktrees go. The runner sets it to its cache, because `$TMPDIR` there is wiped between jobs.                                                                 |
| `CI_SLEEP_GUARD`      | off                    | `1` fails a job the Mac slept through instead of warning (below).                                                                                                           |

**The slot Playwright ports are off limits for a run by hand.** A slot binds its port (`PW_PORT`, `vite preview --strictPort`) when its browser job starts, so a hand run holding `PW_PORT=4873` made that job fail. `apps/web/playwright.config.ts` now stops at load with a message when `PW_PORT` is one of the slot ports (the base, `TALOS_CI_PW_PORT` or 4873, plus 10 per slot, for 6 slots or `CI_SLOTS` if that is more), unless `ci-local.sh` marked the run by exporting `TALOS_CI_SLOT_RUN=1` beside `PW_PORT`. Leave `PW_PORT` unset (4173) or use a port outside the list. The numbers are the three `CI_PW_PORT_*` lines at the top of `ci-local.sh`; the config reads them from there, so there is one copy. The e2e suite and the relay specs take OS-assigned ports (49152 and up) and cannot land on a slot port. What the check does not stop: anything that binds a slot port without going through that config, such as a hand `vite preview --port 4873`, or Verdaccio, whose default port is 4873. Test: `scripts/ci-pw-port.test.ts`.

Two runs at once is the normal case now; the third slot is rarely used (`docs/CI-AUDIT-2026-10-31.md`), and `CI_MAX_LOAD`
holds it back on a busy machine, which is what you want: two runs at once already use the 10 cores.

Each run holds one slot, `~/.cache/talos-ci/locks/slot-N`, and gets its own:

- scratch worktree (your checkout is never touched) and temp dir (`~/.cache/talos-ci/tmp/talos-ci-sN`, emptied at the
  start and removed at the end; every job runs with `TMPDIR` pointing at it, `check` and `browser` at a folder of their
  own inside it). It is under `$HOME`, like the slot's lock,
  and never under the shared `$TMPDIR`: a run with another `HOME` (the tests run this script with a fake one, in any
  checkout) has other locks, so it must not be able to name this directory;
- Playwright port `PW_PORT` for the web specs' `vite preview` server (`pnpm test:e2e` in `apps/web`, PR #49): 4873, 4883,
  4893, …;
- image-test host port, in a range of its own (slot N: 18080 + 100·(N−1) + 0..99), container name
  `talos-ci-sN-<sha>-<pid>` and image tag `talos-relay:ci-<sha>-sN`;
- npm cache for the throwaway Claude Code CLI in the mod job (`~/.cache/talos-ci/npm-sN`).

Everything else that listens already picks a free port: the e2e suite (`e2e/`), the relay specs and the Vitest fakes use
port 0.

Some steps use something there is only one of per Mac. Those hold a mutex, `~/.cache/talos-ci/locks/mutex-<name>`, for
that step only, and the rest of the run goes on in parallel:

| Mutex                | Step                                 | Why it can't be split                       |
| -------------------- | ------------------------------------ | ------------------------------------------- |
| `desktop`            | all of `apps/desktop/scripts/ci.sh`  | shared SwiftPM scratch + cache, GUI session |
| `playwright-install` | `playwright install chromium webkit` | one shared browser download folder          |
| `docker`             | starting Docker (`colima start`)     | one Docker VM                               |

### The heavy lock and its guard

The `suites` mutex is also the machine's heavy-work lock for everything outside a CI run: `scripts/heavy-lock.sh run
<name> -- <cmd>` queues the gate's suites, the desktop Swift suites, stress loops and evals on it (`heavy-lock.sh status`
shows each slot's holder and the queue, in the order it goes, each waiter with its kind). It is **N slots wide**, so N heavy
holds run at once. Who goes next, with one slot: CI's suites first (a ci-local
slot's ticket, kind `ci`), then everything else, first come first served within each; with more, CI has its own slot ("Heavy
slots" below) and the rest go in turn in theirs; a holder is never stopped for anyone. A
push gate (the gate `gate-push.sh` runs; kind `push`) and a builder's own `heavy-lock.sh run` (a whole suite, `cpu-burn.sh`, a
stress loop; kind `run`) never go before CI, however long they wait; the same holds for the desktop mutex. The one exception
is a `jump` ticket: a checked `gate.sh --push --red-main` gate.

A gate's wait behind CI is bounded by CI's arrivals: CI comes from pushes (to `main`, PRs), reruns and the nightly, and a push
needs a gate, so gates that wait trigger no more CI and the oldest goes once CI already queued is done. `HEAVY_LOCK_TIMEOUT`
(default 3600 s) caps a wait for anything but a push: the waiter then refuses, saying it could not get the heavy lock (exit
75). **A push gate (`HEAVY_LOCK_PUSH`, set by `gate-push.sh`) waits up to 14400 s (four hours)** and keeps its place in the queue: a
push that waited behind a long queue and then timed out at an hour threw away its gate and its rebase. An explicit `HEAVY_LOCK_TIMEOUT`
still applies to it, and an explicit `0` means no limit for anyone. During a changeover a waiter on the old lock code may still let a late push gate go first. (A
30-minute cap that let a waiting push gate go before CI was removed: four late gates in a row once left `main` with no verdict
for 2 h.) A ticket is CI only by its kind line, which only ci-local writes; a `heavy-lock.sh run` named `slot 1` is not CI.

**Heavy slots.** The number of slots is `TALOS_HEAVY_SLOTS` in the environment, else the first line of
`~/.cache/talos-ci/heavy-slots` (or `$TALOS_CI_CACHE/heavy-slots`), else **4**; `1` is the one-lock behaviour exactly, and 8 is
the most. The file is machine-local, so changing the number needs no code change and no restart: a waiter reads it on each
look (a holder keeps the slot it has). **The first K slots are CI's** (`TALOS_CI_SLOTS`, else the first line of `~/.cache/talos-ci/ci-slots`, else **2**, never more
than N - 1). Slot 1 **is** `locks/mutex-suites`. A ci-local job takes one of slots 1..K and no other, so **CI never waits behind a
gate** for a slot (a gate runs 30 to 60 minutes, and "CI first" only orders who waits: it cannot take the lock from a gate already running;
on 2026-11-16 CI's waits for the lock averaged 1,039 s), and the jobs of one run **overlap**, up to K at once: they used to take
the one slot after another (a job once waited 1,629 s at a load of 4 to 7 on 18 cores). Each CI hold has its slot's own
`PW_PORT` (4973 + 10 * (slot - 1), `TALOS_CI_HOLD_PW_PORT` moves it: a range of its own, never the builders' 4173 and up nor the
run slots' 4873 and up), tmux socket prefix and `TALOS_HEAVY_SLOT`, as a gate's slot does (its temp folder is its job's own,
`job_tmp`), and the environment is put back when it ends. A gate, a loop or an eval (`heavy-lock.sh run`) takes slots K+1..N (`locks/mutex-suites-<k>`),
the first free one. By default that is CI's two and two for builders, so at most two gates run beside CI (while a run is active
the cap is two whatever N is). Each class has its own line: CI's jobs in turn (slots 1..K), the gates in turn (a checked
`--red-main` jump first, then first come first served), and a waiter of one class never holds back the other. With **one slot** everyone shares it, CI first, as it always did. A dead holder in any slot is taken over
like slot 1's. **During the rollout** a checkout whose scripts are older still runs its gate in `mutex-suites`, i.e. slot 1,
and CI waits for it as before; that goes away as worktrees rebase. **CI's quiet group** (the contract and schedules suites, which give a real bridge and the real Chronos CLI 3 s to answer and
failed beside anything else) **holds all K of CI's slots** (`ci_mutex_all`: it takes the slots as it finds them free, but only
while it is first in line among CI, never through the free-slot grace, or two runs' quiet groups could hold one slot each and wait
for each other's until the timeout; it runs when it has them all), so no other CI job runs beside it, and **no new gate hold starts while it runs** (a gate that waits keeps its place; gates that run already
finish); its end is a row in `~/.cache/talos-ci/logs/quiet-group.tsv` (UTC time, commit, pass or fail, seconds, files that failed
and passed on retry, gate slots busy at its start and at its end), to read what the gates cost it. `TALOS_HEAVY_SLOTS=1` in one
process's environment, while the machine's file or the default says 4, puts that process in CI's slot 1 and out of the rule: it
shares the slot with CI, the old way. The desktop mutex (`heavy-lock.sh desktop`, `locks/mutex-desktop`) stays one:
Swift desktop suites never run two at a time. No gate holds it (`gate.sh` runs no Swift suite); a builder's own
`apps/desktop/scripts/test.sh` or `ci.sh` does, for as long as it runs, and CI's desktop job waits behind that, CI first among
the waiters. Titan's shared flock (`CI_SHARED_LOCK`) still serialises across the distros; set
`TALOS_HEAVY_SLOTS=1` there.

**Gate and CI take turns (one Mac).** The slots above keep CI's holds and a gate's apart, but the two ran at the same time on
purpose, and CI's runs do more than hold a slot (install, build, the e2e and web specs, the image job take no slot), so a run that
started in the middle of a gate pushed the load to 40 to 60 and failed the gate's timing-sensitive tests. Now, with two slots or more,
**a gate's hold (anything `heavy-lock.sh run`: the gate's suites, a loop, an eval) and an admitted CI run never overlap**. Two
classes take turns: _CI_ is a whole `ci-local.sh` run, from the moment it has a run slot (`locks/slot-N`) to the end of its cleanup;
_gate_ is a hold of one of the gate slots (K+1..N). Nobody is stopped: a class that is on waits for the other to finish what it has.

- **Who may start.** A new CI run (before `ci_acquire_slot` takes a run slot) and a new gate hold (before `ci_mutex` takes a gate
  slot) each ask `ci_turn_ok`, which holds a short lock (`locks/mutex-turn`, taken with `ci_lock_try`, a dead holder is taken over
  as any lock) while it looks and while the caller takes its slot, so the look and the take are one step. The answer is no while a
  living holder of the other class exists (a run slot, or a gate slot), and no while a waiter of the other class that came
  earlier is queued (a CI run waits in `locks.queue/admit`, a gate in `locks.queue/suites` as before; tickets sort by arrival, a
  `jump` gate goes before CI waiters but still waits for the runs that are on). So the order is first come, first served across the two classes, and
  a class that is on lets newcomers join it only while no older waiter of the other class is queued: a gate that arrives while
  CI is on is not starved by CI runs that arrive after it, and CI queued behind a gate is not starved by gates that arrive after it.
- **What is never held up.** A run already admitted goes on whatever waits: its own holds of CI's slots, its jobs, its cleanup
  (stopping it for a waiting gate would throw away its verdict, and holding its inner holds back would deadlock). Nested calls
  (`TALOS_CI_NESTED`, a run inside a holder) pass straight through, as they do for the locks.
- **Bounded, and said.** A waiter's line names who it waits for (the runs or gates that hold the machine, with pid, what and
  since when, or the older waiters) and is said again every five minutes with the time so far. A gate's wait counts in its
  `HEAVY_LOCK_TIMEOUT` (a push gate four hours) and ends in exit 75 as any lock wait: a gate fails closed. A CI run **fails open**:
  after `CI_TURN_MAX_S` (3000 s) it goes ahead beside the gate, with a loud line in its log and an alert ("ran beside a gate after N
  min"), because an untested main commit is worse than a noisy run; its waits for a run slot keep `CI_LOCK_TIMEOUT`, which does not run while it waits for its turn. The runner's run step
  has 120 minutes: keep `CI_TURN_MAX_S` plus a normal run well inside it, and the line "ran beside a gate" is said when the run's slot is
  taken, not before. A run that waits for load (`CI_MAX_LOAD`) keeps its place in the queue, so gates queued after it go behind it until it
  runs or gives up at `CI_LOCK_TIMEOUT`; a run counts from the moment it holds a run slot, including an idle wait for another run of the
  same commit. After `TALOS_TURN_ALERT_S` (1200 s) of waiting ONE alert file goes to `alerts/` (what waits, for whom, how long). Each
  wait of 1 s or more is a row of `logs/lock-waits.tsv` (kind `turn`), and `heavy-lock.sh status` shows who holds the machine and who waits.
- **A holder that is gone.** A run slot or a gate slot whose owner process is gone counts for nothing (the same check every lock
  makes): a crashed gate never holds CI back, nor a crashed run a gate.
- **Off switch.** `CI_TURN=0` in the environment or a `turn-off` file in the cache gives the old behaviour (read on every look, by a CI run that already waits too).
  With one heavy slot everyone already shares it, so none of this applies. A copy of the scripts from before this change
  (a worktree not yet rebased) does not look; it still sees the run slots and gate slots, so a new gate waits for its CI, but an
  old gate or an old CI run may still start beside the other, as before, until it has the new scripts.
- **Not covered.** The gate's light steps (typecheck, lint, personal, size), which run outside the heavy lock, and the desktop
  mutex (a builder's own Swift suite): both stay as they are.

Each slot's command is given its own copies of everything the suites share, all from `TALOS_HEAVY_SLOT=<k>`:

| What                     | Slot k                                                                                       | Where it is used                           |
| ------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `PW_PORT`                | 4173 + 10 * (k - 1) (`TALOS_HEAVY_PW_PORT` moves the base)                                   | the web specs' `vite preview` server       |
| `TALOS_TEST_TMUX_PREFIX` | `talos-test-s<k>`; every tmux `-L` a test makes starts with it; never `talos`                | the bridge tests that run a real tmux      |
| `TMPDIR`                 | `<cache>/tmp/talos-hv-s<k>` (`TALOS_HEAVY_TMP` moves the base), with more than one slot only | every `mkdtemp`, the run folders, hub.sock |

Playwright starts its web server in a process group of its own, so killing a stopped holder's group does not reach it, and an
orphan keeps the slot's port. A stopped holder is therefore asked to stop with INT first (what Playwright tears its server down
on), then TERM, then KILL; and a hold stops an orphaned `vite preview` on its slot's port, at its start and at its end. The tree is `sh -c "vite build
&& pnpm exec vite preview"`, then pnpm, then node, and when the run goes only that shell (the group's leader) is re-parented to pid 1,
so an orphan is told by its **group's leader** (gone, or with pid 1 for parent), and only when its command is `vite preview` with
`--port <the slot's port>` whole and its working folder is in a Talos checkout (this repository's worktrees): another project's
preview is never stopped. A server whose run lives (a run by hand on 4173) is never touched: the hold says on stderr who has the port, and the
gate's web specs step refuses, naming the pid, instead of a spec failing on a port that is taken.

The folder is emptied when the hold starts and removed when it ends (or by the waiter that takes the slot from a dead holder).
CI's own slots keep their own ports (`ci_slot_env`: 4873 and up) and `talos-ci-s<n>` folders, which a heavy slot never uses, and a
CI run's suites keep CI's (a ci-local job gets none of this). The first gate slot is 2, so a gate's preview port is 4183 and up;
with one slot it is 4173, the port a plain run uses, and `TMPDIR` is untouched. The relay, bridge hub and e2e harness servers bind port 0 and have no fixed port. Check pty headroom before raising
`TALOS_HEAVY_SLOTS`: `sysctl kern.tty.ptmx_max` (511 here) against the peak one gate uses (`ls /dev/ttys* | wc -l` while it runs).

A waiter that is not first in line still takes the lock once it has sat free, with no living holder, for `CI_DEFER_GRACE`
seconds (default 15): a waiter running other lock code (main's old first come first served during a changeover, or a branch's
gate) can then never leave the lock free with both waiting. Every wait of 1 s or more is a row in
`~/.cache/talos-ci/logs/lock-waits.tsv` (UTC time, lock, what, seconds, `got` or `timed out`, kind: `ci`, `push` or `run`).

**One heavy lock across WSL distros (Titan).** Titan's Ubuntu (gates, the whole-suite runs other machines ask for) and talos-ci
(the runner) share one VM but each has its own `~/.cache/talos-ci` and its own PID namespace, so neither side's mutex can see
the other's holder. `CI_SHARED_LOCK=/mnt/wsl/talos-ci-suites.lock` (`/mnt/wsl` is one tmpfs for every distro), set in the
runner's `.env` and in the gate's environment, adds a kernel flock on that file around the `suites` mutex's command, so a heavy
run on one side waits for the other. The kernel frees it with its holder; the command runs without the lock's fd, so a server a
test leaves behind never keeps it; a holder's descendants (`TALOS_SHARED_LOCK_HELD`) pass straight through. Titan's
`browser-e2e` part takes the `suites` mutex around its tests for this. Unset (every other machine): nothing changes.

Load testing (N runs under a CPU burner, for flake hunting) goes through `scripts/cpu-burn.sh [--cores N] [--seconds S] --
<cmd>` and nothing else: it takes the heavy lock itself (or refuses with exit 75 and never burns), caps the run at 600 s,
and stops every burner on its way out. A burner started by hand outside the lock saturates a CI run beside it.

Before a heavy job takes the lock, `scripts/heavy-guard.sh` may hold it back for memory, load or a booked window. **It is
off until a machine turns it on**: with no `~/.cache/talos-ci/guard/guard.env` (or `TALOS_CI_CACHE/guard/guard.env`) it
answers go without looking at anything, and each check is off until its own setting exists:

| Setting                    | Turns on                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `HEAVY_GUARD_MIN_FREE_PCT` | the memory floor: not now when free memory is below this percentage (40 suits a 32 GB Mac)  |
| `HEAVY_GUARD_MAX_LOAD`     | the load limit on the 1-minute load. No default, and only for machines that are not runners |
| `HEAVY_GUARD_BOOKINGS=1`   | booked windows (`book`)                                                                     |

`heavy-guard.sh init --min-free-pct 40 --bookings` writes guard.env (KEY=value lines, read without being run);
`heavy-guard.sh off --yes` removes it; `HEAVY_GUARD_OFF=1` switches it off for one call. The environment wins over
guard.env. Three ways to use it:

1. **The hook.** `heavy-lock.sh` calls it with the job's name before the job starts (`TALOS_HEAVY_GUARD` names another
   guard; ci-local's lock tells it which cache the lock lives in). **One argument is always a job name**, whatever the
   word, except `status`, `--help` and `-h`: a job called `off` or `init` is checked like any other job and changes
   nothing, which is why turning the guard off takes `off --yes` and `init` takes at least one flag. The name is data
   only, cut to 80 characters with control characters removed. Exit 0 is go; exit 75 is not now: the job keeps its place
   in the queue, does not hold the lock, prints the guard's one-line reason ("not now: memory is tight (31% free, needs
   40%)") and asks again. The memory floor always applies. The load limit never refuses the lock's own work: it is not
   checked while the lock is held, nor for `HEAVY_GUARD_LOAD_SETTLE_S` seconds (300) after the lock last changed hands
   (one CI run takes it several times in a row, and the load between two holds is still its own), so it only decides
   whether a new job may start on a lock that has been idle a while. **A load limit is for machines that are not CI
   runners**: a runner's own runs sit far above any per-core number. On a machine whose heavy jobs start less than the
   settle time apart, the load limit never applies at all. `status` says whether it is live right now or skipped, and why.
2. **`ask` for work that is not a Talos job** (a local model, a video encode): `heavy-guard.sh ask <gb> [who]` answers 0
   when free memory after taking `<gb>` GB stays at or above the floor, the load is under the limit and nobody else has
   booked now.
3. **`book` for a window**: `heavy-guard.sh book <who> 14:00 16:00 model eval` (or `YYYY-MM-DDTHH:MM`) holds every other
   heavy job back in that window; a job or an `ask` under the booker's own name still runs. A window is at most 12 hours,
   starts at most 48 hours ahead and never overlaps someone else's; one name holds at most 12 hours in all, and the file
   at most 20 bookings. `unbook <who> [<from>]` removes a booking; `unbook --all --yes` removes the file and its lock
   without taking the lock, so it works whatever state they are in. Bookings live in `guard/bookings.tsv` beside the
   lock, never in the repo; a row `book` could not have written (hand-edited, damaged) is ignored, and so is any row that
   starts more than 48 hours after the file was last written, or past its first 20 rows. So a file stops holding jobs back
   at most 60 hours after its last write, whatever it holds. `who` is whatever the caller says; this is a courtesy queue
   between cooperating sessions, not access control.

`heavy-guard.sh status` shows memory, load, swap, the bookings, the lock's holder and queue, the last refusal and why, and
possible strays: heavy-looking processes (tests, builds, local models) older than `HEAVY_GUARD_STRAY_MIN` minutes (30) that
are not the lock holder's, never the live `tmux -L talos` server. It prints the first 100 characters of each stray's command
line, which can include its arguments. **The guard lists and refuses; it never stops, signals or reprioritises anyone's
process.** Stopping a job is its owner's act, by pid; the one signal the guard sends goes to its own probe when that probe
outlives its deadline (3 s each, the whole hook within about 5 s; status 5 s each, 15 s in all). A probe, setting or file it
cannot read, or a probe that runs out of time, switches that check off, so a broken guard never blocks: it can only say not
now from a number it actually read. The probe overrides its tests use (`HEAVY_GUARD_FREE_PCT`, `HEAVY_GUARD_NOW` and the
like) count only with `HEAVY_GUARD_TEST=1`, and `status` marks each reading they supply.

### The window-opening desktop tests

About 270 desktop tests open real windows (`apps/desktop/Tests/TalosDesktopGuiTests`) and run only with `TALOS_GUI_TESTS=1` in a
logged-in session. The runner does not set it, so they are not in the default run. Set it and `ci.sh` runs each suite in its own
process through `apps/desktop/scripts/gui-tests.sh`, which fails a process that exits 0 without printing Swift Testing's summary
(AppKit has ended a whole test process early that way) and one that matched no tests. `gui-tests-test.sh` checks that gate in every
run, with a stand-in runner and no windows.

## Pieces for the split over machines (docs/CI-MACHINES.md, phase A)

`ci-local.sh` now has the pieces `docs/CI-MACHINES.md` builds on. **With none of these set, a run is today's run**; the workflow
that sets them comes with phase A step 4.

- `CI_SHARD_TOOLS` (from the plan, e.g. `tmux|`): the tools of the machine that runs each bridge shard, handed to the
  runner as `--pile-tools`; a part machine missing a tool its pile needs refuses the part (`error`) and the machine that
  runs check takes it (docs/CI-MACHINES.md, "Tools a test file needs").
- `CI_REMOTE_JOBS` (phase B, `image` with `CI_TITAN_IMAGE=on`): jobs another machine of the run posts. They are left out
  here (not run, nothing posted) and the rest is a default run, skips planned as before; `ci-runner.sh fallback` takes one over
  in a run of its own when that machine does not answer.
- `--sha <full sha>`: the commit the plan fixed. A PR or ref that now points elsewhere is tested by its newer run; this one says
  so, tests nothing and posts nothing.
- `CI_STATUS_PREFIX` (`local-ci`, `ci-part` or `report-ci`): where a job's status goes. The part jobs (`bridge-shard-1`,
  `bridge-shard-2`, `vitest`, `browser-e2e`) and the report-only ones (`linux`, `stock-mac`) are refused under `local-ci/`, so
  they can never post into a gating context. A run's record keeps each context, so a cancel closes it under its own prefix.
- `CI_ATTEMPT_URL` (the workflow attempt's link prefix): two answers for one context. A context another machine of this attempt
  already answered is not run; right before a final post the commit's full status list is read again, so a red from any
  machine of the attempt stays red (with its own words) and a second green posts nothing; a cancel re-posts that red, not an
  error. Without it nothing is read.
- The part jobs run a piece of `check`: `bridge-shard-K` is `test-parallel.ts --skip test/schedules/ --shard K/2` on
  `CI_PART_JOBS` processes (dropped, with nothing posted, for a commit whose runner has no `--shard`), `vitest` is the root
  suite on `CI_PART_WORKERS` workers. `linux` runs the supervisor files and `history-corrupt.test.ts` on 2 processes.
- `CI_REMOTE_PARTS` (`<part>:<machine> ...`, with `CI_RUN_ID` for the jobs API): `check` folds those parts in instead of running
  them. The quiet group and the loud group become one hold of `suites`; at its end a part whose machine never picked it up
  runs here; one still working gets `CI_PART_WAIT` (120 s) and then runs here too. A part red on its machine fails `check`
  ("bridge shard 2 failed on cyclops; see its run"); a pass says where each part ran. Without `CI_ATTEMPT_URL` every part
  runs here.
- `CI_OWNER_MACHINE=1` (Delphi): before its slot the run refuses, naming the reason, if the runner's user is an admin, can list
  the owner's home (`CI_LIVE_HOME`, default `/Users/$CI_LIVE_OWNER`), live folders or tmux folder (`CI_LIVE_TMUX`), has
  `claude` or `chronos` on `PATH`, or runs inside tmux.
- `docker_up` on Linux starts rootless Docker with `systemctl --user start docker`; colima only on a Mac.

`ci-runner.sh` has the commands the split workflow calls (phase A step 3):

- `plan`: the commit, fixed once (a PR's head, a push's sha, a dispatch's ref resolved once), and each machine's jobs from the
  repository's switches: `CI_DELPHI` and `CI_CYCLOPS` (`on` sends their parts there and tells Lemnos to fold them in; `shadow`
  runs them there as well, only recorded), `CI_HESTIA` (`on`: the report-only Linux job). Lines for `$GITHUB_OUTPUT`: `sha`,
  `remote_parts`, `delphi`, `cyclops`, `hestia`, `titan`. Lemnos still plans its own skips, so with every switch off the run is
  today's.
- `run` passes `CI_PLAN_SHA` as `--sha`, and `GITHUB_RUN_ID` as `CI_RUN_ID`. On a part or report-only machine (`CI_RUN_JOBS`)
  it runs those jobs under `ci-part/` (or `report-ci/` for `linux`), with `--full` on the nightly and a dispatch; one that
  starts after `check` was answered in this attempt tests nothing.
- `fallback`, after Lemnos's own run: each gating job handed elsewhere (`CI_FALLBACK`, `<machine>:<job,...>`, phase B on) with
  no final answer in this attempt is run here, in one `ci-local.sh` call: at once when its machine never picked it up or ended
  without answering, after `CI_REMOTE_DEADLINE` (900 s from the run's start) when it is still working.
- `preflight`: the owner's-Mac check (`ci-local.sh --preflight`), the first step of the Delphi job.
- `guard` refuses a draft PR (`PR_DRAFT`) and a `CI_RUN_JOBS` that is not check's parts or `linux` alone.

**The workflow (phase A step 4).** `.github/workflows/ci-runner.yml` has six jobs: `plan` (fixes the commit and reads the
repository variables `CI_DELPHI`, `CI_CYCLOPS`, `CI_HESTIA`; a base whose `ci-runner.sh` has no `plan` plans nothing, so the run
is the one-machine run), `ci` (Lemnos, as before, given the planned commit and the parts to fold in), `delphi`, `cyclops` and
`hestia` (each skipped unless `plan` gave it jobs; `delphi` sets `CI_OWNER_MACHINE: 1` itself and runs the preflight first;
`hestia` is `continue-on-error`; each uploads its own logs on a failure), and `close`. Only when a part of check runs elsewhere
do Lemnos's statuses link to the run's attempt (`.../attempts/<n>#lemnos`) and read the attempt's other answers; with every
switch off they link to the run, as before. `close` runs only when a remote job was planned, after `ci`, checks nothing out,
and cancels the run when a remote job is still queued once Lemnos is done (its machine is off). It decides from the jobs' states,
so a run whose `ci-local.sh` reused another run's result is closed the same way; it waits up to an hour for a remote job still
working, and never fails the run. With no variable set the remote jobs and `close` are skipped, and the six statuses are
today's, with today's links; the run gains the `plan` job and `--sha`.

## A fast answer: report-ci/fast

A run that tests `check` and posts its answers also posts `report-ci/fast`, about 3 minutes in: `pnpm typecheck`, `pnpm lint` and
the unit tests (every Vitest project but `scripts/`, the CI and install suites) that the change since `check`'s last pass can reach
(`vitest --changed <that commit>`, by imports; a change to `package.json` or the Vitest config reruns all of them), with one retry
per failed test and the flake log, as in `check`. With no such pass (a rerun, `--full`, the nightly, none in reach) it runs
typecheck and lint only: every unit test took 470 s on 2 workers at nice 15 on a loaded Mac, a second copy of `check`'s beside
its suites.

It is outside the verdict: `ci_classify` reads the six `local-ci/<job>` contexts only, so a red or pending `report-ci/fast`
never changes it, and `check` runs all of it again. A failed fast lane does fail the run, as `check` will. It costs the full run
little: it takes no mutex (never the `suites` one, so it neither waits for nor holds up a running full run's suites) and no slot
of its own, every step runs at `nice -n 15` so the run's jobs come first for the CPU, and Vitest gets `CI_FAST_WORKERS` workers
(2). It reuses the run's one install and build, and its typecheck and lint write nothing (`tsc --noEmit`, `biome check`), so
they cannot race `check`'s. Memory is not limited by nice: two typechecks at once means twice the `tsc` processes. A cancel
closes a pending `report-ci/fast` as an error, like a job; `ci-runner.sh sweep` closes it too. `--no-status` and a run without
`check` have no fast lane, and `--jobs` cannot name it.

## No proxy in front of localhost

The browser job talks to localhost only. A proxy put in front of it on the CI Mac (web protection software) once failed
`page.goto` with `ERR_UNEXPECTED_PROXY_AUTH`. Under ci-local (`CI_FLAKE_FILE` set) every Playwright config starts Chromium with
`--no-proxy-server`; a spec that sets its own `launchOptions` replaces the project's whole, so it must carry the flag too (a test
checks every one). After the browser download (which may need a proxy), `ci_browser_env` clears `http_proxy`, `https_proxy` and
`all_proxy` (both cases) and sets `NO_PROXY=localhost,127.0.0.1`: that reaches Node and the tools that read those variables. The
browsers on macOS read the system proxy settings, not these variables. WebKit takes no Chromium flag, so nothing here covers it:
a proxy set in System Settings still reaches WebKit. A run by hand changes nothing. Checked in
`scripts/ci-flake-reporters.test.ts` and `scripts/ci-local-runner*.test.ts`.

## A test that failed once

A failed test runs once more, on its own where the runner allows it, never the whole job. If it passes then, the job is green,
but it says so: "passed on retry (N flaky tests, see flakes.tsv)" in its status (a pass, like "with warnings"; `verdict` lists
these jobs), a `! <job>: passed on retry: <test> (<file>)` line in the run's output, the same line in the job's log, and a row
in `~/.cache/talos-ci/logs/flakes.tsv`: date, sha, job, test, file. A test that fails twice stays red. Each job gets its own
`CI_FLAKE_FILE`, where the runners write the tests that passed only on the retry:

| Runner                                            | How it retries                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vitest (`check`)                                  | `--retry=1`; `scripts/ci-flake-vitest.ts` reports a test whose retry passed                                                                                                                                                                                        |
| bun (`check`, the bridge)                         | `test-parallel.ts --retry-failed` runs a failed file once more; a file killed at the file limit is not rerun                                                                                                                                                       |
| Swift (`desktop`'s main run, `mobile`'s packages) | `scripts/ci-swift-retry.sh` reruns only the failed tests (`--filter`), and passes only if each printed a pass line; not rerun: a crash, a run with no end-of-run summary, an issue no failed test accounts for, a test known only by a display name, a build error |
| Playwright (`browser`)                            | `retries: 1` in every config when `CI_FLAKE_FILE` is set; `scripts/ci-flake-playwright.ts` reports the flaky ones                                                                                                                                                  |

Not retried: the desktop job's other scripts (starvation, the packed app, the install tests), the iPhone app's own tests
(`xcodebuild test`) and the mobile package's Vitest. By hand (no `CI_FLAKE_FILE`) nothing retries.

## git never waits for a person

Titan's runner once hung 4 h 23 m in `git fetch -q origin`: there was no credential, and git waited on a prompt nobody could
answer. `ci-local.sh` and `ci-runner.sh` export `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` and (unless set)
`GIT_SSH_COMMAND="ssh -o BatchMode=yes"` (unless the owner set an ssh command of their own), so no git below them asks. Each call that talks to the remote (the fetches, the PR
head's `ls-remote`) also has stdin from `/dev/null` and a time limit, `CI_GIT_LIMIT` (300 s). A small perl in front of it
puts git in a process group of its own; at the limit the whole group (git and its helpers: `git-remote-https`, a credential
helper, ssh) gets TERM, on which git removes its `.lock` files, and 5 s later KILL. The perl holds the limit even if the script
above it is killed, and passes on a TERM, INT or HUP it gets. A `.lock` file made during the call and still there (in the git dir, or the common one of a linked worktree) is named
in the failure line and left alone, since another git may own it. One that fails or is stopped says
which remote and why: `ci-local: git fetch of https://github.com/<repo>.git failed (exit 128): no credential? (git may not ask
for one here); git said: ...`, with no user or token in the link. The fetches are not required (the commit may already be
here), so the run goes on; a PR head it cannot fetch is the run's failure, as before, and a PR head's `ls-remote` that fails
leaves the run testing the head it was given. Tests: `scripts/ci-local-jobs.test.ts`
and `scripts/ci-runner-machines.test.ts`, "git never waits for a person".

## A Mac that slept

A laptop that sleeps in the middle of a run gives a weaker pass: a test that waits for something not to happen passes across a
suspend, and a deadline on the wall clock means nothing. So the run asks the Mac when it last woke (`sysctl kern.waketime`, which
counts a brief dark wake too). A job that finished green after a wake that came after the run got its slot **still passes, with
a warning**: a `!` line in the run's output, a `warning:` line in the job's log and "with warnings" in its status. No failure has
been traced to this. A skipped job is exempt. If the wake time can't be read on a Mac, that counts as a sleep; on other systems
the check does nothing. `CI_SLEEP_GUARD=1` puts the old stop back: the job is reported as `error` ("the Mac slept during the run;
result not trusted, re-run") and the run exits 1. The runner also keeps the Mac awake while it works (`caffeinate -i -m -s`),
which is enough plugged in. On battery with the lid shut the Mac sleeps anyway, and then the warning is what tells you.

A Mac that sleeps through the end of a run (the runner process itself frozen, GitHub losing contact) can't answer at all:
the statuses stay pending. See "When the runner is offline" (a pending status is not enforced as a block either).

## Always the PR head

A run resolves the commit once to say what it is queued for, then again after it gets its slot. If the PR moved while it
waited, it tests the new head and says `head moved while queued (old -> new)`. Statuses are posted only for the commit
actually tested: pending when it starts, then the result, all on that one sha. PR heads are fetched into a ref of the
run's own (`refs/talos-ci/run-*`, deleted afterwards), never `FETCH_HEAD`, which concurrent runs would overwrite.

## How the locks work

A lock is a directory created with `mkdir`, the atomic step: exactly one process can create it. It holds `owner` (pid,
the process's start time, a random nonce) and `what` (shown to waiting runs). Release renames the directory away and then
deletes it, so nobody sees a half-removed lock.

The rule: only one live process may believe it holds a lock, however long any of them stalls.

A lock whose owner is dead (the pid is gone, or now belongs to another process: its start time differs) is taken over, never
deleted. The waiter makes a claim, `<lock>/takeover-<owner key>.<n>`, re-reads the owner to make sure the lock was not
released and retaken by a live run since it looked, and then writes itself in. A claim is a symlink whose target names the
claimer: `ln -s` is atomic and refuses a name that exists, so one waiter wins each claim and it can't be seen half-written.

A claim is never taken from a live claimer, however old it is. Age proves nothing: the first version reclaimed a claim after
`CI_LOCK_GRACE` seconds, and a claimer stalled that long woke up, wrote itself in over the waiter that had moved on, and
both held the slot. If a claimer died, the next waiter makes claim n+1 and leaves claim n alone, so no one can remove a live
claim by mistake. The price: a process stopped in the middle of a takeover holds that lock up until it dies or waiters
reach `CI_LOCK_TIMEOUT`. Waiting is the safe way to fail here.

A lock with no `owner` file yet is left alone for `CI_LOCK_GRACE` seconds (default 30) in case its creator is still writing
it. Then a waiter may give it an owner. The first owner is written with `ln`, which refuses to replace one, so a creator that
stalled past the grace period loses and walks away instead of overwriting the waiter. An older lock with a claim directory
from the previous script counts as held for the grace period, then as dead.

If `ps` fails, a live pid counts as alive (only a different start time means the pid was reused). Start times are read in
the C locale and UTC, and once per process, so a later failed `ps` can't make a run stop recognising its own lock.

`scripts/ci-lock-stress.sh <copy of ci-local.sh> [rounds]` stresses all of this (the copy with its `ci-local/` folder beside it): run it beside real load. On 2026-10-31, at
load 25 to 50, against the code before and after this rule:

| Rounds                                           | Before: two live holders | After |
| ------------------------------------------------ | ------------------------ | ----- |
| Process stalled past a 1 s grace (44 rounds)     | 40                       | 0     |
| 10 racers, nothing forced, 1 s grace (52 rounds) | 3                        | 0     |

The default grace is 30 s, so hitting this took a 30-second stall; the shorter grace is how the stress reaches it quickly. A
third count is not a bug: with racers started late, 19 of 30 rounds (old code) and 21 of 30 (new) saw a second winner after
the first had exited. That is a correct takeover of a dead lock, and no two were ever alive together.

Two runs of one commit never test at once, whatever each asked for. The second waits for the first. Then, if both were asked to run
the same way (`--latest`, posting or not, a forced desktop job, GUI tests), it takes the first one's result for each job they
share and posts nothing for those, so a failure cannot be overwritten by a later pass. Any other job it tests itself. If the first
died, the second tests everything. A new run also waits for a run of the old single-lock script (`~/.cache/talos-ci/lock`, same
port as slot 1) to finish; that lock is never touched.

To see who holds what: `cat ~/.cache/talos-ci/locks/*/what`. Nothing needs clearing by hand after a crash: the next run
takes the dead run's slot over.

`scripts/ci-local-runner*.test.ts` covers what the runner needs of this script: a cancelled or killed run leaving no pending
status, no held lock (a mutex from inside a job too), no container, image tag, half-started colima, worktree or temp dir; the
watchdog surviving a runner that signals everything under the job; `--reap`; the text and link of the statuses; and the sleep
check. `scripts/ci-runner.test.ts` covers `scripts/ci-runner.sh` and the two workflow files: the fork and ref guard, the pins,
the sizing, the cache check, the call into `ci-local.sh`, the sweep, and what the workflows say (token, triggers, no
interpolation into a command, `ci.yml` still manual-only).

`scripts/ci-local-jobs.test.ts` covers a run from the inside: jobs that can only finish if they overlap, a failing job, a job
killed from outside, a cancelled run stopping what its jobs started, and one shared install and build.
`scripts/ci-local-jobs-gates.test.ts` (the same harness) covers every gate of `check` and `browser` failing the run on its own.

The tests are `scripts/ci-local-slots.test.ts` (part of `pnpm test`): the stale-takeover race with many waiters, a
waiter that looked before someone else took the lock, pid reuse, the grace period, the load guard, the mutex, per-slot
ports, a queued `--pr` run whose PR gets a new commit while it waits, a run under another `HOME` leaving a live slot's temp
dir alone, and the whole desktop script running under its mutex.

`scripts/e2e-clock-sweep.sh` is not part of CI (it takes about an hour): it runs `e2e/tests/schedules.spec.ts` with
`E2E_NOW` at every hour of a plain day and around both clock changes. Run it after changing that spec or its harness.
