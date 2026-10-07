#!/usr/bin/env python3
"""agent-log.py: SubagentStop hook. One row per sub-agent run, written by the HARNESS, not by the agent.

WHY. A sub-agent's own report is a claim, not a fact: an agent can say it wrote a file it never wrote, and the
phantom path then gets copied into other notes. This log is written by the hook, so it does not depend on an
agent describing itself honestly, and it lists an artifact path ONLY if that path exists inside the agent folder
at the moment the sub-agent stopped. Harvesting paths from text and logging them unchecked would be worse than
logging nothing.

Writes memory/agent-log.md (append-only; the append-only guard protects it). A payload with nothing that
identifies the run writes NO row: a log full of blank rows is a log nobody reads.
Never blocks, never fails a run: any error is silence. Kill switch: agent-log.off
"""
import datetime
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _talos_common as C  # noqa: E402

KILL_NAME = "agent-log.off"
LOG = os.path.join(C.ROOT, "memory", "agent-log.md")
HEADER = ("# Agent log\n\n"
          "Written by the `SubagentStop` hook, not by any agent. **Append-only, oldest first.**\n\n"
          "Exists because an agent's own report is a claim, not a fact. Artifact paths are listed only if they\n"
          "EXISTED inside this folder when the agent stopped.\n\n"
          "| When | Agent | Task | Verified artifacts |\n|---|---|---|---|\n")


def pick(d, *keys):
    for k in keys:
        v = d.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def first_user_text(transcript_path):
    """The task a sub-agent was given, from the first user message in its transcript (best effort)."""
    try:
        with open(transcript_path, encoding="utf-8", errors="replace") as fh:
            for _ in range(40):
                line = fh.readline()
                if not line:
                    break
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                if rec.get("type") != "user":
                    continue
                msg = rec.get("message") or {}
                content = msg.get("content")
                if isinstance(content, str):
                    return content.strip()
                if isinstance(content, list):
                    for c in content:
                        if isinstance(c, dict) and c.get("type") == "text" and c.get("text"):
                            return c["text"].strip()
    except Exception:
        pass
    return ""


def clean(s, n):
    s = re.sub(r"\s+", " ", s).replace("|", "/").strip()
    return (s[: n - 1] + "…") if len(s) > n else s


def existing_artifacts(text, limit=3):
    """Paths in `text` that exist INSIDE the agent folder, shown relative to it."""
    out = []
    for cand in re.findall(r"[~\w./-]*/[\w./-]+|[\w-]+\.(?:md|py|sh|json|html|txt|csv)", text):
        cand = cand.strip(".,;:)")
        p = os.path.expanduser(cand)
        full = C.contained(p)                   # inside the folder, no link on the way
        if full and full != C.ROOT and os.path.exists(full):
            rel = os.path.relpath(full, C.ROOT)
            if rel not in out:
                out.append(rel)
        if len(out) >= limit:
            break
    return out


def main():
    if C.killed(KILL_NAME):
        return
    d = C.read_stdin()
    agent = pick(d, "subagent_type", "agent_type", "name")
    desc = pick(d, "description", "task", "prompt")
    if not desc and d.get("agent_transcript_path"):
        desc = first_user_text(str(d["agent_transcript_path"]))
    last = pick(d, "last_assistant_message", "result", "output")
    if not desc and not agent:
        return
    ts = datetime.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M %Z")
    arts = existing_artifacts(last)
    art = " · ".join(arts) if arts else "—"
    row = "| %s | %s | %s | %s |\n" % (ts, clean(agent, 24) or "?", clean(desc, 80) or "?", clean(art, 90))
    # C.append_contained: the log must resolve inside the agent folder with no symlink on the way (a symlinked memory/
    # would otherwise append rows to a file somewhere else), and it only ever appends: several can stop in one minute.
    if not C.contained(LOG):
        return
    if not os.path.exists(LOG):
        C.append_contained(LOG, HEADER)
    C.append_contained(LOG, row)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
