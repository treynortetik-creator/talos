#!/usr/bin/env python3
"""plugin-hook-probes.py <release folder> <sandbox>: run every hook a release registers, from the release, against a temp agent.

Used by scripts/test-plugin.sh. Each hook command is taken from <release>/templates/dot-claude/settings.json (what an agent's settings.json registers) and run through `sh -c` exactly as
Claude Code would (CLAUDE_PROJECT_DIR = the agent, the working directory = the agent), with
a temp HOME and XDG folders. The checks:
  * every registered command runs and does not crash;
  * the hooks that read the agent (session-start, statusline, memory-reflex, append-only-guard, timeline-guard, ...) act on the
    agent's files, and the ones that write (claim-gate, channel-debt, agent-log, compaction-guard, hands-free) write into the
    agent folder or the agent's own state folder, named after the agent;
  * nothing is created, changed or removed inside the release, and the state folder holds no dir named after the release.
The hook scripts are never given the agent folder any other way, so a hook that still used its own location fails here.
Prints "  ok   ..." / "  FAIL ..." lines; exits 1 on any FAIL. Python 3.9, standard library only."""
import hashlib
import json
import os
import re
import subprocess
import sys
import time

release, sb = os.path.realpath(sys.argv[1]), os.path.realpath(sys.argv[2])
fails = 0


def check(name, cond, detail=""):
    global fails
    if cond:
        print("  ok   %s" % name)
    else:
        fails += 1
        print("  FAIL %s%s" % (name, ("\n       " + str(detail)[:400]) if detail else ""))


def tree_hash(root):
    h = hashlib.sha256()
    for dp, dn, fn in os.walk(root):
        dn.sort()
        for n in sorted(fn + [d for d in dn if os.path.islink(os.path.join(dp, d))]):
            p = os.path.join(dp, n)
            h.update(os.path.relpath(p, root).encode() + b"\0")
            if os.path.islink(p):
                h.update(os.readlink(p).encode())
            elif os.path.isfile(p):
                h.update(open(p, "rb").read())
        h.update(("|".join(dn)).encode())
    return h.hexdigest()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


# ---------------------------------------------------------------- the temp agent (nobody here is real)
home = os.path.join(sb, "home")
agent = os.path.join(sb, "agent-one")
state_root = os.path.join(sb, "state")
cfg = os.path.join(sb, "cfg")
vault = os.path.join(sb, "vault")
today = time.strftime("%Y-%m-%d")
write(os.path.join(agent, ".talos-version"), "version=probe\n")
write(os.path.join(agent, "memory", "STATE.md"), "# STATE\n\n## ACTIVE FIVE\n- PROBE-STATE-7731 ship the thing\n")
write(os.path.join(agent, "memory", "HANDOFF.md"), "# Handoff\nwhere we stopped\n")
write(os.path.join(agent, "memory", "decisions-ledger.md"), "# Decisions\n" + "- 2026-10-01 decided something worth keeping on record\n" * 30)
write(os.path.join(agent, "memory", "real-artifact.md"), "made by the sub-agent\n")
write(os.path.join(agent, ".learnings", "LEARNINGS.md"),
      "# LEARNINGS\n\n## %s — never summarise the budget table (correction)\n**What happened:** I rounded the table.\n"
      "**Rule (apply every time):** keep every row.\n" % today)
write(os.path.join(agent, "wiki", "people", "dana-ruiz.md"),
      "---\ntitle: Dana Ruiz\ntype: person\ndescription: Vendor lead at Acme\n---\n\n# Dana Ruiz\n")
write(os.path.join(agent, "wiki", "_index.md"), "# Index\n- [[dana-ruiz]]\n")
write(os.path.join(vault, "_guard-terms.txt"), "# terms\nzebracorn\n")
for base in (os.path.join(home, ".config"), cfg):
    write(os.path.join(base, "talos", "vault-dir"), vault + "\n")
slug = "%s-%s" % (os.path.basename(agent), hashlib.sha1(agent.encode()).hexdigest()[:8])
SD = os.path.join(state_root, "talos", slug)

env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "TALOS_", "CHRONOS", "XDG_"))}
env.update(HOME=home, XDG_STATE_HOME=state_root, XDG_CONFIG_HOME=cfg, PYTHONDONTWRITEBYTECODE="1",
           CLAUDE_PROJECT_DIR=agent)

