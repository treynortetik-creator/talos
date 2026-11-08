#!/usr/bin/env python3
"""talos-update.py: `talos update`, `talos rollback` and `talos restore` for the Talos kit.

    talos-update.py update   [--dry-run] [--source SRC] [--agent DIR] [--vendor DIR] [--relay-version V] [--app-repo DIR --app-ref REF]
    talos-update.py rollback [VERSION]   [--agent DIR] [--vendor DIR]
    talos-update.py restore  FILE        [--agent DIR] [--vendor DIR] [--source COMMIT]
    talos-update.py trust-key PUBKEYFILE [--vendor DIR]

Run from the owner's Terminal. It refuses without a terminal and inside a Claude Code session. That is a speed bump for an agent, not
a lock: the agent runs as the same user, so it could fake a terminal and clear the variable, or write to the release folder itself. What
stands behind the bump: the guard hook denies these commands and writes to the vendor folder, every bundle must carry a signature the
installed release trusts, and each session start checks that the live release still matches its recorded content hash and says so loudly. Exit codes: 0 done, 1 refused or failed with nothing left half done (or
rolled back), 2 usage or not allowed here, 3 another update is running, 4 something is half done and needs the owner.

UPDATE (docs: K8-UPDATE-DESIGN.md section 4). One kernel lock (flock on VENDOR/.lock, held by any child it starts, so a killed
updater cannot leave a second one starting under an orphaned migration). Then:
  fetch   SOURCE/latest.json names a version; the bundle talos-kit-<version>.tar.gz and its .sig are fetched (a folder, https, or
          http on this machine). A version that is not newer than the installed one is not an update.
  verify  `ssh-keygen -Y verify -n talos-kit-release -I talos-release` against allowed_signers of the release that is INSTALLED,
          never the one inside the bundle. An unsigned, wrongly signed or altered bundle stops here, before anything is unpacked.
  unpack  a hand-written extractor (regular files and folders under talos-kit/ only; no links, devices, absolute or .. names)
          into releases/.tmp-<pid>, checked against its own content hash.
  selftest  the new release's `release-check.py release` runs on the staged copy. --dry-run stops after this and prints the
          new version, the release notes, the pending migrations, the hook changes and the app and relay notes; it deletes the stage.
  journal the staged release is made read-only and renamed into releases/<version>; update-journal.json records from, to and the
          migration marker; settings.json is copied aside so a failed update can put back the exact bytes.
  swap    `current` moves with one rename of a fresh link over it.
  files   the Talos files that live inside the agent folder (agent-files/ in the release) are copied in, each by atomic replace.
  reconcile  the hook list in .claude/settings.json is made to match the release's template (plugin-settings.py reconcile).
  migrate each pending migration runs in order (talos-migrate up --live: memory/ may be written meanwhile) and moves the marker.
  check   the new release's `release-check.py start`: links, settings.json, hook scripts, SessionStart. Any failure, any timeout
          and any interrupt after the swap runs the same rollback as `talos rollback`, then exits 1.
  restart the Mac app is asked through agent-request.json ({"v":1,"control_id","action":"restart","ts"}); it acts on that file
          alone, so this is the only way the agent is stopped and started again (there is no stop-only request).
  prune   the newest three releases stay, and never the current one or the one just left; the journal is cleared.
A run that dies (kill -9, power) leaves the journal; the next `talos update` resumes it: the marker says which migrations are done.

ROLLBACK [VERSION]: the same lock; migration `down` for every migration above the target's newest, NEWEST first (a migration marked
`# down: none` makes it refuse before anything runs); the hook list reconciled back; `current` swapped; the Talos files copied
back; the marker written. RESTORE FILE: Talos files come from the current release, shared setup files (.mcp.json and the settings)
from the Talos app's last-good store, everything else from git (`git restore --source`). Python 3.9, standard library only."""
import argparse
import io
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time

sys.dont_write_bytecode = True      # never write a .pyc: a staged release must still match its content hash after the checks have run on it
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _update_app import app_merge, git  # noqa: E402
from _update_fetch import fetch_bytes  # noqa: E402
from _update_trust import cmd_trust_key, combined_allowed  # noqa: E402
from _update_common import (FAILED, HALF, NAMESPACE, OK, PLUGIN_DIR, PR, PRINCIPAL, USAGE, Interrupted, Stop,  # noqa: E402
                            atomic_write, die_point, load_script, owner_terminal_only, resolve_agent, resolve_vendor, rm_tree,
                            run_group, say, take_lock, unique_bak, warn, app_home)

KEEP = 3
MAX_BUNDLE = 200 * 1024 * 1024
MAX_UNPACKED = 600 * 1024 * 1024
MAX_MEMBERS = 20000
SHARED = (".mcp.json", ".claude/settings.json", ".claude/settings.local.json")




# --------------------------------------------------------------------------- releases
def current_version(vendor):
    link = os.path.join(vendor, "current")
    try:
        target = os.readlink(link)
    except OSError:
        raise Stop("no release is installed under %s (there is no `current`). Run the kit's install.sh first." % vendor)
    m = re.fullmatch(r"releases/([A-Za-z0-9][A-Za-z0-9._+-]*)", target)
    if not m or not os.path.isfile(os.path.join(vendor, "releases", m.group(1), PLUGIN_DIR, ".claude-plugin", "plugin.json")):
        raise Stop("`current` points at %r, which is not an installed release under %s" % (target, vendor))
    return m.group(1)


def rel_dir(vendor, version):
    return os.path.join(vendor, "releases", version, PLUGIN_DIR)


def release_meta(path):
    kv = {}
    try:
        with open(os.path.join(path, ".talos-release"), encoding="utf-8") as fh:
            for line in fh:
                if "=" in line and not line.startswith("#"):
                    k, v = line.strip().split("=", 1)
                    kv[k] = v
    except OSError:
        pass
    return kv


