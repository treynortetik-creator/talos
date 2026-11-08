#!/usr/bin/env python3
"""update-fixture.py: builds the kits, keys and signed bundles test-update.sh updates between. Nothing here is used outside tests.

    update-fixture.py keys DIR                       key1 (the release key), key2 (a stranger's) and allowed_signers for each
    update-fixture.py make-kit SRC DST --version V [--allowed FILE] [--migration ID:slug:mode]... [--hook EVENT|MATCHER|script]...
                      [--rewrite script]... [--drop script]... [--check-fail] [--min-relay X] [--notes TEXT]
    update-fixture.py yours AGENT                    one hash over everything of the owner's in an agent folder (bytes, size, mtime)

Migration modes: plain, hold (waits while $TALOS_TEST_HOLD exists), slow (sleeps a minute), baddown (down fails), nodown,
half (up leaves a file behind and fails; down removes it), delmem (up deletes a file under memory/),
baddownb / failupb (down / up fail, for the agent folder named agentB only).
Every migration appends to $TALOS_TEST_LOG, with its own pid for hold and slow."""
import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys

PRINCIPAL = "talos-release"
NAMESPACE = "talos-kit-release"


def keys(d):
    os.makedirs(d, exist_ok=True)
    for n in ("key1", "key2"):
        p = os.path.join(d, n)
        if not os.path.exists(p):
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", n, "-f", p], check=True)
    for n, files in (("allowed1", ["key1"]), ("allowed2", ["key2"]), ("allowed12", ["key1", "key2"])):
        with open(os.path.join(d, n), "w") as fh:
            for f in files:
                pub = open(os.path.join(d, f + ".pub")).read().strip().split()
                fh.write('%s namespaces="%s" %s %s\n' % (PRINCIPAL, NAMESPACE, pub[0], pub[1]))


MIG = {
    "plain": 'up() {{ echo "up {id}" >> "$TALOS_TEST_LOG"; }}\ndown() {{ echo "down {id}" >> "$TALOS_TEST_LOG"; }}\n',
    "hold": 'up() {{ echo "up {id} pid $$" >> "$TALOS_TEST_LOG"; while [ -e "$TALOS_TEST_HOLD" ]; do sleep 0.1; done; }}\n'
            'down() {{ echo "down {id}" >> "$TALOS_TEST_LOG"; }}\n',
    "slow": 'up() {{ echo "up {id} pid $$" >> "$TALOS_TEST_LOG"; sleep 60; }}\ndown() {{ echo "down {id}" >> "$TALOS_TEST_LOG"; }}\n',
    "baddown": 'up() {{ echo "up {id}" >> "$TALOS_TEST_LOG"; }}\ndown() {{ echo "down {id} fails" >> "$TALOS_TEST_LOG"; return 1; }}\n',
    "half": 'up() {{ echo "up {id}" >> "$TALOS_TEST_LOG"; : > "$TALOS_TEST_LOG.half"; return 1; }}\n'
            'down() {{ echo "down {id}" >> "$TALOS_TEST_LOG"; rm -f "$TALOS_TEST_LOG.half"; }}\n',
    "delmem": 'up() {{ echo "up {id}" >> "$TALOS_TEST_LOG"; rm -f "$TALOS_AGENT/memory/note.md"; }}\ndown() {{ echo "down {id}" >> "$TALOS_TEST_LOG"; }}\n',
    "baddownb": 'up() {{ echo "up {id}" >> "$TALOS_TEST_LOG"; }}\ndown() {{ echo "down {id}" >> "$TALOS_TEST_LOG"; case "$TALOS_AGENT" in *agentB) return 1;; esac; }}\n',
    "failupb": 'up() {{ echo "up {id}" >> "$TALOS_TEST_LOG"; case "$TALOS_AGENT" in *agentB) return 1;; esac; }}\ndown() {{ echo "down {id}" >> "$TALOS_TEST_LOG"; }}\n',
    "nodown": 'up() {{ echo "up {id}" >> "$TALOS_TEST_LOG"; }}\n# down: none (a test migration that cannot be undone)\n',
}


