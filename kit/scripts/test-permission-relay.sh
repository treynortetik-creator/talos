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
. "$KIT/scripts/_test-env.sh"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }
# A loaded machine (the gate sets TALOS_TEST_TIME_FACTOR=3) runs the hook slowly: every deadline below scales with the factor and
# ends as soon as its condition holds. poll SECONDS COMMAND...: runs COMMAND every 0.05 s until it succeeds or the deadline passes.
scale(){ awk -v a="$1" -v f="${TALOS_TEST_TIME_FACTOR:-1}" 'BEGIN { f += 0; if (!(f >= 1) || f == f + 1) f = 1; printf "%g", a * f }'; }
poll(){ local i n; n="$(scale $(( $1 * 20 )))"; shift; for (( i = 0; i < ${n%%.*}; i++ )); do "$@" && return 0; sleep 0.05; done; return 1; }
has(){ [ -s "$1" ]; }
gone(){ ! kill -0 "$1" 2>/dev/null; }

SB="$(mktemp -d)" || exit 2
SB="$(cd "$SB" && pwd -P)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
HUBPID=""
cleanup(){ [ -n "$HUBPID" ] && kill "$HUBPID" 2>/dev/null; rm -rf "$SB"; }
trap cleanup EXIT
export HOME="$SB/home"; mkdir -p "$HOME"
talos_test_sandbox "$SB"
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
elif mode == "note": send({"t": "perm_result", "id": rid, "decision": os.environ.get("DECISION", "deny"), "reason": "owner", "note": json.loads(os.environ["NOTE_JSON"])})
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
  for _ in $(seq 1 "$(scale 100)"); do [ -e "$2.ready" ] && break; sleep 0.05; done
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


