#!/usr/bin/env python3
"""
wiki-lint.py — keep the knowledge base from rotting.

    python3 scripts/wiki-lint.py [wiki_dir] [--extra-dir DIR ...]

Pure standard library. No install, no config file.

Checks:
  1. Broken links      [[target]] with no matching note
  2. Orphans           notes NOTHING reaches -- not even the index
  3. Indexed only      in _index.md but no note cross-links it (soft)
  4. Thin links        notes with fewer than 2 outbound links (stubs exempt)
  5. Frontmatter       missing or incomplete
  6. Index integrity   notes missing from _index.md
  7. Relative time     "yesterday" / "recently" / "last week" in durable notes
  8. Unfilled tokens   leftover {{PLACEHOLDER}}
  9. Stale             status: living, not updated in STALE_DAYS
 10. Expired questions an "## Open questions" line past its verify-by date
 11. Frontmatter VALUES  status: must be a real status, dates must parse
 12. Changelog shape     _changelog.md dated entries must run newest-first
 13. Dossier pattern     notes that opted into <!-- TIMELINE:APPEND-ONLY --> must
                         obey it: one separator, well-formed ascending entries,
                         nothing edited or deleted below the line (vs git HEAD)
 14. Not yet converted   people/ and partners/ notes with no separator (warning)

WHY --extra-dir EXISTS (learned the hard way)
---------------------------------------------
If your notes link to files that live OUTSIDE the wiki directory -- a separate
meetings folder, a projects folder -- a linter that only scans the wiki will
report every one of those as a broken link. That is a checker crying wolf, and
a checker that cries wolf trains you to ignore it, which is worse than having
no checker at all.

So: pass every directory that can legitimately hold a link target.

    python3 scripts/wiki-lint.py wiki --extra-dir memory/meetings
"""

import unicodedata
import datetime
import os
import re
import subprocess
import sys
from collections import defaultdict

LINK_RE = re.compile(r"\[\[([^\]|#]+)")

# 🔴 TWO PARSER GAPS, BOTH FOUND IN PRACTICE, BOTH FALSE POSITIVES.
#
# (1) CODE SPANS AND FENCES. Documentation that *shows* link syntax -- a schema
#     template, a note explaining that renaming breaks inbound links -- types
#     [[example]] inside backticks. Backticks do not stop a regex. 22 of 47
#     reported broken links in a mature wiki turned out to be illustrative syntax in
#     real notes, i.e. nearly half the error count was one authoring habit
#     colliding with one parser blind spot.
#
# (2) ESCAPED PIPES INSIDE MARKDOWN TABLES. A piped link in a table cell must be
#     written [[slug\|Label]] -- the backslash is REQUIRED or the cell splits on
#     the pipe. The capture then swallows the backslash and the slug never matches.
#     That is a correctly-authored link the linter calls broken.
CODE_RE = re.compile(r"```.*?```|`[^`\n]*`", re.S)   # fenced blocks and inline spans
FM_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*(?:\n|\Z)", re.S)
TOKEN_RE = re.compile(r"\{\{[A-Z_]+\}\}")
RELTIME_RE = re.compile(r"\b(yesterday|today|tomorrow|recently|last week|next week|this morning)\b", re.I)
QUOTE_RE   = re.compile(r"^\s*>.*$|\u201c[^\u201d]*\u201d|\"[^\"\n]{0,400}\"|\*[^*\n]{0,400}\*", re.M)
DATED_NAME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}")

REQUIRED_FM = ["title", "type", "created", "updated"]
STALE_DAYS = 90            # a 'living' note nobody has touched in this long is a claim
                           # about January wearing today's clothes
OPENQ_RE   = re.compile(r"^##+\s*Open questions\s*$(.*?)(?=^##\s|\Z)", re.M | re.S)
VERIFYBY_RE = re.compile(r"verify[- ]by[: ]\s*(\d{4}-\d{2}-\d{2})", re.I)
STUB_RE    = re.compile(r"^status:\s*stub\s*$", re.M)

# 🔴 CHECKING THAT A KEY EXISTS IS NOT CHECKING ITS VALUE, and the gap is not
# cosmetic. Before this check, `status: livng` passed the frontmatter rule AND
# matched neither `living` nor `stub` -- so the typo silently exempted the note
# from the staleness check and from the stub rules at the same time. The note
# looked fine and was unpoliced. Enforce only the vocabulary this kit actually
# declares; inventing an enum the docs never stated would manufacture false
# positives, and a checker that cries wolf trains you to ignore it.
# ⚠️ FIRST DRAFT OF THIS SET WAS TOO NARROW AND IT MATTERED. Seeded from the
# kit template alone ({living, stub, superseded}), it flagged 42 notes in a real
# 1,150-note wiki -- 35 of which were perfectly legal `draft` notes. A checker
# that reports 42 problems where 7 exist is the wolf-crying failure this file
# warns about twice elsewhere. Seed this set from the vocabulary your OWN
# README declares, and widen it the moment you add a status, or the lint will
# punish correct notes.
VALID_STATUS = {"draft", "living", "stub", "superseded", "archived"}
# The vocabulary wiki/README.md actually documents. Unknown types used to pass silently,
# so a typo'd `type: conept` looked clean. (Adversarial review, 2026-08-26.)
VALID_TYPE = {"person", "project", "playbook", "concept", "meeting", "source",
              "framework", "competitor", "stat", "quote", "journal", "hobby",
              "account", "event", "partner", "vendor", "venue", "meta", "reference", "lint", "org"}
