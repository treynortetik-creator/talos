#!/usr/bin/env bash
# test-action-rules.sh -- hooks/action-rules.py against the starter rules, a user rules file, approvals, and failure modes.
# Throwaway HOME/XDG; never touches your real config or state. Every case feeds the hook the JSON the harness would send.
export PYTHONDONTWRITEBYTECODE=1
set -uo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SB="$(mktemp -d)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
trap 'rm -rf "$SB"' EXIT
export HOME="$SB/home"; mkdir -p "$HOME"
export XDG_STATE_HOME="$SB/state" XDG_CONFIG_HOME="$SB/cfg"
unset CHRONOS_RUN TALOS_UNATTENDED CHRONOS_CONFIG
# Second pass: hide PyYAML so the built-in reader is what parses the rules (a stock Mac python3 has no PyYAML).
if [ "${TALOS_TEST_NOYAML:-0}" = 1 ]; then mkdir -p "$SB/noyaml"; printf 'raise ImportError("hidden for the test")\n' > "$SB/noyaml/yaml.py"; export PYTHONPATH="$SB/noyaml"; fi
A="$SB/agent"; mkdir -p "$A/hooks"; cp "$KIT"/hooks/*.py "$KIT"/hooks/action-rules.yaml "$A/hooks/"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

# run <tool> <cwd> <command-or-path>  -> verdict word: allow | deny | ask
run() {
  local out
  out="$(python3 -c 'import json,sys
t=sys.argv[1]; v=sys.argv[3]
ti={"command":v} if t=="Bash" else {"file_path":v,"content":"x"}
print(json.dumps({"tool_name":t,"cwd":sys.argv[2],"tool_input":ti}))' "$1" "$2" "$3" | ( cd "$A" && python3 hooks/action-rules.py check 2>"$SB/err" ))"
  case "$out" in *'"deny"'*) echo deny ;; *'"ask"'*) echo ask ;; *) echo allow ;; esac
}
expect(){ local want="$1" label="$2" got="$3"; [ "$got" = "$want" ] && ok || no "$label (want $want, got $got)"; }
K1=pk; K1="${K1}ill"; K2=kill; K2="${K2}all"

echo "action-rules: starter rules"
expect deny  "rm -rf ~"                       "$(run Bash /tmp 'rm -rf ~')"
expect deny  "rm -rf \$HOME"                  "$(run Bash /tmp 'rm -rf $HOME')"
expect deny  "rm -rf /"                       "$(run Bash /tmp 'cd /x && rm -rf /')"
expect deny  "rm -r -f ~/"                    "$(run Bash /tmp 'rm -r -f ~/')"
expect allow "rm -rf of a project folder"     "$(run Bash /tmp 'rm -rf ~/projects/old-build')"
expect allow "rm of one file"                 "$(run Bash /tmp 'rm notes.txt')"
expect deny  "force push main"                "$(run Bash /tmp 'git push --force origin main')"
expect deny  "force push main (-f after)"     "$(run Bash /tmp 'git push origin main -f')"
expect deny  "force push +main"               "$(run Bash /tmp 'git push origin +main')"
expect deny  "force push main via -C"         "$(run Bash /tmp 'git -C ~/repo push -f origin master')"
expect ask   "plain push to main"             "$(run Bash /tmp 'git push origin main')"
expect ask   "push HEAD:main"                 "$(run Bash /tmp 'git push origin HEAD:main')"
expect allow "push a feature branch"          "$(run Bash /tmp 'git push -u origin feat/main-nav')"
expect allow "force push a feature branch"    "$(run Bash /tmp 'git push --force-with-lease origin feat/x')"
expect allow "push then log main"             "$(run Bash /tmp 'git push origin feat/x && git log main')"
expect deny  "pattern kill"                   "$(run Bash /tmp "$K1 -f node")"
expect deny  "killall"                        "$(run Bash /tmp "$K2 node")"
expect allow "kill by pid"                    "$(run Bash /tmp 'kill 12345')"
expect allow "quoted pkill in grep"           "$(run Bash /tmp "grep -n '$K1' notes.md")"
expect allow "quoted pkill in echo"           "$(run Bash /tmp "echo 'never run $K1 here' >> log.md")"
expect deny  "claude mcp list"                "$(run Bash /tmp 'claude mcp list')"
expect allow "claude mcp add"                 "$(run Bash /tmp 'claude mcp add x')"
expect ask   "vercel deploy"                  "$(run Bash /tmp 'vercel deploy --prod')"
expect ask   "npm publish"                    "$(run Bash /tmp 'npm publish')"
expect ask   "terraform apply (chained)"      "$(run Bash /tmp 'cd infra && terraform apply -auto-approve')"
expect allow "terraform plan"                 "$(run Bash /tmp 'terraform plan')"
expect allow "npm install"                    "$(run Bash /tmp 'npm install left-pad')"
expect ask   "gh release create"              "$(run Bash /tmp 'gh release create v1.0 --notes x')"
expect ask   "gh repo edit public"            "$(run Bash /tmp 'gh repo edit me/x --visibility public --accept-visibility-change-consequences')"
expect ask   "gh repo create public"          "$(run Bash /tmp 'gh repo create x --public')"
expect allow "gh repo create private"         "$(run Bash /tmp 'gh repo create x --private')"
expect ask   "gh auth switch"                 "$(run Bash /tmp 'gh auth switch -u someone')"
expect allow "gh auth status"                 "$(run Bash /tmp 'gh auth status')"
expect ask   "connector send"                 "$(run mcp__claude_ai_Slack__slack_send_message /tmp '')"
expect ask   "connector mail forward"         "$(run mcp__claude_ai_Gmail__forward /tmp '')"
expect ask   "connector delete"               "$(run mcp__claude_ai_Google_Drive__trash_file /tmp '')"
expect allow "connector read"                 "$(run mcp__claude_ai_Slack__slack_read_channel /tmp '')"
expect allow "connector search"               "$(run mcp__claude_ai_Gmail__search_threads /tmp '')"
expect allow "telegram reply (own channel)"   "$(run mcp__plugin_telegram_telegram__reply /tmp '')"
expect allow "imessage reply (own channel)"   "$(run mcp__plugin_imessage_imessage__reply /tmp '')"
expect allow "plain ls"                       "$(run Bash /tmp 'ls -la')"
expect allow "Write tool"                     "$(run Write /tmp '/x/a.md')"
echo "action-rules: the ask verdict names the escape hatch, the deny verdict names the rule"
out="$(python3 -c 'import json;print(json.dumps({"tool_name":"Bash","cwd":"/tmp","tool_input":{"command":"npm publish"}}))' | ( cd "$A" && python3 hooks/action-rules.py check ))"
case "$out" in *"deploy-or-publish"*"approve deploy-or-publish"*) ok ;; *) no "ask reason does not name the rule and the approve command" "$out" ;; esac

echo "action-rules: one-use approvals"
( cd "$A" && python3 hooks/action-rules.py approve deploy-or-publish 5 "user said yes in chat" >/dev/null )
expect allow "approved once"                  "$(run Bash /tmp 'npm publish')"
expect ask   "approval consumed"              "$(run Bash /tmp 'npm publish')"
( cd "$A" && python3 hooks/action-rules.py approve deploy-or-publish 5 "" >/dev/null 2>&1 ); rc=$?
[ "$rc" -ne 0 ] && ok || no "approval without a note was accepted"
( cd "$A" && python3 hooks/action-rules.py approve own-channel-reply 5 "x" >/dev/null 2>&1 ); rc=$?
[ "$rc" -ne 0 ] && ok || no "approve accepted a rule that is not an ask rule"
( cd "$A" && python3 hooks/action-rules.py approve push-to-main 5 "yes" >/dev/null )
sleep 0 ; python3 - "$XDG_STATE_HOME" <<'PY'
import glob, json, sys, time
for p in glob.glob(sys.argv[1] + "/talos/*/approvals/push-to-main.json"):
    d = json.load(open(p)); d["until"] = time.time() - 5; json.dump(d, open(p, "w"))