def verify_release_dir(path, version):
    """The release's files are what its own .talos-release says, and it is the version it claims. Returns an error text or None."""
    kv = release_meta(path)
    if not kv:
        return "it has no .talos-release"
    if kv.get("version") != version:
        return "it says version %r, not %r" % (kv.get("version"), version)
    try:
        manifest = json.load(open(os.path.join(path, ".claude-plugin", "plugin.json"), encoding="utf-8"))
    except (OSError, ValueError):
        return "its plugin.json is missing or not JSON"
    if manifest.get("version") != version:
        return "its plugin.json says version %r" % manifest.get("version")
    if PR.content_sha(path) != kv.get("content_sha256"):
        return "its files do not match the content hash recorded when it was built"
    return None


def installed_versions(vendor):
    d = os.path.join(vendor, "releases")
    out = []
    for n in os.listdir(d) if os.path.isdir(d) else []:
        if not n.startswith(".") and os.path.isfile(os.path.join(d, n, PLUGIN_DIR, ".claude-plugin", "plugin.json")):
            out.append(n)
    return sorted(out, key=PR.version_key)


def prune_stale(vendor):
    """We hold the lock, so every temporary folder a killed run left behind is stale."""
    for base, pats in ((vendor, (r"\.dl-.*", r"current\.tmp\..*", r"\.trash-.*")),
                       (os.path.join(vendor, "releases"), (r"\.tmp-.*", r"\.build-.*", r"\.trash-.*")),
                       (os.path.join(vendor, ".claude-plugin"), (r".*\.tmp\.\d+",))):
        for n in os.listdir(base) if os.path.isdir(base) else []:
            if any(re.fullmatch(p, n) for p in pats):
                rm_tree(os.path.join(base, n))


# --------------------------------------------------------------------------- journal
def journal_path(vendor):
    return os.path.join(vendor, "update-journal.json")


def read_journal(vendor):
    try:
        with open(journal_path(vendor), encoding="utf-8") as fh:
            j = json.load(fh)
    except FileNotFoundError:
        return None
    except ValueError:
        raise Stop("%s is not valid JSON. An update was interrupted and its record is damaged: run `talos rollback` to go back to "
                   "the release you had, then remove that file." % journal_path(vendor), HALF)
    if not (isinstance(j, dict) and isinstance(j.get("from"), str) and isinstance(j.get("to"), str) and isinstance(j.get("agent"), str)):
        raise Stop("%s is not an update record. Remove it by hand if no update is running." % journal_path(vendor), HALF)
    return j


def write_journal(vendor, j):
    atomic_write(journal_path(vendor), (json.dumps(j, indent=2) + "\n").encode("utf-8"), 0o600)


def clear_journal(vendor):
    for p in (journal_path(vendor),):
        if os.path.exists(p):
            os.remove(p)
    rm_tree(os.path.join(vendor, "update-journal.d"))


# --------------------------------------------------------------------------- verifying and unpacking
def verify_signature(allowed_signers, bundle, sig_path, bundle_name):
    """ssh-keygen -Y verify of the bytes `bundle` against allowed_signers (the INSTALLED release's keys, plus any the owner added with
    trust-key). The message goes in on stdin, so what is verified is exactly what the caller holds."""
    try:
        lines = [l for l in open(allowed_signers, encoding="utf-8").read().splitlines() if l.strip() and not l.lstrip().startswith("#")]
    except OSError:
        lines = []
    if not any(l.split()[0] == PRINCIPAL for l in lines):
        raise Stop("cannot verify %s: the installed release lists no signing key (%s). Nothing was installed." % (bundle_name, allowed_signers))
    ssh = "/usr/bin/ssh-keygen" if os.access("/usr/bin/ssh-keygen", os.X_OK) else shutil.which("ssh-keygen")
    if not ssh:
        raise Stop("cannot verify %s: ssh-keygen is not installed. Nothing was installed." % bundle_name)
    r = subprocess.run([ssh, "-Y", "verify", "-f", allowed_signers, "-I", PRINCIPAL, "-n", NAMESPACE, "-s", sig_path],
                       input=bundle, capture_output=True, timeout=60)
    r.stdout, r.stderr = r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace")
    if r.returncode != 0 or "Good" not in r.stdout:
        raise Stop("signature check FAILED for %s: it was not signed by a key the installed release trusts (%s). Nothing was installed."
                   % (bundle_name, (r.stderr or r.stdout).strip().splitlines()[-1][:120] if (r.stderr or r.stdout).strip() else "no detail"))


def unpack_verified(data, sig, allowed_signers, bundle_name, dest):
    """Verify the bytes `data` against the signature bytes `sig`, then unpack those same bytes (never a second read of a file). Nothing is
    written under `dest` unless the signature holds. Returns the unpacked plugin folder."""
    with tempfile.TemporaryDirectory(prefix="talos-sig-") as d:
        sp = os.path.join(d, "bundle.sig")
        with open(sp, "wb") as fh:
            fh.write(sig)
        verify_signature(allowed_signers, data, sp, bundle_name)
    return safe_extract(data, dest)


