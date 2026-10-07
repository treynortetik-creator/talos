"""_talos_common.py: shared helpers for the Talos hooks. Not a hook itself; nothing registers this file.

What every hook here promises (read this before adding one):
  1. FAIL OPEN IN A LIVE SESSION, FAIL CLOSED WHEN UNATTENDED. In an interactive session any exception means "do
     nothing": a hook that can wedge a session is worse than the failure it prevents, and losing a reminder must
     not break a conversation. The settings template wraps every command so a MISSING script exits 0.
     BUT the four SAFETY GUARDS (pre-tool-guard, append-only-guard, timeline-guard, check-vault) are different
     when nobody is watching: in a headless scheduled run (unattended(), below) a guard that errors, cannot load
     its helpers, or is missing BLOCKS the action and says why, because there is no person to notice that a guard
     silently stopped guarding. Reminder-style hooks (claim-gate, channel-debt, agent-log, hands-free, the
     session-start digest, the status line) stay fail-open in both modes: they cannot cause harm by failing.
  2. STATE LIVES OUTSIDE THE AGENT FOLDER, in ${XDG_STATE_HOME:-~/.local/state}/talos/<slug>/, where
     slug = folder name + "-" + the first 8 hex of sha1(realpath of the folder). Two agents never share state,
     and the agent folder (and its upgrade-protected .gitignore) needs no new entries.
  3. THE ROOT COMES FROM THIS FILE'S OWN LOCATION, never from an environment variable.
  4. EVERY HOOK HAS KILL SWITCHES: the environment variable TALOS_<HOOK>_OFF=1, a file <hook>.off in the state
     folder, or the same file name in Chronos's kill-switch folder (default ~/.chronos/switches), which is what
     the Chronos Control Room toggles. Each hook script names its file as a string literal.
Python 3.9 compatible, standard library only.
"""
import hashlib
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


# --------------------------------------------------------------------------- unattended runs and guard errors
def unattended():
    """True inside a headless, nobody-is-watching run. Chronos exports CHRONOS_RUN=1 into every run it starts
    (bin/chronos-run.sh); TALOS_UNATTENDED=1 marks one by hand (any other scheduler, a CI job, a test)."""
    return os.environ.get("CHRONOS_RUN") == "1" or os.environ.get("TALOS_UNATTENDED") == "1"


def pretool_json(decision, reason):
    """The PreToolUse JSON for a guard verdict. An `ask` needs a person to answer it; when unattended there is
    none, so it becomes a `deny` (the reason says so)."""
    if decision == "ask" and unattended():
        decision = "deny"
        reason += "\n\n(This run is unattended, so there is nobody to ask: the write is refused.)"
    return json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": decision,
                                              "permissionDecisionReason": reason}})


def guard_failed(name, err):
    """A SAFETY GUARD hit an error it did not expect. Interactive: allow ({} on stdout, exit 0), because a broken
    guard must never wedge a session. Unattended: BLOCK (deny + exit 0, which Claude Code honours) and report."""
    if unattended():
        print(pretool_json("deny", "Talos %s hit an internal error (%s: %s) while this run is unattended, so the "
                           "action is blocked rather than allowed unchecked. Nothing was written. Fix the guard "
                           "(or run it interactively) before relying on this job." % (name, type(err).__name__, str(err)[:160])))
    else:
        print("{}")


def arm_guard_timeout(name, seconds=None):
    """Call FIRST in a safety guard. A hook that outlives Claude Code's own hook timeout is a NON-blocking error, so a guard
    that hangs (a stuck read, a runaway import) would let the action through. This alarm fires well before that: in a live
    session it allows ({} and exit 0, as for any guard error); when unattended it DENIES. TALOS_GUARD_TIMEOUT_S overrides
    the default of 20 seconds (the tests use 1)."""
    try:
        import signal
        secs = int(seconds or os.environ.get("TALOS_GUARD_TIMEOUT_S") or 20)

        def _fire(signum, frame):
            try:
                if unattended():
                    sys.stdout.write(pretool_json("deny", "Talos %s did not finish within %ds and this run is unattended, so the action is "
                                                  "blocked rather than allowed unchecked." % (name, secs)) + "\n")
                else:
                    sys.stdout.write("{}\n")
                sys.stdout.flush()
            finally:
                os._exit(0)
        signal.signal(signal.SIGALRM, _fire)
        signal.alarm(max(1, secs))
    except Exception:
        pass