PY
expect ask   "an expired approval does not count" "$(run Bash /tmp 'git push origin main')"

echo "action-rules: your own rules file wins, and can carve out an exception"
mkdir -p "$XDG_CONFIG_HOME/talos"
cat > "$XDG_CONFIG_HOME/talos/action-rules.yaml" <<'YML'
rules:
  - id: my-docs-ok
    decision: allow
    tool: Bash
    command: '(?:^|[;&|(\n`])\s*npm\s+publish\b'
    cwd_note: "an unknown key is ignored"
  - id: my-never-tweets
    decision: never
    tool: Bash
    command: 'api\.twitter\.com/2/tweets'
    why: "I draft, I post."
  - id: my-ask-env-edit
    decision: ask
    tool: 'Write|Edit'
    path: '(^|/)\.env$'
    why: "Secrets files change only with your say-so."
YML
expect allow "user allow overrides a starter ask"   "$(run Bash /tmp 'npm publish')"
expect deny  "user never rule"                      "$(run Bash /tmp 'curl -X POST https://api.twitter.com/2/tweets -d x')"
expect ask   "user path rule on Write"              "$(run Write /tmp '/proj/.env')"
expect allow "user path rule leaves other files"    "$(run Write /tmp '/proj/notes.md')"
expect deny  "starter never still applies"          "$(run Bash /tmp 'rm -rf ~')"
( cd "$A" && python3 hooks/action-rules.py test >/dev/null ) && ok || no "action-rules.py test failed on valid files"
( cd "$A" && python3 hooks/action-rules.py list | grep -q 'my-never-tweets' ) && ok || no "list does not show the user rules"