# the agent reaches the release the way a real one does: hooks/ and scripts/ are links, settings.json registers the hooks
for d in ("hooks", "scripts"):
    os.symlink(os.path.join(release, d), os.path.join(agent, d))
registry = json.load(open(os.path.join(release, "templates", "dot-claude", "settings.json")))["hooks"]
cmds = {}                         # (script, args) -> the command Claude Code would run
for event, entries in registry.items():
    for e in entries:
        for h in e["hooks"]:
            m = re.search(r'hooks/([\w.-]+\.(?:py|sh))"', h["command"])
            a = re.search(r'python3 "\$f"((?: [a-z]+)?)(?:;|$)', h["command"])
            cmds[(m.group(1), (a.group(1).strip() if a else ""))] = h["command"]
check("the settings template registers hooks and each runs a script that exists in the release",
      len(cmds) >= 15 and all(os.path.isfile(os.path.join(release, "hooks", s)) for s, _ in cmds), sorted(cmds)[:3])
before_release = tree_hash(release)


def run(script, args, payload, cwd=None, extra=None):
    command = cmds.get((script, args)) or 'python3 "$CLAUDE_PROJECT_DIR/hooks/%s" %s' % (script, args)
    e = dict(env)
    e.update(extra or {})
    r = subprocess.run(["sh", "-c", command], input=json.dumps(payload), capture_output=True, text=True, env=e,
                       cwd=cwd or agent, timeout=60)
    return r


def decision(r):
    try:
        return json.loads(r.stdout)["hookSpecificOutput"]["permissionDecision"]
    except Exception:
        return "none"


def crashed(r):
    return r.returncode not in (0, 2) or "Traceback" in r.stderr


# ---------------------------------------------------------------- every registration runs
bad = []
for (script, args) in sorted(cmds):
    r = run(script, args, {"session_id": "g1", "prompt": "hello", "tool_name": "Bash", "tool_input": {"command": "ls"},
                           "last_assistant_message": "done"}, extra={"TALOS_TG_CLAIM_FORCE": "1"})
    if crashed(r):
        bad.append((script, args, r.returncode, r.stderr[-200:]))
check("every registered hook command runs from the release without a crash (%d commands)" % len(cmds), not bad, bad)

# ---------------------------------------------------------------- the ones that read the agent
r = run("session-start.py", "", {"session_id": "s1", "hook_event_name": "SessionStart", "source": "startup"})
ctx = ""
try:
    ctx = json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"]
except Exception:
    pass
check("session-start reads memory/STATE.md of the agent (CLAUDE_PROJECT_DIR), not of the release", "PROBE-STATE-7731" in ctx, r.stdout[:200] + r.stderr[:200])
r = run("session-start.py", "", {"session_id": "s1", "source": "resume"}, cwd=os.path.join(agent, "wiki"))
try:
    ctx2 = json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"]
except Exception:
    ctx2 = ""
check("session-start started in a subfolder of the agent still finds the agent", "PROBE-STATE-7731" in ctx2, r.stdout[:200] + r.stderr[:200])
r = subprocess.run([sys.executable, os.path.join(release, "hooks", "statusline.py")], input=json.dumps({"model": {"display_name": "Probe"}}),
                   capture_output=True, text=True, env=env, cwd=agent)
check("statusline shows the age of the agent's memory/HANDOFF.md", "handoff:" in r.stdout, r.stdout + r.stderr[:200])
subprocess.run([sys.executable, os.path.join(release, "scripts", "wiki-gazetteer.py"), "--quiet"], env=env, cwd=agent, capture_output=True)
r = run("memory-reflex.py", "", {"session_id": "s1", "hook_event_name": "UserPromptSubmit", "prompt": "what did Dana Ruiz say about the vendor?"})
check("wiki-gazetteer (script) builds from the agent's wiki into the agent's state folder, and memory-reflex points at the note",
      os.path.isfile(os.path.join(SD, "gazetteer.json")) and "wiki/people/dana-ruiz.md" in r.stdout, r.stdout[:200] + r.stderr[:200])