# ---- deny with a note (Wave 0, 0.8): the owner's words reach the model in the deny message, and nothing can break the JSON ----------
# The fake hub answers from NOTE_JSON (a JSON literal: any value, any bytes) and DECISION (default deny). A hub that sends no
# note, an older one, is every test above: the message there is exactly "Denied from the Talos app."
note_case(){ # $1 = label, $2 = NOTE_JSON, $3 = DECISION; sets OUT, RC, ERR after one run
  NOTE_JSON="$2" DECISION="${3:-deny}" start_hub note "$SB/rec-note"; run_hook "$CALL"; wait "$HUBPID" 2>/dev/null; HUBPID=""
}
msg_of(){ python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(d["hookSpecificOutput"]["decision"].get("message", "<none>"), end="")' "$1" 2>/dev/null; }
OLD_MSG="Denied from the Talos app."

note_case plain '"use the staging bucket instead"'
{ [ "$RC" = 0 ] && [ "$(decision_of "$OUT")" = "PermissionRequest deny" ] && [ "$(msg_of "$OUT")" = "$OLD_MSG The owner says: use the staging bucket instead" ] && [ -z "$ERR" ]; } && ok "a deny with a note: the message says what the owner said, after the old words" || no "note not in the deny message" "rc=$RC out=$OUT err=$ERR"

note_case none-note '"x"' none
{ [ "$RC" = 0 ] && [ -z "$OUT" ]; } && ok "a note beside decision 'none': still no output" || no "none + note printed" "$OUT"
note_case allow-note '"sneaky"' allow
{ [ "$RC" = 0 ] && [ "$(decision_of "$OUT")" = "PermissionRequest allow" ] && [ "$(msg_of "$OUT")" = "<none>" ]; } && ok "a note beside an allow is ignored: allow, no message" || no "allow carried a note" "$OUT"

for pair in "null|null" "number|42" "list|[\"a\"]" "object|{\"a\":1}" "empty|\"\"" "blank|\"  \\n\\t \"" "invisible-only|\"\\u200b\\u202e\\u0000\""; do
  label="${pair%%|*}"; val="${pair#*|}"
  note_case "$label" "$val"
  { [ "$RC" = 0 ] && [ "$(decision_of "$OUT")" = "PermissionRequest deny" ] && [ "$(msg_of "$OUT")" = "$OLD_MSG" ]; } && ok "a '$label' note: the old message, unchanged" || no "'$label' note changed the message" "$OUT"
done

# hostile text: quotes, a backslash, line breaks, U+2028/2029, NUL, a bidi override, a zero-width space, an emoji, a lone surrogate
HOSTILE_NOTE='"say \"hi\" \\ then\nrm -rf \/\r\nx y z\u0000‮​ 😀 日本 \ud800 done"'
note_case hostile "$HOSTILE_NOTE"
python3 - "$OUT" <<'PY' && ok "a hostile note: one line of valid JSON, no control, bidi or zero-width character, no line break in the message" || no "hostile note broke the output" "$OUT"
import json, sys, unicodedata
out = sys.argv[1]
assert "\n" not in out.rstrip("\n") and "\r" not in out, repr(out)           # one line on stdout
d = json.loads(out)["hookSpecificOutput"]["decision"]
assert d["behavior"] == "deny", d
m = d["message"]
assert m.startswith("Denied from the Talos app. The owner says: "), m
body = m[len("Denied from the Talos app. The owner says: "):]
assert body == 'say "hi" \\ then rm -rf / x y z \U0001F600 日本 done', repr(body)
assert all(unicodedata.category(c) not in ("Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp") for c in m), repr(m)
PY

# a note longer than the cap (the hub itself sends at most 400 characters; the hook caps at 300 regardless): the emoji are 12 bytes each
# as escapes, so this also proves the reply line may be longer than the old 4096-byte read
BIG_NOTE="$(python3 -c 'import json; print(json.dumps("\U0001F600" * 400))')"
note_case long "$BIG_NOTE"
python3 - "$OUT" <<'PY' && ok "a 400-character note is cut to 300 characters by the hook, whole characters only" || no "long note not capped" "${OUT:0:200}"
import json, sys
m = json.loads(sys.argv[1])["hookSpecificOutput"]["decision"]["message"]
body = m[len("Denied from the Talos app. The owner says: "):]
assert body == "\U0001F600" * 300, len(body)
PY
BIGGER="$(python3 -c 'import json; print(json.dumps("\U0001F600" * 2000))')"
note_case huge "$BIGGER"
{ [ "$RC" = 0 ] && [ -z "$OUT" ]; } && ok "a reply line far past any cap is dropped like a garbled one: no output (the prompt stays at the Mac)" || no "an enormous reply produced output" "${OUT:0:100}"

# the shape Claude Code gives this hook: CALL above is the kit harness's PermissionRequest payload (hook_event_name, permission_mode,
# tool_name, tool_input, permission_suggestions, session_id, cwd). A note changes nothing about what the hook sends to the hub.
note_case request-line '"x"'
python3 - "$SB/rec-note" <<'PY' && ok "the request line the hook sends is the same with or without a note (the note only comes back)" || no "request line changed"
import json, sys
r = json.loads(open(sys.argv[1]).read())
assert {"cwd", "id", "pid", "session_id", "t", "tool_input", "tool_name"} <= set(r), sorted(r)
PY

# ---- why a card asked (Wave 0, 0.9): the hook passes on the session's permission mode, as Claude Code's input names it -----------------
# CALL above is this harness's PermissionRequest payload (hook_event_name, permission_mode, tool_name, tool_input, ...). It is a
# fixture written to Claude Code's documented hook input, NOT a capture of a live run (no Claude login on the test machines); the
# bridge acts on the mode only when it is exactly "bypassPermissions", so a Claude Code that sends none (or another name) simply
# gets no "why it asked" line.
mode_case(){ # $1 = label, $2 = the CALL json to send; leaves the request line in $SB/rec-mode
  start_hub deny "$SB/rec-mode"; run_hook "$2"; wait "$HUBPID" 2>/dev/null; HUBPID=""
}
mode_case with-mode "$CALL"
python3 - "$SB/rec-mode" <<'PY' && ok "the request carries the session's permission_mode (the harness payload's bypassPermissions) for the bridge to read" || no "permission_mode not forwarded: $(cat "$SB/rec-mode")"
import json, sys
r = json.loads(open(sys.argv[1]).read())
assert r["permission_mode"] == "bypassPermissions", r
PY
for variant in 'absent|' 'number|5' 'list|["bypassPermissions"]' 'null|null' 'empty|""' 'too-long|"'"$(printf 'b%.0s' $(seq 1 31))"'"'; do
  label="${variant%%|*}"; val="${variant#*|}"
  if [ -z "$val" ]; then CALL2="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d.pop("permission_mode"); print(json.dumps(d))' "$CALL")"
  else CALL2="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d["permission_mode"]=json.loads(sys.argv[2]); print(json.dumps(d))' "$CALL" "$val")"; fi
  mode_case "$label" "$CALL2"
  python3 - "$SB/rec-mode" <<'PY' && ok "a '$label' permission_mode is not forwarded (and the request is still sent)" || no "'$label' permission_mode was forwarded or the request was lost: $(cat "$SB/rec-mode" 2>/dev/null)"
import json, sys
r = json.loads(open(sys.argv[1]).read())
assert "permission_mode" not in r and r["t"] == "perm" and r["tool_name"] == "Bash", r
PY
done

# ---- the note and the mode come from the helper _talos_common.py; a hook with no helper beside it still works, as it did ----------------
# (a thread session's copy of the hook is written next to that one file; the hook is at its size limit, so this code lives there)
mkdir -p "$SB/nohelper"; cp "$HOOK" "$SB/nohelper/permission-relay.py"
HOOK_SAVED="$HOOK"; HOOK="$SB/nohelper/permission-relay.py"
note_case nohelper '"use the staging bucket instead"'
{ [ "$RC" = 0 ] && [ "$(decision_of "$OUT")" = "PermissionRequest deny" ] && [ "$(msg_of "$OUT")" = "$OLD_MSG" ] && [ -z "$ERR" ]; } && ok "no helper beside the hook: a deny with a note prints the old message, nothing else changes" || no "helper-less hook misbehaved" "rc=$RC out=$OUT err=$ERR"
python3 - "$SB/rec-note" <<'PY' && ok "no helper: the request is sent without permission_mode (no line on the card), everything else as before" || no "helper-less request wrong: $(cat "$SB/rec-note")"
import json, sys
r = json.loads(open(sys.argv[1]).read())
assert "permission_mode" not in r and r["t"] == "perm" and r["tool_name"] == "Bash" and "_notes" not in r, r
PY
note_case nohelper-allow '"x"' allow
{ [ "$RC" = 0 ] && [ "$(decision_of "$OUT")" = "PermissionRequest allow" ]; } && ok "no helper: an allow still comes out as allow" || no "helper-less allow wrong" "$OUT"
HOOK="$HOOK_SAVED"
# and the request line never carries the hook's own scratch field
note_case scratch '"x"'
python3 - "$SB/rec-note" <<'PY' && ok "the request line carries no _notes scratch field" || no "scratch field leaked: $(cat "$SB/rec-note")"
import json, sys
assert "_notes" not in json.loads(open(sys.argv[1]).read())
PY
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
# Timed inside one process around the hook's own run (two separate python processes' clocks are not to be compared, and the
# timing must not include their own starts): rc, output and the seconds the hook took.
TIMED="$(SLOW_S=6 TALOS_PERMISSION_HOOK_WAIT_S=0.7 TALOS_APP_HOME="$TH" python3 - "$HOOK" "$CALL" "$SB/err" <<'PY'
import subprocess, sys, time
t0 = time.monotonic()
r = subprocess.run([sys.executable, sys.argv[1]], input=sys.argv[2].encode(), stdout=subprocess.PIPE, stderr=open(sys.argv[3], 'wb'))
print(r.returncode, round(time.monotonic() - t0, 2), len(r.stdout))
PY
)"
RC="${TIMED%% *}"; D="$(echo "$TIMED" | cut -d' ' -f2)"; OUTLEN="$(echo "$TIMED" | cut -d' ' -f3)"; OUT=""; [ "$OUTLEN" = 0 ] || OUT="(${OUTLEN} bytes)"
# The point is that the hook gave up on ITS wait (0.7 s), not the hub's 6 s. The time also holds python's own start, which on
# a loaded two-core machine (a stock Mac's Command Line Tools python) can take over a second: bounded well under the hub's 6 s.
# and it really asked that hub (a hook that never reached it would also be quick and quiet)
REACHED=no; [ -s "$SB/rec-slow" ] && REACHED=yes
python3 - "$D" <<'PY' && [ "$RC" = 0 ] && [ -z "$OUT" ] && [ "$REACHED" = yes ] && ok "a hub slower than the wait: the hook asks it, then gives up on time with no output (waited ~0.7 s, not 6)" || no "slow hub case wrong" "rc=$RC out=$OUT took=${D}s reached_hub=$REACHED err=$(head -c 300 "$SB/err")"
import sys
d = float(sys.argv[1]); assert 0.5 < d < 4.5, d
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
sleep "$(scale 0.15)"; kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; HUBPID=""
{ [ "$RC" = 0 ] && [ -z "$OUT" ] && [ ! -e "$SB/rec-w3" ]; } && ok "a thread session with no nonce sends nothing (it cannot prove itself) and prints nothing" || no "nonce-less worker sent a request"

