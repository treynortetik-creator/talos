#!/usr/bin/env python3
"""compaction-guard.py: PreCompact. Write down what a compaction summary tends to drop, so the session-start hook can
hand it back.

WHY. A compaction summary keeps the task and loses the "no, do it this way" you said an hour ago, so the same
correction gets earned twice. Claude Code re-injects CLAUDE.md after a compaction, so the standing rules survive. What
does NOT reliably survive: the corrections logged in the last few days, a hands-free window you opened, and a chat
reply that is still owed.

ROLES (argv[1])
  save   PreCompact: write <state>/compaction-carry.md. Contents, each only if there is something to say:
           - recent corrections: entries of .learnings/LEARNINGS.md dated in the last 3 days, newest first, capped;
           - an open hands-free window (minutes left);
           - a note that a chat reply was owed for THIS session.
  show   print the current carry file (debugging).

There is deliberately NO "inject" role here: hooks/session-start.py already fires on the `compact` event and reads this
file, so the digest and the carry arrive in ONE block instead of two hooks racing to inject. Nothing is injected when
the file is missing or empty.

The text is copied from .learnings (file text) and is injected inside the continuity block's data wrapper by
session-start.py: it is context, never an instruction that can override CLAUDE.md or the user.

Never blocks, never writes outside <state>. FAILS OPEN, ALWAYS. Kill switch: compaction-guard.off
"""
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _talos_common as C  # noqa: E402

KILL_NAME = "compaction-guard.off"
CORR_DAYS = 3
CORR_CHARS = 3500          # the whole corrections block; a runaway log must not become a context problem of its own
ENTRY_CHARS = 700
LEARNINGS = ("LEARNINGS.md",)


def carry_path():
    return os.path.join(C.state_dir(), "compaction-carry.md")


def corrections():
    days = {time.strftime("%Y-%m-%d", time.localtime(time.time() - 86400 * i)) for i in range(CORR_DAYS)}
    items = []
    for name in LEARNINGS:
        text = C.read_contained(os.path.join(C.ROOT, ".learnings", name))
        for sec in re.split(r"\n(?=## )", text):
            if not sec.startswith("## "):
                continue
            head = sec.split("\n", 1)[0]
            m = re.search(r"20\d\d-\d\d-\d\d", head)
            if not m or m.group(0) not in days:
                continue
            body = sec.split("\n", 1)[1] if "\n" in sec else ""
            happened = re.search(r"\*\*What happened:\*\*\s*(.+?)(?=\n\*\*|\Z)", body, re.S)
            rule = re.search(r"\*\*Rule[^*]*\*\*\s*(.+?)(?=\n\*\*|\Z)", body, re.S)
            parts = [head[3:].strip()]
            if happened:
                parts.append("what happened: " + happened.group(1))
            if rule:
                parts.append("rule: " + rule.group(1))
            items.append((m.group(0), re.sub(r"\s+", " ", " | ".join(parts)).strip()[:ENTRY_CHARS]))
    items.sort(key=lambda x: x[0], reverse=True)
    out, used = [], 0
    for day, txt in items:
        line = "- " + txt
        if used + len(line) > CORR_CHARS:
            break
        out.append(line)
        used += len(line)
    return out


def hands_free_note():
    d = C.load_json(os.path.join(C.state_dir(), "hands-free.json"))
    if d and time.time() < float(d.get("until", 0)):
        return "HANDS-FREE is ON, %d min left: substantial chat replies must go out as audio WITH the full text." % max(1, int((float(d["until"]) - time.time()) // 60))
    return ""


def debt_note(session_id):
    sid = re.sub(r"[^A-Za-z0-9_-]", "", str(session_id or ""))[:64]
    d = C.load_json(os.path.join(C.state_dir(), "channel-debt-%s.json" % sid if sid else "channel-debt.json"))
    if d and time.time() - float(d.get("ts", 0)) < 3 * 3600:
        return "A chat reply was still owed when the context was compacted. Check it went out."
    return ""


def save(data):
    lines = []
    c = corrections()
    if c:
        lines.append("Corrections logged in the last %d days (still in force):" % CORR_DAYS)
        lines += c
    for note in (hands_free_note(), debt_note(data.get("session_id"))):
        if note:
            lines.append(note)
    path = carry_path()
    if not lines:
        C.drop(path)             # nothing to carry: do not leave yesterday's carry behind
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.tmp.%d" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write("Snapshotted %s before a context compaction.\n%s\n" % (time.strftime("%Y-%m-%d %H:%M"), "\n".join(lines)))
    os.replace(tmp, path)


def main():
    role = sys.argv[1] if len(sys.argv) > 1 else ""
    if role == "show":
        try:
            sys.stdout.write(open(carry_path(), encoding="utf-8").read())
        except OSError:
            pass
        return
    if C.killed(KILL_NAME):
        return
    if role == "save":
        save(C.read_stdin())


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass                      # fail open, always
