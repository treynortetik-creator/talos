#!/usr/bin/env python3
"""timeline-guard.py: PreToolUse. Refuse a wiki write that puts a BAD timeline entry on disk.

WHY. Timeline entries are append-only: a malformed one cannot be repaired later without deliberately breaking the
very rule that makes the layer trustworthy. In the reference agent this kit grew out of, the same few shapes came
back week after week and the lint reported them every Monday: an entry hard-wrapped over several lines, `## Related`
or open-question bullets written BELOW the separator, preamble prose below it, an author written `@x via y`, a
confidence value followed by prose, a date older than the entry above. Instructions in a prompt did not stop it.

WHAT. On Write, Edit or MultiEdit to wiki/**/*.md it computes the file's PROPOSED content (Write: the content;
Edit and MultiEdit: the replacements applied to the file on disk), runs the lint's own timeline rules (E1-E5) and
judges only the lines that are NEW. A violation the file already carries never blocks an unrelated edit. On a
violation it DENIES, quoting the offending line, why it fails, and the one-line entry format, so the writer (often
an ingest sub-agent) can fix the line and retry.

ONE RULE SET. The rules live in scripts/wiki-lint.py (timeline_findings, new_timeline_violations). This hook
imports them and restates nothing, so lint and guard cannot drift apart.

Only a note that already contains the `<!-- TIMELINE:APPEND-ONLY -->` separator is checked (opt-in, as in the lint).
wiki/_*.md bookkeeping files, README, CLAUDE, index and wiki/examples/ are skipped, as in the lint.
Unexpected errors (an unreadable file, a missing or broken wiki-lint.py) fail OPEN in a live session and CLOSED (deny)
in an unattended run. An Edit that simply will not apply is not an error: the tool fails it by itself. Kill switch: timeline-guard.off
"""
import importlib.util
import json
import os
import re
import sys

try:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import _talos_common as C  # noqa: E402
except Exception as _e:        # the shared helpers will not load: fail open in a live session, CLOSED when unattended
    if os.environ.get("CHRONOS_RUN") == "1" or os.environ.get("TALOS_UNATTENDED") == "1":
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
              "permissionDecisionReason": "Talos timeline-guard could not load hooks/_talos_common.py (" + type(_e).__name__ + ": " + str(_e)[:120] + ") and this run is unattended, so the action is blocked rather than allowed unchecked."}}))
    else:
        print("{}")
    sys.exit(0)

KILL_NAME = "timeline-guard.off"
LINT = os.path.join(C.ROOT, "scripts", "wiki-lint.py")
SKIP_NAMES = {"README", "CLAUDE", "CONTRIBUTING", "index"}
MAX_SHOWN = 4


def allow():
    print("{}")


def relpath_in_root(path):
    """Path relative to the agent folder, or None when it is outside it."""
    try:
        full = os.path.realpath(path if os.path.isabs(path) else os.path.join(C.ROOT, path))
        if full == C.ROOT or not full.startswith(C.ROOT + os.sep):
            return None
        return os.path.relpath(full, C.ROOT).replace(os.sep, "/")
    except Exception:
        return None


def in_scope(rel):
    if not re.match(r"^wiki/.+\.md$", rel):
        return False
    base = os.path.basename(rel)[:-3]
    return not (base.startswith("_") or base in SKIP_NAMES or rel.startswith("wiki/examples/"))


def load_lint():
    spec = importlib.util.spec_from_file_location("wiki_lint_shared", LINT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def apply_edit(text, old, new, replace_all):
    """The Edit tool's semantics. None when it would not apply (the Edit fails on its own; not our business)."""
    if not isinstance(old, str) or not isinstance(new, str) or old == "" or old not in text:
        return None
    if text.count(old) > 1 and not replace_all:
        return None
    return text.replace(old, new) if replace_all else text.replace(old, new, 1)


def proposed(tool, ti, full):
    """(old_text, new_text) or None."""
    old = ""
    if os.path.exists(full):
        with open(full, encoding="utf-8") as fh:
            old = fh.read()
    if tool == "Write" or (tool is None and "content" in ti):
        new = ti.get("content")
        return (old, new) if isinstance(new, str) else None
    if tool == "MultiEdit" or "edits" in ti:
        cur = old
        for e in ti.get("edits") or []:
            cur = apply_edit(cur, e.get("old_string"), e.get("new_string"), bool(e.get("replace_all")))
            if cur is None:
                return None
        return old, cur
    cur = apply_edit(old, ti.get("old_string"), ti.get("new_string"), bool(ti.get("replace_all")))
    return (old, cur) if cur is not None else None


def deny_reason(lint, rel, viol):
    shown = viol[:MAX_SHOWN]
    parts = ["TIMELINE GUARD: this write would put a malformed entry below the append-only separator in\n  %s\n" % rel]
    for code, lineno, line, why in shown:
        text = " ".join(line.split())
        if len(text) > 220:
            text = text[:217] + "..."
        parts.append("[%s] line %d: %s\n  WHY: %s\n" % (code, lineno, text, why))
    if len(viol) > len(shown):
        parts.append("(+%d more of the same kind)\n" % (len(viol) - len(shown)))
    parts.append(
        "THE RULE (wiki/README.md, 'Dossier pattern'): above the separator is rewritable synthesis, including "
        "## Related and ## Open questions. Below it is ONLY one-line dated entries, oldest first, newest at the bottom:\n"
        "  FORMAT : %s\n"
        "  GOOD   : %s\n"
        "  BAD    : %s\n"
        "           (author is '@me via Lindsay'; the entry ends in prose after Confidence; if it were also hard-wrapped "
        "over two lines that is a third error)\n"
        "Source is a [[wikilink]] (a bare slug is best), a path or a short plain origin. Confidence is exactly one of "
        "high|medium|low, optionally one parenthetical, then nothing.\n"
        "Fix the lines above and retry. Do not edit or delete existing entries. To turn this guard off: touch "
        "<state folder>/timeline-guard.off or set TALOS_TIMELINE_GUARD_OFF=1."
        % (lint.ENTRY_FORMAT, lint.ENTRY_GOOD, lint.ENTRY_BAD))
    return "\n".join(parts)


def main():
    if C.killed(KILL_NAME):
        return allow()
    d = C.read_stdin()
    ti = d.get("tool_input")
    if not isinstance(ti, dict):
        return allow()
    path = ti.get("file_path") or ti.get("path") or ""
    if not isinstance(path, str) or not path:
        return allow()
    rel = relpath_in_root(path)
    if not rel or not in_scope(rel):
        return allow()
    tool = d.get("tool_name")
    if tool not in (None, "Write", "Edit", "MultiEdit"):
        return allow()
    full = os.path.realpath(path if os.path.isabs(path) else os.path.join(C.ROOT, path))
    pair = proposed(tool, ti, full)
    if pair is None:
        return allow()
    lint = load_lint()
    viol = lint.new_timeline_violations(pair[0], pair[1])
    if not viol:
        return allow()
    C.log_jsonl("timeline-guard.jsonl", {"path": rel, "tool": tool, "codes": [v[0] for v in viol],
                                          "first": viol[0][2][:160]})
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": deny_reason(lint, rel, viol)}}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        C.guard_failed("timeline-guard", e)       # {} in a live session; a deny when unattended