# --------------------------------------------------------------------------- containment
def contained(path, root=None):
    """The canonical path of `path` when it names something INSIDE `root` (default: the agent folder) and no
    component below the root is a symlink; None otherwise. Relative paths are taken from the root.

    WHY: a check on the final component (islink, O_NOFOLLOW) does not see a symlinked PARENT. If memory/ or
    wiki/ is a link to some other folder, memory/STATE.md is a regular file that lives outside the project, and
    a hook that reads or writes it has left the project. So: resolve the root, find where the path enters it,
    and refuse a link at every step below that. Anything above the root may be a link (/tmp, a synced folder),
    and `..` is refused outright because collapsing it before resolving is how that kind of check is fooled.
    Works for paths that do not exist yet (a missing component is not a link)."""
    try:
        base_root = os.path.realpath(root or ROOT)
        s = str(path)
        if not s or "\0" in s or ".." in s.replace("\\", "/").split("/"):
            return None
        p = os.path.normpath(s if os.path.isabs(s) else os.path.join(base_root, s))
        parts = p.split(os.sep)
        base, rest = None, []
        for i in range(2, len(parts) + 1):
            pre = os.sep.join(parts[:i]) or os.sep
            if os.path.realpath(pre) == base_root:
                base, rest = pre, parts[i:]
                break
        if base is None:
            return None
        cur = base
        for seg in rest:
            cur = os.path.join(cur, seg)
            if os.path.islink(cur):
                return None
        return cur
    except Exception:
        return None


def read_contained(path, limit=None, root=None):
    """Text of a regular file that `contained` accepts, or '' for any reason at all. Never raises, never follows a
    link (O_NOFOLLOW on the last component, `contained` on the rest)."""
    try:
        full = contained(path, root)
        if not full or not os.path.isfile(full):
            return ""
        fd = os.open(full, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read() if not limit else fh.read(limit)
    except Exception:
        return ""


def append_contained(path, text, root=None):
    """Append `text` to a file inside the root (creating it and its folder), refusing any link on the way. True when written."""
    try:
        full = contained(path, root)
        if not full:
            return False
        parent = os.path.dirname(full)
        if not os.path.isdir(parent):
            os.makedirs(parent, exist_ok=True)
            if not contained(full, root):          # re-check after creating: a link may have appeared
                return False
        fd = os.open(full, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o644)
        with os.fdopen(fd, "a", encoding="utf-8") as fh:
            fh.write(text)
        return True
    except Exception:
        return False


def slug():
    return "%s-%s" % (os.path.basename(ROOT) or "agent", hashlib.sha1(ROOT.encode("utf-8")).hexdigest()[:8])


def state_dir():
    base = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
    return os.path.join(base, "talos", slug())


def chronos_switch_dir():
    """Where Chronos's Control Room writes <name>.off files. Best effort; the default is ~/.chronos/switches."""
    default = os.path.expanduser("~/.chronos/switches")
    try:
        cfg_path = os.environ.get("CHRONOS_CONFIG") or os.path.expanduser("~/.config/chronos/config.json")
        with open(cfg_path, encoding="utf-8") as fh:
            cfg = json.load(fh)
        if cfg.get("kill_switch_dir"):
            return os.path.expanduser(str(cfg["kill_switch_dir"]))
        if cfg.get("home_dir"):
            return os.path.join(os.path.expanduser(str(cfg["home_dir"])), "switches")
    except Exception:
        pass
    return default


def killed(off_name):
    """off_name like 'claim-gate.off'. True when any kill switch for that hook is set."""
    try:
        env = "TALOS_" + off_name[:-4].upper().replace("-", "_") + "_OFF"
        if os.environ.get(env) == "1":
            return True
        for d in (state_dir(), chronos_switch_dir()):
            if os.path.exists(os.path.join(d, off_name)):
                return True
    except Exception:
        pass
    return False


def read_stdin():
    try:
        d = json.loads(sys.stdin.read() or "{}")
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def load_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def save_json(path, d):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = "%s.tmp.%d" % (path, os.getpid())
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(d, fh)
        os.replace(tmp, path)
    except Exception:
        pass


def drop(path):
    try:
        os.remove(path)
    except Exception:
        pass


def log_jsonl(name, rec, keep_lines=2000):
    """Append one JSON line to <state>/<name>. Trims to the newest keep_lines when it grows past twice that."""
    try:
        p = os.path.join(state_dir(), name)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        rec = dict(rec)
        rec["ts"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        with open(p, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec) + "\n")
        if os.path.getsize(p) > keep_lines * 400:
            with open(p, encoding="utf-8", errors="replace") as fh:
                lines = fh.readlines()
            if len(lines) > keep_lines * 2:
                with open(p, "w", encoding="utf-8") as fh:
                    fh.writelines(lines[-keep_lines:])
    except Exception:
        pass
