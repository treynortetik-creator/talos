#!/usr/bin/env python3
"""permission-relay.py: PermissionRequest hook. Puts a permission prompt that the channel relay does not carry on your phone.

WHY. With "Tool prompts as approval cards" on, Claude Code sends a permission prompt to the Talos app through the channel
relay. Two kinds of prompt never take that road: Claude Code's own built-in ones, such as "Dangerous rm operation on critical
path" (shown even in bypass mode, and blocked by Claude Code itself after about two minutes), and EVERY prompt of a thread's own
session (a thread session is not a channel). Claude Code does run PermissionRequest hooks for them, so this hook hands the call
to the Talos bridge, which raises the same approval card the relay raises, and waits for your answer.

HOW. One JSON line to the bridge's hub socket ($TALOS_APP_HOME/run/hub.sock, default ~/.config/talos/app): the tool name, the
exact tool input and, in a thread session, that thread's id, nonce and process id (the same proof a thread session gives
the hub). The bridge decides everything else: whether the setting is on, whether the channel relay already carries this very
prompt (then it answers nothing and the relay card is the only one), where the card goes. The answer comes back as one line.

THE ONE RULE. This hook never decides anything itself. It prints a decision ONLY when the bridge answers, for this request id,
exactly "allow" or "deny", which the bridge sends only after your signed answer to the card. Everything else prints nothing and
exits 0: no bridge, no socket, a refusal, a slow bridge, a garbled or unknown answer, an input too big to send, bad input from
Claude Code, an error of any kind. No output means Claude Code's own prompt stays, and its own default applies. It can never allow on its own and never denies by failing.

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
A test sets TALOS_TEST_SANDBOX to its temp folder, and the hook then never connects to a hub outside it.
Kill switch: permission-relay.off in the hook state folder, or TALOS_PERMISSION_RELAY_OFF=1. Python 3.9, standard library only. Test: scripts/test-permission-relay.sh
"""
import hashlib
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
    C = None                     # no helper: no Deny note, no permission mode, the old deny message (the hook runs without it)
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
    req.update(C.request_extras(call) if C else {})     # the session's permission mode, for "why it asked"
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
    """The bridge's answer for this request: 'allow', 'deny', or None for anything else. With a deny, the owner's cleaned note (if any) is left in req["_notes"]."""
    line = (json.dumps(req, ensure_ascii=True) + "\n").encode("ascii")
    if len(line) > MAX_LINE_BYTES:
        return None
    box = os.environ.get("TALOS_TEST_SANDBOX")
    if box:                           # a test (its sandbox folder) never reaches a bridge outside that folder
        home = app_home()
        chosen = "run/hub.sock" if os.path.exists(os.path.join(home, "run/hub.sock")) or not os.path.exists(os.path.join(home, "hub.sock")) else "hub.sock"
        root, here = os.path.realpath(box), os.path.realpath(os.path.join(home, chosen))   # the socket itself, links followed
        if here != root and not here.startswith(root + os.sep):
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
            # run/hub.sock since the socket left home (Bun on Linux cannot watch a folder holding one); hub.sock, where it
            # was, only while the new one is not there (a bridge not yet restarted), for one release
            sock.connect("run/hub.sock" if os.path.exists("run/hub.sock") or not os.path.exists("hub.sock") else "hub.sock")
        finally:
            if old:
                os.chdir(old)
        want = bridge_pid()
        got = peer_pid(sock)
        if want is None or got is None or want != got:
            return None                   # not the live bridge (or no way to tell): the tool input is never sent
        sock.sendall(line)
        buf = b""
        while b"\n" not in buf and len(buf) < 16384:     # room for a deny with the owner's 400-character note (~5 KB as escapes)
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
    req["_notes"] = C.deny_notes(msg) if d == "deny" and C else []      # only with a deny; beside an allow it is never read
    return d if d in ("allow", "deny") else None