def make_kit(a):
    if os.path.exists(a.dst):
        shutil.rmtree(a.dst)
    shutil.copytree(a.src, a.dst, symlinks=True, ignore=shutil.ignore_patterns(".git", "__pycache__", "*.pyc", ".DS_Store"))
    with open(os.path.join(a.dst, "VERSION"), "w") as fh:
        fh.write(a.version + "\n")
    if a.allowed:
        shutil.copyfile(a.allowed, os.path.join(a.dst, "allowed_signers"))
    for spec in a.migration or []:
        mid, slug, mode = spec.split(":")
        p = os.path.join(a.dst, "migrations", "%s-%s.sh" % (mid, slug))
        with open(p, "w") as fh:
            fh.write("#!/usr/bin/env bash\n# test migration %s (%s)\n" % (mid, mode) + MIG[mode].format(id=mid))
    tp = os.path.join(a.dst, "templates", "dot-claude", "settings.json")
    t = json.load(open(tp))
    for spec in a.hook or []:
        event, matcher, script = spec.split("|")
        entry = {"hooks": [{"type": "command", "command": 'python3 "$CLAUDE_PROJECT_DIR/hooks/%s"' % script}]}
        if matcher:
            entry["matcher"] = matcher
        t["hooks"].setdefault(event, []).append(entry)
        hp = os.path.join(a.dst, "hooks", script)
        with open(hp, "w") as fh:
            fh.write('#!/usr/bin/env python3\nprint("{}")\n')
        os.chmod(hp, 0o755)
    for script in a.rewrite or []:
        for es in t["hooks"].values():
            for e in es:
                for h in e["hooks"]:
                    if "hooks/" + script in h["command"]:
                        h["command"] += "\n# revision 2"
    for script in a.drop or []:
        for ev in list(t["hooks"]):
            kept = []
            for e in t["hooks"][ev]:
                e["hooks"] = [h for h in e["hooks"] if "hooks/" + script not in h["command"]]
                if e["hooks"]:
                    kept.append(e)
            t["hooks"][ev] = kept
        os.remove(os.path.join(a.dst, "hooks", script))
    with open(tp, "w") as fh:
        json.dump(t, fh, indent=2)
        fh.write("\n")
    if a.check_fail:
        rc = os.path.join(a.dst, "scripts", "release-check.py")
        text = open(rc).read()
        assert "def cmd_start(" in text, "release-check.py has no cmd_start to break"
        text = text.replace("def cmd_start(a):", 'def cmd_start(a):\n    print("start check: this test release cannot start")\n    sys.exit(1)', 1)
        open(rc, "w").write(text)
    if a.min_relay:
        json.dump({"min_relay": a.min_relay}, open(os.path.join(a.dst, "release.json"), "w"))
    if a.notes:
        cp = os.path.join(a.dst, "CHANGELOG.md")
        open(cp, "w").write("# Changelog\n\n## %s - test\n\n%s\n\n## older\n\nold\n" % (a.version, a.notes))
    mark = os.path.join(a.dst, "bin", "talos-update")
    if os.path.exists(mark):
        os.chmod(mark, 0o755)


def yours(agent, listing=False):
    """Everything of the owner's: all files except the Talos zone, the copied Talos files, the shared settings and .git."""
    skip_top = {"hooks", "scripts", ".talos-pre-plugin", ".talos-version", ".git"}
    skip = {".claude/rules/talos-defaults.md", "wiki/README.md", "wiki/_privacy-and-sharing.md"}
    h = hashlib.sha256()
    for dp, dn, fn in os.walk(agent):
        rel_root = os.path.relpath(dp, agent)
        dn[:] = sorted(d for d in dn if not (rel_root == "." and d in skip_top) and not (rel_root == "wiki" and d == "examples"))
        for n in sorted(fn):
            rel = os.path.normpath(os.path.join(rel_root, n))
            if rel in skip or rel in (".claude/settings.json", ".mcp.json", ".talos-version") or ".bak-" in n or n.startswith("settings.json."):
                continue
            p = os.path.join(dp, n)
            st = os.lstat(p)
            h.update(("%s|%d|%d|" % (rel, st.st_size, st.st_mtime_ns)).encode())
            if stat.S_ISLNK(st.st_mode):
                h.update(os.readlink(p).encode())
            else:
                h.update(open(p, "rb").read())
            if listing:
                print("%s %d %d" % (rel, st.st_size, st.st_mtime_ns))
    if not listing:
        print(h.hexdigest())


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    k = sub.add_parser("keys")
    k.add_argument("dir")
    m = sub.add_parser("make-kit")
    m.add_argument("src")
    m.add_argument("dst")
    m.add_argument("--version", required=True)
    m.add_argument("--allowed")
    m.add_argument("--migration", action="append")
    m.add_argument("--hook", action="append")
    m.add_argument("--rewrite", action="append")
    m.add_argument("--drop", action="append")
    m.add_argument("--check-fail", action="store_true")
    m.add_argument("--min-relay")
    m.add_argument("--notes")
    y = sub.add_parser("yours")
    y.add_argument("agent")
    y.add_argument("--list", action="store_true")
    a = ap.parse_args()
    if a.cmd == "keys":
        keys(a.dir)
    elif a.cmd == "make-kit":
        make_kit(a)
    else:
        yours(a.agent, a.list)


if __name__ == "__main__":
    main()
