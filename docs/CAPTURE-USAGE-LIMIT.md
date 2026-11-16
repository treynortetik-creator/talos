# Capturing Claude Code's usage-limit menu (safely)

No real capture of Claude Code's usage-limit menu exists yet. Every test of it (`apps/desktop/Tests/Fixtures/synthetic/usage-limit*.txt`)
is written by hand from the strings in the binary. The menu ("You've hit your … limit", then options to stop and wait, to wait and
go on by itself, and to go on with **usage credits**) can spend the owner's money with one key. So the first session, person or
machine that sees it for real saves it, read-only, as described here. Nothing in this procedure sends a key to the pane.

## The rules

- **Press nothing in that pane.** No Enter, no digit, no arrow, no Escape, no typing, no mouse click in it. Do not `tmux attach` to
  it to look: an attached client can send keys by accident. Read it from outside with `capture-pane`, which only reads.
- The session at its limit cannot do this itself (it is stopped at the menu). Another session, or the owner, takes the capture.
- The owner decides what to do with the menu afterwards. Talos never answers it.

## Steps (a pane under the Talos supervisor, Linux or Mac)

The supervisor's panes are on the tmux socket `talos` (`TMUX_SOCKET`; `TALOS_SUPERVISOR_TMUX_SOCKET` overrides it in tests). Thread
sessions are named `t-<thread id>`.

1. Find the pane that shows the menu (this only reads):

   ```sh
   for p in $(tmux -L talos list-panes -a -F '#{pane_id}'); do
     tmux -L talos capture-pane -p -t "$p" | grep -q "hit your" && echo "$p"
   done
   ```

2. Wait about two seconds after it appears (a frame still drawing is not the menu), then save it twice, with colours and plain,
   from the same moment:

   ```sh
   P=%12   # the pane id from step 1
   D=$(mktemp -d)
   tmux -L talos capture-pane -p -e -t "$P" > "$D/usage-limit-1.ansi.txt"
   tmux -L talos capture-pane -p    -t "$P" > "$D/usage-limit-1.txt"
   tmux -L talos display -p -t "$P" '#{pane_width}x#{pane_height}' > "$D/size.txt"
   ```

   Do not pass `-J`: the readers work on the pane's rows as drawn, wrapped rows included. Take a second pair a few seconds later
   (`usage-limit-2.*`); if the two differ, keep both (the menu redraws, and that is worth having).

3. Note the Claude Code version from another shell (`claude --version` reads nothing from the pane), the pane size from `size.txt`,
   the date, and which kind of session it was (Main, a thread, a fleet session).

4. Keep ONLY the menu's own frame. A full-pane capture also holds the conversation above the menu: the owner's messages, Main's
   replies, tool output. `check-no-personal.sh` is rule-based and would pass all of that, so it is taken out by position, not by
   searching for it:
   - the frame starts at the solid rule above the menu's headline (or at the headline when there is no rule) and ends at its last
     option or footer row; the rows under it, if any (a status row, an input box), are Claude Code's own and stay;
   - EVERY row above the frame is replaced by this one fixed line, row for row, so the row count and the menu's position stay as
     captured: `[a row of the conversation above the menu, removed]` (in the `.ansi.txt` too, with no escape codes on it);
   - in the frame itself, replace a home path, an account or organisation name or an email address with a placeholder of the SAME
     width (for example `/home/alex/proj` padded to the original length), so no column moves; edit the `.ansi.txt` and the `.txt`
     the same way.

5. Read the result top to bottom, both files, before anything is committed: only placeholder rows, then the menu, then Claude
   Code's own rows under it. Then run `bash scripts/check-no-personal.sh` (a second check, never the only one).

6. Delete the raw copies: `rm -r "$D"` (the folder `mktemp -d` printed in step 2, under `$TMPDIR` or `/tmp`). Say in the commit
   that they were deleted. A raw capture is never copied anywhere else, never attached to a message, never pasted into a session.

## Where it goes

- The files (steps 4 to 6 done) go into `apps/desktop/Tests/Fixtures/real-<version>/` (a new folder for a version with none), named
  `usage-limit-<n>.txt` and `usage-limit-<n>.ansi.txt`, with a line in that folder's README: version, pane size, date, kind of
  session, and what was replaced in step 4.
- The Linux key-guard table test (`apps/bridge/test/supervisor/usage-limit.test.ts`, "every real capture") fails until the new
  capture has a row there. Its row must be `-` (no key for any intent), and `isUsageLimit` must be true on it. If either is not, the
  reader is wrong about the real screen: that is the finding, and it is fixed in the reader, never in the capture.
- The Mac's `UsageLimitScreen` tests get the same capture (Delphi mirrors it).
- `synthetic/README.md` and the usage-limit section of `docs/OPTION-C.md` then say a real capture exists, and which.

## A session outside tmux

A Claude Code session in a plain terminal window (not under the supervisor) cannot be read by `capture-pane`. Do not select text
there with the mouse: a terminal app that turns mouse reporting on receives clicks and drags as input. Take a screenshot of the
window instead (the system's screenshot key or tool; nothing reaches the terminal), and transcribe it row for row into
`usage-limit-<n>.txt`, with no `.ansi.txt`, saying in the README that it was transcribed from a screenshot. Transcribe only the
menu's frame (step 4: the rows above it become the fixed placeholder line), read it through (step 5), and delete the screenshot
once the transcription is committed (step 6). It is still evidence of the words and the layout, without the colours.
