#!/usr/bin/env python3
"""talos-jobs.py -- register, list, enable and remove the Talos jobs in Chronos.

Chronos (https://github.com/treynortetik-creator/chronos) is the scheduler. A Chronos job is one entry in
jobs.json plus a folder jobs/<id>/ holding prompt.md (and optionally a locked guard.md); a "command" job
(Chronos 0.2.1) is just the entry and a shell command, no folder. Talos ships five of them in jobs/ in this kit. This script copies them into your Chronos config, fills in the path of your
agent folder, and never overwrites a job you have already edited.

  talos-jobs.py register   --agent-dir DIR [--chronos-config FILE] [--kit-dir DIR]
  talos-jobs.py unregister [--chronos-config FILE]            remove every job whose id starts with talos-
  talos-jobs.py list       [--chronos-config FILE]
  talos-jobs.py enable  ID [--time HH:MM] [--days SPEC] [--chronos-config FILE]
  talos-jobs.py disable ID [--chronos-config FILE]
  talos-jobs.py validate   [--kit-dir DIR]                    check the shipped job templates (no Chronos needed)
  talos-jobs.py hook-add    --agent-dir DIR --chronos-dir DIR    register Chronos's SessionStart hook for this agent
  talos-jobs.py hook-remove --agent-dir DIR

Python 3.9+, standard library only. It reads the Chronos config the same way Chronos does
(CHRONOS_CONFIG, else ~/.config/chronos/config.json) and takes the same lock Chronos's UI takes before it
touches jobs.json. It never starts a job and never runs claude.
"""
import argparse
import fcntl
import json
import os
import re
import shlex
import shutil
import sys
import time

ID_RE = re.compile(r"^[a-z0-9-]{2,40}$")          # Chronos's rule for a job id
TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
ONCE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$")
NOTIFY_MODES = ("failure", "always", "never")
# Chronos 0.2's rule for a job's optional `model` (passed to claude as --model). Chronos 0.1 ignores the key.
MODEL_RE = re.compile(r"^(opus|sonnet|haiku|claude-[A-Za-z0-9._-]{2,60}(\[1m\])?)$")
DAY_NAMES = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
PREFIX = "talos-"
PLACEHOLDER = "{{TALOS_HOME}}"
HOOK_MARK = "chronos-session-start.py"

# Chronos 0.2.1 added the command job ("kind": "command"): a plain shell command on the schedule, no claude run.
# talos-memory-index is one, so it spends no Claude usage. An older Chronos cannot run it.
COMMAND_MIN_CHRONOS = (0, 2, 1)
MAX_COMMAND_LEN = 2000

DEFAULT_JOBS_FILE = "~/.config/chronos/jobs.json"
DEFAULT_JOBS_DIR = "~/.config/chronos/jobs"


def die(msg, code=1):
    sys.stderr.write("talos-jobs: %s\n" % msg)
    sys.exit(code)


def kit_dir_default():
    return os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


def chronos_config_path(explicit=None):
    return os.path.abspath(os.path.expanduser(
        explicit or os.environ.get("CHRONOS_CONFIG") or "~/.config/chronos/config.json"))


