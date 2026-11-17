#!/usr/bin/env bash
# test-action-rules.sh -- hooks/action-rules.py against the starter rules, a user rules file, approvals, and failure modes.
# Throwaway HOME/XDG; never touches your real config or state. Every case feeds the hook the JSON the harness would send.
export PYTHONDONTWRITEBYTECODE=1
set -uo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$KIT/scripts/_test-env.sh"
SB="$(mktemp -d)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
trap 'rm -rf "$SB"' EXIT
export HOME="$SB/home"; mkdir -p "$HOME"
talos_test_sandbox "$SB"
export XDG_STATE_HOME="$SB/state" XDG_CONFIG_HOME="$SB/cfg"
unset CHRONOS_RUN TALOS_UNATTENDED CHRONOS_CONFIG
# Second pass: hide PyYAML so the built-in reader is what parses the rules (a stock Mac python3 has no PyYAML).
if [ "${TALOS_TEST_NOYAML:-0}" = 1 ]; then mkdir -p "$SB/noyaml"; printf 'raise ImportError("hidden for the test")\n' > "$SB/noyaml/yaml.py"; export PYTHONPATH="$SB/noyaml"; fi
A="$SB/agent"; mkdir -p "$A/hooks"; cp "$KIT"/hooks/*.py "$KIT"/hooks/action-rules.yaml "$A/hooks/"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

# the hook and approve with the password database answering this sandbox's HOME as the account home (hermetic: the real account may
# have a Talos app); ACCT moves that answer, HOME stays where it is
cat > "$SB/acct.py" <<'PY'
import os, pwd, runpy, sys
home = sys.argv[1]
real = pwd.getpwuid
pwd.getpwuid = lambda uid: (lambda e: type("E", (), {"pw_dir": home, "pw_name": e.pw_name})())(real(uid))
sys.argv = ["action-rules.py"] + sys.argv[2:]
runpy.run_path("hooks/action-rules.py", run_name="__main__")
PY
acct(){ python3 "$SB/acct.py" "${ACCT:-$HOME}" "$@"; }
# run <tool> <cwd> <command-or-path>  -> verdict word: allow | deny | ask
run() {
  local out
  out="$(python3 -c 'import json,sys
t=sys.argv[1]; v=sys.argv[3]
ti={"command":v} if t=="Bash" else {"file_path":v,"content":"x"}
print(json.dumps({"tool_name":t,"cwd":sys.argv[2],"tool_input":ti}))' "$1" "$2" "$3" | ( cd "$A" && acct check 2>"$SB/err" ))"
  case "$out" in *'"deny"'*) echo deny ;; *'"ask"'*) echo ask ;; *) echo allow ;; esac
}
expect(){ local want="$1" label="$2" got="$3"; [ "$got" = "$want" ] && ok || no "$label (want $want, got $got)"; }
K1=pk; K1="${K1}ill"; K2=kill; K2="${K2}all"

echo "action-rules: Talos app tools are the kit's own channel"
for t in reply schedule_propose schedule_run_start schedule_run_done schedules_list; do
  expect allow "talos-app $t"                 "$(run mcp__talos-app__$t /tmp x)"
  expect allow "talos-app $t (CHRONOS_RUN=1)" "$(CHRONOS_RUN=1 run mcp__talos-app__$t /tmp x)"
done
expect ask   "talos-app send_x stays gated"   "$(run mcp__talos-app__send_x /tmp x)"
expect ask   "talos-app reply_all stays gated" "$(run mcp__talos-app__reply_all /tmp x)"
expect ask   "other server reply stays gated" "$(run mcp__other__reply /tmp x)"

echo "action-rules: a git push to main is its own kind"
python3 - "$A/hooks" <<'PY' && ok || no "push-to-main is not kind push, or push is not an allowed kind (deploy stays deploy)"
import importlib.util, sys
spec = importlib.util.spec_from_file_location("ar", sys.argv[1] + "/action-rules.py")
ar = importlib.util.module_from_spec(spec); spec.loader.exec_module(ar)
kinds = {r["id"]: r.get("kind") for r in ar.load_rules()}
assert kinds["push-to-main"] == "push", kinds
assert kinds["deploy-or-publish"] == "deploy", kinds
assert ar.rule_kind({"kind": "push"}, "Bash") == "push"
assert ar.rule_kind({"kind": "nonsense"}, "Bash") is None
PY

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
why(){ python3 -c 'import json,sys;print(json.dumps({"tool_name":"Bash","cwd":"/tmp","tool_input":{"command":sys.argv[1]}}))' "$1" | ( cd "$A" && acct check ); }
why_tool(){ python3 -c 'import json,sys;print(json.dumps({"tool_name":sys.argv[1],"cwd":"/tmp","tool_input":{}}))' "$1" | ( cd "$A" && acct check ); }
grep -q "'github-repo-public-or-delete'" <<<"$(why 'gh repo edit me/x --visibility public')" && ok || no "a public repo is not its own no-kind rule"
expect ask   "gh api -X DELETE repos"         "$(run Bash /tmp 'gh api -X DELETE repos/o/r')"
expect ask   "gh api --method=delete refs"    "$(run Bash /tmp 'gh api --method=delete repos/o/r/git/refs/heads/x')"
expect ask   "gh api visibility='public'"     "$(run Bash /tmp "gh api repos/o/r -f visibility='public'")"
expect ask   'gh api private="false"'         "$(run Bash /tmp 'gh api repos/o/r -f private="false"')"
expect ask   "GH_TOKEN=x gh repo delete"      "$(run Bash /tmp 'GH_TOKEN=x gh repo delete o/r --yes')"
expect ask   "command gh api -X DELETE repos" "$(run Bash /tmp 'command gh api -X DELETE repos/o/r')"
expect ask   "gh api repos then -X DELETE"    "$(run Bash /tmp 'gh api repos/o/r -X DELETE')"
expect ask   "gh api -X 'DELETE' repos"       "$(run Bash /tmp "gh api -X 'DELETE' repos/o/r")"
expect ask   'gh api --method="DELETE" repos'  "$(run Bash /tmp 'gh api --method="DELETE" repos/o/r')"
# BSEC-2 review: a crafted run of "(gh api repos/ " must match fast (no cubic backtracking: the 20 s guard timeout allows the call
# through unchecked) and the push to main after it must still hit its rule
python3 - "$A/hooks" <<'PY' && ok || no "the repo-delete match is slow on a crafted line, or the push after it is missed"
import importlib.util, re, sys, time
spec = importlib.util.spec_from_file_location("ar", sys.argv[1] + "/action-rules.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
rules = {r["id"]: r for r in m.load_rules()}
text = "/tmp\n" + "(gh api repos/ " * 1500 + "; git push origin main"
t = time.time(); hit = re.search(rules["github-repo-public-or-delete"]["command"], text); dt = time.time() - t
assert not hit, "no delete in that line"
F = float(__import__("os").environ.get("TALOS_TEST_TIME_FACTOR") or 1)
assert dt < 1 * F, "took %.2fs" % dt
assert re.search(rules["push-to-main"]["command"], text), "push-to-main missed"
print("crafted line matched in %.3fs" % dt)
PY
# every shipped rule, run the way the hook runs it (tool: fullmatch, command/path: search), against pathological input: each match
# must finish in under 0.5 s, so no rule can run the 20 s guard timeout out
python3 - "$A/hooks" <<'PY' && ok "every shipped rule matches pathological input in under 0.5 s" || no "a shipped rule is slow on pathological input"
import importlib.util, re, sys, time
F = float(__import__("os").environ.get("TALOS_TEST_TIME_FACTOR") or 1)  # a loaded machine (the gate sets 3) scales the limits
spec = importlib.util.spec_from_file_location("ar", sys.argv[1] + "/action-rules.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
rules = m.load_file(m.SHIPPED)
assert len(rules) >= 10, len(rules)
slow = []
total = time.time()
for r in rules:
    pats = [r.get(k) for k in ("tool", "command", "path") if r.get(k)]
    words = sorted({w for p in pats for w in re.findall(r"[A-Za-z][A-Za-z_]{2,}", re.sub(r"\\.", " ", p))})
    own = " ".join(words)
    inputs = {
        "20KB": "a" * 20000,
        "2000 x (gh api repos/ ": "(gh api repos/ " * 2000,
        "nested quotes": "'\"'\"'" * 4000,
        "5000 separators": ";&|" * 5000,
        "2000 spaces then x": " " * 2000 + "x",
        "own keywords x1000": (own + " ") * 1000,
        "own keywords joined x1000": "".join(w + "_" for w in words) * 1000,
        "keywords then push": (own + " ") * 1000 + "; git push origin main",
        "quoted values": "gh api repos/o/r -f visibility=\"" * 1000,
        "env prefixes": "A=b " * 5000 + "gh api",
        "(a= runs": "(a=" * 20000,
        "(env a=b= runs": "(env " + "a=b=" * 20000,
        "(env a=b runs": "(env a=b " * 8000 + "gh api",
    }
    for label, text in inputs.items():
        for kind, pat, fn in (("tool", r.get("tool"), re.fullmatch), ("command", r.get("command"), re.search),
                              ("path", r.get("path"), re.search)):
            if not pat:
                continue
            subject = text if kind != "command" else "/tmp\n" + text
            t = time.time(); fn(pat, subject); dt = time.time() - t
            if dt >= 0.5 * F:
                slow.append("%s %s on %s: %.2fs" % (r["id"], kind, label, dt))
assert not slow, slow
assert time.time() - total < 20 * F, "the whole sweep took %.1fs" % (time.time() - total)
print("every shipped rule: %d rules, whole sweep %.1fs" % (len(rules), time.time() - total))
PY
expect allow "gh api repos GET"               "$(run Bash /tmp 'gh api repos/o/r')"
grep -q "'github-repo-public-or-delete'" <<<"$(why 'gh repo delete me/x --yes')" && ok || no "a repo delete is not its own no-kind rule"
grep -q "'github-release-or-public'" <<<"$(why 'gh release create v1.0 --notes x')" && ok || no "a release is not under the publish rule"
expect ask   "gh auth switch"                 "$(run Bash /tmp 'gh auth switch -u someone')"
expect allow "gh auth status"                 "$(run Bash /tmp 'gh auth status')"
expect ask   "connector send"                 "$(run mcp__claude_ai_Slack__slack_send_message /tmp '')"
expect ask   "connector mail forward"         "$(run mcp__claude_ai_Gmail__forward /tmp '')"
expect ask   "connector delete"               "$(run mcp__claude_ai_Google_Drive__trash_file /tmp '')"
for t in delete_file publish_page share_file schedule_event; do
  grep -q "'destructive-via-connector'" <<<"$(why_tool mcp__x__$t)" && ok || no "connector $t is not its own no-kind rule"
done
for t in create_shared_link shared_link_create add_shared_drive_member shared_drive_add_permission; do
  grep -q "'destructive-via-connector'" <<<"$(why_tool mcp__x__$t)" && ok || no "connector $t (a real share) does not ask"
done
for t in list_shared_drives get_shared_drive get_shared_drive_metadata; do
  grep -q "'destructive-via-connector'" <<<"$(why_tool mcp__x__$t)" && no "read-only $t asks as destructive" || ok
done
grep -q "'send-or-publish-via-connector'" <<<"$(why_tool mcp__x__send_message)" && ok || no "connector send lost its send rule"
expect allow "connector read"                 "$(run mcp__claude_ai_Slack__slack_read_channel /tmp '')"
expect allow "connector search"               "$(run mcp__claude_ai_Gmail__search_threads /tmp '')"
expect ask   "discord reply (not the allowed channel)" "$(run mcp__plugin_discord_discord__reply /tmp '')"
expect allow "imessage reply (own channel)"   "$(run mcp__plugin_imessage_imessage__reply /tmp '')"
expect allow "plain ls"                       "$(run Bash /tmp 'ls -la')"
expect allow "Write tool"                     "$(run Write /tmp '/x/a.md')"
echo "action-rules: the ask verdict names the escape hatch, the deny verdict names the rule"
out="$(python3 -c 'import json;print(json.dumps({"tool_name":"Bash","cwd":"/tmp","tool_input":{"command":"npm publish"}}))' | ( cd "$A" && acct check ))"
case "$out" in *"deploy-or-publish"*"approve deploy-or-publish"*) ok ;; *) no "ask reason does not name the rule and the approve command" "$out" ;; esac

echo "action-rules: one-use approvals"
( cd "$A" && acct approve deploy-or-publish 5 "user said yes in chat" >/dev/null )
expect allow "approved once"                  "$(run Bash /tmp 'npm publish')"
expect ask   "approval consumed"              "$(run Bash /tmp 'npm publish')"
( cd "$A" && acct approve deploy-or-publish 5 "" >/dev/null 2>&1 ); rc=$?
[ "$rc" -ne 0 ] && ok || no "approval without a note was accepted"
( cd "$A" && acct approve own-channel-reply 5 "x" >/dev/null 2>&1 ); rc=$?
[ "$rc" -ne 0 ] && ok || no "approve accepted a rule that is not an ask rule"
( cd "$A" && acct approve push-to-main 5 "yes" >/dev/null )
sleep 0 ; python3 - "$XDG_STATE_HOME" <<'PY'
import glob, json, sys, time
for p in glob.glob(sys.argv[1] + "/talos/*/approvals/push-to-main.json"):
    d = json.load(open(p)); d["until"] = time.time() - 5; json.dump(d, open(p, "w"))