TYPE_RE = re.compile(r"^type:\s*(\S.*?)\s*$", re.M)
# Slugs that legitimately repeat in every directory and are never wikilink targets.
NON_LINKABLE_SLUGS = {"index", "README", "readme"}
STATUS_RE    = re.compile(r"^status:\s*(\S+)\s*$", re.M)
DATE_FM_RE   = re.compile(r"^(created|updated|stale_after):\s*(\S+)\s*$", re.M)

# Per-note staleness. A stat card and a person profile do not rot at the same
# rate, so a single global STALE_DAYS is always wrong for someone. A note may
# declare its own absolute expiry; absent one, the global default still applies.
STALE_AFTER_RE = re.compile(r"^stale_after:\s*(\d{4}-\d{2}-\d{2})\s*$", re.M)

# A changelog is only trustworthy if its order is. Newest-first is stated as a
# rule in the agent instructions and, until now, enforced by nothing.
CHANGELOG_DATE_RE = re.compile(r"^\s*(?:[-*|]\s*)?(?:\*\*)?(\d{4}-\d{2}-\d{2})\b", re.M)
META_PREFIX = "_"          # _index, _changelog etc are bookkeeping, not notes
EXAMPLE_DIR = "examples"   # shipped examples are exempt until deleted

# Schema/handshake docs are not notes. They legitimately contain illustrative
# links like [[dana-ruiz]] as EXAMPLES, have no frontmatter, and are never
# indexed. Linting them produces guaranteed false positives -- which is how a
# checker teaches you to ignore it.
META_NAMES = {"README", "CLAUDE", "CONTRIBUTING", "index"}   # "index" added 2026-08-25: per-directory index.md is generated, not a note

# --- DOSSIER PATTERN: compiled truth above the line, append-only timeline below ---
#
# The convention, which is decided and is not this file's to redesign:
#
#     <!-- TIMELINE:APPEND-ONLY -->
#     - **YYYY-MM-DD** | source | @author — evidence text. Confidence: high|medium|low
#
# 🔴 OPT-IN IS THE ENTIRE DESIGN OF THESE CHECKS. A mature vault has well over a hundred
# people notes, and only the first few get converted. An ERROR that fires on
# every UNCONVERTED note reports 130+ problems on day one -- the cry-wolf failure this
# file already warns about three times, and the fastest way to make someone stop
# reading the lint. So the split is:
#   * ERRORS fire ONLY on a note that ALREADY CONTAINS the separator. It opted in, so
#     it is held to the whole convention.
#   * "Not converted yet" is a WARNING, and it is the one that fires 130+ times.
# A note outside people/ and partners/ that opts in is still checked -- the convention
# is valid anywhere -- but it is never nagged for failing to opt in.
SEP_RE = re.compile(r"<!--\s*TIMELINE:APPEND-ONLY\s*-->")

# The strict entry format. Confidence is captured LOOSELY on purpose: `Confidence:
# certain` should be reported as a bad confidence VALUE, not as a malformed line.
# Two rules, two messages, two different fixes. The source field is matched
# non-greedily rather than as [^|]+ so that a piped wikilink ([[slug|Label]]) in the
# source position does not read as a third column; @author anchors the boundary.
ENTRY_RE = re.compile(
    r"^-\s+\*\*(\d{4}-\d{2}-\d{2})\*\*\s*\|\s*.+?\s*\|\s*@[A-Za-z0-9][A-Za-z0-9._-]*"
    r"\s+—\s+\S.*?\s*Confidence:\s*([A-Za-z]+)(?:\s*\([^)]*\))?\s*\.?\s*$"
)
# The loose SHAPE: a bullet leading with a bold ISO date and a pipe. Used to spot an
# entry that landed ABOVE the separator, and to read the date off a line the strict
# rule already rejected. The pipe is REQUIRED so that ordinary compiled-truth history
# bullets ("- **2026-08-01** — promoted to team lead") are not mistaken for entries.
ENTRY_SHAPE_RE = re.compile(r"^-\s+\*\*(\d{4}-\d{2}-\d{2})\*\*\s*\|")
VALID_CONFIDENCE = {"high", "medium", "low"}
MAX_TIMELINE = 40          # growth guard: past this, archive the oldest entries out
DOSSIER_DIRS = {"people", "partners"}   # where the pattern is expected, eventually
GIT_TIMEOUT = 5            # seconds -- a hung git must never hang the lint



