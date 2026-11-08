Byte-for-byte `tmux capture-pane -p -J` output of the real Claude Code 2.1.318 (pane 120x40), captured with a temporary
`CLAUDE_CONFIG_DIR` and `HOME`, a private `-L talos-test-*` tmux server and `--resume` of a session whose transcript holds one
user line and one reply. No prompt was ever submitted.

- `trust-dialog.txt`: the workspace-trust dialog of an untrusted folder. It has NO numbered options (`hideIndexes`): `❯ No, exit`
  then `  Yes, I trust this folder`, a rule row above, and the footer `Enter to confirm · Esc to cancel`.
- `empty-input.txt`: the resumed session with an empty input box. The input row is `❯` + U+00A0 + text, between two rule rows. An
  earlier user message in the history is drawn `❯` + an ASCII space.
- `draft-input.txt`: the same screen after `hello draft ` was typed into the box (nothing submitted).

- `mcp-consent.txt`: a project `.mcp.json` naming a harmless server (`echo`) in a trusted folder. Three UNNUMBERED options; the
  cursor starts on the LAST one (`❯ Continue without using this MCP server`). Footer `Enter to confirm · Esc to cancel`.
- `bypass-disclaimer.txt`: `claude --dangerously-skip-permissions` with a fresh config. `❯ No, exit` / `Yes, I accept`, unnumbered.
- `login-not-logged-in.txt`: a config dir with no credentials, `env -i` and an empty HOME (no keychain reached, nothing logged in).
  It is NOT a Select: the normal screen with an empty input box and the footer status `Not logged in · Run /login`.
  The "login expired" API-error text of a running session was not captured (it needs a real request, which is never sent).

The three newer files were captured the same way (temporary config dir seeded with onboarding done and the folder trusted,
private `-L talos-test-*` server, 120x40, `capture-pane -p -J`, server killed, nothing submitted, neutral path `/private/tmp/tsw/rc`).

## Prompts nobody named (captured 2026-11-04, Claude Code CLI 2.1.318)

Used by `PromptDetector` ("terminal prompts must relay to Talos"). Captured by hand in a private tmux server (`-L` a throwaway socket,
killed afterwards) at 120x40, `tmux capture-pane -p` (rows as drawn, no ANSI), with a temporary `CLAUDE_CONFIG_DIR` and the neutral
folder `/private/tmp/tcap/proj`, in manual permission mode. Every prompt was cancelled with Esc; nothing was approved and no tool ran.
The names here are the capture order of the session (01 to 11):

Prompts (a keypress is awaited):

- `bash-permission.txt` (07): the Bash tool permission. A rule row, `Bash command`, a tip line, a description, a `╌╌╌` box with the
  command, `Do you want to proceed?`, four options with `❯ 1. Yes`, footer `Esc to cancel · Tab to amend`.
  `bash-permission-6s.txt` (07b) is the same prompt six seconds later: ONE line differs, far above the prompt (`Creating hello.txt…`
  became `⏺ Creating hello.txt…`, a blinking activity dot). The prompt itself is identical, so stillness is measured on the prompt's
  own rows (from its frame rule down), not on the whole screen. `bash-permission-cursor2.txt` (07c) has the cursor on option 2; the
  footer then reads just `Esc to cancel`. Footers vary with the selection.
- `write-permission.txt` (09): the Write tool permission. `Create file`, `notes.txt`, a `╌╌╌` diff box, `Do you want to create
  notes.txt?`, three options, footer `Esc to cancel · Tab to amend`. `write-permission-6s.txt` (09b) is identical to it.
- `askuser-select.txt` (10): the agent's own multiple-choice question (AskUserQuestion). `☐ Color`, the question, `❯ 1. Red`, option
  descriptions, `3. Type something.`, a second rule, `4. Chat about this`, footer `Enter to select · ↑/↓ to navigate · Esc to cancel`.
  The cursor row is above the last rule. `askuser-select-6s.txt` (10b) is identical to it.
- `onboarding-theme.txt` (01): the first-run theme Select, on a fresh config directory only. No frame rule and no footer: `❯ ✔ Dark mode`
  with unnumbered siblings aligned under the label, then a code preview. It flags by structure alone.
- `trust-dialog-tcap.txt` (03): the folder-trust dialog again, from this session. It must stay the KNOWN trust dialog, never "generic".

Not prompts:

- `idle-input-auto.txt` (04) and `idle-input-manual.txt` (05): the idle input box. It has rule rows and a `❯` cursor line (a
  placeholder `Try "…"` after it, joined by U+00A0), and the status footer `⏵⏵ auto mode on (shift+tab to cycle)` or `⏸ manual mode on ·
  ? for shortcuts`. It looks framed and cursored and is not a prompt.
