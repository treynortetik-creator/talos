"""Shared helpers for the nightly dream cycle (collect / verify_quotes / apply / revert / digest / budget).

The dream cycle CONNECTS and FLAGS; it never rewrites. Only `## Related` links are ever applied automatically;
everything else goes to memory/dream/QUEUE.md for a human to decide. See setup/dream-cycle.md.

The agent folder is derived from this file's location (<agent>/scripts/dream/common.py); there is no environment
variable that can point it somewhere else. Standard library only, Python 3.9 compatible.
"""
import datetime
import hashlib
import hmac
import json
import os
import re
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
MEM = os.path.join(ROOT, "memory")
WIKI = os.path.join(ROOT, "wiki")
DREAM = os.path.join(MEM, "dream")
QUEUE = os.path.join(DREAM, "QUEUE.md")
QUEUE_ONLY = os.path.join(DREAM, "QUEUE-ONLY")
TIMELINE_MARK = "<!-- TIMELINE:APPEND-ONLY -->"

DAILY_RE = re.compile(r"^memory/\d{4}-\d{2}-\d{2}\.md$")
SKIP_BASENAMES = {"index.md", "readme.md", "claude.md", "contributing.md"}
SKIP_DIR_PARTS = {"examples", "_archive", ".git", "node_modules"}


def today():
    """The LOCAL calendar date (the machine's clock), as YYYY-MM-DD."""
    return datetime.date.today().isoformat()


def run_dir(date=None):
    return os.path.join(DREAM, date or today())


def rel(path):
    return os.path.relpath(path, ROOT).replace(os.sep, "/")


def is_personal_path(path):
    """True if ANY component of the path (or of its realpath) is 'personal'. Hard exclude, case-insensitive."""
    for p in (path, os.path.realpath(path)):
        if "personal" in re.split(r"[\\/]+", p.lower()):
            return True
    return False


def is_env_path(path):
    return os.path.basename(path).lower().startswith(".env")


def allowed_input(relpath):
    """relpath is agent-folder-relative. True only for wiki notes and memory/YYYY-MM-DD.md daily logs."""
    r = relpath.replace(os.sep, "/")
    if is_personal_path(os.path.join(ROOT, r)) or is_env_path(r):
        return False
    base = os.path.basename(r).lower()
    if DAILY_RE.match(r):
        return True
    if not r.startswith("wiki/") or not base.endswith(".md"):
        return False
    if base.startswith("_") or base in SKIP_BASENAMES:
        return False
    return not (set(r.lower().split("/")[:-1]) & SKIP_DIR_PARTS)


def kind_of(relpath):
    return "daily-log" if DAILY_RE.match(relpath.replace(os.sep, "/")) else "wiki"


# ---------- text normalisation (quote matching) ----------
_QUOTES = {"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "−": "-"}


def norm(s):
    s = unicodedata.normalize("NFKC", s or "")
    for a, b in _QUOTES.items():
        s = s.replace(a, b)
    return re.sub(r"\s+", " ", s).strip()


# ---------- personal-name filter (built from an OPTIONAL private vault; never reads vault note contents) ----------
_STOP = {"and", "the", "of", "a", "an"}
_COMMON = {"monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
           "january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
           "november", "december"}                  # a first name that is also a weekday or month: possessive form only


def vault_dir():
    """The optional private vault, from <config>/talos/vault-dir. '' when none is configured (the usual case)."""
    cfg = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "talos", "vault-dir")
    try:
        with open(cfg, encoding="utf-8") as fh:
            v = fh.readline().strip()
        v = os.path.realpath(os.path.expanduser(v)) if v else ""
        return v if v and os.path.isdir(v) else ""
    except OSError:
        return ""


def name_terms(vault=None):
    """Lower-cased terms to keep out of the model's view: the FILENAMES under <vault>/people/ plus the lines of
    <vault>/_guard-terms.txt. Nothing inside a vault note is ever opened. No vault configured -> []."""
    vault = vault_dir() if vault is None else vault
    if not vault:
        return []
    terms = set()
    try:
        names = os.listdir(os.path.join(vault, "people"))
    except OSError:
        names = []
    for fn in names:
        if not fn.endswith(".md") or fn.startswith("_") or fn.lower() in ("index.md", "readme.md"):
            continue
        for chunk in fn[:-3].split("-and-"):
            toks = [t for t in chunk.split("-") if t and t not in _STOP]
            if not toks:
                continue
            if len(toks) >= 2:
                terms.add(" ".join(toks))
            if len(toks[0]) >= 3:
                terms.add(toks[0])
    try:
        with open(os.path.join(vault, "_guard-terms.txt"), encoding="utf-8") as fh:
            for ln in fh:
                ln = ln.strip()
                if ln and not ln.startswith("#"):
                    terms.add(ln)
    except OSError:
        pass
    return sorted({t.lower() for t in terms})


