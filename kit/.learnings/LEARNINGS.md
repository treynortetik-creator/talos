# LEARNINGS — corrections, and better ways found

Write the entry **in the turn the correction happens.** Later means never.

## Format

    ## YYYY-MM-DD — one-line title (correction | best_practice)
    **What happened:** what you did, and their correction QUOTED VERBATIM.
    **Root cause:** why you did it. Be honest; "I inferred instead of asking" is a
    real root cause and a common one.
    **Rule (apply every time):** numbered, imperative, specific enough to follow.
    **Severity:** LOW | MEDIUM | HIGH — and what it actually cost.
    **3-strike status:** N/3 (name the pattern, so related failures can be counted
    together even when they look different on the surface)

## Strikes 1 and 2: here, and only here

The entry stays in this file with its strike count. Do not touch `CLAUDE.md`.

## At three strikes

**Propose** the rule for `CLAUDE.md`. Show the exact lines to add and wait for a human yes.
**Never edit `CLAUDE.md` on your own initiative.** On a yes, three things, in this order:

1. an entry in `memory/rules-ledger.md` under the next free key (`## R-nn · title — RULE`): the story, in plain words;
2. ONE line in `CLAUDE.md`, at most 60 words, starting with when it fires, ending in that key: `[R-nn]`;
3. a row in `GRADUATION_LOG.md`.

Then `bash scripts/claude-md-lint.sh`. The story belongs in the ledger, never in `CLAUDE.md`.

That gate is not ceremony. `CLAUDE.md` is the standing instruction set you read at every
session start, so a rule that lands there is permanent and self-reinforcing. Everything
in `.learnings/` was written after reading something: an error message, a document, a
transcript, a file someone sent. If a bad line can walk from a file into that section
unattended, the config is editable by whoever can get text in front of you.

So: strikes are counted automatically, promotion is approved manually.

Keep **the strike count next to the rule** (in the ledger entry): the count is the justification, and it
is what stops a future cleanup from deleting a rule that was paid for in real mistakes.

---
