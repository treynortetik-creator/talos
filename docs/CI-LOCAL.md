# Local CI (`scripts/ci-local.sh`)

Pull requests and pushes to `main` are checked on your own Macs, not in GitHub Actions (`.github/workflows/ci.yml` is manual-only). `ci-local.sh` runs
the same jobs and posts each result as a commit status, `local-ci/<job>`. A second machine can run the same
script from a workflow:

```bash
scripts/ci-local.sh --pr 39                 # the PR's head commit
scripts/ci-local.sh --ref feat/x            # any branch, tag or sha
scripts/ci-local.sh --pr 39 --jobs check,browser --no-status
```

Options: `--jobs check,mod,browser,image,desktop,mobile` (default all, exactly the ones named), `--full` (no job is skipped, see "Running only what a change can affect"), `--latest` (also the advisory latest-CLI mod run),
`--no-status` (post nothing), `--keep` (keep the scratch worktree), `--reap` (stop and clean up after runs that died, then exit). `TALOS_CI_FORCE_DESKTOP=1` runs the desktop job even
when no desktop path changed (only a hand run needs it; `apps/desktop/scripts/review-d0-test.sh` uses it as its control; `ci-local.sh` keeps it out of every job's environment). A commit that is already on `origin/main` runs the desktop and mobile jobs with no flag at all, unless "Running only what a change can affect" shows the change cannot reach them. Logs: `~/.cache/talos-ci/logs/<sha>-<job>.log`, plus `<sha>-setup.log`. Exit 0 only if every
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

**The base.** The diff is against the last green commit, not the parent. The inner commits of a push get no status
("Pushing to main"), so a parent can be a commit nobody tested. `ci-affected.sh plan` starts at the parent of a commit that is on
`origin/main` (at the merge-base with `origin/main` for a PR) and walks the first-parent line back, at most 30 commits. A commit
with no `local-ci/*` status is passed over, and what it changed counts, because the diff is taken to the green commit. The
nearest commit that has a status decides, through the same `ci_classify` the verdict uses (`ci-runner.sh`): green is the base.
Red, pending, partly reported, errored, or skipped any other way means no base, and **every job runs**: a skip can never hide an
earlier red. Nothing found in 30 commits, GitHub not readable (`gh` failing is not "no status", for the head or for any commit on the
walk), no repository, a missing script: all six. The statuses are read from GitHub, so the base can come from either machine.

**A rerun runs everything.** If the commit being tested already has any `local-ci/*` status, whatever its state, the plan
is all six and no base is looked for. The statuses are the sign of an earlier run, and that run may have failed a job this
commit's own change cannot reach: a skip proved against a base that has gone green since would post `success` over that
failure. This covers the GitHub re-run button and `scripts/ci-local.sh --ref <sha>`. A first run posts its `pending`
statuses only after the plan, so it never sees its own.

**What a skipped job says.** The job is not started (it takes no mutex and no slot time) and the run posts `success` with the
description `skipped: no affected files`, and nothing before it (no `pending`). It is not "passed on": `verdict` lists it apart
("skipped, no affected files") and treats a commit with such skips as a verdict, **only when the description is exactly those
words and the job is not `check`**; every other skip text ("skipped (swift is not installed)", "skipped (no desktop changes)")
is still no verdict. A skip chain is honest by induction: each skip is proved against a commit whose own jobs passed or were
skipped the same way, back to a real run.

**When nothing is skipped.** `--full`; `--jobs` (it names exactly what to run); `--no-status` (a skip is a posted status, and a
run that posts nothing has nowhere to say it); `TALOS_GUI_TESTS=1` or `TALOS_CI_FORCE_DESKTOP=1` (the GUI desktop tests read
`apps/web`: the companion harness imports `apps/web/src`, and a test reads `apps/web/src/theme/tokens.css`); a rerun of a commit
that already has `local-ci/*` statuses (above); and every `workflow_dispatch` of the runner (`ci-runner.sh run` adds `--full`):
a manual trigger is the full run. A nightly full run is not scheduled; `gh workflow run "CI runner" -f ref=main` is one. Pushes and
pull requests skip. The job-level gates in `job_desktop` and `job_mobile` are unchanged and still apply to a job that runs.

The earlier audit (`docs/CI-AUDIT-2026-10-31.md`) declined to skip beyond desktop and mobile because a skip is the one change that
can turn a real failure green. This is the owner's call to take it; the red-base rule, the exact-words rule and the full-run
trigger are what keep it from doing that. Tests: `scripts/ci-affected.test.ts`.

**Microphone preflight.** The browser job first runs `scripts/mic-preflight.mjs` (Chromium with the fake-microphone flags, `getUserMedia({audio:true})`, 8 s limit). If the Mac's audio is stuck, every test still runs, then the job fails with one plain line in the status: check the Mac's microphone permission (on 2026-11-03 that was the cause), then a stuck sound device; then rerun.

## Inside a run

`docs/CI-AUDIT-2026-10-31.md` has the measurements behind this. A run used to be its jobs one after another: half of a
21-minute run was a job waiting for its turn, and most of the rest was two suites asleep.

1. **Setup, once:** `pnpm install` and `pnpm build`, if any job needs them. The jobs share one `node_modules` and one
   `apps/web/dist` + `apps/relay/dist`, so nothing writes to those once the jobs start. The Playwright suites get
   `SKIP_BUILD=1` and `E2E_SKIP_BUILD=1`. If setup fails, every job that needed it fails, with the reason in its log.
2. **Jobs:** `check`, `mod` and `image` start together. `desktop` then `mobile` (they share a SwiftPM cache and a build wants
   every core) wait for `check`'s quiet group. `browser` waits for `check`. Results post as they finish. One red job does not
   stop the others. A job that dies without a result is red.
3. **Inside `check`:** the personal-data scan, which only warns, then the quick gates (types, lint), then the quiet group: the contract suite, then the bridge's
   `test/schedules/` files one at a time. Then the loud group side by side: the other bridge files 4 at once, Vitest and the
   capture check. Output of the loud group goes to `<log>.<step>` while it runs and into the job log, whole, with failed steps
   last so the reason is in the tail a failed job prints. Last comes the known-vulnerability audit (`pnpm audit --prod
   --audit-level high`), which also only warns, because an advisory or a registry outage says nothing about this commit's code.
   A step that warns adds a `warning:` line to the log, a `!` line to the run's output and "with warnings" to the job's status,
   which still counts as a pass. The one-day wait before pnpm picks a new package version stays in force.
4. **The `suites` mutex:** the quiet group, the loud group and each Swift job hold it, one at a time on this Mac, across all
   runs. The e2e suite and the web specs don't take it, so they can still sit beside another run's suites.
5. **Inside `browser`:** `pnpm test:e2e` as ever (relay, web specs, e2e suite), with the e2e suite on `ci_e2e_workers` workers: a worker is a relay, a bridge and a Chromium (about 3 cores and 6 GB), so it is the smaller of cores × 0.3 and GB ÷ 6, between 1 and 8. That is 3 on a 10-core Mac, which also runs builders (what it always ran) and 5 on 18 cores and 128 GB. Each test starts its own relay on its own port inside its worker, and the relay's auth state is per process, so workers share nothing; `E2E_WORKERS` in the environment still wins.

### A job can't outlive its run

A run that ends any way at all answers for itself: every status it posted pending gets an answer (a job that never reported is
closed as `error`, "cancelled or interrupted; re-run", never left pending), the scratch worktree and temp dir go, and every lock
it holds goes, including a mutex a job took inside its own subshell. The same cleanup is done by the watchdog if the run is
killed outright, by a waiter that takes a lock from a dead run, by the start of the next run, and by `ci-local.sh --reap`. The
record `runs/<nonce>` holds what that needs (`owner`, `worktree`, `tmp`, `repo`, `posted`, `reported/`), so no one needs the
dead run's memory.

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

| Suite      | Workers                      | Set by                          | Measured alone                       |
| ---------- | ---------------------------- | ------------------------------- | ------------------------------------ |
| Vitest     | 4                            | `CI_WORKERS` (40% of the cores) | 9 workers 82 s · 5: 96 s · 3: 157 s  |
| `bun test` | 4 processes                  | `CI_WORKERS`                    | 1 process 435 s · 4: 132 s           |
| e2e suite  | 3 on 10 cores, 5 on 18 cores | `E2E_WORKERS`                   | 1 worker 500 s · 3: 248 s · 5: 187 s |

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

Every run ends with `ci-local: timing: waited Ns, setup Ns, jobs Ns` and adds a line to `logs/timings.tsv`. Each step's time
is in the job log as `[step] <seconds> exit <code>: <command>`, so the next audit needs no detective work.

`apps/bridge/scripts/test-parallel.ts` is the `bun test` runner: one process per file, one result per file, green only if every
file exited 0 and reported at least one test. Its default test timeout is 20 s, not 5: that timeout only catches hangs, and
fired on tests that passed every assertion but ran slowly beside other files. Explicit timeouts, waits and assertions stay as
written. `scripts/test-parallel.test.ts` also asks `bun test` which files it would run and compares, so a file can't drop
out of CI unnoticed. `pnpm test:bun` is still the plain one.

## Before you push

The flow: work in a worktree, run fast local checks (`pnpm lint`, the tests of what you changed, the hook below), rebase on
`main`, push. Full CI then runs on the newest `main` (see "Pushing to main" below). A conflict resolved by hand gets one check
of the changed code, with no loop.

`pnpm install` turns on a pre-push hook (`.githooks/pre-push`, `scripts/pre-push.sh`) for the repo and every worktree of it:
biome on the changed files, `tsc` on the changed packages. Run by a hook, not a doc, because agents skip steps. Before any of that it runs the personal-data check (`pnpm check:personal`, `scripts/check-no-personal.sh`), which **warns and lets the push go** by default (`TALOS_PERSONAL_SCAN=stop` stops the push instead; see "The personal-data scan"). It reads what is being pushed: every commit in the range (the files it changes, read from the commit and not from the working tree, and not counting commits already on the main of the remote being pushed to (`<remote>/main`, so a push to a fork has not got origin's); for a merge only the files that differ from every parent, so a value a later commit removes, an edit or a deletion on disk, or a push of another branch cannot hide it) and each commit message; the whole tree of the tip when the hook cannot tell where the push starts. The generic rules are in the repo. The private list, `scripts/personal-denylist.txt`, and the list of private documents, `scripts/private-docs.txt`, are gitignored and exist only in the owner's main checkout: the hook looks for them there when it runs in a worktree and passes them in, so a push from any worktree of that checkout gets it; a clone elsewhere checks the generic rules only and the hook says so. A missing `check-no-personal.sh` is reported the same way. **A very large push is warned about, not refused, unless `TALOS_PERSONAL_SCAN=stop`:** past `PRE_PUSH_SCAN_COMMITS` commits (a whole number from 1 to 999,999,999, default 100; empty, text, a negative, 0 or a longer number mean no limit) it reads the newest ones one by one plus the whole tree of the tip, and says the older commits' messages, and a value added and removed again inside them, are not checked. In stop mode there is no limit: every commit is read, however many. Files go to the scanner in numbered folders, so two paths that differ only by case are each scanned on a disk that ignores case, and a pushed file named `.commit-message` cannot replace the message. The rest never
takes much over 10 s: `tsc` gets 8 s (`PRE_PUSH_TSC_SECONDS`) and is cut off with a note past that, which only happens when the Mac is busy. It is a quick filter, not a gate: it doesn't check packages that depend on the changed one, and
`git push --no-verify` skips it. CI checks everything, but for a push to `main` only after the code has landed, so it is not a gate.
`git config talos.nohooks true` keeps it off for good; `TALOS_NO_HOOKS=1 pnpm install` is for one install. CI's scratch worktrees
never install it, and neither does a repo with hooks of its own in `.git/hooks`, because `core.hooksPath` would stop them. It says
so and lets the push go when it can't check honestly: no node or pnpm on PATH, or files on disk that aren't what is being pushed.

## The personal-data scan

`pnpm check:personal` (`scripts/check-no-personal.sh`) looks for names, emails, chat ids and machine paths that do not belong in a
repository. By default it warns: in the pre-push hook, in the `check` job, in the cloud workflow, and for `/Users/` paths in
`apps/desktop/scripts/guards-test.sh`. To make it a hard stop:

1. Run `bash scripts/check-no-personal.sh <path>` on the tree you want to check. It must exit 0. It loads the generic rules in
   `scripts/denylist.generic.txt`, plus any extra rules file named in `CHECK_EXTRA_RULES`.
2. `apps/desktop/scripts/guards-test.sh` must print no `warn` line.
3. Change the default of `SCAN_MODE` (`warn` to `stop`) near the top of `scripts/pre-push.sh`, the one place the hook reads
   `TALOS_PERSONAL_SCAN`, the personal-data `warn_step` in `scripts/ci-local.sh` back to `run`, `continue-on-error` off that step
   in `.github/workflows/ci.yml`, and the `/Users/` guard in `apps/desktop/scripts/guards-test.sh` from `warn` back to `bad`.

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

### The window-opening desktop tests

About 270 desktop tests open real windows (`apps/desktop/Tests/TalosDesktopGuiTests`) and run only with `TALOS_GUI_TESTS=1` in a
logged-in session. The runner does not set it, so they are not in the default run. Set it and `ci.sh` runs each suite in its own
process through `apps/desktop/scripts/gui-tests.sh`, which fails a process that exits 0 without printing Swift Testing's summary
(AppKit has ended a whole test process early that way) and one that matched no tests. `gui-tests-test.sh` checks that gate in every
run, with a stand-in runner and no windows.

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

`scripts/ci-lock-stress.sh <copy of ci-local.sh> [rounds]` stresses all of this: run it beside real load. On 2026-10-31, at
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

`scripts/ci-local-runner.test.ts` covers what the runner needs of this script: a cancelled or killed run leaving no pending
status, no held lock (a mutex from inside a job too), no container, image tag, half-started colima, worktree or temp dir; the
watchdog surviving a runner that signals everything under the job; `--reap`; the text and link of the statuses; and the sleep
check. `scripts/ci-runner.test.ts` covers `scripts/ci-runner.sh` and the two workflow files: the fork and ref guard, the pins,
the sizing, the cache check, the call into `ci-local.sh`, the sweep, and what the workflows say (token, triggers, no
interpolation into a command, `ci.yml` still manual-only).

`scripts/ci-local-jobs.test.ts` covers a run from the inside: jobs that can only finish if they overlap, a failing job, a job
killed from outside, a cancelled run stopping what its jobs started, one shared install and build, and every gate of
`check` and `browser` failing the run on its own.

The tests are `scripts/ci-local-slots.test.ts` (part of `pnpm test`): the stale-takeover race with many waiters, a
waiter that looked before someone else took the lock, pid reuse, the grace period, the load guard, the mutex, per-slot
ports, a queued `--pr` run whose PR gets a new commit while it waits, a run under another `HOME` leaving a live slot's temp
dir alone, and the whole desktop script running under its mutex.

`scripts/e2e-clock-sweep.sh` is not part of CI (it takes about an hour): it runs `e2e/tests/schedules.spec.ts` with
`E2E_NOW` at every hour of a plain day and around both clock changes. Run it after changing that spec or its harness.
