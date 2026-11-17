#!/usr/bin/env python3
"""action-rules.py: one table for "just do it" vs "ask me first" vs "never".

WHY. The never/ask rules of an agent tend to be scattered prose ("deploys only when I say ship", "I draft, I post",
"kill by PID"). Prose has no instant at which it fires; a table read by a PreToolUse hook does. The table is YAML:
`hooks/action-rules.yaml` ships a generic starter set; yours go in `~/.config/talos/action-rules.yaml` and are read
FIRST, so an upgrade of the kit never overwrites them and you can override a starter rule there.

DECISIONS
  never  always refused. The reason comes back to the agent, which should tell you and stop.
  ask    live session: Claude Code's own permission prompt (you click yes or no). Unattended run (Chronos, nobody to
         answer): refused. With the Talos app, `approve <id>` (below) puts a card with the exact call on your phone and your
         tap grants ONE use of exactly that call. Some starter rules carry a `kind` (deploy, push = a git push to main, publish, `send` = email for a
         mail tool, else message): a kind you "Always allow" in Talos goes through without a card, with a line in the
         thread, as on the agent's own cards. The bridge decides the kind from its own copy of the starter rules and only
         for a call that matches the rule; a `kind` in your own rules file is not used for that (anything can edit it).
  allow  a rule that matches first and lets the call through (use it in your own file to carve out an exception). The rules are read in
         order, yours first: a never refuses at once, and an allow lets the call through only if no ask rule matched before it.
  Anything no rule matches is allowed: this hook adds friction to what you list, it is not a sandbox.

MATCHING
  tool     regex, FULL match on the tool name ("Bash", "mcp__.*__send_message", "Write|Edit").
  command  Bash only: regex SEARCHED in the command text, anchored to command position by the starter rules
           (start of line, or after ; & | ( or a backquote) so a phrase quoted inside an echo, a log line or a
           commit message does not trip a rule. Both given = both must match. The text searched is the working
           directory, a newline, then the command, so a rule can key on the folder too.
  path     Write/Edit/MultiEdit/NotebookEdit: regex searched in the file path.

ROLES (argv[1])
  check (default)  PreToolUse: read the hook payload on stdin, print the verdict JSON ({} = allow).
  approve ID [MIN] ["NOTE"]
                   WITH THE TALOS APP (audit item 28, Pantheon 2026-11-15): asks the bridge over its hub socket for an
                   "Allow once" card showing the call this rule last stopped, and waits for your tap (about two minutes;
                   the card stays open after that). Your signed tap is the approval, and the bridge keeps it, never a file
                   here: the check asks the bridge for an approval of exactly this call, from this same session, and uses
                   it up. MIN and NOTE are ignored. Nothing a session runs or writes can make one; no bridge, no approval.
                   WITHOUT THE APP (a kit on its own): records a one-use approval of rule ID (default 15 minutes, at most
                   120); the NOTE (your words, where you said yes) is required. That is an honour-system switch, because an
                   agent with a shell can run it too: prefer the native prompt.
  list             print the rules and any live approvals
  test             parse the rule files and report errors (exit 1 on any)

LOG: <state>/action-rules.jsonl (rule id, tool, decision; never the command text).
Kill switch: action-rules.off. This is a safety guard: it fails OPEN in a live session and CLOSED when unattended.
Python 3.9, standard library only. A tiny built-in reader handles the YAML subset used here; PyYAML is used if present.
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import _talos_common as C  # noqa: E402
except Exception as _e:        # helpers will not load: fail open live, CLOSED unattended
    if os.environ.get("CHRONOS_RUN") == "1" or os.environ.get("TALOS_UNATTENDED") == "1":
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
              "permissionDecisionReason": "Talos action-rules could not load hooks/_talos_common.py (%s) and this run is unattended, so the action is blocked rather than allowed unchecked." % type(_e).__name__}}))
    else:
        print("{}")
    sys.exit(0)

KILL_NAME = "action-rules.off"
SHIPPED = os.path.join(os.path.dirname(os.path.abspath(__file__)), "action-rules.yaml")
USER_RULES = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "talos", "action-rules.yaml")
MAX_FILE = 200000
DECISIONS = ("never", "ask", "allow")


# --------------------------------------------------------------------------- the YAML subset
def _unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] == "'":
        return v[1:-1].replace("''", "'")
    if len(v) >= 2 and v[0] == v[-1] == '"':
        try:
            return json.loads(v)
        except Exception:
            return v[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    v = re.sub(r"\s+#.*$", "", v)          # a trailing comment on a plain scalar
    return v.strip()


def parse_rules(text):
    """Parse the `rules:` list: `- key: value` items, scalars plain / 'single' / "double" quoted. No anchors, no
    flow style, no multi-line scalars. Returns a list of dicts; raises ValueError with a line number on a bad line."""
    try:
        import yaml  # optional
        d = yaml.safe_load(text) or {}
        rules = d.get("rules") if isinstance(d, dict) else None
        if rules is None:
            return []
        if not isinstance(rules, list) or not all(isinstance(r, dict) for r in rules):
            raise ValueError("`rules:` must be a list of mappings")
        return [{str(k): ("" if v is None else str(v)) for k, v in r.items()} for r in rules]
    except ImportError:
        pass
    rules, cur, seen_rules = [], None, False
    for n, raw in enumerate(text.splitlines(), 1):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        if re.match(r"^rules:\s*(#.*)?$", raw):
            seen_rules = True
            continue
        m = re.match(r"^\s*-\s+([A-Za-z_][\w-]*):\s*(.*)$", raw)
        if m:
            if not seen_rules:
                raise ValueError("line %d: a rule before `rules:`" % n)
            cur = {m.group(1): _unquote(m.group(2))}
            rules.append(cur)
            continue
        m = re.match(r"^\s+([A-Za-z_][\w-]*):\s*(.*)$", raw)
        if m and cur is not None:
            cur[m.group(1)] = _unquote(m.group(2))
            continue
        raise ValueError("line %d: cannot read %r (the reader supports `- key: value` items under `rules:`)" % (n, raw.strip()[:60]))
    return rules


def load_file(path):
    try:
        if os.path.getsize(path) > MAX_FILE:
            raise ValueError("%s is larger than %d bytes" % (path, MAX_FILE))
        with open(path, encoding="utf-8") as fh:
            return parse_rules(fh.read())
    except FileNotFoundError:
        return []


def load_rules():
    """Your rules first, then the shipped starter set. A bad rule file raises (the caller decides what failing means)."""
    return load_file(USER_RULES) + load_file(SHIPPED)


def valid_rule(r):
    return r.get("decision") in DECISIONS and bool(r.get("id")) and bool(r.get("tool") or r.get("command") or r.get("path"))


# --------------------------------------------------------------------------- matching
def match(rule, tool, text, path):
    t = rule.get("tool")
    if t and not re.fullmatch(t, tool):
        return False
    c = rule.get("command")
    if c:
        if text is None or not re.search(c, text):
            return False
    p = rule.get("path")
    if p:
        if not path or not re.search(p, path):
            return False
    return bool(t or c or p)


# --------------------------------------------------------------------------- approvals
def appr_dir():
    return os.path.join(C.state_dir(), "approvals")


def safe_id(rid):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", str(rid))[:80]


def ask_dir():
    return os.path.join(C.state_dir(), "asks")


MAX_CALL_BYTES = 250 * 1024   # the hub drops a line over 300 KB; a call this big is never sent, so no card shows half of it


def note_ask(rid, call=None):
    """Remember the call rule rid last stopped (tool, input, folder), so `approve` can put exactly that on the owner's card.
    A session can rewrite this file, but whatever it writes is what the card shows and the only call the tap approves."""
    p = os.path.join(ask_dir(), safe_id(rid) + ".json")
    os.makedirs(ask_dir(), exist_ok=True)
    C.save_json(p, dict(call or {}, at=time.time()))


def asked_call(rid):
    d = C.load_json(os.path.join(ask_dir(), safe_id(rid) + ".json")) or {}
    try:
        if time.time() - float(d.get("at", 0)) > ASK_KEEP_S:
            return None
    except (TypeError, ValueError):
        return None
    return d if d.get("tool_name") else None


def take_approval(rid):
    """Consume a live one-use approval for rule rid. Returns the record, or None."""
    p = os.path.join(appr_dir(), safe_id(rid) + ".json")
    d = C.load_json(p)
    if not d:
        return None
    C.drop(p)                                    # one use, consumed even if expired
    if time.time() > float(d.get("until", 0)):
        return None
    return d


# --------------------------------------------------------------------------- the hook
def verdict(decision, reason):
    print(C.pretool_json(decision, reason))


def check():
    C.arm_guard_timeout("action-rules")
    if C.killed(KILL_NAME):
        print("{}")
        return
    data = C.read_stdin()
    tool = str(data.get("tool_name") or "")
    ti = data.get("tool_input") or {}
    if not tool or not isinstance(ti, dict):
        print("{}")
        return
    text = None
    if tool == "Bash":
        text = str(data.get("cwd") or "") + "\n" + str(ti.get("command") or "")
    path = str(ti.get("file_path") or ti.get("notebook_path") or ti.get("path") or "")
    # ONE pass in file order (yours first, then the starter set): a never denies at once; the first ask is remembered and the
    # scan goes on, so a later never still wins; an allow returns only when no ask has been seen before it; at the end a
    # remembered ask asks. So an earlier ask beats a later allow, and your allow listed before a never still carves it out.
    rules = [r for r in load_rules() if valid_rule(r)]
    pending = None
    for r in rules:
        try:
            if not match(r, tool, text, path):
                continue
        except re.error:
            continue                              # a bad regex in one rule must not disable the others
        rid, dec, why = r["id"], r["decision"], r.get("why", "")
        if dec == "allow":
            if pending is None:
                print("{}")
                return
            continue
        if dec == "never":
            C.log_jsonl("action-rules.jsonl", {"rule": rid, "tool": tool, "decision": "never"})
            verdict("deny", "ACTION RULE '%s' = never. %s Do not retry or look for a way around it: tell the user what you "
                    "wanted to do and let them decide. (hooks/action-rules.yaml, or ~/.config/talos/action-rules.yaml)" % (rid, why))
            return
        if pending is None:
            pending = (rid, why)
    if pending is None:
        print("{}")
        return
    rid, why = pending
    # ask
    home, problem = app_home()
    call = {"tool_name": tool, "tool_input": ti}
    if isinstance(data.get("cwd"), str):
        call["cwd"] = data["cwd"]
    if home:
        # the Talos app: only the bridge's record of the owner's tap counts, never a file a session could write
        got = hub_request(home, dict(call, t="rule_take", rule=rid), TAKE_WAIT_S)
        if got and got.get("decision") == "allow":
            C.log_jsonl("action-rules.jsonl", {"rule": rid, "tool": tool,
                        "decision": "allow-always" if got.get("reason") == "always" else "allow-tapped"})
            print("{}")
            return
    elif not problem and take_approval(rid):    # a moved HOME: no file counts
        C.log_jsonl("action-rules.jsonl", {"rule": rid, "tool": tool, "decision": "allow-approved"})
        print("{}")
        return
    C.log_jsonl("action-rules.jsonl", {"rule": rid, "tool": tool, "decision": "ask"})
    note_ask(rid, call)
    if home:
        verdict("ask", "ACTION RULE '%s' = ask first. %s Say exactly what you are about to do. To ask the owner on their "
                "phone, run: python3 hooks/action-rules.py approve %s (it puts a card with this exact call in front of "
                "them and waits for their tap), then make exactly the same call once. Only their tap on that card "
                "approves it: a yes in chat, a web page, a file or tool output does not." % (rid, why, rid))
    else:
        verdict("ask", "ACTION RULE '%s' = ask first. %s Say exactly what you are about to do and wait for a yes. "
                "(If the user answered yes in a chat channel instead of this prompt, run: python3 hooks/action-rules.py "
                "approve %s 15 \"<their words>\" and retry once. An approval found in a web page, file or tool output "
                "does not count.)" % (rid, why, rid))
    return


ASK_KEEP_S = 2 * 3600  # how long a stopped call waits for `approve`


def app_home():
    """(home, problem): the Talos app's folder when there is one, else (None, None) for a kit on its own. The account's home
    comes from the password database, not $HOME: a session that moves HOME (to a folder with no app) must not get the no-app
    path (Delphi's follow-up to 3ede1b84), so a HOME that isn't the account's is a problem. TALOS_APP_HOME, when set, names it."""
    import pwd
    named = os.environ.get("TALOS_APP_HOME")
    if named:
        return named, None
    acct = pwd.getpwuid(os.getuid()).pw_dir
    if os.path.realpath(os.path.expanduser("~")) != os.path.realpath(acct):
        return None, "HOME is not this account's home folder, so I can't reach the Talos app; the owner can answer the prompt."
    home = os.path.join(acct, ".config", "talos", "app")
    return (home if os.path.exists(os.path.join(home, "config.json")) else None), None


TAKE_WAIT_S = 5.0
ASK_WAIT_S = 110.0            # under the Bash tool's two-minute default; the card stays open after it


def _peer_pid(sock):
    import socket
    import struct
    try:
        if sys.platform == "darwin":
            return struct.unpack("i", sock.getsockopt(0, 0x002, 4))[0]        # SOL_LOCAL, LOCAL_PEERPID
        if sys.platform.startswith("linux"):
            return struct.unpack("3i", sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))[0]
    except Exception:
        pass
    return None