PY
expect ask   "an expired approval does not count" "$(run Bash /tmp 'git push origin main')"

echo "action-rules: with the Talos app, only the owner's tap (the bridge's answer) approves (audit item 28)"
rm -rf "$XDG_STATE_HOME"/talos/*/asks "$XDG_STATE_HOME"/talos/*/approvals 2>/dev/null
TH="$SB/talos-app"; mkdir -p "$TH/run"; echo '{}' > "$TH/config.json"
# a stand-in bridge on the hub socket: logs every line it is sent; `ask_rule` answers what $TH/mode says (allow|deny|waiting)
# and on allow approves exactly that call; `rule_take` lets through only an approved call, once (the bridge's rule)
cat > "$SB/fakehub.py" <<'PY'
import json, os, socket, sys
home, as_bridge = sys.argv[1], sys.argv[2] == "1"
path = os.path.join(home, "run", "hub.sock")
try: os.unlink(path)
except FileNotFoundError: pass
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.bind(path); s.listen(8)
json.dump({"pid": os.getpid() if as_bridge else 1}, open(os.path.join(home, "bridge.pid"), "w"))
open(os.path.join(home, "up"), "w").close()
ok = set()
key = lambda m: json.dumps([m.get("rule"), m.get("tool_name"), m.get("tool_input"), m.get("cwd"), m.get("thread_id")], sort_keys=True)
while True:
    c, _ = s.accept(); buf = b""
    while b"\n" not in buf:
        d = c.recv(65536)
        if not d: break
        buf += d
    if not buf: c.close(); continue
    m = json.loads(buf.split(b"\n")[0])
    open(os.path.join(home, "got.jsonl"), "a").write(json.dumps(m) + "\n")
    mode = open(os.path.join(home, "mode")).read().strip() if os.path.exists(os.path.join(home, "mode")) else "allow"
    if m["t"] == "ask_rule":
        d = {"allow": "allow", "always": "allow", "deny": "deny"}.get(mode, "none")
        if d == "allow": ok.add(key(m))
        r = {"decision": d, "reason": "always" if mode == "always" else ("owner" if d != "none" else mode)}
    elif m["t"] == "rule_take":
        k = key(m); r = {"decision": "allow" if k in ok else "none", "reason": "owner"}; ok.discard(k)
    elif m["t"] == "rule_notice":
        if mode == "stall": __import__("time").sleep(5)
        r = {"decision": "none", "reason": "told"}
    else:
        r = {"decision": "none", "reason": "?"}
    c.sendall((json.dumps(dict(r, t="rule_result", id=m["id"])) + "\n").encode()); c.close()
