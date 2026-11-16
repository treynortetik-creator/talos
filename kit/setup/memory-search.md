# Memory search

Clio, Talos's memory system, is how the agent finds things in its notes. It searches two ways. The first is always on and needs nothing. The second is set up by
default for a new agent (the root `./install.sh`, the Mac app's Create, Windows Setup) and can be skipped with
`--no-memory-search`; an agent from before that default adds it with `bash scripts/memory/setup.sh`.

| | Lexical (always) | Semantic (new agents: on by default) |
|---|---|---|
| How | looks for the words of your question in every note | compares the *meaning* of your question with chunks of every note |
| Finds | a note that uses your words | a note that says the same thing in other words ("car repair" finds "brake pads and an oil change") |
| Needs | python3 (the system one is fine) | Python 3.10+, about 160 MB of packages, a model of 67 to 210 MB, and a one-off index |
| Command | `python3 scripts/recall.py "<question>"` | the same command; it uses both and fuses the rankings |

`scripts/wiki-search.sh "<exact term>"` stays as the exact-term tool (names, IDs, quoted phrases).

## Turn on semantic search

```bash
./install.sh                                    # a new agent gets it by default (--no-memory-search skips it), or:
bash scripts/memory/setup.sh                    # from an existing agent folder, or to try again after a failed setup
bash scripts/memory/setup.sh --embed-model small   # the 67 MB model; the default, auto, picks it under 15 GiB of memory
bash scripts/memory/setup.sh --dry-run          # print the plan, create nothing
```

It finds a Python 3.10+ (`uv` if you have it, else `python3.13` to `python3.10` from Homebrew or pyenv; Apple's
own `python3` is 3.9 and cannot run the semantic packages). **A stock Mac has only the 3.9, so on a Mac `setup.sh` fetches a
pinned `uv` into `~/.local/share/talos/uv/0.13.8` by itself** (no admin, checked against its published SHA-256). Only when that download fails
(a blocked network) does it stop and print the by-hand fix: **`brew install uv`** (no Homebrew: `curl -LsSf https://astral.sh/uv/install.sh | sh`, then a new terminal); `uv`
brings its own Python and changes nothing else on the system. Plain-Python alternative: `brew install python@3.12`.
With none found, setup says so and prints that command, exits, and **nothing else breaks**: search stays lexical. Then it builds one shared venv at `~/.local/share/talos/venv`, installs three
pinned packages (`fastembed`, `sqlite-vec`, `apsw`), downloads the model into
`~/.local/share/talos/models/fastembed` (a pinned folder, because the default cache lives in the system temp
directory, which macOS purges), runs the first index into `<agent folder>/.index/memory.db`, and, if Chronos
is installed, enables the `talos-memory-index` job.

Remove it with `./uninstall.sh --remove-memory-search` (deletes the venv and the model; the per-agent
`.index/` lives in the agent folder and can be deleted by hand).

## What is indexed

`wiki/`, `memory/` and `.learnings/`. Left out on purpose: the dream cycle's undo copies (`memory/dream/<date>/preimage/`), the shipped `wiki/examples/` (made-up people), the
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
| `semantic: UNAVAILABLE` | the semantic subprocess failed or timed out: lexical only. The output also starts and ends with a `WARNING: MEANING SEARCH IS DOWN` line, and `--json` has a `degraded` object |
| `NO RESULTS -- search verified working` | a control term (the title of `wiki/me.md`) was found, so nothing matched this phrasing: try others |
| `SEARCH DEGRADED` | the control term did not match, or the corpus is empty: this is **not** evidence that nothing is recorded |

## Flags

| Flag | What it does |
|---|---|
| `-k N` | how many results (default 8) |
| `--expand` | under each hit, list the notes it links to with their `type` and one-line `description`; hubs (the top 1% of wiki notes by inbound links, never fewer than 30) are left out and counted as `skipped N hubs`. The ranking does not change. Inbound counts are cached in `.index/wiki-inbound.json`. |
| `--hubs` | with `--expand`, keep the hub notes in the menu |
| `--json`, `--batch` | machine output; several queries in one process |
| `--rerank` | rerank the top 15 now (see below) |
| `--no-rerank` | never rerank this query |

`TALOS_RECALL_RERANK=1` or `0` does what `--rerank` / `--no-rerank` do; a flag beats the variable. `TALOS_RG=/path/to/rg` picks the ripgrep to use.

**Faster keyword search.** With ripgrep installed (`brew install ripgrep`), the keyword arm is one `rg` pass over your notes and
runs while the semantic search answers; the results are the same as without it. Without ripgrep, `recall.py` reads every note
and says so once on stderr.

**Loud failures.** If the semantic search was set up but failed, or a rerank was asked for (or chosen by default) and could not
run, the first and last lines of the output are a warning and `--json` has a `degraded` object with the reason. The exit code
stays 0 and the keyword results still print. A search that was never set up (`NOT INSTALLED`, `NO INDEX`) is not a warning.

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

## Optional reranking (1.2)

`python3 scripts/recall.py "what did we decide about X" --rerank` (or `TALOS_RECALL_RERANK=1`) re-sorts the top 15 files with a
cross-encoder (bge-reranker-v2-m3, int8, CPU) that reads each file's best chunk against the question. It needs this
semantic stack plus the model: `bash scripts/memory/fetch-reranker.sh` or `bash scripts/memory/setup.sh --rerank` (about 571 MB;
`./install.sh --with-reranker` does the same at install time). A NEW install from the root `./install.sh` downloads the model by
default with the search (skipped, in one line, on a computer with under 3 GiB of memory; `--no-reranker` skips it; a failed download
never fails the install, and `talos-app doctor` says so with the retry command).

**By default, for questions, where it is fast.** A query is a question when it ends with `?`, starts with who, what, when, where,
why, how, which, did, do, does, is, are, was, were, can or should, or contains decide, decided or decision. A question is
reranked by itself only if the model is installed AND `.index/rerank-time.json` (the install and the daily index job time one cold rerank (a fresh worker, because every `recall.py` run starts one) and one warm one, and keep both there; `mem_rerank.py --probe <agent folder> --force` measures again) says the cold one (`cold_seconds`) took under 8.0 seconds on this
computer; a file without `cold_seconds`, from an older install, counts as no timing yet until the next probe. Anything else, and a plain topic or a name, is not reranked unless you pass `--rerank`. When reranking is off for a
question, one line a day on stderr says why: `reranking is off on this computer (it took N s)`, `(no timing yet)` or
`(model not installed)`. `--no-rerank` turns it off for one query.

The first line of the output says whether it ran, and if the model or the stack is missing it says that and returns the normal order
(with a warning line when you asked for the rerank). It costs about 1.7 GB of RAM and 15-40 s a query on 4 CPUs (measured with a
5.5 MB corpus), which is why the 8.0 s gate exists. It tended to help vague "what did we decide" questions and to hurt exact name
and file lookups (one maintainer's 33-question test, so a hint).
Code: `scripts/memory/mem_rerank.py`. More on the suggested local models: [`local-models.md`](local-models.md).

Credit: the hybrid design (grep plus vectors, fused with reciprocal-rank fusion) follows common practice; the
embedding model is BAAI's `bge` family (MIT), run through the `fastembed` library.
