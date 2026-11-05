#!/usr/bin/env python3
"""
seed-quotecheck.py — did that quote actually come from anywhere?

    python3 scripts/seed-quotecheck.py [wiki_dir] [staging_dir]

Defaults: wiki_dir=wiki, staging_dir=.seed-staging

Pure standard library. No install, no config file.

WHAT THIS IS FOR
----------------
`SEED-WIKI.md` Step 6 runs this before spawning `reviewer`. It pulls every
quoted string out of the wiki notes and greps the staging dump for it,
verbatim. An invented quote, or one that got quietly "tidied" on its way into
a note, fails here in about a second instead of costing a full adversarial
review pass.

WHAT IT DOES NOT DO — read this before you trust a clean run
------------------------------------------------------------
It is a cheap mechanical first pass, not a verification step. It is blind to:

  * inference stated as fact          (no quote marks, nothing to check)
  * a real quote attributed to the wrong person, meeting, or date
  * a real quote moved into a context that changes what it meant
  * anything paraphrased rather than quoted

Those are exactly the failures `reviewer` exists for, and this script does not
reduce the need for it by one line. A clean run here means "no fabricated
quotes," which is the cheapest of the problems, not the important one.

WHY IT WHITELISTS SO AGGRESSIVELY
---------------------------------
Prose uses double quotes for lots of things that are not quotations: scare
quotes, defined terms, titles, the string literal in a code example. Flagging
those would bury the real finding in noise, and a check people learn to ignore
is worse than no check. So this errs hard toward silence: short strings, single
words, anything that looks like code or a path, and anything inside a fenced
block is skipped. It will miss some fabricated quotes. It should almost never
cry wolf.

MATCHING
--------
Whitespace is collapsed before comparing, because markdown line-wraps a quote
that was one line in the source. Smart quotes, apostrophes and dashes are
folded to their ASCII forms on both sides — a note that went through a text
editor's autocorrect is not a fabrication and should not report as one.

Case is NOT folded, because changing it is a real alteration. A quote that
matches only case-insensitively is reported separately, as ALTERED rather than
MISSING, since the fix is different: restore the original casing, do not go
hunting for a source that is already there.
"""

import os
import re
import sys
import unicodedata

# Quotes shorter than this are almost always scare quotes or defined terms.
MIN_CHARS = 25
MIN_WORDS = 4

# Notes that ship with the kit and quote things on purpose.
SKIP_NOTES = ("README.md", "_index.md", "_changelog.md",
              "_privacy-and-sharing.md", "_onboarding-progress.md")
SKIP_DIRS = ("examples", ".git", "__pycache__")

FENCE_RE = re.compile(r"```.*?```|~~~.*?~~~", re.S)
INLINE_CODE_RE = re.compile(r"`[^`\n]*`")
# Straight or smart double quotes. Non-greedy, must stay on one logical run.
# 2026-09-02 (seed dry run, B3): the minimum length used to live INSIDE the match, so a quoted string
# shorter than it, or an inch mark (55"), could not pair and the engine mis-paired every quote after
# it in the file: 15 false MISSING on 27 ordinary notes. Match any pair on one line; the filters below
# apply the minimums. A digit before the mark is an inch/second mark, not a quote.
QUOTE_RE = re.compile(r'(?<!\d)["“]([^"“”\n]*?)["”]')

# Looks like code, a path, a URL, or a placeholder rather than human speech.
CODEY_RE = re.compile(
    r"(^[\w.\-/]+$)"           # bare token/path, no spaces
    r"|(https?://)"
    r"|(\{\{.*\}\})"           # {{TEMPLATE}}
    r"|(^[/~.])"               # starts like a path
    r"|(\$\{)"
    r"|(<[a-zA-Z!/])"          # html/xml-ish
)

FOLD = {
    "“": '"', "”": '"', "‘": "'", "’": "'",
    "–": "-", "—": "-", "…": "...", " ": " ",
    "′": "'", "″": '"', "​": "",
}


def fold(s):
    """Normalise the things that change in transit but are not alterations."""
    s = unicodedata.normalize("NFC", s)
    for a, b in FOLD.items():
        s = s.replace(a, b)
    return re.sub(r"\s+", " ", s).strip()


def walk_md(root, skip_dirs=SKIP_DIRS):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip_dirs]
        for fn in sorted(filenames):
            if fn.endswith(".md"):
                yield os.path.join(dirpath, fn)


def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError as exc:
        print("  !! could not read %s: %s" % (path, exc), file=sys.stderr)
        return ""


