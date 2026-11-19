---

name: talos-build
description: The shared rules for building, reviewing and landing changes to this repository (Talos), on any machine. Use for every Talos build, fix, test run, review or landing - before writing code, before running a suite or a time-limited command, and before any push, handoff or worktree removal. A builder brief can say "load talos-build" instead of pasting these rules.
version: 1.3.0
---

# talos-build: how every builder works in this repo

These rules hold for every builder on every machine, whatever brief it got. A brief may add rules; it never removes one.
Where a rule names a script, the script's own header comment is the full truth: read it when in doubt.

Words used below: **the lead** is the machine (or session) that lands other machines' handoffs and plain branches on `main`.
**The follow-ups list** is wherever your project keeps findings that did not block a landing (outside this repository).
**The roadmap entry** is the item in your project's roadmap that the change serves.

## 1. Before you start

- **Every brief opens with "Done looks like: ...".** If yours does not, or it names no worktree, files or done-state, stop and
  say so before you write code.
- **Work in a worktree**, never in the deployed main clone. On a machine where something runs straight from the main clone,
  moving it is a deploy: never run `checkout`, `switch` or `reset` there. Make your own:
  `git worktree add -b <branch> <worktree-path> origin/main`, then `pnpm install --frozen-lockfile` inside it (that also turns
  on the pre-push hook).
- **Before removing a worktree**, make sure nothing uses it: no agent, background job, test run or eval of yours still has it
  as its folder. Removing one mid-run loses the run.
