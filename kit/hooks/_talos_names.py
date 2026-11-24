"""_talos_names.py: the looser person-name forms for the memory-reflex hook. Not a hook itself; nothing registers it.

hooks/memory-reflex.py resolves a name strictly first (alias, exact title, unique surname). This adds three forms for PEOPLE only,
each anchored so it cannot guess from a bare word, and ranked LAST: a loose hit never replaces a strict one.

  initial + surname   "R. Harlow"      the initial must start the given name of exactly one person with that surname (so it also
                                       settles a surname two people share)
  reversed            "Harlow, Robin"  must equal a person note's full title read backwards
  surname typo        "Robin Harlov"   the first name (or its initial) must match, the surname is one edit from a real surname, and
                                       the surname is at least 5 characters. No first name, no guess.

A form that lands on two or more notes yields no hit and a `dropped` record: ambiguity is dropped, never guessed. Only person notes
(`pe`) are returned. The gazetteer's `ignore` list applies to the RESOLVED name too: whatever initial, reversal or typo got to the
note, a note whose own full name is on the list (the owner, the agent) is no hit. Pure functions over the gazetteer; no I/O.
Python 3.9, standard library only. The TypeScript twin is apps/bridge/src/memory/reflex-names.ts; test/memory-reflex-parity.test.ts
keeps the two equal.
"""
import re
import unicodedata

_CAP = r"[A-Z][^\W\d_]*(?:['’\-][^\W\d_]+)?"                    # one capitalised name word
INITIAL = re.compile(r"(?<![\w.])([A-Z])\.[ \t]+(%s)" % _CAP)
REVERSED = re.compile(r"(?<![\w])(%s)[ \t]*,[ \t]+(%s)" % (_CAP, _CAP))
PAIR = re.compile(r"(?<![\w.])(?=((?:[A-Z]\.|%s)[ \t]+(%s)))" % (_CAP, _CAP))       # overlapping: a lookahead
PREV_CAP = re.compile(r"(?<![\w])%s[ \t]+$" % _CAP)                  # the text before an initial ends in a capitalised word
MIN_TYPO_LEN = 5


def norm(s):
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace("’", "'")
    s = re.sub(r"'s\b", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return " ".join(s.split())


def edit1(a, b):
    """True when the edit distance of a and b is exactly 1 (one substitution, insertion or deletion)."""
    if a == b or abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b)) == 1
    if len(a) > len(b):
        a, b = b, a
    i = 0
    while i < len(a) and a[i] == b[i]:
        i += 1
    return a[i:] == b[i + 1:]


def _full(note):
    return norm(re.sub(r"\s*[\(\[].*$", "", note.get("t", "")))


def _given(note):
    w = _full(note).split()
    return w[0] if len(w) >= 2 else ""


def _persons(g, idxs):
    return [i for i in dict.fromkeys(idxs) if g["notes"][i].get("pe")]


def _surnames(g):
    """surname -> [person note idx]: the gazetteer's own table (which leaves out a surname that is also a first name) plus the last
    word of every person note's title. Safe here because every loose form carries a second anchor."""
    out = {k: list(v) for k, v in g.get("surname", {}).items()}
    for i, n in enumerate(g["notes"]):
        if n.get("pe"):
            w = _full(n).split()
            if len(w) >= 2 and len(w[-1]) >= 3 and i not in out.setdefault(w[-1], []):
                out[w[-1]].append(i)
    return out


def _add(hits, dropped, cands, name, form, g, ign):
    cands = list(dict.fromkeys(cands))
    if len(cands) == 1:
        if _full(g["notes"][cands[0]]) not in ign:           # ambiguity is decided first; an ignored name is dropped after
            hits.append({"idx": cands[0], "name": name, "form": form})
    elif len(cands) >= 2:
        dropped.append({"name": name, "why": "ambiguous", "n": len(cands)})


def loose_matches(text, g):
    """-> (hits [{idx, name, form}], dropped [{name, why, n}]). `text` has had code, URLs and paths blanked already."""
    notes, surname, title = g["notes"], _surnames(g), g.get("title", {})
    ign = set(g.get("ignore", ()))
    hits, dropped = [], []
    for m in INITIAL.finditer(text):
        if PREV_CAP.search(text[max(0, m.start() - 40):m.start()]):        # "Robin R. Harlow": R. is a middle initial
            continue
        ini, sur = m.group(1).lower(), norm(m.group(2))
        cands = [i for i in _persons(g, surname.get(sur, [])) if _given(notes[i]).startswith(ini)]
        _add(hits, dropped, cands, "%s. %s" % (ini, sur), "initial", g, ign)
    for m in REVERSED.finditer(text):
        sur, giv = norm(m.group(1)), norm(m.group(2))
        if sur and giv:
            _add(hits, dropped, _persons(g, title.get("%s %s" % (giv, sur), [])), "%s, %s" % (sur, giv), "reversed", g, ign)
    for m in PAIR.finditer(text):
        first, last = m.group(1).split()[0].rstrip("."), norm(m.group(2))
        if len(last) < MIN_TYPO_LEN or last in surname or " " in last:
            continue
        fn = norm(first)
        cands = []
        for s in [s for s in surname if len(s) >= MIN_TYPO_LEN and edit1(last, s)]:
            for i in _persons(g, surname[s]):
                gv = _given(notes[i])
                if gv and ((len(fn) == 1 and gv.startswith(fn)) or (len(fn) > 1 and gv == fn)):
                    cands.append(i)
        _add(hits, dropped, cands, "%s %s" % (fn, last), "typo", g, ign)
    seen, out = set(), []
    for h in hits:
        if h["idx"] not in seen:
            seen.add(h["idx"])
            out.append(h)
    return out, dropped
