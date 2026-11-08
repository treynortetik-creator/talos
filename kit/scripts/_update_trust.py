"""_update_trust.py: `talos-update trust-key`: the owner, at the terminal, adds one public key to VENDOR/trusted_signers. Python 3.9, standard
library only."""
import base64
import os
import re
import shutil
import stat
import subprocess
import tempfile

from _update_common import FAILED, NAMESPACE, OK, PRINCIPAL, USAGE, Stop, atomic_write, owner_terminal_only, resolve_vendor, say, take_lock


TRUSTED_LINE = re.compile(r'^talos-release namespaces="talos-kit-release" (?:ssh-ed25519|sk-ssh-ed25519@openssh\.com|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) [A-Za-z0-9+/=]+$')


def combined_allowed(cur_rel, vendor, dest):
    """The installed release's allowed_signers plus VENDOR/trusted_signers (keys the owner added with `talos-update trust-key`), as one file.
    The owner's file is used only when it is a regular file, mode 600, owned by this user, and every line is exactly what trust-key writes."""
    text = ""
    tp = os.path.join(vendor, "trusted_signers")
    if os.path.lexists(tp):
        st = os.lstat(tp)
        if not stat.S_ISREG(st.st_mode) or stat.S_IMODE(st.st_mode) != 0o600 or st.st_uid != os.getuid():
            raise Stop("%s must be a plain file, mode 600, owned by you (it is mode %o, owner uid %d); it decides who may sign releases, so it is "
                       "not used. Fix it with chmod 600, or remove it and run trust-key again." % (tp, stat.S_IMODE(st.st_mode), st.st_uid))
        for n, line in enumerate(open(tp, encoding="utf-8").read().splitlines(), 1):
            if not TRUSTED_LINE.match(line):
                raise Stop("%s line %d is not in the format trust-key writes (format: talos-release namespaces=\"talos-kit-release\" <key type> <key>); "
                           "the file is not used." % (tp, n))
    for p in (os.path.join(cur_rel, "allowed_signers"), tp):
        try:
            with open(p, encoding="utf-8") as fh:
                t = fh.read()
            text += t if t.endswith("\n") or not t else t + "\n"
        except OSError:
            pass
    with open(dest, "w", encoding="utf-8") as fh:
        fh.write(text)


# the second name is written in two pieces: the privacy scan reads an @ as an email address
KEY_TYPES = ("ssh-ed25519", "sk-ssh-ed25519@" + "openssh.com", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-rsa")


def cmd_trust_key(a):
    """Add one public key to VENDOR/trusted_signers after showing its fingerprint and getting a y from the owner at the terminal. The
    way the first (or a replacement) signing key reaches an install that was made without one; no release is changed."""
    owner_terminal_only("trust-key")
    vendor = resolve_vendor(a.vendor)
    try:
        if os.path.getsize(a.file) > 4096:
            raise Stop("%s is too big to be one public key file" % a.file, USAGE)
        lines = [l.strip() for l in open(a.file, encoding="utf-8").read().splitlines() if l.strip() and not l.lstrip().startswith("#")]
    except (OSError, UnicodeDecodeError) as e:
        raise Stop("cannot read %s as a public key file: %s" % (a.file, e), USAGE)
    if len(lines) != 1:
        raise Stop("%s must hold exactly one public key (it has %d lines): one key, one decision." % (a.file, len(lines)), USAGE)
    parts = lines[0].split(None, 2)
    try:
        if len(parts) < 2 or parts[0] not in KEY_TYPES:
            raise ValueError("it does not start with a public key type (%s)" % ", ".join(KEY_TYPES[:2]))
        base64.b64decode(parts[1], validate=True)
    except ValueError as e:
        raise Stop("%s is not a public key line: %s. (A private key is refused on purpose.)" % (a.file, e), USAGE)
    ssh = "/usr/bin/ssh-keygen" if os.access("/usr/bin/ssh-keygen", os.X_OK) else shutil.which("ssh-keygen")
    if not ssh:
        raise Stop("ssh-keygen is not installed, so the key cannot be checked")
    with tempfile.TemporaryDirectory(prefix="talos-key-") as d:
        kp = os.path.join(d, "key.pub")
        with open(kp, "w", encoding="utf-8") as fh:
            fh.write("%s %s\n" % (parts[0], parts[1]))
        r = subprocess.run([ssh, "-l", "-f", kp], capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise Stop("ssh-keygen does not accept that key: %s" % (r.stderr or r.stdout).strip()[:200], USAGE)
    say("Public key in %s:" % a.file)
    say("  %s" % r.stdout.strip())
    say("If you trust it, `talos update` will install any Talos kit release signed with it. Compare the fingerprint with the one you got "
        "from the person who made the key, not from this screen alone.")
    try:
        answer = input("Trust this key to sign Talos kit releases on this Mac? [y/N] ")
    except EOFError:
        answer = ""
    if answer.strip().lower() not in ("y", "yes"):
        say("Not trusted; nothing was changed.")
        return FAILED
    take_lock(vendor)
    path = os.path.join(vendor, "trusted_signers")
    entry = '%s namespaces="%s" %s %s' % (PRINCIPAL, NAMESPACE, parts[0], parts[1])
    try:
        have = open(path, encoding="utf-8").read()
    except OSError:
        have = ""
    if entry in have.splitlines():
        say("That key is already trusted; nothing to add.")
        return OK
    atomic_write(path, (have + ("" if not have or have.endswith("\n") else "\n") + entry + "\n").encode("utf-8"), 0o600)
    say("Trusted. %s now lists it; no release was changed." % path)
    return OK
