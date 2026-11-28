#!/usr/bin/env python3
"""Claude Code `Notification` hook: tells the Talos bridge that a session is waiting on the owner in a way that has no card.

Only `elicitation_dialog` (an MCP server asking the owner something at the terminal) is told. The bridge answers with ONE fixed sentence and an
"Open terminal" button in the thread (at most one per thread per ten minutes). Claude Code's `idle_prompt` is NOT told: it fires after almost every
answered turn, so it would say "waiting" when nothing is. Permission prompts are the PermissionRequest hook's job. The notification's own text is NEVER
read onward: this hook sends only the kind, the proof of who is asking and the session's pid.

Never blocks the session for more than four seconds in all (connect and reads together), never prints, never fails: whatever goes wrong, it exits 0
having done nothing. In a thread session it runs only from the copy registered in that session's own settings (TALOS_APP_PERM_HOOK_SOURCE=worker).
A test sets TALOS_TEST_SANDBOX to its temp folder, and the hook then never connects to a hub outside it.
Kill switch: notification-relay.off in the hook state folder, or TALOS_NOTIFICATION_RELAY_OFF=1. TALOS_NOTIFICATION_HOOK_WAIT_S can only shorten the
four seconds (tests). Python 3.9, standard library only.
"""
import json
import os
import socket
import struct
import sys
import time
import uuid

KINDS = {"elicitation_dialog": "ask"}   # notification_type -> the bridge's kind; any other type is not ours
CONNECT_S = 2.0
WAIT_S = 4.0                            # the whole hook, connect and reads together

try:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import _talos_common as C  # noqa: E402
    if C.killed("notification-relay.off"):
        sys.exit(0)
except SystemExit:
    raise
except Exception:
    C = None                            # no helper: only the environment switch below
if os.environ.get("TALOS_NOTIFICATION_RELAY_OFF") == "1":
    sys.exit(0)


def total_seconds():
    """The whole wait, never longer than WAIT_S (TALOS_NOTIFICATION_HOOK_WAIT_S can only shorten it: tests)."""
    try:
        v = float(os.environ.get("TALOS_NOTIFICATION_HOOK_WAIT_S", ""))
        return WAIT_S if v != v else max(0.05, min(v, WAIT_S))
    except ValueError:
        return WAIT_S


def app_home():
    return os.environ.get("TALOS_APP_HOME") or os.path.join(os.path.expanduser("~"), ".config", "talos", "app")


def claude_pid():
    try:
        n = int(os.environ.get("CLAUDE_PID", ""))
        if n > 0:
            return n
    except ValueError:
        pass
    return os.getppid()


def bridge_pid():
    try:
        with open(os.path.join(app_home(), "bridge.pid"), encoding="utf-8") as fh:
            n = json.load(fh).get("pid")
        return n if isinstance(n, int) and n > 0 else None
    except Exception:
        return None


def peer_pid(sock):
    try:
        if sys.platform == "darwin":
            return struct.unpack("i", sock.getsockopt(0, 0x002, 4))[0]
        if sys.platform.startswith("linux"):
            return struct.unpack("3i", sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))[0]
    except Exception:
        pass
    return None


def build_request(call, kind):
    req = {"t": "notify", "id": "n_" + uuid.uuid4().hex[:24], "kind": kind, "pid": claude_pid()}
    cwd = call.get("cwd")
    if isinstance(cwd, str) and 0 < len(cwd) <= 1000:
        req["cwd"] = cwd
    sid = call.get("session_id")
    if isinstance(sid, str) and 0 < len(sid) <= 100:
        req["session_id"] = sid
    thread = os.environ.get("TALOS_APP_WORKER_THREAD")
    if thread:
        nonce = os.environ.get("TALOS_APP_WORKER_NONCE", "")
        if not nonce:
            return None          # a thread session that cannot prove itself says nothing
        req["thread_id"] = thread
        req["nonce"] = nonce
    return req


def tell_bridge(req):
    deadline = time.monotonic() + total_seconds()
    line = (json.dumps(req, ensure_ascii=True) + "\n").encode("ascii")
    box = os.environ.get("TALOS_TEST_SANDBOX")
    if box:                           # a test (its sandbox folder) never reaches a bridge outside that folder
        home = app_home()
        chosen = "run/hub.sock" if os.path.exists(os.path.join(home, "run/hub.sock")) or not os.path.exists(os.path.join(home, "hub.sock")) else "hub.sock"
        root, here = os.path.realpath(box), os.path.realpath(os.path.join(home, chosen))
        if here != root and not here.startswith(root + os.sep):
            return
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(max(0.05, min(CONNECT_S, deadline - time.monotonic())))
        try:
            old = os.getcwd()
        except OSError:
            old = None
        try:
            os.chdir(app_home())      # a relative name sidesteps the ~104-byte socket path limit
            sock.connect("run/hub.sock" if os.path.exists("run/hub.sock") or not os.path.exists("hub.sock") else "hub.sock")
        finally:
            if old:
                os.chdir(old)
        want, got = bridge_pid(), peer_pid(sock)
        if want is None or got is None or want != got:
            return                    # not the live bridge (or no way to tell): nothing is sent
        sock.sendall(line)
        buf = b""
        while b"\n" not in buf and len(buf) < 4096:
            left = deadline - time.monotonic()
            if left <= 0:
                break                 # the one deadline: the answer decides nothing, so it is not waited for past it
            sock.settimeout(left)
            chunk = sock.recv(1024)
            if not chunk:
                break
            buf += chunk
    except Exception:
        pass
    finally:
        try:
            sock.close()
        except Exception:
            pass


def main():
    try:
        call = json.loads(sys.stdin.read() or "{}")
        if not isinstance(call, dict):
            return
        event = call.get("hook_event_name")
        if event is not None and event != "Notification":
            return
        kind = KINDS.get(call.get("notification_type"))
        if kind is None:
            return
        if os.environ.get("CLAUDE_CODE_SESSION_ATTENDED") == "0":
            return                    # an unattended `claude -p` run has no owner at a terminal
        if os.environ.get("TALOS_APP_WORKER_THREAD") and os.environ.get("TALOS_APP_PERM_HOOK_SOURCE") != "worker":
            return                    # the agent folder's copy in a thread session: the session's own copy speaks
        req = build_request(call, kind)
        if req is None:
            return
        tell_bridge(req)
    except Exception:
        return


if __name__ == "__main__":
    main()
    sys.exit(0)