def _iso_date(raw):
    """YYYY-MM-DD only. E-08 (review 2026-09-02): date.fromisoformat grew looser on 3.11+, so
    `20260902` and `2026-W36-3` linted clean on the maintainer's Python and failed on the managed
    Mac's 3.9.6. The accepted grammar is the kit's, not the interpreter's."""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(raw).strip()):
        raise ValueError("not YYYY-MM-DD: %r" % (raw,))
    return datetime.date.fromisoformat(str(raw).strip())

def mask_code(text):
    """Blank fenced blocks and inline spans WITHOUT moving a single offset.

    The separator is an HTML comment, so the note that DOCUMENTS this convention
    types it inside a fence. Without this, the design-rationale note looks converted
    and every prose line under it gets reported as a malformed entry -- crying wolf
    on the one note that explains the rule. Newlines survive, so line numbers and
    above/below-the-line positions stay true."""
    return CODE_RE.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), text)


def in_dossier_dir(path, root):
    # Relative to the WIKI ROOT only. Scanning the absolute path would flag every note in
    # a vault that merely happens to live under some directory named "people" or "partners".
    try:
        rel = os.path.relpath(os.path.abspath(path), os.path.abspath(root))
    except ValueError:
        return False
    return bool(DOSSIER_DIRS & set(os.path.normpath(rel).split(os.sep)[:-1]))


def short(line, n=68):
    s = " ".join(line.split())
    return s if len(s) <= n else s[:n - 3] + "..."


def split_timeline(text):
    """(lines_above, lines_below, separator_count).

    lines_below is None when the note never opted in, which is how every error rule
    below stays silent on the ~130 notes nobody has converted yet."""
    lines = mask_code(text).splitlines()
    count = sum(1 for ln in lines if SEP_RE.search(ln))
    for i, ln in enumerate(lines):
        if SEP_RE.search(ln):
            return lines[:i], lines[i + 1:], count
    return lines, None, 0


def split_timeline_raw(text):
    """The lines below the separator, UNMASKED.

    2026-08-27 (TALOS-13, reproduced): the append-only check used to compare masked
    text against masked text. mask_code() replaces every character of an inline code
    span with a space of the same width, so editing `old-value` to `new-value` inside
    a committed entry produced two byte-identical masked lines and the check passed.
    The tamper-evidence rule was blind precisely where a tamper would hide.

    Masking still decides WHERE the separator is -- that part was never the bug, and
    removing it would make the note that documents this convention (which types the
    separator inside a fence) fail its own rule. So: find the line with the mask,
    slice the raw text, compare raw bytes."""
    masked = mask_code(text).splitlines()
    raw = text.splitlines()
    for i, ln in enumerate(masked):
        if SEP_RE.search(ln):
            return raw[i + 1:]
    return None


def head_text(path):
    """The file's content at git HEAD, or None if git cannot answer.

    EVERY failure mode returns None and the append-only check is skipped in silence:
    no git binary, not a repo, untracked or brand-new file, empty/unborn HEAD, a
    timeout. A missing baseline is not evidence of a violation -- reporting one would
    make every new dossier note fail its first lint, which is the same cry-wolf
    failure in a different coat."""
    try:
        r = subprocess.run(
            ["git", "-C", os.path.dirname(os.path.abspath(path)) or ".",
             "show", "HEAD:./" + os.path.basename(path)],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=GIT_TIMEOUT)
    except Exception:
        return None
    if r.returncode != 0:
        return None
    return r.stdout.decode("utf-8", "replace")


def check_append_only(slug, path, text):
    """The invariant: what was below the line at HEAD must still be there, unchanged,
    as a PREFIX of what is below the line now. Appends are the only legal edit.

    Both sides are compared RAW (see split_timeline_raw). Comparing masked text here
    let equal-length edits inside inline code spans slip through untouched."""
    old = head_text(path)
    if old is None:
        return []
    old_below = split_timeline_raw(old)
    if old_below is None:
        return []                       # timeline is new since HEAD; all of it is append
    below = split_timeline_raw(text)
    if below is None:
        below = []
    was = [ln.strip() for ln in old_below if ln.strip()]
    now = [ln.strip() for ln in below if ln.strip()]
    for i, line in enumerate(was):
        if i >= len(now):
            return [(slug, "E6 APPEND-ONLY VIOLATION: entry deleted since git HEAD: "
                     + short(line))]
        if now[i] != line:
            return [(slug, "E6 APPEND-ONLY VIOLATION: entry changed since git HEAD: "
                     + short(line) + "  ->  " + short(now[i]))]
    return []