PY
hub(){ rm -f "$TH/up" "$TH/got.jsonl"; python3 "$SB/fakehub.py" "$TH" "${1:-1}" & HUBPID=$!; for _ in $(seq 50); do [ -e "$TH/up" ] && break; sleep 0.1; done; }
unhub(){ kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; }
app(){ TALOS_APP_HOME="$TH" "$@"; }
pub(){ python3 -c 'import json,sys;print(json.dumps({"tool_name":"Bash","cwd":"/srv/app","tool_input":{"command":sys.argv[1],"description":"publish it"}}))' "${1:-npm publish}" | ( cd "$A" && app acct check ); }
verdict(){ case "$1" in *'"deny"'*) echo deny ;; *'"ask"'*) echo ask ;; *) echo allow ;; esac; }
hub 1
out="$(pub)"; expect ask "app: the rule stops the call" "$(verdict "$out")"
grep -q 'approve deploy-or-publish' <<<"$out" && grep -q 'tap' <<<"$out" && ok || no "the ask does not say approve asks for the owner's tap" "$out"
grep '"rule_take"' "$TH/got.jsonl" | tail -1 | grep -q '"kind"' && no "the check named a kind (the bridge decides it)" "$(cat "$TH/got.jsonl")" || ok
# a session writing the old approval file itself: does not count with the app
SDIR="$(cd "$A" && python3 -c 'import sys; sys.path.insert(0,"hooks"); import _talos_common as C; print(C.state_dir())')"
mkdir -p "$SDIR/approvals"; python3 -c 'import json,sys,time; json.dump({"until":time.time()+600,"note":"yes"},open(sys.argv[1],"w"))' "$SDIR/approvals/deploy-or-publish.json"
expect ask "app: an approval file a session wrote does not count" "$(verdict "$(pub)")"
# approve sends the stopped call, whole, with the rule's kind and folder, and is approved only on the bridge's allow
echo deny > "$TH/mode"
out="$( cd "$A" && app acct approve deploy-or-publish 2>&1 )"; rc=$?
[ $rc -ne 0 ] && grep -q 'denied' <<<"$out" && ok || no "a Deny on the card did not refuse approve" "$out"
expect ask "app: nothing approved after a Deny" "$(verdict "$(pub)")"
echo allow > "$TH/mode"
out="$( cd "$A" && app acct approve deploy-or-publish 2>&1 )"; [ $? -eq 0 ] && ok || no "approve refused the owner's tap" "$out"
python3 - "$TH/got.jsonl" <<'PY' && ok || no "approve did not send the stopped call exactly"
import json, sys
m = [json.loads(l) for l in open(sys.argv[1]) if '"ask_rule"' in l][-1]
assert m["rule"] == "deploy-or-publish" and "kind" not in m and m["cwd"] == "/srv/app", m
assert m["tool_name"] == "Bash" and m["tool_input"] == {"command": "npm publish", "description": "publish it"}, m
assert "thread_id" not in m and "nonce" not in m, m
PY
expect ask   "app: a different call is not the approved one" "$(verdict "$(pub 'npm publish --tag next')")"
expect allow "app: the approved call goes through once"     "$(verdict "$(pub)")"
expect ask   "app: and only once"                           "$(verdict "$(pub)")"
# no stopped call waiting: nothing to put on a card
rm -rf "$SDIR/asks"
out="$( cd "$A" && app acct approve deploy-or-publish 2>&1 )"; [ $? -ne 0 ] && grep -q 'no call is waiting' <<<"$out" && ok || no "approve asked with no stopped call" "$out"
pub >/dev/null; echo waiting > "$TH/mode"
out="$( cd "$A" && app acct approve deploy-or-publish 2>&1 )"; [ $? -ne 0 ] && grep -q "haven't answered" <<<"$out" && ok || no "an unanswered card read as approved" "$out"
# a connector send: the call goes to the bridge whole, with no kind (the bridge decides email from the tool)
python3 -c 'import json;print(json.dumps({"tool_name":"mcp__gmail__send_message","tool_input":{"to":"a@example.com"}}))' | ( cd "$A" && app acct check ) >/dev/null
echo allow > "$TH/mode"; ( cd "$A" && app acct approve send-or-publish-via-connector >/dev/null 2>&1 )
tail -1 "$TH/got.jsonl" | grep -q '"mcp__gmail__send_message"' && ! tail -1 "$TH/got.jsonl" | grep -q '"kind"' && ok || no "the connector send was not sent whole, without a kind" "$(tail -1 "$TH/got.jsonl")"
# making a repository public has no kind (Pantheon 2026-11-15): always a card, whatever is always allowed
python3 -c 'import json;print(json.dumps({"tool_name":"Bash","cwd":"/tmp","tool_input":{"command":"gh repo edit me/x --visibility public"}}))' | ( cd "$A" && app acct check ) >/dev/null
grep '"rule_take"' "$TH/got.jsonl" | tail -1 | grep -q '"kind"' && no "the public-repo check sent a kind" || ok
( cd "$A" && app acct approve github-repo-public-or-delete >/dev/null 2>&1 )
tail -1 "$TH/got.jsonl" | grep -q '"github-repo-public-or-delete"' && ! tail -1 "$TH/got.jsonl" | grep -q '"kind"' && ok || no "a public repo asked with a kind" "$(tail -1 "$TH/got.jsonl")"
# a thread session proves itself; one with no nonce asks for nothing
pub >/dev/null
( cd "$A" && TALOS_APP_WORKER_THREAD=th1 TALOS_APP_WORKER_NONCE=0123456789abcdef0123 app acct approve deploy-or-publish >/dev/null 2>&1 )
tail -1 "$TH/got.jsonl" | grep -q '"thread_id": "th1"' && tail -1 "$TH/got.jsonl" | grep -q '"nonce"' && ok || no "a thread session's request has no proof" "$(tail -1 "$TH/got.jsonl")"
expect ask "app: a thread's approval is not main's" "$(verdict "$(pub)")"
n="$(wc -l < "$TH/got.jsonl")"
out="$( cd "$A" && TALOS_APP_WORKER_THREAD=th1 TALOS_APP_WORKER_NONCE= app acct approve deploy-or-publish 2>&1 )"; [ $? -ne 0 ] && [ "$(wc -l < "$TH/got.jsonl")" = "$n" ] && ok || no "a thread session with no nonce sent a request" "$out"
unhub
# a listener that is not the bridge in bridge.pid never sees the call, and approves nothing
hub 0; pub >/dev/null
out="$( cd "$A" && app acct approve deploy-or-publish 2>&1 )"; [ $? -ne 0 ] && grep -q "can't be reached" <<<"$out" && ok || no "approve trusted a socket that is not the bridge" "$out"
[ ! -s "$TH/got.jsonl" ] && ok || no "a stand-in listener was sent the call" "$(cat "$TH/got.jsonl")"
unhub
# no bridge at all: no approval, the action keeps asking
expect ask "app, bridge down: still asks" "$(verdict "$(pub)")"
out="$( cd "$A" && app acct approve deploy-or-publish 2>&1 )"; [ $? -ne 0 ] && ok || no "approve went through with no bridge" "$out"
# the app found at the account home without TALOS_APP_HOME (the hook's own environment)
mkdir -p "$SB/acct/.config/talos/app"; echo '{}' > "$SB/acct/.config/talos/app/config.json"
python3 -c 'import json,sys,time; json.dump({"until":time.time()+600,"note":"yes"},open(sys.argv[1],"w"))' "$SDIR/approvals/deploy-or-publish.json"
out="$(python3 -c 'import json;print(json.dumps({"tool_name":"Bash","cwd":"/tmp","tool_input":{"command":"npm publish"}}))' | ( cd "$A" && HOME="$SB/acct" ACCT="$SB/acct" acct check ))"
expect ask "the app at the account home: a file approval does not count" "$(verdict "$out")"
rm -rf "$SB/acct" "$SDIR/approvals"
rm -rf "$XDG_STATE_HOME"/talos/*/asks "$XDG_STATE_HOME"/talos/*/approvals 2>/dev/null
echo "action-rules: approve with HOME moved off the account's home is refused, not treated as no Talos app"
out="$( cd "$A" && ACCT="$SB/the-real-home" acct approve deploy-or-publish 5 "yes" 2>&1 )"; [ $? -ne 0 ] && grep -q 'HOME is not this account' <<<"$out" && ok || no "a moved HOME took the no-app path" "$out"
out="$( cd "$A" && python3 hooks/action-rules.py approve deploy-or-publish 5 "yes" 2>&1 )"; [ $? -ne 0 ] && grep -q 'HOME is not this account' <<<"$out" && ok || no "the real password database did not refuse the sandbox HOME" "$out"

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
( cd "$A" && python3 hooks/action-rules.py list | grep 'my-never-tweets' >/dev/null ) && ok || no "list does not show the user rules"

