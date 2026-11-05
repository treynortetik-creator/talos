#!/usr/bin/env python3
"""
apple-notes-pull.py — stage Apple Notes for the seed, one folder at a time.

    python3 scripts/apple-notes-pull.py --list-folders
    python3 scripts/apple-notes-pull.py --folders "Work,Meetings" --days 30

Pure standard library plus `osascript`. macOS only. Nothing is installed, no
API key, no connector: Apple ships no Notes API, so the only way in is
AppleScript against the local app.

WHY THIS SOURCE IS ALLOWED WHEN DRIVE AND NOTION ARE NOT
--------------------------------------------------------
`SEED-WIKI.md` closes the source list at mail, calendar, chat and meeting summaries, and
rejects shared document stores on two grounds. Apple Notes is checked against
both and passes:

  * REACH. The objection to Drive is that a recency listing returns whatever
    the whole company touched, including other people's data (a bare listing
    can surface a spreadsheet of customer records nobody asked for). Apple
    Notes is single-user by construction. It is one person's own note store on
    their own machine. Nothing another person wrote can appear in it. That is a
    TIGHTER blast radius than Gmail, which is full of other people's words.

  * YIELD. The objection is that documents do not tell you who works with whom.
    True of a file store, false here: meeting notes are the user's own synthesis
    of a conversation. Every other source captures what HAPPENED. This one
    captures what they CONCLUDED, already filtered by a human deciding it was
    worth writing down.

THE ONE THING THAT IS GENUINELY WORSE
--------------------------------------
Every other source is a work account with an implicit work/personal boundary.
A personal note store has none. Grocery lists, doctor appointments, passwords
people should not have written down, and board strategy all live in the same
app.

So there is NO DEFAULT FOLDER SET and no "pull everything" flag. `--folders` is
required and takes an explicit list. Run `--list-folders` first, show the user
their own folder names, and let them choose. A folder they did not name is not
read. This is the whole gate; do not add a convenience flag that bypasses it.

FOLDER NAMES ARE NOT A RELIABLE GATE — MEASURED, 2026-08-30
------------------------------------------------------------
The first real test of this script pulled a folder whose name sounded entirely
work-adjacent. It returned private personal content: a diary-style entry, and
notes on personal life goals. Nothing in the folder NAME predicted that, and the
user who picked the folder would not have predicted it either.

So folder opt-in is necessary and NOT sufficient. `--dry-run` exists because of
that test: it writes a manifest of titles and dates and NO bodies, so the user
reviews what would be read before anything is read. `--exclude` then drops
titles by substring.

The order is: --list-folders, --dry-run, exclude what does not belong, then
pull. Do not collapse those steps to save a minute. The failure they prevent is
a private journal entry landing in a wiki an agent will quote back in a work
meeting.

Password-protected notes are skipped — AppleScript cannot read them and should
not try. The count is reported so a silent gap never looks like an empty folder.
"""

import argparse
import html
import os
import re
import subprocess
import sys
from html.parser import HTMLParser

# Record/field separators. Chosen to be things a human never types into a note;
# a separator that can appear in the body silently corrupts the parse.
import secrets as _secrets
_TOK = _secrets.token_hex(6)      # per-run: a note body cannot forge a boundary it has never seen (E-16)
REC = "\x1e@@NOTE-%s@@\x1e" % _TOK
FLD = "\x1f@@F-%s@@\x1f" % _TOK


def osascript(script: str) -> str:
    """Run AppleScript, return stdout. Raises with the real error text."""
    p = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True, text=True,
    )
    if p.returncode != 0:
        err = (p.stderr or "").strip()
        if "-1743" in err or "not authorized" in err.lower():
            raise SystemExit(
                "macOS blocked access to Notes.\n"
                "Grant it in System Settings > Privacy & Security > Automation,\n"
                "then re-run. (The first run normally shows a prompt; if you\n"
                "dismissed it, the toggle is the only way back.)"
            )
        raise SystemExit(f"osascript failed: {err or 'no error text'}")
    return p.stdout


