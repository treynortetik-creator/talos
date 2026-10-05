# How this wiki works

Small linked notes. Not a document dump, not a search index — **a graph you walk.**

## Every note

```yaml
---
title: Human Readable Title
type: person | org | project | playbook | concept | meeting | source
tags: [kebab-case]
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: stub | draft | living | superseded | archived
stale_after: YYYY-MM-DD   # optional: the linter flags the note once this date has passed
---
```

`org` is your employer, or any organisation that is not a partner or vendor; `me.md`'s first link
is usually one. The linter accepts more types than this list, but these are the ones to reach for.

Then the content, with `[[links]]` woven through it, an `## Open questions`
section if anything is unresolved, and a `## Related` section.

## The rules that matter

1. **One idea per note.** Five ideas in a source is five notes.
2. **At least two outbound links.** A note you cannot link twice belongs inside
   another note. This is a *creation-time* rule, not a cleanup task — it is what
   keeps the graph walkable instead of a pile.
3. **Link text = the target's filename**, minus `.md`. `[[dana-ruiz]]` finds
   `dana-ruiz.md`. Getting this wrong is the most common way a wiki turns into a
   field of dead links.
4. **Linking to something that has no note? Create a stub.** Frontmatter, one
   line, `status: stub`. Never leave a dead end.
5. **Absolute dates.** "On 2026-03-14," never "last week." You are writing for
   someone reading this in a year, and that someone is you.
6. **Supersede, don't delete.** Mark the old note `status: superseded` and point
   at what replaced it. History is useful; a stale note pretending to be current
   is not.
7. **The body is facts only.** Anything the agent *inferred* rather than read or
   was told goes at the bottom under `## Open questions`, phrased as a question
   for a human — never as a statement, and never cited or built on anywhere else.
   When the answer arrives it moves up into the body as a fact and the question
   is deleted. This is the rule that stops a hedge from quietly becoming a law
   three notes later.
8. **When an idea is killed, write the kill down as a prohibition with the reason** — their
   words, and why it does not work — not as a neutral note about the option. A note that records
   what something *can* do without recording why it was rejected will resurrect the dead idea
   every single time a future session reads it.
9. **Everything that arrives gets filed, the day it arrives.** A transcript, a
   doc, a thread. Search first (`scripts/wiki-search.sh "<topic>"`) and update the note
   that already exists — a duplicate is worse than nothing, because then two
   notes disagree and neither knows about the other.

## Folders

`people/` · `projects/` · `playbooks/` · `concepts/` · `meetings/` · `sources/`

Optional: `partners/` — outside organisations you deal with. It shares the dossier pattern with
`people/` (see below); create it only if you actually have partners to track.

Add folders when you have three notes that want one. Not before.

## Keeping it healthy

    python3 scripts/wiki-lint.py wiki

Broken links, orphans, thin notes, missing frontmatter, index drift, relative
dates, stale notes, and open questions past their verify-by date. You should not have to
remember to run it — the session-start hook runs it for you once enough has changed, and keeps
reporting until it comes back clean.

**The one check no script can do: contradiction.** The linter cannot see two notes that disagree
— only a reader can. Whenever you touch a note that contradicts another, reconcile them in the
same turn, or mark both `⚠️ contradicts [[other-note]]` and put the question to a human. **Two
confident notes that disagree is the worst state a wiki can be in**, because whoever reads first
believes first.

## The dossier pattern — entity notes carry two layers

**Applies to `people/` and `partners/` only.** Not concepts, not playbooks — those are already
claims, not evidence.

**Why bother.** Entity notes get rewritten in place, and every rewrite silently destroys the trail
of what someone actually said and when. The specific failure it prevents: a hunch in the body
hardening into a stated fact three edits later, with nothing underneath it. If the hunch lives as a
dated entry with a confidence, that hardening is a visible diff instead of an invisible rewrite.

An entity note holds a **rewritable synthesis on top** and an **immutable dated evidence log
underneath**, split by a literal separator:

```
<!-- TIMELINE:APPEND-ONLY -->
```

An HTML comment, deliberately — invisible when rendered, greppable, and it cannot collide with a
YAML frontmatter close the way a `--- timeline ---` heading can.

**Above the separator:** who they are, how to operate with them, what is currently true. Rewrite
this freely as understanding changes. It should stay short — this is what you read in the two
minutes before a 1:1.

**Below the separator:** one line per dated observation, oldest first, newest appended at the
bottom:

```
- **YYYY-MM-DD** | source | @author — evidence. Confidence: high|medium|low
```

A short note in parentheses after the value is fine (`Confidence: low (second-hand)`); a second
value is not (see below).

