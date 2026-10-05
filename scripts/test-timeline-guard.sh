#!/usr/bin/env bash
# test-timeline-guard.sh -- hooks/timeline-guard.py (PreToolUse): refuses a wiki write that puts a bad entry below the
# <!-- TIMELINE:APPEND-ONLY --> separator. A fake must be DENIED and a real one ALLOWED in the same run; a hook that
# crashes or writes to stderr is a failure, not an allow. Everything runs in a throwaway agent folder with a throwaway
# HOME and XDG state: no real wiki, ~/.claude or state folder is touched. test-hooks.sh runs this suite too.
set -uo pipefail
export PYTHONDONTWRITEBYTECODE=1
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)" || exit 2
case "$T" in /*/*) ;; *) echo "suspicious temp dir '$T'" >&2; exit 2 ;; esac
trap 'rm -rf "$T"' EXIT
export HOME="$T/home" XDG_STATE_HOME="$T/state" XDG_CONFIG_HOME="$T/cfg"; mkdir -p "$HOME"
unset CHRONOS_CONFIG TALOS_TIMELINE_GUARD_OFF
A="$T/agent"; mkdir -p "$A/hooks" "$A/scripts" "$A/memory" "$A/wiki/people" "$A/wiki/examples"
cp "$KIT"/hooks/*.py "$A/hooks/"; cp "$KIT/scripts/wiki-lint.py" "$A/scripts/"
W="$A/wiki/people"
SD="$(cd "$A" && python3 -c 'import sys; sys.path.insert(0, "hooks"); import _talos_common as C; print(C.state_dir())')"
pass=0; fail=0
SEP='<!-- TIMELINE:APPEND-ONLY -->'

# run PAYLOAD -> sets OUT, RC, ERR
run() { ERR="$T/stderr"; OUT=$(printf '%s' "$1" | ( cd "$A" && python3 hooks/timeline-guard.py ) 2>"$ERR"); RC=$?; }
decision() { printf '%s' "$OUT" | python3 -c 'import json,sys
try:
  o=json.load(sys.stdin).get("hookSpecificOutput",{}); print(o.get("permissionDecision","allow"))
except Exception: print("BAD")' ; }
reason() { printf '%s' "$OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hookSpecificOutput"]["permissionDecisionReason"])'; }
# check NAME WANT PAYLOAD [needle-in-reason ...]
check() { local name="$1" want="$2" payload="$3"; shift 3; run "$payload"
  if [ "$RC" -ne 0 ] || [ -s "$ERR" ]; then fail=$((fail+1)); printf "  FAIL %-66s hook crashed rc=%s %s\n" "$name" "$RC" "$(head -c 80 "$ERR")"; return; fi
  local got; got=$(decision)
  if [ "$got" = "allow" ] && [ "$(printf '%s' "$OUT" | tr -d '[:space:]')" != "{}" ]; then
    fail=$((fail+1)); printf "  FAIL %-66s allow was not exactly {}\n" "$name"; return; fi
  if [ "$got" != "$want" ]; then fail=$((fail+1)); printf "  FAIL %-66s got %s want %s\n" "$name" "$got" "$want"; return; fi
  local n; for n in "$@"; do
    if ! reason | grep -qF -- "$n"; then fail=$((fail+1)); printf "  FAIL %-66s reason lacks: %s\n" "$name" "$n"; return; fi
  done
  pass=$((pass+1)); printf "  ok   %-66s %s\n" "$name" "$got"; }

# payload builders (JSON via python so quoting never bites)
EDIT()  { python3 -c 'import json,sys; print(json.dumps({"tool_name":"Edit","tool_input":{"file_path":sys.argv[1],"old_string":sys.argv[2],"new_string":sys.argv[3]}}))' "$@"; }
WRITE() { python3 -c 'import json,sys; print(json.dumps({"tool_name":"Write","tool_input":{"file_path":sys.argv[1],"content":sys.argv[2]}}))' "$@"; }
MULTI() { python3 -c 'import json,sys; a=sys.argv; print(json.dumps({"tool_name":"MultiEdit","tool_input":{"file_path":a[1],"edits":[{"old_string":a[2],"new_string":a[3]},{"old_string":a[4],"new_string":a[5]}]}}))' "$@"; }

E1='- **2026-09-01** | [[2026-09-01-sync]] | @dana-ruiz — Approved the vendor ticket. Confidence: high'
E2='- **2026-09-02** | Slack DM | @me — Asked for the checklist. Confidence: medium'
GOODNEW='- **2026-09-03** | [[../meetings/2026-09-03-standup]] | @sam-lee — Named Jo Ames the owner. Confidence: high (stated aloud)'

mknote() { # path, body-below-separator
  printf -- '---\ntitle: X\ntype: person\n---\n# X\n\nTitle line.\n\n## Related\n- [[a]]\n- [[b]]\n\n%s\n%s\n' "$SEP" "$2" > "$1"; }
NOTE="$W/clean.md"; mknote "$NOTE" "$E1
$E2"

echo "denied: one test per root-cause shape"
check "wrapped multi-line entry (Write)" deny "$(WRITE "$W/new1.md" "---
title: N
---
# N
[[a]] [[b]]
$SEP
- **2026-09-23** | this transcript | @me — Coached Pat
while she deleted the legacy classes. Confidence: high")" "line" "ONE physical line" "FORMAT" "GOOD" "BAD"
check "wrapped entry appended by Edit (continuation line only)" deny "$(EDIT "$NOTE" "$E2" "$E2
  and a wrapped continuation line")" "hard-wrapped" "ONE physical line"
check "## Related bullets appended BELOW the separator (Edit)" deny "$(EDIT "$NOTE" "$E2" "$E2

## Related
- [[david-rouse]] — her manager")" "david-rouse" "ABOVE the separator" "Related"
check "open-questions bullet below the separator (Edit)" deny "$(EDIT "$NOTE" "$E2" "$E2
- Whether the session is one-off or recurring.")" "undated bullet" "ABOVE the separator"
check "preamble prose below the separator (Write)" deny "$(WRITE "$W/new2.md" "---
title: Q
---
# Q
[[a]] [[b]]
$SEP
*Converted 2026-09-29. Earlier evidence lives in the prose above.*
$E1")" "free prose" "ABOVE the separator"
check "author '@x via y'" deny "$(EDIT "$NOTE" "$E2" "$E2
- **2026-09-04** | STATE.md intel line | @me via Lindsay — Pat joined Acme Health. Confidence: medium")" "author field" "via"
check "author with a trailing parenthetical" deny "$(EDIT "$NOTE" "$E2" "$E2
- **2026-09-04** | [[2026-09-04-x]] | @me (speaker inferred) — Sam asked a question. Confidence: medium")" "author field"
check "Confidence followed by trailing prose" deny "$(EDIT "$NOTE" "$E2" "$E2
- **2026-09-04** | [[2026-09-04-x]] | @sam-lee — Said he is negotiating. Confidence: high on the statement; the split is open")" "END with" "Confidence"
check "no Confidence tag at all" deny "$(EDIT "$NOTE" "$E2" "$E2
- **2026-09-04** | [[2026-09-04-x]] | @sam-lee — Said he is negotiating.")" "Confidence"
check "invalid Confidence value (E5)" deny "$(EDIT "$NOTE" "$E2" "$E2
- **2026-09-04** | [[2026-09-04-x]] | @sam-lee — Said he is negotiating. Confidence: certain")" "E5"
check "out-of-order date appended at the bottom (E3)" deny "$(EDIT "$NOTE" "$E2" "$E2
- **2026-08-01** | [[2026-08-01-x]] | @sam-lee — An older observation. Confidence: low")" "E3" "oldest first" "newest"
check "out-of-order date inserted in the MIDDLE (the new line is blamed)" deny "$(EDIT "$NOTE" "$E1" "$E1
- **2026-09-09** | [[2026-09-09-x]] | @sam-lee — Too new for its slot. Confidence: low")" "E3"
check "dated entry placed ABOVE the separator (E4)" deny "$(EDIT "$NOTE" "- [[b]]" "- [[b]]
- **2026-09-05** | [[2026-09-05-x]] | @sam-lee — Wrong side of the line. Confidence: low")" "E4" "ABOVE the separator"
check "a related line MOVED from above to below the separator" deny "$(EDIT "$NOTE" "$E2" "$E2
- [[b]]")" "undated bullet"
check "second separator (E1)" deny "$(EDIT "$NOTE" "$E2" "$E2
$SEP")" "E1" "second"
check "MultiEdit: one good edit, one bad edit -> denied" deny "$(MULTI "$NOTE" "Title line." "Title line, revised." "$E2" "$E2
- **2026-09-04** | [[x]] | @me via y — Bad author. Confidence: low")" "author field"

echo "allowed: valid entries and non-violations"
check "valid entry appended (Edit)" allow "$(EDIT "$NOTE" "$E2" "$E2
$GOODNEW")"
check "valid entry with a [[../meetings/...]] path source (the lint accepts it)" allow "$(EDIT "$NOTE" "$E2" "$E2
- **2026-09-03** | [[../meetings/2026-09-03-standup]] | @dana-ruiz — Moved the review. Confidence: medium")"
check "valid entry with one short parenthetical after Confidence" allow "$(EDIT "$NOTE" "$E2" "$E2
$GOODNEW")"
check "valid entry, piped wikilink source [[slug|Label]]" allow "$(EDIT "$NOTE" "$E2" "$E2
- **2026-09-03** | [[2026-09-03-standup|Standup]] | @me — Spoke to the point. Confidence: low")"
check "same-day entries keep ascending order" allow "$(EDIT "$NOTE" "$E2" "$E2
- **2026-09-02** | Slack DM | @me — Second observation, same day. Confidence: low")"
check "new note via Write with a clean timeline" allow "$(WRITE "$W/new3.md" "---
title: N
---
# N
[[a]] [[b]]
$SEP
$E1
$E2")"
check "MultiEdit with only valid edits" allow "$(MULTI "$NOTE" "Title line." "Title line, revised." "$E2" "$E2
$GOODNEW")"
check "edit above the separator (synthesis rewrite)" allow "$(EDIT "$NOTE" "Title line." "Title line, now a long and rewritten synthesis.")"
check "Related bullets ABOVE the separator" allow "$(EDIT "$NOTE" "- [[b]]" "- [[b]]
- [[c]] — new link")"
check "archive pointer line and a heading below the separator are scaffolding" allow "$(EDIT "$NOTE" "$SEP" "$SEP
_(Older entries archived to [[x-timeline-archive]] on 2026-10-05.)_")"

echo "allowed: pre-existing violations never block an unrelated edit"
BAD="$W/legacy.md"
printf -- '---\ntitle: L\n---\n# L\n\nSynthesis.\n\n%s\n%s\n- Whether it is recurring.\n- **2026-09-02** | x | @a via b — old bad entry. Confidence: high\n- **2026-08-01** | [[y]] | @a — out of order, old. Confidence: low\nwrapped continuation from long ago\n' "$SEP" "$E1" > "$BAD"
check "legacy file: Edit of the synthesis above the separator" allow "$(EDIT "$BAD" "Synthesis." "Synthesis, rewritten.")"
check "legacy file: a valid entry appended below the old violations" allow "$(EDIT "$BAD" "wrapped continuation from long ago" "wrapped continuation from long ago
- **2026-09-10** | [[2026-09-10-x]] | @me — Clean new entry. Confidence: high")"
check "legacy file: a NEW bad entry is still denied" deny "$(EDIT "$BAD" "wrapped continuation from long ago" "wrapped continuation from long ago
- **2026-09-10** | [[2026-09-10-x]] | @me via z — New bad entry. Confidence: high")" "author field"
python3 - "$BAD" <<'PY' > "$T/legacy-whole.txt"
import sys; sys.stdout.write(open(sys.argv[1]).read().replace("Synthesis.", "Synthesis, whole-file rewrite."))
PY
check "legacy file: whole-file Write that only changes the synthesis" allow "$(WRITE "$BAD" "$(cat "$T/legacy-whole.txt")")"

echo "allowed: out of scope, opted out, kill switch"
check "note with no separator is never checked (not opted in)" allow "$(WRITE "$W/plain.md" "# P
- Whether it is recurring.
- **2026-09-02** | x | @a via b — whatever. Confidence: purple")"
check "path outside wiki/ (memory/)" allow "$(WRITE "$A/memory/p.md" "$SEP
- junk bullet")"
check "a wiki/ path in some OTHER folder is not this agent's wiki" allow "$(WRITE "$T/elsewhere/wiki/people/x.md" "$SEP
- junk bullet")"
check "_changelog.md is meta, skipped" allow "$(WRITE "$A/wiki/_changelog.md" "$SEP
- junk bullet")"
check "README.md is meta, skipped" allow "$(WRITE "$A/wiki/README.md" "$SEP
- junk bullet")"
check "wiki/examples/ is skipped (shipped examples)" allow "$(WRITE "$A/wiki/examples/dana.md" "$SEP
- junk bullet")"
check "a relative path inside the agent folder is judged too" deny "$(WRITE "wiki/people/rel.md" "# N
[[a]] [[b]]
$SEP
- junk bullet")" "undated bullet"
check "non-markdown file in the wiki" allow "$(WRITE "$W/data.json" "$SEP
- junk bullet")"
mkdir -p "$SD"; touch "$SD/timeline-guard.off"
check "kill switch file timeline-guard.off in the state folder lets a bad entry through" allow "$(WRITE "$W/new4.md" "# N
[[a]] [[b]]
$SEP
- junk bullet")"
rm -f "$SD/timeline-guard.off"
OUT=$(printf '%s' "$(WRITE "$W/new4.md" "# N
[[a]] [[b]]
$SEP
- junk bullet")" | ( cd "$A" && TALOS_TIMELINE_GUARD_OFF=1 python3 hooks/timeline-guard.py ) 2>"$T/stderr")
if [ "$(printf '%s' "$OUT" | tr -d '[:space:]')" = "{}" ] && [ ! -s "$T/stderr" ]; then pass=$((pass+1)); printf "  ok   %-66s allow\n" "TALOS_TIMELINE_GUARD_OFF=1 lets a bad entry through"
else fail=$((fail+1)); printf "  FAIL %-66s %s\n" "TALOS_TIMELINE_GUARD_OFF=1 ignored" "$OUT"; fi
check "kill switches removed: the same write is denied again" deny "$(WRITE "$W/new4.md" "# N
[[a]] [[b]]
$SEP
- junk bullet")"

echo "allowed: malformed payloads and tool-side failures fail OPEN"
check "empty stdin" allow ""
check "garbage, not JSON" allow "not json {{{"
check "JSON null" allow "null"
check "JSON list" allow "[1,2,3]"
check "empty object" allow "{}"
check "tool_input is a string" allow '{"tool_name":"Write","tool_input":"nope"}'
check "tool_input missing" allow '{"tool_name":"Write"}'
check "file_path is a number" allow '{"tool_name":"Write","tool_input":{"file_path":42,"content":"x"}}'
check "Write with non-string content" allow "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$NOTE\",\"content\":[1]}}"
check "Edit whose old_string is not in the file (the Edit itself will fail)" allow "$(EDIT "$NOTE" "no such text" "- junk")"
check "Edit of a file that does not exist" allow "$(EDIT "$W/ghost.md" "a" "$SEP
- junk")"
check "Edit with a non-unique old_string and no replace_all" allow "$(EDIT "$NOTE" "- [[" "- junk [[")"
check "unrelated tool name" allow "{\"tool_name\":\"Bash\",\"tool_input\":{\"file_path\":\"$NOTE\",\"content\":\"x\"}}"
# a missing or broken lint must still allow: an agent folder with the hooks but no scripts/wiki-lint.py
mkdir -p "$T/fake/hooks"; cp "$KIT"/hooks/*.py "$T/fake/hooks/"
OUT=$(printf '%s' "$(WRITE "$T/fake/wiki/people/x.md" "# N
$SEP
- junk bullet")" | ( cd "$T/fake" && python3 hooks/timeline-guard.py ) 2>"$T/stderr"); rc=$?
if [ $rc -eq 0 ] && [ ! -s "$T/stderr" ] && [ "$(printf '%s' "$OUT" | tr -d '[:space:]')" = "{}" ]; then
  pass=$((pass+1)); printf "  ok   %-66s allow\n" "lint missing / import failure"
else fail=$((fail+1)); printf "  FAIL %-66s rc=%s out=%s\n" "lint missing / import failure" "$rc" "$OUT"; fi
printf 'raise SystemExit("broken lint")\n' > "$T/fake/scripts_broken.py"; mkdir -p "$T/fake/scripts"; printf 'raise RuntimeError("broken")\n' > "$T/fake/scripts/wiki-lint.py"
OUT=$(printf '%s' "$(WRITE "$T/fake/wiki/people/x.md" "# N
$SEP
- junk bullet")" | ( cd "$T/fake" && python3 hooks/timeline-guard.py ) 2>"$T/stderr"); rc=$?
if [ $rc -eq 0 ] && [ ! -s "$T/stderr" ] && [ "$(printf '%s' "$OUT" | tr -d '[:space:]')" = "{}" ]; then
  pass=$((pass+1)); printf "  ok   %-66s allow\n" "lint raises on import"
else fail=$((fail+1)); printf "  FAIL %-66s rc=%s out=%s\n" "lint raises on import" "$rc" "$OUT"; fi

echo "one source of rules: the guard and the lint agree"
if python3 - "$KIT" <<'PY'
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("wl", sys.argv[1] + "/scripts/wiki-lint.py")
wl = importlib.util.module_from_spec(spec); spec.loader.exec_module(wl)
sep = "<!-- TIMELINE:APPEND-ONLY -->"
bad = "# N\n[[a]] [[b]]\n%s\n- **2026-09-01** | x | @a via b — e. Confidence: high\n- stray\n  wrapped\n- **2026-08-01** | x | @a — e. Confidence: low\n" % sep
lint_codes = sorted(m[:2] for _s, m in wl.check_timeline("n", "/nonexistent/n.md", bad)[0])
guard_codes = sorted(c for c, *_ in wl.new_timeline_violations("", bad))
assert lint_codes == guard_codes, (lint_codes, guard_codes)
PY
then pass=$((pass+1)); echo "  ok   guard findings on a fully-new file equal the lint's errors (same rules)"
else fail=$((fail+1)); echo "  FAIL guard and lint disagree"; fi

echo; echo "  PASS $pass   FAIL $fail"; [ "$fail" -eq 0 ]
