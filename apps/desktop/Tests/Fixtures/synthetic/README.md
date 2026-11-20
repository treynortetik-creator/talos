SYNTHETIC screens, not captures: each is a real capture from `../real-2.1.318` with a few words changed by `sed`, for a test that needs
"another prompt of the same kind". Never used as evidence of what Claude Code draws.

- `bash-permission-other.txt`: `bash-permission.txt` with the command `touch hello.txt && ls -l hello.txt` changed to `rm -rf build && ls -l`.
- `trust-changed-option.ansi.txt`: `real-2.1.319/needs-you-capture/01-trust-first.ansi.txt` (the cursor on "No, exit"; the escape codes are kept, the way
  `tmux capture-pane -e` wrote them) with the word after "Yes, I trust this folder" changed to `and delete everything`: "another option" for the
  needs-you tests (`dialog-real.sh`).
- `trust-other-folder.ansi.txt`: the same capture with the folder path changed to `/private/tmp/some-other-folder`.
- `mcp-wrapped-a-{0,1,2}.ansi.txt`, `mcp-wrapped-b-{0,1,2}.ansi.txt`: `real-2.1.319/needs-you-capture/22-mcp-up2`, `21-mcp-up` and `20-mcp-first` (the MCP consent dialog with the cursor on row 0, 1 and 2; escape codes kept)
  with the server name `harmless` replaced by a longer name that continues on a second row (`first-server-na` / `me-wrapped-a`, and `second-server-n` / `ame-wrapped-b`): a server name wrapped over two rows, so the
  Mac reads no subject; two such dialogs that differ only in the wrapped text, for the needs-you tests of "the next dialog looks the same" (`dialog-real.sh`).
- `busy-transcript.txt`: written by hand, not a capture: a turn at work (a tool running, the spinner row, no input box and no prompt), for "another screen
  between two looks at the same prompt" (`worker-real.sh`).
- `usage-limit*.txt`: written by hand, not captures (no real capture of the screen exists yet): Claude Code's usage-limit screen, from the
  strings in the 2.1.323 binary read on 2026-11-12 ("You've hit your … limit", "Stop and wait for limit to reset", "Wait here, then continue
  automatically when the limit resets", "Continue with usage credits") and the owner's description of the third option ("Switch to usage
  credits"). `usage-limit.txt` (a model and a reset time with a zone, the cursor on 1), `-cursor3` (the cursor on the credits row),
  `-session` (no model, a day and a time), `-weekly-model` (a model with a version, two options), `-quoted` (the same words in a
  conversation that ends in the input box: NOT the screen) and `-after-esc` (the idle box). Replace with a capture when one is made
  (`docs/CAPTURE-USAGE-LIMIT.md`: read-only, no key to the pane).
- `usage-limit-{add-funds,switch-to-usage,admin,upgrade-only,footer-status,hint-row,narrow}.txt`: written by hand (2026-11-13), the same
  menu in the other forms the 2.1.323 binary carries (read from its strings after Fable's review of the Linux port): the options "Add funds
  to continue with usage credits", "Switch to usage billing", "Ask your admin for more usage", "Wait for limit to reset" and "Upgrade your
  plan for higher session limits every month"; the headlines "You've hit your weekly limit", "... 5-hour limit", "... team's shared
  budget"; a status row under the footer; a hint row under the last option; and the menu wrapped in a 30-column pane. Made by a small
  generator from `usage-limit.txt`'s top rows, never captured.
- `usage-limit-quoted-{user-status,old-model-row}.txt` and `usage-limit-fake-frame-status.txt`: written by hand (2026-11-13), not
  captures. `-quoted` with a row under the input box that is no status row Talos allows (an owner's own status line; the old recorder's bare
  model): still the quoted menu, NOT the screen (whether the menu is live never depends on the rows under the box). `usage-limit.txt` with a
  status line that draws a frame of its own under the live menu (two rules and a `❯` row, indented as Claude Code draws every status row):
  still the screen (only Claude's own frame, drawn from the first column, proves the menu quoted).
- `unknown-menu-under-box.txt`: written by hand (2026-11-13), not a capture: `real-2.1.318/empty-input.txt` with two rows of a made-up menu (an
  arrow, no numbers, no footer) added under the status row. A select no reader names, under Claude's empty input box: the key guard's test that
  the pointer is never typed when anything but Claude Code's own status rows sits under the box (`KeyGuard`, KeyGuardIntegrationTests).
- `first-start-login-success.txt`: written by hand from the owner's words for the screen after a sign-in (`Login successful. Press Enter to
  continue…`); there is no real 2.1.322 capture of it yet (the first-start captures stop at the sign-in screens). Evidence of nothing but the
  matcher's shape.
- `first-start-oauth-paste.txt`: written by hand from the CLI's own two lines the Linux reader keys on (`Paste code here if prompted`,
  `Browser didn't open? Use the url below to sign in`), for the same reason.
- `bypass-disclaimer-{0,1}.ansi.txt` and `dev-channels-{0,1}.txt`: written by hand (2026-11-19), not captures: the real `real-2.1.318/bypass-disclaimer.txt` and
  `real-dev-channels/dev-channels-capture.txt` with the cursor row drawn at each of its two positions (the bypass cursor row coloured as the real
  trust and MCP dialogs colour theirs, `ESC[38;5;153m` ... `ESC[39m`). They are what `fake-claude/dialog-real.sh` (`FAKE_DLG=bypass|dev`) prints so
  the card and popup answer paths can be driven with arrow keys on a real tmux pane.
- `bypass-disclaimer-partial.txt`: the real bypass disclaimer with its `Yes, I accept` row removed (written by hand, 2026-11-19): a disclaimer the reader
  must refuse, so the thread gets the no-card line and no card.