echo "action-rules: failure modes"
printf 'rules:\n  this is not a rule\n' > "$XDG_CONFIG_HOME/talos/action-rules.yaml"
( cd "$A" && python3 hooks/action-rules.py test >/dev/null 2>&1 ) && no "test accepted an unreadable rules file" || ok
# (an unreadable file of yours, or the shipped one, ASKS live and DENIES unattended: see "an unreadable rule file" below)
# never rules run before ask rules: your own ask rule on a call the starter set forbids does not turn the refusal into a question,
# and your own allow still carves an exception out of a never
printf 'rules:\n  - id: my-ask-rm\n    decision: ask\n    tool: Bash\n    command: "rm -rf"\n' > "$XDG_CONFIG_HOME/talos/action-rules.yaml"
expect deny  "a user ask rule does not beat a starter never rule" "$(run Bash /tmp 'rm -rf ~')"
expect ask   "a user ask rule still asks where no never rule matches" "$(run Bash /tmp 'rm -rf build')"
printf 'rules:\n  - id: my-allow-rm\n    decision: allow\n    tool: Bash\n    command: "rm -rf ~$"\n' > "$XDG_CONFIG_HOME/talos/action-rules.yaml"
expect allow "a user allow still carves an exception out of a starter never" "$(run Bash /tmp 'rm -rf ~')"
rm -f "$XDG_CONFIG_HOME/talos/action-rules.yaml"
# a hung check (stdin held open past the alarm) ASKS in a live session and DENIES when unattended, and is never allowed
live="$(sleep 4 | ( cd "$A" && TALOS_GUARD_TIMEOUT_S=1 python3 hooks/action-rules.py check 2>/dev/null ))"
un="$(sleep 4 | ( cd "$A" && CHRONOS_RUN=1 TALOS_GUARD_TIMEOUT_S=1 python3 hooks/action-rules.py check 2>/dev/null ))"
expect ask  "action-rules: a timeout asks in a live session" "$(verdict "$live")"
grep -q 'timed out checking' <<<"$live" && ok || no "the timeout ask has no timeout reason" "$live"
expect deny "action-rules: a timeout denies when unattended" "$(verdict "$un")"
# an unreadable rule file (the SHIPPED one: missing, empty, rejected by either reader, a rule that is not valid; or YOURS: the same, plus
# a bad regex) must never allow everything: it ASKS in a live session and DENIES when unattended, with the timeout's output and exit
# code (0), naming the file and the error (and the line where there is one), never the command. One code path for both files.
echo "action-rules: an unreadable rule file asks (live) or denies (unattended), never allows"
cp "$A/hooks/action-rules.yaml" "$SB/shipped.keep"
# a PyYAML stand-in: strict about a bare ' inside a single-quoted value (what real PyYAML refused on 2026-11-16), and it rejects
# every other file too, so it only ever stands for "PyYAML says no"
mkdir -p "$SB/fakeyaml"; cat > "$SB/fakeyaml/yaml.py" <<'PY'
import re
class YAMLError(Exception): pass
def safe_load(text):
    for n, line in enumerate(text.splitlines(), 1):
        m = re.match(r"^\s*(?:-\s+)?[A-Za-z_][\w-]*:\s+'(.*)'\s*(?:#.*)?$", line)
        if m and "'" in m.group(1).replace("''", ""):
            raise YAMLError("while scanning a single-quoted scalar, line %d: a bare ' inside the quotes" % n)
    raise YAMLError("the PyYAML stand-in rejects every file")
