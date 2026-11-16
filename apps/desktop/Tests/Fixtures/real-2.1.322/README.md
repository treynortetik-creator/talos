`tmux capture-pane -p` output of the real Claude Code 2.1.322, captured 2026-11-11 in a private `-L talos-test-cap322-*` tmux server
(killed afterwards) with a temporary `HOME` and `CLAUDE_CONFIG_DIR`, the neutral folder `/private/tmp/tsw322/thread`,
`--dangerously-skip-permissions`, no plugins and no MCP servers, and a local stand-in for the model API that answers with scripted tool
calls. Nothing was sent to a real model. Every prompt was cancelled with Esc: nothing was approved and no `rm` ran.

The scripted turn: the main session starts a background sub-agent of a project agent named `talos-builder`
(`.claude/agents/talos-builder.md` in the sandbox), and the sub-agent calls Bash with
`bash -c 'unset $(env | grep -o "^TALOS_[A-Z_]*"); export TMPDIR=…; echo gate step 1 ok; … rm -f …/old.log'`. A `-c` script longer
than 2,000 characters that runs `rm` is one Claude Code does not check, so it asks even in bypass mode:
`This shell -c script runs rm and could not be checked`. This is the prompt that sat in a thread session's pane on 2026-11-11.

Pane 150x53 unless the name says otherwise:

- `perm-subagent-rm-unchecked.txt`: the ask, one sub-agent. A rule row, `Bash command · from the talos-builder agent`, the call's
  description, a `╌╌╌` box with the script (each wrapped row starts `│ `), the reason, `Do you want to proceed?`, `❯ 1. Yes`, `2. No`,
  and the footer `Esc to cancel · Tab to amend · ctrl+x ctrl+k twice to stop background agents`. Fourteen captures one second apart
  were byte-identical: nothing in it ticks.
- `perm-subagent-rm-unchecked-cursor2.txt`: the same with the cursor on `2. No`. The footer is the same row.
- `perm-subagent-rm-withheld.txt`: a script of about 10,000 characters. It is not drawn: the box holds
  `(value cannot be shown in full — approval withheld; one-time options only)`. So the header never scrolls off for a long script.
- `perm-subagent-rm-120x40.txt`: the withheld ask on a 120x40 pane (the size the fake thread session of the integration tests draws).
- `perm-subagent-rm-two-agents.txt`, `perm-subagent-rm-queued-3.txt`, `perm-subagent-rm-queued-4.txt`: several sub-agents asking at
  once, six seconds apart each. The header row gains a right-aligned counter (`1 of 3`, then `1 of 4`) while the ask in front stays
  the same. The transcript above the rule says `Waiting for 9 background agents to finish`.
- `idle-agents-panel.txt`: NOT a prompt. The idle input box while a background agent runs: under the status bar
  (`⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents · ↓ to manage`) stand a blank row and the agents'
  rows (`⏺ main`, `◯ talos-builder (+2)  Verify the push … 4s · ↓ 36 tokens`), whose timer ticks. The status bar is no longer the last row.
- `idle-after-esc.txt`: NOT a prompt. The idle box after the ask was cancelled and the sub-agent ended.

While an ask is on the pane the agents' rows are not drawn under it (checked with a second, long-running sub-agent).

Tests use these files as they are. Do not edit them; capture again the same way when Claude Code changes.

## The computer-use permission dialog (captured 2026-11-12, CLI 2.1.322)

`tmux capture-pane -p -J` (and `-e` for the colour copy) of the real Claude Code 2.1.322 at 120x40, in a throwaway session in the
neutral folder `/private/tmp/tcap-cu/proj` on its own private tmux socket, `--dangerously-skip-permissions`, while macOS had NOT
granted Accessibility or Screen Recording to the program. The session was asked to call the computer-use tools
`list_granted_applications` (it does not raise the dialog: it returns "Accessibility and Screen Recording permissions are
required. Call request_access to show the permission panel.") and then `request_access`, which does.

- `computer-use-permissions.txt`: the dialog. A rule row, the title `Computer Use needs macOS permissions`, the rows
  `Accessibility: ✘ not granted` and `Screen Recording: ✘ not granted`, two rows of text, then three UNNUMBERED options with the cursor
  on the FIRST: `❯ Open System Settings → Accessibility`, `Open System Settings → Screen Recording`, `Try again`, and the footer
  `Enter to confirm · Esc to cancel`. Enter on the first row opens System Settings on the Mac: Talos only ever sends it Escape.
- `computer-use-permissions-6s.txt`: the same six seconds later. ONE row differs, above the dialog: `⏺ Calling computer-use 2 times…`
  became `  Calling computer-use 2 times · 15s…`, a ticking timer. So the screen never holds still while the dialog waits; the dialog's
  own rows (from its rule down) do.
- `computer-use-permissions-e.txt`: the dialog with its escape sequences (`-e`).
- `computer-use-permissions-after-esc.txt`: after Escape. The tool call returned to the model, which said the permissions are not
  granted, and the turn ended at the idle input box. Nothing was granted and the session was not stuck.

Tests use these files as they are. Do not edit them; capture again the same way when Claude Code changes.
