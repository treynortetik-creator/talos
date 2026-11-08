#!/usr/bin/env python3
"""permission-relay.py: PermissionRequest hook. Puts a permission prompt that the channel relay does not carry on your phone.

WHY. With "Tool prompts as approval cards" on, Claude Code sends a permission prompt to the Talos app through the channel
relay. Two kinds of prompt never take that road: Claude Code's own built-in ones, such as "Dangerous rm operation on critical
path" (shown even in bypass mode, and blocked by Claude Code itself after about two minutes), and EVERY prompt of a thread's own
session (a thread session is not a channel). Claude Code does run PermissionRequest hooks for them, so this hook hands the call
to the Talos bridge, which raises the same approval card the relay raises, and waits for your answer.

HOW. One JSON line to the bridge's hub socket ($TALOS_APP_HOME/hub.sock, default ~/.config/talos/app): the tool name, the
exact tool input and, in a thread session, that thread's id, nonce and process id (the same proof a thread session gives
the hub). The bridge decides everything else: whether the setting is on, whether the channel relay already carries this very
prompt (then it answers nothing and the relay card is the only one), where the card goes. The answer comes back as one line.

THE ONE RULE. This hook never decides anything itself. It prints a decision ONLY when the bridge answers, for this request id,
exactly "allow" or "deny", which the bridge sends only after your signed answer to the card. Everything else prints nothing and
exits 0: no bridge, no socket, a refusal, a slow bridge, a garbled or unknown answer, an input too big to send, bad input from
Claude Code, an error of any kind. No output means Claude Code's own prompt stays, and its own default applies. It can never
allow on its own and never denies by failing.

TIME. It waits until it is answered or the prompt is over. Claude Code stops the hook (SIGTERM) when the prompt is answered at the
Mac. It does NOT stop it when its own countdown blocks the call (dangerous-rm prompt, 2 minutes; observed on 2.1.318), so the hook
also watches the session transcript for the tool_result of this very call (matched by the tool_use id of the transcript entry
that has this tool name and input) and ends when it appears. It also notices within a second if the process that started it is gone.
The bridge closes the card when the hook's socket closes. The registered timeout (3600 s) is only a backstop and this hook's own
wait is a little shorter, on the monotonic clock, so a clock change or sleep does not stretch it.

WHO IS TALKING. Before it sends anything the hook checks that the process on the other end of hub.sock is the live bridge (the
socket's peer pid must equal the pid in bridge.pid), so a stand-in listener on that path never sees the tool input and never
gets a decision. It stays silent in an unattended `claude -p` run (CLAUDE_CODE_SESSION_ATTENDED=0), where an ask is refused, and
in a thread session it runs only from the copy registered in that session's own settings (TALOS_APP_PERM_HOOK_SOURCE=worker), so
the agent folder's copy of the same hook never raises a second card.
Kill switch: permission-relay.off in the hook state folder, or TALOS_PERMISSION_RELAY_OFF=1.
Python 3.9, standard library only. Test: scripts/test-permission-relay.sh
"""
import json
import os
import socket
import struct
import sys
import time
import uuid

WAIT_S = 3590.0                  # just under the registered 3600 s timeout; Claude Code ends the hook sooner (answered, or its countdown)
CONNECT_S = 2.0
MAX_LINE_BYTES = 250 * 1024      # the hub drops a line over 300 KB; an input this big is never sent, so no card shows half of it

try:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import _talos_common as C  # noqa: E402
    if C.killed("permission-relay.off"):
        sys.exit(0)
except SystemExit:
    raise
except Exception:
    pass
if os.environ.get("TALOS_PERMISSION_RELAY_OFF") == "1":
    sys.exit(0)


def app_home():
    return os.environ.get("TALOS_APP_HOME") or os.path.join(os.path.expanduser("~"), ".config", "talos", "app")


def wait_seconds():
    """The wait, never longer than WAIT_S. TALOS_PERMISSION_HOOK_WAIT_S can only shorten it (tests)."""
    try:
        v = float(os.environ.get("TALOS_PERMISSION_HOOK_WAIT_S", ""))
        if v != v:                    # nan compares false with everything: it must not become a near-zero wait
            return WAIT_S
        return max(0.05, min(v, WAIT_S))
    except ValueError:
        return WAIT_S


def claude_pid():
    """The Claude Code process this hook belongs to. The hook runs in a session of its own, so its own process group is not
    the worker's; the hub checks the pane's group against this pid, and the nonce is the real proof."""
    try:
        n = int(os.environ.get("CLAUDE_PID", ""))
        if n > 0:
            return n
    except ValueError:
        pass
    return os.getppid()


def build_request(call, req_id):
    req = {"t": "perm", "id": req_id, "tool_name": call["tool_name"], "tool_input": call.get("tool_input", {})}
    req["pid"] = claude_pid()
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
            return None          # a thread session that cannot prove itself asks for nothing
        req["thread_id"] = thread
        req["nonce"] = nonce
    return req


def peer_pid(sock):
    """The pid of the process at the other end of a connected unix socket, or None when this platform cannot say."""
    try:
        if sys.platform == "darwin":
            return struct.unpack("i", sock.getsockopt(0, 0x002, 4))[0]        # SOL_LOCAL, LOCAL_PEERPID
        if sys.platform.startswith("linux"):
            return struct.unpack("3i", sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))[0]
    except Exception:
        pass
    return None


def bridge_pid():
    try:
        with open(os.path.join(app_home(), "bridge.pid"), encoding="utf-8") as fh:
            n = json.load(fh).get("pid")
        return n if isinstance(n, int) and n > 0 else None
    except Exception:
        return None


