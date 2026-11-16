#!/usr/bin/env python3
"""One machine's Claude Code token spend, from its own transcripts. Read-only, standard library only (python3 3.9+).

    python3 scripts/spend.py [--days N] [--by agent|model|project] [--json] [--root DIR] [--until YYYY-MM-DD] [--machine NAME]

The window is the N whole UTC days before --until (default: today, UTC), so `--days 1` is the previous UTC day.
Reads ~/.claude/projects (or $CLAUDE_CONFIG_DIR/projects), and on WSL the Windows user's too: each project's <session>.jsonl (the session itself, counted as
`main`) and <session>/subagents/**/agent-*.jsonl, named by the sibling agent-*.meta.json (its name, else its agentType).
Every assistant message counts once (Claude Code writes one line per content block, each with the same usage), by its
message.id, and only when its timestamp is inside the window. Project folders of scratch and temp runs are skipped.

--json (with --machine, the name Lemnos files it under) prints one object, schema "talos-spend/1": machine, window, by, rows (key, runs, turns, input, cache_new, cache_read,
output) and total. Fields are only ever added under this schema; a change of meaning gets a new one. A tracker only: it
never blocks or slows anything.
"""
import argparse
import datetime as dt
import glob
import json
import os
import re
import subprocess
import sys

SCHEMA = "talos-spend/1"
SKIP = re.compile(r"scratchpad|-private-tmp-|-tmp-")
FIELDS = (
    ("input", "input_tokens"),
    ("cache_new", "cache_creation_input_tokens"),
    ("cache_read", "cache_read_input_tokens"),
    ("output", "output_tokens"),
)
FOOTER = "raw tokens, not plan usage; records expire ~30 days"


def utc_day(text):
    try:
        return dt.datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc)
    except ValueError:
        raise argparse.ArgumentTypeError("a date is YYYY-MM-DD")


def positive(text):
    if not text.isdigit() or int(text) < 1:
        raise argparse.ArgumentTypeError("a whole number of days, 1 or more")
    return int(text)


def machine_name(text):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,39}", text):
        raise argparse.ArgumentTypeError("lowercase letters, digits and -")
    return text


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(text):
    try:
        return dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None


def turns(path, start, end):
    """{message id: (model, usage)} of the assistant messages in the window; the last line of each message wins."""
    found = {}
    try:
        f = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return found
    with f:
        for line in f:
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if not isinstance(o, dict):
                continue
            m = o.get("message")
            if o.get("type") != "assistant" or not isinstance(m, dict) or not isinstance(m.get("usage"), dict):
                continue
            t = parse_ts(o.get("timestamp"))
            if t is None or t.tzinfo is None or not (start <= t < end):
                continue
            key = m.get("id") or o.get("requestId") or o.get("uuid")
            if key:
                found[key] = (m.get("model") or "unknown", m["usage"])
    return found


def agent_name(jsonl):
    try:
        with open(jsonl[: -len(".jsonl")] + ".meta.json", encoding="utf-8") as f:
            meta = json.load(f)
        return meta.get("name") or meta.get("agentType") or "subagent"
    except (OSError, ValueError, AttributeError):
        return "subagent"


def windows_projects():
    """On WSL, the Windows user's ~/.claude/projects (as /mnt/<drive>/...): Claude Code run from the Windows app (Titan's
    sessions) writes its transcripts there, not in the distro's home (found 2026-11-16: Titan's line read 0 runs). Asked of
    Windows itself (cmd.exe), else the one /mnt/c/Users/* that has one; None off WSL or when it cannot be told.
    TALOS_SPEND_WINDOWS_HOME (a test's) names the Windows home instead."""
    try:
        with open("/proc/sys/kernel/osrelease", encoding="utf-8") as f:
            wsl = "microsoft" in f.read().lower()
    except OSError:
        wsl = False
    if not (wsl or os.environ.get("WSL_DISTRO_NAME") or os.environ.get("TALOS_SPEND_WINDOWS_HOME")):
        return None
    home = os.environ.get("TALOS_SPEND_WINDOWS_HOME")
    if not home:
        try:
            out = subprocess.run(["cmd.exe", "/c", "echo %USERPROFILE%"], cwd="/mnt/c", capture_output=True, text=True,
                                 timeout=10).stdout.strip()
            m = re.fullmatch(r"([A-Za-z]):\\(.*)", out)
            if m:
                home = "/mnt/%s/%s" % (m.group(1).lower(), m.group(2).replace("\\", "/"))
        except (OSError, ValueError, subprocess.SubprocessError):
            home = None
    if not home:
        found = [d for d in glob.glob("/mnt/c/Users/*/.claude/projects") if os.path.isdir(d)]
        return found[0] if len(found) == 1 else None
    p = os.path.join(home, ".claude", "projects")
    return p if os.path.isdir(p) else None