def load_staging(staging_dir):
    """Every staged byte, folded, as one haystack. Any text file, not just .md.

    Pullers stage whatever the connector returned -- .md, .txt, .json, .eml.
    Restricting this to .md would silently check against a fraction of the
    corpus and report fabrications that are sitting right there in a .json.
    """
    chunks, files = [], 0
    for dirpath, dirnames, filenames in os.walk(staging_dir):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in sorted(filenames):
            path = os.path.join(dirpath, fn)
            try:
                if os.path.getsize(path) > 40 * 1024 * 1024:
                    print("  !! skipping oversized staging file: %s" % path,
                          file=sys.stderr)
                    continue
            except OSError:
                continue
            text = read(path)
            if text:
                chunks.append(fold(text))
                files += 1
    return "\n".join(chunks), files


def extract_quotes(text):
    """Quoted strings that plausibly claim to be somebody's words."""
    text = FENCE_RE.sub(" ", text)
    text = INLINE_CODE_RE.sub(" ", text)
    out = []
    for m in QUOTE_RE.finditer(text):
        raw = m.group(1).strip()
        if len(raw) < MIN_CHARS:
            continue
        if len(raw.split()) < MIN_WORDS:
            continue
        if CODEY_RE.search(raw):
            continue
        out.append(raw)
    return out


def main(argv):
    wiki_dir = argv[1] if len(argv) > 1 else "wiki"
    staging_dir = argv[2] if len(argv) > 2 else ".seed-staging"

    if not os.path.isdir(wiki_dir):
        print("seed-quotecheck: no such directory: %s" % wiki_dir)
        return 2
    if not os.path.isdir(staging_dir):
        print("seed-quotecheck: no staging directory at %s" % staging_dir)
        print("  Nothing to check against. If you already deleted staging, this")
        print("  check can no longer run -- it is a Step 6 gate, before Step 7's")
        print("  cleanup, and it cannot be reconstructed afterwards.")
        return 2

    haystack, staged_files = load_staging(staging_dir)
    if not staged_files:
        print("seed-quotecheck: %s is empty." % staging_dir)
        print("  Refusing to report a pass against an empty corpus -- every quote")
        print("  would 'fail', or with an empty check every quote would 'pass',")
        print("  and neither number means anything.")
        return 2

    haystack_lower = haystack.lower()

    missing, altered = [], []
    checked = notes = 0

    for path in walk_md(wiki_dir):
        base = os.path.basename(path)
        if base in SKIP_NOTES:
            continue
        quotes = extract_quotes(read(path))
        if not quotes:
            continue
        notes += 1
        rel = os.path.relpath(path, os.path.dirname(wiki_dir) or ".")
        for q in quotes:
            checked += 1
            needle = fold(q)
            if needle in haystack:
                continue
            if needle.lower() in haystack_lower:
                altered.append((rel, q))
            else:
                missing.append((rel, q))

    def show(label, rows):
        print("\n%s (%d):" % (label, len(rows)))
        for rel, q in rows:
            snippet = q if len(q) <= 140 else q[:137] + "..."
            print("  %s\n    \"%s\"" % (rel, snippet))

    print("seed-quotecheck: %d quotes in %d notes, against %d staged files"
          % (checked, notes, staged_files))

    if not checked:
        print("\nNo quotes long enough to check. That is not a pass -- it usually")
        print("means the notes paraphrase instead of quoting, which is the exact")
        print("habit SEED-WIKI.md Step 3 warns about. Go look at a note.")
        return 0

    if altered:
        show("ALTERED -- present in staging but the casing was changed", altered)
    if missing:
        show("MISSING -- not found in staging, verbatim", missing)

    if not missing and not altered:
        print("\nAll %d quotes trace to staging, verbatim." % checked)
        print("This rules out fabricated quotes and NOTHING else. Wrong")
        print("attribution, wrong context and inference-stated-as-fact all pass")
        print("this check cleanly. Run `reviewer` -- that is what it is for.")
        return 0

    print("\n%d to fix. A MISSING quote is one of three things: it was invented,"
          % (len(missing) + len(altered)))
    print("it was reworded on the way into the note, or it came from outside")
    print("staging -- the user said it to you directly, for instance. The third")
    print("is legitimate and the note's `source` field should already say so.")
    print("Fix the first two by going back to the staged item. Do NOT delete a")
    print("quote to make this script quiet -- that destroys the provenance the")
    print("crawl paid for, which is the failure in SEED-WIKI.md Step 3.")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
