Byte-for-byte `tmux capture-pane` output of the real Claude Code **2.1.325** on macOS, captured 2026-11-13 on the build Mac: a busy
turn with messages typed into it, which Claude Code queues. What it draws in and under the input box then is what Talos's key guard
reads before a pointer (a second message to a busy thread session is typed exactly this way).

## Method

- A private tmux server (`tmux -L <own socket> -f /dev/null`, never Talos's), a pane 120 columns by 40 rows, a new empty folder
  under `$TMPDIR` as the working directory, the folder trusted in the pane's own trust dialog.
- `claude --settings <file> --allowedTools 'Bash(sleep:*)' --strict-mcp-config`, run with an emptied environment (HOME, USER,
  LOGNAME, TMPDIR, TERM, LANG, PATH). The settings file turned off every plugin the account enables (the Telegram and iMessage
  channels among them), set `disableAllHooks`, set the permission mode to `default` and set a status line that prints a fixed
  Talos-style row. No MCP server was started. The status line printed nothing in these frames (the row under the box is Claude
  Code's own).
- A first turn ("Run the shell command: sleep 90. Then reply done.") put the sleep in a background shell, which is why the rows
  under the box say "1 shell". The busy turn captured is a second one, a 1500-word story with no tools; a third (a 600-word story)
  gave the 30-column frames of one queued message.
- During the turn, lines were typed with `send-keys -l` and entered with `send-keys Enter`: one (`queued-one`), a second
  (`queued-two`), the box then cleared (`-box-empty`), and a line typed and not entered (`queued-draft`). The pane was resized to 30
  columns for the `-30` frames; `queued-several-30` has three messages queued.
- Each frame was taken twice: plain (`.txt`) and with escapes (`-e`, `.ansi.txt`). Afterwards the `claude` process was stopped by
  its own pid and the tmux server by its socket.
- The working directory in the banner was replaced by `/home/alex/proj-xxx…` of the same width, and the plan name by "Claude Pro".

## What they show

- Once a message is queued, the empty box shows a DIM placeholder, `Press up to edit queued messages` (cut with "…" on a narrow
  pane): no draft, so the box reads empty. The queued message is drawn above the box with `ctrl+x ctrl+s to send now`.
- Under the box: `⏸ manual mode on · 1 shell · esc to interrupt · ↓ to manage`; with a draft in the box, `⏸ manual mode on · 1
  shell`; at 30 columns the row is cut at the edge: `⏸ manual mode on · esc to…`.
