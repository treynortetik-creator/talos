#!/usr/bin/env python3
"""talos-jobs.py -- register, list, enable and remove the Talos jobs in Chronos.

Chronos (https://github.com/treynortetik-creator/chronos) is the scheduler. A Chronos job is one entry in
jobs.json plus a folder jobs/<id>/ holding prompt.md (and optionally a locked guard.md); a "command" job
(Chronos 0.2.1) is just the entry and a shell command, no folder. Talos ships five of them in jobs/ in this kit. This script copies them into your Chronos config, fills in the path of your
agent folder, and never overwrites a job you have already edited.

  talos-jobs.py register   --agent-dir DIR [--chronos-config FILE] [--kit-dir DIR] [--full-access]
  talos-jobs.py unregister [--chronos-config FILE]            remove every job whose id starts with talos-
  talos-jobs.py list       [--chronos-config FILE]                   shows each job's access: RESTRICTED or FULL ACCESS
  talos-jobs.py access ID --restricted|--full --agent-dir DIR [--kit-dir DIR] [--chronos-config FILE]
                                                            switch one job between the tool-restricted default and
                                                            full access (the opt-out; needs your say-so, see README)
  talos-jobs.py allow ID TOOL [TOOL ...] [--remove] [--allow-write-tools] [--chronos-config FILE]
                                                            give a restricted job exact MCP tools (e.g. the read-only mail and
                                                            calendar tools the morning brief reads) without opening it up
  talos-jobs.py harden --agent-dir DIR [--kit-dir DIR] [--full-access] [--chronos-config FILE]
                                                            upgrade jobs registered by Talos 1.1.1 to restricted
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
import hashlib
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

# Chronos 0.2.2 added "restricted": true (scheduled runs use the job's allowed_tools instead of skipping permissions).
# An older Chronos IGNORES the key and runs the job with --dangerously-skip-permissions, so a "restricted" job on an
# old Chronos would be restricted in name only. register and enable therefore refuse it (and say how to update).
RESTRICTED_MIN_CHRONOS = (0, 2, 2)
# Tools a restricted shipped job may never be given. A bare Bash allows every command; the rest talk to the network or
# spawn other agents with their own tool sets.
FORBIDDEN_SHIPPED_TOOLS = ("Bash", "WebFetch", "WebSearch", "Task", "Agent", "NotebookEdit")
# sha256 of every prompt.md / guard.md that Talos 1.1.1-cli shipped, as written in the kit (placeholder form).
# `harden` replaces a registered job's file only when it still hashes to one of these, i.e. the user never edited it.
LEGACY_PROMPT_HASHES = {
    ("talos-morning-brief", "prompt.md"): "1c05a7a4dbc063788d27b637ba356004cf051443f749f2a24fa5e34214d81d9e",
    ("talos-morning-brief", "guard.md"): "d96688a425d59b30ea2ac1d2a20efa57cde8574349b259a89e1832c7ebe3a436",
    ("talos-state-sweep", "prompt.md"): "b8215f0a730b577dd7f51588876bbe2afc88867c8e828df6965d07f6aa0c63b3",
    ("talos-state-sweep", "guard.md"): "aa5ebb46e63a94bed2a8384001f4c427fc6858058626731bbbcc685ddcc3f19a",
    ("talos-weekly-snapshot", "prompt.md"): "fea2a96cf90383f6e42313b9a9a85ce1ed765a4ae7844dd4776d751567c3e579",
    ("talos-weekly-snapshot", "guard.md"): "a48ceb4db484379e2065984d547ebf64d495534e719867f2f8c28245b9f70b15",
    ("talos-weekly-wiki-lint", "prompt.md"): "39ac61e4a2e291b5dc4d9d43a142db44f48b8e7b5eee23ac6752ba8af7f77466",
    ("talos-weekly-wiki-lint", "guard.md"): "811548b63f57cd72e1085499bba92bb2b06bac289cd27f741d7ad3e18fb345e0",
}

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
    if "restricted" in j and not isinstance(j.get("restricted"), bool):
        errs.append("%s: restricted must be true or false (a string or a number is invalid, never read as unrestricted)" % jid)
    if j.get("restricted") is True and j.get("kind") == "command":
        errs.append("%s: a command job runs one fixed shell command and has no tools to restrict" % jid)
    if j.get("restricted") is True and j.get("in_session") is True:
        errs.append("%s: a restricted job cannot also run in a live session (that run would use the session's own permissions)" % jid)
    at = j.get("allowed_tools")
    if at is not None and (not isinstance(at, list) or len(at) > 24 or not all(isinstance(x, str) and x.strip() for x in at)):
        errs.append("%s: allowed_tools must be a list of at most 24 tool rules" % jid)
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


def is_restricted(j):
    return isinstance(j, dict) and j.get("restricted") is True


def render_job(j, agent, full_access=False):
    """A copy of a shipped template record, ready for jobs.json. Restricted by default: the agent folder is filled
    into the tool rules. full_access (the documented opt-out) records `restricted: false` and drops the tool list."""
    rec = dict(j)
    if is_command(rec):
        rec["command"] = str(rec["command"]).replace(PLACEHOLDER, shlex.quote(agent))
        return rec
    if full_access:
        rec.pop("allowed_tools", None)
        rec["restricted"] = False
    elif rec.get("allowed_tools"):
        rules = []
        real = os.path.realpath(agent)
        for t in rec["allowed_tools"]:
            t = str(t)
            rules.append(t.replace(PLACEHOLDER, agent))
            # a path rule is matched against the file's real path: if the agent folder is reached through a symlink
            # (a linked home folder), also allow the resolved spelling, or the job could not read its own folder.
            # Bash rules are NOT duplicated: they must equal the command text the prompt tells the job to run.
            if real != agent and t.split("(", 1)[0] in ("Read", "Grep", "Glob", "Edit", "Write", "MultiEdit"):
                alt = t.replace(PLACEHOLDER, real)
                if alt not in rules:
                    rules.append(alt)
        rec["allowed_tools"] = rules
    return rec


def legacy_hash(path, agent):
    """sha256 of a registered prompt/guard with the agent path turned back into the placeholder, or None."""
    try:
        text = open(path, encoding="utf-8").read()
    except OSError:
        return None
    return hashlib.sha256(text.replace(agent, PLACEHOLDER).encode("utf-8")).hexdigest()


def parse_version(text):
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", str(text or ""))
    return tuple(int(x) for x in m.groups()) if m else None


TICK_LABEL = "io.github.chronos.tick"
UPDATE_CHRONOS_HELP = (
    "To move the Chronos that actually runs your jobs to the version Talos pins: for a NEW agent folder, re-run ./install.sh "
    "with --reinstall-chronos (it re-runs Chronos's own installer, which rewrites the launchd plist). For an agent you already "
    "have: git -C ~/.local/share/talos/chronos fetch origin && git -C ~/.local/share/talos/chronos checkout --detach <the "
    "CHRONOS_PINNED_REF at the top of install.sh> && bash ~/.local/share/talos/chronos/install.sh --workspace <your agent folder> "
    "(the Chronos clone is a detached checkout, so `git pull` does nothing there).")


def installed_chronos():
    """(version tuple or None, description) for the Chronos that LAUNCHD actually runs.

    The clone Talos made (recorded in ~/.config/talos/chronos-dir) is NOT authoritative: when a Chronos config already existed,
    install.sh leaves Chronos's installer alone, so launchd can still be running an older copy than the pinned clone. The tick
    agent's plist names the script it runs (<runtime>/bin/chronos-tick.sh), so the version is read from THAT runtime's
    lib/chronoslib.py. Anything that cannot be read is None: the caller must treat None as unknown, not as new enough."""
    import plistlib
    agents = os.environ.get("CHRONOS_LAUNCHAGENTS_DIR") or os.path.join(os.path.expanduser("~"), "Library", "LaunchAgents")
    plist = os.path.join(agents, TICK_LABEL + ".plist")
    try:
        with open(plist, "rb") as fh:
            data = plistlib.load(fh)
    except Exception:
        return None, "no Chronos scheduler is installed (no %s)" % plist
    script = next((str(x) for x in (data.get("ProgramArguments") or []) if str(x).endswith("chronos-tick.sh")), "")
    if not script:
        return None, "%s does not name a chronos-tick.sh" % plist
    runtime = os.path.dirname(os.path.dirname(script))
    try:
        txt = open(os.path.join(runtime, "lib", "chronoslib.py"), encoding="utf-8").read(20000)
    except OSError:
        return None, "cannot read the Chronos runtime that %s points at (%s)" % (TICK_LABEL, runtime)
    m = re.search(r'^VERSION\s*=\s*["\']([^"\']+)["\']', txt, re.M)
    v = parse_version(m.group(1)) if m else None
    if v is None:
        return None, "cannot read a version from %s/lib/chronoslib.py" % runtime
    return v, "Chronos %s at %s" % (".".join(str(x) for x in v), runtime)


def chronos_version():
    """The version of the Chronos that launchd runs, or None when it cannot be determined (see installed_chronos)."""
    return installed_chronos()[0]


def restricted_blocker():
    """None when the Chronos that launchd runs is known to be 0.2.2 or newer; otherwise the plain-English reason a restricted
    job must not be registered or enabled. An older Chronos IGNORES "restricted": true and would run the job with permission
    prompts skipped, and an UNKNOWN version cannot be trusted either: both refuse."""
    v, where = installed_chronos()
    if v is None:
        return "I cannot tell which Chronos will run your jobs (%s). Restricted jobs need Chronos 0.2.2 or newer, and a Chronos that " \
               "ignores the setting would run them with permission prompts skipped. %s" % (where, UPDATE_CHRONOS_HELP)
    if v < RESTRICTED_MIN_CHRONOS:
        return "the Chronos that runs your jobs is %s; restricted jobs need 0.2.2 (an older Chronos ignores the setting and would " \
               "run them with permission prompts skipped). %s" % (where, UPDATE_CHRONOS_HELP)
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
        # shipped Claude jobs are RESTRICTED by default, with a tool list that names the agent folder by placeholder
        if j.get("restricted") is not True:
            problems.append("%s: shipped Claude jobs must be restricted (\"restricted\": true)" % jid)
        tools = j.get("allowed_tools")
        if not isinstance(tools, list) or not tools:
            problems.append("%s: a restricted shipped job needs an allowed_tools list" % jid)
            tools = []
        for t in tools:
            base = str(t).split("(", 1)[0]
            if base in FORBIDDEN_SHIPPED_TOOLS and "(" not in str(t):
                problems.append("%s: allowed_tools names %s with no restriction" % (jid, base))
            if base.startswith("mcp__"):
                problems.append("%s: a shipped job names no MCP tool (the owner adds read-only ones; see MORNING-BRIEF.md): %s" % (jid, t))
            if base == "Bash":
                body = str(t)[5:-1]
                if body == "date":
                    continue
                if not re.match(r"^(bash|python3) \{\{TALOS_HOME\}\}/scripts/[A-Za-z0-9_./-]+( [A-Za-z0-9_.-]+)*$", body):
                    problems.append("%s: Bash rule must be an exact command that runs one of the kit's own scripts: %s" % (jid, t))
            elif base in ("Edit", "Write", "MultiEdit"):
                if not str(t).startswith(base + "(/" + PLACEHOLDER + "/"):
                    problems.append("%s: %s rule must be scoped inside the agent folder: %s" % (jid, base, t))
            elif base in ("Read", "Grep", "Glob"):
                if str(t) != "%s(/%s/**)" % (base, PLACEHOLDER):
                    problems.append("%s: %s must be scoped to the agent folder, exactly %s(/%s/**): a bare %s can read the whole disk" % (jid, base, base, PLACEHOLDER, base))
            else:
                problems.append("%s: tool %s is outside the shipped allow-list vocabulary (scoped Read/Grep/Glob/Edit, exact Bash)" % (jid, t))
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
        # every command a prompt tells the job to run must be covered by a Bash rule (a prompt that asks for something
        # the tool list refuses is a job that fails at 7am); and a restricted prompt must not tell it to `cd` or write markers
        for cmd in re.findall(r"`((?:bash|python3) \{\{TALOS_HOME\}\}/scripts/[^`]+)`", text):
            if "Bash(%s)" % cmd not in tools:
                problems.append("%s: prompt.md runs `%s` but no Bash rule allows exactly that" % (jid, cmd))
        if re.search(r"`(?:bash|python3) scripts/", text):
            problems.append("%s: prompt.md runs a script by a relative path; restricted rules match the full path" % jid)
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
    added, kept, skipped, restricted_skipped = [], [], [], []
    cv = chronos_version()
    old_chronos = None if a.full_access else restricted_blocker()
    if re.search(r"\s", agent) and not a.full_access:
        print("  WARNING: %r contains a space. A restricted job's command rules name the agent folder, and a path with a space "
              "cannot be matched reliably, so those jobs would be refused their own scripts (they fail closed, loudly). "
              "Use a folder name without spaces, or --full-access if you accept unrestricted scheduled runs." % agent)
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
                rec = render_job(j, agent)
                rec["created"] = rec["updated"] = now_iso()
                jobs.append(rec)
                added.append(jid)
                continue
            if is_restricted(j) and not a.full_access and old_chronos:
                restricted_skipped.append((jid, old_chronos))
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
            rec = render_job(j, agent, a.full_access)
            rec["created"] = rec["updated"] = now_iso()
            jobs.append(rec)
            added.append(jid)
        if added:
            write_jobs(jf, jobs)
    for jid in added:
        print("  registered %s (disabled)" % jid)
    for jid in kept:
        print("  kept existing %s (not overwritten)" % jid)
    for jid, why in restricted_skipped:
        print("  SKIPPED %s (tool-restricted): %s Then run this again, or pass --full-access to register it unrestricted." % (jid, why))
    for jid, ver in skipped:
        print("  SKIPPED %s: it is a plain command job and your Chronos is %s (command jobs need 0.2.1). "
              "%s Then run this again." % (jid, ver, UPDATE_CHRONOS_HELP))
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
        acc = "command" if is_command(j) else ("INVALID" if ("restricted" in j and not isinstance(j["restricted"], bool))
                                                else ("RESTRICTED" if is_restricted(j) else "FULL ACCESS"))
        print("%-26s %-8s %-11s %s %s" % (j["id"], "ON" if j.get("enabled") else "disabled", acc,
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
        if on and is_restricted(hit):
            why = restricted_blocker()
            if why:
                die("%s is a tool-restricted job, not enabled: %s" % (a.id, why))
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


def cmd_access(a):
    """Switch one registered job between restricted (the default) and full access (the documented opt-out)."""
    if a.restricted == a.full:
        die("pass exactly one of --restricted or --full")
    kit = os.path.abspath(a.kit_dir or kit_dir_default())
    agent = os.path.abspath(os.path.expanduser(a.agent_dir))
    tmpl = {j["id"]: j for j in template_jobs(kit) if isinstance(j, dict)}
    jf, _ = load_chronos(a.chronos_config)
    with JobsLock(jf):
        jobs = read_jobs(jf)
        hit = next((j for j in jobs if isinstance(j, dict) and j.get("id") == a.id), None)
        if hit is None:
            die("no job %r in %s" % (a.id, jf))
        if is_command(hit):
            die("%s is a plain command job: it runs one fixed command and has no tools to restrict" % a.id)
        if a.full:
            hit["restricted"] = False
            hit.pop("allowed_tools", None)
        else:
            why = restricted_blocker()
            if why:
                die("not changed: %s" % why)
            if a.id not in tmpl or not tmpl[a.id].get("allowed_tools"):
                die("%s is not a shipped Talos job, so there is no default tool list for it. Set \"restricted\": true and "
                    "\"allowed_tools\" in jobs.json (or the Chronos UI) yourself." % a.id)
            hit["restricted"] = True
            hit["allowed_tools"] = render_job(tmpl[a.id], agent)["allowed_tools"]
        hit["updated"] = now_iso()
        errs = check_job(hit)
        if errs:
            die("not saved: " + "; ".join(errs))
        write_jobs(jf, jobs)
    print("%s is now %s" % (a.id, "FULL ACCESS (scheduled runs skip permission prompts)" if a.full else "RESTRICTED"))
    if a.full:
        print("  Restore with:  python3 scripts/talos-jobs.py access %s --restricted --agent-dir <agent folder>" % a.id)
    return 0


# An MCP tool name that contains one of these is probably not read-only. `allow` refuses it unless told otherwise.
WRITE_WORDS = ("send", "reply", "forward", "post", "create", "update", "delete", "trash", "remove", "edit", "write", "modify",
               "share", "schedule", "label", "move", "archive", "upload", "publish", "invite", "execute", "run", "submit",
               "cancel", "merge", "push", "commit", "spam", "mark", "apply", "copy", "rename", "set", "add", "draft")
MCP_TOOL_RE = re.compile(r"^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$")


def looks_like_write(tool):
    """True when a word in the tool's own name (snake_case, kebab-case or camelCase) is a verb that changes something."""
    words = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", tool).replace("_", " ").replace("-", " ").lower().split()
    return any(w in WRITE_WORDS or w.rstrip("s") in WRITE_WORDS or w.rstrip("d") in WRITE_WORDS or w.startswith("authenticat") for w in words)


