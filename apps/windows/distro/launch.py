#!/usr/bin/env python3
# The owner's approval of how Talos starts Claude (Hestia's launch-approve contract, 2026-11-12). Root-owned at
# /opt/talos-wsl/launch.py; `talos-wsl.sh launch-check` and `launch-approve <fingerprint>` run it as root.
#
#   check                one JSON line: this start's fingerprint and parts, whether it is the approved one, which parts
#                        differ, and the values themselves in full (what the tray's "Approve this change" window shows)
#   approve <64 hex>     writes /etc/talos/launch-approved, but only if the fingerprint worked out again now is the one
#                        given (the one the owner was shown); otherwise "it changed again" and exit 1
#   fingerprint          the fingerprint and parts of a supervisor.json given on stdin (for the shared test vectors)
#
# supervisor.json is talos's (~talos/.config/talos/app). Root never opens it by its path: every folder on the way is
# talos's, and a link there would make root read any file it can. Its bytes are read AS talos (runuser ... head -c), then
# parsed and hashed here; nothing of talos's is ever run. The fingerprint is the Mac's (DesktopConfig.launchFingerprint):
# SHA-256 over each item as <UTF-8 byte count>:<bytes>, in the order dir, agent_dir, claude, claude_path, args, <count>,
# ...args, env, <2 x count>, ...env as key, value rows sorted by key (UTF-8 byte order). Parts: each piece on its own, cut
# to 8 bytes. Values as written: no ~ expanded, no PATH looked up.
import difflib
import hashlib
import json
import os
import pwd
import re
import signal
import stat
import subprocess
import sys
import unicodedata