def build_name_regex(terms):
    parts = []
    for t in sorted(terms, key=len, reverse=True):
        if t in _COMMON:
            parts.append(re.escape(t) + r"(?:'s|’s)")
        else:
            parts.append(re.escape(t))
    if not parts:
        return None
    return re.compile(r"(?<![A-Za-z])(?:" + "|".join(parts) + r")(?![A-Za-z])", re.I)


class NameFilter:
    def __init__(self, terms=None):
        self.terms = terms if terms is not None else name_terms()
        self.rx = build_name_regex(self.terms)

    def hits(self, line):
        if "memory/personal" in line or "personal vault" in line.lower():
            return True
        return bool(self.rx and self.rx.search(line))

    def filter_text(self, text):
        """(kept_text, dropped_line_count)."""
        kept, dropped = [], 0
        for ln in text.splitlines():
            if self.hits(ln):
                dropped += 1
            else:
                kept.append(ln)
        return "\n".join(kept), dropped


# ---------- io ----------
def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def jload(path, default=None):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def jdump(obj, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=1, ensure_ascii=False)


def wiki_slugs():
    """slug -> [paths] for every md under wiki/ (underscore files included, for link resolution)."""
    out = {}
    for root, dirs, files in os.walk(WIKI):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for fn in files:
            if fn.endswith(".md"):
                out.setdefault(fn[:-3], []).append(os.path.join(root, fn))
    return out


def changelog_add(row):
    """Insert one table row directly under the header of wiki/_changelog.md (newest first). False if there is none."""
    cl = os.path.join(WIKI, "_changelog.md")
    if not os.path.isfile(cl):
        return False
    text = read(cl)
    lines = text.split("\n")
    for i, ln in enumerate(lines):
        if re.match(r"^\|[\s:|-]+\|\s*$", ln) and "-" in ln:
            lines.insert(i + 1, row)
            write(cl, "\n".join(lines))
            return True
    write(cl, text + ("" if text.endswith("\n") or not text else "\n") + row + "\n")
    return True


# ---------- seal: proof that verified.json came out of verify_quotes.py ----------
def state_dir():
    base = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
    return os.path.join(base, "talos", "%s-%s" % (os.path.basename(ROOT) or "agent", hashlib.sha1(ROOT.encode("utf-8")).hexdigest()[:8]))


def seal_key():
    """A random per-agent key kept in the state folder, OUTSIDE the agent folder. The restricted nightly job can read
    and write only inside the agent folder, so the model cannot learn it. None when the state folder is unwritable."""
    path = os.path.join(state_dir(), "dream-seal.key")
    try:
        with open(path, "rb") as fh:
            k = fh.read().strip()
        if k:
            return k
    except OSError:
        pass
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        k = os.urandom(32).hex().encode()
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(k)
        return k
    except FileExistsError:
        return seal_key()
    except OSError:
        return None


def seal_of(run):
    """HMAC of <run>/verified.json bound to the run date; None if there is no key or no file."""
    key = seal_key()
    try:
        with open(os.path.join(run, "verified.json"), "rb") as fh:
            body = fh.read()
    except OSError:
        return None
    if not key:
        return None
    return hmac.new(key, os.path.basename(os.path.normpath(run)).encode() + b"|" + body, hashlib.sha256).hexdigest()


def write_seal(run):
    p = os.path.join(run, "verify-summary.json")
    d = jload(p, {}) or {}
    d["seal"] = seal_of(run)
    jdump(d, p)
    return d["seal"]


def seal_ok(run):
    want = (jload(os.path.join(run, "verify-summary.json"), {}) or {}).get("seal")
    got = seal_of(run)
    return bool(want and got and hmac.compare_digest(str(want), got))
