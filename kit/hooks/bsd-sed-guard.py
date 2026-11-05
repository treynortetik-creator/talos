#!/usr/bin/env python3
"""bsd-sed-guard.py: PreToolUse (Bash). Stop the GNU spelling of `sed -i` before it runs on a Mac.

WHY. macOS ships BSD sed. Models write the GNU form `sed -i 's/a/b/' file`; BSD sed reads the script as the BACKUP
SUFFIX and then runs the FILE PATH as the script ("undefined label", "invalid command code", "bad flag in substitute
command"), and a mangled call can leave a stray `file<suffix>` backup behind. Refusing before it runs costs one retry
and never half-runs.

HOW. Heredoc bodies are stripped first (text being WRITTEN to a file is never matched). Then: `sed` with -i followed by
a quoted or unquoted s/ or y/ script, or by -e / -E / -n / -r. These pass: `sed -i '' ...`, `sed -i.bak ...`,
`sed -i'' ...`, `sed -n ...`, and a sed in a pipe. Only active when the `sed` on your PATH is Apple's /usr/bin/sed: if
you put GNU sed first on PATH the guard stands down. Exit 2 (block) with a message that names the fix.

It is a correctness helper, not a safety guard: FAILS OPEN on any error, in a live session and unattended alike.
Kill switch: bsd-sed-guard.off (or TALOS_BSD_SED_GUARD_OFF=1). Test: scripts/test-bsd-sed-guard.sh
"""
import json
import os
import re
import shutil
import sys

try:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import _talos_common as C  # noqa: E402
    if C.killed("bsd-sed-guard.off"):
        sys.exit(0)
except SystemExit:
    raise
except Exception:
    pass

HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1[^\n]*\n.*?\n\s*\2\s*(?:\n|$)", re.S)
BAD = re.compile(
    r"(?:^|[\s;&|(`])sed\s+(?:-[A-Za-z]+\s+)*-i"
    r"(?:\s+(?!''|\"\")(?=['\"]|[0-9]*[sy]/)|\s+-[eEnr]\b)"
)


def is_bsd_sed():
    if os.environ.get("TALOS_BSD_SED_FORCE") == "1":      # tests, or a machine where `which sed` lies
        return True
    return sys.platform == "darwin" and shutil.which("sed") == "/usr/bin/sed"


try:
    data = json.load(sys.stdin)
    if data.get("tool_name") != "Bash":
        sys.exit(0)
    cmd = (data.get("tool_input") or {}).get("command") or ""
    if "sed" not in cmd or not is_bsd_sed():
        sys.exit(0)
    if BAD.search(HEREDOC.sub("\n", cmd)):
        sys.stderr.write(
            "BLOCKED (bsd-sed-guard): this Mac has BSD sed, where `sed -i 's/..' file` treats the script as the backup "
            "suffix and runs the file path as the script. Use `sed -i '' 's/a/b/' file` (empty suffix) or "
            "`sed -i.bak ...`, or use the Edit tool or a short python3 script.\n")
        sys.exit(2)
except SystemExit:
    raise
except Exception:
    pass
sys.exit(0)