def timeline_findings(text):
    """The E1-E5 rules, line by line: ([(code, message, lineno, prev_lineno)], entry_count).

    ONE implementation of the timeline rules. check_timeline() (the lint) and
    new_timeline_violations() (the PreToolUse guard, hooks/timeline-guard.py) both call it, so the
    guard can never drift from the lint. entry_count is None for a note that has not opted in.
    lineno is 0-based into text.splitlines(); prev_lineno is the earlier line of an E3 pair, else None."""
    above, below, seps = split_timeline(text)
    if below is None:
        return [], None
    out = []
    base = len(above) + 1                 # index of the first line below the separator
    if seps > 1:
        second = [i for i, ln in enumerate(mask_code(text).splitlines()) if SEP_RE.search(ln)][1]
        out.append(("E1", f"E1 separator appears {seps} times (at most one per note)", second, None))
    for i, ln in enumerate(above):
        if ENTRY_SHAPE_RE.match(ln):
            out.append(("E4", "E4 timeline entry ABOVE the separator: " + short(ln), i, None))

    dates, entries = [], 0                # dates: (iso, lineno)
    for j, ln in enumerate(below):
        if not ln.strip():
            continue
        # A second separator is E1's finding. Do not ALSO report it as a malformed
        # entry and do not count it toward the growth guard -- one defect, one row.
        if SEP_RE.search(ln):
            continue
        if re.match(r"^#{1,6}\s", ln) or re.match(r"^_\(.*\)_\s*$", ln):
            continue        # a heading or an _(archive pointer)_ is scaffolding, not an entry
        entries += 1
        m = ENTRY_RE.match(ln.rstrip())
        if not m:
            out.append(("E2", "E2 malformed entry (want: - **YYYY-MM-DD** | source | "
                              "@author em-dash evidence. Confidence: high/medium/low): " + short(ln), base + j, None))
            shape = ENTRY_SHAPE_RE.match(ln)
            if shape:
                dates.append((shape.group(1), base + j))     # still order-checkable
            continue
        dates.append((m.group(1), base + j))
        if m.group(2).lower() not in VALID_CONFIDENCE:
            out.append(("E5", f"E5 Confidence: {m.group(2)} (expected one of "
                              f"{'/'.join(sorted(VALID_CONFIDENCE))})", base + j, None))
    for i in range(1, len(dates)):
        if dates[i][0] < dates[i - 1][0]:
            out.append(("E3", f"E3 dates out of order: {dates[i - 1][0]} followed by "
                              f"older {dates[i][0]} (ascending, newest appended last)", dates[i][1], dates[i - 1][1]))
    return out, entries


def check_timeline(slug, path, text):
    """(errors, entry_count). entry_count is None for a note that has not opted in."""
    found, entries = timeline_findings(text)
    if entries is None:
        return [], None
    errs = [(slug, msg) for _code, msg, _ln, _prev in found]
    errs.extend(check_append_only(slug, path, text))
    return errs, entries


# --- the write-time guard's view of the same rules --------------------------------------------------
ENTRY_FORMAT = "- **YYYY-MM-DD** | source | @author \u2014 evidence. Confidence: high|medium|low"
ENTRY_GOOD = ("- **2026-10-05** | [[2026-10-05-vendor-sync]] | @dana-ruiz \u2014 Said the vendor review moves to "
              "Friday; no owner named. Confidence: high")
ENTRY_BAD = ("- **2026-10-05** | [[2026-10-05-vendor-sync]] | @me via Lindsay \u2014 Said the vendor review moves to "
             "Friday. Confidence: high on the statement; the date is open")


def explain_entry_problem(line):
    """Why one line below the separator fails the entry rule, and what to do about it, in one sentence."""
    s = line.rstrip()
    if not s.strip():
        return "blank"
    if s[:1].isspace() or not s.startswith("- "):
        return ("not a dated entry. Either it is the hard-wrapped continuation of the entry above it (every entry is "
                "ONE physical line: join the text back onto it, do not wrap), or it is free prose (preamble, notes, a "
                "closing remark), which goes ABOVE the separator. The timeline holds only one-line dated entries.")
    if not ENTRY_SHAPE_RE.match(s):
        return ("an undated bullet below the separator (a Related link, an open question, a see-also). Those "
                "go ABOVE the separator, in a ## Related or ## Open questions section; below it, every bullet is a "
                "dated entry.")
    if not re.search(r"\|\s*@[A-Za-z0-9][A-Za-z0-9._-]*\s+\u2014\s+\S", s):
        if re.search(r"\|\s*@[A-Za-z0-9]", s):
            return ("the author field must be exactly @slug followed by ' \u2014 ' (an em dash). No 'via', no "
                    "parenthetical after the handle: put a relay or an inference in the evidence text.")
        return "the third field must be the author, @slug, followed by ' \u2014 ' (an em dash) and the evidence."
    if not re.search(r"Confidence:\s*[A-Za-z]+(?:\s*\([^)]*\))?\s*\.?\s*$", s):
        if "Confidence:" in s:
            return ("text follows the confidence value. The entry must END with 'Confidence: high|medium|low', "
                    "optionally one parenthetical, nothing after it (move nuance into the evidence or the parenthetical).")
        return ("the entry never reaches 'Confidence: high|medium|low' at its end of line. If it was wrapped, "
                "join it into one line; otherwise add the confidence tag.")
    return "does not match the entry format."