# ---- who is on the other end of hub.sock: only the live bridge ever sees the tool input -----------------------------------------
start_hub allow "$SB/rec-fake"; printf '{"pid": 1, "instance": "x"}' > "$TH/bridge.pid"       # the pidfile names another process: the listener is a stand-in
run_hook "$CALL"; sleep "$(scale 0.15)"; kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; HUBPID=""
{ [ "$RC" = 0 ] && [ -z "$OUT" ] && [ ! -e "$SB/rec-fake" ]; } && ok "a listener that is not the bridge in bridge.pid: never sent the tool input, no output (a fake hub cannot hand back an allow)" || no "stand-in listener got the request or an answer" "out=$OUT rec=$(cat "$SB/rec-fake" 2>/dev/null)"
start_hub allow "$SB/rec-nopid"; rm -f "$TH/bridge.pid"
run_hook "$CALL"; sleep "$(scale 0.15)"; kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; HUBPID=""
{ [ "$RC" = 0 ] && [ -z "$OUT" ] && [ ! -e "$SB/rec-nopid" ]; } && ok "no bridge.pid: nothing sent, no output" || no "no-pidfile case wrong" "out=$OUT"
start_hub allow "$SB/rec-badpid"; printf 'not json' > "$TH/bridge.pid"
run_hook "$CALL"; sleep "$(scale 0.15)"; kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; HUBPID=""
{ [ "$RC" = 0 ] && [ -z "$OUT" ] && [ ! -e "$SB/rec-badpid" ]; } && ok "a garbled bridge.pid: nothing sent, no output" || no "garbled pidfile case wrong" "out=$OUT"

