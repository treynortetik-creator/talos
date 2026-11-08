#!/usr/bin/env bash
# test-permission-relay.sh -- hooks/permission-relay.py (PermissionRequest): puts a prompt the channel relay does not carry on the phone.
#
# The hook is run as a child process, the way Claude Code runs it (JSON on stdin, decision JSON on stdout), against a FAKE hub
# socket written below that records the line it receives and answers as each test says. The real bridge end to end is
# apps/bridge/test/permission-hook.test.ts. Everything runs under a throwaway HOME; nothing touches a real Talos home.
#
# The rule under test: the hook prints a decision ONLY when the hub answers, for the same request id, exactly "allow" or "deny".
# Anything else (no hub, a refusal, a slow hub, a garbled or newer answer, an input it will not send) prints nothing, exits 0.
export PYTHONDONTWRITEBYTECODE=1
set -uo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

SB="$(mktemp -d)" || exit 2
SB="$(cd "$SB" && pwd -P)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
HUBPID=""
cleanup(){ [ -n "$HUBPID" ] && kill "$HUBPID" 2>/dev/null; rm -rf "$SB"; }
trap cleanup EXIT
export HOME="$SB/home"; mkdir -p "$HOME"
unset CLAUDE_PID CLAUDE_CODE_SESSION_ATTENDED TALOS_APP_PERM_HOOK_SOURCE TALOS_APP_WORKER_THREAD TALOS_APP_WORKER_NONCE TALOS_PERMISSION_HOOK_WAIT_S TALOS_PERMISSION_RELAY_OFF
export XDG_STATE_HOME="$SB/state" XDG_CONFIG_HOME="$SB/cfg"
HOOK="$KIT/hooks/permission-relay.py"
TH="$SB/th"; mkdir -p "$TH"                    # TALOS_APP_HOME (the hook chdirs into it: a long path is fine)

# ---- a fake hub: one connection, records the first line, answers per MODE ---------------------------------------------------
cat > "$SB/fakehub.py" <<'PY'
import json, os, socket, sys, time
home, mode, rec = sys.argv[1], sys.argv[2], sys.argv[3]
os.chdir(home)
try: os.unlink("hub.sock")
except OSError: pass
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.bind("hub.sock"); s.listen(4)
open(rec + ".ready", "w").write("1")
c, _ = s.accept()
buf = b""
while b"\n" not in buf:
    d = c.recv(65536)
    if not d: sys.exit(0)
    buf += d
line = buf.split(b"\n", 1)[0]
open(rec, "wb").write(line)
req = json.loads(line)
def send(o): c.sendall((json.dumps(o) + "\n").encode())
rid = req.get("id")
if mode == "allow": send({"t": "perm_result", "id": rid, "decision": "allow"})
elif mode == "deny": send({"t": "perm_result", "id": rid, "decision": "deny", "reason": "owner"})
elif mode == "none": send({"t": "perm_result", "id": rid, "decision": "none", "reason": "relay_off"})
elif mode == "wrongid": send({"t": "perm_result", "id": "someone-else", "decision": "allow"})
elif mode == "noid": send({"t": "perm_result", "decision": "allow"})
elif mode == "wrongtype": send({"t": "ack", "id": rid, "decision": "allow"})
elif mode == "upper": send({"t": "perm_result", "id": rid, "decision": "ALLOW"})
elif mode == "padded": send({"t": "perm_result", "id": rid, "decision": "allow "})
elif mode == "bool": send({"t": "perm_result", "id": rid, "decision": True})
elif mode == "newer": send({"t": "perm_result", "id": rid, "decision": "allow_always", "extra": 1})
elif mode == "refused": send({"t": "refused", "code": "bad_frame", "message": "no"})
elif mode == "garbage": c.sendall(b"not json at all\n")
elif mode == "partial": c.sendall(b'{"t":"perm_result","id":"' + rid.encode() + b'","decision":"allow"')  # no newline, then hang up
elif mode == "hangup": pass
elif mode == "slow": time.sleep(float(os.environ.get("SLOW_S", "5"))); send({"t": "perm_result", "id": rid, "decision": "allow"})
elif mode == "extra-then-allow": send({"t": "perm_result", "id": rid, "decision": "none"}); send({"t": "perm_result", "id": rid, "decision": "allow"})
time.sleep(0.2)
PY

