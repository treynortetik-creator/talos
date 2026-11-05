#!/usr/bin/env python3
"""_agent_root.py: where the AGENT folder is, for every script that reads or writes the agent's data.

    from _agent_root import agent_root      # agent_root(__file__) for scripts/x.py; depth=2 for scripts/memory/x.py
    python3 scripts/_agent_root.py <path of the calling script> [depth]      # the same answer, for shell scripts

Why this exists: in the plugin layout the scripts live in a release OUTSIDE the agent folder (the agent's scripts/ is a link
into it), so "the folder above this file" is the release, not the agent. The agent is, in order:
  1. CLAUDE_PROJECT_DIR when it is set. It must name a folder that is not a plugin release, else this REFUSES (SystemExit, "not
     an agent folder"), the way hooks/session-start.py does: a variable that points nowhere is never followed and never replaced
     by a guess. The nearest folder at or above it that holds .talos-version wins, so starting claude in a subfolder still
     finds the agent;
  2. the folder above the calling script, as it was REACHED (symlinks are not resolved, so $AGENT/scripts/x.py leads back to
     $AGENT), when that folder is not a plugin release; this is also the whole answer in the old layout. With strict=True it must also hold .talos-version, so
     a kit source checkout is no agent;
  3. the nearest folder at or above the working directory that holds .talos-version; when none does, the working directory
     itself for a read-only helper, or a refusal ("not an agent folder; pass --agent") with strict=True, which anything that
     changes the folder (talos-migrate) uses: it never acts on a folder just because it is the working directory.
It is data only. Code is always read from the release the script itself sits in. hooks/_talos_common.py and
hooks/session-start.py hold the same rule for hooks (they stay standalone on purpose); scripts/test-plugin.sh runs all three
on the same inputs and fails when they disagree. Python 3.9, standard library only.
"""
import os
import sys


def is_release(path):
    """A plugin release carries .claude-plugin/plugin.json. It is code, never an agent folder."""
    return os.path.exists(os.path.join(path, ".claude-plugin", "plugin.json"))


def agent_above(start, strict=False):
    """`start`, or the nearest folder above it that holds .talos-version. When none does: `start`, or None with strict."""
    cur = os.path.realpath(start)
    while True:
        if os.path.isfile(os.path.join(cur, ".talos-version")):
            return cur
        up = os.path.dirname(cur)
        if up == cur:
            return None if strict else os.path.realpath(start)
        cur = up


def agent_root(own_file, depth=1, env=None, cwd=None, strict=False):
    env = os.environ.get("CLAUDE_PROJECT_DIR") if env is None else env
    if env:
        if not os.path.isdir(env) or is_release(os.path.realpath(env)):
            raise SystemExit("%s: CLAUDE_PROJECT_DIR=%r is not an agent folder (it does not exist, or it is a plugin release); "
                             "refusing to guess. Start claude inside the agent folder, or unset the variable." % (
                                 os.path.basename(own_file), env))
        found = agent_above(env, strict)
        if found is None:
            raise SystemExit("not an agent folder; pass --agent (CLAUDE_PROJECT_DIR=%r has no .talos-version at or above it)" % env)
        return found
    here = os.path.abspath(own_file)
    for _ in range(depth + 1):
        here = os.path.dirname(here)
    here = os.path.realpath(here)
    if not is_release(here) and (not strict or os.path.isfile(os.path.join(here, ".talos-version"))):
        return here        # strict (talos-migrate): a kit source checkout is no agent; only a folder with .talos-version counts
    found = agent_above(os.getcwd() if cwd is None else cwd, strict)
    if found is None:
        raise SystemExit("not an agent folder; pass --agent (no .talos-version at or above the working directory)")
    return found


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: _agent_root.py <calling script path> [depth]")
    print(agent_root(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 1))