def _bridge_pid(home):
    try:
        with open(os.path.join(home, "bridge.pid"), encoding="utf-8") as fh:
            n = json.load(fh).get("pid")
        return n if isinstance(n, int) and n > 0 else None
    except Exception:
        return None


def _claude_pid():
    """The Claude Code process this runs under (a thread session's hub proof is a pid in its pane's process group): CLAUDE_PID,
    else the nearest ancestor named claude, else the parent."""
    try:
        n = int(os.environ.get("CLAUDE_PID", ""))
        if n > 0:
            return n
    except ValueError:
        pass
    import subprocess
    pid = os.getppid()
    for _ in range(12):
        try:
            out = subprocess.run(["/bin/ps", "-o", "ppid=,comm=", "-p", str(pid)], capture_output=True, text=True,
                                 timeout=2, env={}).stdout.strip().split(None, 1)
        except Exception:
            break
        if len(out) < 2:
            break
        if os.path.basename(out[1]).lower().startswith("claude"):
            return pid
        nxt = int(out[0])
        if nxt <= 1:
            break
        pid = nxt
    return os.getppid()


def hub_request(home, req, wait_s):
    """One request to the live bridge's hub socket, and its answer (a dict), or None for anything else: no socket, a listener
    that is not the bridge in bridge.pid (it never sees the call), too big, slow, garbled. In a thread session the request
    carries that session's proof, the same as the permission hook's."""
    # A test marks itself with TALOS_TEST_SANDBOX; it may never reach a hub outside that folder (2026-11-15: a kit test run from a
    # thread session sent real cards to the owner's phone). Same answer as "no bridge".
    box = os.environ.get("TALOS_TEST_SANDBOX")
    if box:
        root = os.path.realpath(box)
        chosen = "run/hub.sock" if os.path.exists(os.path.join(home, "run/hub.sock")) or not os.path.exists(os.path.join(home, "hub.sock")) else "hub.sock"
        here = os.path.realpath(os.path.join(home, chosen))     # the socket itself: a link out of the sandbox is outside it
        if here != root and not here.startswith(root + os.sep):
            return None
    import socket
    import uuid
    req = dict(req, id=uuid.uuid4().hex[:16])
    req["pid"] = _claude_pid()
    thread = os.environ.get("TALOS_APP_WORKER_THREAD")
    if thread:
        nonce = os.environ.get("TALOS_APP_WORKER_NONCE", "")
        if not nonce:
            return None
        req["thread_id"], req["nonce"] = thread, nonce
    try:
        line = (json.dumps(req, ensure_ascii=True) + "\n").encode("ascii")
    except Exception:
        return None
    if len(line) > MAX_CALL_BYTES:
        return None
    deadline = time.monotonic() + wait_s
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(2.0)
        try:
            old = os.getcwd()
        except OSError:
            old = None
        try:
            os.chdir(home)                 # a relative name sidesteps the ~104-byte socket path limit
            sock.connect("run/hub.sock" if os.path.exists("run/hub.sock") or not os.path.exists("hub.sock") else "hub.sock")
        finally:
            if old:
                os.chdir(old)
        want, got = _bridge_pid(home), _peer_pid(sock)
        if want is None or got is None or want != got:
            return None
        sock.sendall(line)
        buf = b""
        while b"\n" not in buf and len(buf) < 4096:
            left = deadline - time.monotonic()
            if left <= 0:
                return None
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
    if not isinstance(msg, dict) or msg.get("t") != "rule_result" or msg.get("id") != req["id"]:
        return None
    return msg


