#!/usr/bin/env python3
"""wiki-gazetteer.py: the name list for the memory-reflex hook (hooks/memory-reflex.py).

Reads the frontmatter of every note under wiki/ and writes ONE JSON file, <state>/gazetteer.json (the same per-agent
state folder the hooks use), that the UserPromptSubmit hook loads in a few milliseconds. The hook never touches the wiki,
a model or the semantic index; everything it needs is precomputed here.

IDEA. Pull names out of a message and resolve them through THREE arms in strict order: an explicit alias, then an exact
title, then a surname that only one person has. A name that lands on 2+ notes gets no pointer. Precision beats recall: a
wrong pointer costs more than a missed one.

WHAT GOES IN THE FILE
  notes     [{p path, t title, d description, ty type, e entity?, pe person?}]   (indexed by position)
  alias     norm-name -> [note idx]      from the `aliases:` frontmatter field
  title     norm-name -> [note idx]      full title, title minus a trailing (parenthetical), the filename slug, and for
                                         ENTITY notes the head before " - "
  surname   norm-name -> [note idx]      last word of a person's name (>= 3 letters)
  given     norm-name -> [note idx]      first word of a person's name. NEVER matches by itself; it only vetoes: "Sam"
                                         is a title (sam.md) AND the first name of sam-jones.md, so it is ambiguous.
  ordinary  [norm-name]                  single words that are also ordinary English ("still", "grant", "atlas"). The
                                         hook only honours these in the middle of a sentence, never as the first word.
  ignore    [norm-name]                  names that appear in nearly every message and are never pointed at: the owner's
                                         own name (read from the title of wiki/me.md), the agent's name, and any line in
                                         ~/.config/talos/reflex-ignore.txt (one name per line).

WHAT IS DELIBERATELY LEFT OUT
  - superseded / archived notes, and notes marked `confidential: true`;
  - anything outside wiki/ (memory/, a private vault, .learnings), wiki/examples/, index.md / README.md / `_*.md` meta
    files, dot-directories, and any note whose `privacy:` says extra-sensitive.

USAGE
  python3 scripts/wiki-gazetteer.py              # build -> <state>/gazetteer.json
  python3 scripts/wiki-gazetteer.py --if-stale   # build only when a note is newer than the file (session start uses this)
  python3 scripts/wiki-gazetteer.py --out F      # write somewhere else (tests)
  python3 scripts/wiki-gazetteer.py --stats      # build, then print key counts
  python3 scripts/wiki-gazetteer.py --check      # exit 1 if the file is older than any note

Fails soft: a bad note is skipped, never fatal. Python 3.9, standard library only (PyYAML is used only if installed).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import unicodedata

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, ".."))
WIKI = os.path.join(REPO, "wiki")


def state_dir():
    """The per-agent state folder the hooks use (hooks/_talos_common.state_dir): same folder, same slug."""
    try:
        sys.path.insert(0, os.path.join(REPO, "hooks"))
        import _talos_common as C
        return C.state_dir()
    except Exception:
        import hashlib
        root = os.path.realpath(REPO)
        base = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
        return os.path.join(base, "talos", "%s-%s" % (os.path.basename(root) or "agent", hashlib.sha1(root.encode("utf-8")).hexdigest()[:8]))


DEFAULT_OUT = os.path.join(state_dir(), "gazetteer.json")

FRONTMATTER = re.compile(r"^---\r?\n(.*?)\r?\n---(?:\r?\n|$)", re.S)
NEVER_NOTES = {"index.md", "README.md"}
ENTITY_TYPES = {"person", "org", "project", "partner", "vendor", "account", "competitor", "event", "venue", "place"}
ENTITY_DIRS = {"people", "partners", "orgs", "accounts", "vendors", "competitors", "projects", "events"}
SKIP_STATUS = {"superseded", "archived"}
IGNORE = {"claude", "claude code", "talos", "me"}     # the owner's name and the agent's name are added from the wiki / config
# words that must never be a one-word name even if some note is titled that way
NEVER_SINGLE = {"glossary", "index", "readme", "claude", "today", "notes", "note", "source", "sources",
                "quotes", "stat", "stats", "meeting", "meetings", "monday", "tuesday", "wednesday",
                "thursday", "friday", "saturday", "sunday", "january", "february", "march", "april",
                "may", "june", "july", "august", "september", "october", "november", "december",
                # brands that collide with a first-name note (an assistant brand pointing at a person who shares the name)
                "siri", "alexa", "cortana", "bard", "gemini", "grok", "sonnet", "opus", "haiku"}
HEAD_SPLIT = re.compile(r"\s+[—–-]\s+|:\s+|\s+\|\s+")
PAREN_TAIL = re.compile(r"\s*[\(\[].*?[\)\]]\s*$")
CONNECTORS = {"of", "the", "and", "vs", "for", "de", "van", "von", "la", "di", "da", "le", "du"}


def norm(s: str) -> str:
    """Lowercase, ASCII-folded, punctuation -> space, possessive stripped. The hook uses the same."""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace("’", "'")
    s = re.sub(r"'s\b", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return " ".join(s.split())


def read_front(path: str):
    """(fields dict, ok). A parse failure degrades to a tolerant line scan, never raises."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            text = fh.read(6000)
    except OSError:
        return {}, False
    m = FRONTMATTER.match(text)
    if not m:
        return {}, True
    block = m.group(1)
    fields = None
    if yaml is not None:
        try:
            fields = yaml.safe_load(block)
        except Exception:
            fields = None
    if not isinstance(fields, dict):
        fields = {}
        for ln in block.splitlines():          # tolerant fallback: top-level `key: value` lines
            mm = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", ln)
            if mm:
                v = mm.group(2).strip().strip("\"'")
                fields[mm.group(1)] = v
    return fields, True


