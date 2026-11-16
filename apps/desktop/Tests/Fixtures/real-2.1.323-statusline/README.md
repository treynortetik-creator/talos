Byte-for-byte `tmux capture-pane` output of the real Claude Code **2.1.323** on Linux (tmux 3.x), captured 2026-11-13 on a Linux test
machine: what sits under the input box in a thread session, whose `--settings` carries Talos's own `statusLine` (the usage recorder,
`usageRecorderCommand` in packages/protocol/src/usage-readings.ts), and in a session with only the user's status line.

## Method

The real-2.1.319 README's method: logged out (no credentials, so no model request), `env -i` with a temporary `HOME` and
`CLAUDE_CONFIG_DIR` (onboarding marked done, the folder trusted), a private tmux server, a throwaway folder. **No key was sent at all.**
The temporary config's `settings.json` set a user `statusLine` that prints `USER-STATUS-LINE`.

- `user-only`: `claude` with no `--settings`: the user's status line renders under the box.
- `thread`: `claude --settings <file>` whose `statusLine` is the recorder (`python3 -I`, `env -i`): the recorder's row renders in place
  of the user's line (the `--settings` status line replaces it). Taken again the same day with the recorder's fixed prefix:
  `Talos: Opus 5.5` (logged out there is no rate-limit data, so no `| 7d: N%`).
- `-30`: the same pane resized to 30 columns: the recorder's row on its own row.
- `thread-long`, `thread-long-30` (taken on Claude Code **2.1.325**, the same method): the recorder **fed a faked status-line input**
  (`{"model":{"display_name":"Sonnet 4.5 (1M context)"},"rate_limits":{"seven_day":{"used_percentage":100}}}` piped into it in
  the `statusLine` command), because a logged-out session has no rate-limit data and a logged-in capture was not made. It prints
  the longest row it can, `Talos: Sonnet 4 | 7d: 100%` (26 characters: the model cut at 8), and the 30-column pane shows it whole.
  Measured the same way: Claude Code cuts a status row longer than 26 characters at 30 columns with an ellipsis (`Talos: Sonnet
  4.5 | 7d: 1…`, `Talos: Sonnet 4x | 7d: 10…`); that is why the recorder cuts the model at 8.

The key guard allows typing on `thread` and `thread-30`, and not on `user-only`: a user's own status line under the box is not a
row Claude Code or Talos draws (Main keeps the owner's line; Talos types no pointer into Main).

Each capture has a `.ansi.txt` copy (`-e`). The project path in the banner was replaced by `/home/alex/proj-xxx…` of the same width.

**Any change to what the usage recorder prints (`USAGE_RECORDER_PY`, `usageRecorderCommand`, and the Mac's `WorkerUsage.statusLine`)
needs a new capture here, the same way, and the key guard's row shape (`RECORDER_ROW` in apps/bridge/src/supervisor/box-frame.ts)
checked against it.** The guard refuses any row under a thread session's input box that it does not recognise, so a recorder that
prints a new shape would make every message to every thread session fall to Main (2026-11-13: this happened when the strict allowlist
landed without the recorder's row).
