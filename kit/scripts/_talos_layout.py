#!/usr/bin/env python3
"""_talos_layout.py: where the agent's wiki lives. ONE answer for every script that names the wiki folder.

    from _talos_layout import layout, paths      # layout(agent_dir) -> 1 or 2; paths(agent_dir) -> {memory, wiki, projects}
    python3 scripts/_talos_layout.py <agent_dir> <memory|wiki|projects>     # prints the absolute path, for shell scripts

The layout is a line `layout=N` in <agent>/.talos-version. No file, or no such line, is layout 1 (today's default). N must be 1
or 2, there must be at most one such line, and it must be spelt exactly `layout=N`: anything else (`Layout=2`, `layout: 2`, `layout=zz`, a
second line) is refused (SystemExit, "unknown layout"), never guessed. A UTF-8 BOM at the start of the file is ignored.

                     layout 1             layout 2
    wiki             <agent>/wiki         <agent>/memory/wiki
    projects         (none)               <agent>/memory/projects
    memory           <agent>/memory       <agent>/memory           (daily logs, HANDOFF, STATE, ledgers: the same in both)

`paths(...)["projects"]` is None on layout 1; the CLI prints nothing for it (exit 0). An unknown key exits 2.

Given the agent folder, as found by _agent_root.py (scripts) or the hooks' own PROJECT_DIR logic: never the folder above this
file (in the plugin layout that is a release, not the agent). hooks/_talos_common.py, hooks/_talos_session.py and
hooks/session-start.py hold a private copy of layout() as wiki_dir() (hooks stay standalone on purpose, like _agent_root.py);
scripts/test-layout.sh runs all of them on the same inputs and fails when they disagree. Python 3.9, standard library only.
"""
import os
import re
import sys

KEYS = ("memory", "wiki", "projects")


def layout(agent_dir):
    """1 or 2, from the `layout=N` line in <agent_dir>/.talos-version. Strict, never a guess: a UTF-8 BOM at the start is ignored;
    any line that starts with "layout" and then (after optional spaces) `=` or `:` is a layout line; there may be at most one,
    and it must be exactly `layout`, optional spaces, `=`, optional spaces, `1` or `2`. So `Layout=2`, `layout: 2`, `layout=zz` and
    a second layout line are all refused (SystemExit, "unknown layout ..."). No file, or no layout line: 1."""
    path = os.path.join(agent_dir, ".talos-version")
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            text = fh.read(65536)
    except OSError:
        return 1
    if text.startswith("\ufeff"):
        text = text[1:]
    found = [ln.strip() for ln in text.splitlines() if re.match(r"layout\s*[=:]", ln.strip(), re.I)]
    if len(found) > 1:
        raise SystemExit("unknown layout: more than one layout line in %s; refusing to guess where the wiki is." % path)
    if found:
        m = re.fullmatch(r"layout\s*=\s*([12])", found[0])
        if not m:
            raise SystemExit("unknown layout %r in %s (expected exactly layout=1 or layout=2); refusing to guess where the wiki is."
                             % (found[0], path))
        return int(m.group(1))
    return 1


def paths(agent_dir):
    """{memory, wiki, projects}: absolute paths for this agent's layout. projects is None on layout 1."""
    agent = os.path.abspath(agent_dir)
    memory = os.path.join(agent, "memory")
    if layout(agent) == 2:
        return {"memory": memory, "wiki": os.path.join(memory, "wiki"), "projects": os.path.join(memory, "projects")}
    return {"memory": memory, "wiki": os.path.join(agent, "wiki"), "projects": None}


def main(argv):
    if len(argv) != 2 or argv[1] not in KEYS:
        sys.stderr.write("usage: _talos_layout.py <agent_dir> <%s>\n" % "|".join(KEYS))
        return 2
    value = paths(argv[0])[argv[1]]
    if value is not None:
        print(value)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
