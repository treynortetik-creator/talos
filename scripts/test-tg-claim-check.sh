#!/usr/bin/env bash
# test-tg-claim-check.sh -- hooks/tg-claim-check.py (PreToolUse on the Telegram reply tool).
# Doctrine: a fake claim must FAIL and a real one must PASS, in the same suite. Every case also asserts the plumbing
# invariants: never crash, and "pre" only ever denies (never allow/ask: it must not widen permissions).
# Throwaway HOME/XDG; nothing touches your real state.
export PYTHONDONTWRITEBYTECODE=1
set -uo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SB="$(mktemp -d)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
trap 'rm -rf "$SB"' EXIT
export HOME="$SB/home" XDG_STATE_HOME="$SB/state" XDG_CONFIG_HOME="$SB/cfg"; mkdir -p "$HOME"
unset CHRONOS_RUN TALOS_UNATTENDED CHRONOS_CONFIG
export TALOS_TG_CLAIM_FORCE=1
A="$SB/agent"; mkdir -p "$A/hooks"; cp "$KIT"/hooks/*.py "$A/hooks/"
H="$A/hooks/tg-claim-check.py"
SD="$(cd "$A" && python3 -c 'import sys; sys.path.insert(0,"hooks"); import _talos_common as C; print(C.state_dir())')"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); printf "  FAIL %-62s %s\n" "$1" "$2"; }
# transcript fixture: an old turn, a human prompt, then one tool call + its result (the turn's evidence)
TR() { python3 - "$SB/tr.jsonl" "$1" "$2" <<'PY'
import json,sys
p, prompt, result = sys.argv[1], sys.argv[2], sys.argv[3]
recs = [{"type":"user","message":{"role":"user","content":"old turn"}},
        {"type":"user","message":{"role":"user","content":"[old] ticket ACME-42 resolved, the export job restored"}},
        {"type":"user","message":{"role":"user","content":prompt}},
        {"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"tracker view ACME-42"}}]}},
        {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":result}]}},
        {"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"mcp__plugin_telegram_telegram__reply","input":{"chat_id":"1","text":"x"}}]}}]
open(p,"w").write("\n".join(json.dumps(r) for r in recs)+"\n")
PY
}
J() { python3 -c 'import json,sys;print(json.dumps({"session_id":sys.argv[4],"tool_name":sys.argv[1],"tool_use_id":"t2","transcript_path":sys.argv[3],"tool_input":json.loads(sys.argv[2])}))' "$1" "$2" "$SB/tr.jsonl" "${3:-s1}"; }
TG() { J mcp__plugin_telegram_telegram__reply "$(python3 -c 'import json,sys;print(json.dumps({"chat_id":"1","text":sys.argv[1]}))' "$1")" "${2:-s1}"; }
run() { ( cd "$A" && python3 "$H" "$1" 2>&1 ); }
# t <stdin> <want: block|allow> <name>
t() { rm -rf "$SD"; rc=0; out=$(printf '%s' "$1" | run pre) || rc=$?
  if [ "$rc" -ne 0 ]; then bad "$3" "crashed rc=$rc $(head -c 80 <<<"$out")"; return; fi
  if printf '%s' "$out" | grep -q '"permissionDecision": "\(allow\|ask\)"'; then bad "$3" "widened permissions"; return; fi
  got=allow; printf '%s' "$out" | grep -q '"permissionDecision": "deny"' && got=block
  if [ "$got" = "$2" ]; then ok; else bad "$3" "$got (want $2) $(head -c 100 <<<"$out")"; fi; }

echo "tg-claim-check: detector on Telegram replies (block once)"
TR "how is the export job" "ACME-42 Export job   Status: In progress. Latest comment: still broken for large files."
t "$(TG 'There is no video endpoint on the provider.')"                                   block "bare negative, no evidence"
t "$(TG 'There is no video endpoint on the provider (checked: `GET /api/v1/models`, 05:21).')" allow "same claim, backtick command"
t "$(TG 'Morning. Want me to start the draft now?')"                                      allow "offer / question"
t "$(TG 'Ha, fair. That one is on me.')"                                                  allow "joke / banter"
t "$(TG 'I will check the ticket and report back.')"                                      allow "plan"
t "$(TG 'ACME-42 is still in progress; latest comment says it is still broken for large files.')" allow "faithful summary of this turn's tool result"
t "$(TG '{"garbage')"                                                                     allow "malformed tool_input -> allow"
t '{"garbage'                                                                             allow "malformed stdin -> allow"
t '{"tool_name":"Read","tool_input":{"file_path":"/x/a.md"}}'                             allow "non-outbound tool ignored"
t '{"tool_name":"Write","tool_input":{"file_path":"/x/a.md","content":"There is no such thing at all."}}' allow "a local file write is not checked (Telegram only)"
# status ledger: "restored" about a thing the turn read as "In progress". The old turn's "restored" must not count.
t "$(TG 'The export job restored for large files (ACME-42).')"                             block "status ledger: restored vs In progress"
TR "is the export fixed" "ACME-42 Export job   Status: Resolved. Comment: fixed and verified for large files."
t "$(TG 'The export job restored for large files (ACME-42).')"                             allow "status ledger: restored backed by Resolved/fixed"
t "$(TG 'Nothing was deployed or shipped yet, so nothing to roll back.')"                 allow "negated status word is not a claim"
t "$(TG "Those are gone, and there's a new check so it can't sneak back in.")"            allow "purpose clause is not a claim"
t "$(TG "Don't lead with the scanner; there is no reason to.")"                           allow "instruction is not a claim"
t "$(TG "ACME-7 isn't a real ticket.")"                                                   block "classification negative with nothing in the turn"
t "$(TG 'Scheduled tasks run in the cloud.')"                                             block "capability claim, nothing in the turn"
t "$(TG 'I checked the ticket ACME-42 just now.')"                                        allow "first-person check in a turn that ran tools"
t "$(TG 'The invoice from 8/3 is still unread.')"                                         block "a date like 8/3 is not a path (evidence)"
t "$(TG 'Still unread, per scripts/report.py output.')"                                   allow "a real path still counts as evidence"
t "$(TG 'Fri/Sat/Sun/Mon produced no notes at all.')"                                     block "Fri/Sat/Sun/Mon is not a path"
t "$(TG 'You told me it can point at a local model, and you have not tried it.')"        allow "attribution keeps the sentence covered"
t "$(TG 'There is no such endpoint; per the docs it was removed in v2.')"                  allow "a source after a semicolon still covers the claim"
TR "how is the export job" "ACME-42 Export job   Status: In progress. Latest comment: still broken for large files."

echo "tg-claim-check: block-once plumbing"
rm -rf "$SD"
s1=$(TG 'There is no such tool anywhere.' s9)
o1=$(printf '%s' "$s1" | run pre); o2=$(printf '%s' "$s1" | run pre)
if grep -q deny <<<"$o1" && ! grep -q deny <<<"$o2"; then ok; else bad "identical resend passes after one block" "$(head -c 60 <<<"$o1") / $(head -c 60 <<<"$o2")"; fi
grep -q 'There is no such tool' <<<"$o1" && ok || bad "deny reason quotes the sentence" ""
grep -q 'send the same text' <<<"$o1" && ok || bad "deny reason names the escape hatch" ""
o3=$(printf '%s' "$(TG 'There is no such tool anywhere.' s10)" | run pre)
grep -q deny <<<"$o3" && ok || bad "another session is blocked on its own first send" ""
[ -s "$SD/tg-claim-check.jsonl" ] && ok || bad "runs are logged" ""
grep -q 'There is no such tool anywhere' "$SD/tg-claim-check.jsonl" && ! grep -q '"text"' "$SD/tg-claim-check.jsonl" && ok || bad "the log holds a flagged-sentence sample but never the whole payload" ""
mkdir -p "$SD"; touch "$SD/tg-claim-check.shadow"
o6=$(printf '%s' "$(TG 'There is no such tool at all, none.' s13)" | run pre)
if [ -z "$o6" ] && grep -q '"shadow-block"' "$SD/tg-claim-check.jsonl"; then ok; else bad "shadow mode logs the would-block and emits nothing" "$(head -c 80 <<<"$o6")"; fi
rm -f "$SD/tg-claim-check.shadow"
touch "$SD/tg-claim-check.off"
o4=$(printf '%s' "$(TG 'There is no such tool at all.' s11)" | run pre)
[ -z "$o4" ] && ok || bad "the kill-switch file silences it" ""
rm -f "$SD/tg-claim-check.off"
o4=$(printf '%s' "$(TG 'There is no such tool at all.' s11b)" | ( cd "$A" && TALOS_TG_CLAIM_CHECK_OFF=1 python3 "$H" pre 2>&1 ))
[ -z "$o4" ] && ok || bad "TALOS_TG_CLAIM_CHECK_OFF=1 silences it" ""
grep -q 'KILL_NAME = "tg-claim-check.off"' "$H" && ok || bad "kill-switch name is a string literal" ""
# only active when the Telegram channel is set up
o7=$(printf '%s' "$(TG 'There is no such tool at all.' s14)" | ( cd "$A" && TALOS_TG_CLAIM_FORCE=0 python3 "$H" pre 2>&1 ))
[ -z "$o7" ] && ok || bad "with no Telegram channel set up it does nothing" "$o7"
mkdir -p "$HOME/.claude/channels/telegram"; echo '{}' > "$HOME/.claude/channels/telegram/access.json"
o8=$(printf '%s' "$(TG 'There is no such tool at all.' s15)" | ( cd "$A" && TALOS_TG_CLAIM_FORCE=0 python3 "$H" pre 2>&1 ))
grep -q deny <<<"$o8" && ok || bad "with the channel's access.json present it is active" "$o8"
rm -rf "$HOME/.claude"
# a transcript that cannot be read = no evidence, still no crash
o9=$(printf '%s' "$(TG 'There is no such tool at all.' s16 | sed 's#"transcript_path": "[^"]*"#"transcript_path": "/nonexistent"#')" | run pre)
grep -q deny <<<"$o9" && ok || bad "a missing transcript means no evidence (blocks), never a crash" "$o9"
printf '\xff\xfe not json {' | ( cd "$A" && CHRONOS_RUN=1 python3 "$H" pre ) >/dev/null 2>&1 && ok || bad "garbage input exits 0 even unattended" ""
echo "  tg-claim-check: PASS $pass FAIL $fail"
[ "$fail" -eq 0 ]