def _regions(text):
    """[(region, stripped raw line)] with region in {'above', 'sep', 'below'}; 'none' for a note with no separator."""
    masked = mask_code(text).splitlines()
    raw = text.splitlines()
    out, seen = [], False
    for i, ln in enumerate(raw):
        if i < len(masked) and SEP_RE.search(masked[i]):
            out.append(("sep", ln.strip()))
            seen = True
        else:
            out.append(("below" if seen else "above", ln.strip()))
    if not seen:
        return [("none", ln) for _r, ln in out]
    return out


def new_timeline_violations(old_text, new_text):
    """Timeline findings (E1-E5) that sit on lines NEW in new_text. -> [(code, lineno, line, why)].

    Used by the PreToolUse guard. A line is new when old_text holds no unconsumed identical line in the same region
    (above / separator / below), so a violation the file already carries never blocks an unrelated edit, and a line
    moved from above the separator to below it is judged. An E3 pair counts if either of its two lines is new
    (inserting an out-of-order entry in the middle is the writer's mistake, not the entry after it).
    Returns [] when the note has not opted in. Same rules as the lint: it calls timeline_findings()."""
    found, entries = timeline_findings(new_text)
    if entries is None or not found:
        return []
    raw = new_text.splitlines()
    if len(raw) != len(mask_code(new_text).splitlines()):
        return []                                  # line numbering is not trustworthy: fail open
    pool = defaultdict(int)
    for key in _regions(old_text or ""):
        pool[key] += 1
    is_new = []
    for key in _regions(new_text):
        if pool[key] > 0:
            pool[key] -= 1
            is_new.append(False)
        else:
            is_new.append(True)
    res = []
    for code, msg, ln, prev in found:
        if ln >= len(raw) or not (is_new[ln] or (prev is not None and is_new[prev])):
            continue
        if code == "E2":
            why = explain_entry_problem(raw[ln])
        elif code == "E3":
            why = ("this entry is dated earlier than the entry before it. Entries run oldest first, newest "
                   "appended at the BOTTOM; " + msg.replace("E3 ", "", 1))
        elif code == "E4":
            why = "a dated timeline entry sits ABOVE the separator; entries go below it."
        elif code == "E1":
            why = "a second <!-- TIMELINE:APPEND-ONLY --> separator; a note has at most one."
        else:
            why = msg
        res.append((code, ln + 1, raw[ln], why))
    return res


def collect(root):
    """slug -> path. Slugs are basenames, so two files can collide; report, never silently drop."""
    out, dupes = {}, []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fn in sorted(filenames):
            if fn.endswith(".md"):
                slug = unicodedata.normalize("NFC", fn[:-3])
                path = os.path.join(dirpath, fn)
                # Generated per-directory indexes and READMEs legitimately share a
                # basename in every folder and are never wikilink targets. Measured on the
                # real wiki: without this exemption the check fired 186 times, all of them
                # index.md/README.md, i.e. it would have been switched off within a day.
                if slug in NON_LINKABLE_SLUGS or slug.startswith(META_PREFIX):
                    out.setdefault(slug, path)
                    continue
                if slug in out:
                    # 🔴 2026-08-26 adversarial review: this used to overwrite, so a broken
                    # note could hide behind a valid twin and lint clean. Wikilinks are by
                    # slug, so a collision is also genuinely ambiguous for the reader.
                    dupes.append((slug, out[slug], path))
                    continue
                out[slug] = path
    return out, dupes


def is_meta(path):
    base = os.path.basename(path)[:-3] if path.endswith(".md") else os.path.basename(path)
    return base.startswith(META_PREFIX) or base in META_NAMES


def is_example(path):
    return os.sep + EXAMPLE_DIR + os.sep in path