def transcripts(root):
    """(project, agent, path) for every session and subagent transcript under the projects folder."""
    for proj in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        pdir = os.path.join(root, proj)
        if SKIP.search(proj) or not os.path.isdir(pdir):
            continue
        for session in sorted(glob.glob(os.path.join(pdir, "*.jsonl"))):
            yield proj, "main", session
        for sub in sorted(glob.glob(os.path.join(pdir, "*", "subagents", "**", "agent-*.jsonl"), recursive=True)):
            yield proj, agent_name(sub), sub


def tally(roots, start, end, by):
    rows = {}
    for proj, agent, path in (t for root in roots for t in transcripts(root)):
        found = turns(path, start, end)
        if not found:
            continue
        seen = set()
        for model, u in found.values():
            key = {"agent": agent, "model": model, "project": proj}[by]
            r = rows.setdefault(key, {"key": key, "runs": 0, "turns": 0, **{k: 0 for k, _ in FIELDS}})
            if key not in seen:
                r["runs"] += 1
                seen.add(key)
            r["turns"] += 1
            for k, src in FIELDS:
                v = u.get(src)
                r[k] += v if isinstance(v, int) and v > 0 else 0
    out = sorted(rows.values(), key=lambda r: (-sum(r[k] for k, _ in FIELDS), r["key"]))
    total = {"runs": 0, "turns": 0, **{k: 0 for k, _ in FIELDS}}
    for r in out:
        for k in total:
            total[k] += r[k]
    return out, total


def table(by, rows, total):
    head = [by, "runs", "turns", "input", "cache_new", "cache_read", "output"]
    body = [[r["key"]] + [str(r[k]) for k in head[1:]] for r in rows] + [["TOTAL"] + [str(total[k]) for k in head[1:]]]
    w = [max(len(x[i]) for x in [head] + body) for i in range(len(head))]
    fmt = lambda cells: "  ".join(c.ljust(w[0]) if i == 0 else c.rjust(w[i]) for i, c in enumerate(cells)).rstrip()
    return "\n".join([fmt(head)] + [fmt(x) for x in body] + [FOOTER])


def main(argv):
    p = argparse.ArgumentParser(description="Token spend from this machine's Claude Code transcripts (read-only).")
    p.add_argument("--days", type=positive, default=1)
    p.add_argument("--by", choices=("agent", "model", "project"), default="agent")
    p.add_argument("--json", action="store_true")
    # given: only that folder (repeatable). Not given: this home's, and on WSL the Windows user's too (windows_projects)
    p.add_argument("--root", action="append")
    p.add_argument("--until", type=utc_day, help="end of the window, exclusive (default: today, UTC)")
    # the name Lemnos files the line under (lemnos, delphi, cyclops, titan, hestia): neither the hostname nor CI_STATUS_WHERE
    # (ci-runner on Lemnos) is it, so a --json line must say it
    p.add_argument("--machine", type=machine_name)
    a = p.parse_args(argv)
    if a.json and not a.machine:
        p.error("--json needs --machine (lemnos, delphi, cyclops, titan or hestia)")
    end = a.until or dt.datetime.now(dt.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    start = end - dt.timedelta(days=a.days)
    roots = a.root
    if not roots:
        roots = [os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), "projects")]
        win = windows_projects()
        if win and os.path.realpath(win) != os.path.realpath(roots[0]):
            roots.append(win)
    rows, total = tally(roots, start, end, a.by)
    if a.json:
        window = {"start": iso(start), "end": iso(end), "days": a.days}
        print(json.dumps({"schema": SCHEMA, "machine": a.machine, "window": window, "by": a.by, "rows": rows, "total": total}))
    else:
        print(table(a.by, rows, total))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