def cmd_allow(a):
    """Add (or remove) exact MCP tools on a restricted job. This is how the morning brief gets its read-only mail,
    calendar and chat tools: by name, one at a time, never a wildcard and never a whole server."""
    jf, _ = load_chronos(a.chronos_config)
    rules = []
    for t in a.tools:
        t = t.strip()
        if t == "ToolSearch" or MCP_TOOL_RE.match(t):
            rules.append(t)
        else:
            die("%r is not an exact MCP tool name (mcp__<server>__<tool>, no wildcard). To add other rules edit the job in jobs.json "
                "or the Chronos UI; see README, 'Giving a restricted job more'." % t)
    for t in rules:
        if t.startswith("mcp__") and not a.remove and not a.allow_write_tools and looks_like_write(t.split("__", 2)[2]):
            die("%s looks like it can change something (send, create, update, delete, ...). A restricted job should read only. "
                "If you are sure it is read-only, repeat with --allow-write-tools." % t)
    with JobsLock(jf):
        jobs = read_jobs(jf)
        hit = next((j for j in jobs if isinstance(j, dict) and j.get("id") == a.id), None)
        if hit is None:
            die("no job %r in %s" % (a.id, jf))
        if not is_restricted(hit):
            die("%s is not a restricted job (it runs with full access); there is no tool list to extend. "
                "Restore it with: talos-jobs.py access %s --restricted --agent-dir <agent folder>" % (a.id, a.id))
        cur = list(hit.get("allowed_tools") or [])
        if a.remove:
            cur = [t for t in cur if t not in rules]
        else:
            if any(t.startswith("mcp__") for t in rules) and "ToolSearch" not in cur and "ToolSearch" not in rules:
                rules.append("ToolSearch")        # MCP tools are deferred: the run needs the loader to reach them
            for t in rules:
                if t not in cur:
                    cur.append(t)
        if len(cur) > 24:
            die("a job may carry at most 24 tool rules")
        hit["allowed_tools"] = cur
        hit["updated"] = now_iso()
        errs = check_job(hit)
        if errs:
            die("not saved: " + "; ".join(errs))
        write_jobs(jf, jobs)
    print("%s now allows: %s" % (a.id, ", ".join(cur)))
    return 0