`source` is a `[[wikilink]]`, a path, or a short plain origin ("Slack DM", "1:1, verbal") — write
`unknown` rather than guessing. `@author` is who asserted it — `@me`, your agent's name, or a
colleague slug; that field is the provenance record. Confidence maps from the claim types in your
`CLAUDE.md`: a sourced FACT is `high`, someone's READ or a DECISION is `medium`, and anything you
inferred is `low` — though if your config bans inferences from note bodies, an inference belongs in
`## Open questions`, not in the timeline at all.

⚠️ **One confidence value per entry.** `Confidence: medium (the date), high (the owner)` is not a
thing — the linter rejects it, and correctly, because a single line then carries two different
provenance claims and nothing says which half to trust. **If one exchange gave you evidence of
mixed reliability, that is two entries**, same date, split by what you actually know:

```
- **2026-07-14** | [[q3-migration]] | @me — Dana owns vendor renewals. Confidence: high
- **2026-07-14** | [[q3-migration]] | @me — renewal window looks like Q4. Confidence: medium
```

**What the date means: when the thing happened, not when you wrote it down.** Evidence that surfaces
late still gets its own date. Because entries must run in ascending order and existing lines can
never be edited, back-dated evidence found after the fact goes at the BOTTOM with the true event
date in the text — for example `- **2026-08-24** | old email | @me — [event 2026-01-14] …`.

**The timeline is the last thing in the file.** Nothing may follow it — not a Related
section, not a closing note. Every line below the separator is parsed as an entry, and
anything else both fails the lint and stops appends from landing at the true bottom.

### The one-line entry format, and what the guard refuses

`hooks/timeline-guard.py` (PreToolUse on Write, Edit and MultiEdit) refuses a write that would put a malformed entry
below the separator, quotes the offending line and says why, so the writer can fix it and retry. It applies the lint's
own rules (`scripts/wiki-lint.py`) and judges only the lines that are NEW, so an old violation never blocks an
unrelated edit. If you hand a sub-agent a transcript to file, paste it this block: it is the whole rule.

```
- **YYYY-MM-DD** | source | @author — evidence. Confidence: high|medium|low
```

CORRECT (one line, however long):

```
- **2026-10-01** | [[2026-10-01-vendor-sync]] | @dana-ruiz — Said the vendor review moves to Friday; no owner named. Confidence: high
```

INCORRECT, each one a lint error and a refused write:

| Shape | Why it fails | Do this instead |
|---|---|---|
| The entry hard-wrapped over 2+ lines | an entry is ONE physical line | join it; never wrap |
| `## Related`, `- [[other-note]] — her manager`, `- Whether it recurs?` below the separator | only dated entries live below it | Related links and open questions go ABOVE the separator |
| A preamble or closing note below the separator | it is parsed as an entry | put it above, or drop it |
| `@me via Lindsay` or `@me (speaker inferred)` | the author is exactly `@slug`, then ` — ` | keep `@slug`; put the relay or the inference in the evidence text |
| `Confidence: high on the statement; the date is open` | text after the value | end on `Confidence: high|medium|low`, at most ONE short parenthetical |
| A date earlier than the entry above it | entries run oldest first | append at the bottom, in date order |

Kill switch: `touch ~/.local/state/talos/<folder>-<hash>/timeline-guard.off` or `TALOS_TIMELINE_GUARD_OFF=1`.

### The routing rule — this is the whole idea

When a new fact arrives, decide which layer it belongs in:

- **Does it change the current understanding?** Edit the compiled truth above the separator.
- **Is it raw evidence of what someone said or did?** Append a timeline bullet.

Usually it is both: append the evidence, then revise the synthesis to match.

### The invariant

🔴 **Existing timeline entries are never edited or deleted, only appended to.** That is the only
thing that makes the layer worth trusting. When understanding changes, the old evidence stays put
and the synthesis above it moves. A hypothesis hardening into a stated fact becomes a visible diff
instead of an invisible rewrite.

`wiki-lint.py` enforces this against git HEAD and will fail the run on a modified or deleted entry.

⚠️ **Two limits worth knowing.** The check needs a git repo — with no `git init` it is skipped
*silently*, and you get no enforcement of the one thing that makes the layer trustworthy. And the
baseline is your last commit, so anything written since then can still be rewritten freely. Commit
often if you want the invariant to mean much.

### Migration and growth

- **No retrofit.** Convert a note when you are touching it anyway. An unconverted `people/` note is
  a lint *warning*, never an error, so the backlog stays quiet.
- **Growth guard:** past 40 entries the lint warns. ⚠️ **Archive what is superseded or no longer
  load-bearing — NOT simply the oldest.** On an entity note the earliest entries are often the
  most-cited (a JD submission, a first commitment); evicting by age alone removes exactly the
  facts people open the note for. A note freshly converted from years of history may sit over
  the threshold legitimately — it is a warning, not a deadline. When you do archive, move to
  `<slug>-timeline-archive.md` and leave a pointer as the first entry. Nothing is deleted.
