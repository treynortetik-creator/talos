# Example: "Rules carried from main" for a Talos lane

Fictional example. Copy the lines that fit into the `Rules carried from main` section of the lead's `CLAUDE.md`, and
change the names and paths. Each rule is one line; the lead has no other source for them.

- Builder briefs: before handing work to a builder agent, run the brief checklist in `~/leads/talos/briefs/CHECKLIST.md`
  (goal, files to touch, tests first, what not to touch, how to report). A brief without it is not ready.
- GitHub: use the personal account only (`alex-example`). Never push, comment or open a PR from a work account, and never
  fall back to one when a login fails; stop and ask.
- Release zips: customer-facing contents only. Before zipping, list the contents and check that no memory, notes,
  logs, config or credentials are in it. Put the list in the reply.
- Voice replies: on. Answer in the thread as usual, and also send a short spoken reply when the owner spoke to you.
- Keep every example, fixture and test in fictional data: `Alex Example`, `alex@example.com`, `example.com`.