PY
# a PyYAML stand-in that SUCCEEDS: it agrees with the built-in reader on every file, except one with MARK-RETURN in it (it answers
# the JSON in FAKEYAML_RETURN: a wrong shape, or rules that differ) or MARK-EXIT (it raises SystemExit(0), as a planted module could)
mkdir -p "$SB/retyaml" "$SB/exitimport"; cat > "$SB/retyaml/yaml.py" <<'PY'
import importlib.util, json, os
class YAMLError(Exception): pass
_ar = None
def safe_load(text):
    global _ar
    if "MARK-RETURN" in text: return json.loads(os.environ["FAKEYAML_RETURN"])
    if "MARK-EXIT" in text: raise SystemExit(0)
    if _ar is None:
        spec = importlib.util.spec_from_file_location("ar_for_stand_in", os.environ["FAKEYAML_HOOK"])
        _ar = importlib.util.module_from_spec(spec); spec.loader.exec_module(_ar)
    return {"rules": _ar._builtin(text)[0]}
PY
printf 'raise SystemExit(0)\n' > "$SB/exitimport/yaml.py"
CALLJ='{"tool_name":"Bash","cwd":"/srv/app","tool_input":{"command":"npm publish"}}'
chk(){ # $1 = env assignments (may be empty), the call on stdin of printf -> "<stdout>|<exit code>"
  local out rc
  out="$(printf '%s' "$CALLJ" | ( cd "$A" && env $1 python3 "$SB/acct.py" "$HOME" check 2>"$SB/err" ))"; rc=$?
  printf '%s|%s' "$(printf '%s' "$out" | tr -d '\n')" "$rc"; }
