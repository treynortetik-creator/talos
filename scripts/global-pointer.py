#!/usr/bin/env python3
"""global-pointer.py: add or remove a small marked block in your GLOBAL Claude config (~/.claude/CLAUDE.md) that
points every Claude Code session on this Mac at your Talos agent's memory.

    python3 scripts/global-pointer.py add --agent-dir ~/my-agent [--claude-dir ~/.claude] [--dry-run]
    python3 scripts/global-pointer.py remove [--claude-dir ~/.claude]

Why it is opt-in: it edits a file that belongs to you and applies to EVERY project, not just the agent. What it
does: appends (or replaces) one block between `<!-- TALOS-POINTER:BEGIN -->` and `<!-- TALOS-POINTER:END -->` telling
any session where the agent's memory lives and how to search it, plus the privacy rule. It never touches anything
outside those markers, writes a one-time backup (CLAUDE.md.bak-before-talos) before the first change, replaces the
file atomically, and `remove` (also run by ./uninstall.sh) deletes exactly that block and nothing else. Standard
library only.
"""
import argparse
import os
import re
import shutil
import sys

BEGIN = "<!-- TALOS-POINTER:BEGIN -->"
END = "<!-- TALOS-POINTER:END -->"
BLOCK_RE = re.compile(r"\n?" + re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?", re.S)


def block(agent):
    return (BEGIN + "\n"
            "## Talos memory (added by the Talos installer; `./uninstall.sh` removes this block)\n"
            "- A Talos agent's memory lives at `%(a)s`. Before answering about the user, their projects, people or past\n"
            "  decisions, search it: `python3 %(a)s/scripts/recall.py \"<query>\"` (fuzzy) or\n"
            "  `%(a)s/scripts/wiki-search.sh \"<term>\"` (exact). Cite the notes you used.\n"
            "- Do not write into that folder from another project unless asked; its own `CLAUDE.md` governs how.\n"
            "- Privacy: anything from a personal vault (a `personal/` folder) may inform an answer in a direct conversation but must\n"
            "  never be copied into a work artifact, repository, commit or message to anyone else.\n"
            % {"a": agent} + END + "\n")


def atomic_write(path, text):
    # ~/.claude/CLAUDE.md is often a symlink into a dotfiles repo. os.replace on the LINK would swap it for a
    # regular file and leave the repo's copy stale, so write through to the real file.
    path = os.path.realpath(path)
    tmp = "%s.tmp.%d" % (path, os.getpid())
    mode = os.stat(path).st_mode & 0o777 if os.path.exists(path) else 0o644
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")
    a = sub.add_parser("add")
    a.add_argument("--agent-dir", required=True)
    a.add_argument("--claude-dir", default=None)
    a.add_argument("--dry-run", action="store_true")
    r = sub.add_parser("remove")
    r.add_argument("--claude-dir", default=None)
    args = ap.parse_args(argv)
    if not args.cmd:
        ap.print_help()
        return 2
    cdir = os.path.abspath(os.path.expanduser(args.claude_dir or "~/.claude"))
    path = os.path.join(cdir, "CLAUDE.md")
    existing = ""
    if os.path.exists(path):
        try:
            existing = open(path, encoding="utf-8").read()
        except (OSError, UnicodeDecodeError) as e:
            print("global-pointer: cannot read %s: %s (left untouched)" % (path, e), file=sys.stderr)
            return 1
    if args.cmd == "remove":
        if BEGIN not in existing:
            print("  no Talos block in %s" % path)
            return 0
        if existing.count(BEGIN) != existing.count(END) or existing.count(BEGIN) > 1 or not BLOCK_RE.search(existing):
            print("global-pointer: the markers in %s are unbalanced or duplicated, so nothing was removed. "
                  "Delete the lines between %s and %s by hand." % (path, BEGIN, END), file=sys.stderr)
            return 1
        new = BLOCK_RE.sub("\n", existing, count=1).strip("\n")
        atomic_write(path, (new + "\n") if new else "")
        print("  removed the Talos block from %s" % path)
        return 0
    agent = os.path.abspath(os.path.expanduser(args.agent_dir))
    if not os.path.isdir(agent):
        print("global-pointer: %s is not a folder" % agent, file=sys.stderr)
        return 1
    if (existing.count(BEGIN) != existing.count(END)) or existing.count(BEGIN) > 1:
        print("global-pointer: the markers in %s are unbalanced or duplicated; fix by hand (left untouched)" % path, file=sys.stderr)
        return 1
    new_block = block(agent)
    if BEGIN in existing:
        new = BLOCK_RE.sub("\n" + new_block, existing, count=1)
    else:
        new = existing.rstrip("\n") + ("\n\n" if existing.strip() else "") + new_block
    if args.dry_run:
        print("  would %s the Talos block in %s:\n%s" % ("replace" if BEGIN in existing else "append", path, new_block))
        return 0
    os.makedirs(cdir, exist_ok=True)
    bak = os.path.join(cdir, "CLAUDE.md.bak-before-talos")
    if existing and not os.path.exists(bak):
        shutil.copy2(os.path.realpath(path), bak)
    atomic_write(path, new)
    print("  wrote the Talos block to %s (remove with ./uninstall.sh)" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