# The Mac's thread sessions name their folder here (TALOS_APP_HOOK_CHECK_DIR, written into the command by the app). Its Claude Code
# files, and those of every folder above it up to its git root and of its git roots, are looked at again at prompts (the walk is
# kept between them, `folder_check`). Only a session in the agent folder (TALOS_APP_HOOK_CHECK_HOOKS=0) loads them, so there a
# finding REFUSES; a thread folder's session starts with `--setting-sources user` and loads none, so there each is a WARNING (one
# stderr line, and the prompt goes on). The findings:
#  `.claude`, anything under it, `.mcp.json` or `.env` that is a link; a subagent, skill or command whose frontmatter has hooks,
#  allowed-tools, its own MCP servers or permission mode, or cannot be read for certain; more files than are looked at; a git
#  pointer that cannot be followed the way Claude Code follows it; a `.claude/settings(.local).json` carrying more than the lists
#  below (in the agent folder itself, the kit's own hooks and status line excepted). A refusal: the prompt stays at the terminal,
#  the bridge is never asked, one line says why.
# This stops only an honest hook: one whose shell was already steered never runs this. Unset (Linux, main's own session): nothing
# is read. The lists and the reader are the app's (WorkerHookFolder.swift, WorkerFolderTree.swift, FrontmatterScan.swift;
# swift-parity.test.ts holds the lists equal, and both suites run kit/scripts/frontmatter-cases.json).
ALLOWED_ENV = frozenset((
    "BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS", "BASH_MAX_OUTPUT_LENGTH", "MAX_THINKING_TOKENS", "MAX_MCP_OUTPUT_TOKENS", "MCP_TIMEOUT",
    "MCP_TOOL_TIMEOUT", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR", "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_TELEMETRY", "DISABLE_AUTOUPDATER", "DISABLE_ERROR_REPORTING", "DISABLE_BUG_COMMAND",
    "DISABLE_COST_WARNINGS", "DISABLE_NON_ESSENTIAL_MODEL_CALLS", "DISABLE_PROMPT_CACHING",
))
ALLOWED_KEYS = frozenset((
    "$schema", "env", "permissions", "model", "includeCoAuthoredBy", "alwaysThinkingEnabled", "outputStyle",
    "claudeMdExcludes", "skillOverrides",
))
ALLOWED_PERMISSION_KEYS = frozenset(("deny", "ask", "defaultMode"))  # the session's own --settings names main's mode and outranks it
REFUSED_FRONTMATTER_KEYS = frozenset(("hooks", "allowed-tools", "mcpServers", "permissionMode"))
TREE_ENTRIES_CAP = 5000
TREE_DEPTH_CAP = 24


def _norm_key(k):
    return k.lower().replace("-", "").replace("_", "")


def _shown(k):
    ok = isinstance(k, str) and 0 < len(k.encode("utf-8")) <= 64 and all(c.isascii() and (c.isalnum() or c in "_$.-") for c in k)
    return k if ok else "a key that is not a plain name"


SETTINGS_CAP = 256 * 1024