def as_str(v):
    if isinstance(v, str) and v.strip():
        return " ".join(v.split())
    return None


def as_aliases(v):
    if isinstance(v, str):
        v = re.split(r"[,;|]", v)
    if isinstance(v, (list, tuple)):
        out = []
        for a in v:
            a = as_str(str(a)) if a is not None else None
            if a:
                out.append(a)
        return out
    return []


def is_note(dirpath: str, name: str, root: str) -> bool:
    if not name.endswith(".md") or name in NEVER_NOTES:
        return False
    if os.path.abspath(dirpath) == os.path.abspath(root):
        if name.startswith("_") or name == "CLAUDE.md":
            return False
    return True


def walk_notes(root: str):
    for dp, dn, fn in os.walk(root):
        dn[:] = sorted(d for d in dn if not d.startswith(".") and not os.path.islink(os.path.join(dp, d)))
        rel_dir = os.path.relpath(dp, root)
        top = rel_dir.split(os.sep)[0] if rel_dir != "." else ""
        if top == "examples":
            dn[:] = []                          # the shipped worked examples are not the owner's knowledge
            continue
        for f in sorted(fn):
            if is_note(dp, f, root) and not os.path.islink(os.path.join(dp, f)):
                yield os.path.join(dp, f), top


def clean_title(title: str) -> str:
    return PAREN_TAIL.sub("", title).strip()


def head_of(title: str) -> str:
    return HEAD_SPLIT.split(clean_title(title), maxsplit=1)[0].strip()


def looks_like_name(raw: str) -> bool:
    """'Dana Ruiz', 'Lopez-Hart', 'Priya Nair' yes; 'Old neighbour (Riverside)', 'TBD' no."""
    words = [w for w in re.split(r"[\s\-]+", raw.strip()) if w]
    if not words or "(" in raw or ")" in raw or "tbd" in raw.lower():
        return False
    for w in words:
        if w.lower() in CONNECTORS:
            continue
        if not (w[0].isupper() or w[0].isdigit()):
            return False
    return True


def first_names():
    out = set()
    try:
        with open("/usr/share/dict/propernames", errors="ignore") as fh:
            for w in fh:
                w = w.strip().lower()
                if w:
                    out.add(w)
    except OSError:
        pass
    return out