- `turn-done.txt` (06) and `after-esc.txt` (08): a finished turn and an interrupted one, then the idle box.
- `reply-quotes-prompt.txt` (11): the agent's REPLY quoting `Do you want to proceed?`, `❯ 1. Yes`, `2. No` and `Esc to cancel · Tab to
  amend` in the transcript, with the real idle box below it. Ordinary output with the same words.
- `onboarding-security-notes.txt` (02): `Press Enter to continue…`. A wait for Enter, not a Select, and not detected.

Not captured: the computer-use access prompt. The structure rule (one `❯` cursor with aligned sibling options, in the region below the
last frame rule, no status bar, no input box around it) is meant to cover it and any other Select; there is no capture to test it on,
so it has no test of its own.

Tests use these files as they are. Do not edit them; capture again the same way when Claude Code changes.

## The input box with its colours (captured 2026-11-05, CLI 2.1.318)

`tmux capture-pane -e -p` (escape sequences kept) in a private tmux socket with a temporary config, 120x40, nothing submitted. Plain
text cannot tell a placeholder from a draft (all of them are `❯` + U+00A0 + text); the attributes can: the placeholder is drawn dim
(SGR 2) apart from one reverse-video cursor cell (SGR 7), a draft at normal intensity.

- `input-e-idle-placeholder.txt`: a fresh idle box. Input row: `ESC[39m❯` NBSP `ESC[7mT ESC[0;2mry ESC[0m ESC[2m"refactor ESC[0m ESC[2m<filepath>" ESC[0m`.
- `input-e-real-draft.txt`: the owner typed `hello draft`. Input row: `ESC[39m❯` NBSP `hello draft ESC[7m ESC[0m`.
- `input-e-draft-looks-like-placeholder.txt`: the owner typed `Try "fix lint errors"` literally. Same words as a placeholder, at normal
  intensity: a draft.
- `input-e-cleared.txt`: that draft deleted again; the placeholder is back.

## Permission prompts in bypass mode (perm-*.txt)

Captured against the real 2.1.318 in a private `-L talos-test-perm` tmux server (120x40, `capture-pane -p -J`), a temporary HOME and
`CLAUDE_CONFIG_DIR`, a throwaway agent folder at the neutral path `/private/tmp/tsw/perm/agent`, `--dangerously-skip-permissions`, a
channel stub that logs every `notifications/claude/channel/permission_request`, and a local stand-in for the model API that answers
with one scripted harmless tool call (a `touch` in the sandbox). Nothing was sent to a real model. Which of these reached the channel:

- `perm-ask-rule-bypass.txt`: a settings `permissions.ask` rule. RELAYED.
- `perm-hook-ask.txt`: a PreToolUse hook answering `ask`. RELAYED.
- `perm-subagent-ask.txt`: the same rule hit by a sub-agent (header `Bash command · from the general-purpose agent`). RELAYED.
- `perm-background-bash-ask.txt`: `run_in_background` Bash under an ask rule. RELAYED.
- `perm-dangerous-rm-bypass.txt` and `perm-dangerous-rm-t0..t3.txt`: `rm -rf` of the HOME folder. Claude Code asks even in bypass mode
  ("Dangerous rm operation on critical path") and NEVER sends a permission_request. The warning row counts down (`block this
  request in 1:54` ... `1:45`, three seconds between t0..t3) and the CLI blocks the call itself when it runs out.
- `perm-askuserquestion.txt`: the agent's own AskUserQuestion Select. Not a permission prompt; never relayed.

Tried and never prompted in bypass mode: Write to `.claude/settings.json`, `.git/config`, `.mcp.json`, `.claude/commands`, a path
outside the working folder, `~/.claude/CLAUDE.md`, `~/.ssh/config`, `~/.bashrc`; Bash with `$(...)` or `cd` out of the folder.

## The input row in every theme (`input-e-theme-*`, `capture-pane -e`)

Captured 2026-11-05 with CLI 2.1.318: a private `-L talos-test-cap3` socket, a fresh temp `CLAUDE_CONFIG_DIR` per theme (the theme
picked at onboarding), the neutral folder `/private/tmp/tcap/proj`, 120x40, manual permission mode. Nothing was submitted. Per theme
(`auto`, `light`, `dark-cb`, `light-cb`, `dark-ansi`, `light-ansi`; the default dark is `input-e-idle-placeholder` above) there are:

- `input-e-theme-<theme>-placeholder.txt`: the fresh idle box with its placeholder.
- `input-e-theme-<theme>-draft.txt`: the same box after typing `hello draft`.

The themes change the rest of the screen (the ANSI-only themes use no 256-colour codes at all; light greys are 241, dark 244), but the
input row is drawn the same way in every one: `ESC[39m❯` NBSP, then for the placeholder the first letter reverse-video
(`ESC[7m`) and the rest dim (`ESC[0;2m` / `ESC[2m`), and for a draft plain text with the reverse-video cursor cell after it.
`InputBoxThemeTests` pins that encoding: when a new CLI is captured and draws the row differently, it fails and says so.
