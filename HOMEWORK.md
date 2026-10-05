# HOMEWORK — two weeks to something that actually earns its keep

Setup gave you an agent. This makes it useful. About 20 minutes a day.

The goal at the end: **one real recurring piece of your job, running through your
agent, with a written playbook, used in production at least once.**

---

## Week 1 — feed it

**Day 1 · Finish the interview.** Waves 5-8 of `SETUP-INTERVIEW.md` — setup already
did waves 1-4, and your agent is told never to re-ask a wave you completed. Wave 5
(your people) and wave 7 (how you work, and how you want output) matter most: they are the three fields
your config is currently carrying a placeholder for.

**Day 2 · The continuity test.** Ask `Where did we leave off?` at the start, and
`Update the handoff before I go` at the end. Do this every day this week until it
is automatic. It is the habit the whole system rests on.

**Day 3 · Ten notes.** Ask it to write notes on ten things you already know — the
people you work with, your live projects, the systems you touch. Check that each
one links to at least two others.

> ⚠️ **If you ran the connector seed (`SEED-WIKI.md`) at setup, do this differently.**
> Those notes already exist and writing them again creates duplicates, which the wiki
> rules call worse than nothing. Instead: **open the seeded notes and correct them.**
> Answer the `## Open questions` at the bottom of each one — those are the agent's
> guesses, and each answer you give turns a guess into a fact. That is a better use of
> the day, and it is the only way the inferred material ever gets verified.

**Day 3b · Feed it something real.** Take an actual artifact from your week — a
meeting transcript, a long email thread, a doc someone sent you — and paste it or
point the agent at the file. It should file what matters into the wiki **without
being asked to**, tell you which notes it created or updated, and tell you what it
deliberately skipped. If it summarizes the thing back at you and files nothing,
that is the bug: say so, and check the correction lands in `.learnings/`.

> This is the habit the whole thing lives or dies on. Notes you write on purpose
> run out in week one. **Notes that accumulate from work you were doing anyway are
> the only kind that keep coming.** An agent that only knows what you sat down and
> told it is a notebook with extra steps.

**Day 4 · Prep for something real.** Not a quiz — a real stake. Before your next
actual meeting, ask it to prep you from the wiki: who is in the room, what is open
with them, what changed recently. Watch whether it hops between notes, cites which
ones, and tells you plainly what it does not know. Then go to the meeting.

Afterwards, tell it everything the prep missed or got wrong, and watch the
corrections get filed. **A synthetic question tells you it can retrieve. A real
meeting tells you what it does not know**, which is the more useful of the two and
the only one you would have found out the hard way anyway.

**Day 5 · Correct it on purpose.** Find something it does in a way you dislike.
Tell it. Then check `.learnings/LEARNINGS.md` and confirm it wrote the entry with
a strike count. **If it did not, that is the bug to fix this week** — the learning
loop is what makes month three better than month one.

**The habit to start now and keep forever: audit it on purpose.**

Once a week, ask it two things you already know the answer to — one about your
world, one about its own files ("what does the note on X say about Y"). Check the
answer against the truth. Every miss goes into `.learnings/` before you move on.

> This is not a trick, and it is not paranoia. It is calibration, and it is the
> single habit that separates a five-month agent from a five-day one. An agent that
> is never checked does not become trustworthy; it becomes **unfalsifiable**, which
> feels identical right up until it costs you something.

---

## Week 2 — make it work

**Day 6-7 · Pick the workflow.** Use the candidate from interview wave 6, or pick
the thing you do most often that is rules rather than judgment.

**Day 8-9 · Write the playbook.** In `wiki/playbooks/`. Steps in order, and for
each step, **what good looks like.**

> That last part is the single most important idea in this kit. A person doing a
> task checks their own work against standards they carry in their head. A model
> will not, unless you write them down. "Draft the summary" produces slop.
> "Draft the summary — 3 bullets max, no adjectives, must name the decision and
> the owner" produces something usable. The quality bar is not implied. Write it.

Model it on `wiki/examples/weekly-status-rollup.md`.

**Day 10 · Run it.** For real, on real work. Note where it went wrong.

**Day 11 · Fix the playbook.** Every failure is a missing "what good looks like."

**Day 12 · Run it again.** It should be noticeably better. If not, the step that
failed is still underspecified.

**Day 13 · Lint it.** `python3 scripts/wiki-lint.py wiki`. Fix what it finds. Now
delete `wiki/examples/` — you have your own.

**Day 13b · Make it promote something.** Ask: *"Read `.learnings/` and propose
anything at 3 or more strikes for promotion into CLAUDE.md."* Approve or reject each
proposal, and check that what you approved lands as three things: one line in `CLAUDE.md`
ending in its `[R-nn]` key, an entry under that key in `memory/rules-ledger.md` (the story, and the
strike count), and a row in `.learnings/GRADUATION_LOG.md`. Re-run this every couple of weeks.

> **Insist on the shape of the rule.** A promoted rule is ONE line that starts with when
> it fires: *"Before any date reference: run `date`."* Not a paragraph about the time it
> went wrong. The story goes in `memory/rules-ledger.md` under the same key. In a reference agent
> audited after five months, every rule written as a paragraph recurred; the only ones that held were
> written as a trigger, a number, or a check a script could run. Config files grow by paragraphs and
> shrink by discipline, so set the discipline on day 13, not day 130. `bash scripts/claude-md-lint.sh`
> is the ceiling.

> **This is the loop that actually compounds, and it is the one everybody skips.**
> The wiki is what your agent *knows*. The promoted-rules section of `CLAUDE.md` is
> what it has *learned* — and learned rules are what stop the same mistake arriving
> a fourth time. Every rule in a mature agent's config is a scar. You want scars.

**Day 14 · Grade yourself.**

| | How to check |
|---|---|
| 20+ real notes | `wiki-lint.py` prints the count. **If you ran the seed, this was true on day zero — measure instead whether the open questions have been answered down to near zero.** |
| It files things without being told | hand it a transcript cold and watch |
| Every note has ≥2 links | lint reports thin notes |
| It knows where you left off | ask it, cold, tomorrow morning |
| A correction from week 1 still holds | try to make the same mistake happen |
| At least one rule promoted from `.learnings/` | `GRADUATION_LOG.md` is not empty |
| One playbook, run twice, improved | you know |

---

## After that

- **Automate the trigger.** `setup/scheduling.md` (Chronos runs it headless on a schedule).
- **Log a judgment call.** Next time it gives you a real recommendation, put it in
  `memory/decisions-ledger.md` with `outcome: pending` and, in advance, what would
  prove it wrong. Grade it in two weeks. This is how you find out whether to trust it.
- **Add a second workflow.** Only after the first one has run four or five times.

## The failure mode to avoid

Building capability you never use. Skills, sub-agents, integrations — all of it is
amplifier, and amplifying zero gives zero. **One workflow that runs every week beats
nine that ran once.** If you find yourself installing things instead of using it,
stop and go run the playbook.