class Watcher:
    """True once the session transcript holds the tool_result of THIS call: the prompt is over, however it ended.

    The call is the transcript's tool_use block with this tool name and input that has no tool_result yet. When more than one
    such block exists (two identical calls at once, in one assistant entry or in separate ones) the hook cannot tell which result
    is its own, so the watcher stays off for good and only Claude Code ending the hook closes the card. Ambiguity is checked
    on every look, so a second identical call that shows up later also turns it off."""

    TAIL = 2 * 1024 * 1024

    def __init__(self, call):
        p = call.get("transcript_path")
        self.path = p if isinstance(p, str) and p else None
        self.name = call.get("tool_name")
        self.input = call.get("tool_input", {})
        self.pending = set()         # ids of matching tool_use blocks with no result yet
        self.mine = None
        self.off = self.path is None
        self.offset = 0
        self.started = False
        self.tries = 0

    def _scan(self, data):
        """Folds the transcript lines in `data` into the pending set. True when a result for `mine` was seen (and still unambiguous)."""
        finished = False
        for raw in data.splitlines():
            try:
                msg = json.loads(raw.decode("utf-8")).get("message") or {}
            except Exception:
                continue
            content = msg.get("content")
            for block in content if isinstance(content, list) else []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use" and block.get("name") == self.name and block.get("input") == self.input \
                        and isinstance(block.get("id"), str):
                    self.pending.add(block["id"])
                elif block.get("type") == "tool_result" and block.get("tool_use_id") in self.pending:
                    if block["tool_use_id"] == self.mine:
                        finished = True
                    self.pending.discard(block["tool_use_id"])
            if len(self.pending) > 1:
                self.off = True      # two identical calls open: whose result is whose cannot be told
        return finished and not self.off

    def done(self):
        try:
            if self.off:
                return False
            size = os.path.getsize(self.path)
            if not self.started:
                self.tries += 1
                if self.tries > 15:          # the transcript never showed the call: rely on Claude Code ending the hook
                    self.off = True
                    return False
                with open(self.path, "rb") as fh:
                    fh.seek(max(0, size - self.TAIL))
                    data = fh.read()
                self.pending = set()
                self._scan(data)
                if len(self.pending) == 1:
                    self.mine = next(iter(self.pending))
                    self.started = True
                    self.offset = size
                return False
            if size <= self.offset:
                return False
            with open(self.path, "rb") as fh:
                fh.seek(self.offset)
                chunk = fh.read(min(size - self.offset, 4 * 1024 * 1024))
            self.offset += len(chunk)
            return self._scan(chunk)
        except Exception:
            return False


def ask_bridge(req, deadline, parent, watcher):
    """The bridge's answer for this request: 'allow', 'deny', or None for anything else."""
    line = (json.dumps(req, ensure_ascii=True) + "\n").encode("ascii")
    if len(line) > MAX_LINE_BYTES:
        return None
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(CONNECT_S)
        try:
            old = os.getcwd()
        except OSError:
            old = None
        try:
            os.chdir(app_home())          # a relative name sidesteps the ~104-byte socket path limit
            sock.connect("hub.sock")
        finally:
            if old:
                os.chdir(old)
        want = bridge_pid()
        got = peer_pid(sock)
        if want is None or got is None or want != got:
            return None                   # not the live bridge (or no way to tell): the tool input is never sent
        sock.sendall(line)
        buf = b""
        while b"\n" not in buf and len(buf) < 4096:
            left = deadline - time.monotonic()
            if left <= 0:
                return None
            if watcher.done():
                return None               # the prompt is over (blocked by Claude Code's own countdown, say): the card must not outlive it
            if os.getppid() != parent:
                return None               # whatever started this hook is gone (Claude Code ended it): do not linger holding the card open
            sock.settimeout(min(left, 1.0))
            try:
                chunk = sock.recv(4096)
            except socket.timeout:
                continue
            if not chunk:
                return None
            buf += chunk
        msg = json.loads(buf.split(b"\n", 1)[0].decode("utf-8"))
    except Exception:
        return None
    finally:
        try:
            sock.close()
        except Exception:
            pass
    if not isinstance(msg, dict) or msg.get("t") != "perm_result" or msg.get("id") != req["id"]:
        return None
    d = msg.get("decision")
    return d if d in ("allow", "deny") else None


def main():
    try:
        call = json.loads(sys.stdin.read() or "{}")
        if not isinstance(call, dict) or not isinstance(call.get("tool_name"), str) or not call["tool_name"]:
            return
        event = call.get("hook_event_name")
        if event is not None and event != "PermissionRequest":
            return
        if "tool_input" in call and not isinstance(call["tool_input"], dict):
            return
        if os.environ.get("CLAUDE_CODE_SESSION_ATTENDED") == "0":
            return                        # an unattended `claude -p` run: an ask stays refused (C3.1)
        if os.environ.get("TALOS_APP_WORKER_THREAD") and os.environ.get("TALOS_APP_PERM_HOOK_SOURCE") != "worker":
            return                        # the agent folder's copy in a thread session: the session's own copy answers
        parent = os.getppid()
        deadline = time.monotonic() + wait_seconds()
        req = build_request(call, "h_" + uuid.uuid4().hex[:24])
        if req is None:
            return
        decision = ask_bridge(req, deadline, parent, Watcher(call))
        if decision == "allow":
            out = {"behavior": "allow"}
        elif decision == "deny":
            out = {"behavior": "deny", "message": "Denied from the Talos app."}
        else:
            return
        sys.stdout.write(json.dumps({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": out}}) + "\n")
        sys.stdout.flush()
    except Exception:
        return


if __name__ == "__main__":
    main()
    sys.exit(0)
