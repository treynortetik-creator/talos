#!/usr/bin/env python3
"""talos-migrate.py: move an agent folder from the layout it has to the layout a release expects, one migration at a time.

    talos-migrate.py status [--agent DIR] [--release DIR]
    talos-migrate.py up     [--agent DIR] [--release DIR] [--kit-home DIR] [--limit N] [--live]
    talos-migrate.py down   [--agent DIR] [--release DIR] [--kit-home DIR] [--steps N | --id ID] [--live]
    talos-migrate.py check  [--release DIR]                      # every migration keeps the contract below
    talos-migrate.py mark   --agent DIR --version V [--migration ID]   # a fresh install stamps the layout it was built in

--agent defaults to the agent folder (scripts/_agent_root.py); --release to the release this script sits in.

THE CONTRACT for migrations/<UTC yyyymmddHHMM>-<slug>.sh in a release:
  * a bash file that defines up(), and down() or the line `# down: none (<reason>)`;
  * idempotent: running up twice changes nothing the second time;
  * it runs when its id (the file name without .sh) is above `migration=` in the agent's .talos-version, in order;
  * the environment it gets: TALOS_AGENT, TALOS_RELEASE (the release folder, whose files are READ-ONLY), TALOS_KIT_HOME (the
    folder that holds current/ and the marketplace), TALOS_MIGRATION_ID, TALOS_DIRECTION (up or down);
  * the Talos ZONE is hooks/, scripts/, .talos-pre-plugin/ and .talos-version. Anything else it touches is outside the zone:
    a file it changes or deletes there must have its original kept next to it as <file>.bak-<id> (down: ...-down), and the
    migration prints a line for it. memory/, wiki/ and .learnings/ are never touched at all.
This runner CHECKS the last two rules by hashing the agent folder before and after each migration, and it stops and reports
(without advancing .talos-version) when one is broken. With --live (what `talos update` passes: an agent session may be running
and writing its own memory while the update runs) the contents of memory/, wiki/ and .learnings/ are not compared, because a change
there cannot be told from the live session's own write; but a file that is GONE from them after a migration is still a broken rule
(a migration may never delete there). Every shipped migration is also checked WITHOUT --live by test-plugin.sh.
`down --id ID` runs one migration's down() whether or not the marker says it finished: `talos update` uses it for a migration whose
up() failed half way, so down() must tolerate an up() that stopped anywhere. Python 3.9, standard library only.
"""
import argparse
import hashlib
import os
import re
import stat
import subprocess
import sys

ID_RE = re.compile(r"^(\d{12})-([a-z0-9][a-z0-9-]*)\.sh$")
ZONE = {"hooks", "scripts", ".talos-pre-plugin", ".talos-version", "hooks.tmp-restore", "scripts.tmp-restore"}   # the last two: plugin-move down, mid-swap
NEVER = ("memory", "wiki", ".learnings")
SKIP_DIRS = {".git", ".index", "node_modules", "__pycache__"}
TOP_LIVE = {".learnings", "logs", "state"}          # top-level folders a running session writes
LIVE = False                                        # --live: also leave NEVER folders out of the zone check
# Paths a running session writes at any moment (an open Claude Code session, Chronos, a hook) are left out of the zone check
# (see _live): comparing them before and after a migration would call a normal live write a broken rule. .learnings/, logs/ and state/, *.log / *.lock / *.pid files and the dot-files hooks keep under memory/ and wiki/ (.last-lint ...) are skipped;
# the curated files in memory/ and wiki/ are still checked, because a migration must never change them.
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _agent_root import agent_root  # noqa: E402


def code_root():
    return os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