ULOG(){ cat "$XDG_STATE_HOME"/talos/*/action-rules-unreadable.jsonl 2>/dev/null; }
UFILE="$XDG_CONFIG_HOME/talos/action-rules.yaml"
unreadable_case() { # $1 label, $2 env for the hook, $3 a regex the reason must match, $4 which file (shipped|user, default shipped)
  local live un rows which="${4:-shipped}" tail=hooks/action-rules.yaml
  [ "$which" = user ] && tail=talos/action-rules.yaml
  rm -f "$XDG_STATE_HOME"/talos/*/action-rules-unreadable.jsonl
  live="$(chk "$2")"; un="$(chk "CHRONOS_RUN=1 $2")"
  { [ "$(verdict "${live%|*}")" = ask ] && [ "${live##*|}" = 0 ]; } && ok || no "$1: live did not ASK with exit 0" "$live"
  { [ "$(verdict "${un%|*}")" = deny ] && [ "${un##*|}" = 0 ]; } && ok || no "$1: unattended did not DENY with exit 0" "$un"
  { grep -q "$tail" <<<"$live" && grep -qE "$3" <<<"$live" && ! grep -q 'npm publish' <<<"$live$un"; } && ok || no "$1: the reason must name the file ($tail) and match '$3', and never the command" "$live"
  rows="$(ULOG | wc -l | tr -d ' ')"
  { [ "$rows" = 2 ] && ULOG | python3 -c 'import json,sys
which, tail = sys.argv[1], sys.argv[2]
rs=[json.loads(l) for l in sys.stdin]
assert all(r["file"]==which and r["path"].endswith(tail) and r["error"] and r["at"].endswith("Z") for r in rs), rs
assert sorted(r["unattended"] for r in rs)==[False,True], rs
assert not any("npm publish" in json.dumps(r) for r in rs), rs' "$which" "$tail"; } && ok || no "$1: want one action-rules-unreadable.jsonl line per call (file $which, path, error, no command text)" "$(ULOG)"
}
# the old broken line: a bare ' inside the single quotes, which the built-in reader reads and PyYAML refuses
python3 - "$SB/shipped.keep" "$A/hooks/action-rules.yaml" <<'PY' || no "could not build the broken shipped file (the doubled-quote spot moved?)"
import sys
t = open(sys.argv[1]).read()
assert "[''\"]" in t, "the shipped file no longer has the doubled-quote spot this test breaks"
open(sys.argv[2], "w").write(t.replace("[''\"]", "['\"]"))
PY
unreadable_case "the old broken quote (PyYAML refuses, the built-in reader reads it)" "PYTHONPATH=$SB/fakeyaml" 'PyYAML'
# PyYAML disagreeing with the built-in reader on a file the built-in one reads is unreadable too (no silent fallback)
cp "$SB/shipped.keep" "$A/hooks/action-rules.yaml"
unreadable_case "PyYAML rejects a file the built-in reader accepts" "PYTHONPATH=$SB/fakeyaml" 'must agree'
# a PyYAML that raises SystemExit(0), on import or on parse, is an error, never an exit-0 allow
unreadable_case "a yaml module that exits on import" "PYTHONPATH=$SB/exitimport" 'PyYAML'
# the readers must agree when both succeed; the stand-in agrees on the real shipped file, so the guard works with it
RY="PYTHONPATH=$SB/retyaml FAKEYAML_HOOK=$A/hooks/action-rules.py"
r="$(chk "$RY")"; [ "$(verdict "${r%|*}")" = ask ] && grep -q 'deploy-or-publish' <<<"$r" && ok || no "a PyYAML that agrees with the built-in reader changed the answer" "$r"
python3 - "$A/hooks" <<'PY' && ok || no "parse_rules: a wrong shape, a disagreement or a SystemExit from PyYAML was not an error (or an agreeing file was)"
import importlib.util, sys, types
spec = importlib.util.spec_from_file_location("ar", sys.argv[1] + "/action-rules.py")
ar = importlib.util.module_from_spec(spec); spec.loader.exec_module(ar)
def with_yaml(ret, text):
    m = types.ModuleType("yaml")
    def safe_load(t):
        if isinstance(ret, BaseException): raise ret
        return ret
    m.safe_load = safe_load
    sys.modules["yaml"] = m
    try: return ar.parse_rules(text)
    finally: del sys.modules["yaml"]
def without_yaml(text):
    sys.modules["yaml"] = None                  # `import yaml` raises ImportError
    try: return ar.parse_rules(text)
    finally: del sys.modules["yaml"]
def fails(fn, *want):
    try: fn()
    except ValueError as e:
        assert all(w in str(e) for w in want), (want, str(e))
        return
    raise AssertionError("no error: %r" % (want,))
body = "rules:\n  - id: a\n    decision: ask\n    tool: Bash\n    why: %s\n"
def rule(why): return {"rules": [{"id": "a", "decision": "ask", "tool": "Bash", "why": why}]}
# a wrong shape that PyYAML reads without an error: every owner never would be off
fails(lambda: with_yaml({}, body % "x"), "rules")
fails(lambda: with_yaml({"rule": [{"id": "a"}]}, body % "x"), "rules", "rule")
fails(lambda: with_yaml([{"id": "a", "decision": "never", "tool": "Bash"}], body % "x"), "rules")
fails(lambda: with_yaml(None, body % "x"), "rules")
fails(lambda: with_yaml({"rules": "nope"}, body % "x"), "list")
fails(lambda: without_yaml("rule:\n  - id: a\n"), "line 1")
fails(lambda: without_yaml("- id: a\n  decision: ask\n"), "line 1")
assert without_yaml("# only a comment\n\n") == [] and with_yaml({}, "# only a comment\n") == []
assert without_yaml("rules:\n") == [] and with_yaml({"rules": None}, "rules:\n") == []
# the four seen cases where both succeed and differ
fails(lambda: with_yaml(rule("x"), body % "'x' # c"), "must agree", "why")
fails(lambda: with_yaml(rule(None), body % "~"), "must agree", "why")
fails(lambda: with_yaml(rule(True), body % "yes"), "must agree", "why")
fails(lambda: with_yaml(rule("A"), body % '"\\x41"'), "must agree", "why")
assert with_yaml(rule("plain"), body % "plain")[0]["why"] == "plain"
# a SystemExit or any other BaseException from the module is an error, never an exit; Ctrl-C still stops
fails(lambda: with_yaml(SystemExit(0), body % "x"), "PyYAML")
fails(lambda: with_yaml(GeneratorExit(), body % "x"), "PyYAML")
try: with_yaml(KeyboardInterrupt(), body % "x"); raise AssertionError("swallowed Ctrl-C")
except KeyboardInterrupt: pass
PY
# end to end: PyYAML succeeds with a wrong shape / different rules / exits, on YOUR file
printf '# MARK-RETURN\nrules:\n  - id: my-never-x\n    decision: never\n    tool: Bash\n    command: "yyy"\n' > "$UFILE"
unreadable_case "your file, PyYAML reads {} (no rules key)" "$RY FAKEYAML_RETURN={}" 'rules' user
unreadable_case "your file, PyYAML reads rule: instead of rules:" "$RY FAKEYAML_RETURN={\"rule\":[{\"id\":\"a\"}]}" 'rules' user
unreadable_case "your file, PyYAML reads a top-level list" "$RY FAKEYAML_RETURN=[{\"id\":\"a\"}]" 'rules' user
unreadable_case "your file, PyYAML reads different rules" "$RY FAKEYAML_RETURN={\"rules\":[{\"id\":\"my-never-x\",\"decision\":\"never\",\"tool\":\"Bash\",\"command\":\"zzz\"}]}" 'must agree.*command|command.*must agree' user
printf '# MARK-EXIT\nrules:\n  - id: my-never-x\n    decision: never\n    tool: Bash\n    command: "yyy"\n' > "$UFILE"
unreadable_case "your file, PyYAML raises SystemExit(0) while parsing" "$RY" 'PyYAML' user
# a missing, an empty and a garbled shipped file; a shipped file with one rule is fine; any rule that is not valid makes it unreadable
rm -f "$UFILE"
rm -f "$A/hooks/action-rules.yaml"
unreadable_case "a missing shipped file" "" 'missing'
: > "$A/hooks/action-rules.yaml"
unreadable_case "an empty shipped file" "" 'no rules'
printf 'rules:\n' > "$A/hooks/action-rules.yaml"
unreadable_case "a shipped file with an empty rules list" "" 'no rules'
printf 'rules:\n  this is not a rule\n' > "$A/hooks/action-rules.yaml"
unreadable_case "a garbled shipped file" "" 'cannot read|must be a list'
{ cat "$SB/shipped.keep"; printf '\n  - id: bad-one\n    tool: Bash\n    decision: maybe\n'; } > "$A/hooks/action-rules.yaml"
unreadable_case "a shipped file with a decision that is not never, ask or allow" "" 'bad-one.*decision'
{ cat "$SB/shipped.keep"; printf '\n  - id: bad-one\n    tool: Bash\n    decision: ask\n    colour: red\n'; } > "$A/hooks/action-rules.yaml"
unreadable_case "a shipped file with an unknown field" "" 'unknown field.*colour'
{ cat "$SB/shipped.keep"; printf '\n  - id: bad-one\n    decision: ask\n    command: "(unclosed"\n'; } > "$A/hooks/action-rules.yaml"
unreadable_case "a shipped file with a bad regex" "" 'bad-one.*regex'
printf 'rules:\n  - id: only-one\n    decision: never\n    tool: Bash\n    command: "x"\n' > "$A/hooks/action-rules.yaml"
rm -f "$XDG_STATE_HOME"/talos/*/action-rules-unreadable.jsonl
r="$(chk "")"; [ "$r" = "{}|0" ] && ok || no "a shipped file with one valid rule is readable (at least one rule, every rule valid)" "$r"
[ -z "$(ULOG)" ] && ok || no "a readable shipped file wrote an unreadable line" "$(ULOG)"
# a stdout that cannot be written still blocks: exit 2, like the timeout path
rm -f "$A/hooks/action-rules.yaml"
( cd "$A" && printf '%s' "$CALLJ" | CHRONOS_RUN=1 python3 hooks/action-rules.py check >&- 2>/dev/null ); [ $? = 2 ] && ok || no "an unreadable shipped file with a closed stdout did not exit 2"
# list does not carry on with nothing
out="$( cd "$A" && python3 hooks/action-rules.py list 2>&1 )"; [ $? -ne 0 ] && ok || no "list printed an empty table for an unreadable shipped file" "$out"
cp "$SB/shipped.keep" "$A/hooks/action-rules.yaml"
expect ask "the restored shipped file asks again on npm publish" "$(run Bash /srv/app 'npm publish')"
# YOUR file unreadable: the same stop (a loud stop is safe; silently losing your never rules is the failure this prevents)
printf 'rules:\n  this is not a rule\n' > "$UFILE"
unreadable_case "a garbled file of yours" "" 'line 2' user
printf 'rules:\n  - id: broken\n    decision: never\n    tool: Bash\n    command: "(unclosed"\n  - id: after-broken\n    decision: never\n    tool: Bash\n    command: "dangerous-thing"\n' > "$UFILE"
unreadable_case "a bad regex in a rule of yours" "" 'broken.*regex' user
printf 'rules:\n  - id: typo\n    decision: nevr\n    tool: Bash\n' > "$UFILE"
unreadable_case "a rule of yours with a decision that is not never, ask or allow" "" 'typo.*decision' user
out="$( cd "$A" && python3 hooks/action-rules.py list 2>&1 )"; [ $? -ne 0 ] && grep -q 'typo' <<<"$out" && ok || no "list did not refuse with an unreadable file of yours" "$out"
printf 'rules:\n  - id: fine\n    decision: never\n    tool: Bash\n    command: "dangerous-thing"\n    cwd_note: "an unknown key is fine in your own file"\n' > "$UFILE"
rm -f "$XDG_STATE_HOME"/talos/*/action-rules-unreadable.jsonl
expect deny "a repaired file of yours works again" "$(run Bash /tmp 'dangerous-thing now')"
[ -z "$(ULOG)" ] && ok || no "a readable file of yours wrote an unreadable line" "$(ULOG)"
# the guard switched OFF (the kill switch file, or TALOS_ACTION_RULES_OFF=1; a machine that never registered the hook never runs `check`
# at all) is not stopped by a file it never reads: today's answer, no log line, nothing sent to the owner
printf 'rules:\n  this is not a rule\n' > "$UFILE"; rm -f "$XDG_STATE_HOME"/talos/*/action-rules-unreadable.jsonl
SDOFF="$(cd "$A" && python3 -c 'import sys; sys.path.insert(0,"hooks"); import _talos_common as C; print(C.state_dir())')"; mkdir -p "$SDOFF"
touch "$SDOFF/action-rules.off"
off1="$(chk "")"; off2="$(chk "CHRONOS_RUN=1")"; rm -f "$A/hooks/action-rules.yaml"; off3="$(chk "")"; cp "$SB/shipped.keep" "$A/hooks/action-rules.yaml"
rm -f "$SDOFF/action-rules.off"; off4="$(chk "TALOS_ACTION_RULES_OFF=1")"
{ [ "$off1" = "{}|0" ] && [ "$off2" = "{}|0" ] && [ "$off3" = "{}|0" ] && [ "$off4" = "{}|0" ]; } && ok || no "guards off: an unreadable file changed the answer (want {}|0 each time)" "$off1 $off2 $off3 $off4"
[ -z "$(ULOG)" ] && ok || no "guards off: an unreadable file was logged" "$(ULOG)"
rm -f "$UFILE"
rm -f "$XDG_STATE_HOME"/talos/*/action-rules-unreadable.jsonl
# ONE notice to the owner's thread through the Talos app's hub (the way the hook already reaches it), the first time a bad file makes
# the hook ask or deny; once per file and content, no command text, not at all with no app
echo "action-rules: one notice to the owner per unreadable file and content"
rm -f "$XDG_STATE_HOME"/talos/*/action-rules-notified.json
hub 1
APPENV="TALOS_APP_HOME=$TH"
nn(){ grep -c '"rule_notice"' "$TH/got.jsonl" 2>/dev/null || true; }
printf 'rules:\n  this is not a rule\n' > "$UFILE"
chk "$APPENV" >/dev/null
[ "$(nn)" = 1 ] && ok || no "the first bad call did not send exactly one notice" "$(cat "$TH/got.jsonl")"
python3 - "$TH/got.jsonl" <<'PY' && ok || no "the notice has the wrong shape (file, line, content hash, unattended; no command text)"
import json, re, sys
m = [json.loads(l) for l in open(sys.argv[1]) if '"rule_notice"' in l][-1]
assert m["file"] == "user" and m["line"] == 2 and re.fullmatch(r"[0-9a-f]{64}", m["hash"]) and m["unattended"] is False, m
assert set(m) <= {"t", "id", "pid", "file", "line", "hash", "unattended"} and "npm publish" not in json.dumps(m), m
PY
chk "$APPENV" >/dev/null; chk "CHRONOS_RUN=1 $APPENV" >/dev/null
[ "$(nn)" = 1 ] && ok || no "the same file, asked again (live and unattended), sent another notice" "$(nn)"
printf 'rules:\n  still not a rule\n' > "$UFILE"
chk "$APPENV" >/dev/null
[ "$(nn)" = 2 ] && ok || no "a changed file did not send a new notice" "$(nn)"
chk "CHRONOS_RUN=1 $APPENV" >/dev/null
[ "$(nn)" = 2 ] && ok || no "an unattended call after the change sent a second notice for the same content" "$(nn)"
rm -f "$UFILE"; rm -f "$A/hooks/action-rules.yaml"
chk "$APPENV" >/dev/null
tail -1 "$TH/got.jsonl" | grep -q '"file": "shipped"' && [ "$(nn)" = 3 ] && ok || no "a missing shipped file did not send its own notice" "$(tail -1 "$TH/got.jsonl")"
cp "$SB/shipped.keep" "$A/hooks/action-rules.yaml"
# a bridge that is slow to take the notice does not bring the timeout's own verdict after the real one (one verdict on stdout)
echo stall > "$TH/mode"
printf 'rules:\n  a slow bridge file\n' > "$UFILE"
out="$(printf '%s' "$CALLJ" | ( cd "$A" && env $APPENV TALOS_GUARD_TIMEOUT_S=1 python3 "$SB/acct.py" "$HOME" check 2>/dev/null ))"
[ "$(printf '%s\n' "$out" | grep -c permissionDecision)" = 1 ] && grep -q 'cannot read its rules' <<<"$out" && ok || no "a slow bridge made the hook print a second verdict (the timeout's)" "$out"
echo allow > "$TH/mode"
# a stalled state folder (the notice's state file is a pipe nobody writes: opening it never returns) ends the hook inside its short
# notice budget with exit 0 and exactly one verdict: never a hang past Claude Code's own hook timeout, never a second answer
printf 'rules:\n  a stalled state file\n' > "$UFILE"
rm -f "$SDOFF/action-rules-notified.json"; mkfifo "$SDOFF/action-rules-notified.json"
t0=$SECONDS
out="$( cd "$A" && printf '%s' "$CALLJ" | perl -e '$t=shift; $p=fork; if(!$p){setpgrp(0,0); exec @ARGV} $SIG{ALRM}=sub{kill "TERM",-$p; sleep 5; kill "KILL",-$p; exit 142}; alarm $t; waitpid($p,0); exit($? & 127 ? 128+($? & 127) : $? >> 8)' 20 env $APPENV TALOS_GUARD_TIMEOUT_S=2 python3 "$SB/acct.py" "$HOME" check 2>/dev/null )"; rc=$?
took=$((SECONDS - t0))
{ [ "$rc" = 0 ] && [ "$took" -le 5 ] && [ "$(printf '%s\n' "$out" | grep -c permissionDecision)" = 1 ] && grep -q 'cannot read its rules' <<<"$out"; } && ok || no "a stalled state folder: want exit 0 within the budget and one verdict (rc=$rc, ${took}s)" "$out"
rm -f "$SDOFF/action-rules-notified.json"
# the same when the LOG write hangs (the log file is a pipe nobody reads: opening it never returns): after the verdict the main timeout
# must not write a second one, for an unreadable file and for the timeout's own log: exit 0 within the budget, exactly one verdict
lim(){ perl -e '$t=shift; $p=fork; if(!$p){setpgrp(0,0); exec @ARGV} $SIG{ALRM}=sub{kill "TERM",-$p; sleep 5; kill "KILL",-$p; exit 142}; alarm $t; waitpid($p,0); exit($? & 127 ? 128+($? & 127) : $? >> 8)' 20 "$@"; }
printf 'rules:\n  a hanging log\n' > "$UFILE"
rm -f "$SDOFF/action-rules-unreadable.jsonl"; mkfifo "$SDOFF/action-rules-unreadable.jsonl"
out="$( cd "$A" && printf '%s' "$CALLJ" | lim env TALOS_GUARD_TIMEOUT_S=2 python3 "$SB/acct.py" "$HOME" check 2>/dev/null )"; rc=$?
{ [ "$rc" = 0 ] && [ "$(printf '%s\n' "$out" | grep -c permissionDecision)" = 1 ] && grep -q 'cannot read its rules' <<<"$out"; } && ok || no "a hanging unreadable-log write: want exit 0 and one verdict (rc=$rc)" "$out"
rm -f "$SDOFF/action-rules-unreadable.jsonl" "$UFILE"
rm -f "$SDOFF/guard-timeouts.jsonl"; mkfifo "$SDOFF/guard-timeouts.jsonl"
out="$( cd "$A" && sleep 4 | lim env TALOS_GUARD_TIMEOUT_S=1 python3 "$SB/acct.py" "$HOME" check 2>/dev/null )"; rc=$?
{ [ "$rc" = 0 ] && [ "$(printf '%s\n' "$out" | grep -c permissionDecision)" = 1 ] && grep -q 'timed out checking' <<<"$out"; } && ok || no "a hanging timeout-log write: want exit 0 and one verdict (rc=$rc)" "$out"
rm -f "$SDOFF/guard-timeouts.jsonl"
# the bridge not reachable: the answer is the same and the notice is kept for later (not marked as sent)
unhub
printf 'rules:\n  a third bad file\n' > "$UFILE"
out="$(chk "$APPENV")"; [ "$(verdict "${out%|*}")" = ask ] && ok || no "with no bridge the unreadable file did not ask" "$out"
python3 - "$XDG_STATE_HOME" <<'PY' && ok || no "an unsent notice was marked as sent"
import glob, json, sys
d = json.load(open(glob.glob(sys.argv[1] + "/talos/*/action-rules-notified.json")[0]))
assert d["user"]["sent"] is False, d
PY
# no app on the machine: nothing to tell, and the prompt itself reaches the owner
rm -f "$XDG_STATE_HOME"/talos/*/action-rules-notified.json
chk "" >/dev/null; ls "$XDG_STATE_HOME"/talos/*/action-rules-notified.json >/dev/null 2>&1 && no "a notice state was written with no Talos app" || ok
rm -f "$UFILE"
rm -f "$XDG_STATE_HOME"/talos/*/action-rules-unreadable.jsonl "$XDG_STATE_HOME"/talos/*/action-rules-notified.json
# one pass in file order: an earlier ask beats a later allow (a starter allow, or one of your own); your allow before a never carves out
printf 'rules:\n  - id: my-ask-reply\n    decision: ask\n    tool: "mcp__talos-app__reply"\n' > "$XDG_CONFIG_HOME/talos/action-rules.yaml"
expect ask   "a user ask on the app's own reply still asks (the starter allow comes later)" "$(run mcp__talos-app__reply /tmp x)"
printf 'rules:\n  - id: my-ask-x\n    decision: ask\n    tool: Bash\n    command: "echo hi"\n  - id: my-allow-x\n    decision: allow\n    tool: Bash\n    command: "echo hi"\n' > "$XDG_CONFIG_HOME/talos/action-rules.yaml"
expect ask   "a user ask beats a later user allow" "$(run Bash /tmp 'echo hi')"
printf 'rules:\n  - id: my-allow-rm\n    decision: allow\n    tool: Bash\n    command: "rm -rf ~$"\n' > "$XDG_CONFIG_HOME/talos/action-rules.yaml"
expect allow "your allow listed before a never still carves it out" "$(run Bash /tmp 'rm -rf ~')"
rm -f "$XDG_CONFIG_HOME/talos/action-rules.yaml"
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