def _read_small(path, cap, dir_fd=None):
    """The bytes of a regular file that is not a link, of at most `cap` bytes, through one descriptor that never blocks, else None:
    a FIFO, a device or a huge file at a settings path cannot hold the hook."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=dir_fd)
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not stat_is_reg(st.st_mode) or st.st_size > cap:
            return None
        data = os.read(fd, cap + 1)
        return data if len(data) <= cap else None
    except OSError:
        return None
    finally:
        os.close(fd)


def stat_is_reg(mode):
    return (mode & 0o170000) == 0o100000


def stat_is_dir(mode):
    return (mode & 0o170000) == 0o040000


def stat_is_lnk(mode):
    return (mode & 0o170000) == 0o120000


def _lexical(p):
    parts = []
    for c in p.split("/"):
        if c in ("", "."):
            continue
        if c == "..":
            if parts:
                parts.pop()
            continue
        parts.append(c)
    return "/" + "/".join(parts)


def _pointer(raw, base):
    """A path a git pointer file names: its whole text trimmed, from `base` when relative, resolved by its text alone, and only when
    that is where it really is (no link on the way). None for a control character or any non-ASCII space (U+0085, U+2028, U+2029,
    U+00A0 ...): Claude Code trims some of those and not others."""
    text = raw.strip(" \t\n\r\f\v")       # ASCII only: Claude Code's trim takes more, so what is left of it is refused below
    if not text or any(ord(c) < 0x20 or ord(c) == 0x7F or (not c.isascii() and c.isspace()) for c in text):
        return None
    lex = _lexical(text if text.startswith("/") else base + "/" + text)
    return lex if os.path.realpath(lex) == lex else None


def _git_roots(folder):
    """The git roots whose settings Claude Code reads for `folder`: the nearest folder with a .git, and when that .git is a file
    (a linked worktree) the canonical root it leads to (.git -> gitdir -> commondir), followed as Claude Code follows it: the whole
    trimmed text after `gitdir:`, each path resolved by its text, and each step where its text says. (roots, problem)."""
    d = os.path.realpath(folder)
    while not os.path.lexists(os.path.join(d, ".git")):
        up = os.path.dirname(d)
        if up == d:
            return [], None
        d = up
    dot = os.path.join(d, ".git")
    broken = "the git repository at %s points somewhere that cannot be followed" % dot
    if os.path.islink(dot):
        return [d], "%s is a link" % dot
    if os.path.isdir(dot):
        return [d], None
    raw = _read_small(dot, 4096)
    try:
        text = (raw or b"").decode("utf-8")
    except UnicodeDecodeError:
        return [d], broken
    if not text.startswith("gitdir:"):
        return [d], broken
    gitdir = _pointer(text[len("gitdir:"):], d)
    if gitdir is None or not os.path.isdir(gitdir):
        return [d], broken
    common_file = os.path.join(gitdir, "commondir")
    if not os.path.lexists(common_file):
        return [d], None
    raw = _read_small(common_file, 4096)
    try:
        common = _pointer((raw or b"").decode("utf-8"), gitdir) if raw is not None else None
    except UnicodeDecodeError:
        common = None
    if common is None or not os.path.isdir(common):
        return [d], broken
    if os.path.basename(common) != ".git":
        return [d], None
    canonical = os.path.dirname(common)
    if os.path.realpath(canonical) != canonical:
        return [d], broken
    return ([d] if canonical == d else [d, canonical]), None


def _config_folders(folder):
    """The folder, every folder above it up to its git root, and its git roots, as real paths. (folders, problem)."""
    me = os.path.realpath(folder)
    roots, problem = _git_roots(folder)
    out = [me]
    if roots and me != roots[0] and me.startswith("/" if roots[0] == "/" else roots[0] + "/"):
        d = os.path.dirname(me)
        while d != roots[0] and len(d) > len(roots[0]):
            out.append(d)
            d = os.path.dirname(d)
    out += [r for r in roots if r not in out]
    return out, problem


class _Unclear(Exception):
    pass


def frontmatter_keys(text):
    """The top-level keys of a Markdown file's YAML frontmatter, or raises _Unclear (FrontmatterScan.swift is the same reader)."""
    if text.startswith("﻿"):
        text = text[1:]
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    if not lines[0].startswith("---"):
        return []
    if lines[0].strip(" \t") != "---":
        raise _Unclear("its first line starts a frontmatter block that is not plain ---")
    end = None
    for k in range(1, len(lines)):
        t = lines[k].strip(" \t")
        if t == "---":
            end = k
            break
        if t == "...":
            raise _Unclear("its frontmatter has a ... line")
    if end is None:
        raise _Unclear("its frontmatter has no closing ---")
    body = "\n".join(lines[1:end])
    for c in body:
        o = ord(c)
        if (o < 0x20 and c not in "\t\n") or o in (0x7F, 0x85, 0x2028, 0x2029, 0xFEFF):
            raise _Unclear("its frontmatter has the character U+%04X" % o)
    return _FrontReader(body).block()


