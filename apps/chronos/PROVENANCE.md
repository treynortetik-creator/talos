# Where this came from

Chronos, Talos's scheduler, is maintained here now and only here. The owner decided on 2026-11-19: "Just leave the chronos repo as is
but do not update it in the future. Just maintain it in Talos."

- **Source:** the standalone Chronos repository (github.com/treynortetik-creator/chronos) at commit
  `48846b3e2f3383385f47c46539c17bee5c351e7a`, its main after 0.5.1 with the Linux background timer (PR #10). That is the
  commit the Talos kit pinned and tested with.
- **That repository is frozen at that commit.** It is no longer maintained. Nothing is pushed to it and nothing re-syncs from
  it. Changes to Chronos are made in this folder, in Talos's own history.
- **How it was brought in:** one commit holding the tree of that commit (`git archive`, then the changes below). Its 70 commits
  stay in the frozen repository and were not imported.
- **License:** MIT, in [LICENSE](LICENSE), word for word; the copyright holder now reads "The Talos authors" (the owner's choice, 2026-11-21).

## Changed on the way in

Each change is behaviour-neutral, and the whole suite (`tests/run.sh`: 21 files, 572 tests) passed before and after. The
personal-data and time-zone changes were also checked in the original repository: 572 of 572 passed there.

- **Personal-data rule (Talos's check-no-personal.sh):**
  - The sample mail addresses in `tests/test_chronos.py` (`@x.com`, `@example.test`) and in
    `examples/gmail/imap-search.py` (a `gmail.com` sample) became `@example.com` addresses, changed together with what the
    tests expect.
  - Two test time zones in `tests/test_api_core.py` (America/Denver, America/Los_Angeles) became America/Chicago and
    America/New_York, inputs and expected values together.
  - A sample home folder in README.md's settings example now uses the example name `alex`.
  - README.md's closing credit line and the LICENSE copyright line no longer name the author.
  - One docstring was reworded (it read as a time-zone abbreviation).
- **Two installer tests ran `git clone` on Chronos's own folder**
  (`test_a_checkout_cloned_where_the_copy_goes_runs_in_place_and_purge_keeps_it` and
  `test_purge_keeps_a_git_worktree_where_the_copy_goes`). Inside Talos that folder is not a repository root. They now make
  a git checkout of the tree instead (`git_checkout_of_this_tree`) and check the same things.

## Changed since it was brought in

- **`Hygiene.test_pr_diff_and_messages_have_no_home_paths_or_emails` (`tests/test_review_pr5.py`)** scanned
  `git log -p origin/main..HEAD`, so its verdict depended on where the suite ran: it passes on main and fails on a branch whose
  range holds the placeholder paths (`/Users/alex`, `/Users/you`) that the tree itself carries. It now scans the range
  `CHRONOS_PR_BASE..HEAD` and skips, printing why, when `CHRONOS_PR_BASE` is not set; a base git does not know fails the test.
  Three tests pin that (575 tests in 21 files now). CI's `check` job does not set it.

## Not changed yet (each a later step)

- README.md still describes installing Chronos on its own (`git clone`, `./install.sh`). Inside Talos, Talos's own installer
  sets it up. The README gets a Talos section when the kit installs from this folder.
- The kit (`kit/install.sh`) still clones the frozen repository. It switches to this folder in the next step, and that clone
  path goes away (`--chronos-path` stays, for development).
- `third_party/chronos` is an older trimmed copy (0.5.0, with its own DIVERGENCE.md) that the bridge's schedules tests run
  against. Until those tests move to this folder, a change here is not seen by them. Moving them is a later step, so that
  this is the one copy.
- Chronos's own suite (`tests/run.sh`) runs in CI's `check` job (scripts/ci-local/jobs-check.sh `step_chronos`), not in the
  push gate, so run it by hand before a change here (`bash apps/chronos/tests/run.sh`). The test that scans a PR's commits for
  home paths and addresses (`Hygiene.test_pr_diff_and_messages_have_no_home_paths_or_emails`) scans only the range in
  `CHRONOS_PR_BASE` (`CHRONOS_PR_BASE=origin/main bash apps/chronos/tests/run.sh`) and skips without it: its verdict
  must not depend on where the suite runs.
