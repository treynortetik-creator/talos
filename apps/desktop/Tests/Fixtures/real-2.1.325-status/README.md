Byte-for-byte `tmux capture-pane` output of the real Claude Code **2.1.325** on macOS, captured 2026-11-13 on the build Mac: what
Claude Code draws in and under its input box in states a thread session goes through, each at 120, 60 and 30 columns (`-120`,
`-60`, `-30`), plain (`.txt`) and with escapes (`.ansi.txt`).

## Method

The same rig as ../real-2.1.325-queued (its README): a private tmux server, a scratch folder under `$TMPDIR`, `claude --settings
<file>` with every plugin turned off, `disableAllHooks`, permission mode `default` and a fixed status line, `--strict-mcp-config`,
an emptied environment; each session stopped by its own pid and its tmux server by its socket; the raw copies deleted afterwards.
Each frame was taken at 120 columns, then the window resized to 60 and to 30 and taken again.

- Session A, `--allowedTools 'TodoWrite,Bash(sleep:*)'`: idle in each permission mode, cycled with shift+tab (`idle-manual`,
  `idle-accept-edits`, `idle-plan`); "Run the shell command: sleep 20, in the background" (`bg-running` during the turn,
  `bg-idle-shell` after it with the shell still running, `bg-finished` after its completion notice); a todo list made with
  TodoWrite during a story turn (`todo-busy`).
- Session B, `--allowedTools 'Task'` only: one general-purpose subagent writing an essay (`subagent-busy` with the agents panel,
  `subagent-later`, `subagent-done`).
- Session C, `--mcp-config` naming one stdio server that exits at once (`/usr/bin/false`), no other server: `mcp-failed`. Claude Code
  2.1.325 drew no notice for it under the box.

Replaced, each by text of the same width: the working directory in the banner (`/home/alex/proj-xxx…`, also where a narrow pane
wraps it), the plan name ("Claude Pro"), and the account's usage line above the box (50%, a made-up date, the zone `UTC`).

## What they show under the box

`⏸ manual mode on`, `⏵⏵ accept edits on`, `⏸ plan mode on` (with `(shift+tab to cycle)` when it fits, cut as `(shift+tab` at 30
columns), then Claude's own parts: `? for shortcuts`, `1 shell`, `esc to interrupt`, `↓ to manage`, `/tasks to see subagents`,
`ctrl+t to hide tasks`, the last one cut with "…" at the edge. The agents panel under it: `⏺ main` and a subagent's row, its name,
its task (cut or left out on a narrow pane), its time and its token count with an UP arrow (`3s · ↑ 50 tokens`; `6s · ↑` at 30).

## When Claude Code draws something new

The key guard reads the row under the box exactly, except for up to two short plain parts (ASCII lower-case words, digits and
`/+.:,-`) after a mode head seen here. Anything else refuses the key, and the audit gets `status_part_refused` with the part's
length and character classes (or `mode …` for a mode head not seen here). A status_part_refused in the audit means: capture it and
add it (a new capture here, the row's part in BoxFrame.swift and box-frame.ts, and the shared table). The shape is "<code points>:<kinds>", kinds a A N s p u.
