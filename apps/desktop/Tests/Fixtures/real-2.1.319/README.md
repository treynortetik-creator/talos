Byte-for-byte `tmux capture-pane` output of the real Claude Code **2.1.319** (`claude --version` said 2.1.319, not 2.1.318; tmux 3.8),
captured 2026-11-06 on the owner's Mac by `capture-owed-line.sh` in this folder: what the real input box does with Talos's pointer
line (`PointerTyper.text`, 53 characters) and with the 53 Backspaces that take it out. Used by `OwedLineCaptureTests`. Do not edit
the captures; run the script again the same way when Claude Code changes.

## Method

Logged out (no credentials, so no model request can be made), `env -i` with a temporary `HOME` and `CLAUDE_CONFIG_DIR` (onboarding marked
done and the folder trusted, so the first screen is the input box), a private `-L talos-test-*` tmux server, a throwaway folder.
Pane 120x40 first, then `resize-window` to 40 and to 30 columns (40 rows each). `capture-pane -p -J` for the `.txt` files and
`capture-pane -e -p -J` for the `.ansi.txt` copies (the colours: the draft check tells a dim placeholder from text by them).
**Nothing was submitted: Enter is never sent.** The server is killed and the temp dirs are removed on every exit.

The first screen showed the input box, the footer status `Not logged in · Run /login`, and the auto-mode banner
(`⏵⏵ auto mode on (shift+tab to cycle)`) on the row below the box's lower rule, as `01-first.txt` shows.

## What they show

- At 120 columns our line is on one row (`❯` + U+00A0 + the text). One `send-keys` with 53 `BSpace` empties the box, the same as 53
  calls with one key each (`03-after-burst-120` and `04-after-split-120`): `TmuxCommands.sendBackspaces` needs no change.
- At 40 columns the line wraps at the space before `Call` (`❯ Talos: new message in this thread.` / `  Call read_inbound.`). At 30
  columns it takes three rows, breaking after `this` and after `Call`. Continuation rows are indented two spaces and carry no `❯`.
  The one burst empties the box at both widths.

## Files (`owed-capture/`, each as `<name>.txt` and `<name>.ansi.txt`)

- `01-first`: the first screen, before anything is typed (120x40).
- `02-typed-120`: our line typed at 120 columns (one row).
- `03-after-burst-120`: after one `send-keys` of 53 `BSpace`: the box is empty.
- `03b-cleared-120`: after 70 more single `BSpace` (the script's clean-up): still empty.
- `04-after-split-120`: our line typed again, then 53 `BSpace` one per call: empty.
- `05-typed-40`: our line typed at 40 columns (two rows).
- `05-typed-30`: our line typed at 30 columns (three rows).
- `06-after-burst-40`: the 40-column line after one burst of 53 `BSpace`: empty.
- `06-after-burst-30`: the 30-column line after one burst of 53 `BSpace`: empty.
- `06b-cleared-40`: after the clean-up at 40 columns: empty.
- `06b-cleared-30`: after the clean-up at 30 columns: empty.