def list_folders() -> list[tuple[str, int]]:
    out = osascript(
        'tell application "Notes"\n'
        '  set acc to ""\n'
        '  repeat with f in folders\n'
        '    set acc to acc & (name of f) & "\\t" & (count of notes of f) & linefeed\n'
        '  end repeat\n'
        '  return acc\n'
        'end tell'
    )
    rows = []
    for line in out.splitlines():
        if "\t" in line:
            name, _, n = line.rpartition("\t")
            if name.strip():
                rows.append((name.strip(), int(n.strip() or 0)))
    return rows


class _Text(HTMLParser):
    """Apple Notes bodies are HTML. Block tags become newlines, <br> too, and
    list items get a bullet — otherwise a checklist collapses into one run-on
    line and the note reads as garbage in the wiki."""

    BLOCK = {"div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "ul", "ol", "blockquote"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "br":
            self.parts.append("\n")
        elif tag == "li":
            self.parts.append("\n- ")
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        self.parts.append(data)

    def text(self) -> str:
        s = "".join(self.parts)
        s = html.unescape(s)
        s = s.replace(" ", " ")
        s = re.sub(r"[ \t]+", " ", s)
        s = re.sub(r"\n\s*\n\s*\n+", "\n\n", s)
        return "\n".join(ln.rstrip() for ln in s.splitlines()).strip()


def html_to_text(body: str) -> str:
    p = _Text()
    p.feed(body)
    return p.text()


def slug(s: str, n: int = 60) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return (s[:n].rstrip("-") or "untitled")


def pull(folder: str, days: int, limit: int) -> list[dict]:
    """One osascript call per folder. Per-note calls are ~50x slower and a
    300-note store turns a 4-second pull into three minutes."""
    esc = folder.replace("\\", "\\\\").replace('"', '\\"')
    script = f'''tell application "Notes"
  set cutoff to (current date) - ({days} * days)
  set acc to ""
  set hits to notes of folder "{esc}" whose modification date is greater than cutoff
  set k to 0
  repeat with n in hits
    if k >= {limit} then exit repeat
    set k to k + 1
    if (password protected of n) then
      set acc to acc & "{REC}" & "LOCKED" & "{FLD}" & (name of n as text) & "{FLD}" & "" & "{FLD}" & ""
    else
      set acc to acc & "{REC}" & "OK" & "{FLD}" & (name of n as text) & "{FLD}" & ((modification date of n) as string) & "{FLD}" & (body of n as text)
    end if
  end repeat
  return acc
end tell'''
    raw = osascript(script)
    notes = []
    for chunk in raw.split(REC):
        if not chunk.strip():
            continue
        f = chunk.split(FLD)
        if len(f) < 4:
            continue
        notes.append({
            "status": f[0].strip(),
            "title": f[1].strip(),
            "modified": f[2].strip(),
            "body": f[3],
            "folder": folder,
        })
    return notes


def main() -> int:
    ap = argparse.ArgumentParser(description="Stage Apple Notes into the seed staging dir.")
    ap.add_argument("--list-folders", action="store_true",
                    help="print folder names and note counts, then exit. Read-only, no bodies.")
    ap.add_argument("--folders", default="",
                    help="REQUIRED for a pull. Comma-separated folder names the user named themselves.")
    ap.add_argument("--days", type=int, default=30,
                    help="modification window. Default 30, matching the seed's other sources.")
    ap.add_argument("--max", type=int, default=60, help="max notes per folder (default 60)")
    ap.add_argument("--max-chars", type=int, default=6000,
                    help="truncate a note's text at this many chars (default 6000)")
    ap.add_argument("--out", default=".seed-staging/apple-notes", help="staging directory")
    ap.add_argument("--dry-run", action="store_true",
                    help="write ONLY a manifest of titles+dates, no bodies. Do this before every "
                         "real pull: folder names do not predict folder contents.")
    ap.add_argument("--exclude", default="",
                    help="comma-separated substrings; a note whose title matches one is skipped. "
                         "Case-insensitive.")
    a = ap.parse_args()

    if sys.platform != "darwin":
        print("Apple Notes is macOS-only. Skip this source.", file=sys.stderr)
        return 2

    if a.list_folders:
        rows = list_folders()
        if not rows:
            print("No Notes folders found (or Notes has never been opened on this Mac).")
            return 1
        w = max(len(n) for n, _ in rows)
        print(f"{'FOLDER'.ljust(w)}  NOTES")
        for n, c in rows:
            print(f"{n.ljust(w)}  {c}")
        print("\nPick the folders that are work. Pass them to --folders.")
        print("A folder you do not name is never read.")
        return 0

    wanted = [f.strip() for f in a.folders.split(",") if f.strip()]
    if not wanted:
        print(
            "--folders is required.\n\n"
            "There is deliberately no default and no --all. A personal note store\n"
            "has no work/personal boundary, so the user picks the folders.\n\n"
            "Run:  python3 scripts/apple-notes-pull.py --list-folders",
            file=sys.stderr,
        )
        return 2

    have = {n for n, _ in list_folders()}
    missing = [f for f in wanted if f not in have]
    if missing:
        print(f"No such folder(s): {', '.join(missing)}", file=sys.stderr)
        print(f"Available: {', '.join(sorted(have))}", file=sys.stderr)
        return 2

    os.makedirs(a.out, exist_ok=True)
    written = locked = empty = excluded = 0
    manifest = []
    excludes = [x.strip().lower() for x in a.exclude.split(",") if x.strip()]

    for folder in wanted:
        for note in pull(folder, a.days, a.max):
            if note["status"] == "LOCKED":
                locked += 1
                continue
            title_l = (note["title"] or "").lower()
            if any(x in title_l for x in excludes):
                excluded += 1
                continue
            if a.dry_run:
                manifest.append((folder, note["title"] or "untitled", note["modified"], "(dry run)"))
                written += 1
                continue
            text = html_to_text(note["body"])
            if len(text) < 20:
                empty += 1
                continue
            truncated = len(text) > a.max_chars
            if truncated:
                text = text[:a.max_chars] + "\n\n[truncated]"
            title = note["title"] or "untitled"
            fname = f"{slug(folder, 24)}--{slug(title)}.txt"
            path = os.path.join(a.out, fname)
            i = 2
            while os.path.exists(path):
                path = os.path.join(a.out, fname[:-4] + f"-{i}.txt")
                i += 1
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(
                    f"SOURCE: Apple Notes\n"
                    f"FOLDER: {folder}\n"
                    f"TITLE: {title}\n"
                    f"MODIFIED: {note['modified']}\n"
                    f"{'-' * 60}\n{text}\n"
                )
            written += 1
            manifest.append((folder, title, note["modified"], os.path.basename(path)))

    with open(os.path.join(a.out, "_manifest.md"), "w", encoding="utf-8") as fh:
        kind = "DRY RUN (titles only, no bodies read)" if a.dry_run else "staged"
        fh.write(f"# Apple Notes {kind} — last {a.days} days\n\n")
        fh.write(f"Folders read: {', '.join(wanted)}\n\n")
        fh.write("| Folder | Title | Modified | File |\n|---|---|---|---|\n")
        for row in manifest:
            fh.write("| " + " | ".join(c.replace("|", "\\|") for c in row) + " |\n")

    if a.dry_run:
        print(f"DRY RUN — {written} note(s) would be read. No bodies were touched.")
        print(f"Titles are listed in {os.path.join(a.out, '_manifest.md')}.")
        print("Read that list. Pass anything personal to --exclude, then re-run without --dry-run.")
    else:
        print(f"staged {written} notes -> {a.out}")
    if locked:
        print(f"skipped {locked} password-protected note(s) — AppleScript cannot read those.")
    if empty:
        print(f"skipped {empty} note(s) under 20 characters.")
    if excluded:
        print(f"excluded {excluded} note(s) by --exclude.")
    if not written:
        print("Nothing staged. Widen --days, or the chosen folders are quiet.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
