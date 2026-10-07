#!/usr/bin/env python3
"""statusline.py: the status line. `model | ██░░░░░░░░ 20% | 7d: 12% | handoff: 3h`

Claude Code pipes a JSON document to a statusLine command on stdin. Python so it needs no jq. It prints ONE line:
the model name, a ten-block bar of how full the context window is (a long session needs a /compact or a handoff
before it hits the wall), the seven-day usage figure when the plan reports one, and how long ago
memory/HANDOFF.md was last written (the continuity layer is only as good as that file is fresh).

Always exits 0. Malformed input prints just the model if one can be found, else nothing. No state, no kill switch:
there is nothing to wedge; remove the statusLine block from .claude/settings.json to turn it off.
"""
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


def handoff_age():
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import _talos_common as C
        f = C.contained(os.path.join(ROOT, "memory", "HANDOFF.md"))      # a link anywhere on the way: not ours, show nothing
        if not f:
            return ""
        s = time.time() - os.path.getmtime(f)
    except Exception:
        return ""
    h = int(s // 3600)
    return "handoff: %dm" % max(1, int(s // 60)) if h < 1 else ("handoff: %dh" % h if h < 48 else "handoff: %dd" % (h // 24))


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")   # a LANG=C terminal would otherwise fail on the block characters
    except Exception:
        pass
    try:
        d = json.loads(sys.stdin.read() or "{}")
        if not isinstance(d, dict):
            d = {}
    except Exception:
        d = {}
    model = str((d.get("model") or {}).get("display_name") or "") if isinstance(d.get("model"), dict) else ""
    out = [model] if model else []
    try:
        pct = (d.get("context_window") or {}).get("used_percentage")
        if pct is not None:
            pct = max(0, min(100, int(round(float(pct)))))
            filled = min(10, pct // 10)
            out.append("%s%s %d%%" % ("█" * filled, "░" * (10 - filled), pct))
    except Exception:
        pass
    try:
        week = ((d.get("rate_limits") or {}).get("seven_day") or {}).get("used_percentage")
        if week is not None:
            out.append("7d: %d%%" % int(round(float(week))))
    except Exception:
        pass
    h = handoff_age() if d else ""
    if h:
        out.append(h)
    print(" | ".join(out))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