class _FrontReader(object):
    def __init__(self, t):
        self.t = t
        self.n = len(t)

    def line_end(self, i):
        j = self.t.find("\n", i)
        return self.n if j < 0 else j

    def blank(self, a, b):
        return all(c in " \t" for c in self.t[a:b])

    def rest_is_nothing(self, a, b):
        j = a
        while j < b and self.t[j] in " \t":
            j += 1
        return j == b or self.t[j] == "#"

    def block(self):
        t = self.t
        keys = []
        top = None
        block_indent = None
        pos = 0
        while pos <= self.n:
            le = self.line_end(pos)
            k = pos
            while k < le and t[k] == " ":
                k += 1
            indent = k - pos
            if self.blank(pos, le):
                pos = le + 1
                continue
            if t[k] == "\t":
                raise _Unclear("its frontmatter has a tab in an indentation")
            if block_indent is not None:
                if indent > block_indent:
                    pos = le + 1
                    continue
                block_indent = None
            if t[k] == "#":
                pos = le + 1
                continue
            if top is None:
                top = indent
                if t[k] in "{[":
                    return self.flow_document(k)
            if indent < top:
                raise _Unclear("its frontmatter has a line less indented than its first")
            if indent == top:
                got = self.key_at(k, le, True)
                if got is None:
                    raise _Unclear("its frontmatter has a top-level line that is not a key")
                keys.append(got[0])
                v = got[1]
            else:
                q = k
                while q < le and t[q] == "-" and (q + 1 == le or t[q + 1] in " \t"):
                    q += 1
                    while q < le and t[q] in " \t":
                        q += 1
                got = self.key_at(q, le, False)
                v = got[1] if got else q
            kind, last = self.value(v, le, top)
            if kind == "block":
                block_indent = indent
                pos = le + 1
            elif kind == "until":
                pos = last + 1
            else:
                pos = le + 1
        return keys

    def key_at(self, k, le, strict):
        t = self.t
        if k >= le:
            return None
        c = t[k]
        if c in "\"'":
            j = k + 1
            key = []
            while True:
                if j >= le:
                    return None
                if c == '"' and t[j] == "\\":
                    if strict:
                        raise _Unclear("its frontmatter has a key with an escape")
                    return None
                if t[j] == c:
                    if c == "'" and j + 1 < le and t[j + 1] == "'":
                        key.append("'")
                        j += 2
                        continue
                    break
                key.append(t[j])
                j += 1
            j += 1
            while j < le and t[j] in " \t":
                j += 1
            if j >= le or t[j] != ":":
                return None
            return "".join(key), j + 1
        nxt = t[k + 1] if k + 1 < le else None
        if c in "-?:" and (nxt is None or nxt in " \t"):
            return None
        if c in ",[]{}#&*!|>%@`":
            return None
        j = k
        while j < le:
            if t[j] == ":" and (j + 1 == le or t[j + 1] in " \t"):
                return t[k:j].strip(" \t"), j + 1
            if t[j] == "#" and j > k and t[j - 1] in " \t":
                return None
            j += 1
        return None

    def value(self, v, le, top):
        t = self.t
        while v < le and t[v] in " \t":
            v += 1
        if v == le or t[v] == "#":
            return "line", None
        c = t[v]
        if c in "\"'":
            close = self.quoted(v)
        elif c in "[{":
            close = self.flow_node(v, None) - 1
        elif c in "|>":
            j = v + 1
            while j < le and ("0" <= t[j] <= "9" or t[j] in "+-"):
                j += 1
            if not (j == le or (t[j] in " \t" and self.rest_is_nothing(j, le))):
                raise _Unclear("its frontmatter has a block scalar header it cannot read")
            return "block", None
        elif c in "&*!%@`":
            raise _Unclear("its frontmatter has an anchor, alias, tag or reserved character")
        else:
            return "line", None
        if close < le:
            return "line", None
        self.span_stays_right(le, close, top)
        last = self.line_end(close)
        if not self.rest_is_nothing(close + 1, last):
            raise _Unclear("its frontmatter has text after a value that spans lines")
        return "until", last

    def span_stays_right(self, start, end, top):
        t = self.t
        for j in range(start, end):
            if t[j] == "\n":
                k = j + 1
                while k < self.n and t[k] == " ":
                    k += 1
                le = self.line_end(j + 1)
                if not self.blank(j + 1, le) and k - (j + 1) <= top:
                    raise _Unclear("its frontmatter has a quote or a flow collection open at a top-level line")

    def quoted(self, q):
        t = self.t
        c = t[q]
        j = q + 1
        while j < self.n:
            if c == '"' and t[j] == "\\":
                j += 2
                continue
            if t[j] == c:
                if c == "'" and j + 1 < self.n and t[j + 1] == "'":
                    j += 2
                    continue
                return j
            j += 1
        raise _Unclear("its frontmatter has a quote that never closes")

    def flow_document(self, k):
        if self.t[k] != "{":
            raise _Unclear("its frontmatter is a flow sequence, not a mapping")
        keys = []
        j = self.skip_space(self.flow_node(k, keys))
        if j < self.n:
            raise _Unclear("its frontmatter has text after its flow mapping")
        return keys

    def skip_space(self, j):
        t = self.t
        while j < self.n:
            if t[j] in " \t\n":
                j += 1
            elif t[j] == "#" and (j == 0 or t[j - 1] in " \t\n"):
                while j < self.n and t[j] != "\n":
                    j += 1
            else:
                return j
        return j

    def flow_node(self, j, keys):
        """One flow node at `j`; the index just past it. `keys`: a list for this mapping's own keys, or None."""
        t = self.t
        never = "its frontmatter has a flow collection that never closes"
        j = self.skip_space(j)
        if j >= self.n:
            raise _Unclear(never)
        c = t[j]
        if c in "\"'":
            return self.quoted(j) + 1
        if c in "[{":
            closer = "]" if c == "[" else "}"
            j += 1
            while True:
                j = self.skip_space(j)
                if j >= self.n:
                    raise _Unclear(never)
                if t[j] == closer:
                    return j + 1
                start = j
                if t[j] == "?" and j + 1 < self.n and t[j + 1] in " \t\n":
                    raise _Unclear("its frontmatter has an explicit key")
                j = self.flow_node(j, None)
                if keys is not None:
                    key = self.flow_key_text(start, j)
                    if key is None:
                        raise _Unclear("its frontmatter has a flow key it cannot read")
                    keys.append(key)
                j = self.skip_space(j)
                if j < self.n and t[j] == ":":
                    j = self.skip_space(j + 1)
                    if j < self.n and t[j] not in (",", closer):
                        j = self.flow_node(j, None)
                    j = self.skip_space(j)
                if j >= self.n:
                    raise _Unclear(never)
                if t[j] == ",":
                    j += 1
                elif t[j] != closer:
                    raise _Unclear("its frontmatter has a flow collection it cannot read")
        if c in "&*!|>%@`],}":
            raise _Unclear("its frontmatter has an anchor, alias, tag or reserved character")
        while j < self.n:
            d = t[j]
            if d in ",[]{}":
                return j
            if d == ":" and (j + 1 >= self.n or t[j + 1] in " \t\n,[]{}"):
                return j
            if d == "#" and j > 0 and t[j - 1] in " \t\n":
                return j
            j += 1
        return j

    def flow_key_text(self, a, b):
        t = self.t
        c = t[a]
        if c in "\"'":
            inner = t[a + 1:b - 1]
            if "\n" in inner or (c == '"' and "\\" in inner):
                return None
            return inner.replace("''", "'") if c == "'" else inner
        if c in "[{":
            return None
        key = t[a:b].strip(" \t\n")
        return None if "\n" in key else key


