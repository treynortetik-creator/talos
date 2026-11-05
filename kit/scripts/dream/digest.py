#!/usr/bin/env python3
"""dream/digest.py [date]: one line summarising a night. Writes memory/dream/<date>/digest.txt and prints it.
Sends nothing anywhere. Reads <run>/applied.json, verified.json, judged.json, collect.json and run.json."""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402


def short(v):
    s = re.sub(r"\[\[|\]\]", "", C.norm(v.get("claim") or v.get("from") or ""))
    return (s[:48].rsplit(" ", 1)[0] if len(s) > 48 else s) or str(v.get("from"))


def plural(n, word):
    return "%d %s%s" % (n, word, "" if n == 1 else "s")


def build(run):
    coll = C.jload(os.path.join(run, "collect.json"), {}) or {}
    led = C.jload(os.path.join(run, "applied.json"), {}) or {}
    ver = C.jload(os.path.join(run, "verified.json"), []) or []
    jud = C.jload(os.path.join(run, "judged.json"), []) or []
    jud = jud.get("judgements", []) if isinstance(jud, dict) else jud
    acc = {j.get("id") for j in jud if isinstance(j, dict) and str(j.get("decision", "")).lower() == "accept"}
    meta = C.jload(os.path.join(run, "run.json"), {}) or {}
    n_links = len(led.get("applied", []))
    q = [v for v in ver if v.get("id") in acc and v.get("type") != "link"]
    parts = []
    if n_links:
        parts.append(plural(n_links, "link") + " added")
    stale = [v for v in q if v["type"] in ("stale-fact", "flattened-date")]
    if stale:
        parts.append("%s queued (%s)" % (plural(len(stale), "stale fact"), "; ".join(short(v) for v in stale[:2])))
    for t in ("contradiction", "supersession"):
        n = sum(1 for v in q if v["type"] == t)
        if n:
            parts.append("%s queued" % plural(n, t))
    over = sum(1 for e in led.get("queued", []) if e.get("type") == "link")
    if over:
        parts.append("%s queued%s" % (plural(over, "link"), " (queue-only mode)" if led.get("queue_only") else ""))
    if not parts:
        parts.append("quiet night, %d notes scanned, nothing worth acting on" % coll.get("note_count", 0) if coll else "no run data")
    line = "Dream: " + ", ".join(parts)
    if meta.get("ceiling_hit"):
        line += " [cost ceiling hit, partial run]"
    if meta.get("note"):
        line += " [%s]" % meta["note"]
    return line + ("." if not line.endswith((".", "]")) else "")


def main(argv=None):
    date = (argv if argv is not None else sys.argv[1:] or [C.today()])
    date = date[0] if date else C.today()
    run = C.run_dir(date)
    line = build(run)
    C.write(os.path.join(run, "digest.txt"), line + "\n")
    print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
