#!/usr/bin/env bash
# test-settings-merge.sh -- scripts/settings-merge.py: adds missing hook registrations, touches nothing else.
export PYTHONDONTWRITEBYTECODE=1
set -uo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SB="$(mktemp -d)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
trap 'rm -rf "$SB"' EXIT
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }
A="$SB/agent"; mkdir -p "$A/.claude" "$A/templates/dot-claude" "$A/hooks" "$A/scripts"
cp "$KIT/templates/dot-claude/settings.json" "$A/templates/dot-claude/settings.json"
cp "$KIT/scripts/settings-merge.py" "$A/scripts/"; cp "$KIT"/hooks/*.py "$A/hooks/"
# a "1.1.2-style" file: only some hooks, plus the user's own permissions, a custom hook and a Chronos absolute hook
python3 - "$A" <<'PY'
import json, sys
A = sys.argv[1]
t = json.load(open(A + "/templates/dot-claude/settings.json"))
old = {"autoMemoryEnabled": False, "permissions": {"allow": ["Bash(git status:*)"], "deny": ["Read(./.env)"]},
       "enabledPlugins": {"telegram@claude-plugins-official": True},
       "hooks": {"SessionStart": [t["hooks"]["SessionStart"][0],
                                  {"matcher": "startup", "hooks": [{"type": "command", "command": "python3 /abs/chronos/hooks/chronos-session-start.py"}]}],
                 "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "echo mine"}]}] + [e for e in t["hooks"]["UserPromptSubmit"] if "claim-gate" in e["hooks"][0]["command"]]}}
json.dump(old, open(A + "/.claude/settings.json", "w"), indent=2)
PY
cp "$A/.claude/settings.json" "$SB/before.json"
out="$(cd "$A" && python3 scripts/settings-merge.py 2>&1)"
{ printf '%s' "$out" | grep -q 'would add memory-reflex.py on UserPromptSubmit' && printf '%s' "$out" | grep -q 'would add action-rules.py on PreToolUse' && printf '%s' "$out" | grep -q 'Dry run'; } && ok || no "dry run does not list the missing hooks" "$out"
cmp -s "$A/.claude/settings.json" "$SB/before.json" && ok || no "dry run changed the file"
out="$(cd "$A" && python3 scripts/settings-merge.py --apply 2>&1)"; rc=$?
[ "$rc" = 0 ] && ls "$A/.claude"/settings.json.bak-* >/dev/null 2>&1 && ok || no "apply failed or took no backup" "$out"
python3 - "$A" "$SB/before.json" <<'PY' && ok || no "the merge changed something it must not touch, or lost a hook"
import json, sys
A = sys.argv[1]
new, old = json.load(open(A + "/.claude/settings.json")), json.load(open(sys.argv[2]))
t = json.load(open(A + "/templates/dot-claude/settings.json"))
assert new["permissions"] == old["permissions"] and new["enabledPlugins"] == old["enabledPlugins"] and new["autoMemoryEnabled"] is False
assert new["hooks"]["SessionStart"][:2] == old["hooks"]["SessionStart"], "existing entries reordered or edited"
assert any("echo mine" in h["command"] for e in new["hooks"]["UserPromptSubmit"] for h in e["hooks"]), "the user's own hook was lost"
assert any("chronos-session-start" in h["command"] for e in new["hooks"]["SessionStart"] for h in e["hooks"]), "the Chronos hook was lost"
import re
def scripts(d):
    return {(ev, re.search(r"hooks/([\w.-]+\.py)", h["command"]).group(1)) for ev, es in d["hooks"].items() for e in es for h in e["hooks"] if "hooks/" in h["command"] and "$CLAUDE_PROJECT_DIR" in h["command"]}
assert scripts(t) <= scripts(new), scripts(t) - scripts(new)
assert "PreCompact" in new["hooks"]
PY
out="$(cd "$A" && python3 scripts/settings-merge.py 2>&1)"
printf '%s' "$out" | grep -q 'already registered' && ok || no "a second run is not a no-op" "$out"
n1=$(ls "$A/.claude"/settings.json.bak-* | wc -l | tr -d ' '); ( cd "$A" && python3 scripts/settings-merge.py --apply >/dev/null 2>&1 ); n2=$(ls "$A/.claude"/settings.json.bak-* | wc -l | tr -d ' ')
[ "$n1" = "$n2" ] && ok || no "a no-op apply still took a backup"
printf '{ not json' > "$A/.claude/settings.json"; out="$(cd "$A" && python3 scripts/settings-merge.py --apply 2>&1)"; rc=$?
{ [ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'not valid JSON' && [ "$(cat "$A/.claude/settings.json")" = '{ not json' ]; } && ok || no "invalid JSON was not left alone" "$out"
rm -f "$A/.claude/settings.json"; out="$(cd "$A" && python3 scripts/settings-merge.py 2>&1)"; rc=$?
[ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'does not exist' && ok || no "missing settings.json not reported" "$out"
echo "  settings-merge: PASS $PASS FAIL $FAIL"
[ "$FAIL" -eq 0 ]