start_hub(){ # $1 = mode, $2 = record file; waits until the socket is bound
  rm -f "$2" "$2.ready"; python3 "$SB/fakehub.py" "$TH" "$1" "$2" & HUBPID=$!
  for _ in $(seq 1 100); do [ -e "$2.ready" ] && break; sleep 0.05; done
  [ -e "$2.ready" ] || { echo "fake hub did not start" >&2; return 1; }
  printf '{"pid": %s, "instance": "x"}' "$HUBPID" > "$TH/bridge.pid"       # the pid the hook expects at the other end (the fake plays the live bridge)
}
CALL='{"session_id":"abc","cwd":"/srv/proj","permission_mode":"bypassPermissions","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"rm -rf /srv/proj/build","description":"remove it"},"permission_suggestions":[]}'
run_hook(){ # stdin = $1; env as set; sets OUT, ERR, RC
  OUT="$(printf '%s' "$1" | TALOS_APP_HOME="$TH" python3 "$HOOK" 2>"$SB/err")"; RC=$?; ERR="$(cat "$SB/err")"
}
decision_of(){ python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(d["hookSpecificOutput"]["hookEventName"], d["hookSpecificOutput"]["decision"]["behavior"])' "$1" 2>/dev/null; }

# ---- the two decisions, and what the hook sends ----------------------------------------------------------------------------
start_hub allow "$SB/rec1"; run_hook "$CALL"; wait "$HUBPID" 2>/dev/null; HUBPID=""
{ [ "$RC" = 0 ] && [ "$(decision_of "$OUT")" = "PermissionRequest allow" ] && [ -z "$ERR" ]; } && ok "allow from the hub becomes {hookSpecificOutput:{hookEventName:PermissionRequest,decision:{behavior:allow}}}, exit 0, nothing on stderr" || no "allow output wrong" "rc=$RC out=$OUT err=$ERR"
python3 - "$SB/rec1" <<'PY' && ok "the request carries the exact tool name and tool input, the asking pid and cwd, and no thread proof in the main session" || no "request line wrong: $(cat "$SB/rec1")"
import json, sys
r = json.loads(open(sys.argv[1]).read())
assert r["t"] == "perm" and r["tool_name"] == "Bash" and r["tool_input"] == {"command": "rm -rf /srv/proj/build", "description": "remove it"}, r
assert r["session_id"] == "abc" and r["id"].startswith("h_") and len(r["id"]) >= 20, r
assert not ({"thread_id", "nonce"} & set(r)), r
assert isinstance(r["pid"], int) and r["pid"] > 0 and r["cwd"] == "/srv/proj", r        # who asked, for the card
PY
start_hub deny "$SB/rec2"; run_hook "$CALL"; wait "$HUBPID" 2>/dev/null; HUBPID=""
{ [ "$RC" = 0 ] && [ "$(decision_of "$OUT")" = "PermissionRequest deny" ] && <<<"$OUT" grep -q '"message"'; } && ok "deny from the hub becomes a deny decision with a reason for Claude" || no "deny output wrong" "$OUT"

# ---- it can NEVER decide without the hub's exact answer ---------------------------------------------------------------------
for mode in none wrongid noid wrongtype upper padded bool newer refused garbage partial hangup extra-then-allow; do
  start_hub "$mode" "$SB/rec-$mode"; run_hook "$CALL"; wait "$HUBPID" 2>/dev/null; HUBPID=""
  if [ "$mode" = extra-then-allow ]; then want_empty=1; else want_empty=1; fi
  { [ "$RC" = 0 ] && [ -z "$OUT" ] && [ -z "$ERR" ]; } && ok "hub answer '$mode': no output, exit 0 (the prompt stays at the Mac)" || no "hub answer '$mode' produced output or an error" "rc=$RC out=$OUT err=$ERR"
done

# ---- unreachable bridge ----------------------------------------------------------------------------------------------------
rm -f "$TH/hub.sock"
run_hook "$CALL"; { [ "$RC" = 0 ] && [ -z "$OUT" ] && [ -z "$ERR" ]; } && ok "no socket: no output, exit 0, no traceback" || no "no-socket case wrong" "rc=$RC out=$OUT err=$ERR"
: > "$TH/hub.sock"; run_hook "$CALL"; { [ "$RC" = 0 ] && [ -z "$OUT" ] && [ -z "$ERR" ]; } && ok "a hub.sock that is a plain file (dead bridge): no output, exit 0" || no "dead-socket case wrong" "rc=$RC out=$OUT err=$ERR"
rm -f "$TH/hub.sock"
OUT="$(printf '%s' "$CALL" | TALOS_APP_HOME="$SB/does-not-exist" python3 "$HOOK" 2>"$SB/err")"; RC=$?
{ [ "$RC" = 0 ] && [ -z "$OUT" ] && [ ! -s "$SB/err" ]; } && ok "a Talos home that does not exist: no output, exit 0" || no "missing home case wrong" "rc=$RC out=$OUT"
OUT="$(printf '%s' "$CALL" | env -u TALOS_APP_HOME HOME="$SB/empty-home" python3 "$HOOK" 2>"$SB/err")"; RC=$?
{ [ "$RC" = 0 ] && [ -z "$OUT" ] && [ ! -s "$SB/err" ]; } && ok "a fresh home with no Talos folder (default ~/.config/talos/app): no output, exit 0" || no "fresh-home case wrong" "rc=$RC out=$OUT"

# ---- time: a slow hub, and the wait can only be shortened ------------------------------------------------------------------
start_hub slow "$SB/rec-slow"
t0=$(python3 -c 'import time; print(time.monotonic())')
OUT="$(printf '%s' "$CALL" | SLOW_S=6 TALOS_PERMISSION_HOOK_WAIT_S=0.7 TALOS_APP_HOME="$TH" python3 "$HOOK" 2>"$SB/err")"; RC=$?
t1=$(python3 -c 'import time; print(time.monotonic())')
python3 - "$t0" "$t1" <<'PY' && [ "$RC" = 0 ] && [ -z "$OUT" ] && ok "a hub slower than the wait: the hook gives up on time with no output (waited ~0.7 s, not 6)" || no "slow hub case wrong" "rc=$RC out=$OUT"
import sys
d = float(sys.argv[2]) - float(sys.argv[1]); assert 0.5 < d < 3.0, d
PY
kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; HUBPID=""
python3 - "$KIT/hooks" <<'PY' && ok "the wait is capped just under the registered 3600 s timeout (Claude Code ends the hook sooner), and TALOS_PERMISSION_HOOK_WAIT_S can only shorten it" || no "wait cap wrong"
import os, sys
sys.path.insert(0, sys.argv[1])
import importlib.util
spec = importlib.util.spec_from_file_location("pr", sys.argv[1] + "/permission-relay.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
assert m.WAIT_S == 3590.0 and m.WAIT_S < 3600
os.environ.pop("TALOS_PERMISSION_HOOK_WAIT_S", None); assert m.wait_seconds() == 3590.0
for v, want in (("99999", 3590.0), ("1e9", 3590.0), ("30", 30.0), ("0", 0.05), ("-4", 0.05), ("abc", 3590.0), ("", 3590.0), ("nan", 3590.0)):
    os.environ["TALOS_PERMISSION_HOOK_WAIT_S"] = v
    got = m.wait_seconds()
    assert got == got and abs(got - want) < 1e-9, (v, got, want)
PY
grep -q 'time\.time()' "$HOOK" && no "the hook reads the wall clock (time.time): a clock change or sleep would stretch the wait" || ok "the deadline runs on the monotonic clock only (no time.time in the hook)"
start_hub slow "$SB/rec-jump"
OUT="$(printf '%s' "$CALL" | SLOW_S=6 TALOS_PERMISSION_HOOK_WAIT_S=0.8 TALOS_APP_HOME="$TH" python3 - "$HOOK" 2>"$SB/err" <<'PY'
import runpy, sys, time
real = time.time
time.time = lambda: real() + 86400 * 400      # the wall clock jumps more than a year ahead
sys.argv = [sys.argv[1]]
runpy.run_path(sys.argv[0], run_name="__main__")
PY
)"; RC=$?
{ [ -z "$OUT" ]; } && ok "the wall clock jumping a year ahead changes nothing: still no output from a slow hub" || no "clock jump case wrong" "$OUT"
kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; HUBPID=""

# ---- bad input from Claude Code: nothing is sent, nothing is printed -------------------------------------------------------
for bad in '' 'not json' '[]' '{}' '{"tool_name":""}' '{"tool_name":5}' '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{}}' \
           '{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":"rm -rf /"}' '{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":[1]}'; do
  start_hub allow "$SB/rec-bad"; run_hook "$bad"; sleep 0.15
  kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; HUBPID=""
  { [ "$RC" = 0 ] && [ -z "$OUT" ] && [ -z "$ERR" ] && [ ! -e "$SB/rec-bad" ]; } && ok "bad input '${bad:0:50}': no request sent, no output, exit 0" || no "bad input '$bad' leaked" "rc=$RC out=$OUT rec=$(cat "$SB/rec-bad" 2>/dev/null)"
done

# ---- hostile text is sent byte for byte, never altered -----------------------------------------------------------------------
HOSTILE='{"hook_event_name":"PermissionRequest","tool_name":"mcp__x__‮evil","tool_input":{"command":"echo ‮~ fr- mr\nrm -rf \"$HOME\" # \u0000 😀","n":null}}'
start_hub deny "$SB/rec-h"; run_hook "$HOSTILE"; wait "$HUBPID" 2>/dev/null; HUBPID=""
python3 - "$SB/rec-h" <<'PY' && ok "hostile text (bidi override, NUL, newline, quotes, emoji, null) reaches the hub unchanged" || no "hostile text was altered"
import json, sys
r = json.loads(open(sys.argv[1]).read())
assert r["tool_name"] == "mcp__x__‮evil", r["tool_name"]
assert r["tool_input"]["command"] == "echo ‮~ fr- mr\nrm -rf \"$HOME\" # \u0000 \U0001F600" and r["tool_input"]["n"] is None, r
PY

# ---- size: an input the hub would drop is never sent -------------------------------------------------------------------------
BIG="$(python3 -c 'import json; print(json.dumps({"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"echo "+"y"*300000}}))')"
[ "${#BIG}" -gt 300000 ] || no "the oversize fixture was not built (a broken fixture would pass the check below for the wrong reason)"
start_hub allow "$SB/rec-big"; run_hook "$BIG"; sleep 0.2; kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; HUBPID=""
{ [ "$RC" = 0 ] && [ -z "$OUT" ] && [ ! -e "$SB/rec-big" ]; } && ok "an input over 250 KB is not sent (no card could show it whole): no output, exit 0" || no "oversize input was sent" "rc=$RC"

