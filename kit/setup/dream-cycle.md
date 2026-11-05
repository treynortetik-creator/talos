# The dream cycle (opt-in nightly memory consolidation)

Once a night, one headless session reads what changed in your wiki and daily logs and looks for four things:
notes that should link to each other, two notes that disagree, an old fact a newer note has overtaken, and a dated
fact written as if it were timeless. **It connects and flags. It never rewrites.**

Job: `talos-dream-cycle` (ships disabled, restricted, 02:30 daily). Scripts: `scripts/dream/`. Tests: `bash scripts/test-dream.sh`.

## What it will and will not touch

| | |
|---|---|
| Reads | `wiki/**/*.md` notes and `memory/YYYY-MM-DD.md` daily logs that changed in the last day |
| Never reads | any path with a `personal` folder in it, `.env` files, `wiki/examples/`, `_*.md` bookkeeping files, README/CLAUDE/index |
| Writes to the wiki | only `- [[target]] - reason (dream YYYY-MM-DD)` bullets in the `## Related` section of an existing note (a `## Related` section is added if the note has none), above any `<!-- TIMELINE:APPEND-ONLY -->` separator, at most 15 a night, plus one row in `wiki/_changelog.md` |
| Writes elsewhere | `memory/dream/` only: the run folders, `QUEUE.md`, and the ledger |
| Sends | nothing. No message, mail or post. `notify` is `failure`, so you hear about it only when a run fails |

Everything the model finds that is not a link (contradiction, supersession, flattened date, stale fact) goes into
`memory/dream/QUEUE.md` as an unchecked item with the two verbatim quotes, `file:line`, and a proposed action.
Nothing reads that file to edit anything. It is a to-do list for you.

## Turn it on

```bash
python3 scripts/talos-jobs.py enable talos-dream-cycle            # 02:30 daily; add --time 03:10 to move it
python3 scripts/talos-jobs.py disable talos-dream-cycle           # off again
```

Try it by hand first, no model involved, to see what it would hand the session:

```bash
python3 scripts/dream/collect.py --days 7 --no-recall    # writes memory/dream/<today>/shards/, prints counts
```

Start in **queue-only mode** if you want to review before anything touches the wiki: `touch memory/dream/QUEUE-ONLY`.
Links are then queued like everything else and nothing is applied. Delete the file to let links through.

## Reviewing each morning

1. `memory/dream/<date>/digest.txt` is one line, e.g. `Dream: 6 links added, 2 stale facts queued (...)`. Your morning brief can read it.
2. `memory/dream/QUEUE.md` holds the items for you. Handle one, tick `[x]`. Entries are never added twice.
3. Links the script added are tagged `(dream YYYY-MM-DD)` in the note, so `grep -rn "(dream 2026-" wiki/` finds them all.

## Undoing a night

```bash
python3 scripts/dream/revert.py 2026-10-28
```

A note that has not changed since is restored byte for byte from `memory/dream/<date>/preimage/`. A note you edited
since only loses the one bullet. A revert row is added to `wiki/_changelog.md` (the original row stays) and the
ledger is renamed `applied.reverted.json`. Queue items are left for you to tick or delete.

## How a night runs

One `claude -p` session, no sub-agents (a restricted job cannot start any), small on purpose:

1. `collect.py` (no model): changed notes, newest and least-linked first, capped at **12 notes in shards of at most 4**;
   missing-link candidates (Adamic-Adar over the link graph), `wiki-lint.py` hits for those notes, and neighbour
   excerpts from one `recall.py --batch` call. Lexical-only neighbours are fine; if semantic search is off the degradation is
   recorded in `collect.json` under `errors`.
2. `budget.py` (no model): how many shards the session may read (at most 4, 300k estimated tokens a night).
3. Pass 1, extract: the session reads each shard and writes `proposals/shard-NN.json`, every proposal with verbatim quotes.
4. `verify_quotes.py` (no model): drops every proposal whose quote is not found verbatim in the cited file.
5. Pass 2, judge: same session, default reject, reads only `verified.json`, writes `judged.json`, spot-checks a sample of drops and rejections.
6. `apply.py` (no model): applies accepted links, queues the rest. `digest.py` writes the one line.