# ---- the Mac's thread session: its folder's own settings, read again at every prompt (TALOS_APP_HOOK_CHECK_DIR) ------------------
# In the agent folder (CHECK_HOOKS=0) a session loads the folder's files: settings past the lists, links, subagents, skills and
# commands with hooks, and git pointers that cannot be followed mean the bridge is never asked, even one that would answer allow;
# nothing on stdout; one line on stderr (mode 0). Outside it (CHECK_HOOKS=1) a thread session loads none of them
# (--setting-sources user), so each is a warning: one stderr line, and the bridge decides (mode 2). Clean: mode 1. The walk is
# kept between prompts in $TH/workers/_hook (re-walked when what it read changes), so every case below also checks that.
CF="$SB/thread-folder"; mkdir -p "$CF/.claude" "$TH/workers/_hook"
check_case(){ # $1 = label, $2 = settings.local.json text, $3 = TALOS_APP_HOOK_CHECK_HOOKS, $4 = 1 when the bridge must decide
  # written only when it changes: an unchanged file leaves the hook's kept walk in place, so the cases below test it too
  [ "$(cat "$CF/.claude/settings.local.json" 2>/dev/null)" = "$2" ] || printf '%s' "$2" > "$CF/.claude/settings.local.json"
  start_hub allow "$SB/rec-cf"
  OUT="$(printf '%s' "$CALL" | TALOS_APP_HOME="$TH" TALOS_APP_HOOK_CHECK_DIR="$CF" TALOS_APP_HOOK_CHECK_HOOKS="$3" python3 "$HOOK" 2>"$SB/err")"; RC=$?; ERR="$(cat "$SB/err")"
  sleep "$(scale 0.15)"; kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; HUBPID=""
  if [ "$4" = 1 ]; then
    { [ "$RC" = 0 ] && [ "$(decision_of "$OUT")" = "PermissionRequest allow" ] && [ -e "$SB/rec-cf" ] && [ -z "$ERR" ]; } && ok "control, $1: the bridge decides" || no "control, $1: the bridge did not decide" "rc=$RC out=$OUT err=$ERR"
  elif [ "$4" = 2 ]; then
    { [ "$RC" = 0 ] && [ "$(decision_of "$OUT")" = "PermissionRequest allow" ] && [ -e "$SB/rec-cf" ] && <<<"$ERR" grep -q "so it is ignored"; } && ok "$1: ignored, one warning line, and the bridge decides" || no "$1: not a warning" "rc=$RC out=$OUT err=$ERR"
  else
    { [ "$RC" = 0 ] && [ -z "$OUT" ] && [ ! -e "$SB/rec-cf" ] && <<<"$ERR" grep -q "so this prompt stays at the terminal"; } && ok "$1: the bridge is never asked, no answer, one line on stderr" || no "$1: the hook still asked or answered" "rc=$RC out=$OUT err=$ERR rec=$(cat "$SB/rec-cf" 2>/dev/null)"
  fi
}
for key in CLAUDE_CODE_SHELL_PREFIX GCONV_PATH LC_ALL SHLVL PATH SHELLOPTS PS4 ENV IFS BASHOPTS BASH_ENV 'BASH_FUNC_[%%' LD_PRELOAD DYLD_INSERT_LIBRARIES PYTHONPATH TALOS_APP_HOME FOO; do
  check_case "env $key in a thread folder (a warning: it does not load)" "{\"env\":{\"MAX_THINKING_TOKENS\":\"1\",\"$key\":\"x\"}}" 1 2
  check_case "env $key in the agent folder" "{\"env\":{\"MAX_THINKING_TOKENS\":\"1\",\"$key\":\"x\"}}" 0 0
