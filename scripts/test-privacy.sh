#!/usr/bin/env bash
# test-privacy.sh -- does the kit contain anything that looks like a secret or like somebody's private data?
#
# GENERIC checks that run for everyone (and in self-test.sh):
#   - credentials: sk-/sk_ keys, ghp_/gho_ tokens, Slack xox tokens, AWS access key ids, PEM private keys,
#     Telegram bot tokens
#   - personal email addresses (example.com, acme.com and no-reply addresses are fine)
#   - absolute home-folder paths (a user name baked into a path)
#   - long bare numbers that look like chat or account ids
#
# PRIVATE denylist, only if you ask for it: TALOS_PRIVACY_DENYLIST=/path/to/file (one term per line, matched
# case-insensitively, outside this repo!). A maintainer keeps their own names, employer, hometown and ids in such a
# file and runs the scan before every publish. The denylist itself is private and must never be committed.
#
# Usage: bash scripts/test-privacy.sh
set -uo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export KIT
python3 - <<'PY'
import os, re, subprocess, sys
kit = os.environ["KIT"]
SELF = "scripts/test-privacy.sh"
try:
    files = subprocess.run(["git", "-C", kit, "ls-files", "-z"], capture_output=True, text=True, check=True).stdout.split("\0")
    files = [f for f in files if f]
    # also anything new and not yet committed (a scan that skips fresh files would pass the file you just wrote)
    files += [f for f in subprocess.run(["git", "-C", kit, "ls-files", "-z", "--others", "--exclude-standard"],
                                        capture_output=True, text=True).stdout.split("\0") if f]
except Exception:
    files = []
    for root, dirs, fs in os.walk(kit):
        dirs[:] = [d for d in dirs if d not in (".git", ".index", "__pycache__")]
        for f in fs:
            files.append(os.path.relpath(os.path.join(root, f), kit))

SECRETS = [
    ("an sk- API key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}")),
    ("an sk_ API key", re.compile(r"\bsk_[A-Za-z0-9]{20,}")),
    ("a GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}")),
    ("a Slack token", re.compile(r"\bxox[bpas]-[A-Za-z0-9-]{10,}")),
    ("an AWS access key id", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("a PEM private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("a Telegram bot token", re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b")),
]
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}")
OK_EMAIL_DOMAIN = ("example.com", "example.org", "acme.com", "noreply.anthropic.com", "users.noreply.github.com")
USERPATH = re.compile(r"/(?:Users|home)/(?!\w*(?:you|user|name|me|someone|agent)\b)[A-Za-z0-9._-]{2,}/")
LONGNUM = re.compile(r"(?<![\w.:/-])\d{9,}(?![\w.-])")

problems = []
deny = []
dl = os.environ.get("TALOS_PRIVACY_DENYLIST")
if dl:
    try:
        deny = [l.strip().lower() for l in open(os.path.expanduser(dl), encoding="utf-8") if l.strip() and not l.startswith("#")]
    except OSError as e:
        print("  FAIL cannot read TALOS_PRIVACY_DENYLIST: %s" % e); sys.exit(1)
    if os.path.realpath(os.path.expanduser(dl)).startswith(os.path.realpath(kit) + os.sep):
        print("  FAIL the denylist is INSIDE the repo; it is private and must live outside it"); sys.exit(1)

for rel in files:
    if rel == SELF or rel.startswith(".git/"):
        continue
    p = os.path.join(kit, rel)
    try:
        data = open(p, "rb").read()
    except OSError:
        continue
    if b"\0" in data[:4096]:
        continue
    text = data.decode("utf-8", "replace")
    for n, line in enumerate(text.splitlines(), 1):
        low = line.lower()
        if "fake" in low or "made-up" in low:           # test fixtures that say so
            continue
        for what, rx in SECRETS:
            if rx.search(line):
                problems.append("%s:%d looks like %s" % (rel, n, what))
        for m in EMAIL.finditer(line):
            dom = m.group(0).split("@", 1)[1].lower()
            if not dom.endswith(OK_EMAIL_DOMAIN) and dom not in ("t.t", "local"):
                problems.append("%s:%d contains an email address (%s)" % (rel, n, m.group(0)))
        if USERPATH.search(line):
            problems.append("%s:%d contains an absolute home-folder path" % (rel, n))
        for m in LONGNUM.finditer(line):
            s = m.group(0)
            if set(s) == {"0"} or "touch -t" in line or s in ("123456789", "1234567890", "987654321"):
                continue        # 0000... fake ids, `touch -t 202601010000`, and the textbook placeholder sequences
            problems.append("%s:%d contains a long bare number (%s): a chat or account id?" % (rel, n, s))
        for term in deny:
            if term and term in low:
                problems.append("%s:%d matches a denylist term (%s)" % (rel, n, term))

if problems:
    for p in problems[:40]:
        print("  FAIL " + p)
    print("  privacy: %d problem(s)%s" % (len(problems), " (denylist applied)" if deny else ""))
    sys.exit(1)
print("  ok   no secrets, personal emails, home paths or long ids in %d files%s" % (len(files), " (denylist of %d terms applied)" % len(deny) if deny else ""))
print("  privacy: PASS 1 FAIL 0")
PY
