Byte-for-byte `tmux capture-pane -p -J` output of the real Claude Code 2.1.318 (pane 120x40), captured with a temporary
`CLAUDE_CONFIG_DIR` and `HOME`, a private `-L talos-test-*` tmux server and `--resume` of a session whose transcript holds one
user line and one reply. No prompt was ever submitted.

- `trust-dialog.txt`: the workspace-trust dialog of an untrusted folder. It has NO numbered options (`hideIndexes`): `❯ No, exit`
  then `  Yes, I trust this folder`, a rule row above, and the footer `Enter to confirm · Esc to cancel`.
- `empty-input.txt`: the resumed session with an empty input box. The input row is `❯` + U+00A0 + text, between two rule rows. An
  earlier user message in the history is drawn `❯` + an ASCII space.
- `draft-input.txt`: the same screen after `hello draft ` was typed into the box (nothing submitted).

Tests use these files as they are. Do not edit them; capture again the same way when Claude Code changes.