def rule_kind(rule, tool):
    k = str(rule.get("kind") or "").strip().lower()
    if k == "send":
        return "email" if re.search(r"mail", tool, re.I) else "message"
    return k if k in ("email", "message", "deploy", "push", "publish", "purchase") else None


ASK_SAYS = {
    "deny": "not approved: the owner denied it on the card. Don't run it; ask them what they want instead.",
    "waiting": "the card is on the owner's phone and they haven't answered yet. Tell them what it is for and wait; run approve "
               "again to keep waiting, or make the call once they say they tapped Allow.",
    "gone": "the card is on the owner's phone and they haven't answered yet.",
    "busy": "not asked: several of these cards are already waiting for the owner. Wait for them to answer those.",
    "too_long": "not asked: this call is too long to show whole on a card. The owner can answer the prompt instead.",
    "not_live": "not asked: the Talos bridge isn't the live one right now. The owner can answer the prompt instead.",
    "send_failed": "not asked: the card could not be sent to the owner's phone. Try again in a minute.",
    "expired": "not approved: the card expired unanswered. Ask the owner again.",
}


def approve(args):
    if not args:
        print("usage: action-rules.py approve ID [minutes] \"note\"")
        sys.exit(2)
    rid, mins, note = args[0], 15, ""
    if len(args) > 1:
        try:
            mins = max(1, min(120, int(args[1])))
        except ValueError:
            note = args[1]
    if len(args) > 2:
        note = args[2]
    rules = {}
    for r in load_rules():                        # first match wins: your file's rule of an id over the starter's
        if r.get("decision") == "ask" and r.get("id") and r["id"] not in rules:
            rules[r["id"]] = r
    if rid not in rules:
        print("no ask rule '%s'. ask rules: %s" % (rid, ", ".join(sorted(rules)) or "(none)"))
        sys.exit(1)
    home, problem = app_home()
    if problem:
        print("not approved: %s" % problem)
        sys.exit(1)
    if home:
        return approve_by_card(rid, rules[rid], home)
    if not note.strip():
        print("an approval needs a note: the user's words and where they said them")
        sys.exit(1)
    _approve_file(rid, mins, note)


