#!/usr/bin/env bash
# test-hub-fence.sh -- no kit test can reach a live Talos bridge, even run from inside a thread session.
# On 2026-11-15 a kit test run from a thread session sent real cards to the owner's phone: the session's TALOS_APP_HOME and
# worker proof were still set, so the hooks under test talked to the live hub. Here a decoy "live" hub sits OUTSIDE every test's
# sandbox, the real test scripts run with a full thread-session environment pointing at it, and the decoy must get nothing.
export PYTHONDONTWRITEBYTECODE=1
set -uo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$KIT/scripts/_test-env.sh"
D="$(mktemp -d)" || exit 2
case "$D" in /*/*) ;; *) echo "suspicious temp dir '$D'" >&2; exit 2 ;; esac
D="$(cd "$D" && pwd -P)"
RECPID=""
cleanup(){ [ -n "$RECPID" ] && kill "$RECPID" 2>/dev/null; rm -rf "$D"; }
trap cleanup EXIT
PASS=0; FAIL=0
# A loaded machine (the gate sets TALOS_TEST_TIME_FACTOR=3) runs this for minutes: the decoy's life and the hook's wait scale
scale(){ awk -v a="$1" -v f="${TALOS_TEST_TIME_FACTOR:-1}" 'BEGIN { f += 0; if (!(f >= 1) || f == f + 1) f = 1; printf "%g", a * f }'; }
ok(){ PASS=$((PASS+1)); }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

# ---- the decoy live hub: records every line it is sent, answers allow, and bridge.pid names it (so a hook's peer-pid check passes)
APP="$D/app"; mkdir -p "$APP/run"; echo '{}' > "$APP/config.json"
cat > "$D/recorder.py" <<'PY'
import json, os, socket, sys
home = sys.argv[1]
path = os.path.join(home, "run", "hub.sock")
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.bind(path); s.listen(16)
json.dump({"pid": os.getpid()}, open(os.path.join(home, "bridge.pid"), "w"))
open(os.path.join(home, "up"), "w").close()
import time
start_ppid, t0, life = os.getppid(), time.time(), float(sys.argv[2])
s.settimeout(1.0)
while True:
    try:
        c, _ = s.accept()
    except socket.timeout:
        if os.getppid() != start_ppid or time.time() - t0 > life: sys.exit(0)    # never outlives the test that started it
        continue
    c.settimeout(5.0); buf = b""
    while b"\n" not in buf:
        d = c.recv(65536)
        if not d: break
        buf += d
    if not buf: c.close(); continue
    m = json.loads(buf.split(b"\n")[0])
    open(os.path.join(home, "got.jsonl"), "a").write(json.dumps(m) + "\n")
    t = "perm_result" if m.get("t") == "perm" or "perm" in str(m.get("t")) else "rule_result"
    c.sendall((json.dumps({"t": t, "id": m.get("id"), "decision": "allow", "reason": "always"}) + "\n").encode()); c.close()
PY
python3 "$D/recorder.py" "$APP" "$(scale 300)" & RECPID=$!
for _ in $(seq 50); do [ -e "$APP/up" ] && break; sleep 0.1; done
[ -e "$APP/up" ] || { echo "the decoy hub did not start" >&2; exit 2; }
got(){ [ -s "$APP/got.jsonl" ] && wc -l < "$APP/got.jsonl" | tr -d ' ' || echo 0; }

# ---- a full thread-session environment, pointing at the decoy
SESSION_ENV=(TALOS_APP_HOME="$APP" TALOS_SESSION_ROLE=worker TALOS_APP_WORKER_THREAD=t1 TALOS_APP_WORKER_NONCE=0123456789abcdef0123 CLAUDE_PID=$$)

for s in test-action-rules.sh test-permission-relay.sh; do
  rm -f "$APP/got.jsonl"
  out="$(env "${SESSION_ENV[@]}" bash "$KIT/scripts/$s" 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok || no "$s exits 0 from a thread session (got $rc)" "$(printf '%s' "$out" | tail -3)"
  [ "$(got)" = 0 ] && ok || no "$s sent the decoy hub $(got) request(s)"
done

rm -f "$APP/got.jsonl"
# ---- hook level: a test-marked environment whose sandbox does not contain the app folder
mkdir -p "$D/sb" "$D/agent/hooks" "$D/home" "$D/state"
cp "$KIT"/hooks/*.py "$KIT"/hooks/action-rules.yaml "$D/agent/hooks/"
HOOKENV=(HOME="$D/home" XDG_STATE_HOME="$D/state" XDG_CONFIG_HOME="$D/cfg" TALOS_TEST_SANDBOX="$D/sb" "${SESSION_ENV[@]}")
printf '%s' '{"tool_name":"Bash","cwd":"/srv/app","tool_input":{"command":"npm publish","description":"publish it"}}' \
  | ( cd "$D/agent" && env "${HOOKENV[@]}" python3 hooks/action-rules.py check >/dev/null 2>&1 )
[ "$(got)" = 0 ] && ok || no "action-rules check reached the decoy hub from outside its test sandbox"
CALL='{"session_id":"abc","cwd":"/srv/proj","permission_mode":"bypassPermissions","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"rm -rf /srv/proj/build","description":"remove it"},"permission_suggestions":[]}'
out="$(printf '%s' "$CALL" | env "${HOOKENV[@]}" TALOS_APP_PERM_HOOK_SOURCE=worker TALOS_PERMISSION_HOOK_WAIT_S="$(scale 3)" python3 "$KIT/hooks/permission-relay.py" 2>/dev/null)"
[ "$(got)" = 0 ] && [ -z "$out" ] && ok || no "permission-relay reached the decoy hub from outside its test sandbox" "output: $out"
# and the fence is only for tests: without TALOS_TEST_SANDBOX the same hook still reaches a hub (nothing changes for owners)
out="$(printf '%s' "$CALL" | env "${HOOKENV[@]}" TALOS_TEST_SANDBOX= TALOS_APP_PERM_HOOK_SOURCE=worker TALOS_PERMISSION_HOOK_WAIT_S="$(scale 3)" python3 "$KIT/hooks/permission-relay.py" 2>/dev/null)"
[ "$(got)" != 0 ] && ok || no "without TALOS_TEST_SANDBOX the permission hook no longer reaches its hub"

# ---- the tripwire: a test that seals nothing refuses to run
err="$( ( . "$KIT/scripts/_test-env.sh"; export TALOS_APP_HOME="$APP"; talos_test_sandbox "$D/sb" ) 2>&1 >/dev/null )"; rc=$?
[ "$rc" = 3 ] && ok || no "the tripwire exits 3 when TALOS_APP_HOME is outside the sandbox (got $rc)"
case "$err" in "REFUSING:"*) ok ;; *) no "the tripwire prints a REFUSING: line" "$err" ;; esac
# a sealed sandbox passes
( . "$KIT/scripts/_test-env.sh"; HOME="$D/sb/home" talos_test_sandbox "$D/sb" ) >/dev/null 2>&1 && ok || no "a sealed sandbox is refused by the tripwire"

# ---- a sandbox app folder whose run/hub.sock is a link to the decoy's socket: the socket it reaches is outside the sandbox
rm -f "$APP/got.jsonl"
mkdir -p "$D/sb/linkapp/run"; ln -s "$APP/run/hub.sock" "$D/sb/linkapp/run/hub.sock"; cp "$APP/bridge.pid" "$D/sb/linkapp/bridge.pid"; echo '{}' > "$D/sb/linkapp/config.json"
LINKENV=(HOME="$D/home" XDG_STATE_HOME="$D/state" XDG_CONFIG_HOME="$D/cfg" TALOS_TEST_SANDBOX="$D/sb" TALOS_APP_HOME="$D/sb/linkapp" TALOS_SESSION_ROLE=worker TALOS_APP_WORKER_THREAD=t1 TALOS_APP_WORKER_NONCE=0123456789abcdef0123 CLAUDE_PID=$$)
printf '%s' '{"tool_name":"Bash","cwd":"/srv/app","tool_input":{"command":"npm publish","description":"publish it"}}' \
  | ( cd "$D/agent" && env "${LINKENV[@]}" python3 hooks/action-rules.py check >/dev/null 2>&1 )
out="$(printf '%s' "$CALL" | env "${LINKENV[@]}" TALOS_APP_PERM_HOOK_SOURCE=worker TALOS_PERMISSION_HOOK_WAIT_S="$(scale 3)" python3 "$KIT/hooks/permission-relay.py" 2>/dev/null)"
[ "$(got)" = 0 ] && [ -z "$out" ] && ok || no "a link from the sandbox to the decoy's socket was followed" "output: $out"
# every "got nothing" above means something only while the decoy still listens: one that quit early would pass them all
kill -0 "$RECPID" 2>/dev/null && ok || no "the decoy hub stopped before the last check that needs it"

# ---- static check: every test script scrubs first, seals its sandbox when it sets HOME, and no HOME-less script runs the hooks
python3 - "$KIT/scripts" <<'PY' || FAIL=$((FAIL+1))
import glob, os, re, sys
d = sys.argv[1]
bad = 0
for f in sorted(glob.glob(os.path.join(d, "test-*.sh"))) + [os.path.join(d, "self-test.sh")]:
    name = os.path.basename(f)
    lines = open(f, encoding="utf-8").read().split("\n")
    seen = False
    for l in lines:
        t = l.strip()
        if "_test-env.sh" in t and t.startswith("."):
            seen = True; break
        if not t or t.startswith("#") or t.startswith("set ") or t.startswith("unset ") or re.match(r"(export\s+)?[A-Za-z_][A-Za-z0-9_]*=", t):
            continue
        break
    if not seen:
        print("  FAIL %s does not source _test-env.sh before its first command" % name); bad += 1
    text = "\n".join(lines)
    sets_home = re.search(r"(^|;)\s*(export\s+)?HOME=", text, re.M) is not None
    if sets_home and "talos_test_sandbox" not in text:
        print("  FAIL %s sets HOME but never calls talos_test_sandbox" % name); bad += 1
    if not sets_home and name not in ("self-test.sh", "test-hub-fence.sh") and any(re.search(r"(action-rules|permission-relay)\.py", l) and re.search(r"python|HOOK=", l) for l in lines):
        # a script that sets no HOME but pins TALOS_APP_HOME inside its sandbox may call it too
        if "talos_test_sandbox" not in text:
            print("  FAIL %s never sets HOME but mentions a hub hook" % name); bad += 1
sys.exit(1 if bad else 0)
PY
echo "hub fence: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