def _link_line(path):
    return "%s is a link, which a thread session's Claude Code files may not be" % path


def _loaded_kind(area, name):
    lower = name.lower()
    if area == "agents" and lower.endswith(".md"):
        return "subagent"
    if area == "commands" and lower.endswith(".md"):
        return "command"
    if area == "skills" and lower == "skill.md":
        return "skill"
    return None


def _walk(fd, path, area, depth, seen):
    if depth > TREE_DEPTH_CAP:
        return "%s cannot be read" % path
    try:
        names = sorted(os.listdir(fd))
    except OSError:
        return "%s cannot be read" % path
    for name in names:
        seen[0] += 1
        if seen[0] > TREE_ENTRIES_CAP:
            return "%s has more files than are checked (%d)" % (path, TREE_ENTRIES_CAP)
        full = path + "/" + name
        try:
            st = os.stat(name, dir_fd=fd, follow_symlinks=False)
        except OSError:
            return "%s cannot be read" % full
        if stat_is_lnk(st.st_mode):
            return _link_line(full)
        if stat_is_dir(st.st_mode):
            if area is None and name.lower() == "worktrees":
                continue
            try:
                sub = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except OSError:
                return "%s cannot be read" % full
            try:
                why = _walk(sub, full, area or name.lower(), depth + 1, seen)
            finally:
                os.close(sub)
            if why:
                return why
            continue
        kind = _loaded_kind(area, name)
        if kind is None:
            continue
        data = _read_small(name, SETTINGS_CAP, dir_fd=fd)
        try:
            text = data.decode("utf-8") if data is not None else None
        except UnicodeDecodeError:
            text = None
        if text is None:
            return "the %s %s cannot be read" % (kind, full)
        try:
            keys = frontmatter_keys(text)
        except _Unclear as e:
            return "the %s %s cannot be read for certain (%s)" % (kind, full, e)
        for k in keys:
            if _norm_key(k) in {_norm_key(r) for r in REFUSED_FRONTMATTER_KEYS}:
                return "the %s %s has %s of its own" % (kind, full, _shown(k))
    return None


