"""_rooted.py: whether this machine is a Talos distro whose kit root keeps (the Windows install), read the way the supervisor's
apps/bridge/src/supervisor/rooted-kit.ts reads it: root's marker /etc/talos-wsl/marker, a plain file root owns that nobody else
can write, in a folder root owns that nobody else can write.

    mode()  -> "home"    no /etc/talos-wsl at all: the kit is the user's own (plain Linux, a Mac)
               "rooted"  root's marker: the kit Main loads is root's sealed copy at ROOTED_KIT, named by that path as written
    raises Bad           /etc/talos-wsl there but not root's, or its marker missing or not root's: nothing is written then

Shared by plugin-settings.py and release-check.py so the two never disagree. TALOS_KIT_ROOTED_MARKER moves the marker, and
the test's own uid stands for root, only when TALOS_KIT_TEST=1 (the kit's tests); a shipped run reads /etc/talos-wsl only.
"""
import os
import stat

ROOTED_KIT = "/opt/talos-app/kit"
_MARKER = "/etc/talos-wsl/marker"


class Bad(Exception):
    pass


def _where():
    if os.environ.get("TALOS_KIT_TEST") == "1" and os.environ.get("TALOS_KIT_ROOTED_MARKER"):
        return os.environ["TALOS_KIT_ROOTED_MARKER"], os.getuid()
    return _MARKER, 0


def mode():
    marker, root = _where()
    folder = os.path.dirname(marker)
    try:
        d = os.lstat(folder)
    except (FileNotFoundError, NotADirectoryError):
        return "home"
    except OSError as e:
        raise Bad("%s cannot be looked at (%s)" % (folder, e.strerror or e))
    if stat.S_ISLNK(d.st_mode) or not stat.S_ISDIR(d.st_mode) or d.st_uid != root or d.st_mode & 0o022:
        raise Bad("%s is not root's own folder" % folder)
    try:
        m = os.lstat(marker)
    except OSError:
        raise Bad("%s is there without root's marker" % folder)
    if stat.S_ISLNK(m.st_mode) or not stat.S_ISREG(m.st_mode) or m.st_uid != root or m.st_mode & 0o022:
        raise Bad("%s is not root's own" % marker)
    return "rooted"


def market_entry():
    """talos-local's entry on a Talos distro: root's kit by its path as written (root's policy compares it unresolved)."""
    return {"source": {"source": "directory", "path": ROOTED_KIT}}