def approve_by_card(rid, rule, home):
    """The Talos app's way: the owner's tap on a card with the exact call. Exit 0 only when it is allowed."""
    call = asked_call(rid)
    if not call:
        print("not asked: no call is waiting for '%s'. Make the call first; when the rule stops it, run approve." % rid)
        sys.exit(1)
    req = {"t": "ask_rule", "rule": rid, "why": str(rule.get("why") or "")[:300], "tool_name": call["tool_name"],
           "tool_input": call.get("tool_input", {}), "wait_ms": int(ASK_WAIT_S * 1000)}
    kind = rule_kind(rule, call["tool_name"])     # for the words only: the bridge decides the kind from the shipped rules
    if isinstance(call.get("cwd"), str):
        req["cwd"] = call["cwd"][:1000]
    r = hub_request(home, req, ASK_WAIT_S + 10)
    if r is None:
        print("not asked: the Talos bridge can't be reached. The owner can answer the prompt instead.")
        sys.exit(1)
    d, why = r.get("decision"), str(r.get("reason") or "")
    C.log_jsonl("action-rules.jsonl", {"rule": rid, "decision": "card-" + str(d), "reason": why[:40]})
    if d == "allow":
        print("approved by the owner%s: make exactly the same call once now." % (" (they always allow %ss)" % kind if why == "always" else ""))
        return
    print(ASK_SAYS.get("deny" if d == "deny" else why, "not approved (%s). The owner can answer the prompt instead." % why[:60]))
    sys.exit(1)