# ---- thread session: its own proof, from its own environment ------------------------------------------------------------------
start_hub deny "$SB/rec-w"
OUT="$(printf '%s' "$CALL" | TALOS_APP_HOME="$TH" TALOS_APP_PERM_HOOK_SOURCE=worker TALOS_APP_WORKER_THREAD=trip TALOS_APP_WORKER_NONCE=abcdef0123456789abcdef CLAUDE_PID=4242 python3 "$HOOK" 2>"$SB/err")"; RC=$?
wait "$HUBPID" 2>/dev/null; HUBPID=""
python3 - "$SB/rec-w" <<'PY' && ok "in a thread session the request names the thread, its nonce and the Claude Code pid (CLAUDE_PID)" || no "worker request wrong: $(cat "$SB/rec-w")"
import json, sys
r = json.loads(open(sys.argv[1]).read())
assert r["thread_id"] == "trip" and r["nonce"] == "abcdef0123456789abcdef" and r["pid"] == 4242, r
PY
start_hub deny "$SB/rec-w2"
OUT="$(printf '%s' "$CALL" | TALOS_APP_HOME="$TH" TALOS_APP_PERM_HOOK_SOURCE=worker TALOS_APP_WORKER_THREAD=trip TALOS_APP_WORKER_NONCE=abcdef0123456789abcdef CLAUDE_PID=notanumber python3 "$HOOK" 2>"$SB/err")"
wait "$HUBPID" 2>/dev/null; HUBPID=""
python3 - "$SB/rec-w2" <<'PY' && ok "without a usable CLAUDE_PID the hook falls back to its parent process id" || no "pid fallback wrong"
import json, os, sys
r = json.loads(open(sys.argv[1]).read())
assert isinstance(r["pid"], int) and r["pid"] > 0, r
PY
start_hub deny "$SB/rec-w3"
OUT="$(printf '%s' "$CALL" | TALOS_APP_HOME="$TH" TALOS_APP_PERM_HOOK_SOURCE=worker TALOS_APP_WORKER_THREAD=trip python3 "$HOOK" 2>"$SB/err")"; RC=$?
sleep 0.15; kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; HUBPID=""
{ [ "$RC" = 0 ] && [ -z "$OUT" ] && [ ! -e "$SB/rec-w3" ]; } && ok "a thread session with no nonce sends nothing (it cannot prove itself) and prints nothing" || no "nonce-less worker sent a request"