def cmd_harden(a):
    """Bring jobs registered by Talos 1.1.1 up to 1.1.2: restricted + tool list, and the new prompt/guard text when the
    user never edited the old one. A job that already has a `restricted` key (either value) is left alone."""
    kit = os.path.abspath(a.kit_dir or kit_dir_default())
    agent = os.path.abspath(os.path.expanduser(a.agent_dir))
    if not os.path.isdir(agent):
        die("agent folder %s does not exist" % agent)
    jf, jd = load_chronos(a.chronos_config)
    tmpl = {j["id"]: j for j in template_jobs(kit) if isinstance(j, dict)}
    if not a.full_access:
        why = restricted_blocker()
        if why:
            die("nothing changed: %s Or pass --full-access to record that you want these jobs unrestricted." % why)
    changed = []
    with JobsLock(jf):
        jobs = read_jobs(jf)
        plan = []                       # phase 1: work out and VALIDATE every change; nothing is written until all are valid
        for j in jobs:
            jid = str(j.get("id", "")) if isinstance(j, dict) else ""
            if not jid.startswith(PREFIX) or is_command(j) or "restricted" in j or jid not in tmpl:
                continue
            new = render_job(tmpl[jid], agent, a.full_access)
            upd = dict(j)
            upd["restricted"] = new["restricted"] if "restricted" in new else True
            if "allowed_tools" in new:
                upd["allowed_tools"] = new["allowed_tools"]
            upd["updated"] = now_iso()
            notes = []
            if upd["restricted"] is True and upd.get("in_session") is True:
                # a restricted job cannot also run in a live session (that run would use the session's own permissions, and
                # Chronos refuses the pair): switch the live-session arming off rather than write an invalid job
                upd["in_session"] = False
                notes.append("in_session switched OFF (a restricted job cannot run in a live session; Chronos still runs it on schedule)")
            errs = check_job(upd)
            if errs:
                die("nothing changed: %s would be invalid after hardening: %s" % (jid, "; ".join(errs)))
            plan.append((j, upd, jid, notes))
        for j, upd, jid, notes in plan:  # phase 2: write
            if not a.full_access:
                for fname in ("prompt.md", "guard.md"):
                    dst = os.path.join(jd, jid, fname)
                    if not os.path.isfile(dst):
                        continue
                    want = LEGACY_PROMPT_HASHES.get((jid, fname))
                    if want and legacy_hash(dst, agent) == want:
                        text = open(os.path.join(kit, "jobs", jid, fname), encoding="utf-8").read().replace(PLACEHOLDER, agent)
                        with open(dst, "w", encoding="utf-8") as fh:
                            fh.write(text)
                        notes.append("%s updated" % fname)
                    else:
                        notes.append("%s KEPT (you edited it: check that every command in it is one the tool list allows)" % fname)
            j.clear()
            j.update(upd)
            changed.append((jid, notes))
        if changed:
            write_jobs(jf, jobs)
    if not changed:
        print("  nothing to harden: every Talos job already has a restricted setting")
    for jid, notes in changed:
        print("  %s: %s%s" % (jid, "FULL ACCESS recorded" if a.full_access else "now RESTRICTED", ("; " + "; ".join(notes)) if notes else ""))
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
    p.add_argument("--full-access", action="store_true",
                   help="register the Claude jobs WITHOUT the tool restriction (scheduled runs skip permission prompts)")
    p = common(sub.add_parser("access"))
    p.add_argument("id")
    p.add_argument("--restricted", action="store_true")
    p.add_argument("--full", action="store_true")
    p.add_argument("--agent-dir", required=True)
    p.add_argument("--kit-dir", default=None)
    p = common(sub.add_parser("allow"))
    p.add_argument("id")
    p.add_argument("tools", nargs="+")
    p.add_argument("--remove", action="store_true")
    p.add_argument("--allow-write-tools", action="store_true")
    p = common(sub.add_parser("harden"))
    p.add_argument("--agent-dir", required=True)
    p.add_argument("--kit-dir", default=None)
    p.add_argument("--full-access", action="store_true")
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
            "access": cmd_access, "allow": cmd_allow, "harden": cmd_harden,
            "validate": cmd_validate, "hook-add": cmd_hook_add, "hook-remove": cmd_hook_remove}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
