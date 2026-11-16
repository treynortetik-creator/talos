# The reviewer eval

Past changes that hid a real bug, each with the finding a good review produces for it. It measures how well a reviewer
(a prompt and a model) finds what our reviews have caught before.

- `prompt.md`: a generic adversarial reviewer prompt. A private prompt can be scored the same way with `--prompt <path>`.
  `prompt-v1.md` is the first version, kept to compare runs before and after a change to the prompt.
- `cases/<id>/`: one bug each.
  - `case.json`: `base` (the commit before the change), `buggy` and `fix` (where it came from, for people), and `expect`:
    the finding a review must produce. That is the `file` (or any of a list), an optional `lines` range (with ten lines of
    slack), the minimum `severity`, and `must`, a list of groups of regular expressions. Every group must match the finding's
    `summary` plus `failure_scenario`; any one pattern in a group is enough. `decoys` are things a review should not flag.
  - `change.patch`: the change, stored, so a history rewrite cannot break the case.
  - `README.md`: what the bug was, and what caught it.
- Held out: `files-put-unlink-race`, `setting-sources-instructions`, `wsl-interop-vm-wide` and `wsl-mount-propagation`
  were added after `prompt.md`'s two rule lines and cap were tuned on the first eleven, so they measure it on bugs it was
  not shaped by. Report their recall apart from the rest.
- `results/`: gitignored. One folder per run, holding each case's review, its raw answer and `summary.json`.

## Running it

```
node scripts/reviewer-eval.ts run                      # every case, Fable, prompt.md
node scripts/reviewer-eval.ts run --case files-put-fold --model haiku --max-cases 1   # a cheap check of the harness
node scripts/reviewer-eval.ts run --prompt ~/private/reviewer.md
node scripts/reviewer-eval.ts check                    # every case is well formed and has its patch (no model)
```

It needs a logged-in `claude` and a full clone (each case's base is read from the history). The gate and CI never run it:
each case is a paid review. For each case the tree at `base` (without `evals/`) is copied into a fresh repository with a
single commit, and the patch is staged on top. So the review sees the change and the code around it, but no history that
could lead it to the fix. Claude Code then reviews it headless (`claude -p --output-format json`), with read-only tools, a
turn limit and a time limit. It runs with `--strict-mcp-config`, so none of the machine's own MCP servers start (a messaging
plugin must not start a second poller). `--claude-args '<JSON array>'` adds arguments, for example
`'["--settings","<a file that turns the machine's plugins off>"]'`. A case whose temp folder will not go away is left in
place and named; the run goes on.

## Scoring

Deterministic, with no model judging. A finding meets an expected one when it is in the file (and lines), at most one step
below the expected severity, and matches every `must` group. The case's severity is the right one by the prompt's own bar;
one step below still found the bug. A case is a **hit** when every expected finding is met, or with `expect_mode: any` (a
change that hid several real bugs) when one is. A miss whose closest finding is in the right file is reported as **near**:
the wording may be right and the anchor too strict. Widening an anchor is a reviewed commit, never automatic.

A run reports:
- recall: cases hit;
- findings found: expected findings met, across all cases;
- hit@5 and precision@5: the same from the first five findings only, which is what a reader acts on;
- severity: exact, higher or lower than the case's;
- findings per case, and how many matched nothing;
- decoys flagged.

`node scripts/reviewer-eval.ts compare <run> <run>` puts two runs side by side, for example
`run --prompt evals/reviewer/prompt-v1.md` before a prompt change and `run` after it.

## Adding a case

```
node scripts/reviewer-eval.ts add <id> --base <sha before> --buggy <sha> --fix <sha> --title "<the bug, in a sentence>"
node scripts/reviewer-eval.ts add <id> --base <sha> --patch <file> ...   # a change that was never committed
```

Then fill in `expect` and `README.md`, and run `check`. A stored patch must pass `bash scripts/check-no-personal.sh`, as
every file in the repository does.