def load_chronos(explicit=None):
    """Return (jobs_file, jobs_dir) the way Chronos resolves them. Defaults apply when keys are absent."""
    p = chronos_config_path(explicit)
    cfg = {}
    try:
        with open(p, encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            cfg = data
    except FileNotFoundError:
        die("no Chronos config at %s. Install Chronos first (./install.sh does this), or pass --chronos-config." % p)
    except Exception as e:
        die("cannot read Chronos config %s: %s" % (p, e))
    jf = os.path.abspath(os.path.expanduser(str(cfg.get("jobs_file") or DEFAULT_JOBS_FILE)))
    jd = os.path.abspath(os.path.expanduser(str(cfg.get("jobs_dir") or DEFAULT_JOBS_DIR)))
    return jf, jd


def read_jobs(path):
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return []
    except Exception as e:
        die("cannot read %s: %s (fix or move it; nothing was changed)" % (path, e))
    if not isinstance(data, list):
        die("%s is not a JSON list (nothing was changed)" % path)
    return data


class JobsLock(object):
    """The same advisory lock Chronos takes (<jobs.json>.lock) so we never race its web UI."""

    def __init__(self, jobs_file):
        self.path = jobs_file + ".lock"

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.fh = open(self.path, "a")
        fcntl.flock(self.fh, fcntl.LOCK_EX)
        return self

    def __exit__(self, *a):
        fcntl.flock(self.fh, fcntl.LOCK_UN)
        self.fh.close()


def write_jobs(path, jobs):
    if os.path.exists(path):
        shutil.copy2(path, "%s.bak-talos-%s" % (path, time.strftime("%Y%m%d-%H%M%S")))
    tmp = "%s.tmp.%d" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(jobs, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, path)


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def check_job(j, where="job"):
    """Return a list of problems with one job record, using Chronos's own rules."""
    errs = []
    if not isinstance(j, dict):
        return ["%s is not an object" % where]
    jid = str(j.get("id", ""))
    if not ID_RE.match(jid):
        errs.append("%s: bad id %r (2-40 chars of a-z, 0-9, dash)" % (where, jid))
    if not str(j.get("name") or "").strip() or len(str(j.get("name"))) > 60:
        errs.append("%s: name is required and at most 60 characters" % jid)
    if j.get("kind") not in (None, "claude", "command"):
        errs.append("%s: kind must be claude or command" % jid)
    if j.get("kind") == "command":
        cmd = j.get("command")
        if not isinstance(cmd, str) or not cmd.strip() or len(cmd) > MAX_COMMAND_LEN:
            errs.append("%s: a command job needs a command string of at most %d characters" % (jid, MAX_COMMAND_LEN))
        if j.get("triggers") or j.get("clock") is False:
            errs.append("%s: a command job runs on its clock schedule only (no triggers, clock stays on)" % jid)
        if j.get("model"):
            errs.append("%s: a command job does not use Claude, so it has no model" % jid)
    model = j.get("model")
    if model not in (None, "") and not MODEL_RE.match(str(model)):
        errs.append("%s: model must be opus, sonnet, haiku or a full model id like claude-sonnet-5-5" % jid)
    if j.get("clock") not in (None, True, False):
        errs.append("%s: clock must be true or false" % jid)
    once = j.get("once")
    if j.get("clock") is False and not once:
        pass          # an event-only job (Chronos 0.2 triggers) has no clock schedule to validate
    elif once:
        if not ONCE_RE.match(str(once)):
            errs.append("%s: once must look like 2026-10-05T09:00" % jid)
    else:
        if not TIME_RE.match(str(j.get("time", ""))):
            errs.append("%s: time must be HH:MM (24-hour)" % jid)
        d = str(j.get("days", ""))
        ok = d in ("daily", "weekdays") or re.match(r"^dom:\d{1,2}(,\d{1,2})*$", d) \
            or (d and all(x in DAY_NAMES for x in d.split(",")))
        if not ok:
            errs.append("%s: days must be daily, weekdays, mon,wed,fri or dom:1,15" % jid)
    if j.get("notify") not in NOTIFY_MODES:
        errs.append("%s: notify must be one of %s" % (jid, ", ".join(NOTIFY_MODES)))
    try:
        c = int(j.get("catchup_min"))
        if not 15 <= c <= 1440:
            errs.append("%s: catchup_min must be 15-1440" % jid)
    except (TypeError, ValueError):
        errs.append("%s: catchup_min must be an integer 15-1440" % jid)
    for k in ("enabled", "in_session"):
        if not isinstance(j.get(k), bool):
            errs.append("%s: %s must be true or false" % (jid, k))
    if j.get("kind") == "command" and j.get("in_session") is True:
        errs.append("%s: a command job cannot run in a live session (in_session must be false)" % jid)
    return errs


def is_command(j):
    return isinstance(j, dict) and j.get("kind") == "command"


def parse_version(text):
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", str(text or ""))
    return tuple(int(x) for x in m.groups()) if m else None


def chronos_version():
    """The version of the Chronos runtime that will run the jobs, or None when it cannot be found (then we assume it is new enough).
    Reads lib/chronoslib.py (VERSION = "x.y.z") from the checkout install.sh recorded, or from the copied runtime."""
    cfgdir = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    cands = []
    try:
        d = open(os.path.join(cfgdir, "talos", "chronos-dir"), encoding="utf-8").read().strip()
    except OSError:
        d = ""
    home = os.path.expanduser("~")
    if d:
        # Chronos copies its runtime out of Desktop/Documents/Downloads; that copy is what launchd runs
        if any(d.startswith(os.path.join(home, f) + os.sep) for f in ("Desktop", "Documents", "Downloads")):
            cands.append(os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share"), "chronos"))
        cands.append(d)
    for c in cands:
        try:
            txt = open(os.path.join(c, "lib", "chronoslib.py"), encoding="utf-8").read(20000)
        except OSError:
            continue
        m = re.search(r'^VERSION\s*=\s*["\']([^"\']+)["\']', txt, re.M)
        if m:
            return parse_version(m.group(1))
    return None


def template_jobs(kit_dir):
    p = os.path.join(kit_dir, "jobs", "jobs.json")
    try:
        with open(p, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as e:
        die("cannot read the shipped job templates %s: %s" % (p, e))
    if not isinstance(data, list) or not data:
        die("%s is not a non-empty list" % p)
    return data


# --------------------------------------------------------------------------- commands
def cmd_validate(a):
    kit = os.path.abspath(a.kit_dir or kit_dir_default())
    problems = []
    jobs = template_jobs(kit)
    seen = set()
    for j in jobs:
        problems += check_job(j)
        jid = str(j.get("id"))
        if jid in seen:
            problems.append("duplicate id %s" % jid)
        seen.add(jid)
        if not jid.startswith(PREFIX):
            problems.append("%s: shipped job ids must start with %s so uninstall can find them" % (jid, PREFIX))
        if j.get("enabled") is not False:
            problems.append("%s: shipped jobs must ship disabled" % jid)
        if "haiku" in str(j.get("model") or "").lower():
            problems.append("%s: shipped jobs never pin haiku (Sonnet is the floor: a cheaper model fails quietly)" % jid)
        d = os.path.join(kit, "jobs", jid)
        if is_command(j):
            # no prompt.md and no guard.md: nothing here asks Claude to do anything. The command must name the agent folder.
            cmd = str(j.get("command") or "")
            if PLACEHOLDER not in cmd:
                problems.append("%s: command never mentions %s" % (jid, PLACEHOLDER))
            if re.search(r"/(Users|home)/", cmd):
                problems.append("%s: command contains an absolute user path" % jid)
            if os.path.exists(os.path.join(d, "prompt.md")):
                problems.append("%s: a command job must not ship a prompt.md (it would never be read)" % jid)
            continue
        pf = os.path.join(d, "prompt.md")
        if not os.path.isfile(pf):
            problems.append("%s: no prompt.md" % jid)
            continue
        text = open(pf, encoding="utf-8").read()
        if PLACEHOLDER not in text:
            problems.append("%s: prompt.md never mentions %s" % (jid, PLACEHOLDER))
        if re.search(r"/(Users|home)/", text):
            problems.append("%s: prompt.md contains an absolute user path" % jid)
        gf = os.path.join(d, "guard.md")
        if not os.path.isfile(gf):
            problems.append("%s: no guard.md (every shipped job carries locked standing rules)" % jid)
            continue
        g = open(gf, encoding="utf-8").read().lower()
        if "foreground" not in g or "background" not in g:
            problems.append("%s: guard.md must forbid background work (FOREGROUND ONLY)" % jid)
    # a job folder with no entry would never be registered
    jd = os.path.join(kit, "jobs")
    for name in sorted(os.listdir(jd)):
        if os.path.isdir(os.path.join(jd, name)) and name not in seen:
            problems.append("jobs/%s has no entry in jobs/jobs.json" % name)
    if problems:
        for p in problems:
            print("  PROBLEM  %s" % p)
        return 1
    print("ok: %d shipped job(s) valid in Chronos format: %s" % (len(jobs), ", ".join(sorted(seen))))
    return 0


def cmd_register(a):
    kit = os.path.abspath(a.kit_dir or kit_dir_default())
    agent = os.path.abspath(os.path.expanduser(a.agent_dir))
    if not os.path.isdir(agent):
        die("agent folder %s does not exist" % agent)
    jf, jd = load_chronos(a.chronos_config)
    tmpl = template_jobs(kit)
    for j in tmpl:
        errs = check_job(j)
        if errs:
            die("the shipped template is invalid: %s" % "; ".join(errs))
    os.makedirs(jd, exist_ok=True)
    added, kept, skipped = [], [], []
    cv = chronos_version()
    with JobsLock(jf):
        jobs = read_jobs(jf)
        have = set(str(j.get("id")) for j in jobs if isinstance(j, dict))
        for j in tmpl:
            jid = j["id"]
            if jid in have or (not is_command(j) and os.path.exists(os.path.join(jd, jid))):
                kept.append(jid)
                continue
            if is_command(j):
                if cv is not None and cv < COMMAND_MIN_CHRONOS:
                    skipped.append((jid, ".".join(str(x) for x in cv)))
                    continue
                rec = dict(j)
                rec["command"] = str(j["command"]).replace(PLACEHOLDER, shlex.quote(agent))
                rec["created"] = rec["updated"] = now_iso()
                jobs.append(rec)
                added.append(jid)
                continue
            src = os.path.join(kit, "jobs", jid)
            dst = os.path.join(jd, jid)
            os.makedirs(dst)
            for fname in ("prompt.md", "guard.md"):
                sp = os.path.join(src, fname)
                if os.path.isfile(sp):
                    text = open(sp, encoding="utf-8").read().replace(PLACEHOLDER, agent)
                    with open(os.path.join(dst, fname), "w", encoding="utf-8") as fh:
                        fh.write(text)
            rec = dict(j)
            rec["created"] = rec["updated"] = now_iso()
            jobs.append(rec)
            added.append(jid)
        if added:
            write_jobs(jf, jobs)
    for jid in added:
        print("  registered %s (disabled)" % jid)
    for jid in kept:
        print("  kept existing %s (not overwritten)" % jid)
    for jid, ver in skipped:
        print("  SKIPPED %s: it is a plain command job and your Chronos is %s (command jobs need 0.2.1). "
              "Update Chronos (git pull, then re-run its install.sh) and run this again." % (jid, ver))
    print("jobs file: %s" % jf)
    return 0


def cmd_unregister(a):
    jf, jd = load_chronos(a.chronos_config)
    removed = []
    with JobsLock(jf):
        jobs = read_jobs(jf)
        keep = []
        for j in jobs:
            if isinstance(j, dict) and str(j.get("id", "")).startswith(PREFIX):
                removed.append(j["id"])
            else:
                keep.append(j)
        if removed:
            write_jobs(jf, keep)
    for jid in removed:
        d = os.path.join(jd, jid)
        # only ever remove a folder that sits directly inside Chronos's jobs dir and carries our prefix
        if ID_RE.match(jid) and os.path.isdir(d) and os.path.dirname(os.path.realpath(d)) == os.path.realpath(jd):
            shutil.rmtree(d)
        print("  removed %s" % jid)
    if not removed:
        print("  no %s* jobs found" % PREFIX)
    return 0


def cmd_list(a):
    jf, _ = load_chronos(a.chronos_config)
    rows = [j for j in read_jobs(jf) if isinstance(j, dict) and str(j.get("id", "")).startswith(PREFIX)]
    if not rows:
        print("no Talos jobs registered in %s" % jf)
        return 0
    for j in rows:
        print("%-26s %-8s %s %s" % (j["id"], "ON" if j.get("enabled") else "disabled",
                                    j.get("time"), j.get("days")))
    return 0


def cmd_enable(a, on=True):
    jf, _ = load_chronos(a.chronos_config)
    with JobsLock(jf):
        jobs = read_jobs(jf)
        hit = None
        for j in jobs:
            if isinstance(j, dict) and j.get("id") == a.id:
                hit = j
        if hit is None:
            die("no job %r in %s" % (a.id, jf))
        hit["enabled"] = bool(on)
        if on and getattr(a, "time", None):
            hit["time"] = a.time
        if on and getattr(a, "days", None):
            hit["days"] = a.days
        hit["updated"] = now_iso()
        errs = check_job(hit)
        if errs:
            die("not saved: " + "; ".join(errs))
        write_jobs(jf, jobs)
    print("%s %s (%s %s)" % (a.id, "enabled" if on else "disabled", hit.get("time"), hit.get("days")))
    return 0


def _settings_path(agent):
    return os.path.join(os.path.abspath(os.path.expanduser(agent)), ".claude", "settings.json")


def hook_command(script_path):
    """A hook command that FAILS OPEN. Claude Code treats exit 2 from a UserPromptSubmit/SessionStart-style hook
    as a block, and `python3 <missing file>` exits 2, so a hook whose script was deleted (a purged Chronos, a
    removed kit file) used to be able to block every prompt. Missing file or missing python3 -> exit 0."""
    return 'f="%s"; [ -f "$f" ] || exit 0; command -v python3 >/dev/null 2>&1 || exit 0; python3 "$f"' % script_path


def cmd_hook_add(a):
    sp = _settings_path(a.agent_dir)
    hook = os.path.join(os.path.abspath(os.path.expanduser(a.chronos_dir)), "hooks", HOOK_MARK)
    if not os.path.isfile(hook):
        die("no Chronos hook at %s" % hook)
    try:
        cfg = json.load(open(sp, encoding="utf-8")) if os.path.exists(sp) else {}
    except Exception as e:
        die("cannot parse %s: %s (left untouched)" % (sp, e))
    entries = cfg.setdefault("hooks", {}).setdefault("SessionStart", [])
    for e in entries:
        for h in (e.get("hooks") or []):
            if HOOK_MARK in str(h.get("command", "")):
                print("  Chronos SessionStart hook already registered")
                return 0
    entries.append({"matcher": "startup|resume",
                    "hooks": [{"type": "command", "command": hook_command(hook)}]})
    os.makedirs(os.path.dirname(sp), exist_ok=True)
    tmp = sp + ".tmp.%d" % os.getpid()
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, sp)
    print("  registered the Chronos SessionStart hook in %s" % sp)
    return 0


def cmd_hook_remove(a):
    sp = _settings_path(a.agent_dir)
    if not os.path.exists(sp):
        return 0
    try:
        cfg = json.load(open(sp, encoding="utf-8"))
    except Exception:
        print("  could not parse %s; left untouched" % sp)
        return 0
    entries = (cfg.get("hooks") or {}).get("SessionStart") or []
    kept, dropped = [], 0
    for e in entries:
        hs = [h for h in (e.get("hooks") or []) if HOOK_MARK not in str(h.get("command", ""))]
        if len(hs) != len(e.get("hooks") or []):
            dropped += 1
        if hs:
            e = dict(e)
            e["hooks"] = hs
            kept.append(e)
    if dropped:
        cfg["hooks"]["SessionStart"] = kept
        tmp = sp + ".tmp.%d" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, sp)
        print("  removed the Chronos SessionStart hook from %s" % sp)
    return 0


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")

    def common(p, chronos=True):
        if chronos:
            p.add_argument("--chronos-config", default=None)
        return p

    p = common(sub.add_parser("register"))
    p.add_argument("--agent-dir", required=True)
    p.add_argument("--kit-dir", default=None)
    common(sub.add_parser("unregister"))
    common(sub.add_parser("list"))
    p = common(sub.add_parser("enable"))
    p.add_argument("id")
    p.add_argument("--time", default=None)
    p.add_argument("--days", default=None)
    p = common(sub.add_parser("disable"))
    p.add_argument("id")
    p = sub.add_parser("validate")
    p.add_argument("--kit-dir", default=None)
    p = sub.add_parser("hook-add")
    p.add_argument("--agent-dir", required=True)
    p.add_argument("--chronos-dir", required=True)
    p = sub.add_parser("hook-remove")
    p.add_argument("--agent-dir", required=True)

    a = ap.parse_args(argv)
    if not a.cmd:
        ap.print_help()
        return 2
    return {"register": cmd_register, "unregister": cmd_unregister, "list": cmd_list,
            "enable": lambda x: cmd_enable(x, True), "disable": lambda x: cmd_enable(x, False),
            "validate": cmd_validate, "hook-add": cmd_hook_add, "hook-remove": cmd_hook_remove}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