# ---- who is on the other end of hub.sock: only the live bridge ever sees the tool input -----------------------------------------
start_hub allow "$SB/rec-fake"; printf '{"pid": 1, "instance": "x"}' > "$TH/bridge.pid"       # the pidfile names another process: the listener is a stand-in
run_hook "$CALL"; sleep 0.15; kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; HUBPID=""
{ [ "$RC" = 0 ] && [ -z "$OUT" ] && [ ! -e "$SB/rec-fake" ]; } && ok "a listener that is not the bridge in bridge.pid: never sent the tool input, no output (a fake hub cannot hand back an allow)" || no "stand-in listener got the request or an answer" "out=$OUT rec=$(cat "$SB/rec-fake" 2>/dev/null)"
start_hub allow "$SB/rec-nopid"; rm -f "$TH/bridge.pid"
run_hook "$CALL"; sleep 0.15; kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; HUBPID=""
{ [ "$RC" = 0 ] && [ -z "$OUT" ] && [ ! -e "$SB/rec-nopid" ]; } && ok "no bridge.pid: nothing sent, no output" || no "no-pidfile case wrong" "out=$OUT"
start_hub allow "$SB/rec-badpid"; printf 'not json' > "$TH/bridge.pid"
run_hook "$CALL"; sleep 0.15; kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; HUBPID=""
{ [ "$RC" = 0 ] && [ -z "$OUT" ] && [ ! -e "$SB/rec-badpid" ]; } && ok "a garbled bridge.pid: nothing sent, no output" || no "garbled pidfile case wrong" "out=$OUT"