def safe_extract(data, dest):
    """Unpack a verified bundle (bytes) by hand. Only regular files and folders under talos-kit/; no link, device, absolute or .. name."""
    os.makedirs(dest)
    total = 0
    try:
        tar = tarfile.open(fileobj=io.BytesIO(data), mode="r:gz")
    except (tarfile.TarError, OSError, EOFError) as e:
        raise Stop("the bundle is not a readable archive: %s" % e)
    with tar:
        members = []
        try:
            for m in tar:
                members.append(m)
                if len(members) > MAX_MEMBERS:
                    raise Stop("the bundle has more than %d entries; refused" % MAX_MEMBERS)
        except (tarfile.TarError, OSError, EOFError) as e:
            raise Stop("the bundle is damaged: %s" % e)
        root = os.path.realpath(dest)
        for m in members:
            name = m.name
            parts = name.split("/")
            if (not name or name.startswith("/") or "\\" in name or "\0" in name or ".." in parts or parts[0] != PLUGIN_DIR
                    or any(p == "" for p in parts[1:-1])):
                raise Stop("the bundle holds an entry that is not a plain path under %s/ (%r); refused" % (PLUGIN_DIR, name[:80]))
            if not (m.isfile() or m.isdir()):
                raise Stop("the bundle holds %r, which is not a plain file or folder (links and devices are never unpacked); refused" % name[:80])
            total += max(m.size, 0)
            if total > MAX_UNPACKED:
                raise Stop("the bundle unpacks to more than %d MB; refused" % (MAX_UNPACKED // (1024 * 1024)))
        for m in members:
            target = os.path.join(dest, *m.name.rstrip("/").split("/"))
            if os.path.commonpath([root, os.path.realpath(os.path.dirname(target))]) != root:
                raise Stop("the bundle would write outside its folder (%r); refused" % m.name[:80])
            if m.isdir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            src = tar.extractfile(m)
            with open(target, "wb") as out:
                shutil.copyfileobj(src, out)
            os.chmod(target, 0o755 if m.mode & 0o111 else 0o644)
    return os.path.join(dest, PLUGIN_DIR)


# --------------------------------------------------------------------------- pieces of the move
def read_marker(agent):
    return load_script(os.path.join(HERE, "talos-migrate.py"), "talos_migrate_here").read_marker(agent)


def request_restart():
    home = app_home()
    if not os.path.isdir(home):
        say("The Talos app home (%s) does not exist, so no restart was requested. Restart your agent yourself." % home)
        return False
    ms = int(time.time() * 1000)
    body = {"v": 1, "control_id": "kit-%d-%d" % (ms, os.getpid()), "action": "restart", "ts": ms}
    atomic_write(os.path.join(home, "agent-request.json"), (json.dumps(body) + "\n").encode("utf-8"), 0o600)
    say("Asked the Mac app to restart the agent (it acts on that within a minute, unless you stopped the agent on purpose; if you run "
        "the agent in Terminal, restart it yourself).")
    return True


def agent_files(release):
    base = os.path.join(release, "agent-files")
    out = []
    for dp, dn, fn in os.walk(base):
        dn.sort()
        for n in sorted(fn):
            out.append(os.path.relpath(os.path.join(dp, n), base).replace(os.sep, "/"))
    return out


def same_bytes(a, b):
    try:
        with open(a, "rb") as x, open(b, "rb") as y:
            return x.read() == y.read()
    except OSError:
        return False


def sync_agent_files(agent, new_rel, old_rel, tag):
    """The Talos files inside the agent folder, copied from `new_rel`'s agent-files/, each by atomic replace. A copy the owner edited
    (it differs from `old_rel`'s) is kept as <file>.bak-<tag> first. Nothing is ever deleted."""
    n = 0
    root = os.path.realpath(agent)
    for rel in agent_files(new_rel):
        src = os.path.join(new_rel, "agent-files", rel)
        dst = os.path.join(agent, rel)
        parent = os.path.realpath(os.path.dirname(dst))
        if os.path.commonpath([root, parent]) != root:
            warn("talos update: %s would leave the agent folder; skipped" % rel)
            continue
        if os.path.islink(dst) or os.path.isdir(dst):
            warn("talos update: %s is a link or a folder in your agent folder; left alone" % rel)
            continue
        if os.path.exists(dst):
            if same_bytes(src, dst):
                continue
            if not same_bytes(os.path.join(old_rel, "agent-files", rel), dst):
                bak = unique_bak(dst, tag)
                shutil.copy2(dst, bak)
                say("  %s differed from the release's copy (you had edited it): your version is kept as %s" % (rel, os.path.basename(bak)))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        tmp = "%s.tmp.%d" % (dst, os.getpid())
        shutil.copyfile(src, tmp)
        os.chmod(tmp, 0o644)
        os.replace(tmp, dst)
        n += 1
    say("  copied %d Talos file%s into the agent folder" % (n, "" if n == 1 else "s"))


def release_notes(release):
    try:
        text = open(os.path.join(release, "CHANGELOG.md"), encoding="utf-8").read().splitlines()
    except OSError:
        return []
    out, seen = [], False
    for line in text:
        if line.startswith("## "):
            if seen:
                break
            seen = True
            out.append(line[3:].strip())
        elif seen and line.strip():
            out.append(line)
        if len(out) > 14:
            out.append("...")
            break
    return out


def relay_note(new_rel, relay_version):
    try:
        need = json.load(open(os.path.join(new_rel, "release.json"), encoding="utf-8")).get("min_relay")
    except (OSError, ValueError):
        need = None
    if not need or not isinstance(need, str):
        return None
    if relay_version and relay_version == need:
        return None
    return ("Relay: this release expects relay %s and yours %s. If it changed the relay, press Update in Railway (the relay is "
            "deployed there, not by this command). The kit update does not wait for it." % (need, relay_version or "is not known here"))


def migrate_run(new_rel, agent, vendor, direction, lock_fd, extra=()):
    cmd = [sys.executable, os.path.join(new_rel, "scripts", "talos-migrate.py"), direction, "--agent", agent, "--release", new_rel,
           "--kit-home", vendor, "--live"] + list(extra)
    return run_group(cmd, fd=lock_fd, what="the %s migrations" % direction)


def settings_bytes(agent):
    try:
        with open(os.path.join(agent, ".claude", "settings.json"), "rb") as fh:
            return fh.read()
    except OSError:
        return None


def pending_ids(new_rel, agent):
    tm = load_script(os.path.join(new_rel, "scripts", "talos-migrate.py"), "talos_migrate_new")
    marker = tm.read_marker(agent).get("migration", "")
    return tm, marker, [(i, p) for i, p in tm.migrations(new_rel) if i > marker]


# --------------------------------------------------------------------------- rollback
def migration_down_problems(release, ids):
    out = []
    for i, p in ids:
        text = open(p, encoding="utf-8").read()
        if not re.search(r"^\s*(function\s+)?down\s*\(\s*\)", text, re.M):
            m = re.search(r"^# down: none \((.+)\)\s*$", text, re.M)
            out.append((i, m.group(1) if m else "it has no down()"))
    return out


def other_agents_above(agent, target):
    """[(folder, version)] of the OTHER agent folders this Mac's Talos app has saved a setup for (the app's last-good store records each
    agent_dir; no list of agents is kept anywhere else) whose .talos-version is a release newer than `target`."""
    d = os.path.join(app_home(), "last-good")
    seen, out = set(), []
    try:
        names = os.listdir(d)
    except OSError:
        return out
    for n in names:
        try:
            other = os.path.realpath(str(json.load(open(os.path.join(d, n, "meta.json"), encoding="utf-8")).get("agent_dir", "")))
        except (OSError, ValueError):
            continue
        if other in seen or other == agent or not os.path.isfile(os.path.join(other, ".talos-version")):
            continue
        seen.add(other)
        v = read_marker(other).get("version", "")
        if v and PR.version_key(v) > PR.version_key(target):
            out.append((other, v))
    return out


def do_rollback(vendor, agent, target, lock_fd, journal=None, restart=True, failed=None):
    """Go back to release `target`. Raises Stop. Nothing is swapped until every migration down has run."""
    cur = current_version(vendor)
    cur_rel, tgt_rel = rel_dir(vendor, cur), rel_dir(vendor, target)
    if not os.path.isfile(os.path.join(tgt_rel, ".claude-plugin", "plugin.json")):
        raise Stop("there is no release %s installed under %s/releases (installed: %s)" % (target, vendor, ", ".join(installed_versions(vendor)) or "none"))
    bad = verify_release_dir(tgt_rel, target)
    if bad:
        raise Stop("release %s failed its integrity check (%s); refusing to go back to it" % (target, bad))
    tm_cur = load_script(os.path.join(cur_rel, "scripts", "talos-migrate.py"), "talos_migrate_cur")
    marker = tm_cur.read_marker(agent).get("migration", "")
    tgt_ids = [i for i, _ in tm_cur.migrations(tgt_rel)]
    newest_target = tgt_ids[-1] if tgt_ids else ""
    downs = [(i, p) for i, p in tm_cur.migrations(cur_rel) if marker and newest_target < i <= marker]
    problems = migration_down_problems(cur_rel, downs)
    if problems:
        raise Stop("rollback to %s refused: %s cannot be undone (%s). Nothing was changed." % (
            target, "; ".join(i for i, _ in problems), "; ".join(r for _, r in problems)))
    if failed is not None:
        undo_failed_migration(agent, vendor, lock_fd, cur_rel, failed)
    if downs:
        say("Undoing %d migration%s, newest first: %s" % (len(downs), "" if len(downs) == 1 else "s", ", ".join(i for i, _ in reversed(downs))))
        rc = migrate_run(cur_rel, agent, vendor, "down", lock_fd, ["--steps", str(len(downs))])
        if rc != 0:
            raise Stop("a migration's down failed (exit %d). `current` was NOT swapped, so release %s is still the one running; the marker "
                       "(.talos-version, migration=%s) says how far the undo got. Fix what the lines above name, then run talos rollback "
                       "again." % (rc, cur, read_marker(agent).get("migration", "") or "none"), HALF)
    reconcile_back(agent, cur_rel, tgt_rel, journal)
    others = [] if journal is not None else other_agents_above(agent, target)
    if not others:
        PR.activate(vendor, target)
    sync_agent_files(agent, tgt_rel, cur_rel, "rollback-%s" % target)
    tm = load_script(os.path.join(HERE, "talos-migrate.py"), "talos_migrate_marker")
    tm.write_marker(agent, version=target, migration=(journal or {}).get("from_migration", tm.read_marker(agent).get("migration", "")))
    chk = os.path.join(tgt_rel, "scripts", "release-check.py")
    if others:
        for o, v in others:
            say("Agent %s is on %s, which still needs `current`, so `current` stays at %s. This agent is back on %s; roll the other back too "
                "(`talos rollback --agent %s`) and the last one moves `current`." % (o, v, cur, target, o))
    elif os.path.isfile(chk):
        rc = run_group([sys.executable, chk, "start", "--release", tgt_rel, "--agent", agent, "--vendor", vendor], what="the start check of release %s" % target)
        if rc != 0:
            raise Stop("release %s is back, but it did not pass its own start check (above). Look at it before you start the agent." % target, HALF)
    clear_journal(vendor)
    say("rolled back to %s" % target)
    if restart:
        request_restart()


def reconcile_back(agent, cur_rel, tgt_rel, journal):
    ps = os.path.join(cur_rel, "scripts", "plugin-settings.py")
    rc = run_group([sys.executable, ps, "reconcile", "--agent", agent, "--old-release", cur_rel, "--new-release", tgt_rel,
                    "--migration", "rollback-%s-to-%s" % (os.path.basename(os.path.dirname(cur_rel)), os.path.basename(os.path.dirname(tgt_rel)))],
                   what="putting the hook list back")
    if rc != 0:
        raise Stop("the hook list in settings.json could not be put back (exit %d). `current` was not swapped." % rc, HALF)
    if not journal:
        return
    before = os.path.join(journal_dir_of(journal), "settings.before")
    if os.path.exists(before):
        restore_exact(agent, open(before, "rb").read())


def journal_dir_of(journal):
    return journal["_dir"]


# --------------------------------------------------------------------------- update
def cmd_update(a):
    owner_terminal_only("update")
    agent = resolve_agent(a.agent)
    vendor = resolve_vendor(a.vendor)
    fd = take_lock(vendor)
    prune_stale(vendor)
    j = read_journal(vendor)
    if j is not None:
        if a.dry_run:
            say("An update %s -> %s was interrupted and is waiting. A dry run never resumes it: run `talos update` to finish it, or "
                "`talos rollback` to go back to %s. Nothing was changed." % (j["from"], j["to"], j["from"]))
            return OK
        return resume(a, agent, vendor, fd, j)
    cur = current_version(vendor)
    cur_rel = rel_dir(vendor, cur)
    lag = agent_lag(agent, cur, cur_rel)
    if lag:
        if a.dry_run:
            say("This agent is behind the release that `current` names (%s): %s. `talos update` would bring it up to date (migrations, hook "
                "list, Talos files) without changing `current`. Dry run: nothing was changed." % (cur, lag))
            return OK
        return catch_up(agent, vendor, fd, cur, lag)
    source = a.source or os.environ.get("TALOS_UPDATE_SOURCE")
    if not source:
        try:
            source = json.load(open(os.path.join(cur_rel, "release.json"), encoding="utf-8")).get("update_source")
        except (OSError, ValueError):
            source = None
    if not source:
        raise Stop("no update source: pass --source <folder or https URL> or set TALOS_UPDATE_SOURCE (the installed release names none).", USAGE)
    die_point("fetch")
    try:
        latest = json.loads(fetch_bytes(source, "latest.json", 65536).decode("utf-8"))
        version, bundle_name = latest["version"], latest["bundle"]
        if not (isinstance(version, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]*", version)
                and bundle_name == "talos-kit-%s.tar.gz" % version):
            raise ValueError("version/bundle names are not in the expected form")
    except (ValueError, KeyError, TypeError, UnicodeDecodeError) as e:
        raise Stop("%s/latest.json is not a release feed (%s). Nothing was changed." % (source, e))
    if PR.version_key(version) <= PR.version_key(cur):
        say("already up to date (%s)%s" % (cur, "" if version == cur else "; the source offers %s, which is not newer" % version))
        return OK
    say("Update available: %s -> %s" % (cur, version))
    dl = os.path.join(vendor, ".dl-%d" % os.getpid())
    stage = os.path.join(vendor, "releases", ".tmp-%d" % os.getpid())
    os.makedirs(dl, mode=0o700)
    try:
        data = fetch_bytes(source, bundle_name, MAX_BUNDLE)
        die_point("verify")
        try:
            sig = fetch_bytes(source, bundle_name + ".sig", 16384)
        except Stop as e:
            raise Stop("no signature for %s (%s). Refusing to install an unsigned release; nothing was changed." % (bundle_name, e))
        allowed = os.path.join(dl, "allowed_signers")
        combined_allowed(cur_rel, vendor, allowed)
        die_point("unpack")
        new_rel = unpack_verified(data, sig, allowed, bundle_name, stage)
        say("Signature verified against the installed release's allowed_signers (and keys you added with trust-key); unpacked those same bytes.")
        bad = verify_release_dir(new_rel, version)
        if bad:
            raise Stop("the signed bundle is not the release it announced (%s): version %s expected. Nothing was installed." % (bad, version))
        die_point("selftest")
        chk = os.path.join(new_rel, "scripts", "release-check.py")
        if not os.path.isfile(chk):
            raise Stop("the new release has no scripts/release-check.py, so it cannot be checked. Nothing was installed.")
        if run_group([sys.executable, chk, "release", "--release", new_rel], fd=fd, what="the new release's self-test") != 0:
            raise Stop("the new release failed its own self-test (above). Nothing was installed.")
        tm, marker, pending = pending_ids(new_rel, agent)
        merge_line = app_merge(a.app_repo, a.app_ref, apply=False) if a.app_repo else None
        notes = release_notes(new_rel)
        if a.dry_run:
            say("")
            say("Dry run: %s would replace %s." % (version, cur))
            for l in notes:
                say("  notes: %s" % l)
            say("  pending migrations: %s" % (", ".join("%s" % os.path.basename(p)[:-3] for _, p in pending) or "none"))
            run_group([sys.executable, os.path.join(new_rel, "scripts", "plugin-settings.py"), "reconcile", "--agent", agent,
                       "--old-release", cur_rel, "--new-release", new_rel, "--dry-run"], what="the hook list preview")
            if merge_line:
                say("  app: %s" % merge_line)
            note = relay_note(new_rel, a.relay_version or os.environ.get("TALOS_RELAY_VERSION"))
            if note:
                say("  %s" % note)
            say("Dry run: nothing was changed.")
            return OK
        die_point("journal")
        if merge_line:
            say("App: " + app_merge(a.app_repo, a.app_ref, apply=True))
        existing = rel_dir(vendor, version)
        if os.path.exists(os.path.dirname(existing)):
            if PR.content_sha(existing) != PR.content_sha(new_rel):
                raise Stop("release %s already exists under releases/ with different content. A release is immutable; remove it yourself if "
                           "you are sure, then run this again. Nothing was changed." % version)
            rm_tree(stage)
        else:
            PR.make_read_only(stage)
            os.rename(stage, os.path.dirname(existing))
        jd = os.path.join(vendor, "update-journal.d")
        rm_tree(jd)
        os.makedirs(jd, mode=0o700)
        sb = settings_bytes(agent)
        if sb is not None:
            atomic_write(os.path.join(jd, "settings.before"), sb, 0o600)
        j = {"v": 1, "from": cur, "to": version, "agent": agent, "from_migration": read_marker(agent).get("migration", ""),
             "settings_existed": sb is not None, "started_ms": int(time.time() * 1000), "relay_version": a.relay_version or ""}
        write_journal(vendor, j)
    finally:
        rm_tree(stage)          # gone already when it was renamed into releases/
        rm_tree(dl)
    j["_dir"] = os.path.join(vendor, "update-journal.d")
    return forward(a, agent, vendor, fd, j)


def agent_lag(agent, cur, cur_rel):
    """Why this agent folder is not on the release `current` names (another agent's update moved `current` under it), or ''."""
    m = read_marker(agent)
    mv = m.get("version", "")
    if mv and mv != cur:
        if PR.version_key(mv) > PR.version_key(cur):
            raise Stop("this agent folder is on release %s but `current` names the older %s (another agent rolled back). Run `talos rollback` "
                       "for this agent to bring it back too." % (mv, cur))
        return "its .talos-version says release %s" % mv
    tm = load_script(os.path.join(cur_rel, "scripts", "talos-migrate.py"), "talos_migrate_lag")
    pending = [i for i, _ in tm.migrations(cur_rel) if i > m.get("migration", "")]
    return "migrations not yet applied to it: %s" % ", ".join(pending) if pending else ""


def reconcile_run(agent, old_rel, new_rel, fd, tag):
    rc = run_group([sys.executable, os.path.join(new_rel, "scripts", "plugin-settings.py"), "reconcile", "--agent", agent,
                    "--old-release", old_rel, "--new-release", new_rel, "--migration", tag], fd=fd, what="the hook list reconcile")
    if rc != 0:
        raise Stop("reconciling the hook list in settings.json failed (exit %d)" % rc)


class MigrationFailed(Stop):
    def __init__(self, mid, msg):
        Stop.__init__(self, msg)
        self.mid = mid


def run_migrations(agent, vendor, fd, new_rel):
    """Each pending migration of `new_rel`, one at a time, the marker moving after each. Raises MigrationFailed naming the one that failed."""
    tm, marker, pending = pending_ids(new_rel, agent)
    for n, (mid, _) in enumerate(pending):
        rc = migrate_run(new_rel, agent, vendor, "up", fd, ["--limit", "1"])
        if rc != 0:
            raise MigrationFailed(mid, "migration %s failed (exit %d)" % (mid, rc))
        if n == 0:
            die_point("migrate-after-1")
    return tm


def undo_failed_migration(agent, vendor, fd, new_rel, e):
    """A migration whose up() stopped half way: its own down() runs too (down must tolerate that), before anything else is undone."""
    mid = getattr(e, "mid", None)
    if mid:
        say("Migration %s failed part way: running its own down to clean up what it left." % mid)
        rc = migrate_run(new_rel, agent, vendor, "down", fd, ["--id", mid])
        if rc != 0:
            raise Stop("the down of the half-done migration %s failed (exit %d); what it left behind needs a look. `current` was not swapped "
                       "back." % (mid, rc), HALF)


def catch_up(agent, vendor, fd, cur, why):
    """This agent was left behind by another agent's update (`current` moved, this folder did not follow): apply the release `current`
    names to THIS folder: Talos files, hook list, migrations, marker, start check. `current` itself is not touched. A failure undoes
    what this run did to the folder and leaves `current` (which other agents run) alone."""
    new_rel = rel_dir(vendor, cur)
    mv = read_marker(agent).get("version", "")
    old_rel = rel_dir(vendor, mv) if mv and os.path.isfile(os.path.join(rel_dir(vendor, mv), ".claude-plugin", "plugin.json")) else new_rel
    say("This agent folder is behind release %s (%s). Bringing it up to date; `current` stays as it is." % (cur, why))
    before = settings_bytes(agent)
    from_mig = read_marker(agent).get("migration", "")
    step = "files"
    try:
        bad = verify_release_dir(new_rel, cur)
        if bad:
            raise Stop("release %s failed its integrity check (%s)" % (cur, bad))
        sync_agent_files(agent, new_rel, old_rel, "update-%s" % cur)
        step = "reconcile"
        reconcile_run(agent, old_rel, new_rel, fd, "update-%s-to-%s" % (mv or "unknown", cur))
        step = "migrate"
        tm = run_migrations(agent, vendor, fd, new_rel)
        tm.write_marker(agent, version=cur)
        step = "check"
        if run_group([sys.executable, os.path.join(new_rel, "scripts", "release-check.py"), "start", "--release", new_rel, "--agent", agent,
                      "--vendor", vendor], fd=fd, what="the start check") != 0:
            raise Stop("the start check of release %s failed for this agent folder" % cur)
    except (Stop, Interrupted, Exception) as e:
        warn("talos update: catching this agent up FAILED at %s: %s" % (step, e if isinstance(e, Stop) else "%s: %s" % (type(e).__name__, e)))
        try:
            undo_failed_migration(agent, vendor, fd, new_rel, e)
            tm2 = load_script(os.path.join(new_rel, "scripts", "talos-migrate.py"), "talos_migrate_undo")
            done = [i for i, _ in tm2.migrations(new_rel) if from_mig < i <= tm2.read_marker(agent).get("migration", "")]
            if done and migrate_run(new_rel, agent, vendor, "down", fd, ["--steps", str(len(done))]) != 0:
                raise Stop("the down of an already finished migration failed (%s); the marker (.talos-version) says how far the undo got" % ", ".join(done), HALF)
            tm2.write_marker(agent, version=mv or cur, migration=from_mig)
            restore_exact(agent, before)
        except Stop as r:
            warn("talos update: and undoing it failed too: %s" % r)
            return HALF
        warn("talos update: this agent folder is as it was; `current` (%s) was not changed." % cur)
        return 128 + e.sig if isinstance(e, Interrupted) else FAILED
    say("This agent is now on release %s. Run `talos update` again to look for a newer one." % cur)
    request_restart()
    return OK


def restore_exact(agent, was):
    """Put settings.json back to the exact bytes `was` when it only differs from them by Talos's own changes (same JSON)."""
    path = os.path.join(agent, ".claude", "settings.json")
    if was is None:
        return
    try:
        now = open(path, "rb").read()
        if was != now and json.loads(was.decode("utf-8")) == json.loads(now.decode("utf-8")):
            atomic_write(path, was, os.stat(path).st_mode & 0o777)
            say("  settings.json is back to its exact original bytes")
        elif was != now:
            say("  settings.json changed in ways other than Talos's hook list meanwhile; it was left as it is now")
    except (OSError, ValueError) as e:
        warn("talos update: could not compare settings.json with the saved original (%s); left as it is" % e)


def resume(a, agent, vendor, fd, j):
    if os.path.realpath(j["agent"]) != agent:
        raise Stop("an update of another agent folder (%s) was interrupted. Run `talos update` for that folder to finish it, or "
                   "`talos rollback --agent %s` to go back." % (j["agent"], j["agent"]), USAGE)
    to = j["to"]
    new_rel = rel_dir(vendor, to)
    bad = verify_release_dir(new_rel, to) if os.path.isdir(new_rel) else "it is not installed"
    if bad:
        raise Stop("an update to %s was interrupted and that release is not usable (%s). Run `talos rollback` to go back to %s; nothing "
                   "else was changed." % (to, bad, j["from"]), HALF)
    say("Resuming the interrupted update %s -> %s." % (j["from"], to))
    j["_dir"] = os.path.join(vendor, "update-journal.d")
    return forward(a, agent, vendor, fd, j)


def forward(a, agent, vendor, fd, j):
    """Steps swap..prune, safe to run again from the top: each one looks at what is already done."""
    cur_ver, to = j["from"], j["to"]
    old_rel, new_rel = rel_dir(vendor, cur_ver), rel_dir(vendor, to)
    step = "swap"
    prev_handlers = {}
    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        prev_handlers[s] = signal.signal(s, lambda n, f: (_ for _ in ()).throw(Interrupted(n)))
    try:
        die_point("swap")
        if os.path.realpath(os.path.join(vendor, "current")) != os.path.realpath(os.path.join(vendor, "releases", to)):
            PR.activate(vendor, to)
        step = "files"
        die_point("files")
        sync_agent_files(agent, new_rel, old_rel, "update-%s" % to)
        step = "reconcile"
        die_point("reconcile")
        reconcile_run(agent, old_rel, new_rel, fd, "update-%s-to-%s" % (cur_ver, to))
        step = "migrate"
        die_point("migrate")
        tm = run_migrations(agent, vendor, fd, new_rel)
        tm.write_marker(agent, version=to)
        step = "check"
        die_point("check")
        rc = run_group([sys.executable, os.path.join(new_rel, "scripts", "release-check.py"), "start", "--release", new_rel, "--agent", agent,
                        "--vendor", vendor], fd=fd, what="the start check")
        if rc != 0:
            raise Stop("the start check of release %s failed (exit %d)" % (to, rc))
        note = relay_note(new_rel, j.get("relay_version") or os.environ.get("TALOS_RELAY_VERSION"))
        if note:
            say(note)
        step = "prune"
        die_point("prune")
        prune_releases(vendor, to, cur_ver)
        step = "restart"
        die_point("restart")
        request_restart()
        clear_journal(vendor)
    except (Stop, Interrupted, Exception) as e:          # anything at all after the swap rolls back; a traceback must not leave it half done
        for s in prev_handlers:
            signal.signal(s, signal.SIG_IGN)
        msg = "interrupted (%s)" % e if isinstance(e, Interrupted) else (str(e) if isinstance(e, Stop) else "unexpected %s: %s" % (type(e).__name__, e))
        warn("talos update: FAILED at %s: %s" % (step, msg))
        warn("talos update: rolling back to %s ..." % cur_ver)
        try:
            do_rollback(vendor, agent, cur_ver, fd, journal=j, restart=False, failed=e)
        except Stop as r:
            warn("talos update: THE ROLLBACK FAILED TOO: %s" % r)
            warn("talos update: you are half way between %s and %s. Fix what is named above, then run `talos rollback` (or `talos update` to try "
                 "again). The record of this update is %s." % (cur_ver, to, journal_path(vendor)))
            return HALF
        warn("talos update: rolled back to %s; %s was not kept running and your files are as they were." % (cur_ver, to))
        return 128 + e.sig if isinstance(e, Interrupted) else FAILED
    finally:
        for s, h in prev_handlers.items():
            try:
                signal.signal(s, h)
            except (ValueError, OSError):
                pass
    say("updated %s -> %s" % (cur_ver, to))
    return OK


def prune_releases(vendor, current, previous):
    vs = installed_versions(vendor)
    keep = set(vs[-KEEP:]) | {current, previous}
    for v in vs:
        if v not in keep:
            trash = os.path.join(vendor, "releases", ".trash-%s-%d" % (v, os.getpid()))
            os.rename(os.path.join(vendor, "releases", v), trash)
            rm_tree(trash)
            say("  removed old release %s (the newest %d are kept)" % (v, KEEP))


# --------------------------------------------------------------------------- rollback and restore commands
def cmd_rollback(a):
    owner_terminal_only("rollback")
    agent = resolve_agent(a.agent)
    vendor = resolve_vendor(a.vendor)
    fd = take_lock(vendor)
    prune_stale(vendor)
    cur = current_version(vendor)
    j = read_journal(vendor)
    if j is not None:
        if os.path.realpath(j["agent"]) != agent:
            raise Stop("an update of another agent folder (%s) was interrupted and is waiting; this rollback is for %s. Run `talos update "
                       "--agent %s` to finish that update, or `talos rollback --agent %s` to go back, before anything else." % (
                           j["agent"], agent, j["agent"], j["agent"]), USAGE)
        j["_dir"] = os.path.join(vendor, "update-journal.d")
    target = a.version
    if not target:
        if j is not None:
            target = j["from"]
        else:
            older = [v for v in installed_versions(vendor) if PR.version_key(v) < PR.version_key(cur)]
            if not older:
                raise Stop("there is no older release than %s installed under %s/releases; nothing to roll back to." % (cur, vendor))
            target = older[-1]
    elif not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]*", target):
        raise Stop("%r is not a release version" % target, USAGE)
    if target == cur and j is None:
        raise Stop("%s is the release that is running; nothing to roll back to." % cur)
    if target != cur and PR.version_key(target) > PR.version_key(cur) and j is None:
        raise Stop("%s is newer than the running release %s; talos rollback only goes back (use talos update to go forward)." % (target, cur))
    if a.version and not os.path.isdir(os.path.join(vendor, "releases", target)):
        raise Stop("there is no release %s installed under %s/releases (installed: %s)" % (target, vendor, ", ".join(installed_versions(vendor)) or "none"))
    do_rollback(vendor, agent, target, fd, journal=j, restart=True)
    return OK


def last_good_version(agent, rel):
    d = os.path.join(app_home(), "last-good")
    try:
        names = sorted((n for n in os.listdir(d) if re.fullmatch(r"\d{8}T\d{9}Z", n)), reverse=True)
    except OSError:
        raise Stop("the Talos app's last-good store (%s) does not exist on this Mac, so there is nothing to restore %s from." % (d, rel))
    for n in names:
        try:
            meta = json.load(open(os.path.join(d, n, "meta.json"), encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if os.path.realpath(str(meta.get("agent_dir", ""))) != agent or rel not in (meta.get("files") or []):
            continue
        p = os.path.join(d, n, *rel.split("/"))
        if os.path.isfile(p) and not os.path.islink(p):
            return n, p
    raise Stop("the last-good store has no saved copy of %s for this agent folder (%s)." % (rel, agent))


def cmd_restore(a):
    owner_terminal_only("restore")
    agent = resolve_agent(a.agent)
    vendor = resolve_vendor(a.vendor)
    raw = a.file
    if not raw or raw.startswith("/") or "\0" in raw:
        raise Stop("restore takes a path inside the agent folder, written relative to it (not %r)." % raw, USAGE)
    rel = os.path.normpath(raw).replace(os.sep, "/")
    if rel.startswith("../") or rel == ".." or rel == ".":
        raise Stop("%r is not inside the agent folder." % raw, USAGE)
    if rel.split("/")[0] == ".git":
        raise Stop("restore never touches .git.", USAGE)
    dst = os.path.join(agent, rel)
    if os.path.commonpath([agent, os.path.join(os.path.realpath(os.path.dirname(dst)), os.path.basename(dst))]) != agent:
        raise Stop("%s leaves the agent folder through a link; refused." % raw, USAGE)
    if rel.split("/")[0] in ("hooks", "scripts") and (os.path.islink(os.path.join(agent, rel.split("/")[0]))):
        raise Stop("%s lives inside the Talos release (hooks/ and scripts/ are links into it, and a release is read-only). To repair "
                   "it run talos update or talos rollback." % rel, USAGE)
    if os.path.lexists(dst) and (os.path.isdir(dst) or os.path.islink(dst) or not os.path.isfile(dst)):
        raise Stop("%s is not a single file (a folder, a link or something else). restore puts back one regular file at a time, so a "
                   "whole tree is never reverted by it. Nothing was changed." % rel, USAGE)
    fd = take_lock(vendor)
    stamp = time.strftime("%Y%m%dT%H%M%S")

    def keep_current():
        """The file as it is now, kept under a name nothing else has used, BEFORE anything replaces it."""
        if os.path.isfile(dst) and not os.path.islink(dst):
            bak = unique_bak(dst, "restore-%s" % stamp)
            shutil.copy2(dst, bak)
            say("  the file as it was is kept as %s" % os.path.basename(bak))

    def replace(data, mode=None):
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        atomic_write(dst, data, mode if mode is not None else (os.stat(dst).st_mode & 0o777 if os.path.exists(dst) else 0o644))

    cur_rel = rel_dir(vendor, current_version(vendor))
    src_in_release = os.path.join(cur_rel, "agent-files", *rel.split("/"))
    if os.path.isfile(src_in_release):
        keep_current()
        replace(open(src_in_release, "rb").read())
        say("restored %s from the current release (%s)" % (rel, os.path.basename(os.path.dirname(cur_rel))))
        return OK
    if rel in SHARED:
        name, p = last_good_version(agent, rel)
        data = open(p, "rb").read()
        try:
            if not isinstance(json.loads(data.decode("utf-8")), dict):
                raise ValueError("not an object")
        except ValueError as e:
            raise Stop("the saved copy of %s (last-good %s) is not valid JSON (%s); not restored." % (rel, name, e))
        keep_current()
        replace(data)
        say("restored %s from the app's last-good store (version %s)" % (rel, name))
        return OK
    src = a.source or "HEAD"
    if src.startswith("-") or not re.fullmatch(r"[0-9A-Za-z._/~^@{}-]+", src):
        raise Stop("%r is not a commit name." % src, USAGE)
    if git(agent, "rev-parse", "--is-inside-work-tree").stdout.strip() != "true":
        raise Stop("%s is not a git repository, so there is no earlier version of %s to restore (the agent's Stop hook makes the commits "
                   "this reads)." % (agent, rel))
    tree = git(agent, "ls-tree", "-z", src, "--", rel)
    entries = [e for e in tree.stdout.split("\0") if e]
    if tree.returncode != 0 or not entries:
        raise Stop("git has no copy of %s at %s (a file git never saw cannot be restored). Nothing was changed." % (rel, src))
    meta = entries[0].split("\t", 1)[0].split()
    if len(entries) != 1 or meta[:2] not in (["100644", "blob"], ["100755", "blob"]):
        raise Stop("git has %s at %s, not a single file (a folder or a link). restore puts back one regular file at a time. Nothing was "
                   "changed." % (rel, src), USAGE)
    keep_current()
    r = git(agent, "restore", "--source=%s" % src, "--worktree", "--", ":(literal)%s" % rel)
    if r.returncode != 0:
        raise Stop("git could not restore %s: %s" % (rel, (r.stderr or r.stdout).strip()[:300]))
    say("restored %s from git (%s)" % (rel, src))
    return OK


# --------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="verb", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--agent", "--agent-dir", dest="agent")
    common.add_argument("--vendor")
    u = sub.add_parser("update", parents=[common])
    u.add_argument("--dry-run", action="store_true")
    u.add_argument("--source")
    u.add_argument("--relay-version")
    u.add_argument("--app-repo")
    u.add_argument("--app-ref")
    r = sub.add_parser("rollback", parents=[common])
    r.add_argument("version", nargs="?")
    t = sub.add_parser("trust-key")
    t.add_argument("file")
    t.add_argument("--vendor")
    s = sub.add_parser("restore", parents=[common])
    s.add_argument("file")
    s.add_argument("--source")
    a = ap.parse_args()
    if a.verb == "update" and bool(a.app_repo) != bool(a.app_ref):
        print("talos update: --app-repo and --app-ref go together", file=sys.stderr)
        return USAGE
    try:
        return {"update": cmd_update, "rollback": cmd_rollback, "restore": cmd_restore, "trust-key": cmd_trust_key}[a.verb](a)
    except Stop as e:
        warn("talos %s: %s" % (a.verb, e))
        return e.code
    except Interrupted as e:
        warn("talos %s: interrupted; nothing is half done unless it said so above" % a.verb)
        return 128 + e.sig


if __name__ == "__main__":
    sys.exit(main())
