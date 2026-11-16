#!/usr/bin/python3 -I
"""Root's copy of the Talos kit (docs/WINDOWS-PLAN.md step 3, "The kit a thread session's hook runs, kept by root").

    kit.py install      talos-wsl.sh kit-update: the tray's "Update the kit", and install.ps1 before the supervisor's first start

The talos user builds a sealed release of the kit in its own folder (kit/scripts/plugin-release.py), but a release and the
digest vouching for it are both that user's to rewrite. So root copies the release talos built into a folder only root can
write, works the digest out itself over ITS copy, and records it; the supervisor (apps/bridge/src/supervisor/rooted-kit.ts)
then takes a thread session's permission hook only from root's copy, and only when the copy matches root's record:

    /opt/talos-app/kit/current -> releases/<version>         root:root; every folder from the kit up to / not g/o-writable
    /opt/talos-app/kit/releases/<version>/talos-kit/...      folders 0555, files 0555 or 0444: no write bit, the owner's too
    /opt/talos-app/kit/.claude-plugin/marketplace.json       root's fixed bytes (packages/protocol/fixtures/kit-marketplace.json)
    /etc/talos/kit-release                                   root:root 0644: {"v":1,"version":...,"content_sha256":...}
    /etc/claude-code/managed-settings.json                   root:root 0644: Claude Code's policy, only root's kit may load as a
                                                             marketplace (A'; packages/protocol/fixtures/managed-settings.json)

It is reachable only from the Windows side: `wsl.exe -u root` from the tray or Setup. Inside the distro interop is off, so no
process there can start wsl.exe, and nothing there names it: no rule giving talos root through sudo or PolicyKit, no unit, no
socket, no path it watches (scripts/kit-update.test.ts checks the distro's files for that). It refuses unless it runs as uid 0 with no
SUDO_USER, SUDO_UID, PKEXEC_UID or DOAS_USER in its environment, and it checks the distro is still cut off from Windows
(`talos-wsl.sh isolation`) before it starts and again right before it seals.

What it takes from talos is the release's FILES, by content: the tree is opened folder by folder with O_NOFOLLOW, and a link,
a FIFO, a socket or a device anywhere in it refuses the whole update (nothing is installed). The digest is root's, over root's
copy, in plugin-release.py's content_sha (packages/protocol/fixtures/kit-content-sha.json holds both sides to it): a file's x
flag is "can the reader run it", and root's copy is 0555 for a file whose owner could run it in talos's tree, else 0444. Talos
can change what the next update copies (it writes the kit anyway); it can never change a release root sealed, or the record.

Output: ONE fixed word on stdout for the tray (TalosWin.ps1 Get-TalosRecoveryText), the details on stderr (install's log):
  kit-updated | kit-current | kit-policy-updated | not-isolated | not-root | kit-no-release | kit-bad-release | kit-version-taken | kit-policy-foreign
  | kit-unsafe-path | kit-busy | failed
"""
import errno
import fcntl
import hashlib
import json
import os
import pwd
import re
import secrets
import shutil
import stat
import subprocess
import sys

USER = "talos"
# Tests run this as an ordinary user against a scratch root (scripts/kit-update.test.ts). As root it is ignored: no
# variable can point root at another file, folder or program.
# Both ids: a process whose effective uid is root (a set-uid wrapper) never takes a test root either (Fable R1-5).
TEST_ROOT = (os.environ.get("TALOS_KIT_TEST_ROOT") if os.getuid() != 0 and os.geteuid() != 0 else None) or None
ROOT_UID = os.getuid() if TEST_ROOT else 0


def at(path):
    return os.path.join(TEST_ROOT, path.lstrip("/")) if TEST_ROOT else path


VENDOR = at("/opt/talos-app/kit")
RELEASES = os.path.join(VENDOR, "releases")
ETC_TALOS = at("/etc/talos")
RECORD = "kit-release"
MARKER = at("/etc/talos-wsl/marker")
CC_DIR = at("/etc/claude-code")
MANAGED = "managed-settings.json"
DROPINS = "managed-settings.d"
LOCK = at("/run/talos-kit-update.lock")
# the same check the tray's every root verb makes; TALOS_KIT_TEST_ISOLATION stands in for it in tests
ISOLATION = (os.environ.get("TALOS_KIT_TEST_ISOLATION") if TEST_ROOT else None) or "/opt/talos-wsl/talos-wsl.sh"

