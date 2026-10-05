# SETUP-INTERVIEW — the onboarding conversation

**For the agent running it.**

Rules:
- **One cluster at a time, conversationally.** Never paste all the questions at once.
- Read answers back after each section. Let them correct you.
- **Nothing gets written to disk until they have confirmed your read-back of that wave.** Then, and only then, the wave's answers go into `wiki/_onboarding-progress.md`, which is the resume anchor: a session that dies mid-interview picks up from what is recorded there.
  *(The gate is confirmation, not abstinence: a wave is marked `done` only once its answers are written into the progress file, so "confirmed" and "recorded" happen together or not at all.)*
- If they do not know an answer, write `TBD` and move on. This is not a form.
- 🔴 **Two fields may never be `TBD`: `{{NEVER_DO}}` and `{{GUARDRAILS}}` (wave 4).** Everything else
  is recoverable later; these are the agent's safety rules, and blank means the agent has none. If
  they shrug, do not accept it — offer the floor and get a yes: *"At minimum: never send anything as
  you without showing you first, never touch credentials, never delete anything irreversibly. Good enough to start?"* Write that, not `TBD`.
- **Say this once, at hello.** BOOTSTRAP step 0 says it; if that was skipped, say it now, because
  it is the first thing anyone in a regulated field will ask and getting it wrong poisons everything after it:
  *"The notes are files on your machine — yours, greppable, deletable. But the agent reading
  them is Claude, so whatever it reads goes to Anthropic's API to be processed, under whatever
  agreement you or your organisation has with them. If you handle regulated data, this is exactly
  the conversation to have with whoever owns compliance before we connect anything."*
  🔴 **Never say "nothing leaves your machine." It is false, and it is the claim that ends the
  trust when somebody checks.**

**Waves 1-4 are the minimum viable agent. Stop after wave 4** and tell them how to resume. Everything after that can happen later — and will be better answered once they have used the thing for a few days.

**There is a confirmation gate at the end of wave 4, not only at wave 8.** Read waves 1-4 back, get an explicit yes, and only then write anything. Wave 8 re-confirms what came after it; it does not stand in for this one.

**After each wave, write BOTH the wave's status AND its confirmed answers to `wiki/_onboarding-progress.md`.** On any later session, read that file first and resume at the first unfinished wave. Do not re-ask a wave whose answers are recorded there. 🔴 **If a wave is marked done but its answers are NOT recorded, re-ask it** — a status with no answers behind it means the session died before persisting them, and inventing the answer is far worse than asking twice.

---

## Wave 1 — Who am I? *(→ `{{FAMILIAR_NAME}}`, `{{FAMILIAR_PERSONA}}`, `{{FAMILIAR_TONE}}`)*

> "First: what do you want to call me?"

Then persona and tone. **Most people freeze here**, so lead with a real example rather than an open field:

> *"For reference, here is one persona: 'a dry, blunt chief of staff' — sarcastic when it earns it, zero
> flattery, and it argues with its owner on purpose. That is one option. You could go the other way and
> want something calm and precise that never editorializes. Which end are you
> closer to?"*

Push for something with an actual edge. "Professional and helpful" is a non-answer that produces a boring, useless assistant. Ask what they want it to do when they are about to make a mistake.

🔴 **If they still will not choose — and plenty of people genuinely do not care — do NOT write `TBD`,
and do NOT invent a personality for them.** `{{FAMILIAR_PERSONA}}` renders into the config they read
every session; a persona you made up is one they never agreed to and will not recognise. Offer this
floor and get a yes: *"Then I'll default to direct and factual: I lead with the answer, I tell you
when I think you're wrong, and I don't pad. You can change it any time by editing section 1. Fine?"*
Write that. It is a real default, it is honest about being a default, and it tells them where to change it.

**Capture their tone rules as concrete instructions**, not adjectives. "Never apologize twice" beats "concise."

## Wave 2 — Who are you? *(→ `{{USER_NAME}}`, `{{USER_TITLE}}`, `{{USER_COMPANY}}`, `{{USER_ROLE_SUMMARY}}`, `{{USER_TIMEZONE}}`, `{{USER_MISSION}}`)*

Name, title, company, and what they actually do all day (not the job description — the real one).

Timezone in IANA format (`America/Chicago`). Ask whether it observes daylight saving, and append the
answer in parentheses: `America/Chicago (observes daylight saving)`.

Then the one that matters most:

> "What are you actually trying to get to? Not this quarter's goals — the thing underneath."

*(Keep going — waves 3 and 4 are part of the minimum set. Do not stop here.)*

---

## Wave 3 — What should I take off your plate? *(→ `{{DELEGATE_TASKS}}`)*

> "What do you do every week that you resent doing?"