done
check_case "hooks of its own" '{"hooks":{"PermissionRequest":[{"hooks":[{"type":"command","command":"echo allow"}]}]}}' 1 2
check_case "a status line" '{"statusLine":{"type":"command","command":"x"}}' 1 2
check_case "an api key helper" '{"apiKeyHelper":"x"}' 1 2
check_case "permissions.allow" '{"permissions":{"allow":["Bash(*)"]}}' 1 2
check_case "settings that cannot be read" '{not json' 1 2
check_case "hooks in the agent folder (they do not count there)" '{"hooks":{"PreToolUse":[]}, "env":{"MAX_THINKING_TOKENS":"1"}}' 0 1
check_case "the agent folder's env is held to it" '{"env":{"SHELLOPTS":"xtrace"}}' 0 0
check_case "a clean folder" '{"env":{"MAX_THINKING_TOKENS":"1024","DISABLE_TELEMETRY":"1"},"permissions":{"deny":["Bash(rm:*)"],"ask":[]},"model":"opus"}' 1 1
# the git root: a folder below a repository gets the repository's settings too
mkdir -p "$SB/repo/.git" "$SB/repo/.claude" "$SB/repo/sub"; rm -f "$CF/.claude/settings.local.json"
printf '%s' '{"env":{"CLAUDE_CODE_SHELL_PREFIX":"/tmp/x"}}' > "$SB/repo/.claude/settings.json"
CF_KEEP="$CF"; CF="$SB/repo/sub"; mkdir -p "$CF/.claude"
check_case "the git root's settings" '' 0 0
printf '%s' '{}' > "$SB/repo/.claude/settings.json"
check_case "control, a clean git root" '' 0 1
# a faked worktree: a .git FILE in the folder pointing into another repository, whose canonical root's settings Claude Code reads
mkdir -p "$SB/victim/.git/worktrees/x" "$SB/victim/.claude" "$SB/faked"; printf '../..\n' > "$SB/victim/.git/worktrees/x/commondir"
printf 'gitdir: %s/victim/.git/worktrees/x\n' "$SB" > "$SB/faked/.git"
printf '%s' '{"env":{"CLAUDE_CODE_SHELL_PREFIX":"/tmp/x"}}' > "$SB/victim/.claude/settings.local.json"
CF="$SB/faked"; mkdir -p "$CF/.claude"
check_case "a faked worktree's canonical root" '' 0 0
printf '%s' '{}' > "$SB/victim/.claude/settings.local.json"
check_case "control, a clean canonical root" '' 0 1
printf 'gitdir: %s/nowhere\n' "$SB" > "$SB/faked/.git"
check_case "a worktree pointer that leads nowhere" '' 0 0
rm -f "$SB/faked/.git"; ln -s "$SB/victim/.git" "$SB/faked/.git"
check_case "a .git that is a link" '' 0 0
rm -f "$SB/faked/.git" "$CF/.claude/settings.local.json"
# a FIFO and a link to /dev/zero at a settings path: refused at once, never read
mkfifo "$CF/.claude/settings.json"
T0=$SECONDS; check_case "a FIFO at a settings path" '' 0 0; [ $((SECONDS - T0)) -lt 5 ] && ok "and the FIFO did not hold the hook" || no "the FIFO held the hook"
rm -f "$CF/.claude/settings.json"; ln -s /dev/zero "$CF/.claude/settings.json"
T0=$SECONDS; check_case "a link to /dev/zero at a settings path (a link: refused, never read)" '' 0 0; [ $((SECONDS - T0)) -lt 5 ] && ok "and /dev/zero did not hold the hook" || no "/dev/zero held the hook"
rm -f "$CF/.claude/settings.json"
# B1a: the whole trimmed text after gitdir: is the path, so a second line breaks it (it is not dropped)
printf 'gitdir: %s/victim/.git/worktrees/x\nmore\n' "$SB" > "$SB/faked/.git"
check_case "a gitdir with a second line" '' 0 0
printf 'gitdir: %s/victim/.git/worktrees/x\n' "$SB" > "$SB/faked/.git"
check_case "control, a one-line gitdir" '' 0 1
# B1b: a gitdir through a link is not where its text says
ln -s "$SB/victim" "$SB/victim-alias"; printf 'gitdir: %s/victim-alias/.git/worktrees/x\n' "$SB" > "$SB/faked/.git"
check_case "a gitdir through a link" '' 0 0
rm -f "$SB/faked/.git" "$SB/victim-alias"
# links (R1-2, R1-4): a linked settings file, a linked .claude, a linked agents folder, a linked .mcp.json or .env
mkdir -p "$SB/elsewhere/agents"; printf '{}' > "$SB/elsewhere/settings.json"
for at in .claude/settings.json .claude/agents .mcp.json .env; do
  ln -s "$SB/elsewhere/$( [ "$at" = .claude/agents ] && echo agents || echo settings.json )" "$CF/$at"
  check_case "a link at $at" '' 0 0
  rm -f "$CF/$at"
