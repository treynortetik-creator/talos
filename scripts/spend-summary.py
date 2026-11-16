#!/usr/bin/env python3
"""Lemnos's side of the spend tracker: keeps each machine's daily line and prints the one summary line. Standard library
only; a tracker, never a gate.

    spend.py --days 1 --json | python3 scripts/spend-summary.py receive        # keep a line (any machine's, Lemnos's own too)
    python3 scripts/spend-summary.py summarize [--date YYYY-MM-DD]             # default: the previous UTC day

receive: one talos-spend/1 object on stdin, kept as <dir>/<date>/<machine>.json (dir: ~/.cache/talos-ci/spend), the date
being its window's first day. A later line from the same machine and day replaces it.

summarize, first run for a date: prints ONE line for the owner's thread (each machine in --machines: its tokens, or "no
report" when no line came, never 0; and its runner minutes that day from the GitHub jobs API of --repo, by runner name; "?"
with gh's error on stderr when GitHub can't be read), and appends a
row per machine to spend.tsv (~/.cache/talos-ci/logs/spend.tsv). Any later run for that date: a line that came since is
appended as "late", and nothing is printed (no repost).

spend.tsv: date, machine, status (report|no report|late), runs, turns, input, cache_new, cache_read, output, job_min,
recorded_at. Empty fields when there is no report; job_min is empty when the jobs could not be read.
"""
import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys

SCHEMA = "talos-spend/1"
MACHINE = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
MACHINES = "lemnos,delphi,cyclops,titan,hestia"
TOKENS = ("runs", "turns", "input", "cache_new", "cache_read", "output")
CACHE = os.path.expanduser("~/.cache/talos-ci")
REPO = "treynortetik-creator/talos-app"


def fail(msg):
    print("spend-summary: " + msg, file=sys.stderr)
    return 2


def runner_machine(name):
    """GitHub runner name -> machine: Lemnos's runners are m5-max, m5-max-2, ... (docs/CI-MACHINES.md); others are named for theirs."""
    name = (name or "").lower()
    return "lemnos" if name.startswith("m5-max") else name


def parse_ts(text):
    try:
        return dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None


def receive(a):
    try:
        o = json.loads(sys.stdin.read())
    except ValueError:
        return fail("not JSON")
    if not isinstance(o, dict) or o.get("schema") != SCHEMA:
        return fail("not a " + SCHEMA + " line")
    m, start = o.get("machine"), parse_ts((o.get("window") or {}).get("start"))
    total = o.get("total")
    if not isinstance(m, str) or not MACHINE.fullmatch(m) or start is None or not isinstance(total, dict):
        return fail("a line needs machine, window.start and total")
    if (o.get("window") or {}).get("days") != 1:
        return fail("a line is one UTC day (spend.py --days 1)")
    if not all(isinstance(total.get(k), int) for k in TOKENS):
        return fail("total needs " + ", ".join(TOKENS))
    day = os.path.join(a.dir, start.strftime("%Y-%m-%d"))
    os.makedirs(day, exist_ok=True)
    tmp = os.path.join(day, "." + m + ".json.part")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(o, f)
    os.replace(tmp, os.path.join(day, m + ".json"))
    return 0