USER = "talos"
MAX = 65536
# TALOS_LAUNCH_TEST_ROOT: a test's scratch folder, so scripts/windows-distro.test.ts runs check, approve and relay-key for
# real as an ordinary user (Fable R2-5 on c9a60023): /etc/talos is <it>/etc-talos, talos's files are <it>/app/<name> read
# directly, and "root-owned" means owned by the user running the test. The tray never sets it: it runs this through
# `wsl -u root --exec`, with root's own environment, which nothing in the distro (talos included) can change.
# As root it is ignored (Pantheon on bbdcdd36, as Fable R5-5): no environment can point root at another approval folder
# or another setup-user.sh.
TEST_ROOT = (os.environ.get("TALOS_LAUNCH_TEST_ROOT") if os.getuid() != 0 else None) or None
ROOT_UID = os.getuid() if TEST_ROOT else 0
APPROVED_DIR = os.path.join(TEST_ROOT, "etc-talos") if TEST_ROOT else "/etc/talos"
APPROVED = "launch-approved"
# fullmatch, never match with $: $ also matches before a trailing newline (Fable R4-4)
RELAY = re.compile(r"https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
# what the window may show at most, and a value's longest (Fable R3-3 on a44344c2)
SHOW_MAX = 6000
VALUE_MAX = 400


def run_group(cmd, secs, **kw):
    """subprocess.run with a GROUP time limit (the fleet rule, 2026-11-12): the command starts in a session of its own, and
    on the limit its whole process group is killed, so nothing it started (runuser's child, a shell's) is left behind.
    Returns a CompletedProcess; raises subprocess.TimeoutExpired as subprocess.run does."""
    p = subprocess.Popen(cmd, start_new_session=True, **kw)
    try:
        out, err = p.communicate(timeout=secs)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        p.communicate()
        raise
    return subprocess.CompletedProcess(cmd, p.returncode, out, err)


def die(msg):
    # one line of plain ASCII, whatever msg holds (Fable R4-1 on f1699c11): nothing printed here, on stdout or stderr, carries
    # a string talos controls as it is; the messages are fixed sentences, and this is the backstop
    safe = json.dumps(str(msg), ensure_ascii=True)[1:-1]
    sys.stderr.write("launch: %s\n" % safe)
    sys.exit(1)


def h(items):
    d = hashlib.sha256()
    for it in items:
        b = it.encode("utf-8")
        d.update(str(len(b)).encode() + b":" + b)
    return d.hexdigest()


def utf8_ok(v):
    try:
        v.encode("utf-8")
        return True
    except UnicodeEncodeError:
        return False


def parse(raw):
    """The strict rule both sides keep (Hestia's approvableLaunch, d3eaec7b; Fable R2-3 on c9a60023): no defaults at all.
    agent_dir and claude_path absolute strings (no ~); args present, a list of strings; env absent ({}) or an object of
    strings; every string valid UTF-8 (a lone surrogate is not). Anything else is not approvable, before any hash."""
    try:
        s = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        die("not approvable: supervisor.json is not JSON")
    if not isinstance(s, dict):
        die("not approvable: supervisor.json is not a JSON object")
    agent_dir, claude = s.get("agent_dir"), s.get("claude_path")
    if not isinstance(agent_dir, str) or not agent_dir.startswith("/"):
        die("not approvable: agent_dir is not an absolute path")
    if not isinstance(claude, str) or not claude.startswith("/"):
        die("not approvable: claude_path is not an absolute path")
    if "args" not in s or not isinstance(s["args"], list) or not all(isinstance(a, str) for a in s["args"]):
        die("not approvable: args is missing or not a list of strings")
    args = s["args"]
    env = s.get("env", {}) if "env" in s else {}
    if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
        die("not approvable: env is not an object of strings")
    if not all(utf8_ok(v) for v in [agent_dir, claude] + args + list(env) + list(env.values())):
        die("not approvable: a value in supervisor.json is not valid text")
    # session.id and previous_ids reach Claude's argv as --resume=<id> (Fable R3-4 on a44344c2, Hestia's rule): absent,
    # null or a lowercase UUID, or the file is not approvable. They are still not hashed (see fingerprint()).
    sess = s.get("session")
    if sess is not None:
        if not isinstance(sess, dict):
            die("not approvable: session is not an object")
        ids = [sess.get("id")] + (sess.get("previous_ids") if isinstance(sess.get("previous_ids"), list) else
                                  ([] if sess.get("previous_ids") is None else [object()]))
        if not all(i is None or (isinstance(i, str) and UUID.fullmatch(i)) for i in ids):
            die("not approvable: a session id is not a plain id")
    return agent_dir, claude, args, env


def check_real(claude):
    """claude_path must be the real path itself, as talos sees it (no link anywhere in it): realpath, run AS talos."""
    if TEST_ROOT:
        real = os.path.realpath(claude) if os.path.exists(claude) else None
    else:
        try:
            r = run_group(["runuser", "-u", USER, "--", "realpath", "-e", "--", claude], stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, secs=5)
        except subprocess.TimeoutExpired:
            die("not approvable: claude_path could not be checked in time")
        real = r.stdout.decode("utf-8", "replace").rstrip("\n") if r.returncode == 0 else None
    if real != claude:
        # never the path itself: its folder names are talos's, and could hold a newline and a forged line (Fable R4-1)
        die("not approvable: claude_path is not the program's real path" if real else "not approvable: claude_path does not exist")


def fingerprint(agent_dir, claude, args, env):
    # session.id and auto_confirm_restart are deliberately NOT hashed (agreed with Hestia and Pantheon, Fable R2-2 on
    # c9a60023): the supervisor itself rewrites session.id on every new session (its first cold start, /clear, /resume),
    # so hashing it would void the approval each time and a no-terminal install would wait at dev_channels for good; and
    # auto_confirm_restart=false already means the supervisor answers nothing. The Mac's fingerprint leaves both out too.
    rows = []
    for k in sorted(env, key=lambda k: k.encode("utf-8")):
        rows += [k, env[k]]
    full = h(["dir", agent_dir, "claude", claude, "args", str(len(args))] + args + ["env", str(len(rows))] + rows)
    parts = {"folder": h([agent_dir])[:16], "program": h([claude])[:16], "flags": h(args)[:16], "env": h(rows)[:16]}
    return full, parts


def read_as_talos(name):
    """A file in talos's $TALOS_APP_HOME, read AS talos: what talos cannot read, root never sees, and no link on the way
    makes root read anything. A regular file only, read with a time limit (a FIFO there is no answer, not a hang). None if
    it cannot be read; a die if it is too large."""
    if TEST_ROOT:
        try:
            fd = os.open(os.path.join(TEST_ROOT, "app", name), os.O_RDONLY | os.O_NONBLOCK)
        except OSError:
            return None
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                return None
            data = os.read(fd, MAX + 1)
        finally:
            os.close(fd)
    else:
        try:
            u = pwd.getpwnam(USER)
        except KeyError:
            die("there is no talos user in this distro")
        path = os.path.join(u.pw_dir, ".config", "talos", "app", name)
        try:
            r = run_group(["runuser", "-u", USER, "--", "sh", "-c", 'test -f "$1" && exec head -c "$2" -- "$1"', "sh",
                                path, str(MAX + 1)],
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, secs=5)
        except subprocess.TimeoutExpired:
            return None
        if r.returncode != 0:
            return None
        data = r.stdout
    if len(data) > MAX:
        die("%s is larger than %d bytes" % (name, MAX))
    return data



def read_supervisor():
    raw = read_as_talos("supervisor.json")
    if raw is None:
        die("cannot read talos's supervisor.json")
    return raw


def read_root_json(name):
    """A JSON file of root's in /etc/talos, read as the supervisor reads the approval: a root-owned folder and file,
    neither group- nor world-writable, the file regular and not a link, 4 KB or less. Anything else is None."""
    try:
        ds = os.lstat(APPROVED_DIR)
        if not stat.S_ISDIR(ds.st_mode) or ds.st_uid != ROOT_UID or ds.st_mode & 0o022:
            return None
        fd = os.open(os.path.join(APPROVED_DIR, name), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            fs = os.fstat(fd)
            if not stat.S_ISREG(fs.st_mode) or fs.st_uid != ROOT_UID or fs.st_mode & 0o022 or fs.st_size > 4096:
                return None
            return json.loads(os.read(fd, 4097).decode("utf-8"))
        finally:
            os.close(fd)
    except (OSError, ValueError, UnicodeDecodeError):
        return None


def read_approved():
    j = read_root_json(APPROVED)
    if isinstance(j, dict) and j.get("v") == 1 and re.fullmatch(r"[0-9a-f]{64}", str(j.get("fingerprint", ""))):
        return j
    return None


def write_approved(full, parts, shown=None):
    write_root_json(APPROVED, {"v": 1, "fingerprint": full, "parts": parts, "shown": shown})


def write_root_json(name, obj):
    """Atomically, as root: /etc/talos made root:root 0755 if missing (and refused if it is anything else), a temp file
    made with O_EXCL|O_NOFOLLOW in it, 0644, then renamed into place."""
    if not os.path.lexists(APPROVED_DIR):
        os.mkdir(APPROVED_DIR, 0o755)
    ds = os.lstat(APPROVED_DIR)
    if not stat.S_ISDIR(ds.st_mode) or ds.st_uid != ROOT_UID or ds.st_mode & 0o022:
        die("%s is not a root-owned folder only root can write" % APPROVED_DIR)
    d = os.open(APPROVED_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        tmp = ".%s.%d" % (name, os.getpid())
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=d)
        try:
            os.fchmod(fd, 0o644)
            os.write(fd, (json.dumps(obj, separators=(",", ":")) + "\n").encode())
            os.fsync(fd)
        finally:
            os.close(fd)
        os.rename(tmp, name, src_dir_fd=d, dst_dir_fd=d)
        os.fsync(d)
    finally:
        os.close(d)


def normal_relay(url):
    """The one normalisation, the same as TalosWin.ps1 ConvertTo-TalosRelayUrl (Fable R7-3 on 9612c7d7): trailing slashes go,
    and the scheme and host are lowercased (a path keeps its case). Then RELAY decides."""
    url = url.rstrip("/")
    m = re.match(r"([A-Za-z]+://)([^/]*)(.*)", url, re.S)
    return (m.group(1).lower() + m.group(2).lower() + m.group(3)) if m else url


def relay_key():
    """This PC's relay key for Setup to show (Fable R1-3 on f3575ba1). bridge.key is talos's (the bridge runs as talos), so
    the agent could replace it: the key the FIRST install saw is kept by root in /etc/talos/relay-pubkey, and that is the
    one printed. If bridge.key's public key is no longer it (or cannot be read), the line after it says `changed`."""
    pub = None
    raw = read_as_talos("bridge.key")
    if raw is not None:
        try:
            j = json.loads(raw.decode("utf-8"))
            if isinstance(j, dict) and re.fullmatch(r"[A-Za-z0-9_-]{43}", str(j.get("public", ""))):
                pub = j["public"]
        except (UnicodeDecodeError, ValueError):
            pass
    kept = read_root_json("relay-pubkey")
    kept = kept.get("public") if isinstance(kept, dict) and re.fullmatch(r"[A-Za-z0-9_-]{43}", str(kept.get("public", ""))) else None
    if kept is None:
        if pub is None:
            die("no bridge key yet")
        write_root_json("relay-pubkey", {"v": 1, "public": pub})
        kept = pub
    print("BRIDGE_PUBKEY=%s" % kept)
    if pub != kept:
        print("changed")


def unsafe(v):
    """Characters a person cannot see for what they are: controls, format (bidi, zero-width), separators, private use."""
    return any(unicodedata.category(c) in ("Cc", "Cf", "Zl", "Zp", "Co", "Cs", "Cn") for c in v)


def q(v):
    """One value, quoted, every unusual character written out (\\n, \\u202e): what it is, never what it looks like."""
    return json.dumps(v, ensure_ascii=True)


def display(before, shown):
    """The lines the tray shows, worked out here, by root (Fable R3-3): added and removed arguments first, each on its own
    line and quoted; then the whole launch, one argument a line. ok is False (the tray offers no Approve) when a value has
    a character a person cannot see, a value is longer than VALUE_MAX, or the whole is longer than SHOW_MAX."""
    lines = []
    ok = True
    vals = [shown["folder"], shown["program"]] + shown["flags"] + [x for kv in shown["env"].items() for x in kv]
    if any(unsafe(v) for v in vals):
        ok = False
        lines.append("NOT APPROVABLE HERE: a value has a character that cannot be shown for what it is.")
    if any(len(v) > VALUE_MAX for v in vals):
        ok = False
        lines.append("NOT APPROVABLE HERE: a value is longer than %d characters." % VALUE_MAX)
    if before:
        old_flags, new_flags = before.get("flags") or [], shown["flags"]
        sm = difflib.SequenceMatcher(a=old_flags, b=new_flags, autojunk=False)
        added = [f for tag, i1, i2, j1, j2 in sm.get_opcodes() if tag in ("insert", "replace") for f in new_flags[j1:j2]]
        removed = [f for tag, i1, i2, j1, j2 in sm.get_opcodes() if tag in ("delete", "replace") for f in old_flags[i1:i2]]
        for f in added:
            lines.append("ADDED argument: " + q(f))
        for f in removed:
            lines.append("REMOVED argument: " + q(f))
        if before.get("program") != shown["program"]:
            lines.append("CHANGED program: %s -> %s" % (q(before.get("program") or ""), q(shown["program"])))
        if before.get("folder") != shown["folder"]:
            lines.append("CHANGED agent folder: %s -> %s" % (q(before.get("folder") or ""), q(shown["folder"])))
        if (before.get("env") or {}) != shown["env"]:
            lines.append("CHANGED environment")
        lines.append("")
    lines.append("Program: " + q(shown["program"]))
    lines.append("Agent folder: " + q(shown["folder"]))
    lines.append("Arguments (%d), one a line:" % len(shown["flags"]))
    for f in shown["flags"]:
        lines.append("  " + q(f))
    lines.append("Environment (%d):" % len(shown["env"]))
    for k in sorted(shown["env"], key=lambda k: k.encode("utf-8")):
        lines.append("  %s = %s" % (q(k), q(shown["env"][k])))
    if sum(len(l) + 1 for l in lines) > SHOW_MAX:
        ok = False
        lines = ["NOT APPROVABLE HERE: what changed is too long to show in full (%d characters)." % sum(len(l) + 1 for l in lines)] + lines
        lines = lines[:80]
    return lines, ok


def install_defaults():
    """The launch install writes (setup-user.sh), worked out here from root-only inputs alone (Fable R3-2 on a44344c2): the
    talos user's home, and the Claude Code version pinned in root's own copy of setup-user.sh."""
    if TEST_ROOT:
        home = os.path.join(TEST_ROOT, "home", "talos")
    else:
        try:
            home = pwd.getpwnam(USER).pw_dir
        except KeyError:
            die("there is no talos user in this distro")
    su = os.path.join(TEST_ROOT, "setup-user.sh") if TEST_ROOT else "/opt/talos-wsl/setup-user.sh"
    try:
        fd = os.open(su, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_uid != ROOT_UID or st.st_mode & 0o022:
                die("%s is not root's own" % su)
            text = os.read(fd, 1 << 20).decode("utf-8", "replace")
        finally:
            os.close(fd)
    except OSError:
        die("cannot read %s" % su)
    m = re.search(r"^CLAUDE_VERSION=([0-9]+\.[0-9]+\.[0-9]+)$", text, re.M)
    if not m:
        die("no pinned Claude Code version in %s" % su)
    return {"agent_dir": os.path.join(home, "talos-agent"),
            "claude_path": os.path.join(home, ".local", "share", "claude", "versions", m.group(1)),
            "args": ["--plugin-dir", os.path.join(home, "talos-app", "plugins", "talos-app-mod"),
                     "--dangerously-load-development-channels", "server:talos-app"]}


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "fingerprint":
        full, parts = fingerprint(*parse(sys.stdin.buffer.read(MAX + 1)[:MAX]))
        print(json.dumps({"fingerprint": full, "parts": parts}, separators=(",", ":")))
        return
    if cmd == "install-defaults":
        # the install's launch as JSON: what setup-user.sh writes to supervisor.json, from the very function approve-install
        # approves (Fable R4-5 on f1699c11), so the two cannot drift. Needs no root: it reads only root's setup-user.sh.
        print(json.dumps(install_defaults(), indent=2))
        return
    if os.getuid() != 0 and not TEST_ROOT:
        die("runs as root")
    if cmd == "relay-key":
        relay_key()
        return
    if cmd == "relay-set":
        # the install's relay URL, kept by root (Fable R5-1 on 5fc143ef): what pair.py checks enroll's link against, never
        # talos's own bridge config. install.ps1 sets it from Setup's payload (or -RelayUrl); https, a host, an optional
        # port and path, nothing else (no login, query or fragment), with no trailing slash.
        url = normal_relay(sys.argv[2] if len(sys.argv) > 2 else "")
        if not RELAY.fullmatch(url):
            die("usage: launch.py relay-set https://<host>[:<port>][/<path>]")
        write_root_json("relay", {"v": 1, "url": url})
        print("relay set")
        return
    if cmd == "approve-install":
        # install.ps1's only approval (Fable R3-2 on a44344c2): in the run that creates the distro, BEFORE setup-user.sh writes
        # supervisor.json and starts the supervisor. Root approves the launch it works out itself (install_defaults), never
        # a file talos wrote; only when there is no approval yet AND talos has no supervisor.json yet (so the supervisor, and
        # the agent, have never run). Any other case approves nothing: the tray's window is the only way then.
        if os.path.lexists(os.path.join(APPROVED_DIR, APPROVED)):
            print("not approved here: there is an approval already (a change is approved in the tray)")
            return
        if read_as_talos("supervisor.json") is not None:
            print("not approved here: Talos has started before (a change is approved in the tray)")
            return
        d = install_defaults()
        full, parts = fingerprint(d["agent_dir"], d["claude_path"], d["args"], {})
        write_approved(full, parts, {"folder": d["agent_dir"], "program": d["claude_path"], "flags": d["args"], "env": {}})
        print("approved the install's launch %s" % full)
        return
    if cmd == "approved-folder":
        # restore's agent folder (WINPROTO-4, 2026-11-16): the folder of the launch the owner approved, from root's own
        # approval file, never from talos's files. Nothing printed (exit 1) for an approval that does not name one.
        folder = (((read_approved() or {}).get("shown") or {}) or {}).get("folder")
        if not isinstance(folder, str) or not folder.startswith("/") or any(c in folder for c in "\n\r\0"):
            sys.exit(1)
        print(folder)
        return
    if cmd == "state":
        # one word for the tray's status (Fable R3-5): decided here, from root's own check, never from talos's files
        raw = read_as_talos("supervisor.json")
        if raw is None:
            print("none")
            return
        try:
            with open(os.devnull, "w") as quiet:
                old_err, sys.stderr = sys.stderr, quiet
                try:
                    a, c, f, e = parse(raw)
                    check_real(c)
                finally:
                    sys.stderr = old_err
        except SystemExit:
            print("unapprovable")
            return
        old = read_approved()
        print("approved" if old and old["fingerprint"] == fingerprint(a, c, f, e)[0] else "pending")
        return
    agent_dir, claude, args, env = parse(read_supervisor())
    check_real(claude)
    full, parts = fingerprint(agent_dir, claude, args, env)
    # what a person is shown, and what an approval keeps, so the next window can show old -> new
    shown = {"folder": agent_dir, "program": claude, "flags": args, "env": env}
    if cmd == "check":
        old = read_approved()
        changed = sorted(k for k in parts if not old or (old.get("parts") or {}).get(k) != parts[k])
        lines, ok = display((old or {}).get("shown"), shown)
        print(json.dumps({
            "fingerprint": full, "parts": parts, "approved": bool(old and old["fingerprint"] == full),
            "first": not os.path.lexists(os.path.join(APPROVED_DIR, APPROVED)), "changed": changed,
            "display": lines, "display_ok": ok,
        }, separators=(",", ":"), ensure_ascii=True))
        return
    if cmd == "approve":
        want = sys.argv[2] if len(sys.argv) > 2 else ""
        if not re.fullmatch(r"[0-9a-f]{64}", want):
            die("usage: launch.py approve <the 64-hex fingerprint the owner was shown>")
        if want != full:
            die("it changed again since you looked: look again, then approve what it shows now")
        # root's own display of the launch it just worked out again (Fable R4-1): a launch that cannot be shown in full is never
        # approved, whatever the window that asked was shown
        if not display((read_approved() or {}).get("shown"), shown)[1]:
            die("not approvable here: part of this launch cannot be shown in full")
        write_approved(full, parts, shown)
        print("approved %s" % full)
        return
    die("usage: launch.py check | approve <fingerprint> | approve-install | install-defaults | state | approved-folder | relay-key | relay-set <url> | fingerprint")


if __name__ == "__main__":
    main()
