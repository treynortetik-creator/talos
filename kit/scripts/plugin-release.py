#!/usr/bin/env python3
"""plugin-release.py: build a Talos release (the kit's Talos zone as a Claude Code plugin) outside any agent folder.

    python3 scripts/plugin-release.py build    [--source KIT] [--vendor DIR] [--activate]
    python3 scripts/plugin-release.py activate [--vendor DIR] --version V
    python3 scripts/plugin-release.py paths    [--vendor DIR]          # vendor, marketplace, plugin root, as KEY=value lines

Where things go (VENDOR is $TALOS_KIT_HOME, else $TALOS_VENDOR_DIR/kit, else ${XDG_DATA_HOME:-~/.local/share}/talos/kit):

    VENDOR/.claude-plugin/marketplace.json      one plugin, "talos", whose source is ./current/talos-kit
    VENDOR/current                              a symlink to one of the releases; swapping it moves every agent at once
    VENDOR/releases/<version>/talos-kit/        the plugin: .claude-plugin/plugin.json, hooks/ (the hook scripts; no hooks.json),
                                                skills/, agents/, bin/, scripts/, migrations/, templates/ ... Read-only.

The agent's .claude/settings.json names VENDOR as a local-folder marketplace (extraKnownMarketplaces) and enables
talos@talos-local. Claude Code loads a relative-path plugin of a local-folder marketplace IN PLACE, so
${CLAUDE_PLUGIN_ROOT} is VENDOR/current/talos-kit and a swapped `current` takes effect at the next session start
(code.claude.com/docs/en/plugins/loading, "In-place and copied plugins"; scripts/test-plugin.sh proves it with the real CLI).

The plugin registers NO hooks (no hooks/hooks.json). Every hook, the safety guards first, is registered in the agent folder's own
.claude/settings.json as `$CLAUDE_PROJECT_DIR/hooks/<script>` (the hooks/ link leads into the active release). Why: Claude Code does
not load a plugin that only project settings enable when the folder was never trusted (`claude -p`, which is how Chronos runs, says
"Skipping orphaned enabledPlugins entry" and registers 0 hooks), so a guard registered by the plugin would not exist in a headless
run. Settings hooks are fixed text that never changes per release. The plugin carries what Claude Code may load later: skills,
agents, bin/. A release is immutable: building a version that already exists with different content is refused (bump VERSION).
Python 3.9, standard library only.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys

PLUGIN_NAME = "talos"
MARKETPLACE_NAME = "talos-local"
PLUGIN_KEY = PLUGIN_NAME + "@" + MARKETPLACE_NAME
PLUGIN_DIR = "talos-kit"
DESCRIPTION = "The Talos zone: memory hooks, safety guards, skills, agents and helper scripts for a Talos agent."

# Not part of a release: the repo's own files, test fixtures, and the agent's data (a fresh install copies those from the
# source kit; a release never carries anything an agent writes).
SKIP_TOP = {".git", "docs", "memory", "wiki", ".learnings", ".index"}
SKIP_NAMES = {".DS_Store", "__pycache__", ".releaseignore"}
SKIP_PATHS = {"scripts/fixtures", "CLAUDE.md"}      # CLAUDE.md at a plugin root is never loaded; the agent's is rendered from templates/


def vendor_default():
    if os.environ.get("TALOS_KIT_HOME"):
        return os.path.abspath(os.environ["TALOS_KIT_HOME"])
    base = os.environ.get("TALOS_VENDOR_DIR") or os.path.join(
        os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"), "talos")
    return os.path.abspath(os.path.join(base, "kit"))


def kit_source_default():
    return os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


def read_version(src):
    with open(os.path.join(src, "VERSION"), encoding="utf-8") as fh:
        v = fh.read().strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]*", v):
        raise SystemExit("plugin-release: VERSION %r is not a safe folder name" % v)
    return v


def plugin_manifest(version):
    return {"name": PLUGIN_NAME, "version": version, "description": DESCRIPTION,
            "author": {"name": "Talos"}, "keywords": ["talos", "agent", "memory", "guards"]}


def marketplace_manifest():
    return {"name": MARKETPLACE_NAME, "description": "The Talos kit releases installed on this machine.",
            "owner": {"name": "Talos"},
            "plugins": [{"name": PLUGIN_NAME, "source": "./current/" + PLUGIN_DIR, "description": DESCRIPTION}]}


def dump(obj):
    return json.dumps(obj, indent=2, ensure_ascii=False) + "\n"


def _copy_file(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)


def copy_tree(src, dst):
    """The kit tree into dst, minus SKIP_*; .claude/skills -> skills/, .claude/agents -> agents/ (plugin locations)."""
    for root, dirs, files in os.walk(src):
        rel_root = os.path.relpath(root, src)
        rel_root = "" if rel_root == "." else rel_root.replace(os.sep, "/")
        dirs[:] = sorted(d for d in dirs if d not in SKIP_NAMES and not (rel_root == "" and d in SKIP_TOP)
                         and (rel_root + "/" + d).lstrip("/") not in SKIP_PATHS)
        for name in sorted(files):
            if name in SKIP_NAMES or name.endswith(".pyc"):
                continue
            rel = (rel_root + "/" + name).lstrip("/")
            if rel in SKIP_PATHS:
                continue
            target = rel
            if rel.startswith(".claude/skills/"):
                if name == ".gitkeep":
                    continue
                target = "skills/" + rel[len(".claude/skills/"):]
            elif rel.startswith(".claude/agents/"):
                target = "agents/" + rel[len(".claude/agents/"):]
            _copy_file(os.path.join(root, name), os.path.join(dst, target))


def content_sha(root):
    h = hashlib.sha256()
    for dp, dn, fn in os.walk(root):
        dn.sort()
        for n in sorted(fn):
            p = os.path.join(dp, n)
            rel = os.path.relpath(p, root).replace(os.sep, "/")
            if rel == ".talos-release":
                continue
            h.update(rel.encode() + b"\0" + (b"x" if os.access(p, os.X_OK) else b"-") + b"\0")
            with open(p, "rb") as fh:
                h.update(fh.read())
            h.update(b"\0")
    return h.hexdigest()


def make_read_only(path):
    for dp, dn, fn in os.walk(path, topdown=False):
        for n in fn:
            p = os.path.join(dp, n)
            if not os.path.islink(p):
                os.chmod(p, os.stat(p).st_mode & ~(stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))
        os.chmod(dp, os.stat(dp).st_mode & ~(stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))


def make_writable(path):
    """Undo make_read_only (a test, or an owner deleting an old release, needs this before rm -r)."""
    for dp, dn, fn in os.walk(path):
        os.chmod(dp, os.stat(dp).st_mode | stat.S_IWUSR)
        for n in fn:
            p = os.path.join(dp, n)
            if not os.path.islink(p):
                os.chmod(p, os.stat(p).st_mode | stat.S_IWUSR)


def commit_of(src):
    try:
        r = subprocess.run(["git", "-C", src, "rev-parse", "--short", "HEAD"], capture_output=True, text=True, timeout=10)
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""


def build(src, vendor):
    src = os.path.abspath(src)
    version = read_version(src)
    releases = os.path.join(vendor, "releases")
    final_top = os.path.join(releases, version)
    os.makedirs(releases, exist_ok=True)
    tmp_top = os.path.join(releases, ".build-%d" % os.getpid())
    if os.path.exists(tmp_top):
        make_writable(tmp_top)
        shutil.rmtree(tmp_top)
    tmp = os.path.join(tmp_top, PLUGIN_DIR)
    try:
        copy_tree(src, tmp)
        os.makedirs(os.path.join(tmp, ".claude-plugin"), exist_ok=True)
        with open(os.path.join(tmp, ".claude-plugin", "plugin.json"), "w", encoding="utf-8") as fh:
            fh.write(dump(plugin_manifest(version)))
        os.makedirs(os.path.join(tmp, "hooks"), exist_ok=True)
        for d in ("bin", "migrations", "skills", "agents"):
            os.makedirs(os.path.join(tmp, d), exist_ok=True)
        for dp, dn, fn in os.walk(os.path.join(tmp, "bin")):
            for n in fn:
                os.chmod(os.path.join(dp, n), 0o755)
        sha = content_sha(tmp)
        with open(os.path.join(tmp, ".talos-release"), "w", encoding="utf-8") as fh:
            fh.write("# Written by scripts/plugin-release.py. A release is read-only and never edited in place.\n"
                     "version=%s\nkind=plugin-release\ncontent_sha256=%s\n" % (version, sha))
            c = commit_of(src)
            if c:
                fh.write("source_commit=%s\n" % c)
        if os.path.exists(final_top):
            have = ""
            try:
                for line in open(os.path.join(final_top, PLUGIN_DIR, ".talos-release"), encoding="utf-8"):
                    if line.startswith("content_sha256="):
                        have = line.strip().split("=", 1)[1]
            except OSError:
                pass
            make_writable(tmp_top)
            shutil.rmtree(tmp_top)
            if have == sha:
                print("plugin-release: %s is already built (same content), nothing to do" % final_top)
                return version
            raise SystemExit("plugin-release: release %s already exists with different content. A release is immutable: "
                             "bump the kit's VERSION, or remove %s yourself." % (version, final_top))
        make_read_only(tmp_top)
        os.rename(tmp_top, final_top)
    except BaseException:
        if os.path.exists(tmp_top):
            make_writable(tmp_top)
            shutil.rmtree(tmp_top, ignore_errors=True)
        raise
    print("plugin-release: built %s" % os.path.join(final_top, PLUGIN_DIR))
    return version


def activate(vendor, version):
    top = os.path.join(vendor, "releases", version)
    if not os.path.isfile(os.path.join(top, PLUGIN_DIR, ".claude-plugin", "plugin.json")):
        raise SystemExit("plugin-release: no release %s under %s" % (version, vendor))
    mdir = os.path.join(vendor, ".claude-plugin")
    os.makedirs(mdir, exist_ok=True)
    mpath = os.path.join(mdir, "marketplace.json")
    text = dump(marketplace_manifest())
    if not os.path.exists(mpath) or open(mpath, encoding="utf-8").read() != text:
        tmpm = mpath + ".tmp.%d" % os.getpid()
        with open(tmpm, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmpm, mpath)
    link = os.path.join(vendor, "current")
    tmpl = link + ".tmp.%d" % os.getpid()
    if os.path.lexists(tmpl):
        os.remove(tmpl)
    os.symlink(os.path.join("releases", version), tmpl)      # relative: the vendor folder can be moved as a whole
    os.replace(tmpl, link)
    print("plugin-release: current -> releases/%s" % version)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("cmd", choices=["build", "activate", "paths"])
    ap.add_argument("--source", default=kit_source_default())
    ap.add_argument("--vendor", default=None)
    ap.add_argument("--version")
    ap.add_argument("--activate", action="store_true", help="with build: point current at the new release")
    a = ap.parse_args()
    vendor = os.path.abspath(a.vendor) if a.vendor else vendor_default()
    if a.cmd == "paths":
        print("vendor=%s\nmarketplace=%s\nmarketplace_name=%s\nplugin_key=%s\nplugin_root=%s" % (
            vendor, os.path.join(vendor, ".claude-plugin", "marketplace.json"), MARKETPLACE_NAME, PLUGIN_KEY,
            os.path.join(vendor, "current", PLUGIN_DIR)))
    elif a.cmd == "build":
        v = build(a.source, vendor)
        if a.activate:
            activate(vendor, v)
    else:
        if not a.version:
            raise SystemExit("plugin-release: activate needs --version")
        activate(vendor, a.version)
    return 0


if __name__ == "__main__":
    sys.exit(main())