def folder_files_problem(folder):
    """A link at .claude, under it, at .mcp.json or .env, or a subagent, skill or command that refuses (WorkerFolderTree.swift)."""
    try:
        dfd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY)
    except OSError:
        return None
    try:
        for name in (".mcp.json", ".env", ".claude"):
            try:
                st = os.stat(name, dir_fd=dfd, follow_symlinks=False)
            except OSError:
                continue
            if stat_is_lnk(st.st_mode):
                return _link_line(folder + "/" + name)
        try:
            st = os.stat(".claude", dir_fd=dfd, follow_symlinks=False)
        except OSError:
            return None
        if not stat_is_dir(st.st_mode):
            return None
        try:
            cfd = os.open(".claude", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dfd)
        except OSError:
            return "%s/.claude cannot be opened" % folder
        try:
            return _walk(cfd, folder + "/.claude", None, 0, [0])
        finally:
            os.close(cfd)
    finally:
        os.close(dfd)


def _file_problem(path, kit_owned):
    if not os.path.lexists(path):
        return None
    data = _read_small(path, SETTINGS_CAP)
    if data is None:
        return "%s cannot be read as settings" % path
    if not data.strip():
        return None
    try:
        obj = json.loads(data.decode("utf-8"))
    except Exception:
        obj = None
    if not isinstance(obj, dict):
        return "%s cannot be read as settings" % path
    env = obj.get("env")
    if env is not None:
        if not isinstance(env, dict):
            return "%s cannot be read as settings" % path
        for k in sorted(env):
            v = env[k]
            if k not in ALLOWED_ENV or not isinstance(v, (str, int, float)):      # a bool is an int here, as it is a number in the app
                return "%s sets %s for the session" % (path, _shown(k))
    if kit_owned:
        return None
    for k in sorted(obj):
        if k not in ALLOWED_KEYS:
            return "%s has %s" % (path, _shown(k))
    perms = obj.get("permissions")
    if perms is not None:
        if not isinstance(perms, dict):
            return "%s cannot be read as settings" % path
        for k in sorted(perms):
            if k not in ALLOWED_PERMISSION_KEYS:
                return "%s has permissions.%s" % (path, _shown(k))
    return None


FOLDER_CACHE_TTL_S = 60.0


def _folder_findings(folder, agent):
    """(refusal, warnings): in the agent folder the first finding refuses; in a thread folder every finding is a warning."""
    folders, problem = _config_folders(folder)
    findings = [problem] if problem else []
    for f in folders:
        why = folder_files_problem(f)
        if why:
            findings.append(why)
    for n, f in enumerate(folders):
        for name in ("settings.json", "settings.local.json"):
            why = _file_problem(os.path.join(f, ".claude", name), agent and n == 0)
            if why:
                findings.append(why)
    if agent and findings:
        return findings[0], []
    return None, findings


def _sig(path):
    try:
        st = os.stat(path, follow_symlinks=False)
        return [st.st_mode, st.st_ino, st.st_mtime_ns, st.st_size]
    except OSError:
        return None