Look for: recurring, rule-shaped, low-judgment, and currently manual. Capture 3-5 concretely enough to act on. "Email" is useless; "triage the overnight inbox and draft replies to the routine ones" is actionable.

## Wave 4 — What should I never do? *(→ `{{NEVER_DO}}`, `{{GUARDRAILS}}`)*

> "What should I always push back on? And what should I never do, even if you ask me to in the moment?"

**These two answers are the most behaviorally important thing in this entire interview.** They are what stops the agent being an eager idiot. Get real specifics.

Prompt for: sending anything without review, committing them to something, deleting, spending, anything client-facing.

Then guardrails. If they work with regulated data — health, financial, legal, student records — ask directly what must never be written into notes. **Read the resulting rules back and get an explicit yes.** These go into `CLAUDE.md` section 8, which is read every session.

**→ STOP HERE. This is the minimum viable agent.**

Waves 1-4 fill every field `CLAUDE.md` needs **to be safe** — the identity, the
person, the delegation list, the never-do list and the guardrails. Tell them they
have a working agent, that waves 5-8 can happen any time, and write the progress file.

🔴 **Three fields are NOT collected yet, and all three are in the template.**
`{{KEY_PEOPLE}}` (section 2b) comes from wave 5; `{{OUTPUT_PREFS}}` (section 2c) and
`{{WORK_STYLE}}` (section 2d) come from wave 7. **Render them as plain text, not braces:**

    (not yet captured — run interview wave 5)
    (not yet captured — run interview wave 7)

That way the config says something true, and `grep -rnE '\{\{[A-Z_]+\}\}' CLAUDE.md` still comes
back empty like BOOTSTRAP step 2 requires. **Leaving the braces in place fails the
kit's own verifier on a correct install** — which is exactly the class of bug the
note below is about, one stop-line later.

> **Why the line is here and not earlier.** Wave 4 produces `{{NEVER_DO}}` and
> `{{GUARDRAILS}}` — sections 2 and 8 of the config. Stop before that and the agent
> ships with its safety rules literally blank, and the bootstrap's own
> "no unfilled placeholders" check fails. An earlier version of this kit stopped at
> wave 2 and did exactly that.

---

## Wave 5 — Your people *(→ `{{KEY_PEOPLE}}`)*

Names, roles, one word on the relationship. Skippable.

Write **one note per person** in `wiki/people/`, not one blob. A blob cannot be linked to, and unlinkable things are invisible to the query protocol.

## Wave 6 — Find the workflow worth automating

**The most valuable wave.** Look in four places:

1. Anything they already have written down as a process
2. **Their recurring calendar meetings** — *(if calendar access is not set up yet, skip this and come back; do not fake it)*
3. Any task costing 4+ hours a month
4. Their "I wish this just happened by itself" list

**End the wave by naming the single best candidate**, and say why: highest frequency × most rule-shaped × least judgment required.

That candidate is their homework-week-2 deliverable.

## Wave 7 — How you work, and how you want output *(→ `{{WORK_STYLE}}`, `{{OUTPUT_PREFS}}`)*

**How they work first.** Hours and rhythm (when they start, when they stop, the quiet window nobody
should ping into), where they are reachable, how they make decisions (fast and gut, or slow and in
writing), how they want to be interrupted (batch it, or tell me now), and the two or three tools
they actually live in. Capture it as rules the agent can act on: "nothing after 6pm", "batch the
non-urgent into the morning", "decisions go in writing before we talk."

**Then output.** Length, bullets vs prose, formality. Ask how they consume long things — reading, or listening while doing something else. It changes what you build for them.

## Wave 8 — Read it all back

Read the **entire** captured map back. Every field. Get an explicit yes.

Then say what you are about to write to disk, and where.

---

## Placeholder reference

`{{FAMILIAR_NAME}}` `{{FAMILIAR_PERSONA}}` `{{FAMILIAR_TONE}}`
`{{USER_NAME}}` `{{USER_TITLE}}` `{{USER_COMPANY}}` `{{USER_ROLE_SUMMARY}}` `{{USER_TIMEZONE}}` `{{USER_MISSION}}`
`{{DELEGATE_TASKS}}` `{{NEVER_DO}}` `{{GUARDRAILS}}` `{{KEY_PEOPLE}}` `{{OUTPUT_PREFS}}` `{{WORK_STYLE}}`

Every one of these has a home in `templates/CLAUDE.md.tmpl` — verified, not assumed.
`{{DATE}}` also appears in `templates/HANDOFF.md.tmpl`; fill it with today's date in
`YYYY-MM-DD` form from `date`.

If you ever capture an answer that has no placeholder, it is **not captured** —
write it into `wiki/` as a real note rather than letting it evaporate.
