#!/usr/bin/env python3
"""dream/budget.py [run_dir] [--spent N] [--proposals N]: cost guard for ONE session that reads the shards itself.

Estimates the tokens the session spends reading and extracting from each shard (bytes/3.2 + 4k reasoning + 2.5k
output), a fixed 20k for the prompt and tool results, and the judge pass (6k + 350 per verified proposal). Prints
JSON {allowed_shards, total_shards, est_extract, est_judge, est_total, ceiling, ceiling_hit} and merges it into
<run_dir>/run.json. `allowed_shards` is how many shards the session should read (shard-01 first); the ceiling is
300k tokens a night and at most 4 shards. The numbers are estimates; they bound the work, they do not meter it.
"""
import argparse
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

CEILING = 300000
BASE = 20000
JUDGE_RESERVE = 25000
MAX_SHARDS = 4


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dir", nargs="?", default=None)
    ap.add_argument("--spent", type=int, default=0, help="tokens already spent this run")
    ap.add_argument("--proposals", type=int, default=0, help="verified proposals about to be judged")
    a = ap.parse_args(argv)
    run = a.run_dir or C.run_dir()
    shards = sorted(glob.glob(os.path.join(run, "shards", "shard-*.json")))
    per = [int(os.path.getsize(s) / 3.2) + 6500 for s in shards]
    budget = CEILING - JUDGE_RESERVE - BASE - a.spent
    allowed, tot = 0, 0
    for c in per[:MAX_SHARDS]:
        if tot + c > budget:
            break
        tot += c
        allowed += 1
    judge = 6000 + 350 * a.proposals
    total = a.spent + BASE + tot + judge
    out = {"allowed_shards": allowed, "total_shards": len(shards), "est_extract": tot, "est_judge": judge,
           "est_total": total, "ceiling": CEILING, "ceiling_hit": allowed < len(shards) or total > CEILING}
    rj = os.path.join(run, "run.json")
    cur = C.jload(rj, {}) or {}
    cur.update(tokens_est=total, ceiling_hit=out["ceiling_hit"], shards_run=allowed)
    if out["ceiling_hit"]:
        cur["note"] = "read %d/%d shards" % (allowed, len(shards))
    C.jdump(cur, rj)
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
