#!/usr/bin/env python3
"""dream/verify_quotes.py: step 3, the ENFORCED gate. NO LLM. Drops every proposal whose quotes are not found
VERBATIM (whitespace and quote-style normalised) in the cited files, plus anything naming a person from the
optional private vault, anything citing a personal path, and links whose slugs do not resolve to exactly one note.

Proposal JSON: {type: link|contradiction|supersession|flattened-date|stale-fact,
  from, to, claim, why, quote_from, quote_to, file_from, file_to}
Input : a run dir containing proposals/*.json (default: today's), or one JSON file (list or {"proposals": [...]}).
Output: verified.json (ids p-0001...), dropped.json (ids d-0001..., with drop_reason), verify-summary.json.

  python3 scripts/dream/verify_quotes.py
  python3 scripts/dream/verify_quotes.py memory/dream/2026-10-28
"""
import argparse
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

TYPES = {"link", "contradiction", "supersession", "flattened-date", "stale-fact"}
NEEDS_TO = {"link", "contradiction", "supersession"}      # both quotes mandatory
MIN_Q = 15


def segments(q):
    """A quote may use '...' to elide; each segment must appear, in order."""
    return [s for s in (C.norm(x) for x in re.split(r"\.\.\.|…", q)) if s]


def find_quote(quote, text):
    nt = C.norm(text)
    segs = segments(quote)
    if not segs or sum(len(s) for s in segs) < MIN_Q or any(len(s) < 8 for s in segs):
        return False, -1
    pos, first = 0, -1
    for s in segs:
        i = nt.find(s, pos)
        if i < 0:
            return False, -1
        if first < 0:
            first = i
        pos = i + len(s)
    return True, first


def line_of(text, quote):
    seg = (segments(quote) or [""])[0][:40]
    for i, ln in enumerate(text.splitlines(), 1):
        if seg and seg in C.norm(ln):
            return i
    return None


def resolve(path):
    if not path:
        return None, "no-file"
    full = path if os.path.isabs(path) else os.path.join(C.ROOT, path)
    real = os.path.realpath(os.path.normpath(full))
    root = os.path.realpath(C.ROOT)
    if not (real == root or real.startswith(root + os.sep)):
        return None, "outside-agent-folder"
    r = os.path.relpath(real, root).replace(os.sep, "/")
    if C.is_personal_path(real):
        return None, "personal-path"
    if C.is_env_path(real):
        return None, "env-file"
    if not os.path.isfile(real):
        return None, "file-missing"
    if not C.allowed_input(r) and not r.startswith("wiki/"):
        return None, "file-not-allowed"
    return (real, r), ""


def verify_one(p, nf, slugs):
    t = p.get("type")
    if t not in TYPES:
        return None, "bad-type"
    blob = " ".join(str(p.get(k, "")) for k in ("claim", "why", "quote_from", "quote_to", "from", "to"))
    if nf.hits(blob):
        return None, "personal-name"
    out = dict(p)
    pairs = [("quote_from", "file_from")]
    if t in NEEDS_TO or p.get("quote_to"):
        pairs.append(("quote_to", "file_to"))
    for qk, fk in pairs:
        q = p.get(qk) or ""
        if not q:
            return None, "missing-%s" % qk
        res, why = resolve(p.get(fk))
        if not res:
            return None, "%s:%s" % (fk, why)
        real, r = res
        text = C.read(real)
        ok, _ = find_quote(q, text)
        if not ok:
            return None, "%s-not-verbatim" % qk
        out[fk] = r
        out[qk.replace("quote_", "line_")] = line_of(text, q)
    if t == "link":
        for side in ("from", "to"):
            s = str(p.get(side, "")).strip().strip("[]")
            ps = slugs.get(s)
            if not ps or len(ps) != 1:
                return None, "slug-%s-unresolved" % side
            out[side] = s
        if out["from"] == out["to"]:
            return None, "self-link"
    return out, ""


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("path", nargs="?", default=None)
    ap.add_argument("--out-dir")
    a = ap.parse_args(argv)
    path = a.path or C.run_dir()
    if os.path.isdir(path):
        files = sorted(glob.glob(os.path.join(path, "proposals", "*.json")))
        outdir = a.out_dir or path
    else:
        files = [path]
        outdir = a.out_dir or os.path.dirname(os.path.abspath(path))
    props = []
    unreadable = []
    for f in files:
        d = C.jload(f)
        if d is None:
            unreadable.append(os.path.basename(f))
            continue
        d = d.get("proposals", []) if isinstance(d, dict) else d
        props += [x for x in d if isinstance(x, dict)]
    nf = C.NameFilter()
    slugs = C.wiki_slugs()
    ok, dropped, seen = [], [], set()
    for p in props:
        key = (p.get("type"), str(p.get("from")), str(p.get("to")),
               C.norm(p.get("quote_from", ""))[:60], C.norm(p.get("quote_to", ""))[:60])
        if key in seen:
            dropped.append(dict(p, drop_reason="duplicate"))
            continue
        seen.add(key)
        v, why = verify_one(p, nf, slugs)
        if v is None:
            dropped.append(dict(p, drop_reason=why))
        else:
            ok.append(v)
    for i, v in enumerate(ok, 1):
        v["id"] = "p-%04d" % i
    for i, v in enumerate(dropped, 1):
        v["drop_id"] = "d-%04d" % i
    C.jdump(ok, os.path.join(outdir, "verified.json"))
    C.jdump(dropped, os.path.join(outdir, "dropped.json"))
    n = len(props)
    summ = {"proposals": n, "verified": len(ok), "dropped": len(dropped),
            "hallucination_rate": round(len([d for d in dropped if d["drop_reason"].endswith("not-verbatim")]) / n, 3) if n else 0.0,
            "by_type": {t: sum(1 for v in ok if v["type"] == t) for t in sorted(TYPES)},
            "unreadable_files": unreadable}
    C.jdump(summ, os.path.join(outdir, "verify-summary.json"))
    C.write_seal(outdir)
    print(json.dumps(summ))
    return 0


if __name__ == "__main__":
    sys.exit(main())