PLUGIN_DIR = "talos-kit"
VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,63}")
MAX_BYTES = 64 << 20
MAX_ENTRIES = 20000  # files and folders alike (Fable R1-3: empty folders were free)
MAX_DEPTH = 40
SETTINGS_MAX = 1 << 20
WORKERS_MAX = 10000
# The exact bytes, pinned on both sides by the fixtures named above (a test compares them).
# The allowlist alone is not enough: Claude Code checks a marketplace's `source` but loads from the `installLocation` recorded in
# the talos user's ~/.claude/plugins/known_marketplaces.json, so a forged one loaded a plugin from the home folder (Titan, measured
# on 2.1.322 and 2.1.323). Declaring talos-local here too makes Claude Code rewrite that record at start: only root's kit loads.
MANAGED_BYTES = (b'{"strictKnownMarketplaces":[{"source":"directory","path":"/opt/talos-app/kit"}],'
                 b'"extraKnownMarketplaces":{"talos-local":{"source":{"source":"directory","path":"/opt/talos-app/kit"}}}}\n')
# Policies an earlier Talos wrote (SHA-256 of the whole file): a file holding exactly one of these is Talos's own and is replaced
# with MANAGED_BYTES; anything else stays foreign and untouched. A new policy adds the one it replaces here.
PREVIOUS_POLICIES = {
    # A', the allowlist alone (packages/protocol/fixtures/managed-settings.json before 5021b0e1)
    "837baefdd626a3a386f20155e0f4a2ee125aef07d70ee4efd9107c4747ec5b57",
}
MARKETPLACE_BYTES = (json.dumps({
    "name": "talos-local",
    "description": "The Talos kit releases installed on this machine.",
    "owner": {"name": "Talos"},
    "plugins": [{"name": "talos", "source": "./current/" + PLUGIN_DIR,
                 "description": "The Talos zone: memory hooks, safety guards, skills, agents and helper scripts for a Talos agent."}],
}, indent=2, ensure_ascii=False) + "\n").encode("utf-8")

DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


class Refused(Exception):
    def __init__(self, word, why):
        super().__init__(why)
        self.word = word
        self.why = why


def refuse(word, why):
    raise Refused(word, why)


# ---- who may run it -------------------------------------------------------------------------------------------------------
def check_caller():
    for v in ("SUDO_USER", "SUDO_UID", "PKEXEC_UID", "DOAS_USER"):
        if os.environ.get(v):
            refuse("not-root", "run through %s: kit-update runs only as root from the Windows side (wsl.exe -u root)" % v)
    if not TEST_ROOT and os.geteuid() != 0:
        refuse("not-root", "kit-update runs only as root")
    if not TEST_ROOT and os.getuid() != 0:
        refuse("not-root", "kit-update runs only as root (real uid %d)" % os.getuid())


def check_isolated():
    """talos-wsl.sh isolation: interop and the drives off as wsl.conf says, applied at this start, and the mounts cut. The
    VM-wide WSLInterop binfmt entry is NOT the test: the distro registers it again at boot for the owner's other distros, and
    with interop off in wsl.conf WSL serves no Windows program here whatever that entry says."""
    try:
        r = subprocess.run([ISOLATION, "isolation"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=30, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})
    except (OSError, subprocess.TimeoutExpired):
        refuse("not-isolated", "the distro's isolation could not be checked")
    if r.returncode != 0:
        refuse("not-isolated", "the distro is not cut off from Windows (talos-wsl.sh isolation)")


def check_marker():
    try:
        st = os.lstat(MARKER)
        dst = os.lstat(os.path.dirname(MARKER))
    except OSError:
        refuse("kit-unsafe-path", "this is not a Talos distro (no %s)" % MARKER)
    if not stat.S_ISDIR(dst.st_mode) or dst.st_uid != ROOT_UID or dst.st_mode & 0o022:
        refuse("kit-unsafe-path", "%s is not root's own folder" % os.path.dirname(MARKER))
    if not stat.S_ISREG(st.st_mode) or st.st_uid != ROOT_UID or st.st_mode & 0o022:
        refuse("kit-unsafe-path", "%s is not root's own file" % MARKER)


