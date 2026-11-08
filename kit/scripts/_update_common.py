"""_update_common.py: what talos-update.py and its helpers share (the owner-readable errors, printing, the plugin-release module,
folder removal and atomic writes). Python 3.9, standard library only."""
import fcntl
import importlib.util
import os
import shutil
import signal
import subprocess
import sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
OK, FAILED, USAGE, BUSY, HALF = 0, 1, 2, 3, 4
PRINCIPAL = "talos-release"
NAMESPACE = "talos-kit-release"


class Stop(Exception):
    """A step failed in a way the owner should read: message, and the exit code to end with."""

    def __init__(self, msg, code=FAILED):
        Exception.__init__(self, msg)
        self.code = code


class Interrupted(BaseException):
    def __init__(self, sig):
        BaseException.__init__(self, "signal %d" % sig)
        self.sig = sig


def say(msg=""):
    print(msg)
    sys.stdout.flush()


def warn(msg):
    print(msg, file=sys.stderr)
    sys.stderr.flush()


def load_script(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


PR = load_script(os.path.join(HERE, "plugin-release.py"), "plugin_release")
PLUGIN_DIR = PR.PLUGIN_DIR


def rm_tree(path):
    if not os.path.lexists(path):
        return
    if os.path.islink(path) or os.path.isfile(path):
        os.remove(path)
        return
    PR.make_writable(path)
    shutil.rmtree(path, ignore_errors=True)


def atomic_write(path, data, mode=None):
    tmp = "%s.tmp.%d" % (path, os.getpid())
    with open(tmp, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    if mode is not None:
        os.chmod(tmp, mode)
    os.replace(tmp, path)


def unique_bak(path, tag):
    """<path>.bak-<tag>, or <path>.bak-<tag>-2, -3 ... : a name nothing has used. A backup is never overwritten."""
    base = "%s.bak-%s" % (path, tag)
    cand, n = base, 1
    while os.path.lexists(cand):
        n += 1
        cand = "%s-%d" % (base, n)
    return cand


NET_TIMEOUT = lambda: env_seconds("TALOS_UPDATE_NET_TIMEOUT", 30.0)           # noqa: E731  (per read; a stalled peer gives up)
DOWNLOAD_LIMIT = lambda: env_seconds("TALOS_UPDATE_DOWNLOAD_LIMIT", 900.0)    # noqa: E731  (the whole download, slow but moving)
STEP_TIMEOUT = lambda: env_seconds("TALOS_UPDATE_STEP_TIMEOUT", 900.0)        # noqa: E731  (one migration run, one check)


def die_point(name):
    """Fault injection for test-update.sh: SIGKILL ourselves at the start of the named step (a real kill -9, no cleanup runs)."""
    at = os.environ.get("TALOS_UPDATE_DIE_AT")
    if at == name:
        os.kill(os.getpid(), signal.SIGKILL)
    if at == "boom:" + name:
        raise RuntimeError("injected failure at step %s" % name)


def env_seconds(name, default):
    try:
        v = float(os.environ.get(name, ""))
        return v if v > 0 else default
    except ValueError:
        return default


def owner_terminal_only(verb):
    if os.environ.get("CLAUDECODE"):
        raise Stop("this is running inside a Claude Code session (CLAUDECODE is set). Only you, typing in Terminal, run `talos %s`; "
                   "an agent is not meant to change the release it runs on." % verb, USAGE)
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        raise Stop("`talos %s` only runs in Terminal, typed by you. Open Terminal on your Mac and run it there; it will not run from an "
                   "agent, a script or a pipe." % verb, USAGE)


def resolve_vendor(arg):
    if arg:
        return os.path.abspath(arg)
    real = os.path.realpath(HERE)
    parts = real.split(os.sep)
    if len(parts) > 4 and parts[-2] == PLUGIN_DIR and parts[-4] == "releases":     # .../releases/<v>/talos-kit/scripts
        return os.sep.join(parts[:-4]) or os.sep
    return PR.vendor_default()


def resolve_agent(arg):
    sys.path.insert(0, HERE)
    from _agent_root import agent_root
    if arg:
        agent = os.path.realpath(arg)
        if not os.path.isfile(os.path.join(agent, ".talos-version")) or os.path.exists(os.path.join(agent, ".claude-plugin", "plugin.json")):
            raise Stop("%s is not an agent folder (no .talos-version in it, or it is a release). Pass --agent <the agent folder>." % arg, USAGE)
        return agent
    try:
        return agent_root(os.path.join(HERE, "x"), strict=True)
    except SystemExit as e:
        raise Stop("%s Run this inside the agent folder, or pass --agent." % (e.code if isinstance(e.code, str) else "not an agent folder;"), USAGE)


def app_home():
    return os.environ.get("TALOS_APP_HOME") or os.path.expanduser("~/.config/talos/app")


def take_lock(vendor):
    os.makedirs(vendor, exist_ok=True)
    fd = os.open(os.path.join(vendor, ".lock"), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (BlockingIOError, OSError):
        who = ""
        try:
            pid = int(os.pread(fd, 32, 0).split()[0])
            try:
                os.kill(pid, 0)
                who = " (started by pid %d)" % pid
            except ProcessLookupError:
                who = " (started by pid %d, which has gone, but a step it started is still running)" % pid
            except PermissionError:
                who = " (started by pid %d)" % pid
        except (OSError, ValueError, IndexError):
            pass
        os.close(fd)
        raise Stop("update already running%s: another talos update, rollback or restore holds %s. Wait for it to finish; nothing was "
                   "changed." % (who, os.path.join(vendor, ".lock")), BUSY)
    os.ftruncate(fd, 0)
    os.pwrite(fd, ("%d\n" % os.getpid()).encode(), 0)
    return fd


def run_group(cmd, fd=None, timeout=None, cwd=None, what="step"):
    """Run a command in its own process group, output straight to the terminal. The group dies with a timeout or an interrupt.
    `fd` (the lock) is passed down, so the lock lives as long as the child does even if this process is killed."""
    timeout = timeout or STEP_TIMEOUT()
    p = subprocess.Popen(cmd, cwd=cwd, start_new_session=True, pass_fds=(fd,) if fd is not None else (),
                         env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
    try:
        return p.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_group(p)
        raise Stop("%s timed out after %d s and was stopped (the whole process group)" % (what, timeout))
    except BaseException:
        _kill_group(p)
        raise


def _kill_group(p):
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(p.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            p.wait(timeout=3)
            break
        except subprocess.TimeoutExpired:
            continue
    try:
        os.killpg(p.pid, signal.SIGKILL)       # anything the child left in the group
    except (ProcessLookupError, PermissionError):
        pass