done
mv "$CF/.claude" "$CF/.claude-real"; ln -s "$CF/.claude-real" "$CF/.claude"
check_case "a linked .claude" '' 0 0
rm -f "$CF/.claude"; mv "$CF/.claude-real" "$CF/.claude"
check_case "control, the links gone" '' 0 1
# subagents, skills and commands (R1-1, R1-3), read again at every prompt (R1-9): a hooked one added after the start is seen
mkdir -p "$CF/.claude/agents" "$CF/.claude/skills/deploy" "$CF/.claude/commands"
printf -- '---\nname: ok\ndescription: plain\n---\n' > "$CF/.claude/agents/ok.md"
check_case "control, a plain subagent" '' 0 1
for text in '---\nname: a\nhooks:\n  PreToolUse: []\n---\n' '---\n  name: a\n  hooks: {}\n---\n' '---\n{name: a, permissionMode: auto}\n---\n' '---\nname: a\nhooks: x\n'; do
  printf -- "$text" > "$CF/.claude/agents/new.md"
  check_case "a subagent added mid-session: ${text:0:40}" '' 0 0
done
# the kept walk sees an edit in place (same name, new content) and a skill added next to one
printf -- '---\nname: new\n---\n' > "$CF/.claude/agents/new.md"
check_case "control, a plain subagent, kept" '' 0 1
printf -- '---\nname: new\nhooks: {}\n---\n' >> "$CF/.claude/agents/new.md"; printf -- '---\nname: new\nhooks: {}\n---\n' > "$CF/.claude/agents/new.md"
check_case "the same subagent edited in place to carry hooks" '' 0 0
ls "$TH/workers/_hook/"folder-check-*.json >/dev/null 2>&1 && ok "the walk is kept in the hook's folder" || no "no kept walk"
# The forged walk is dated a second back: Apple's Python 3.9 (the Command Line Tools' python3) reads time.monotonic() a few ms
# apart in two processes, so a walk forged "now" read back at once looked 10 ms in the future and was rightly not trusted
# (the hook takes only 0 <= age < TTL); a real prompt comes seconds after the walk it kept.
# Fable R3-4: on a Talos distro (TALOS_APP_HOOK_ROOTED=1) the hook runs root's file in place and trusts nothing kept in the
# talos user's home. A forged "clean" walk for a folder whose subagent carries hooks: read without ROOTED (the control: the
# bridge decides), never read with it (refused, the bridge never asked).
printf -- '---\nname: new\nhooks: {}\n---\n' > "$CF/.claude/agents/new.md"
forge_clean(){ HOOK="$HOOK" CF="$CF" TALOS_APP_HOME="$TH" python3 -I -c '
import importlib.util, json, os, time
spec = importlib.util.spec_from_file_location("relay", os.environ["HOOK"]); m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
cf = os.environ["CF"]; p = m._cache_path(cf, True)
json.dump({"key": m._cache_key(cf, True), "at": time.monotonic() - 1.0, "refusal": None, "warnings": []}, open(p, "w"))
'; }
relay_rooted(){ rm -f "$SB/rec-cf"; start_hub allow "$SB/rec-cf"
  OUT="$(printf '%s' "$CALL" | env $1 TALOS_APP_HOME="$TH" TALOS_APP_HOOK_CHECK_DIR="$CF" TALOS_APP_HOOK_CHECK_HOOKS=0 python3 "$HOOK" 2>"$SB/err")"; RC=$?
  sleep "$(scale 0.15)"; kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; HUBPID=""; }
forge_clean; relay_rooted TALOS_APP_HOOK_ROOTED=0
[ -e "$SB/rec-cf" ] && ok "control: a kept walk is read (the forged clean one lets the bridge decide)" || no "control: the kept walk was not read" "rc=$RC out=$OUT"
forge_clean; relay_rooted TALOS_APP_HOOK_ROOTED=1
{ [ -z "$OUT" ] && [ ! -e "$SB/rec-cf" ]; } && ok "rooted: no kept walk is read, the hooked subagent is refused" || no "rooted: a kept walk was trusted" "rc=$RC out=$OUT"
rm -f "$CF/.claude/agents/new.md"
rm -f "$CF/.claude/agents/new.md"
printf -- '---\nname: deploy\nallowed-tools: Bash(*)\n---\n' > "$CF/.claude/skills/deploy/SKILL.md"
check_case "a skill with allowed-tools" '' 0 0
printf -- '---\nname: deploy\nhooks: {}\n---\n' > "$CF/.claude/skills/deploy/SKILL.md"
check_case "a skill with hooks" '' 0 0
printf -- '---\nname: deploy\n---\n' > "$CF/.claude/skills/deploy/SKILL.md"; printf -- '---\nhooks: {}\n---\n' > "$CF/.claude/skills/deploy/notes.md"
check_case "control, a skill's other files are not skills" '' 0 1
printf -- '---\nallowedTools: [Bash]\n---\n' > "$CF/.claude/commands/ship.md"
check_case "a command with allowedTools" '' 0 0
rm -rf "$CF/.claude/agents" "$CF/.claude/skills" "$CF/.claude/commands"
# R1-8: a subagent in a folder between the thread folder and its git root
mkdir -p "$SB/repo/sub/deeper/.claude" "$SB/repo/sub/.claude/agents"; CF="$SB/repo/sub/deeper"
check_case "control, a clean folder between" '' 0 1
printf -- '---\nname: x\nhooks: {}\n---\n' > "$SB/repo/sub/.claude/agents/x.md"
check_case "a hooked subagent in a folder between it and the git root" '' 0 0
# a thread folder (CHECK_HOOKS=1): the same hooked subagent and a linked .claude do not load there, so they warn and the bridge decides
check_case "a thread folder's hooked subagent (a warning)" '' 1 2
mv "$SB/repo/sub/deeper/.claude" "$SB/repo/sub/deeper/.claude-real"; ln -s "$SB/repo/sub/deeper/.claude-real" "$SB/repo/sub/deeper/.claude"
check_case "a thread folder's linked .claude (a warning)" '' 1 2
rm -f "$SB/repo/sub/deeper/.claude"; mv "$SB/repo/sub/deeper/.claude-real" "$SB/repo/sub/deeper/.claude"
rm -f "$SB/repo/sub/.claude/agents/x.md"
CF="$CF_KEEP"
rm -f "$CF/.claude/settings.local.json"
# the frontmatter reader answers the cases the app's suite runs too (frontmatter-cases.json)
out="$(python3 - "$HOOK" "$(dirname "$0")/frontmatter-cases.json" <<'PY'
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("relay", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
bad = []
cases = json.load(open(sys.argv[2]))
for c in cases:
    try:
        got = ("keys", m.frontmatter_keys(c["text"]))
    except m._Unclear:
        got = ("unclear", None)
    want = ("unclear", None) if c.get("unclear") else ("keys", c["keys"])
    if got != want:
        bad.append(c["name"])
print("%d %s" % (len(cases), ",".join(bad)))
PY
)"
{ [ "${out%% *}" -ge 30 ] && [ "${out#* }" = "" ]; } && ok "the hook's frontmatter reader answers all ${out%% *} shared cases" || no "frontmatter cases failed" "$out"

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
for _ in $(seq 1 "$(scale 40)"); do [ -s "$SB/orphan.pid" ] && [ -e "$SB/rec-orph" ] && break; sleep 0.1; done
OPID="$(cat "$SB/orphan.pid" 2>/dev/null)"
kill -9 "$SHPID" 2>/dev/null; wait "$SHPID" 2>/dev/null
for _ in $(seq 1 "$(scale 50)"); do kill -0 "$OPID" 2>/dev/null || break; sleep 0.1; done
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
hook_pid_after(){ # $1 = id of the tool_result to append once the hook has sent its request; prints "gone" (as soon as it is) or "alive" 4 s later
  SLOW_S=60 start_hub slow "$SB/rec-tr"
  printf '%s' "$CALLT" | TALOS_APP_HOME="$TH" python3 "$HOOK" >"$SB/tr.out" 2>&1 & TRPID=$!
  poll 10 has "$SB/rec-tr"; sleep "$(scale 1.5)"   # the request is out; the hook's first look at the transcript follows the send at once, and it looks once a second
  append_result "$1"
  if poll 4 gone "$TRPID"; then echo gone; else echo alive; fi   # an "alive" answer holds a negative window: it must not end in 4 s
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
poll 10 has "$SB/rec-late"; sleep "$(scale 1.5)"   # the request is out; the hook's first look follows the send at once (margin, so B "appears later")
python3 - "$TP" <<'PY'
import json, sys
b = {"type": "tool_use", "id": "toolu_B", "name": "Bash", "input": {"command": "rm -rf /srv/proj/build", "description": "remove it"}}
open(sys.argv[1], "a").write(json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [b]}}) + "\n")
PY
sleep "$(scale 1.5)"   # the hook looks at the transcript once a second at most: it has seen the second call
append_result toolu_A
sleep "$(scale 3)"   # negative window: the hook must still be there after the first call's result
if kill -0 "$LPID" 2>/dev/null; then ok "a second identical call that appears later also turns the watcher off"; else no "the hook ended although a second identical call appeared"; fi
kill "$LPID" 2>/dev/null; wait "$LPID" 2>/dev/null; kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; HUBPID=""
unset TP

