---
name: talos-agora
description: Convene a five-seat adversarial council (Bull, Bear, Customer, Operator, Contrarian) in two rounds on one decision and synthesise a short memo. On demand only, never scheduled. Use when the user asks to "run the council", "pressure-test this", or faces a costly-if-wrong decision.
---

# Agora: a five-seat decision council

Five independent sub-agents argue one decision from different angles, then cross-examine each other, and you
synthesise a memo with the consensus, the dissent and one recommended call. It exists to find the hole in an idea
before the user commits. **It costs real usage** (about ten sub-agent runs): say so and get a yes first. **Never run it
from a scheduled job.**

## Before you start

1. Get the decision in one sentence from the user, and ask: "What would change your mind?" Write it down.
2. **Say the cost and wait for a yes:** "This runs five sub-agents twice, about ten runs, a few minutes. Go?"
3. Pre-gather context in THIS session, once: `python3 scripts/recall.py --batch "<topic>" "<people involved>"`,
   plus `memory/STATE.md` and `memory/tasks.md` where relevant. Sub-agents never run recall themselves.
4. Write a briefing to `memory/briefs/council-<YYYY-MM-DD>-<slug>.md` (what is being decided, the constraints, what is
   known with sources, what would change the call). Keep it under 800 words. Everything in it is a claim to
   be tested, not a fact, unless it names its source.

## The seats

Each gets the briefing, its stance below, and the same instruction: *"Take a position and defend it in 300 to 500
words. Do not hedge, do not write 'it depends'. State the single strongest fact or argument, and the one thing that
would make you wrong. You have not seen the other seats."* Seats are judgment work: let them inherit the main model;
never use Haiku.

| Seat | Stance |
|---|---|
| Bull | The strongest honest case FOR doing it, and what it unlocks if it works. |
| Bear | The strongest case AGAINST: how it fails, what it costs, what it crowds out. Name the failure that is most likely, not most dramatic. |
| Customer | The person this is ultimately for (a buyer, a user, a stakeholder). What do they actually want, notice, or hate? |
| Operator | The person who has to carry it out on a Tuesday. What breaks in practice: time, dependencies, handoffs, maintenance. |
| Contrarian | Reject the framing. Is this the wrong question? What option is nobody considering, including doing nothing? |

## Round 1: independent takes (parallel)

Spawn all five in ONE message so they run concurrently. Collect the five outputs; if one fails, retry it once, then
proceed without it and say which seat is missing.

## Round 2: cross-examination

Give each seat the other four's round-1 takes. Each writes 150 to 250 words: the one point it concedes, the one it
attacks hardest (quoting it), and whether its position moved and why. A seat that never moves is not listening.

## The memo (you write it; do not delegate it)

Save to `memory/briefs/council-<date>-<slug>.md` and show the user the short version:

1. **Recommended call** in one sentence, and how confident you are (low, medium, high) and why.
2. **Where the council agreed**, and where it split (name the seats).
3. **The strongest objection that survived** round two, quoted.
4. **What would change the call:** the facts to check first, cheapest first.
5. **Your own disagreement**, if you have one. You are a seat in the room too; do not launder your view as consensus.

Then log it as a judgment call in `memory/decisions-ledger.md` with `outcome: pending` and a falsifiable condition
([R-25]), so the council's track record can be graded later.

## Rules

- A council is a tool for a decision with a real alternative. If the user has already decided and wants support,
  do not convene one; support the execution.
- Sub-agents see the same config you do but not the conversation; stage everything they need in the briefing.
- Report only what the seats actually wrote. If a seat's output is empty or off-topic, say so.