r = run("append-only-guard.py", "", {"tool_name": "Write", "tool_input": {"file_path": os.path.join(agent, "memory", "decisions-ledger.md"), "content": "x"}})
check("append-only-guard sees the agent's ledger (a whole-file shrink asks)", decision(r) == "ask", r.stdout[:200] + r.stderr[:200])
bad_note = "---\ntitle: N\n---\n# N\n[[a]] [[b]]\n<!-- TIMELINE:APPEND-ONLY -->\n- **2026-09-23** | this transcript | @me — Coached Pat\nwhile she deleted the legacy classes. Confidence: high"
r = run("timeline-guard.py", "", {"tool_name": "Write", "tool_input": {"file_path": os.path.join(agent, "wiki", "people", "new.md"), "content": bad_note}})
check("timeline-guard runs the release's wiki-lint on a write inside the agent's wiki (a wrapped entry is refused)", decision(r) == "deny", r.stdout[:200] + r.stderr[:200])
r = run("check-vault.py", "", {"tool_name": "Write", "tool_input": {"file_path": os.path.join(agent, "wiki", "x.md"), "content": "met with zebracorn today"}})
check("check-vault reads the vault's guard terms and asks before a term lands in the agent's wiki", decision(r) == "ask", r.stdout[:200] + r.stderr[:200])
r = run("pre-tool-guard.py", "", {"tool_name": "Bash", "tool_input": {"command": "cat .env"}})
check("pre-tool-guard refuses cat .env", decision(r) == "deny" or r.returncode == 2, r.stdout[:200] + r.stderr[:200])
r = run("action-rules.py", "", {"tool_name": "Bash", "tool_input": {"command": "git push --force origin main"}})
check("action-rules reads the release's shipped rule table (a force-push to main is never)", decision(r) == "deny", r.stdout[:200] + r.stderr[:200])
r = run("bsd-sed-guard.py", "", {"tool_name": "Bash", "tool_input": {"command": "sed -i 's/a/b/' f.txt"}})
check("bsd-sed-guard runs (it blocks only with Apple's sed; elsewhere it stands down)", not crashed(r), r.stderr[-200:])

# ---------------------------------------------------------------- the ones that write
r = run("claim-gate.py", "", {"last_assistant_message": "There is no such file in the project.", "session_id": "s1"})
check("claim-gate (Stop) queues its notice in the agent's state folder", os.path.isfile(os.path.join(SD, "claim-gate-pending.json")), r.stderr[-200:])
r = run("claim-gate.py", "inject", {"prompt": "next", "session_id": "s1"})
check("claim-gate (inject) hands the notice back from there", "CLAIM GATE" in r.stdout, r.stdout[:200] + r.stderr[:200])
run("channel-debt.py", "arm", {"prompt": '<channel source="talos-app" chat_id="4242" message_id="1" kind="text">hello</channel>'})
check("channel-debt (arm) records the debt in the agent's state folder", os.path.isfile(os.path.join(SD, "channel-debt.json")))
r = run("channel-debt.py", "check", {})
check("channel-debt (check) blocks the turn from that debt", '"block"' in r.stdout and "4242" in r.stdout, r.stdout[:200] + r.stderr[:200])
run("agent-log.py", "", {"agent_type": "general-purpose", "description": "audit the notes", "last_assistant_message": "Wrote memory/real-artifact.md."})
log = ""
try:
    log = open(os.path.join(agent, "memory", "agent-log.md"), encoding="utf-8").read()
except OSError:
    pass
check("agent-log appends to memory/agent-log.md of the agent and lists the artifact that exists there", "real-artifact.md" in log, log[:200])
run("compaction-guard.py", "save", {"session_id": "s1"})
carry = ""
try:
    carry = open(os.path.join(SD, "compaction-carry.md"), encoding="utf-8").read()
except OSError:
    pass
check("compaction-guard (save) carries the agent's .learnings corrections into its state folder", "budget table" in carry, carry[:200])
r = run("hands-free.py", "on", {}) if ("hands-free.py", "on") in cmds else subprocess.run(
    ["sh", "-c", 'python3 "$CLAUDE_PROJECT_DIR/hooks/hands-free.py" on 30'], capture_output=True, text=True, env=env, cwd=agent)
check("hands-free (on) opens its window in the agent's state folder", any(n.startswith("hands-free") for n in os.listdir(SD)) if os.path.isdir(SD) else False,
      os.listdir(SD) if os.path.isdir(SD) else "no state folder")