Run folder, `memory/dream/<date>/`: `collect.json`, `shards/`, `proposals/`, `verified.json`, `dropped.json`,
`verify-summary.json`, `judged.json`, `applied.json`, `preimage/`, `run.json`, `digest.txt`.

## What is enforced and what is only instructed

**Enforced by code or by the job's permission list:**
- Only `wiki/**` notes and daily logs are collected; `personal` paths and `.env` are rejected in `collect.py`, `verify_quotes.py` and `apply.py` independently.
- A proposal survives only if its quotes appear verbatim (whitespace and quote-style normalised) in a cited, allowed file. `hallucination_rate` in `verify-summary.json` tracks how often the model made one up.
- `apply.py` accepts only the file `verify_quotes.py` wrote: it carries an HMAC seal whose key lives in the state folder (`~/.local/state/talos/<agent>/dream-seal.key`), outside what the restricted job may read or write. A model that adds or edits a proposal in `verified.json` gets "refusing" and nothing changes.
- The script writes the wiki, not the model: the job's Edit/Write are limited to `memory/dream/`, and the only commands it can run are the five exact ones in its tool list.
- Only `type: link` proposals are ever applied; max 15 a night; duplicates, links into `_*` files and into notes marked `superseded`/`archived` are skipped; everything is logged and reversible.
- Names from your optional private vault (see below) are filtered out of daily-log text before the model sees it and out of every proposal.

**Only instructed (the model can get these wrong):**
- Whether an accepted link is actually a good one. **The same session extracts and judges, which is weaker than a separate judge**: a model reviewing its own proposals shares its own blind spots. The judge pass is told to default to reject, to see only the quotes, and to spot-check its own rejections, and that is all. The quote check proves a proposal is *quoted* correctly, not that it is *right*.
- That the session reads only the shards. The job's Read rule covers the whole agent folder (a rule cannot say "everything except"), so staying out of other files is the prompt's job, not the permission system's.
- That queue items are phrased fairly. Read the quotes, not the claim.

The blast radius of a bad judgement is bounded: at most 15 one-line `## Related` bullets a night, each tagged and revertible. Contradictions and stale facts never change a file.

## Privacy

The job itself never reads a personal vault. If you configured one (`./install.sh --with-vault DIR`, location in
`~/.config/talos/vault-dir`), `collect.py` builds a name filter from the **file names** under `<vault>/people/` and the
lines of `<vault>/_guard-terms.txt`, and drops daily-log lines that mention them. It never opens a vault note. With no
vault the filter is empty and daily logs go through as written, so keep private life out of `memory/YYYY-MM-DD.md` if you
have no vault. Whole-word, case-insensitive; a first name that is also a month or weekday matches only in the possessive form.
The filter is a net, not a wall: a private fact that names nobody in your list still passes.

## Cost

One headless session a night. The shards are small (12 notes at most, about 5-6k characters each) so the estimate is
roughly 50-150k tokens a run, hard-capped by `budget.py` at 300k estimated, and a night with nothing changed costs a few thousand.
Counts toward your normal Claude Code usage like any job. The default model is Sonnet; set `"model": "opus"` for the job in the
Chronos UI for a stronger judge at a higher price.

## Limitations

- It sees only the last day of changes (`collect.py --days N` for humans). A link between two old notes is found only when one of them changes.
- Contradictions and stale facts need both statements inside the shard; neighbours come from search, so a conflict with a note the search did not surface is missed.
- Daily logs are filtered line by line; a fact split across lines can lose its context.
- It does not touch notes' prose, frontmatter, the timeline layer, or `status:`. Marking something superseded is on you.
- Under launchd and Chronos only (macOS); the scripts themselves run anywhere Python 3.9 does.
- A night already applied is not re-collected (`collect.py --force` overrides; run `revert.py` first).
