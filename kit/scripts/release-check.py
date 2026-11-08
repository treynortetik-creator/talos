#!/usr/bin/env python3
"""release-check.py: the checks a release runs on itself. `talos update` runs them from the NEW release, so a release decides
what "started cleanly" means for itself.

    release-check.py release --release DIR                        before anything is swapped: is this folder a whole release?
    release-check.py start   --release DIR --agent DIR [--vendor DIR]   after the swap and the migrations: does the agent folder
                                                                  load it? Exit 0 = yes; any other exit makes the update roll back.

`release` checks: .claude-plugin/plugin.json parses and its version is the release's; .talos-release's content hash matches the
files; every hook script the settings template registers exists in hooks/ and compiles; every migration keeps its contract.
`start` checks the agent folder against the release: hooks/ and scripts/ are links that lead into the release `current` names;
settings.json parses, names the marketplace and the plugin, and every kit hook command in it points at a script that exists;
the SessionStart hook is registered for real; the marketplace's plugin path leads to the release. It does not start Claude Code:
a session would write the owner's memory. Python 3.9, standard library only."""
import argparse
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def fail(msg):
    print("release-check: FAIL: " + msg)
    sys.exit(1)


def load_json(path, what):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        fail("%s is missing (%s)" % (what, path))
    except ValueError as e:
        fail("%s is not valid JSON (%s): %s" % (what, path, e))


HOOK_REF = re.compile(r"\$\{?CLAUDE_PROJECT_DIR\}?\"?/hooks/([A-Za-z0-9_.-]+\.(?:py|sh))")


def template_hooks(release):
    t = load_json(os.path.join(release, "templates", "dot-claude", "settings.json"), "the settings template")
    return t.get("hooks") or {}


def commands(hooks):
    for ev, entries in (hooks or {}).items():
        for e in entries if isinstance(entries, list) else []:
            for h in (e.get("hooks") or []) if isinstance(e, dict) else []:
                if isinstance(h, dict) and isinstance(h.get("command"), str):
                    yield ev, h["command"]


def compiles(path):
    try:
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
    except OSError as e:
        return str(e)
    if path.endswith(".py"):
        try:
            compile(src, path, "exec")
        except SyntaxError as e:
            return "syntax error line %s: %s" % (e.lineno, e.msg)
    else:
        r = subprocess.run(["bash", "-n", path], capture_output=True, text=True)
        if r.returncode != 0:
            return r.stderr.strip() or "bash -n failed"
    return None


def cmd_release(a):
    rel = os.path.realpath(a.release)
    manifest = load_json(os.path.join(rel, ".claude-plugin", "plugin.json"), "plugin.json")
    kv = {}
    try:
        for line in open(os.path.join(rel, ".talos-release"), encoding="utf-8"):
            if "=" in line and not line.startswith("#"):
                k, v = line.strip().split("=", 1)
                kv[k] = v
    except OSError:
        fail(".talos-release is missing")
    if manifest.get("version") != kv.get("version"):
        fail("plugin.json says version %r but .talos-release says %r" % (manifest.get("version"), kv.get("version")))
    import importlib.util
    spec = importlib.util.spec_from_file_location("plugin_release", os.path.join(HERE, "plugin-release.py"))
    pr = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pr)
    if pr.content_sha(rel) != kv.get("content_sha256"):
        fail("the files do not match the content hash in .talos-release (the release was changed after it was built)")
    for ev, c in commands(template_hooks(rel)):
        for name in HOOK_REF.findall(c):
            p = os.path.join(rel, "hooks", name)
            if not os.path.isfile(p):
                fail("the settings template registers hooks/%s (%s) but the release does not ship it" % (name, ev))
            problem = compiles(p)
            if problem:
                fail("hooks/%s does not compile: %s" % (name, problem))
    r = subprocess.run([sys.executable, os.path.join(rel, "scripts", "talos-migrate.py"), "check", "--release", rel], capture_output=True, text=True)
    if r.returncode != 0:
        fail("a migration breaks its contract:\n" + r.stdout.strip())
    print("release-check: %s is a whole release (%s)" % (rel, kv.get("version")))


def cmd_start(a):
    rel = os.path.realpath(a.release)
    agent = os.path.realpath(a.agent)
    vendor = os.path.realpath(a.vendor) if a.vendor else os.path.dirname(os.path.dirname(os.path.dirname(rel)))
    cur = os.path.realpath(os.path.join(vendor, "current", "talos-kit"))
    if cur != rel:
        fail("current points at %s, not at this release (%s)" % (cur, rel))
    for d in ("hooks", "scripts"):
        p = os.path.join(agent, d)
        if not os.path.islink(p):
            fail("%s is not a link into the release" % p)
        if os.path.realpath(p) != os.path.join(rel, d):
            fail("%s leads to %s, not into this release" % (p, os.path.realpath(p)))
    settings = load_json(os.path.join(agent, ".claude", "settings.json"), "settings.json")
    if not isinstance(settings, dict):
        fail("settings.json is not a JSON object")
    mk = (settings.get("extraKnownMarketplaces") or {}).get("talos-local")
    if not (isinstance(mk, dict) and isinstance(mk.get("source"), dict) and os.path.realpath(mk["source"].get("path", "")) == vendor):
        fail("settings.json does not name the talos-local marketplace at %s" % vendor)
    if (settings.get("enabledPlugins") or {}).get("talos@talos-local") is not True:
        fail("settings.json does not enable talos@talos-local")
    market = load_json(os.path.join(vendor, ".claude-plugin", "marketplace.json"), "marketplace.json")
    src = (market.get("plugins") or [{}])[0].get("source", "")
    if os.path.realpath(os.path.join(vendor, src)) != rel:
        fail("the marketplace's plugin source %r does not lead to this release" % src)
    for ev, c in commands(settings.get("hooks")):
        for name in HOOK_REF.findall(c):
            p = os.path.join(agent, "hooks", name)
            if not os.path.isfile(p):
                fail("settings.json (%s) runs hooks/%s, which the release does not have" % (ev, name))
            problem = compiles(p)
            if problem:
                fail("hooks/%s does not compile: %s" % (name, problem))
    sub = subprocess.run([sys.executable, os.path.join(rel, "scripts", "_check_hook_registration.py")], cwd=agent, capture_output=True, text=True)
    line = (sub.stdout or "").strip().splitlines()[-1] if (sub.stdout or "").strip() else ""
    if not line.startswith("OK"):
        fail("the SessionStart hook is not registered for real: %s" % (line or sub.stderr.strip()[:200]))
    print("release-check: the agent folder loads release %s (links, settings.json, %d hook commands, SessionStart)" % (
        os.path.basename(os.path.dirname(rel)), sum(1 for _ in commands(settings.get("hooks")))))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("cmd", choices=["release", "start"])
    ap.add_argument("--release", required=True)
    ap.add_argument("--agent")
    ap.add_argument("--vendor")
    a = ap.parse_args()
    if a.cmd == "start":
        if not a.agent:
            fail("start needs --agent")
        cmd_start(a)
    else:
        cmd_release(a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