def gh(args):
    """One `gh api --paginate` call's output. Raises RuntimeError with gh's own words when it fails."""
    try:
        r = subprocess.run(["gh", "api", "--paginate"] + args, capture_output=True, text=True, timeout=120,
                           stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as e:
        raise RuntimeError(str(e))
    if r.returncode != 0:
        raise RuntimeError((r.stderr.strip().splitlines() or ["gh exit %d" % r.returncode])[0][:200])
    return r.stdout


def gh_jobs(date, repo):
    """Every job of every run created that UTC day, re-run attempts too: [{runner_name, started_at, completed_at}]. None if
    GitHub can't say, with why on stderr."""
    try:
        jobs = []
        for rid in gh(["repos/" + repo + "/actions/runs?created=" + date + "&per_page=100", "--jq", ".workflow_runs[].id"]).split():
            out = gh(["repos/" + repo + "/actions/runs/" + rid + "/jobs?filter=all&per_page=100",
                      "--jq", ".jobs[] | {runner_name, started_at, completed_at}"])
            jobs += [json.loads(x) for x in out.splitlines() if x.strip()]
        return jobs
    except (RuntimeError, ValueError) as e:
        print("spend-summary: could not read the runner minutes of %s on %s: %s" % (repo, date, e), file=sys.stderr)
        return None


def job_minutes(jobs):
    """{machine: minutes} from finished jobs; None when the jobs are unknown."""
    if not isinstance(jobs, list):
        return None
    mins = {}
    for j in jobs:
        if not isinstance(j, dict):
            continue
        s, e = parse_ts(j.get("started_at")), parse_ts(j.get("completed_at"))
        if j.get("runner_name") and s and e and e >= s:  # no runner: never picked up (a machine that was off)
            m = runner_machine(j.get("runner_name"))
            mins[m] = mins.get(m, 0.0) + (e - s).total_seconds() / 60
    return mins


def load_jobs(a):
    if a.jobs_file:
        try:
            with open(a.jobs_file, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None
    return gh_jobs(a.date, a.repo)


def short(n):
    return "%.1fM" % (n / 1e6)


def minutes(mins, m):
    if mins is None:
        return "? job-min"
    v = round(mins.get(m, 0.0), 1)
    return ("%d" % v if v == int(v) else "%.1f" % v) + " job-min"


def row(date, m, status, total, mins, now):
    t = [str(total[k]) for k in TOKENS] if total else [""] * len(TOKENS)
    jm = "" if mins is None else "%.1f" % mins.get(m, 0.0)
    return "\t".join([date, m, status] + t + [jm, now]) + "\n"


def summarize(a):
    day = os.path.join(a.dir, a.date)
    marker = os.path.join(day, ".summarized")
    lines = {}
    for m in sorted(os.listdir(day)) if os.path.isdir(day) else []:
        if m.endswith(".json") and MACHINE.fullmatch(m[:-5]):
            try:
                with open(os.path.join(day, m), encoding="utf-8") as f:
                    lines[m[:-5]] = json.load(f)["total"]
            except (OSError, ValueError, KeyError, TypeError):
                continue
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    os.makedirs(os.path.dirname(a.tsv) or ".", exist_ok=True)
    if os.path.exists(marker):  # already posted: a line that came since is recorded, never reposted
        with open(marker, encoding="utf-8") as f:
            done = set(f.read().split())
        late = [m for m in sorted(lines) if m not in done]
        if late:
            with open(a.tsv, "a", encoding="utf-8") as f:
                for m in late:
                    f.write(row(a.date, m, "late", lines[m], None, now))
            with open(marker, "a", encoding="utf-8") as f:
                f.write("".join(m + "\n" for m in late))
        return 0
    mins = job_minutes(load_jobs(a))
    machines = [m for m in a.machines.split(",") if m] + sorted(m for m in lines if m not in a.machines.split(","))
    parts, rows = [], []
    for m in machines:
        t = lines.get(m)
        if t:
            given = ", in " + short(t["input"]) if t["input"] >= 100_000 else ""  # uncached input is mostly tiny
            parts.append("%s %d runs%s, cache %s new / %s read, out %s, %s" % (
                m, t["runs"], given, short(t["cache_new"]), short(t["cache_read"]), short(t["output"]), minutes(mins, m)))
        else:
            jm = minutes(mins, m)
            parts.append(m + " no report" + ("" if jm == "0 job-min" else ", " + jm))
        rows.append(row(a.date, m, "report" if t else "no report", t, mins, now))
    with open(a.tsv, "a", encoding="utf-8") as f:
        f.writelines(rows)
    os.makedirs(day, exist_ok=True)
    with open(marker, "w", encoding="utf-8") as f:
        f.write("".join(m + "\n" for m in sorted(lines)))
    print("spend %s UTC: %s (raw tokens, not plan usage)" % (a.date, " · ".join(parts)))
    return 0


def main(argv):
    p = argparse.ArgumentParser(description="Keep machines' spend lines; print the daily summary line.")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("receive")
    r.add_argument("--dir", default=os.path.join(CACHE, "spend"))
    s = sub.add_parser("summarize")
    yesterday = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1)).strftime("%Y-%m-%d")
    s.add_argument("--date", default=yesterday)
    s.add_argument("--dir", default=os.path.join(CACHE, "spend"))
    s.add_argument("--tsv", default=os.path.join(CACHE, "logs", "spend.tsv"))
    s.add_argument("--machines", default=MACHINES)
    s.add_argument("--jobs-file", help="the jobs as JSON instead of asking GitHub (tests)")
    # explicit, never `gh repo view`: the daily job may run outside a checkout
    s.add_argument("--repo", default=REPO, help="owner/name (default: %(default)s)")
    a = p.parse_args(argv)
    if a.cmd == "summarize" and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", a.date):
        return fail("--date is YYYY-MM-DD")
    return receive(a) if a.cmd == "receive" else summarize(a)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