# ---- unattended runs and the double registration ----------------------------------------------------------------------------------
start_hub allow "$SB/rec-hl"
OUT="$(printf '%s' "$CALL" | CLAUDE_CODE_SESSION_ATTENDED=0 TALOS_APP_HOME="$TH" python3 "$HOOK" 2>&1)"; sleep 0.15
kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; HUBPID=""
{ [ -z "$OUT" ] && [ ! -e "$SB/rec-hl" ]; } && ok "an unattended claude -p run (CLAUDE_CODE_SESSION_ATTENDED=0): silent, nothing sent, so a headless ask stays refused" || no "headless run raised a card" "$OUT"
start_hub allow "$SB/rec-dup"
OUT="$(printf '%s' "$CALL" | TALOS_APP_WORKER_THREAD=trip TALOS_APP_WORKER_NONCE=abcdef0123456789abcdef TALOS_APP_HOME="$TH" python3 "$HOOK" 2>&1)"; sleep 0.15
kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; HUBPID=""
{ [ -z "$OUT" ] && [ ! -e "$SB/rec-dup" ]; } && ok "in a thread session the agent folder's copy (no TALOS_APP_PERM_HOOK_SOURCE=worker) stays silent: one hook, one card" || no "the project copy ran in a worker" "$OUT"

# ---- a killed wrapper must not leave the hook (and its card) alive -----------------------------------------------------------------
SLOW_S=60 start_hub slow "$SB/rec-orph"
sh -c "TALOS_APP_HOME='$TH' python3 '$HOOK' < '$SB/call.json' >/dev/null 2>&1 & echo \$! > '$SB/orphan.pid'; wait" &
SHPID=$!
printf '%s' "$CALL" > "$SB/call.json"
for _ in $(seq 1 40); do [ -s "$SB/orphan.pid" ] && [ -e "$SB/rec-orph" ] && break; sleep 0.1; done
OPID="$(cat "$SB/orphan.pid" 2>/dev/null)"
kill -9 "$SHPID" 2>/dev/null; wait "$SHPID" 2>/dev/null
for _ in $(seq 1 50); do kill -0 "$OPID" 2>/dev/null || break; sleep 0.1; done
{ [ -n "$OPID" ] && ! kill -0 "$OPID" 2>/dev/null; } && ok "the process that started the hook dies: the hook notices within seconds and exits (no orphan holding the card)" || no "the hook outlived its killed parent (pid $OPID)"
kill "$OPID" 2>/dev/null; kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; HUBPID=""

