#!/usr/bin/env bash
# v1-agent-fixture.sh KIT DEST: builds an agent folder the way kit 1.x left one, for tests only.
#
# The copy layout (hooks/ and scripts/ as real folders, not links into a release), set up the way kit/scripts/self-test.sh
# section 5 sets up "a correct install", then aged the way its section 11 ages one: a stale hook, the pre-tool guard missing
# (file and settings.json registration, as before 1.0.0 shipped it), and no .talos-version (nothing before 1.0.0 stamped one).
# On top of that, files only its owner has: an edited CLAUDE.md, memory, wiki notes, .learnings, .env, their own permission
# rule and MCP server. Prints nothing; exits non-zero if any step fails.
set -euo pipefail
KIT="$1"; DEST="$2"
[ ! -e "$DEST" ] || { echo "v1-agent-fixture: $DEST already exists" >&2; exit 2; }
mkdir -p "$DEST"
( cd "$KIT" && tar --exclude=./.git -cf - . ) | ( cd "$DEST" && tar -xf - )
cd "$DEST"
rm -f .talos-version VERSION.stamp
# the rendered CLAUDE.md, from the template (self-test.sh section 5)
python3 - <<'PY'
import re, pathlib
t = pathlib.Path('templates/CLAUDE.md.tmpl').read_text()
for tok in set(re.findall(r'\{\{[A-Z_]+\}\}', t)):
    t = t.replace(tok, 'FILLED')
pathlib.Path('CLAUDE.md').write_text(t)
PY
mkdir -p memory .learnings .claude wiki/concepts
cp templates/dot-claude/settings.json .claude/settings.json
for f in STATE HANDOFF tasks decisions-ledger rules-ledger; do
  [ -f "templates/$f.md.tmpl" ] && sed -e 's/{{[A-Z_]*}}/FILLED/g' "templates/$f.md.tmpl" > "memory/$f.md"
done
printf -- '---\ntitle: me\ntype: person\ncreated: 2026-01-01\nupdated: 2026-01-01\nstatus: living\n---\n# me\nAlex. Links [[alpha]].\n' > wiki/me.md
printf -- '---\ntitle: alpha\ntype: concept\ncreated: 2026-01-01\nupdated: 2026-01-01\nstatus: living\n---\n# alpha\nLinks [[me]].\n' > wiki/concepts/alpha.md
printf -- '- [[me]]\n- [[alpha]]\n' >> wiki/_index.md

# make it OLD: a stale hook, and no pre-tool guard (neither the file nor its registration)
printf '# stale hook from kit 1.x\nprint("{}")\n' > hooks/session-start.py
rm -f hooks/pre-tool-guard.py
python3 - .claude/settings.json <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
for event, groups in list(d.get("hooks", {}).items()):
    kept = []
    for g in groups:
        g["hooks"] = [h for h in g.get("hooks", []) if "pre-tool-guard" not in h.get("command", "")]
        if g["hooks"]:
            kept.append(g)
    d["hooks"][event] = kept
d.setdefault("permissions", {}).setdefault("allow", []).append("Bash(my-own-tool:*)")
json.dump(d, open(p, "w"), indent=2)
PY

# make it THEIRS
printf '\n## My own rule, added by hand\nNever rename my projects.\n' >> CLAUDE.md
printf '# 2026-08-30\nA real working day.\n' > memory/2026-08-30.md
printf '\n## ACTIVE FIVE\n- the migration\n' >> memory/STATE.md
printf '\n## 2026-08-30 - a correction I took\n' >> .learnings/LEARNINGS.md
printf 'SOME_SERVICE_API_KEY=canary-must-survive\n' > .env
printf '{\n  "mcpServers": {\n    "my-own-server": { "command": "my-server", "args": [] }\n  }\n}\n' > .mcp.json
git init -q . && git add -A && git -c user.email=t@example.com -c user.name=t commit -qm "kit 1.x agent" >/dev/null