echo "action-rules: failure modes"
printf 'rules:\n  - id: broken\n    decision: never\n    tool: Bash\n    command: "(unclosed"\n  - id: after-broken\n    decision: never\n    tool: Bash\n    command: "dangerous-thing"\n' > "$XDG_CONFIG_HOME/talos/action-rules.yaml"
expect deny  "a bad regex in one rule does not disable the next" "$(run Bash /tmp 'dangerous-thing now')"
printf 'rules:\n  this is not a rule\n' > "$XDG_CONFIG_HOME/talos/action-rules.yaml"
out="$(python3 -c 'import json;print(json.dumps({"tool_name":"Bash","cwd":"/tmp","tool_input":{"command":"ls"}}))' | ( cd "$A" && python3 hooks/action-rules.py check 2>&1 ))"; rc=$?
[ "$out" = "{}" ] && [ "$rc" = 0 ] && ok || no "an unreadable rules file did not fail open in a live session" "$out"
out="$(python3 -c 'import json;print(json.dumps({"tool_name":"Bash","cwd":"/tmp","tool_input":{"command":"ls"}}))' | ( cd "$A" && CHRONOS_RUN=1 python3 hooks/action-rules.py check 2>&1 ))"
case "$out" in *'"deny"'*) ok ;; *) no "an unreadable rules file did not fail CLOSED when unattended" "$out" ;; esac
( cd "$A" && python3 hooks/action-rules.py test >/dev/null 2>&1 ) && no "test accepted an unreadable rules file" || ok
rm -f "$XDG_CONFIG_HOME/talos/action-rules.yaml"
out="$(python3 -c 'import json;print(json.dumps({"tool_name":"Bash","cwd":"/tmp","tool_input":{"command":"npm publish"}}))' | ( cd "$A" && CHRONOS_RUN=1 python3 hooks/action-rules.py check ))"
case "$out" in *'"deny"'*) ok ;; *) no "an ask must become a deny when unattended" "$out" ;; esac
out="$(printf 'not json' | ( cd "$A" && python3 hooks/action-rules.py check 2>&1 ))"
[ "$out" = "{}" ] && ok || no "garbage stdin did not allow" "$out"
out="$(python3 -c 'import json;print(json.dumps({"tool_name":"Bash","cwd":"/tmp","tool_input":{"command":"npm publish"}}))' | ( cd "$A" && TALOS_ACTION_RULES_OFF=1 python3 hooks/action-rules.py check ))"
[ "$out" = "{}" ] && ok || no "TALOS_ACTION_RULES_OFF=1 did not switch it off" "$out"
SD="$(cd "$A" && python3 -c 'import sys; sys.path.insert(0,"hooks"); import _talos_common as C; print(C.state_dir())')"
mkdir -p "$SD"; touch "$SD/action-rules.off"
out="$(python3 -c 'import json;print(json.dumps({"tool_name":"Bash","cwd":"/tmp","tool_input":{"command":"npm publish"}}))' | ( cd "$A" && python3 hooks/action-rules.py check ))"
[ "$out" = "{}" ] && ok || no "the kill-switch file did not switch it off" "$out"
rm -f "$SD/action-rules.off"
grep -q '"action-rules.off"\|KILL_NAME = "action-rules.off"' "$A/hooks/action-rules.py" && ok || no "kill switch name is not a literal"
grep -q 'command:' "$SB/agent/hooks/action-rules.yaml" && ! grep -q 'rm -rf ~$' "$SB/agent/hooks/action-rules.yaml" && ok || no "starter yaml sanity"

if [ "${TALOS_TEST_NOYAML:-0}" != 1 ]; then
  echo "action-rules: again with PyYAML hidden (the built-in reader)"
  out2="$(TALOS_TEST_NOYAML=1 bash "${BASH_SOURCE[0]}" 2>&1)"; rc2=$?
  printf '%s\n' "$out2" | grep -E '^  FAIL' | head -20
  [ "$rc2" -eq 0 ] && PASS=$((PASS+1)) || no "the built-in YAML reader pass failed"
fi
echo "  action-rules: PASS $PASS FAIL $FAIL"
[ "$FAIL" -eq 0 ]
