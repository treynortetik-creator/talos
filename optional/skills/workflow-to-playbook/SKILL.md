---
name: workflow-to-playbook
description: Turn a recurring task the user does manually into a written playbook the agent can run. Triggers on "turn this into a playbook", "automate this", "I do this every week", "write this up as a process".
---

# workflow-to-playbook

Converts something {{USER_NAME}} does by hand into a playbook that can actually be
run. This is the skill that produces the homework week-2 deliverable, and it is
the highest-leverage thing in the kit.

## Safety first

- **Draft only.** The playbook you produce never sends, posts, deletes, or spends
  on its own. If the workflow ends in an irreversible action, the final step is
  *"present for approval"* — full stop.
- **Never write regulated or sensitive data into the playbook**, including in
  examples. Reference where the data lives; do not copy it in.

## Only build one if it qualifies

Ask three questions before writing anything:

1. **Has it happened at least three times?** Below that, you are guessing at the
   pattern and will encode the exception as the rule.
2. **Is it rules, or is it judgment?** Rules automate. Judgment does not, and
   pretending otherwise produces confident garbage.
3. **Would a wrong output be caught?** If a bad result ships silently to someone
   else, this needs an approval step — say so now, not later.

**If it fails these, say so and stop.** Talking them out of a bad automation is
more valuable than building it.

## The interview

Walk the workflow with them, in order, and get:

- **The trigger.** A time, an event, or a request. Be specific: "Friday 3pm," not
  "weekly."
- **The inputs.** Where does the raw material come from? Name the actual place.
- **Each step, in order.** Make them talk through a real recent instance rather
  than describing it abstractly. People describe the idealized version and then
  the real one has four steps they forgot.
- **⭐ What good looks like, per step.** Push hard here. This is the whole game.
- **The failure modes.** "What goes wrong with this, and how do you notice?"
- **The done condition.** How do they know it is finished and correct?

## The "what good looks like" rule

**This is the single most important part, and the part people skip.**

A person doing a task carries quality standards in their head without thinking
about it. A model has none of that. Left unstated, it produces something
shaped like the right answer.

So every step gets an explicit standard:

| Weak | Usable |
|---|---|
| "Summarize the updates" | "3 bullets max, each naming what changed and who owns the next step. No adjectives." |
| "Check the numbers" | "Every figure traces to a named source. Flag any variance over 10% with a reason." |
| "Write it professionally" | "No greeting, no 'excited to share'. Bad news in the first half." |

If they cannot articulate the standard for a step, that step is **judgment, not
rules** — mark it as needing a human and move on. That is a finding, not a failure.

## Write it

To `wiki/playbooks/<kebab-name>.md`, with frontmatter and ≥2 outbound links.

```markdown
# <Name>

**Trigger:** ...
**Output:** ...
**Approval required:** yes/no — and before what, exactly

## Steps
1. **<Step>**
   *What good looks like:* ...

## Failure modes
- <what goes wrong> → <how to notice> → <what to do>

## Done when
...

## Related
- [[...]]
```

## Then close the loop

1. **Run it once, with them watching.** Not later — now.
2. **Note where it went wrong.** Every failure is a missing "what good looks like."
3. **Fix the playbook, run it again.** Second run should be visibly better.
4. **Log it.** A line in `wiki/_changelog.md`, and add it to `wiki/_index.md`.

**A playbook that has never been run is a document, not a workflow.** Do not
count it as done until it has produced real output at least twice.