# ---------------------------------------------------------------- nothing leaked into the release, nowhere else either
check("the release is byte-for-byte what it was (no file created, changed or removed in it)", tree_hash(release) == before_release)
dirs = sorted(os.listdir(os.path.join(state_root, "talos"))) if os.path.isdir(os.path.join(state_root, "talos")) else []
check("the state folder holds only this agent's folder (%s), nothing named after the release" % slug, dirs == [slug], dirs)
leak = [n for n in os.listdir(release) if n in ("memory", "wiki", ".learnings", ".index")]
check("no memory/, wiki/, .learnings/ or .index/ appeared in the release", not leak, leak)

# ---------------------------------------------------------------- the three copies of the agent-folder rule agree
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(release, "hooks"))
sys.path.insert(0, os.path.join(release, "scripts"))
import _agent_root  # noqa: E402
import _talos_common as C  # noqa: E402

ss_src = open(os.path.join(release, "hooks", "session-start.py"), encoding="utf-8").read()
ss_rule = ss_src[ss_src.index("def _is_release"):ss_src.index("PROJECT_DIR = _find_project_dir()")]
os.makedirs(os.path.join(sb, "elsewhere"), exist_ok=True)
link_hook = os.path.join(agent, "hooks")
link_scripts = os.path.join(agent, "scripts")
if not os.path.lexists(link_hook):
    os.symlink(os.path.join(release, "hooks"), link_hook)
    os.symlink(os.path.join(release, "scripts"), link_scripts)
cases = [
    ("CLAUDE_PROJECT_DIR is the agent", agent, os.path.join(agent, "hooks", "x.py"), sb),
    ("CLAUDE_PROJECT_DIR is a subfolder of the agent", os.path.join(agent, "wiki"), os.path.join(release, "hooks", "x.py"), sb),
    ("no variable, reached through the agent's hooks/ link", None, os.path.join(agent, "hooks", "x.py"), os.path.join(sb, "elsewhere")),
    ("no variable, run from the release, working directory is the agent", None, os.path.join(release, "hooks", "x.py"), agent),
    ("no variable, run from the release, working directory is inside the agent", None, os.path.join(release, "hooks", "x.py"), os.path.join(agent, "memory")),
]
for label, env_dir, here, cwd in cases:
    saved = os.environ.pop("CLAUDE_PROJECT_DIR", None)
    c1 = C.find_agent_root(env=env_dir or "", here=here, cwd=cwd)
    c2 = _agent_root.agent_root(here.replace("/hooks/", "/scripts/"), env=env_dir or "", cwd=cwd)
    code = ("import os,sys\n__file__=%r\n%s\nprint(_find_project_dir())" % (here, ss_rule))
    e = dict(os.environ)
    e.pop("CLAUDE_PROJECT_DIR", None)
    if env_dir:
        e["CLAUDE_PROJECT_DIR"] = env_dir
    c3 = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=e, cwd=cwd).stdout.strip()
    if saved is not None:
        os.environ["CLAUDE_PROJECT_DIR"] = saved
    check("the agent folder is found by all three copies of the rule: %s" % label, c1 == c2 == c3 == agent, (c1, c2, c3))
r = subprocess.run([sys.executable, os.path.join(release, "hooks", "session-start.py")], input="{}", capture_output=True, text=True,
                   env=dict(env, CLAUDE_PROJECT_DIR=os.path.join(sb, "no-such-folder")), cwd=agent)
check("session-start refuses (empty output, a line on stderr, nothing written) when CLAUDE_PROJECT_DIR names no folder",
      r.stdout.strip() == "{}" and "refusing" in r.stderr, r.stdout + r.stderr[:200])
r = subprocess.run([sys.executable, os.path.join(release, "hooks", "session-start.py")], input="{}", capture_output=True, text=True,
                   env=dict(env, CLAUDE_PROJECT_DIR=release), cwd=release)
check("session-start refuses when CLAUDE_PROJECT_DIR is the plugin release itself", r.stdout.strip() == "{}" and "refusing" in r.stderr, r.stdout + r.stderr[:200])
check("the release is still untouched after all of that", tree_hash(release) == before_release)
sys.exit(1 if fails else 0)
