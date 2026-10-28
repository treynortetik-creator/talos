#!/usr/bin/env python3
"""settings-merge.py: add the hooks a newer Talos registers to your .claude/settings.json, and touch nothing else.

WHY. upgrade.sh protects .claude/settings.json on purpose (it holds your permission grants), so it can only TELL you which
hooks the new kit registers that your file does not. Merging them by hand is the step people skip, and a hook that is
shipped but not registered does nothing. This does that one merge, safely:

  python3 scripts/settings-merge.py                 # dry run: show what would be added (changes nothing)
  python3 scripts/settings-merge.py --apply         # write it, after a timestamped backup next to the file
  python3 scripts/settings-merge.py --agent-dir DIR [--template FILE]

What it does: for every hook command in templates/dot-claude/settings.json that runs a script under hooks/, it checks that
your file has a command for the same script on the same event. Missing ones are added as new entries (with the template's
matcher). It never edits, removes or reorders an entry you already have, never touches permissions, env, statusLine,
enabledPlugins or any other key, never adds a Chronos hook (those are absolute paths that belong to your machine), and
reports (does not change) a hook whose matcher differs from the template, or whose registered script no longer exists.
If your file is not valid JSON it stops and changes nothing. Python 3.9, standard library only.
"""
import argparse
import json
import os
import re
import shutil
import sys
import time

SCRIPT = re.compile(r"hooks/([A-Za-z0-9_.-]+\.(?:py|sh))")


def load(path):
    with open(path, encoding="utf-8") as fh:
        d = json.load(fh)
    if not isinstance(d, dict):
        raise ValueError("%s is not a JSON object" % path)
    return d


def keyed(d):
    """{(event, script): [(entry_index, matcher, command)]} for every command that runs hooks/<script> via $CLAUDE_PROJECT_DIR."""
    out = {}
    for event, entries in (d.get("hooks") or {}).items():
        for i, e in enumerate(entries or []):
            if not isinstance(e, dict):
                continue
            for h in e.get("hooks") or []:
                c = h.get("command", "") if isinstance(h, dict) else ""
                m = SCRIPT.search(c)
                if m and "$CLAUDE_PROJECT_DIR" in c:
                    out.setdefault((event, m.group(1)), []).append((i, e.get("matcher"), c))
    return out


def merge(template, live):
    """-> (merged_copy, added [(event, script, matcher)], matcher_notes, stale)"""
    t, l = keyed(template), keyed(live)
    merged = json.loads(json.dumps(live))
    added, notes = [], []
    for (event, script), items in sorted(t.items()):
        if (event, script) in l:
            tm = items[0][1] or ""
            if tm and not any((m or "") == tm for _, m, _ in l[(event, script)]):
                notes.append("%s on %s: your matcher differs from the kit's ('%s'); left as it is" % (script, event, tm))
            continue
        for idx, matcher, _cmd in items:
            entry = json.loads(json.dumps(template["hooks"][event][idx]))
            merged.setdefault("hooks", {}).setdefault(event, []).append(entry)
            added.append((event, script, matcher))
            break
    return merged, added, notes


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--agent-dir", default=os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
    ap.add_argument("--template", help="default: <agent-dir>/templates/dot-claude/settings.json")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    agent = os.path.abspath(a.agent_dir)
    live_p = os.path.join(agent, ".claude", "settings.json")
    tmpl_p = a.template or os.path.join(agent, "templates", "dot-claude", "settings.json")
    try:
        tmpl = load(tmpl_p)
    except Exception as e:
        print("settings-merge: cannot read the kit's template %s: %s" % (tmpl_p, e))
        return 1
    if not os.path.exists(live_p):
        print("settings-merge: %s does not exist. Copy the template there: cp %s %s" % (live_p, tmpl_p, live_p))
        return 1
    try:
        live = load(live_p)
    except Exception as e:
        print("settings-merge: %s is not valid JSON (%s). Nothing changed; fix or restore it first." % (live_p, e))
        return 1
    merged, added, notes = merge(tmpl, live)
    stale = []
    for (event, script), items in keyed(merged).items():
        if not os.path.exists(os.path.join(agent, "hooks", script)):
            stale.append((event, script))
    for n in notes:
        print("  note: " + n)
    for ev, sc in sorted(stale):
        print("  STALE: %s on %s runs a script that does not exist; remove that entry" % (sc, ev))
    if not added:
        print("settings-merge: every hook the kit registers is already registered in %s" % live_p)
        return 0
    for ev, sc, m in added:
        print("  %s %s on %s%s" % ("adding" if a.apply else "would add", sc, ev, (" (matcher %s)" % m) if m else ""))
    if not a.apply:
        print("Dry run: nothing was written. Re-run with --apply to merge (a backup is taken first).")
        return 0
    bak = "%s.bak-%s" % (live_p, time.strftime("%Y%m%d-%H%M%S"))
    shutil.copy2(live_p, bak)
    mode = os.stat(live_p).st_mode & 0o777
    tmp = "%s.tmp.%d" % (live_p, os.getpid())
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(merged, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.chmod(tmp, mode)
    os.replace(tmp, live_p)
    print("settings-merge: wrote %s (backup: %s). Restart claude in this folder to load the hooks." % (live_p, bak))
    return 0


if __name__ == "__main__":
    sys.exit(main())
