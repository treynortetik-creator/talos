#!/usr/bin/env python3
"""append-only-guard.py: PreToolUse. Stop a write that would DESTROY an append-only log.

WHY. A write tool that only overwrites forces an agent to "append" by reading the file, concatenating, and
writing the whole thing back. Do that with a stale read, or let two writers interleave, and everything written
since the read is gone, silently and unrecoverably. Prompt rules against it provably do not hold.

WHAT IT GUARDS, by shape and not by author: the files that are history and must only grow.
    memory/YYYY-MM-DD.md        daily logs
    wiki/_changelog.md          the wiki's change log
    memory/decisions-ledger.md  the judgment ledger
    memory/agent-log.md         the harness-written sub-agent log
It asks (it does not forbid) only when a whole-file Write would shrink one of them below 90% of its current size
(files of 500 bytes or more). Growth, small edits and the Edit tool pass untouched: only a whole-file
replacement can truncate. Anything outside the agent folder is ignored. Fails open on anything unexpected.
Kill switch: append-only-guard.off
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _talos_common as C  # noqa: E402

KILL_NAME = "append-only-guard.off"
PROTECTED = (
    re.compile(r"^memory/\d{4}-\d{2}-\d{2}\.md$"),
    re.compile(r"^wiki/_changelog\.md$"),
    re.compile(r"^memory/decisions-ledger\.md$"),
    re.compile(r"^memory/agent-log\.md$"),
)
SHRINK_TOLERANCE = 0.90      # a rewrite keeping under 90% of the bytes is suspicious
MIN_BYTES = 500


def relpath_in_root(path):
    """Path relative to the agent folder, or None when it is outside it."""
    try:
        full = os.path.realpath(path if os.path.isabs(path) else os.path.join(C.ROOT, path))
        if full == C.ROOT or not full.startswith(C.ROOT + os.sep):
            return None
        return os.path.relpath(full, C.ROOT).replace(os.sep, "/")
    except Exception:
        return None


def main():
    if C.killed(KILL_NAME):
        print("{}")
        return
    d = C.read_stdin()
    ti = d.get("tool_input") or {}
    path = ti.get("file_path") or ti.get("path") or ""
    rel = relpath_in_root(str(path)) if path else None
    if not rel or not any(p.match(rel) for p in PROTECTED):
        print("{}")
        return
    new = ti.get("content")
    if not isinstance(new, str):          # an Edit (or anything that is not a whole-file write) is surgical
        print("{}")
        return
    full = os.path.realpath(path if os.path.isabs(path) else os.path.join(C.ROOT, path))
    if not os.path.exists(full):
        print("{}")
        return
    old_len = os.path.getsize(full)
    new_len = len(new.encode("utf-8"))
    if old_len < MIN_BYTES or new_len >= old_len * SHRINK_TOLERANCE:
        print("{}")
        return
    pct = 100 * (1 - new_len / float(old_len))
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "ask",
        "permissionDecisionReason": (
            "This overwrite would SHRINK an append-only file by %.0f%% (%d -> %d bytes):\n  %s\n\n"
            "Daily logs, the changelog and the ledgers are history. The usual cause is faking an append by "
            "reading the file, concatenating and overwriting it, which loses everything written since the read.\n\n"
            "Append instead (>> or an Edit that adds a line). If you genuinely mean to rewrite this file, "
            "confirm here." % (pct, old_len, new_len, rel))}}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("{}")
