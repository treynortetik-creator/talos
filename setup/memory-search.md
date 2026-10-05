# Memory search

The agent finds things in its memory two ways. The first is always on and needs nothing; the second is opt-in.

| | Lexical (always) | Semantic (opt-in) |
|---|---|---|
| How | looks for the words of your question in every note | compares the *meaning* of your question with chunks of every note |
| Finds | a note that uses your words | a note that says the same thing in other words ("car repair" finds "brake pads and an oil change") |
| Needs | python3 (the system one is fine) | Python 3.10+, about 160 MB of packages, a model of 67 to 210 MB, and a one-off index |
| Command | `python3 scripts/recall.py "<question>"` | the same command; it uses both and fuses the rankings |

`scripts/wiki-search.sh "<exact term>"` stays as the exact-term tool (names, IDs, quoted phrases).

## Turn on semantic search

```bash
./install.sh --with-memory-search               # at install time, or:
bash scripts/memory/setup.sh                    # from an existing agent folder
bash scripts/memory/setup.sh --embed-model small   # a 67 MB model instead of 210 MB (small Macs)
bash scripts/memory/setup.sh --dry-run          # print the plan, create nothing
```

It finds a Python 3.10+ (`uv` if you have it, else `python3.13` to `python3.10` from Homebrew or pyenv; Apple's
own `python3` is 3.9 and cannot run the semantic packages). **A stock Mac has only the 3.9, so first run
`brew install uv`** (no Homebrew: `curl -LsSf https://astral.sh/uv/install.sh | sh`, then a new terminal); `uv`
brings its own Python and changes nothing else on the system. Plain-Python alternative: `brew install python@3.12`.
With none found, setup says so and prints that command, exits, and **nothing else breaks**: search stays lexical. Then it builds one shared venv at `~/.local/share/talos/venv`, installs three
pinned packages (`fastembed`, `sqlite-vec`, `apsw`), downloads the model into
`~/.local/share/talos/models/fastembed` (a pinned folder, because the default cache lives in the system temp
directory, which macOS purges), runs the first index into `<agent folder>/.index/memory.db`, and, if Chronos
is installed, enables the `talos-memory-index` job.

Remove it with `./uninstall.sh --remove-memory-search` (deletes the venv and the model; the per-agent
`.index/` lives in the agent folder and can be deleted by hand).

## What is indexed

`wiki/`, `memory/` and `.learnings/`. Left out on purpose: the shipped `wiki/examples/` (made-up people), the
changelog and the graduation log (append-only churn), `memory/agent-log.md`, `memory/briefs/` (generated), and
**anything under a `personal/` folder: a private vault is never indexed.** Everything stays on your machine; the
embedding model runs locally.

## Keeping it fresh

The index is incremental (only changed files are re-embedded; a run with nothing to do takes about a second
and does not load the model). It is refreshed by:

1. **session start**: if the last clean run was more than 6 hours ago, a detached low-priority run starts and
   the session never waits for it (skipped in scheduled runs);
2. **step 0 of the morning brief and the weekly lint job**;
3. **the `talos-memory-index` Chronos job** (daily 06:41). It is a plain command job (Chronos 0.2.1+):
   it runs `scripts/memory/refresh-index.sh` directly, so it starts no Claude session and costs no plan usage.
   Turn it off with `python3 scripts/talos-jobs.py disable talos-memory-index` if the other two paths are
   enough for you.

A note you just wrote is in the lexical results immediately and in the semantic index at the next refresh.
Force one now: `~/.local/share/talos/venv/bin/python scripts/memory/mem_index.py`.

## When search looks wrong

`recall.py` prints its state on the first line, and on a weak or empty answer a verdict:

| Line | Meaning |
|---|---|
| `semantic: live` | both arms ran |
| `semantic: NOT INSTALLED` | no venv: lexical only (this is normal until you opt in) |
| `semantic: NO INDEX` | venv present, index missing or empty: run `mem_index.py` |
| `semantic: INDEX STALE` | last clean index run more than 48 hours ago; recent notes are not searchable semantically |
| `semantic: UNAVAILABLE` | the semantic subprocess failed or timed out: lexical only |
| `NO RESULTS -- search verified working` | a control term (the title of `wiki/me.md`) was found, so nothing matched this phrasing: try others |
| `SEARCH DEGRADED` | the control term did not match, or the corpus is empty: this is **not** evidence that nothing is recorded |

## Rules that matter

- **One writer.** Only `scripts/memory/mem_index.py` writes the index, one run at a time (a lock folder with
  its pid; a lock whose process is dead is stolen). Readers wait up to 5 seconds on a lock instead of failing.
- **Never fan `recall.py` out to parallel sub-agents.** Each can load the model and open the index. Gather in the
  main session with `python3 scripts/recall.py --batch "q1" "q2" "q3"` and paste results into their briefs.
- **Two models cannot mix.** The index records which model built it; `mem_index.py --embed-model small` against
  an index built with `base` is refused until you pass `--full`.
- The index is derived data: delete `.index/` any time; the next run rebuilds it from your notes.

## Tests

```bash
bash scripts/test-recall.sh                       # no venv needed: lexical arm, banners, exclusions
TALOS_TEST_SEMANTIC=1 bash scripts/test-recall.sh # the real stack: venv, model, index, a query with no shared word
```

Credit: the hybrid design (grep plus vectors, fused with reciprocal-rank fusion) follows common practice; the
embedding model is BAAI's `bge` family (MIT), run through the `fastembed` library.
