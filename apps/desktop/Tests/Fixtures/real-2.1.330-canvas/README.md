The row Claude Code **2.1.330** draws under its input box once a session has an Artifact canvas open, copied by the coordinator from the owner's
pane on 2026-11-22 (only this footer row; nothing else of the screen). `footer-row.ansi.txt` has the escapes (the only copy: a one-row file is no screen, so the capture table does not list it).

    ⏵⏵ bypass permissions on (shift+tab to cycle) · ⧉ canvas · esc to interrupt

What it shows: after the mode head, a new part `⧉ canvas` (U+29C9 and the text, in two colours). "canvas" is not a fixed label: 2.1.330's footer
component draws `⧉` and the open artifact's name (its file name without the extension, or its title, cut at 24 characters), or `⧉ N` when several
are open; this capture's artifact is simply named "canvas" (read from the component's own source by Opus review, not from a second capture).
BoxFrame.swift and box-frame.ts therefore read `⧉ ` and 1 to 24 characters of any printable text as one part, once, on a row that has a mode part
(never a row of its own), cut or not. Before this capture the row was refused whole (`status_part_refused shape=8:asu`) and the thread's messages
went to the main session.