# ---- root's own folders -------------------------------------------------------------------------------------------------
def root_dir(path, mode=0o755, create=True):
    """`path` a real folder of root's that only root can write: made with `mode` when missing (and `create`), its mode set to
    `mode` when it is root's. A link, a file, or a folder of anyone else refuses."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        if not create:
            refuse("kit-unsafe-path", "%s is missing" % path)
        os.mkdir(path, mode)
        st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != ROOT_UID:
        refuse("kit-unsafe-path", "%s is not root's own folder" % path)
    if stat.S_IMODE(st.st_mode) != mode:
        os.chmod(path, mode, follow_symlinks=False)


def check_ancestors(path):
    """Every folder above `path`, up to / (or the test root), root's and not group- or other-writable."""
    top = os.path.realpath(TEST_ROOT) if TEST_ROOT else "/"
    d = os.path.dirname(path)
    while True:
        try:
            st = os.lstat(d)
        except OSError:
            refuse("kit-unsafe-path", "%s cannot be looked at" % d)
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode) or st.st_uid != ROOT_UID or st.st_mode & 0o022:
            refuse("kit-unsafe-path", "%s is not root's own folder that only root can write" % d)
        if os.path.realpath(d) == top or d == os.path.dirname(d):
            return
        d = os.path.dirname(d)


def prepare_vendor():
    opt_app = os.path.dirname(VENDOR)
    if not os.path.lexists(os.path.dirname(opt_app)):
        root_dir(os.path.dirname(opt_app))           # /opt itself, on a distro that has none
    check_ancestors(opt_app)
    root_dir(opt_app)
    root_dir(VENDOR)
    root_dir(RELEASES)


# ---- Claude Code's policy (A') ---------------------------------------------------------------------------------------------
def policy_state():
    """'absent' (nothing there yet), 'ours' (exactly root's file), 'old' (exactly a policy an earlier Talos wrote: replaced), or
    a refusal: never overwrite a policy Talos did not write, and never leave a drop-in beside it (its marketplace list is joined
    to the file's: measured on 2.1.322 and 2.1.323). The drop-in folder is held to the supervisor's rule (rooted-kit.ts
    managedProblem): absent, or root's own empty folder nobody else can write."""
    try:
        d = os.lstat(CC_DIR)
    except FileNotFoundError:
        return "absent"
    if not stat.S_ISDIR(d.st_mode) or d.st_uid != ROOT_UID or d.st_mode & 0o022:
        refuse("kit-policy-foreign", "%s is not root's own folder" % CC_DIR)
    dropins = os.path.join(CC_DIR, DROPINS)
    try:
        ds = os.lstat(dropins)
        if not stat.S_ISDIR(ds.st_mode) or ds.st_uid != ROOT_UID or ds.st_mode & 0o022 or os.listdir(dropins):
            refuse("kit-policy-foreign", "%s holds a policy beside Talos's, or is not root's own; Talos does not change it" % dropins)
    except FileNotFoundError:
        pass
    path = os.path.join(CC_DIR, MANAGED)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except FileNotFoundError:
        return "absent"
    except OSError as e:
        if e.errno == errno.ELOOP:
            refuse("kit-policy-foreign", "%s is a link; Talos does not change it" % path)
        raise
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != ROOT_UID or st.st_mode & 0o022 or st.st_size > 4096:
            refuse("kit-policy-foreign", "%s is not a policy Talos wrote; Talos does not change it" % path)
        body = os.read(fd, 4097)
    finally:
        os.close(fd)
    if body == MANAGED_BYTES:
        return "ours"
    if hashlib.sha256(body).hexdigest() in PREVIOUS_POLICIES:
        return "old"
    refuse("kit-policy-foreign", "%s is a policy Talos did not write; Talos does not change it" % path)


def write_file(dirpath, name, data, mode):
    """`data` as dirpath/name, atomically: a temp file made O_EXCL|O_NOFOLLOW in the folder, `mode`, fsynced, renamed in. A
    write that fails leaves no temp file behind."""
    d = os.open(dirpath, DIR_FLAGS)
    try:
        tmp = ".%s.%s" % (name, secrets.token_hex(6))
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=d)
        try:
            try:
                os.write(fd, data)
                os.fchmod(fd, mode)
                os.fsync(fd)
            finally:
                os.close(fd)
            os.rename(tmp, name, src_dir_fd=d, dst_dir_fd=d)
        except BaseException:
            try:
                os.unlink(tmp, dir_fd=d)
            except OSError:
                pass
            raise
        os.fsync(d)
    finally:
        os.close(d)


