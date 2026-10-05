#!/usr/bin/env python3
"""state-sweep.py: a read-only health check of memory/STATE.md. It reports; it never edits.

    python3 scripts/state-sweep.py [--today YYYY-MM-DD] [--json] [--ceiling N]

STATE.md is read at every session start and outranks everything else on "is X still open?", so two things rot it
silently: it grows (the session hook can only inject part of it), and rows that are finished or stale stay in the
live sections. This finds both:

  size            characters (Python len(), not bytes) against the ceiling (default 30,000)
  close or evict  a row in a LIVE section that reads as finished (done, closed, shipped, resolved, a strike-through)
  stale           a live row whose newest date is more than 14 days old (an untouched bet should die by default)
  coming up       a date inside the next 7 days in any live section
  prune           RECENTLY CLOSED holds more than 15 rows: move the oldest to the day's log

A "row" is a table row or a bullet. Placeholder rows (empty cells, a lone "-") are ignored. Standard library only.
Always exits 0 (it is a report); the first line says whether anything needs attention.
"""
import argparse
import datetime
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
DATE = re.compile(r"\b(20\d\d)-(\d\d)-(\d\d)\b")
DONE = re.compile(r"\b(?:done|closed|shipped|resolved|complete[d]?|finished|merged|killed)\b|✅|~~", re.I)
LIVE = ("FUSES", "ACTIVE FIVE", "WAITING ON", "BLOCKERS", "HARD DATES")
STALE_DAYS, SOON_DAYS, CLOSED_KEEP = 14, 7, 15


def rows_by_section(text):
    sections, cur = [], None
    for line in text.splitlines():
        m = re.match(r"^#{1,3}\s+(.+)$", line)
        if m:
            cur = {"title": m.group(1).strip(), "rows": []}
            sections.append(cur)
            continue
        if cur is None:
            continue
        s = line.strip()
        if not s or s.startswith(">"):
            continue
        if s.startswith("|"):
            cells = [c.strip() for c in s.strip("|").split("|")]
            if all(re.fullmatch(r"[-: ]*", c) for c in cells):          # |---|---| separator
                continue
            if not any(c and not re.fullmatch(r"\d*", c) for c in cells):  # an empty or numbered-only placeholder row
                continue
            if cur["rows"] == [] and not DATE.search(s) and re.search(r"\b(what|bet|who|next action|verified|open since)\b", s, re.I) \
                    and all(len(c) < 24 for c in cells):
                continue                                                   # the table's header row
            cur["rows"].append(s)
        elif re.match(r"^[-*]\s+\S", s):
            cur["rows"].append(s)
    return sections


def kind(title):
    t = title.upper()
    for k in LIVE + ("RECENTLY CLOSED",):
        if k in t:
            return k
    return "OTHER"


def newest_date(row):
    ds = []
    for y, m, d in DATE.findall(row):
        try:
            ds.append(datetime.date(int(y), int(m), int(d)))
        except ValueError:
            pass
    return max(ds) if ds else None


def sweep(text, today, ceiling):
    out = {"today": today.isoformat(), "chars": len(text), "ceiling": ceiling, "over_ceiling": len(text) > ceiling,
           "close_or_evict": [], "stale": [], "coming_up": [], "recently_closed_rows": 0, "prune": 0, "rows": 0}
    for sec in rows_by_section(text):
        k = kind(sec["title"])
        out["rows"] += len(sec["rows"])
        if k == "RECENTLY CLOSED":
            out["recently_closed_rows"] = len(sec["rows"])
            out["prune"] = max(0, len(sec["rows"]) - CLOSED_KEEP)
            continue
        if k not in LIVE:
            continue
        for r in sec["rows"]:
            nd = newest_date(r)
            short = re.sub(r"\s+", " ", r)[:110]
            if DONE.search(r):
                out["close_or_evict"].append({"section": k, "row": short})
            elif nd is not None and (today - nd).days > STALE_DAYS and k != "HARD DATES":
                out["stale"].append({"section": k, "row": short, "age_days": (today - nd).days})
            if nd is not None and 0 <= (nd - today).days <= SOON_DAYS and not DONE.search(r):
                out["coming_up"].append({"section": k, "row": short, "in_days": (nd - today).days})
    out["needs_attention"] = bool(out["over_ceiling"] or out["close_or_evict"] or out["stale"] or out["prune"])
    return out


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--today", default=None)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--ceiling", type=int, default=30000)
    ap.add_argument("--file", default=os.path.join(ROOT, "memory", "STATE.md"))
    a = ap.parse_args(argv)
    try:
        today = datetime.date.fromisoformat(a.today) if a.today else datetime.date.today()
    except ValueError:
        print("--today must look like 2026-10-05", file=sys.stderr)
        return 2
    try:
        with open(a.file, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        print("STATE sweep: no memory/STATE.md to check (%s)" % a.file)
        return 0
    r = sweep(text, today, a.ceiling)
    if a.json:
        print(json.dumps(r, indent=2))
        return 0
    print("STATE sweep %s: %s" % (r["today"], "needs attention" if r["needs_attention"] else "nothing to do"))
    print("size: %s characters (ceiling %s)%s" % (format(r["chars"], ","), format(r["ceiling"], ","),
                                                  "  OVER: evict closed rows to the daily log before adding" if r["over_ceiling"] else "  ok"))
    print("rows: %d" % r["rows"])
    for title, key in (("close or evict (looks finished, still in a live section)", "close_or_evict"),
                       ("stale (newest date more than %d days old)" % STALE_DAYS, "stale"),
                       ("coming up (inside %d days)" % SOON_DAYS, "coming_up")):
        if r[key]:
            print("\n%s:" % title)
            for x in r[key]:
                extra = " [%dd old]" % x["age_days"] if "age_days" in x else (" [in %dd]" % x["in_days"] if "in_days" in x else "")
                print("  - %s: %s%s" % (x["section"], x["row"], extra))
    if r["prune"]:
        print("\nprune: RECENTLY CLOSED has %d rows (keep %d); move the oldest %d to today's log." % (r["recently_closed_rows"], CLOSED_KEEP, r["prune"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