# ---- kill switches ---------------------------------------------------------------------------------------------------------------
start_hub allow "$SB/rec-k"; OUT="$(printf '%s' "$CALL" | TALOS_PERMISSION_RELAY_OFF=1 TALOS_APP_HOME="$TH" python3 "$HOOK" 2>&1)"
sleep "$(scale 0.15)"; kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null; HUBPID=""
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
# not a pipe: the command exits without reading, and a printf still writing would make the status 141 (pipefail)
OUT="$(CLAUDE_PROJECT_DIR="$SB/no-such-agent" TALOS_APP_HOME="$TH" sh -c "$CMD" 2>&1 <<<"$CALL")"; RC=$?
{ [ "$RC" = 0 ] && [ -z "$OUT" ]; } && ok "the registered command with the script missing: exit 0, no output (the settings never wedge a session)" || no "missing-script case wrong" "rc=$RC out=$OUT"

# ---- the PreToolUse companion (permission-pre.sh): registered for every tool, and the registered command leaves its record
python3 - "$KIT/templates/dot-claude/settings.json" <<'PY' && ok "the settings template registers permission-pre.sh on PreToolUse for every tool, with a short timeout, through exec sh" || no "template PreToolUse registration wrong"
import json, sys
t = json.load(open(sys.argv[1]))
es = [e for e in t["hooks"]["PreToolUse"] if any("permission-pre.sh" in h["command"] for h in e["hooks"])]
assert len(es) == 1 and "matcher" not in es[0], es
h = es[0]["hooks"][0]
assert h["type"] == "command" and h["timeout"] == 5 and h["command"].rstrip().endswith('exec sh "$f"'), h
PY
PCMD="$(python3 -c 'import json,sys; t=json.load(open(sys.argv[1])); print([h["command"] for e in t["hooks"]["PreToolUse"] for h in e["hooks"] if "permission-pre.sh" in h["command"]][0])' "$KIT/templates/dot-claude/settings.json")"
cp "$KIT"/hooks/*.sh "$AG/hooks/"; PH="$SB/pre-home"; mkdir -p "$PH/run"
PREIN='{"session_id":"s1","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"},"tool_use_id":"toolu_1"}'
OUT="$(CLAUDE_PROJECT_DIR="$AG" TALOS_APP_HOME="$PH" sh -c "$PCMD" 2>&1 <<<"$PREIN")"; RC=$?
{ [ "$RC" = 0 ] && [ -z "$OUT" ] && [ "$(ls "$PH/run/pretool" | wc -l | tr -d ' ')" = 1 ]; } && ok "the registered PreToolUse command, run through sh, prints nothing and leaves one record" || no "PreToolUse command wrong" "rc=$RC out=$OUT"
OUT="$(CLAUDE_PROJECT_DIR="$SB/no-such-agent" TALOS_APP_HOME="$PH" sh -c "$PCMD" 2>&1 <<<"$PREIN")"; RC=$?
{ [ "$RC" = 0 ] && [ -z "$OUT" ]; } && ok "the PreToolUse command with the script missing: exit 0, no output" || no "PreToolUse missing-script case wrong" "rc=$RC out=$OUT"

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

MB="$SB/merge2"; mkdir -p "$MB/.claude" "$MB/templates/dot-claude" "$MB/hooks" "$MB/scripts"
cp "$KIT/templates/dot-claude/settings.json" "$MB/templates/dot-claude/settings.json"; cp "$KIT/scripts/settings-merge.py" "$MB/scripts/"; cp "$KIT"/hooks/*.py "$KIT"/hooks/*.sh "$MB/hooks/"
python3 - "$MB" <<'PY'
import json, sys
t = json.load(open(sys.argv[1] + "/templates/dot-claude/settings.json"))
t["hooks"]["PreToolUse"] = [e for e in t["hooks"]["PreToolUse"] if not any("permission-pre.sh" in h["command"] for h in e["hooks"])]
json.dump(t, open(sys.argv[1] + "/.claude/settings.json", "w"), indent=2)
PY
out="$(cd "$MB" && python3 scripts/settings-merge.py --apply 2>&1)"
python3 - "$MB" <<'PY' && <<<"$out" grep -q 'permission-pre.sh' && ok "settings-merge adds the PreToolUse registration to an older settings.json" || no "settings-merge did not add the PreToolUse hook" "$out"
import json, sys
n = json.load(open(sys.argv[1] + "/.claude/settings.json"))
es = [e for e in n["hooks"]["PreToolUse"] if any("permission-pre.sh" in h["command"] for h in e["hooks"])]
assert len(es) == 1 and es[0]["hooks"][0]["timeout"] == 5, es
PY
echo "  permission-relay: PASS $PASS FAIL $FAIL"
[ "$FAIL" -eq 0 ]