def write_policy():
    """Root's policy in place: written when there is none, replaced when it is one an earlier Talos wrote, else left alone
    (policy_state refuses anything foreign)."""
    if policy_state() == "ours":
        return False
    root_dir(CC_DIR)
    write_file(CC_DIR, MANAGED, MANAGED_BYTES, 0o644)
    return True


def write_marketplace():
    d = os.path.join(VENDOR, ".claude-plugin")
    root_dir(d)
    path = os.path.join(d, "marketplace.json")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            st = os.fstat(fd)
            same = (stat.S_ISREG(st.st_mode) and st.st_uid == ROOT_UID and stat.S_IMODE(st.st_mode) == 0o444
                    and os.read(fd, 4097) == MARKETPLACE_BYTES)
        finally:
            os.close(fd)
        if same:
            return
    except OSError:
        pass  # missing, or a link (O_NOFOLLOW): replaced below, the rename takes the name over
    write_file(d, "marketplace.json", MARKETPLACE_BYTES, 0o444)


# ---- talos's release, read without following anything ------------------------------------------------------------------
def talos_ids():
    if TEST_ROOT:
        return os.getuid(), os.path.join(TEST_ROOT, "home", "talos")
    try:
        u = pwd.getpwnam(USER)
    except KeyError:
        refuse("kit-no-release", "there is no talos user in this distro")
    return u.pw_uid, u.pw_dir