def extra_ignore():
    """Names that would match nearly every message: the owner (the title of wiki/me.md, whole and word by word) and
    whatever is listed in ~/.config/talos/reflex-ignore.txt (one name per line, # for comments). Reading me.md is a
    frontmatter read of one wiki note; nothing else is learned about the owner."""
    out = set()
    fm, _ok = read_front(os.path.join(WIKI, "me.md"))
    t = as_str(fm.get("title")) if isinstance(fm, dict) else None
    if t:
        full = norm(clean_title(t))
        if full:
            out.add(full)
            out.update(w for w in full.split() if len(w) >= 2)
    cfg = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "talos", "reflex-ignore.txt")
    try:
        with open(cfg, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#"):
                    out.add(norm(line))
    except OSError:
        pass
    return out


def build(verbose=False):
    ignore = set(IGNORE) | extra_ignore()
    notes, alias, tit, sur, giv = [], {}, {}, {}, {}
    caps = set()                      # one-word names written ALL CAPS in their title (NASA, IKEA)
    skipped = {"status": 0, "confidential": 0, "sensitive": 0, "untitled": 0}

    def add(table, key, idx):
        if not key:
            return
        lst = table.setdefault(key, [])
        if idx not in lst:
            lst.append(idx)

    corpus_paths = []
    for root in (WIKI,):
        if not os.path.isdir(root):
            continue
        for path, top in walk_notes(root):
            corpus_paths.append(path)
            fm, ok = read_front(path)
            if not ok:
                continue
            slug = os.path.basename(path)[:-3]
            status = str(fm.get("status") or "").strip().lower()
            if status in SKIP_STATUS:
                skipped["status"] += 1
                continue
            if fm.get("confidential") in (True, "true", "True"):
                skipped["confidential"] += 1
                continue
            priv = str(fm.get("privacy") or "").upper()
            if "EXTRA-SENSITIVE" in priv or "EXTRA SENSITIVE" in priv:
                skipped["sensitive"] += 1
                continue
            title = as_str(fm.get("title")) or slug.replace("-", " ")
            desc = as_str(fm.get("description"))
            ntype = str(fm.get("type") or "").strip().lower()
            is_person = ntype == "person" or top == "people"
            entity = is_person or ntype in ENTITY_TYPES or top in ENTITY_DIRS
            rel = os.path.relpath(path, REPO)
            idx = len(notes)
            notes.append({"p": rel, "t": title, "d": desc or "", "ty": ntype or top or "note",
                          "e": 1 if entity else 0, "pe": 1 if is_person else 0})

            # arm 1: explicit aliases
            for a in as_aliases(fm.get("aliases")):
                add(alias, norm(a), idx)
            # arm 2: exact titles
            full = norm(title)
            add(tit, full, idx)
            stripped = norm(clean_title(title))
            add(tit, stripped, idx)
            if entity:
                add(tit, norm(head_of(title)), idx)
                hw = head_of(title).split()
                if len(hw) == 1 and len(hw[0]) > 1 and hw[0].isupper():
                    caps.add(norm(hw[0]))
            add(tit, norm(slug.replace("-", " ")), idx)
            # arm 3 + guard: person names (only if the title head really looks like a name)
            if is_person and looks_like_name(head_of(title) if entity else clean_title(title)):
                name = norm(head_of(title)) if entity else stripped
                toks = name.split()
                if len(toks) >= 2:
                    if len(toks[-1]) >= 3:
                        add(sur, toks[-1], idx)
                    add(giv, toks[0], idx)
                elif len(toks) == 1:
                    add(giv, toks[0], idx)

    # drop keys that are useless or dangerous
    def prune(table, single_ok, minlen=3):
        for k in list(table):
            toks = k.split()
            if not toks or len(k) < minlen or k in ignore:
                del table[k]
            elif len(toks) == 1 and (k in NEVER_SINGLE or k.isdigit()):
                del table[k]
            elif len(toks) == 1 and not single_ok(table[k]):
                del table[k]
            elif all(t in CONNECTORS for t in toks):
                del table[k]

    ent_only = lambda idxs: any(notes[i]["e"] for i in idxs)
    prune(alias, lambda idxs: True, minlen=2)      # aliases are deliberate: allow "QF"
    # single-word TITLES only for entity notes: "Botsitting" the concept is not worth a reflex
    for k in list(tit):
        if len(k.split()) == 1 and not all(notes[i]["e"] for i in tit[k]):
            tit[k] = [i for i in tit[k] if notes[i]["e"]]
            if not tit[k]:
                del tit[k]
    prune(tit, ent_only)
    prune(sur, lambda idxs: True)
    for k in list(giv):                        # given is guard-only; keep even 2-letter? no, keep >=2
        if k in ignore or len(k) < 2:
            del giv[k]

    # ordinary-word detection: dictionary + how the word is really used in OUR corpus
    singles = {k for t in (tit, sur, alias) for k in t if len(k.split()) == 1}
    ordinary = ordinary_words(singles, corpus_paths)
    # a surname that is also a common given name ("Thomas", "James", "Jordan") or an ordinary word
    # ("Grant", "Team") is how people talk about OTHER people. Full names still resolve via the title arm.
    fn = first_names()
    for k in list(sur):
        if k in fn or k in ordinary:
            del sur[k]

    return {
        "version": 1,
        "built": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "repo": REPO,
        "notes": notes,
        "alias": alias,
        "title": tit,
        "surname": sur,
        "given": giv,
        "ordinary": sorted(ordinary),
        "caps": sorted(caps),
        "ignore": sorted(ignore),
        "skipped": skipped,
    }


def ordinary_words(singles, paths):
    """A single-word name is 'ordinary' if it is also a normal English word: in the system
    dictionary in lowercase, or used in lowercase prose in this very corpus. 'Ready' is a project
    and also the commonest sentence opener in the wiki; 'Quasarfin' is only ever a name."""
    dictionary = set()
    for dp in ("/usr/share/dict/words",):
        try:
            with open(dp, errors="ignore") as fh:
                for w in fh:
                    w = w.strip()
                    if w[:1].islower():
                        dictionary.add(w)
        except OSError:
            pass
    low = {k: 0 for k in singles}
    tot = {k: 0 for k in singles}
    tokre = re.compile(r"[A-Za-z][A-Za-z'\u2019]*")
    for p in paths:
        try:
            with open(p, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            continue
        m0 = FRONTMATTER.match(text)
        if m0:
            text = text[m0.end():]              # frontmatter tags are lowercase labels, not prose
        text = re.sub(r"https?://\S+|\S*[/\\\.]\S+|`[^`]*`|\[\[[^\]]*\]\]", " ", text)   # urls, paths, wikilinks
        for m in tokre.finditer(text):
            w = m.group(0)
            k = norm(w)
            if k in tot:
                tot[k] += 1
                if w.islower():
                    low[k] += 1
    out = set()
    for k in singles:
        t, l = tot[k], low[k]
        ratio = (l / t) if t else 0.0
        in_dict = k in dictionary
        # In the dictionary: an ordinary word unless this wiki gives real evidence that it is used as a name (seen at
        # least 4 times, mostly capitalised). A short or rarely-seen word defaults to ordinary: the cost of being wrong
        # is a missed pointer at the start of a sentence, the cost of the opposite is "Ready when you are" pointing at
        # a project called Ready.
        if in_dict and (t < 4 or ratio >= 0.5 or len(k) <= 4):
            out.add(k)
        elif (not in_dict) and l >= 12 and ratio >= 0.8:
            out.add(k)
    return out


def write_atomic(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp.%d" % os.getpid()
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def newest_note_mtime():
    best = 0.0
    for root in (WIKI,):
        if os.path.isdir(root):
            for path, _top in walk_notes(root):
                try:
                    best = max(best, os.path.getmtime(path))
                except OSError:
                    pass
    return best


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--wiki", help="alternate wiki root (tests)")
    ap.add_argument("--repo", help="alternate agent-folder root that note paths are relative to (tests)")
    ap.add_argument("--stats", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--if-stale", action="store_true", help="build only when a note is newer than the file; print nothing when fresh")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    global WIKI, REPO
    if a.repo:
        REPO = os.path.abspath(a.repo)
    if a.wiki:
        WIKI = os.path.abspath(a.wiki)
    if a.check or a.if_stale:
        try:
            fresh = os.path.getmtime(a.out) >= newest_note_mtime()
        except OSError:
            fresh = False
        if a.check:
            print("fresh" if fresh else "STALE")
            return 0 if fresh else 1
        if fresh:
            return 0
    t0 = time.time()
    data = build()
    write_atomic(a.out, data)
    n = len(data["notes"])
    if not a.quiet:
        print("wiki-gazetteer: %d notes | alias %d | title %d | surname %d | given %d | ordinary %d | %s | %.1fs"
              % (n, len(data["alias"]), len(data["title"]), len(data["surname"]), len(data["given"]),
                 len(data["ordinary"]), a.out, time.time() - t0))
    if a.stats:
        print("skipped:", data["skipped"], "| bytes:", os.path.getsize(a.out))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # never wedge the backup job
        print("wiki-gazetteer: FAILED soft: %r" % (e,), file=sys.stderr)
        sys.exit(0)
