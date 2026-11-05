---
name: talos-memory-recall
description: How and when to search this agent's memory. Use before answering any question about a person, project, decision or past event, and before telling the user "nothing is recorded". Covers recall.py (fuzzy, hybrid) versus wiki-search.sh (exact), reading the status line, and the rule against running recall from several sub-agents at once.
---

# Searching memory

Two tools, one decision: **do you know the exact word, or only the idea?**

| You have | Use | Why |
|---|---|---|
| a name, an ID, a quoted phrase, a file name | `scripts/wiki-search.sh "<term>"` | exact; tries case, kebab/space and plural variants; says whether the search ran |
| a question, a topic, "what did we decide about..." | `python3 scripts/recall.py "<question>"` | fuzzy; lexical search plus (if installed) semantic search, fused and ranked |
| several questions at once | `python3 scripts/recall.py --batch "q1" "q2" "q3"` | one process, JSON out |
| a connected neighbourhood | `python3 scripts/recall.py "<q>" --expand`, then open the `[[links]]` 2-3 deep | answers usually live across linked notes |

## Read the first line of the output

`recall.py` always tells you what ran: `(semantic: live)`, or `NOT INSTALLED`, `NO INDEX`, `INDEX STALE`,
`UNAVAILABLE`. Anything but `live` means the answer is keyword-only: a note that says the same thing in other
words will be missed. Say so if it matters. Semantic search is optional (`bash scripts/memory/setup.sh`).

## A zero is a claim about the query

If nothing comes back, the output ends with a verdict. Believe it:

- `SEARCH DEGRADED` means the search path itself failed a control query. This is **not** evidence that
  nothing is recorded. Say the search is degraded and name the cause printed under it.
- `INDEX STALE` means recent notes are not searchable semantically yet. Refresh it (command printed), or
  fall back to `wiki-search.sh`, which reads the files directly.
- `NO RESULTS -- search verified working` means the control term was found, so the search works and nothing
  matched this phrasing. Try two or three other phrasings, then check `wiki/_index.md`, before telling the user
  it is not recorded.

## Hard rule: never fan recall out in parallel

Do not let several sub-agents each run `recall.py`. Each run can load the embedding model (hundreds of MB) and
opens the same SQLite index; a handful at once costs memory and lock contention for nothing. Instead:

1. In the main session, run `python3 scripts/recall.py --batch "q1" "q2" ...` once, with every question the
   sub-agents will need.
2. Paste the relevant results into each sub-agent's brief.
3. Sub-agents work from the paste. They do not search.

The index has exactly one writer (`scripts/memory/mem_index.py`, one at a time, guarded by a lock). Readers wait
briefly on a lock instead of failing.

## What is and is not indexed

`wiki/`, `memory/` and `.learnings/`, minus the shipped `wiki/examples/`, the changelog, the graduation log,
the agent log and `memory/briefs/`. Anything under a `personal/` folder is **never** indexed. A note you just
wrote is in the lexical results immediately; it enters the semantic index at the next refresh (session start,
the morning brief, or the `talos-memory-index` job).

## After finding something

Cite the notes you used. End by naming what is thin, stale or not seen. If answering produced an insight no note
holds, file it back before moving on.