def open_under(dfd, names, what):
    """Each name a real folder below the last (O_NOFOLLOW): the fd of the last one."""
    fd = os.dup(dfd)
    try:
        for n in names:
            nfd = os.open(n, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = nfd
        return fd
    except FileNotFoundError:
        os.close(fd)
        refuse("kit-no-release", "talos has no built kit (%s is missing)" % what)
    except OSError as e:
        os.close(fd)
        refuse("kit-bad-release", "%s: %s" % (what, "a link or not a folder" if e.errno in (errno.ELOOP, errno.ENOTDIR) else e.strerror))


def source_release():
    """(fd of talos's releases/<version>/talos-kit, version): from talos's kit `current` link, as plugin-release.py writes it
    (relative, releases/<version>), never following a link on the way."""
    _, home = talos_ids()
    try:
        hfd = os.open(home, DIR_FLAGS)
    except OSError:
        refuse("kit-no-release", "talos's home %s cannot be opened" % home)
    try:
        kfd = open_under(hfd, [".local", "share", "talos", "kit"], "~/.local/share/talos/kit")
    finally:
        os.close(hfd)
    try:
        try:
            target = os.readlink("current", dir_fd=kfd)
        except FileNotFoundError:
            refuse("kit-no-release", "talos's kit has no current release")
        except OSError:
            refuse("kit-bad-release", "talos's kit current is not a link to a release")
        m = re.fullmatch(r"releases/(.+)", target)
        if not m or not VERSION.fullmatch(m.group(1)):
            refuse("kit-bad-release", "talos's kit current does not name a release (releases/<version>)")
        version = m.group(1)
        return open_under(kfd, ["releases", version, PLUGIN_DIR], "release %s" % version), version
    finally:
        os.close(kfd)


def good_name(n):
    if n in (".", "..") or "/" in n or "\0" in n or len(os.fsencode(n)) > 255:
        return False
    try:
        n.encode("utf-8")  # an undecodable name (surrogateescape) would sort differently from the supervisor's
    except UnicodeEncodeError:
        return False
    return True


def copy_tree(sfd, dfd, rel, budget, depth):
    """Talos's folder `sfd` into root's `dfd`: regular files and folders only, by content; __pycache__ and .pyc are not taken
    (the supervisor refuses a release that holds any: Python prefers a cached module the digest leaves out)."""
    if depth > MAX_DEPTH:
        refuse("kit-bad-release", "the release is nested deeper than %d folders" % MAX_DEPTH)
    # every entry is counted as it is read, the skipped ones too, so one folder of millions of names stops at the limit
    # instead of being held in memory first (Fable R2-1); the order of the copy does not matter (the digest sorts)
    with os.scandir(sfd) as it:
        for e in it:
            budget["entries"] += 1
            if budget["entries"] > MAX_ENTRIES:
                refuse("kit-bad-release", "the release has more than %d files and folders" % MAX_ENTRIES)
            copy_entry(sfd, dfd, e.name, rel, budget, depth)


def copy_entry(sfd, dfd, n, rel, budget, depth):
    r = rel + n
    if not good_name(n):
        refuse("kit-bad-release", "a name in the release is not plain UTF-8: %r" % r)
    st = os.stat(n, dir_fd=sfd, follow_symlinks=False)
    if stat.S_ISDIR(st.st_mode):
        if n == "__pycache__":
            return
        cfd = os.open(n, DIR_FLAGS, dir_fd=sfd)  # O_NOFOLLOW: a folder swapped for a link since the stat refuses
        try:
            if not stat.S_ISDIR(os.fstat(cfd).st_mode):
                refuse("kit-bad-release", "%s changed while it was copied" % r)
            os.mkdir(n, 0o700, dir_fd=dfd)
            ofd = os.open(n, DIR_FLAGS, dir_fd=dfd)
            try:
                copy_tree(cfd, ofd, r + "/", budget, depth + 1)
            finally:
                os.close(ofd)
        finally:
            os.close(cfd)
    elif stat.S_ISREG(st.st_mode):
        if not n.endswith(".pyc"):
            copy_file(sfd, dfd, n, r, budget)
    else:
        kind = ("a link" if stat.S_ISLNK(st.st_mode) else "a FIFO" if stat.S_ISFIFO(st.st_mode)
                else "a socket" if stat.S_ISSOCK(st.st_mode) else "a device")
        refuse("kit-bad-release", "the release holds %s: %s" % (kind, r))


def copy_file(sfd, dfd, n, r, budget):
    try:
        src = os.open(n, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=sfd)
    except OSError:
        refuse("kit-bad-release", "%s cannot be opened as a plain file" % r)
    try:
        st = os.fstat(src)
        if not stat.S_ISREG(st.st_mode):
            refuse("kit-bad-release", "%s changed while it was copied" % r)
        # talos's own file, with no other name: a hard link to a file talos cannot read itself would otherwise be published
        # 0444 by root (Fable R1-6; fs.protected_hardlinks is not something Talos sets or checks)
        if st.st_uid != budget["uid"] or st.st_nlink != 1:
            refuse("kit-bad-release", "%s is not talos's own file with one name" % r)
        exe = bool(st.st_mode & stat.S_IXUSR)  # the owner (talos) could run it in talos's tree
        dst = os.open(n, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=dfd)
        try:
            while True:
                chunk = os.read(src, 1 << 20)
                if not chunk:
                    break
                budget["bytes"] += len(chunk)
                if budget["bytes"] > MAX_BYTES:
                    refuse("kit-bad-release", "the release is larger than %d MB" % (MAX_BYTES >> 20))
                os.write(dst, chunk)
            os.fsync(dst)
            os.fchmod(dst, 0o555 if exe else 0o444)
        finally:
            os.close(dst)
    finally:
        os.close(src)


# ---- sealing and the digest -----------------------------------------------------------------------------------------------
def seal(top):
    """No write bit anywhere under `top` (folders 0555, files keep their 0555/0444), deepest first."""
    for dp, dn, fn in os.walk(top, topdown=False):
        for n in fn:
            p = os.path.join(dp, n)
            os.chmod(p, stat.S_IMODE(os.lstat(p).st_mode) & 0o555, follow_symlinks=False)
        os.chmod(dp, 0o555)


def unseal(top):
    for dp, dn, fn in os.walk(top):
        os.chmod(dp, 0o755)


def remove_tree(top):
    if os.path.lexists(top):
        unseal(top)
        shutil.rmtree(top)


def content_sha(root):
    """plugin-release.py content_sha, over root's copy. The x flag is the reader's: in root's copy a file is 0555 or 0444, so it
    is the mode, never os.access (which, for root, says yes to any x bit at all)."""
    import hashlib
    h = hashlib.sha256()
    for dp, dn, fn in os.walk(root):
        dn[:] = sorted(d for d in dn if d != "__pycache__")
        for n in sorted(fn):
            if n.endswith(".pyc"):
                continue
            p = os.path.join(dp, n)
            rel = os.path.relpath(p, root).replace(os.sep, "/")
            if rel == ".talos-release":
                continue
            st = os.lstat(p)
            if not stat.S_ISREG(st.st_mode):
                refuse("kit-bad-release", "%s in root's copy is not a plain file" % rel)
            h.update(rel.encode() + b"\0" + (b"x" if st.st_mode & 0o111 == 0o111 else b"-") + b"\0")
            with open(p, "rb") as fh:
                h.update(fh.read())
            h.update(b"\0")
    return h.hexdigest()


def roots_no_links(top):
    """Every entry under `top` root's and no link (write bits not looked at)."""
    for dp, dn, fn in os.walk(top):
        if os.lstat(dp).st_uid != ROOT_UID:
            return False
        for n in dn + fn:
            st = os.lstat(os.path.join(dp, n))
            if stat.S_ISLNK(st.st_mode) or st.st_uid != ROOT_UID:
                return False
    return True


def sealed_and_roots(top):
    """Every entry under `top` root's, no link, no write bit."""
    for dp, dn, fn in os.walk(top):
        for n in dn + fn:
            st = os.lstat(os.path.join(dp, n))
            if stat.S_ISLNK(st.st_mode) or st.st_uid != ROOT_UID or st.st_mode & 0o222:
                return False
        st = os.lstat(dp)
        if st.st_uid != ROOT_UID or st.st_mode & 0o222:
            return False
    return True


# ---- the record, current, and what may be removed -------------------------------------------------------------------------
def read_current():
    try:
        t = os.readlink(os.path.join(VENDOR, "current"))
    except OSError:
        return None
    m = re.fullmatch(r"releases/(.+)", t)
    return m.group(1) if m and VERSION.fullmatch(m.group(1)) else None


def swap_current(version):
    tmp = os.path.join(VENDOR, ".current.%s" % secrets.token_hex(6))
    os.symlink(os.path.join("releases", version), tmp)
    os.replace(tmp, os.path.join(VENDOR, "current"))
    d = os.open(VENDOR, DIR_FLAGS)
    try:
        os.fsync(d)
    finally:
        os.close(d)


def write_record(version, sha):
    root_dir(ETC_TALOS, create=True)
    body = json.dumps({"v": 1, "version": version, "content_sha256": sha}, separators=(",", ":")) + "\n"
    write_file(ETC_TALOS, RECORD, body.encode(), 0o644)


def releases_in_use():
    """None when there are more than WORKERS_MAX workers (nothing is pruned then); else the set of
    the releases a running thread session's hook names (<TALOS_APP_HOME>/workers/*/settings.json, whose hook command is
    releases/<version>/... under root's kit): read only as a list of names to KEEP. A name must be a plain release name; a
    file that is not a regular file, is too large, or names nothing is ignored, so a forged one can only keep a folder. Read
    the way the release is: from talos's home down, folder by folder with O_NOFOLLOW, so no link of talos's is ever followed
    (Fable R1-2), and the workers listed lazily, at most WORKERS_MAX of them."""
    _, home = talos_ids()
    keep = set()
    pat = re.compile(re.escape("/opt/talos-app/kit/releases/") + r"([A-Za-z0-9][A-Za-z0-9._+-]{0,63})/")
    fds = []
    try:
        try:
            fds.append(os.open(home, DIR_FLAGS))
            for n in (".config", "talos", "app", "workers"):
                fds.append(os.open(n, DIR_FLAGS, dir_fd=fds[-1]))
        except OSError:
            return keep
        wfd = fds[-1]
        with os.scandir(wfd) as it:
            for i, e in enumerate(it):
                if i >= WORKERS_MAX:
                    # too many to read them all: which releases a session names is not known, so none is removed this run
                    # (Fable R2-2); a release is never pruned on a partial list
                    return None
                try:
                    tfd = os.open(e.name, DIR_FLAGS, dir_fd=wfd)
                except OSError:
                    continue
                try:
                    fd = os.open("settings.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=tfd)
                except OSError:
                    os.close(tfd)
                    continue
                try:
                    if stat.S_ISREG(os.fstat(fd).st_mode):
                        keep.update(pat.findall(os.read(fd, SETTINGS_MAX).decode("utf-8", "replace")))
                finally:
                    os.close(fd)
                    os.close(tfd)
    finally:
        for fd in fds:
            os.close(fd)
    return keep


def drop_staging():
    """Staging folders a stopped run left (a kill skips the cleanup): removed at every run, once the lock is held."""
    for n in os.listdir(RELEASES):
        p = os.path.join(RELEASES, n)
        if n.startswith(".staging-"):
            st = os.lstat(p)
            if stat.S_ISDIR(st.st_mode) and st.st_uid == ROOT_UID:
                remove_tree(p)


def prune(keep):
    """Releases root installed that nothing keeps: current, the one before it, and any a running session names stay."""
    removed = []
    for n in sorted(os.listdir(RELEASES)):
        p = os.path.join(RELEASES, n)
        if VERSION.fullmatch(n) and n not in keep:
            st = os.lstat(p)
            if stat.S_ISDIR(st.st_mode) and st.st_uid == ROOT_UID:
                remove_tree(p)
                removed.append(n)
    return removed


# ---- install --------------------------------------------------------------------------------------------------------------
def install():
    check_caller()
    check_isolated()
    check_marker()
    os.makedirs(os.path.dirname(LOCK), exist_ok=True)
    lk = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        fcntl.flock(lk, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        refuse("kit-busy", "another kit-update is running")
    policy_state()  # refuse early: a foreign policy stops the update before anything is copied
    prepare_vendor()
    drop_staging()
    sfd, version = source_release()
    staging = os.path.join(RELEASES, ".staging-%s" % secrets.token_hex(8))
    os.mkdir(staging, 0o700)
    try:
        try:
            ofd = os.open(staging, DIR_FLAGS)
            try:
                os.mkdir(PLUGIN_DIR, 0o700, dir_fd=ofd)
                kfd = os.open(PLUGIN_DIR, DIR_FLAGS, dir_fd=ofd)
                try:
                    copy_tree(sfd, kfd, "", {"entries": 0, "bytes": 0, "uid": talos_ids()[0]}, 0)
                finally:
                    os.close(kfd)
            finally:
                os.close(ofd)
        finally:
            os.close(sfd)
        # the digest of root's copy (its files already 0555/0444); folders are sealed once it is in place: rename(2) of a
        # folder whose own mode is read-only fails on macOS APFS, where these tests also run (plugin-release.py says the same)
        sha = content_sha(os.path.join(staging, PLUGIN_DIR))
        final = os.path.join(RELEASES, version)
        before = read_current()
        if os.path.lexists(final):
            st = os.lstat(final)
            if not stat.S_ISDIR(st.st_mode) or st.st_uid != ROOT_UID:
                refuse("kit-unsafe-path", "%s is not root's own folder" % final)
            if not roots_no_links(final) or content_sha(os.path.join(final, PLUGIN_DIR)) != sha:
                refuse("kit-version-taken", "release %s is already installed with different content: a release never "
                                            "changes, so the kit needs a new VERSION" % version)
            if not sealed_and_roots(final):
                # the same content, left unsealed by a run stopped between its rename and its seal (Fable R1-1): sealed now,
                # as plugin-release.py does, never refused as another release
                seal(final)
                if not sealed_and_roots(final) or content_sha(os.path.join(final, PLUGIN_DIR)) != sha:
                    refuse("failed", "release %s did not seal" % version)
            remove_tree(staging)
        else:
            check_isolated()  # again, right before anything is put in place
            os.rename(staging, final)
            seal(final)
            if content_sha(os.path.join(final, PLUGIN_DIR)) != sha or not sealed_and_roots(final):
                refuse("failed", "release %s did not seal as copied" % version)
        d = os.open(RELEASES, DIR_FLAGS)
        try:
            os.fsync(d)
        finally:
            os.close(d)
        write_marketplace()
        check_isolated()
        write_record(version, sha)
        swap_current(version)
        wrote_policy = write_policy()
        # current and the one before it stay, and any a running session names; a run that changed nothing removes nothing
        in_use = releases_in_use() if before != version else None
        removed = prune({version, before} | in_use) if in_use is not None else []
    except BaseException:
        if os.path.lexists(staging):
            remove_tree(staging)
        raise
    print("kit-update: release %s, content_sha256 %s%s%s" % (
        version, sha, "; policy written" if wrote_policy else "",
        "; removed %s" % ", ".join(removed) if removed else ""), file=sys.stderr)
    if before != version:
        return "kit-updated"
    # the same kit, but the policy was written or an earlier Talos's replaced: said so, not "already up to date"
    return "kit-policy-updated" if wrote_policy else "kit-current"


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd != "install":
        print("usage: kit.py install", file=sys.stderr)
        sys.exit(64)
    os.umask(0o022)
    try:
        word = install()
    except Refused as r:
        print(r.word)
        print("kit-update: %s" % r.why, file=sys.stderr)
        sys.exit(1)
    except Exception as e:  # never a traceback for the tray: one word, the reason in the log
        print("failed")
        print("kit-update: failed: %s: %s" % (type(e).__name__, e), file=sys.stderr)
        sys.exit(1)
    print(word)


if __name__ == "__main__":
    main()