def _cache_key(folder, agent):
    """What the last walk's answer depends on, cheaply: each folder's own entry, its .claude, .git, .mcp.json, .env and settings
    files, and the entries of its agents, commands and skills folders (a skill's SKILL.md too), by type, inode, mtime and size.
    A change deeper down is caught within FOLDER_CACHE_TTL_S, when the tree is walked again whatever the key says."""
    folders, problem = _config_folders(folder)
    sig = [folder, agent, problem]
    for f in folders:
        sig.append([f, _sig(f)])
        for n in (".claude", ".git", ".mcp.json", ".env", ".claude/settings.json", ".claude/settings.local.json",
                  ".claude/agents", ".claude/commands", ".claude/skills"):
            sig.append([n, _sig(os.path.join(f, n))])
        for sub in ("agents", "commands", "skills"):
            d = os.path.join(f, ".claude", sub)
            try:
                names = sorted(os.listdir(d))[:TREE_ENTRIES_CAP]
            except OSError:
                continue
            for nm in names:
                sig.append([sub, nm, _sig(os.path.join(d, nm))])
                if sub == "skills":
                    sig.append([sub, nm, "SKILL.md", _sig(os.path.join(d, nm, "SKILL.md"))])
    return hashlib.sha256(json.dumps(sig).encode("utf-8")).hexdigest()


def _cache_path(folder, agent):
    """The cache file in the hook's own folder of the Talos home, or None when that folder is not there (it is never made here)."""
    # on a Talos distro the hook runs root's file in place: a cache in the talos user's home is never trusted (Fable R3-4)
    if os.environ.get("TALOS_APP_HOOK_ROOTED") == "1":
        return None
    d = os.path.join(app_home(), "workers", "_hook")
    if not os.path.isdir(d) or os.path.islink(d):
        return None
    name = hashlib.sha256(("%s\0%d" % (folder, 1 if agent else 0)).encode("utf-8")).hexdigest()[:32]
    return os.path.join(d, "folder-check-%s.json" % name)


def folder_check():
    """(refusal, warnings) for the folder the Mac named, or (None, []) when it named none. The walk is kept between prompts in a
    small file (`_cache_path`) and done again only when `_cache_key` changes or the answer is FOLDER_CACHE_TTL_S old (a clock that
    went back counts as old; the clock is the one since boot, so a new boot reads as old too). Like the rest of this check, it stops only an honest session: one that can write the Talos home can
    write this file too."""
    folder = os.environ.get("TALOS_APP_HOOK_CHECK_DIR")
    if not folder:
        return None, []
    agent = os.environ.get("TALOS_APP_HOOK_CHECK_HOOKS") == "0"
    try:
        key = _cache_key(folder, agent)
        path = _cache_path(folder, agent)
    except Exception:
        key, path = None, None
    if path and key:
        raw = _read_small(path, 64 * 1024)
        try:
            c = json.loads(raw.decode("utf-8")) if raw else None
            age = time.monotonic() - float(c["at"])
            if c["key"] == key and 0 <= age < FOLDER_CACHE_TTL_S and isinstance(c["warnings"], list):
                return c["refusal"], [str(w) for w in c["warnings"]]
        except Exception:
            pass
    refusal, warnings = _folder_findings(folder, agent)
    if path and key:
        tmp = "%s.%d.tmp" % (path, os.getpid())
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump({"key": key, "at": time.monotonic(), "refusal": refusal, "warnings": warnings}, fh)
            os.replace(tmp, path)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    return refusal, warnings


def folder_settings_problem():
    return folder_check()[0]


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
        unsafe, ignored = folder_check()
        if unsafe:
            sys.stderr.write("talos permission hook: %s, so this prompt stays at the terminal (restart the thread's session once the file is fixed)\n" % unsafe)
            return
        for why in ignored:
            sys.stderr.write("talos permission hook: %s; a thread session does not load that file, so it is ignored\n" % why)
        parent = os.getppid()
        deadline = time.monotonic() + wait_seconds()
        req = build_request(call, "h_" + uuid.uuid4().hex[:24])
        if req is None:
            return
        decision = ask_bridge(req, deadline, parent, Watcher(call))
        if decision == "allow":
            out = {"behavior": "allow"}
        elif decision == "deny":
            out = {"behavior": "deny", "message": C.deny_message(req.get("_notes", [])) if C else "Denied from the Talos app."}   # + the owner's note, if any
        else:
            return
        sys.stdout.write(json.dumps({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": out}}) + "\n")
        sys.stdout.flush()
    except Exception:
        return


if __name__ == "__main__":
    main()
    sys.exit(0)