# ---- the prompt ends without the hook being killed (Claude Code's own countdown blocks the call): the transcript says so -------------------------
TP="$SB/transcript.jsonl"
python3 - "$TP" <<'PY'
import json, sys
open(sys.argv[1], "w").write(json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [
    {"type": "tool_use", "id": "toolu_OTHER", "name": "Bash", "input": {"command": "ls"}},
    {"type": "tool_use", "id": "toolu_MINE", "name": "Bash", "input": {"command": "rm -rf /srv/proj/build", "description": "remove it"}}]}}) + "\n")
PY
CALLT="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d["transcript_path"]=sys.argv[2]; print(json.dumps(d))' "$CALL" "$TP")"
append_result(){ python3 - "$TP" "$1" <<'PY'
import json, sys
open(sys.argv[1], "a").write(json.dumps({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": sys.argv[2], "content": "denied"}]}}) + "\n")
PY
}
hook_pid_after(){ # $1 = id of the tool_result to append after 1.5 s; prints "gone" or "alive" 4 s later
  SLOW_S=60 start_hub slow "$SB/rec-tr"
  printf '%s' "$CALLT" | TALOS_APP_HOME="$TH" python3 "$HOOK" >"$SB/tr.out" 2>&1 & TRPID=$!
  sleep 1.5; append_result "$1"; sleep 4
  if kill -0 "$TRPID" 2>/dev/null; then echo alive; else echo gone; fi
  kill "$TRPID" 2>/dev/null; wait "$TRPID" 2>/dev/null; kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; HUBPID=""
}
[ "$(hook_pid_after toolu_MINE)" = gone ] && [ ! -s "$SB/tr.out" ] && ok "the tool_result of THIS call appears in the transcript: the hook ends with no output (the card closes behind it)" || no "the hook ignored the end of its own prompt"
[ "$(hook_pid_after toolu_OTHER)" = alive ] && ok "the tool_result of ANOTHER call (a parallel prompt) does not end it" || no "the hook gave up on another call's result"
# two identical calls at once: whose result is whose cannot be told, so no early exit, in either transcript shape
write_two(){ python3 - "$TP" "$1" <<'PY'
import json, sys
tp, shape = sys.argv[1], sys.argv[2]
a = {"type": "tool_use", "id": "toolu_A", "name": "Bash", "input": {"command": "rm -rf /srv/proj/build", "description": "remove it"}}
b = dict(a, id="toolu_B")
mk = lambda blocks: json.dumps({"type": "assistant", "message": {"role": "assistant", "content": blocks}}) + "\n"
open(tp, "w").write(mk([a, b]) if shape == "one-entry" else mk([a]) + mk([b]))
PY
}
for shape in one-entry two-entries; do
  write_two "$shape"
  [ "$(hook_pid_after toolu_A)" = alive ] && ok "two identical calls ($shape): a result for one does not end the hook (it cannot tell whose it is)" || no "the hook ended on an ambiguous result ($shape)"
done
# the second identical call shows up AFTER the hook started watching: it turns the watcher off from then on
python3 - "$TP" <<'PY'
import json, sys
a = {"type": "tool_use", "id": "toolu_A", "name": "Bash", "input": {"command": "rm -rf /srv/proj/build", "description": "remove it"}}
open(sys.argv[1], "w").write(json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [a]}}) + "\n")
PY
SLOW_S=60 start_hub slow "$SB/rec-late"
printf '%s' "$CALLT" | TALOS_APP_HOME="$TH" python3 "$HOOK" >"$SB/late.out" 2>&1 & LPID=$!
sleep 2.5
python3 - "$TP" <<'PY'
import json, sys
b = {"type": "tool_use", "id": "toolu_B", "name": "Bash", "input": {"command": "rm -rf /srv/proj/build", "description": "remove it"}}
open(sys.argv[1], "a").write(json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [b]}}) + "\n")
PY
sleep 1.5; append_result toolu_A; sleep 3
if kill -0 "$LPID" 2>/dev/null; then ok "a second identical call that appears later also turns the watcher off"; else no "the hook ended although a second identical call appeared"; fi
kill "$LPID" 2>/dev/null; wait "$LPID" 2>/dev/null; kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; HUBPID=""
unset TP

