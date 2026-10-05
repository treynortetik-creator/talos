"""_talos_common.py: shared helpers for the Talos hooks. Not a hook itself; nothing registers this file.

What every hook here promises (read this before adding one):
  1. FAIL OPEN. Any exception means "do nothing": a hook that can wedge a session is worse than the failure it
     prevents. The settings template also wraps every command so a MISSING script exits 0.
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
