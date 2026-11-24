Byte-for-byte `tmux capture-pane -p -J` output of the real Claude Code 2.1.329, captured 2026-11-20 by the coordinator in throwaway folders (the folder path, the plan name and an account banner are scrubbed)
(the originals were named a-before, a-before-2, b-before, b-after-4, a-after-1 and b-after-2 in the probe's output folder). Nothing was approved that mattered.

MEASURED (what these captures and the probe showed, for `PaneSelect`):
- A digit SELECTS AND SUBMITS on both the tool permission and the question Select, with no Enter.
- `bash-permission.txt`: the tool prompt, three rows (`1. Yes`, `2. Yes, and always allow access to <dir> from this project`, `3. No`), footer `Esc to cancel · Tab to amend`.
  `bash-permission-2.txt` is a second prompt of the same session.
- `askuser-select.txt`: the question with rows 1 to 4 (`4. Type something.`), a divider, `5. Chat about this`, footer `Enter to select · ↑/↓ to navigate · Esc to cancel`.
- `askuser-field-focused.txt`: the same question after the digit 4: the digit only MOVES THE CURSOR onto `4. Type something.`, and the footer becomes
  `Enter to select · ↑/↓ to navigate · ctrl+g to edit in VS Code · Esc to cancel`. (What the row shows once words are typed is not captured.)
- `after-esc-working.txt`, `after-question-answered.txt`: the screens after a prompt went (a working turn; the idle box). Not prompts.
- Once, the first Enter after a prompt appeared did not register.

`agents-panel-finished.txt` (added 2026-11-22): the rows under an empty box in a long-running thread session on 2.1.329, as the owner's pane showed
them (agent names only; the rows were copied as text, so the spacing between a task and its time is as copied, not a byte capture; the reply
line and the box above them are built to frame them). It shows the agents panel with FINISHED agents: `waiting on N shells · <task> · since
<Day> h:mm AM/PM`, a `stopped · 1d 16h 25m · ↓ 407.9k tokens` time, and the closing `↓ N more`. Before BoxFrame knew them the row under the box was
refused (`row_under_box`) every second for about 11 hours and the thread's messages went to the main agent.