def kit_home_for(release):
    """VENDOR for a release at VENDOR/releases/<v>/talos-kit; else the same default plugin-release.py uses."""
    real = os.path.realpath(release)
    parts = real.split(os.sep)
    if len(parts) > 4 and parts[-1] == "talos-kit" and parts[-3] == "releases":
        return os.sep.join(parts[:-3]) or os.sep
    if os.environ.get("TALOS_KIT_HOME"):
        return os.path.abspath(os.environ["TALOS_KIT_HOME"])
    base = os.environ.get("TALOS_VENDOR_DIR") or os.path.join(
        os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"), "talos")
    return os.path.abspath(os.path.join(base, "kit"))


def migrations(release):
    d = os.path.join(release, "migrations")
    out = []
    for n in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        m = ID_RE.match(n)
        if m:
            out.append((n[:-3], os.path.join(d, n)))
    return out


def contract_problems(path):
    text = open(path, encoding="utf-8").read()
    bad = []
    if not re.search(r"^\s*(function\s+)?up\s*\(\s*\)", text, re.M):
        bad.append("defines no up()")
    if not (re.search(r"^\s*(function\s+)?down\s*\(\s*\)", text, re.M) or re.search(r"^# down: none \(.+\)\s*$", text, re.M)):
        bad.append("has neither down() nor a '# down: none (<reason>)' line")
    return bad


# --------------------------------------------------------------------------- .talos-version
def read_marker(agent):
    out = {}
    try:
        for line in open(os.path.join(agent, ".talos-version"), encoding="utf-8"):
            m = re.match(r"\s*([A-Za-z_]+)\s*[=:]\s*(.*?)\s*$", line)
            if m and not line.lstrip().startswith("#"):
                out.setdefault(m.group(1), m.group(2).strip('"'))
    except OSError:
        pass
    return out


def write_marker(agent, **kv):
    """Set keys in .talos-version, keeping every other line (and comments) as it is."""
    path = os.path.join(agent, ".talos-version")
    lines = open(path, encoding="utf-8").read().splitlines() if os.path.exists(path) else ["# Written by Talos. What this folder is running."]
    for k, v in kv.items():
        for i, line in enumerate(lines):
            if re.match(r"\s*%s\s*[=:]" % re.escape(k), line) and not line.lstrip().startswith("#"):
                lines[i] = "%s=%s" % (k, v)
                break
        else:
            lines.append("%s=%s" % (k, v))
    tmp = path + ".tmp.%d" % os.getpid()
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    os.replace(tmp, path)


def release_version(release):
    for line in open(os.path.join(release, ".talos-release"), encoding="utf-8") if os.path.exists(os.path.join(release, ".talos-release")) else []:
        if line.startswith("version="):
            return line.strip().split("=", 1)[1]
    try:
        return open(os.path.join(release, "VERSION"), encoding="utf-8").read().strip()
    except OSError:
        return "unknown"


# --------------------------------------------------------------------------- the zone check
def _live(rel):
    """True for a path a running session writes on its own (see LIVE_FILE); only dot-files below memory/ and wiki/ count."""
    if re.search(r"(\.log|\.lock|\.pid|\.sock|\.tmp|\.swp)$", rel):
        return True
    top = rel.split(os.sep)[0]
    return top in ("memory", "wiki") and os.path.basename(rel).startswith(".")


def snapshot(agent, skipped=None):
    """{relative path: sha256 | 'link:<target>'} for every regular file outside the zone (and outside .git, live-write folders
    etc.). Sockets, FIFOs and devices are never opened (a FIFO would block forever), and a file that cannot be read is skipped;
    both are appended to `skipped` when given. It never raises: a migration has already run when this is called."""
    skipped = [] if skipped is None else skipped
    snap = {}
    for root, dirs, files in os.walk(agent):
        rel_root = os.path.relpath(root, agent)
        rel_root = "" if rel_root == "." else rel_root
        if rel_root == "":
            dirs[:] = [d for d in dirs if d not in ZONE and d not in TOP_LIVE and d not in SKIP_DIRS and not (LIVE and d in NEVER)]
            files = [f for f in files if f not in ZONE]
        else:
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for d in list(dirs):
            if os.path.islink(os.path.join(root, d)):
                try:
                    snap[os.path.join(rel_root, d)] = "link:" + os.readlink(os.path.join(root, d))
                except OSError:
                    skipped.append(os.path.join(rel_root, d))
                dirs.remove(d)
        for f in files:
            p = os.path.join(root, f)
            rel = os.path.join(rel_root, f)
            if _live(rel):
                continue
            try:
                if os.path.islink(p):
                    snap[rel] = "link:" + os.readlink(p)
                    continue
                if not stat.S_ISREG(os.lstat(p).st_mode):
                    skipped.append(rel)
                    continue
                h = hashlib.sha256()
                with open(p, "rb") as fh:
                    for chunk in iter(lambda: fh.read(65536), b""):
                        h.update(chunk)
                snap[rel] = h.hexdigest()
            except OSError:
                skipped.append(rel)
    return snap


def never_names(agent):
    """The relative path of every file under memory/, wiki/ and .learnings/ (dot files too): what --live still compares."""
    out = set()
    for top in NEVER:
        for root, dirs, files in os.walk(os.path.join(agent, top)):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for f in files:
                out.add(os.path.relpath(os.path.join(root, f), agent))
    return out


def zone_violations(before, after, mig, suffix):
    bad, created = [], []
    for rel in sorted(set(before) | set(after)):
        b, a = before.get(rel), after.get(rel)
        if b == a:
            continue
        top = rel.split(os.sep)[0]
        if rel.endswith(".bak-%s%s" % (mig, suffix)) and b is None:
            continue                                   # the backup the rule asks for
        if top in NEVER:
            bad.append("%s was changed; memory/, wiki/ and .learnings/ are never touched by a migration" % rel)
        elif b is None:
            created.append(rel)
        else:
            bak = rel + ".bak-%s%s" % (mig, suffix)
            if after.get(bak) != b:
                bad.append("%s was %s outside the Talos zone without a matching %s (the original must be kept there)" % (
                    rel, "deleted" if a is None else "changed", os.path.basename(bak)))
    return bad, created


def run_one(agent, release, kit_home, mig_id, path, direction):
    skipped_before, skipped_after = [], []
    before = snapshot(agent, skipped_before)
    names_before = never_names(agent) if LIVE else set()
    env = dict(os.environ, TALOS_AGENT=agent, TALOS_RELEASE=release, TALOS_KIT_HOME=kit_home,
               TALOS_MIGRATION_ID=mig_id, TALOS_DIRECTION=direction)
    fn = "up" if direction == "up" else "down"
    script = 'set -euo pipefail; source "$1"; "$2"'
    print("migrate: %s %s" % (mig_id, direction))
    r = subprocess.run(["bash", "-c", script, "talos-migration", path, fn], env=env)
    if r.returncode != 0:
        print("migrate: %s %s FAILED (exit %d); .talos-version was not advanced. Nothing outside the Talos zone is changed "
              "without a .bak next to it; read the lines above." % (mig_id, direction, r.returncode), file=sys.stderr)
        return False
    after = snapshot(agent, skipped_after)
    skipped = sorted(set(skipped_before) | set(skipped_after))
    if skipped:
        print("migrate: %d file(s) not checked (not regular files, or not readable): %s" % (len(skipped), ", ".join(skipped[:8]) + (" ..." if len(skipped) > 8 else "")))
    bad, created = zone_violations(before, after, mig_id, "" if direction == "up" else "-down")
    if LIVE:
        bad += ["%s was deleted; memory/, wiki/ and .learnings/ are never touched by a migration, deletions included" % rel
                for rel in sorted(names_before - never_names(agent))]
    for rel in created:
        print("migrate: %s created %s (outside the Talos zone)" % (mig_id, rel))
    if bad:
        for b in bad:
            print("migrate: BROKEN RULE in %s: %s" % (mig_id, b), file=sys.stderr)
        print("migrate: %s has already RUN and its changes are in place, but the marker was not advanced (.talos-version still says "
              "migration=%s). Look at the file(s) named above (a .bak-%s next to a file holds its original). When they are right, run "
              "`talos-migrate up --agent %s` again: migrations are idempotent, so it re-checks and moves the marker. `talos-migrate down` "
              "would undo the migration BEFORE this one, not this one." % (
                  mig_id, read_marker(agent).get("migration", "") or "none", mig_id, agent), file=sys.stderr)
        return False
    return True


def cmd_up(a, agent, release, kit_home):
    marker = read_marker(agent).get("migration", "")
    pending = [(i, p) for i, p in migrations(release) if i > marker]
    if not pending:
        print("migrate: nothing to do (migration=%s)" % (marker or "none"))
        return 0
    if a.limit:
        pending = pending[:a.limit]
    for i, p in pending:
        bad = contract_problems(p)
        if bad:
            print("migrate: %s breaks the contract: %s" % (i, "; ".join(bad)), file=sys.stderr)
            return 2
    for i, p in pending:
        if not run_one(agent, release, kit_home, i, p, "up"):
            return 1
        write_marker(agent, version=release_version(release), migration=i)
    print("migrate: done; migration=%s" % pending[-1][0])
    return 0


def cmd_down(a, agent, release, kit_home):
    if a.id:
        found = [(i, p) for i, p in migrations(release) if i == a.id]
        if not found:
            print("migrate: %s is not a migration of %s" % (a.id, release), file=sys.stderr)
            return 1
        if not re.search(r"^\s*(function\s+)?down\s*\(\s*\)", open(found[0][1], encoding="utf-8").read(), re.M):
            print("migrate: %s has no down() to run" % a.id, file=sys.stderr)
            return 1
        return 0 if run_one(agent, release, kit_home, a.id, found[0][1], "down") else 1
    marker = read_marker(agent).get("migration", "")
    done = [(i, p) for i, p in migrations(release) if marker and i <= marker]
    if not done:
        print("migrate: nothing to undo (migration=%s)" % (marker or "none"))
        return 0
    for i, p in reversed(done[-a.steps:]):
        text = open(p, encoding="utf-8").read()
        if not re.search(r"^\s*(function\s+)?down\s*\(\s*\)", text, re.M):
            m = re.search(r"^# down: none \((.+)\)\s*$", text, re.M)
            print("migrate: %s cannot be undone: %s" % (i, m.group(1) if m else "no down()"), file=sys.stderr)
            return 1
        if not run_one(agent, release, kit_home, i, p, "down"):
            return 1
        earlier = [x for x, _ in migrations(release) if x < i]
        write_marker(agent, migration=earlier[-1] if earlier else "")
    print("migrate: undone; migration=%s" % (read_marker(agent).get("migration") or "none"))
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("cmd", choices=["status", "up", "down", "check", "mark"])
    ap.add_argument("--agent")
    ap.add_argument("--release")
    ap.add_argument("--kit-home")
    ap.add_argument("--steps", type=int, default=1)
    ap.add_argument("--id", help="down: run this one migration's down(), whatever the marker says")
    ap.add_argument("--limit", type=int, help="up: run at most this many pending migrations")
    ap.add_argument("--live", action="store_true", help="a session may be writing memory/, wiki/ and .learnings/: leave them out of the zone check")
    ap.add_argument("--version")
    ap.add_argument("--migration")
    a = ap.parse_args()
    global LIVE
    LIVE = a.live
    release = os.path.abspath(a.release or code_root())
    if a.cmd == "check":
        bad = 0
        for i, p in migrations(release):
            for problem in contract_problems(p):
                print("%s: %s" % (i, problem))
                bad += 1
        print("migrate: %d migration(s) checked, %d problem(s)" % (len(migrations(release)), bad))
        return 1 if bad else 0
    agent = os.path.realpath(a.agent) if a.agent else agent_root(__file__, strict=True)
    kit_home = os.path.abspath(a.kit_home) if a.kit_home else kit_home_for(release)
    if a.cmd == "status":
        m = read_marker(agent)
        print("agent=%s\nversion=%s\nmigration=%s" % (agent, m.get("version", ""), m.get("migration", "")))
        for i, _ in migrations(release):
            print("%s %s" % ("applied" if i <= m.get("migration", "") else "pending", i))
        return 0
    if a.cmd == "mark":
        last = a.migration if a.migration is not None else (migrations(release)[-1][0] if migrations(release) else "")
        write_marker(agent, version=a.version or release_version(release), migration=last)
        return 0
    return (cmd_up if a.cmd == "up" else cmd_down)(a, agent, release, kit_home)


if __name__ == "__main__":
    sys.exit(main())
