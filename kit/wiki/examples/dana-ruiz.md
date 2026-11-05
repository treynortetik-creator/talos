---
title: Dana Ruiz
type: person
tags: [example, operations]
created: 2026-01-15
updated: 2026-03-04
status: living
---

# Dana Ruiz

Ops lead. Owns the monthly close. My main counterpart on anything budget-shaped.

**How to work with her:** she wants the number and the source, in that order. Long preamble loses
her. If something slipped, say so in the first sentence.

**Open thread (2026-03-04):** waiting on her headcount figures for [[quarterly-budget-review]].

## Open questions
- Does Dana own the spend threshold herself, or does her director sign above a certain number?
  (She sends every approval I have seen, but nobody has said.)

## Related
- [[quarterly-budget-review]] — she owns the inputs
- [[weekly-status-rollup]] — she is on the distribution list

> **Notice what changed and what did not.** The top half is the same note it always was: short,
> current, readable in the two minutes before a meeting. Rewrite it as often as you like.
>
> **The bottom half is the receipts, and it is append-only.** Each line is one dated observation
> with a source, an author, and a confidence. Oldest first, new ones added at the bottom, and
> **nothing already written is ever edited or deleted** — `wiki-lint.py` checks that against git
> and fails the run if you try.
>
> **Why bother.** Look at the 2026-02-19 entry. That is the evidence behind the open question about
> the spend threshold — one data point, confidence `medium`, not a conclusion. In a note that gets
> rewritten in place, that observation disappears the next time somebody tidies the file, and six
> months later "Dana approves spend" is sitting in the body as a fact with nothing underneath it.
> Here the hunch stays a hunch until a second entry either confirms or kills it.
>
> **The routing rule:** a new fact either changes the current understanding (edit the top) or is
> raw evidence of what someone said or did (append to the bottom). Usually both — append first,
> then revise.
>
> This pattern is for `people/` and `partners/` only. Concepts and playbooks are already claims,
> not evidence, and forcing a timeline onto them is cargo-culting.
>
> Leave this file until `HOMEWORK.md` tells you to delete it; setup and week 1 use it as a reference.

<!-- TIMELINE:APPEND-ONLY -->
- **2026-01-15** | 1:1, verbal | @me — owns the monthly close end to end. Confidence: high
- **2026-01-15** | 1:1, verbal | @me — cut me off mid-preamble and asked for the number. Confidence: high
- **2026-02-02** | [[quarterly-budget-review]] | @dana-ruiz — said Q2 headcount is "not mine to hand out yet". Confidence: high
- **2026-02-19** | Slack DM | @me — approved a 12k line herself, no director in the thread. Confidence: medium
- **2026-03-04** | [[weekly-status-rollup]] | @me — headcount figures still outstanding, third ask. Confidence: high