# ---- kill switches ---------------------------------------------------------------------------------------------------------------
start_hub allow "$SB/rec-k"; OUT="$(printf '%s' "$CALL" | TALOS_PERMISSION_RELAY_OFF=1 TALOS_APP_HOME="$TH" python3 "$HOOK" 2>&1)"
sleep 0.15; kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; HUBPID=""
{ [ -z "$OUT" ] && [ ! -e "$SB/rec-k" ]; } && ok "TALOS_PERMISSION_RELAY_OFF=1 turns it off: nothing sent, nothing printed" || no "env kill switch ignored" "$OUT"

# ---- registration: the settings template, through the shell wrapper Claude Code runs -----------------------------------------------
python3 - "$KIT/templates/dot-claude/settings.json" <<'PY' && ok "the settings template registers the hook on PermissionRequest, for every tool, with a long timeout (3600 s) above the hook's own wait" || no "template registration wrong"
import json, sys
t = json.load(open(sys.argv[1]))
es = t["hooks"]["PermissionRequest"]
hs = [h for e in es for h in e["hooks"] if "permission-relay.py" in h["command"]]
assert len(hs) == 1 and hs[0]["type"] == "command" and hs[0]["timeout"] == 3600, hs
assert all("matcher" not in e for e in es), "a matcher would leave some tools out"
assert hs[0]["command"].rstrip().endswith('exec python3 "$f"'), "exec: Claude Code's signal must reach the hook, not a shell around it"
PY
CMD="$(python3 -c 'import json,sys; t=json.load(open(sys.argv[1])); print(t["hooks"]["PermissionRequest"][0]["hooks"][0]["command"])' "$KIT/templates/dot-claude/settings.json")"
AG="$SB/agent"; mkdir -p "$AG/hooks"; cp "$KIT"/hooks/*.py "$AG/hooks/"
start_hub allow "$SB/rec-sh"
OUT="$(printf '%s' "$CALL" | CLAUDE_PROJECT_DIR="$AG" TALOS_APP_HOME="$TH" sh -c "$CMD" 2>"$SB/err")"; RC=$?
wait "$HUBPID" 2>/dev/null; HUBPID=""
{ [ "$RC" = 0 ] && [ "$(decision_of "$OUT")" = "PermissionRequest allow" ]; } && ok "the registered command, run through sh the way Claude Code runs it, returns the decision" || no "registered command wrong" "rc=$RC out=$OUT"
OUT="$(printf '%s' "$CALL" | CLAUDE_PROJECT_DIR="$SB/no-such-agent" TALOS_APP_HOME="$TH" sh -c "$CMD" 2>&1)"; RC=$?
{ [ "$RC" = 0 ] && [ -z "$OUT" ]; } && ok "the registered command with the script missing: exit 0, no output (the settings never wedge a session)" || no "missing-script case wrong" "rc=$RC out=$OUT"

# an existing settings.json from before this hook: settings-merge adds it and touches nothing else
MA="$SB/merge"; mkdir -p "$MA/.claude" "$MA/templates/dot-claude" "$MA/hooks" "$MA/scripts"
cp "$KIT/templates/dot-claude/settings.json" "$MA/templates/dot-claude/settings.json"; cp "$KIT/scripts/settings-merge.py" "$MA/scripts/"; cp "$KIT"/hooks/*.py "$MA/hooks/"
python3 - "$MA" <<'PY'
import json, sys
t = json.load(open(sys.argv[1] + "/templates/dot-claude/settings.json"))
del t["hooks"]["PermissionRequest"]
t["permissions"]["allow"] = ["Bash(git status:*)"]
json.dump(t, open(sys.argv[1] + "/.claude/settings.json", "w"), indent=2)
PY
out="$(cd "$MA" && python3 scripts/settings-merge.py --apply 2>&1)"
python3 - "$MA" <<'PY' && <<<"$out" grep -q 'adding permission-relay.py on PermissionRequest' && ok "settings-merge adds the PermissionRequest registration to an older settings.json and keeps the owner's permissions" || no "settings-merge did not add the hook" "$out"
import json, sys
n = json.load(open(sys.argv[1] + "/.claude/settings.json"))
assert n["permissions"]["allow"] == ["Bash(git status:*)"]
assert "permission-relay.py" in n["hooks"]["PermissionRequest"][0]["hooks"][0]["command"] and n["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"] == 3600
PY

echo "  permission-relay: PASS $PASS FAIL $FAIL"
[ "$FAIL" -eq 0 ]
