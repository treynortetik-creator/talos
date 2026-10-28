#!/usr/bin/env python3
"""dream/revert.py [date]: remove exactly the links dream/apply.py added on that night (per applied.json).
A file that is unchanged since apply is restored byte-exact from preimage/; a file edited since has just the
one bullet line removed. Adds a revert row to wiki/_changelog.md (the original row is never deleted) and
renames the ledger to applied.reverted.json. QUEUE.md entries are left alone: tick or delete them yourself.

  python3 scripts/dream/revert.py 2026-10-28
"""
import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
from apply import sha  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("date", nargs="?", default=None)
    a = ap.parse_args(argv)
    date = a.date or C.today()
    run = C.run_dir(date)
    led = C.jload(os.path.join(run, "applied.json"))
    if not led:
        print("no applied.json for %s" % date)
        return 1
    removed = restored = missing = 0
    by_file = {}
    for e in led.get("applied", []):
        by_file.setdefault(e["file"], []).append(e)
    for f, es in by_file.items():
        path = os.path.join(C.ROOT, f)
        cur = C.read(path)
        pre_p = os.path.join(run, "preimage", f.replace("/", "__"))
        pre = C.read(pre_p) if os.path.isfile(pre_p) else ""
        if pre and sha(cur) == es[-1]["after_sha"]:
            C.write(path, pre)
            restored += len(es)
            continue
        for e in reversed(es):
            lines = cur.split("\n")
            idx = [i for i, l in enumerate(lines) if l == e["bullet"]]
            if not idx:
                missing += 1
                continue
            del lines[idx[-1]]
            cur = "\n".join(lines)
            if e.get("created_section"):
                cur = re.sub(r"\n*## Related\n+(?=(##\s|<!--|\Z))", "\n\n", cur, count=1)
            removed += 1
        C.write(path, cur)
    if led.get("applied"):
        C.changelog_add("| %s | **Dream cycle revert %s.** Removed the %d links `scripts/dream/apply.py` added on %s "
                        "(ledger kept as `applied.reverted.json`). |" % (C.today(), date, len(led["applied"]), date))
    os.rename(os.path.join(run, "applied.json"), os.path.join(run, "applied.reverted.json"))
    print("dream revert %s: restored %d (byte-exact), removed %d, already gone %d" % (date, restored, removed, missing))
    return 0


if __name__ == "__main__":
    sys.exit(main())