- **Red main comes first.** If `main` is red, fixing it comes before feature work. The author fixes their own break; whoever
  catches a small one fixes it. Do not push while `main` is red, or while the maintainer has asked everyone to stop pushing (a push hold), except the fix for that red, which
  pushes with `gate.sh --push --red-main` (it goes first in the queue, only when CI's statuses really say red).
- **Triage every red first.** The red-main fixer starts one sub-agent (a mid-size model; the strongest for a guard or
  security test) with the failing tests, their output, `git log <last green>..<red sha>` and the relevant diffs. Within
  about 5 minutes it answers in four lines: TEST, APP or RUNNER (the machine, not the change); the causing commit and its
  author; the fix in one line; its confidence and what would change its mind. Alerts read "red at <sha>: TEST|APP|RUNNER,
  caused by <sha>, fix: ...". A security or guard test is never called TEST without evidence both ways.
- **Undo first.** If no fix is in a gate within 20 minutes of the alert, revert the causing commit(s) with
  `gate.sh --push --red-main` and tell the author, who lands again with the fix. Exceptions: a fix already in a gate, or a
  revert that would itself break something (say so; the lead decides).
- **A RUNNER red.** Run that job again. If the same runner fails twice, take it out of main's verdict until its owner says
  it is fixed and one run is green. A RUNNER red never holds pushes.
- **No new CI or tooling projects** unless they pay off in something the owner can see.
- Read `AGENTS.md` (the project guide) once per session. Its size, safety and testing rules apply here too.

## 2. Tests first

- Write the test before the fix. A test must fail when the code breaks; a fake must refuse what the real thing refuses.
- **A test that answers a review finding is shown red first:** break the code on purpose, watch that test fail, restore the
  code, watch it pass. Say in the report that you did.
- **Fixtures for terminal pane parsing are byte copies of real captures**, never hand-typed approximations.
- No fixed millisecond limits and no wall-clock waits in tests: use the fake clock in `packages/testkit` or measure growth.
- Tests never read the real Talos home, the real clipboard or any live service. Fixture paths use `/home/alex`, never a
  real home folder (the desktop app's guard and the personal check both look for one).

### The failure classes (test only the ones your change touches)

1. **Claimed but not there.** Every doc, UI or report claim is true and reachable in the real app. Drive new features from
   their real entry point; cite the test behind each claim.
2. **Two sides disagree.** Accept what real, older and newer peers send; one unknown value degrades one item, never the
   whole frame. Run real captured output, an old frame and an unknown value through the real parser.
3. **Wrong identity.** Trust proven identity only, never a name, a client-sent id, a reusable number or a null match.
   Approvals bind what was shown. Test that a second caller reusing the first one's id or name is refused.
4. **Tests that prove the mock.** Run against the real component where you can.
5. **Silent failure.** An error never reads as empty, skipped, OK or sent. Force each failure; assert the owner sees it.
6. **Unhappy UI states.** Any screen change works at phone width. A new screen also works by keyboard, in both themes, and
   when loading, empty or failed: render those in a real browser (Playwright), including where focus lands.
7. **One path skips the guard.** Put each rule where UI, API, socket, CLI and agent tools all pass through it. Drive one
   refused case through every entry point.
8. **Off does not reach live things.** Revoke, sign-out, switch-off and restart reach open sockets, running work, child
   processes and cached state. Start work, turn it off midway, assert it stops and nothing stale shows.
9. **Time assumptions.** Timeouts outlast the work they wrap; clocks jump, days end, machines sleep. Fake the clock across
   midnight, a DST change and a sleep; test a peer slower than the timeout.
10. **Races.** A second process or a retry can come at any time. Check and act atomically; side effects run once. Run one
    action twice at once and kill one midway: one winner, nothing lost.

Also, where the change touches them: hostile text, size limits, checks that run after the write, and a fresh home folder
(no dev-machine paths, ports, env vars or installed tools assumed).

## 3. Running things on a shared machine

- **Heavy jobs go through the machine's lock (a few at a time, in slots).** A Swift suite, a stress loop, an eval run or a full gate is heavy. Look at memory and load
  first (`scripts/heavy-guard.sh status`; or `uptime`, plus `memory_pressure` on macOS or `free -m` on Linux), then run it
  under the machine's lock: `bash scripts/heavy-lock.sh run <name> -- <cmd...>`. `heavy-lock.sh status` says who holds each slot.
  The gate and the desktop test script take their locks themselves.
- **Every time limit is a group time limit.** Wrap the command so that, at the limit, its whole process group stops, not
  just the first process:

  ```bash
  perl -e '$t=shift; $p=fork; if(!$p){setpgrp(0,0); exec @ARGV} $SIG{ALRM}=sub{kill "TERM",-$p; sleep 5; kill "KILL",-$p; exit 142}; alarm $t; waitpid($p,0); exit($? & 127 ? 128+($? & 127) : $? >> 8)' <seconds> <cmd...>
  ```

  Why this form: a bare `perl -e 'alarm N; exec ...'` (or a plain `timeout`) stops only the top process and leaves its
  children running. And an older ending, `exit($?>>8)`, turned a child killed by a signal into exit 0, a false pass. This
  one exits 142 at the limit and passes every other exit code through, signals as 128+N. A child that starts its own
  session (setsid, a daemon) still escapes: after every run, check your own leftovers by pid.
- **Load for timing tests comes only from `scripts/cpu-burn.sh`**
  (`bash scripts/cpu-burn.sh [--cores N] [--seconds S] -- <cmd...>`). It runs inside the heavy lock, caps itself at 600
  seconds and stops its burners on every way out. Never hand-roll a burn loop.
- **iOS simulator: create your own** (`xcrun simctl create <name> ...`) and pass `-destination id=<udid>`. Name it after your worktree, so two builders never share one. Never boot, install
  to or erase a shared simulator (the plain "iPhone 17 Pro") or a CI one (`talos-ci-s*`): two xcodebuild runs on one device
  replace each other's app (red at 52805b3). Shut yours down when done.
- **Stop only your own processes, by pid** (or by parent, `pkill -P <pid>`). Never kill by name, pattern, age or the
  command line of something you did not start. The load guard lists strays and refuses new heavy work; it never kills.
  Before you report, confirm none of your processes remain.

## 4. Never

- Touch the live `tmux -L talos` server. Tests start tmux on private sockets of their own.
- Read or write the real clipboard, or open real URLs, apps or system panels from a build or a test. Stub them.
- Start a headless `claude` with messaging plugins enabled, or run the `claude mcp` list command (its health check starts
  extra plugin pollers on the machine).
- Type or store a password. Echo a secret, key or token into output, a file or a commit.
- Read the real Talos home from a test.
- Push to `main` with a plain `git push`, or force-push `main`.
- Copy text from unlicensed sources. Every string, comment and doc is your own wording.
- Put personal data anywhere, tests included: no real names, emails, chat ids, host names, employers or home paths
  (`AGENTS.md`, "Safety rules that are easy to break").

## 5. Before the gate

- **The private list.** If your machine keeps a private denylist (`scripts/personal-denylist.txt` in the main checkout),
  the gate and the hook read it from there: no copy is needed. It is gitignored: never commit it, print it or quote a line
  of it.
- **A clean environment.** Inside a Talos agent session or a scheduled run, the session's own variables change how the
  tests behave and some fail (`TALOS_APP_HOME`, `TALOS_APP_WORKER_NONCE`, `TALOS_APP_WORKER_THREAD`,
  `TALOS_SESSION_ROLE`, `TALOS_APP_BRIDGE`, `TALOS_UNATTENDED`, `CHRONOS_RUN`, `CLAUDECODE`, every `CLAUDE_CODE_*`). Unset
  every `TALOS_*`, `CLAUDE_CODE_*`, `CLAUDECODE` and `CHRONOS_RUN` in the shell that runs the gate, then name the machine
  on the gate's own command line:

  ```bash
  for v in $(env | sed -nE 's/^((TALOS|CLAUDE_CODE)_[A-Za-z0-9_]*|CLAUDECODE|CHRONOS_RUN)=.*/\1/p'); do unset "$v"; done
  TALOS_MACHINE=<machine> bash scripts/gate.sh --checks-only
  ```

  Or, as an option, start from an empty environment and keep only what the gate needs: your PATH (it must reach `git`,
  `node`, `pnpm`, `bun` and, for pinned CI runs, `gh`) and the SSH agent for the push:
  `env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" TMPDIR="${TMPDIR:-/tmp}" PATH="$PATH" SSH_AUTH_SOCK="$SSH_AUTH_SOCK" TALOS_MACHINE=<machine> bash scripts/gate.sh ...`
- **Mac app changes** (anything under `apps/desktop`) also need, before the push, one run of
  `bash apps/desktop/scripts/guards-test.sh`. Its first step runs the whole desktop Swift suite (`apps/desktop/scripts/test.sh`,
  through `scripts/ci-swift-retry.sh`), then it builds the app and checks that each guard really gates. Run it instead of
  running the suite separately. Locally there is no retry: `ci-swift-retry.sh` reruns failed tests only inside a CI job
  (when `CI_FLAKE_FILE` is set); by hand it runs the suite once, so one failed test is a red run. A `warn` line (a home path
  under `apps/desktop`) counts as a failure for you. It is heavy: load checked first, one at a time (the Swift tests take
  the machine's desktop lock themselves). A builder that does not touch Swift may skip it and grep its changed files under
  `apps/desktop` for `/Users/` instead.
- **Fast checks.** `bash scripts/gate.sh --checks-only` runs typecheck, lint, the personal check and the size budget in
  seconds. Run it after your LAST commit and after any rebase, and report its result: a formatter or size error on the
  final head is the most common refused push. `bash scripts/gate.sh --plan` prints what the full gate would run.

## 6. Pushing and handing off

- **The only push path to `main`** is `TALOS_MACHINE=<machine> bash scripts/gate.sh --push`, from a worktree. `<machine>` is your
  machine's fleet name, one of those in `scripts/talos-machine.sh`, never a host name. It refuses with uncommitted changes;
  it rebases onto `main`, gates, takes the push lease and pushes the gated commit by its sha. If the rebase conflicts, stop
  and report: do not resolve a conflict inside someone else's change without being asked.
- **A machine that cannot gate hands off.** The sending machine pushes a handoff branch named for itself:
  `git push origin HEAD:refs/heads/handoff/<sender-machine>/<name>` (letters, digits and `. _ -`). On a handoff branch the
  pre-push hook runs only the personal check of its commits, not the gate. The lead then lands it:
  `TALOS_MACHINE=<landing-machine> bash scripts/gate.sh --push --from origin/handoff/<sender-machine>/<name>`: full gate,
  then `main` by sha, then the handoff branch is deleted. A handoff is a straight line of commits on `main`, no merge
  commits.
- **A change to the push path is never a handoff.** Anything matching `scripts/gate-inputs.txt` (all of `scripts/`,
  `.github/workflows/`, `.githooks/`, package and lock files, test configs and more) is refused as a handoff, by the hook
  and again at landing. Send it as a plain branch: `git push origin HEAD:refs/heads/<branch>` (never `main`). On any branch
  that is not a handoff the pre-push hook runs the personal check AND the gate on your machine, so the push itself is
  your gate run. The lead reads the diff itself, cherry-picks it onto `main` and lands it
  with its own `gate.sh --push`. That read is the trust step. A machine that cannot gate at all sends the change as a
  patch (`git format-patch origin/main`) for the lead to read and apply instead.
- **Skipping the pre-push check.** `gate.sh --push` is the normal path. A lead may skip the hook (`--no-verify`) for a
  test- or doc-only change or an urgent red-main fix, and says so in the landing note.
- **Commit only when the brief says to**, with exactly the attribution lines the brief gives. Never invent attribution.

## 7. Review tiers

| Tier | What                                   | Review                                                                  |
| ---- | -------------------------------------- | ----------------------------------------------------------------------- |
| 1    | Security, protocol, the push path      | ONE review plus ONE fix check; a third round only for a serious finding |
| 2    | Everything else that changes behaviour | ONE review plus ONE fix check, then land                                |
| 3    | Test-only or doc-only                  | No review: the gate decides                                             |
- In tier 2, leftover non-serious findings go to the follow-ups list, never a third round. A third look needs a one-line
  why, written down before it starts.
- The reviewer's brief carries the roadmap entry and the owner's own words about the change.
- Every finding is labelled **serious**, **product direction** or **follow-up**. Only serious ones block a landing.
- **The builder and the reviewer are never the same model.**
- Every landing note says how many review rounds the change had.
- **Third strike becomes a check.** When a reviewer raises the same finding class a third time, it turns into an automatic
  check, cheapest first: a type or schema, then a Biome rule, then a gate step, then a test. It runs as a warning for a day
  before it can fail anything. Keep the tally per class in the follow-ups list.

## 8. Landing and reporting

- **Real-run rule.** A change the owner can see or touch lands with one artifact from a real run in the landing note (a
  screenshot, a short clip or real output), or one line saying why there is none. A CI, gate or guard change gets one real
  run of the changed path before it lands.
- User-visible changes get a plain-language line in `CHANGELOG.md`.
- **Verify before commit.** Load `.claude/skills/verify/SKILL.md`: drive the real app on every route the change reaches, keep before/after evidence, and end the commit message with a `Verified:` trailer.
- **Your report is a claim.** Say what you checked on disk, not what you meant to do: files changed; tests added (name and
  what each proves); each command you ran with its exit code; the sha; what you could not verify.
- A sub-agent's report is a claim too. Read the artifact and check the sha before calling anything done.

## Getting this skill on any machine

It lives in the repository at `.claude/skills/talos-build/SKILL.md`. Claude Code loads project skills from `.claude/skills/`
in the folder it starts in and in each parent up to the repository root, so a builder started anywhere inside a checkout
or worktree of this repo has it: macOS, Linux, and Windows through WSL alike. Nothing to install; pull `main` to get the
newest copy.

## Changelog

- 1.3.0: a pointer to the verify skill (drive the real app, evidence, the `Verified:` trailer) in landing and reporting.
- 1.2.0: the owner's own review limit restored (tier 1 is one review and one fix check, a third round only for a
  serious finding; the guards leave tier 1); a lead may skip the pre-push hook for test- or doc-only changes and urgent red-main
  fixes, saying so; no copying the private list into worktrees (the gate reads it from the main checkout); red-main triage
  (TEST, APP or RUNNER), undo after 20 minutes, and runner reds.
- 1.1.0: one review round of fixes: the desktop guard run replaces a separate suite run (and no local retry), split
  sender and landing machine names, how a push-path change really travels, a full list of session variables to clear and an
  env -i form that keeps PATH and the SSH agent, the lead, follow-ups list, roadmap entry and push hold defined.
- 1.0.0: first version. Worktrees, tests first and the failure classes, heavy work and group time limits, the never list,
  the gate and its clean environment, pushing and handoffs, review tiers, the real-run rule.