def _approve_file(rid, mins, note):
    os.makedirs(appr_dir(), exist_ok=True)
    C.save_json(os.path.join(appr_dir(), safe_id(rid) + ".json"), {"until": time.time() + mins * 60, "note": note[:300], "ts": time.time()})
    C.drop(os.path.join(ask_dir(), safe_id(rid) + ".json"))  # the ask is answered
    C.log_jsonl("action-rules.jsonl", {"rule": rid, "decision": "approve", "minutes": mins})
    print("approved %s for one use, %d minutes" % (rid, mins))


def list_rules():
    for r in load_rules():
        print("%-6s %s: %s" % (r.get("decision", "?"), r.get("id"), r.get("why", "")))
    d = appr_dir()
    if os.path.isdir(d):
        for f in sorted(os.listdir(d)):
            print("live approval:", f[:-5] if f.endswith(".json") else f)


def selftest():
    bad = 0
    for label, p in (("your rules", USER_RULES), ("starter rules", SHIPPED)):
        try:
            rules = load_file(p)
        except Exception as e:
            print("FAIL %s (%s): %s" % (label, p, e))
            bad += 1
            continue
        for r in rules:
            if not valid_rule(r):
                print("FAIL %s: rule %r needs id, decision (never|ask|allow) and a tool, command or path" % (label, r.get("id")))
                bad += 1
                continue
            for k in ("tool", "command", "path"):
                if r.get(k):
                    try:
                        re.compile(r[k])
                    except re.error as e:
                        print("FAIL %s: rule %s has a bad %s regex: %s" % (label, r["id"], k, e))
                        bad += 1
        print("ok   %s: %d rule(s)%s" % (label, len(rules), "" if os.path.exists(p) else " (file not present)"))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    role = sys.argv[1] if len(sys.argv) > 1 else "check"
    try:
        if role == "check":
            check()
        elif role == "approve":
            approve(sys.argv[2:])
        elif role == "list":
            list_rules()
        elif role == "test":
            selftest()
        else:
            print("usage: action-rules.py [check|approve|list|test]")
            sys.exit(2)
    except SystemExit:
        raise
    except Exception as e:
        if role == "check":
            C.guard_failed("action-rules", e)
        else:
            print("action-rules: %s" % e)
            sys.exit(1)