def main():
    args = [a for a in sys.argv[1:]]
    extra = []
    while "--extra-dir" in args:
        i = args.index("--extra-dir")
        args.pop(i)
        if i < len(args):
            extra.append(args.pop(i))

    wiki = args[0] if args else os.environ.get("WIKI_DIR", "wiki")
    if not os.path.isdir(wiki):
        print(f"! no such directory: {wiki}")
        sys.exit(2)

    notes, dupes = collect(wiki)
    # Link targets may live outside the wiki. Resolve against everything.
    universe = dict(notes)
    for d in extra:
        if os.path.isdir(d):
            extra_notes, _ = collect(d)
            universe.update(extra_notes)
            # Collisions ACROSS roots are not defects: --extra-dir supplies separate
            # vaults and per-run scratch folders (a daily log and a personal journal
            # entry for the same date; a memo.md in every Agora run). Measured on the
            # real wiki, counting those produced 110 false errors. Only collisions
            # INSIDE the linted wiki make a [[wikilink]] genuinely ambiguous.
        else:
            print(f"  (note: --extra-dir {d} does not exist, skipping)")

    inbound = defaultdict(int)
    broken, thin, bad_fm, reltime, tokens, stale, expired = [], [], [], [], [], [], []
    bad_values, log_order, odd_type = [], [], []
    timeline, unconverted, oversized = [], [], []
    today = datetime.date.today()

    # Harvest links OUT OF the meta files first. _index.md is how most notes are
    # reachable at all, and the old code skipped meta before counting inbound --
    # which reported every index-only note as an orphan. A checker that cries
    # wolf trains you to ignore it, which is the one failure this file exists to
    # avoid. Index reach is tracked separately from note-to-note reach, because
    # counting it as ordinary inbound would make the orphan check always pass.
    index_reach = set()
    for slug, path in sorted(notes.items()):
        if not is_meta(path):
            continue
        try:
            mtext = open(path, encoding="utf-8-sig", errors="replace").read()
        except Exception:
            continue
        for t in LINK_RE.findall(mtext):
            index_reach.add(t.strip().split("/")[-1])

    for slug, path in sorted(notes.items()):
        if is_meta(path):
            continue
        try:
            text = open(path, encoding="utf-8-sig", errors="replace").read()
        except Exception as e:
            print(f"! unreadable: {path} ({e})")
            continue
        # strip code spans/fences first -- documented syntax is not a live link
        # strip code spans/fences first (documented syntax is not a live link), then
        # normalise path-style links to a basename -- an Obsidian vault root often sits ABOVE
        # wiki/, so [[../people/foo]] is a correct link, not a broken one -- then drop the
        # escape a table cell requires on a piped link.
        targets = {unicodedata.normalize("NFC", t.strip().split("/")[-1].rstrip("\\"))
                   for t in LINK_RE.findall(CODE_RE.sub(" ", text))}
        targets = {t for t in targets if t}

        is_stub = bool(STUB_RE.search(text))
        if not is_example(path):
            # A stub is SUPPOSED to be one line -- BOOTSTRAP orders them created so
            # the graph has no dead ends. Flagging them THIN punishes following the
            # instructions. They are still caught by the orphan check if nothing
            # ever links to them, which is the failure that actually matters.
            if len(targets) < 2 and not is_stub:
                thin.append((slug, len(targets)))
            for t in targets:
                if t not in universe:
                    broken.append((slug, t))

        for t in targets:
            if t in notes and t != slug:     # E-11: a self-link is not an inbound link
                inbound[t] += 1

        m = FM_RE.match(text)
        if not m:
            bad_fm.append((slug, "no frontmatter"))
        else:
            # require a NON-EMPTY value, not merely the key -- `title:` alone used to pass
            missing = [k for k in REQUIRED_FM
                       if not re.search(rf"^{k}:[ \t]*\S", m.group(1), re.M)]
            if missing:
                bad_fm.append((slug, "missing or empty: " + ", ".join(missing)))
            ty = TYPE_RE.search(m.group(1))
            if ty and ty.group(1) not in VALID_TYPE:
                odd_type.append((slug, f"type: {ty.group(1)}"))
            # values, not just keys -- see VALID_STATUS above for why
            st = STATUS_RE.search(m.group(1))
            if st and st.group(1) not in VALID_STATUS:
                bad_values.append((slug, f"status: {st.group(1)} (expected one of {', '.join(sorted(VALID_STATUS))})"))
            for key, raw in DATE_FM_RE.findall(m.group(1)):
                try:
                    _iso_date(raw)
                except ValueError:
                    bad_values.append((slug, f"{key}: {raw} is not a YYYY-MM-DD date"))

        body = text[m.end():] if m else text
        # 🔴 MEASURED ON A REAL 1,150-NOTE WIKI: this rule fired 190 times, and almost
        # none were defects. Two false-positive classes dominate:
        #   (a) QUOTED SPEECH. "the question that came up last week" inside a quotation
        #       is the speaker's words. The note is not making a relative-time claim.
        #   (b) DATED NOTES. A file named 2026-07-17-alex-1on1.md carries its anchor in
        #       its own filename, so "today" in it is unambiguous.
        # A rule that reports 190 problems where a handful exist is the cry-wolf failure
        # this file warns about elsewhere, and it trains you to skip the whole report.
        if not is_example(path) and not DATED_NAME_RE.match(slug):
            prose = CODE_RE.sub(" ", QUOTE_RE.sub(" ", body))   # strip quotes and code
            prose = "\n".join(l for l in prose.splitlines()
                              if not re.match(r"^\s*[-*|]?\s*\**\d{4}-\d{2}-\d{2}", l))  # dated lines carry their date
            if any(not m.group(0).isupper() for m in RELTIME_RE.finditer(prose)):  # TODAY as a label is fine
                reltime.append(slug)
        if TOKEN_RE.search(CODE_RE.sub(" ", text)):     # documented syntax is not a leftover token
            tokens.append(slug)

        if m and not is_example(path) and not is_stub:
            fm = m.group(1)
            declared = STALE_AFTER_RE.search(fm)
            if declared:
                try:
                    if _iso_date(declared.group(1)) < today:
                        overdue = (today - _iso_date(declared.group(1))).days
                        # tagged, because the section header describes the GLOBAL rule and
                        # these rows are caught by the note's own declared expiry instead.
                        # An accurate count under a wrong label is still a lie.
                        stale.append((slug, f"{overdue}d past its declared stale_after"))
                except ValueError:
                    pass
            elif re.search(r"^status:\s*living\s*$", fm, re.M):
                d = re.search(r"^updated:\s*(\d{4}-\d{2}-\d{2})", fm, re.M)
                if d:
                    try:
                        age = (today - _iso_date(d.group(1))).days
                        if age > STALE_DAYS:
                            stale.append((slug, age))
                    except ValueError:
                        bad_fm.append((slug, "unparseable updated: " + d.group(1)))

        # Dossier pattern. check_timeline returns entries=None for a note that never
        # opted in, which is the only reason the error rules stay quiet on a vault
        # where most candidate notes have not been converted yet. See SEP_RE.
        if not is_example(path):
            t_errs, t_count = check_timeline(slug, path, text)
            timeline.extend(t_errs)
            if t_count is None:
                if in_dossier_dir(path, wiki):
                    unconverted.append(slug)
            elif t_count > MAX_TIMELINE and not slug.endswith("-timeline-archive"):
                oversized.append((slug, t_count))   # an archive note is where overflow is MEANT to live

        if not is_example(path):
            for block in OPENQ_RE.findall(text):
                for line in block.splitlines():
                    hit = VERIFYBY_RE.search(line)
                    if not hit:
                        continue
                    try:
                        if _iso_date(hit.group(1)) < today:
                            expired.append((slug, hit.group(1)))
                    except ValueError:
                        pass

    real = [s for s, p in notes.items() if not is_meta(p) and not is_example(p)]  # notes only
    unreached = [s for s in real if inbound.get(s, 0) == 0]
    orphans = [s for s in unreached if s not in index_reach]      # truly invisible
    indexed_only = [s for s in unreached if s in index_reach]      # findable, not woven in

    # --- changelog shape: dated entries must run newest-first -------------
    # Stated as a rule in the agent instructions and, until now, enforced by
    # nothing. An append-happy agent will drift the order and nobody notices
    # until the log is the thing you are trying to trust.
    cl_path = os.path.join(wiki, "_changelog.md")
    if os.path.isfile(cl_path):
        cl = open(cl_path, encoding="utf-8-sig", errors="replace").read()
        dates = []
        for raw in CHANGELOG_DATE_RE.findall(cl):
            try:
                dates.append(_iso_date(raw))
            except ValueError:
                pass
        for i in range(1, len(dates)):
            if dates[i] > dates[i - 1]:
                log_order.append((dates[i - 1].isoformat(), dates[i].isoformat()))

    # 2026-08-25: indexes are now GENERATED per directory by
    # scripts/claude-code/wiki-index.py, and the root _index.md is a compact
    # directory map that no longer lists individual notes. Reading only the root
    # file made all 1,162 notes report as unindexed. Read every index.md plus the
    # root, so this check follows the format instead of dictating it.
    idx_sources = [os.path.join(wiki, "_index.md")]
    for root_dir, dirnames, filenames in os.walk(wiki):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for _nm in ("index.md", "_index.md"):      # per-folder indexes count for reach too (E-07)
            if _nm in filenames:
                idx_sources.append(os.path.join(root_dir, _nm))

    idx = ""
    for ip in idx_sources:
        if os.path.isfile(ip):
            idx += open(ip, encoding="utf-8-sig", errors="replace").read() + "\n"

    # match the actual link form, not a bare substring: a slug like 'me'
    # otherwise 'passes' against any index containing the word 'memory'.
    unindexed = [s for s in real if f'[[{s}]]' not in idx and f'[[{s}|' not in idx] if idx else []

    def section(title, rows, fmt):
        print(f"\n{title}: {len(rows)}")
        for r in rows[:12]:
            print("   " + fmt(r))
        if len(rows) > 12:
            print(f"   ... and {len(rows) - 12} more")

    print(f"scanned {len(real)} notes in {wiki}" + (f" (+{len(universe) - len(notes)} external link targets)" if extra else ""))
    section("UNFILLED PLACEHOLDERS", tokens, lambda s: s)
    section("DUPLICATE SLUGS (a wikilink to these is ambiguous)", dupes,
            lambda r: f"{r[0]}: {r[1]}  AND  {r[2]}")
    section("BROKEN LINKS", broken, lambda r: f"{r[0]} -> [[{r[1]}]]")
    section("TIMELINE (dossier pattern, converted notes only)", timeline, lambda r: f"{r[0]}: {r[1]}")
    print("\n--- warnings below this line never fail the run ---")
    section("UNKNOWN TYPE (not in the documented vocabulary)", odd_type, lambda r: f"{r[0]}: {r[1]}")
    section("ORPHANS (nothing reaches these, not even the index)", orphans, lambda s: s)
    section("INDEXED ONLY (in _index.md, but no note links here)", indexed_only, lambda s: s)
    section("THIN (<2 outbound links)", thin, lambda r: f"{r[0]} ({r[1]})")
    section("FRONTMATTER", bad_fm, lambda r: f"{r[0]}: {r[1]}")
    section("NOT IN _index.md", unindexed, lambda s: s)
    section("RELATIVE TIME (use absolute dates)", reltime, lambda s: s)
    section(f"STALE (declared stale_after, or status: living untouched >{STALE_DAYS}d)", stale,
            lambda r: f"{r[0]} ({r[1]}" + ("" if isinstance(r[1], str) else "d") + ")")
    section("OPEN QUESTIONS PAST THEIR VERIFY-BY DATE", expired, lambda r: f"{r[0]} (due {r[1]})")
    section("FRONTMATTER VALUES", bad_values, lambda r: f"{r[0]}: {r[1]}")
    section("CHANGELOG OUT OF ORDER (newest first)", log_order, lambda r: f"{r[0]} followed by newer {r[1]}")
    section(f"TIMELINE OVER {MAX_TIMELINE} ENTRIES (archive the oldest, leave a pointer)",
            oversized, lambda r: f"{r[0]} ({r[1]})")
    section("NOT YET CONVERTED to the dossier pattern (people/, partners/)", unconverted, lambda s: s)

    # 🔴 TWO TIERS, AND THE SPLIT IS THE WHOLE DESIGN.
    #
    # Measured on a real 1,150-note wiki, a single-tier lint reported 290 issues.
    # Nobody fixes 290 things. They stop running the lint, which is strictly worse
    # than having no lint -- and this file already says as much about indexed_only.
    #
    # ERRORS are unambiguous and fixable now: a schema violation, a dead link, a
    # leftover placeholder. If any exist, the run fails and the hook nags you.
    #
    # WARNINGS are judgment or gradual decay: an orphan may be deliberate, a thin
    # note may be young, a stale note may still be true. They are printed every
    # time and they never fail the run, so the error count can actually reach zero.
    #
    # The test of a good lint is not how much it finds. It is whether you still
    # read it in month three.
    errors   = [("UNFILLED PLACEHOLDERS", tokens), ("DUPLICATE SLUGS", dupes), ("BROKEN LINKS", broken),
                ("FRONTMATTER", bad_fm), ("FRONTMATTER VALUES", bad_values),
                ("CHANGELOG ORDER", log_order), ("TIMELINE", timeline)]
    warnings = [("UNKNOWN TYPE", odd_type), ("ORPHANS", orphans), ("INDEXED ONLY", indexed_only), ("THIN", thin),
                ("NOT IN _index.md", unindexed), ("RELATIVE TIME", reltime),
                ("STALE", stale), ("EXPIRED OPEN QUESTIONS", expired),
                ("TIMELINE OVERSIZED", oversized), ("NOT CONVERTED", unconverted)]
    err_total  = sum(len(x) for _, x in errors)
    warn_total = sum(len(x) for _, x in warnings)
    total = err_total

    # An empty wiki has nothing to complain about, which is exactly why it must not
    # be allowed to print "clean" -- that turns the install check into a check that
    # passes hardest when the agent has done the least.
    if not real:
        print("\nempty -- 0 notes. Nothing has been written to the wiki yet.")
        sys.exit(1)

    print()
    if err_total == 0:
        print(f"clean -- 0 errors ({warn_total} warnings, none blocking)")
    else:
        print(f"{err_total} ERROR{'s' if err_total != 1 else ''}"
              f" ({', '.join(f'{n.lower()} {len(x)}' for n, x in errors if x)})"
              f" -- and {warn_total} warnings")
    sys.exit(0 if err_total == 0 else 1)


if __name__ == "__main__":
    main()
