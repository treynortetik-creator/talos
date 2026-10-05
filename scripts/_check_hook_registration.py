#!/usr/bin/env python3
"""Parse .claude/settings.json and prove the SessionStart hook is really registered.

Called by verify-install.sh. Prints one line: "OK <summary of what was found>" or
"ERR <what is wrong>".

Why this exists (TALOS-05, 2026-08-27): the check it replaces grepped the file for the
words startup/resume/clear/compact. Words are not a schema. An invalid settings file that
merely contained those strings passed, and so did a hook that did nothing at all.
"""
import json
import re
import sys

PATH = ".claude/settings.json"
REQUIRED = ("startup", "resume", "clear", "compact")


def fail(msg):
    print("ERR " + msg)
    sys.exit(0)


try:
    cfg = json.load(open(PATH))
except FileNotFoundError:
    fail("%s missing" % PATH)
except Exception as e:
    fail("%s is not valid JSON: %s" % (PATH, e))

if not isinstance(cfg, dict):
    fail("%s is not a JSON object" % PATH)

entries = (cfg.get("hooks") or {}).get("SessionStart") or []
if not isinstance(entries, list) or not entries:
    fail("no SessionStart hook is registered")

# Correlate matchers with the commands they actually fire (review, 2026-08-27): a
# matcher only counts if it fires OUR hook. The pooled version this replaces blended
# matchers across ALL SessionStart entries, so an entry matching startup|resume|clear|
# compact that ran some OTHER command, next to an entry matching only fork that ran
# session-start.py, looked fully covered -- and the converse mis-reported too.
all_cmds, our_matchers, our_cmds = [], [], []
for e in entries:
    if not isinstance(e, dict):
        continue
    entry_cmds = []
    for h in e.get("hooks") or []:
        if isinstance(h, dict) and h.get("type") == "command" and h.get("command"):
            entry_cmds.append(str(h["command"]))
    all_cmds.extend(entry_cmds)
    if any("session-start.py" in c for c in entry_cmds):
        our_matchers.append(str(e.get("matcher") or ""))
        our_cmds.extend(entry_cmds)

if not all_cmds:
    fail("SessionStart is registered but runs no command hook")

if not our_cmds:
    fail("SessionStart runs something other than hooks/session-start.py: %s" % all_cmds[0])

# Matchers are pipe-alternated regexes. Require each event as its own alternative,
# not merely as a substring of some longer word -- and only in OUR entries' matchers.
blob = " ".join(our_matchers)
missing = [m for m in REQUIRED if not re.search(r"(^|[|\s])%s([|\s]|$)" % m, blob)]
if missing:
    fail("the entries running session-start.py do not cover: %s" % " ".join(missing))

if not any("$CLAUDE_PROJECT_DIR" in c for c in our_cmds):
    fail("hook command uses a hard-coded path; it will break if the folder moves")

# "fork" was added to Claude Code's SessionStart sources (docs checked 2026-08-27):
# it fires when a session is forked, and a fork inherits a transcript whose digest may
# be hours stale, so registering it is strictly better. It is deliberately a NOTE, not
# a failure -- the four in REQUIRED are the load-bearing promise, and failing an
# install over a nice-to-have is exactly the cry-wolf failure this kit keeps warning
# about. Same boundary-safe test as REQUIRED, same pool: a real alternative, on an
# entry that fires our hook. No hard-coded counts here -- the old "OK 5 matchers" was
# asserted, not counted.
if re.search(r"(^|[|\s])fork([|\s]|$)", blob):
    print("OK required matchers + fork, runs session-start.py via $CLAUDE_PROJECT_DIR")
else:
    print("OK required matchers (no fork -- a forked session starts without the digest; add |fork to the matcher)")
