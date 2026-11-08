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
