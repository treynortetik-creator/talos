#!/usr/bin/env python3
"""recall.py: hybrid memory search for the agent: lexical (always) plus semantic (when installed), fused.

    python3 scripts/recall.py "what did we decide about the vendor contract"
    python3 scripts/recall.py "vendor contract" -k 8 --expand        # + the [[links]] of each top hit
    python3 scripts/recall.py --batch "q1" "q2" "q3"                  # many queries, one process, JSON out
    python3 scripts/recall.py "..." --json
    python3 scripts/recall.py "what did we decide about X" --rerank   # force the cross-encoder rerank of the top 15 (below)
    python3 scripts/recall.py "vendor contract" --expand --hubs        # the link menu, with hub notes kept in

Standard library only, so it runs on the system python3 (3.9). Two search arms run side by side and are fused
with Reciprocal-Rank Fusion (semantic weighted a little higher for fuzzy questions), then recently edited notes
get up to a +15% nudge:

  lexical   every query term is looked for in every note under wiki/, memory/ and .learnings/ (the corpus rules
            are in scripts/memory/corpus.py); a term in the file name or title weighs more. Needs nothing.
  semantic  nearest-neighbour search over an sqlite-vec index with a local embedding model. OPT-IN: install it
            with `bash scripts/memory/setup.sh` (or ./install.sh --with-memory-search). This script calls it as a
            subprocess in its own venv, so nothing here needs a single third-party package.

When the semantic arm is not available the output SAYS WHY on its first line, and the lexical arm still answers:
    semantic: NOT INSTALLED   no venv: lexical only (enable: bash scripts/memory/setup.sh)
    semantic: NO INDEX        the venv exists, the index does not (run mem_index.py)
    semantic: INDEX STALE     searched, but notes newer than the index are not in it
    semantic: UNAVAILABLE     the subprocess failed or timed out: lexical only

A weak or empty result prints a diagnosis, because "nothing recorded" and "the search is broken" must not look
alike: a control query for a term that has to exist (the title of wiki/me.md) separates `broken` from `stale`
from `empty`. Absence is a claim about the query, not about the world.

Link menu: --expand lists, under each top hit, the notes it links to with their `type` and one-line `description` (from
frontmatter; "(no description)" when absent). Hubs (the top 1% of wiki notes by inbound links, never fewer than 30) are left
out and counted on a "skipped N hubs" line; --hubs keeps them. Inbound counts are cached in .index/wiki-inbound.json and
rebuilt when a note is newer. The ranking of the results is never touched.

Keyword arm: with ripgrep (TALOS_RG, then PATH, then /opt/homebrew/bin and /usr/local/bin) ONE rg pass finds the notes that
contain any query word, and only those are read and scored; the ranked list is identical to reading every note. Without rg
it reads every note (one stderr note). It runs in a thread while the semantic search answers.

Rerank: a cross-encoder (bge-reranker-v2-m3, int8, CPU) re-sorts the top 15 files by their best chunk. It runs by itself for
a QUESTION (ends with "?", starts with who/what/when/where/why/how/which/did/do/does/is/are/was/were/can/should, or has
decide/decided/decision in it) only when the model is installed AND .index/rerank-time.json (from `mem_rerank.py --probe`)
says one COLD rerank (a fresh worker: start, load, rerank 15, exit, which is what a plain run pays) took under 8.0 seconds. Otherwise it stays off and, once a day, one stderr line says why. --rerank
forces it on, --no-rerank off; TALOS_RECALL_RERANK=1/0 does the same, and flags beat the variable (RECALL_RERANK, the old
name, still works). The banner line says whether it ran. See scripts/memory/mem_rerank.py.

Degraded: when the semantic backend was tried and failed, or a rerank was wanted and could not run, the first AND last lines
of the text output are a WARNING (and --json gets a `degraded` object with the reason). The exit code stays 0 and the keyword
results still print. Not installed / no index is the opt-in state, not a failure.

Dream-cycle preimage copies (memory/dream/<date>/preimage/) are never indexed and never returned.

Single-writer caution: never fan this script out to parallel sub-agents. Gather with --batch in the main session
and paste the results into their briefs.
"""
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from collections import defaultdict

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, os.path.join(HERE, "memory"))
import corpus  # noqa: E402  (stdlib only)

ROOT = corpus.ROOT
INDEX_DB = os.path.join(ROOT, ".index", "memory.db")
INDEX_STAMP = os.path.join(ROOT, ".index", ".last-index-ok")    # touched by mem_index.py only on a clean finish
MEM_SEARCH = os.path.join(HERE, "memory", "mem_search.py")
RRF_K = 60
RERANK_TOP = 15            # files fed to the reranker; ranks 16+ keep their order
RERANK_INFO = {}           # last rerank status per query, surfaced on the banner line and in --json
RERANK_TIME_FILE = os.path.join(ROOT, ".index", "rerank-time.json")       # written by `mem_rerank.py --probe`
RERANK_NOTE_FILE = os.path.join(ROOT, ".index", "rerank-off-note-date")   # the day the "reranking is off" line last printed
RG_NOTE_FILE = os.path.join(ROOT, ".index", "rg-off-note-date")           # the day the "ripgrep unavailable" line last printed
RERANK_MAX_SECONDS = 8.0   # a question is reranked by default only where one measured cold rerank took less than this
W_LEXICAL, W_SEMANTIC = 1.0, 1.2
STALE_HOURS = 48
SEM_TIMEOUT = 60
STOP = {"the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are", "what", "did", "we", "about",
        "how", "why", "i", "do", "does", "with", "our", "my", "was", "were", "who", "when", "where", "which", "that",
        "this", "it", "be", "as", "at", "by", "from", "have", "has", "had", "not", "you", "your"}


def venv_python():
    base = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    return os.path.join(base, "talos", "venv", "bin", "python")


def terms(query):
    return [w for w in re.findall(r"[a-z0-9][a-z0-9\-]+", query.lower()) if w not in STOP and len(w) > 2]


# ------------------------------------------------------------------------------------------- lexical arm
_FILES = None


def corpus_files():
    global _FILES
    if _FILES is None:
        _FILES = corpus.source_files(ROOT)
    return _FILES


_TEXT = {}


def text_of(path):
    if path not in _TEXT:
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                _TEXT[path] = fh.read()
        except OSError:
            _TEXT[path] = ""
    return _TEXT[path]


# Fast arm: when ripgrep is installed, ONE `rg -l` pass over the raw notes (all query words at once, no keyword index) names
# the notes that contain at least one word; only those are read and scored. Scoring is the same loop either way, so the
# ranked list (and its tie order: -score, then path) is identical. No rg, or an rg that fails: every note is read, as before.
RG_TIMEOUT = 20
_RG_CACHE = []          # [path-or-None] once resolved
_RG_NOTED = False


def _in_claude_code_install(real):
    """True when a real path sits inside a Claude Code install: a folder named claude-code, a .claude folder, or
    node_modules/@anthropic-ai/. A user or folder that merely has 'claude' in its name is not."""
    parts = real.split(os.sep)
    return "claude-code" in parts or ".claude" in parts or any(
        a == "node_modules" and b == "@anthropic-ai" for a, b in zip(parts, parts[1:]))


def find_rg():
    """A real ripgrep binary or None. Order: $TALOS_RG (when set it is the only candidate, so a missing file there forces
    the fallback), PATH, /opt/homebrew/bin/rg, /usr/local/bin/rg. A binary bundled inside Claude Code is never used (its
    path changes with every update, and the PATH entry may be a shell function's target)."""
    if _RG_CACHE:
        return _RG_CACHE[0]
    env = os.environ.get("TALOS_RG")
    cands = [env] if env else [shutil.which("rg"), "/opt/homebrew/bin/rg", "/usr/local/bin/rg"]
    found = None
    for c in cands:
        if not c or not os.path.isfile(c) or not os.access(c, os.X_OK):
            continue
        if not env and _in_claude_code_install(os.path.realpath(c)):
            continue
        found = c
        break
    _RG_CACHE.append(found)
    return found


def once_a_day(path):
    """True when the day-stamp file at `path` is not today's, and stamps it. Fail-soft: a folder that cannot be read or
    written (read-only install) just means the line may print again, never an error."""
    today = time.strftime("%Y-%m-%d")
    try:
        with open(path) as fh:
            if fh.read().strip() == today:
                return False
    except OSError:
        pass
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            fh.write(today + "\n")
    except OSError:
        pass
    return True


QUIET_NOTES = False     # set by main() for --json / --batch: machine-read output carries no human notes


def _note_rg_fallback(why):
    """No ripgrep is a normal setup: the note prints at most once a day, on stderr, and never for --json / --batch.
    A misconfiguration (TALOS_RG set but not runnable, or an rg that fails) is a fault, so it says so on every run
    (once per process)."""
    global _RG_NOTED
    if _RG_NOTED or QUIET_NOTES:
        return
    _RG_NOTED = True
    broken = bool(os.environ.get("TALOS_RG")) or not why.startswith("RuntimeError: no rg binary")
    if broken or once_a_day(RG_NOTE_FILE):
        print("recall: ripgrep unavailable (%s); using the slower note-by-note keyword search" % why, file=sys.stderr)


def _rg_candidates(ws):
    """Set of corpus files that contain at least one of the words (rg: fixed strings, case-insensitive). Raises on any rg
    problem, so the caller falls back. rg only narrows the notes that are read; it never decides a score."""
    rg = find_rg()
    if not rg:
        raise RuntimeError("no rg binary")
    roots = [os.path.join(ROOT, d) for d in corpus.corpus_dirs(ROOT) if os.path.isdir(os.path.join(ROOT, d))]
    if not roots:
        return set()
    cmd = [rg, "-l", "-i", "-F", "-a", "--no-config", "--no-messages", "--hidden", "--no-ignore", "--iglob", "*.md"]
    for w in dict.fromkeys(ws):
        cmd += ["-e", w]
    r = subprocess.run(cmd + ["--"] + roots, capture_output=True, text=True, timeout=RG_TIMEOUT, stdin=subprocess.DEVNULL)
    if r.returncode not in (0, 1):
        raise RuntimeError("rg exit %s" % r.returncode)
    found = set(f for f in r.stdout.splitlines() if f)
    if found and not any(f.startswith(os.path.join(ROOT, "")) for f in found):
        raise RuntimeError("rg printed paths outside the agent folder")      # a path-spelling mismatch must not read as 'no match'
    return found


def lexical_rank(query):
    """Files ranked by how many distinct query terms they contain, plus a bonus for a term in the name or title."""
    ws = terms(query)
    if not ws:
        return []
    files = corpus_files()
    try:
        cand = _rg_candidates(ws)
        files = [f for f in files if f in cand]
    except Exception as e:  # noqa: BLE001  any rg trouble: read every note, as before
        _note_rg_fallback("%s: %s" % (type(e).__name__, e))
    score = defaultdict(float)
    for f in files:
        low = text_of(f).lower()
        if not low:
            continue
        name = os.path.basename(f).lower()
        title = ""
        m = re.search(r"^title:\s*(.+)$", low, re.M)
        if m:
            title = m.group(1)
        for w in ws:
            if w in low:
                score[f] += 1.0
                if w in name or w in title:
                    score[f] += 1.5
    return sorted(score, key=lambda f: (-score[f], f))


# ------------------------------------------------------------------------------------------ semantic arm
def index_chunk_count():
    """Rows in the index's plain `chunks` table, read with the stdlib (only the vector table needs the extension).
    Returns None when it cannot be read. NOTE: not opened mode=ro on purpose: the index is a WAL database, and a
    read-only connection to a cleanly closed WAL database cannot create the -shm file it needs, so it fails with
    "unable to open database file" exactly when the index is healthy and idle."""
    if not os.path.exists(INDEX_DB):
        return 0
    try:
        con = sqlite3.connect(INDEX_DB, timeout=5)
        try:
            return con.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        finally:
            con.close()
    except Exception:
        return None


def index_age_hours():
    """Hours since the last CLEAN index run. The stamp, not the db file: a run with nothing to do writes nothing."""
    p = INDEX_STAMP if os.path.exists(INDEX_STAMP) else INDEX_DB
    return (time.time() - os.path.getmtime(p)) / 3600.0


def semantic_status():
    """-> (state, human text). state: live | not-installed | no-index | stale."""
    py = venv_python()
    # the venv is shared (voice uses it too): its python existing does not mean the memory packages are in it
    if not os.path.exists(py) or not os.path.exists(os.path.join(os.path.dirname(os.path.dirname(py)), ".talos-memory-ok")):
        return "not-installed", "NOT INSTALLED: lexical only (enable: bash scripts/memory/setup.sh)"
    n = index_chunk_count()
    if n is None:                    # unreadable here: trust a clean-finish stamp and let the real search decide
        n = 1 if os.path.exists(INDEX_STAMP) else 0
    if n <= 0:
        return "no-index", "NO INDEX: lexical only (run: %s %s)" % (py, os.path.join(HERE, "memory", "mem_index.py"))
    age_h = index_age_hours()
    if age_h > STALE_HOURS:
        return "stale", "INDEX STALE: written %.0fh ago, newer notes are not searchable semantically" % age_h
    return "live", "live"


def _semantic_call(queries, k):
    """Run mem_search once for all queries. -> ({query: [hits]}, error-or-None)."""
    try:
        r = subprocess.run([venv_python(), MEM_SEARCH, "--stdin-queries", "--top-k", str(max(k * 3, 30))],
                           input=json.dumps(queries), capture_output=True, text=True, timeout=SEM_TIMEOUT)
        if r.returncode != 0 or not r.stdout.strip():
            return {}, "exit %s" % r.returncode
        d = json.loads(r.stdout)
        if d.get("error"):
            return {}, d["error"]
        return d.get("batch") or {}, None
    except subprocess.TimeoutExpired:
        return {}, "timed out after %ds" % SEM_TIMEOUT
    except Exception as e:  # noqa: BLE001  fail soft: lexical still answers
        return {}, type(e).__name__


def semantic_rank(hits):
    """Unique source files in rank order from chunk hits, plus the winning chunk per file."""
    seen, order, chunks = set(), [], {}
    for h in hits:
        p = h.get("path")
        if not p or corpus.is_index_excluded(p):
            continue
        full = os.path.join(ROOT, p)
        if p not in seen:
            seen.add(p)
            order.append(full)
            chunks[full] = {"heading": h.get("heading", ""), "score": h.get("score"),
                          "text": (h.get("snippet") or "").strip()}
    return order, chunks


# ---------------------------------------------------------------------------------------------- fusion
def rrf(lists):
    score, methods = defaultdict(float), defaultdict(set)
    for lst, weight, name in lists:
        for rank, f in enumerate(lst):
            score[f] += weight * (1.0 / (RRF_K + rank))
            methods[f].add(name)
    return score, methods


def snippet(path, query, n=140):
    ws = terms(query)
    for line in text_of(path).splitlines():
        s = line.strip()
        if re.match(r"^(title|type|tags|created|updated|source|status|stale_after|---)", s):
            continue
        if len(s) > 15 and any(w in s.lower() for w in ws):
            return s[:n]
    return ""


def line_of(path, chunk_text, probe=40):
    needle = " ".join((chunk_text or "").split())[:probe]
    if not needle:
        return None
    for i, line in enumerate(text_of(path).splitlines(), 1):
        if needle in " ".join(line.split()):
            return i
    return None


def links_of(path):
    return sorted(set(re.findall(r"\[\[([^\]|#]+)", text_of(path))))


# --------------------------------------------------------------------------------------- link menu (--expand)
# --expand lists, for each top hit, the notes it links to: name, type and a one-line description from their frontmatter.
# A hub (a note that very many notes link to: the top 1% by inbound links, never fewer than HUB_FLOOR) tells you nothing
# about the hit, so it is left out and counted ("skipped N hubs"); --hubs keeps them. Computed AFTER ranking from plain
# file reads: it cannot change a score or an order.
INBOUND_CACHE = os.path.join(ROOT, ".index", "wiki-inbound.json")
HUB_PCTL = 0.01
HUB_FLOOR = 30
MENU_MAX = 12
DESC_MAX = 110
INCLUDE_HUBS = False        # --hubs
_LINK_RE = re.compile(r"\[\[([^\]]+)\]\]")
_MENU = {}                  # per-process copy of the inbound index


def link_slug(raw):
    """[[slug]] / [[slug|Shown]] / [[dir/slug]] / [[slug#heading]] / [[slug.md]] -> lowercase slug."""
    t = os.path.basename(raw.split("|")[0].split("#")[0].strip()).lower()
    return t[:-3] if t.endswith(".md") else t


def hub_threshold(counts, n_notes):
    """The inbound count at the top HUB_PCTL position over ALL wiki notes (zeros included), but never below HUB_FLOOR."""
    allv = sorted(list(counts.values()) + [0] * max(0, n_notes - len(counts)), reverse=True)
    if not allv:
        return HUB_FLOOR
    return max(HUB_FLOOR, allv[min(len(allv) - 1, int(len(allv) * HUB_PCTL))])


def _wiki_notes():
    """{slug: path relative to the agent folder} for every searchable note under the wiki folder (the layout resolver's)."""
    wiki = os.path.realpath(corpus.WIKI)
    out = {}
    for f in corpus_files():
        if os.path.realpath(f).startswith(wiki + os.sep):
            out.setdefault(os.path.splitext(os.path.basename(f))[0].lower(), os.path.relpath(f, ROOT).replace(os.sep, "/"))
    return out


def build_inbound(paths):
    """slug -> inbound count: the number of DISTINCT other notes that link to it."""
    inb = defaultdict(set)
    for slug, rel in paths.items():
        for raw in _LINK_RE.findall(text_of(os.path.join(ROOT, rel))):
            t = link_slug(raw)
            if t in paths and t != slug:
                inb[t].add(slug)
    counts = dict((s, len(v)) for s, v in inb.items())
    return {"built": time.time(), "paths": paths, "counts": counts, "threshold": hub_threshold(counts, len(paths))}


def load_inbound():
    """The inbound-link index, from .index/wiki-inbound.json while no wiki note is newer than it (and none was added or
    removed), else rebuilt and saved. The cache is only a speed-up: a read or write failure just rebuilds."""
    if "idx" in _MENU:
        return _MENU["idx"]
    paths = _wiki_notes()
    newest = 0.0
    for rel in paths.values():
        try:
            newest = max(newest, os.path.getmtime(os.path.join(ROOT, rel)))
        except OSError:
            pass
    idx = None
    try:
        with open(INBOUND_CACHE) as fh:
            idx = json.load(fh)
        if idx.get("built", 0) < newest or idx.get("paths") != paths:
            idx = None
    except Exception:  # noqa: BLE001
        idx = None
    if idx is None:
        idx = build_inbound(paths)
        try:
            os.makedirs(os.path.dirname(INBOUND_CACHE), exist_ok=True)
            tmp = "%s.%d.tmp" % (INBOUND_CACHE, os.getpid())
            with open(tmp, "w") as fh:
                json.dump(idx, fh)
            os.replace(tmp, INBOUND_CACHE)
        except OSError:
            pass
    _MENU["idx"] = idx
    return idx


def note_card(path):
    """(type, one-line description) from a note's frontmatter; ("", "") when it has none."""
    typ = desc = ""
    m = re.match(r"^---\s*\n(.*?)\n---\s*(\n|$)", text_of(path)[:6000], re.S)
    if m:
        t = re.search(r"(?m)^type:[ \t]*(.*?)\s*$", m.group(1))
        d = re.search(r"(?m)^description:[ \t]*(.*?)\s*$", m.group(1))
        typ = t.group(1).strip("\"' ") if t else ""
        desc = d.group(1).strip("\"' ") if d else ""
    desc = _LINK_RE.sub(lambda mm: link_slug(mm.group(1)), desc)       # show names, not raw [[ ]]
    return typ, " ".join(desc.split())


def link_menu(path, include_hubs=None):
    """-> {"links": [{slug, path, type, description, inbound, hub}], "hubs_skipped": [{slug, inbound}], "unresolved": [raw]}.
    In order of first appearance, one entry per linked note; the note's own name is skipped."""
    idx = load_inbound()
    include_hubs = INCLUDE_HUBS if include_hubs is None else include_hubs
    me = os.path.splitext(os.path.basename(path))[0].lower()
    links, hubs, unresolved, seen = [], [], [], set()
    for raw in _LINK_RE.findall(text_of(path)):
        slug = link_slug(raw)
        if not slug or slug == me or slug in seen:
            continue
        seen.add(slug)
        rel = idx["paths"].get(slug)
        if not rel:
            unresolved.append(raw.split("|")[0].split("#")[0].strip())
            continue
        n = idx["counts"].get(slug, 0)
        is_hub = n >= idx["threshold"]
        if is_hub and not include_hubs:
            hubs.append({"slug": slug, "inbound": n})
            continue
        typ, desc = note_card(os.path.join(ROOT, rel))
        links.append({"slug": slug, "path": rel, "type": typ, "description": desc, "inbound": n, "hub": is_hub})
    hubs.sort(key=lambda h: -h["inbound"])
    return {"links": links, "hubs_skipped": hubs, "unresolved": unresolved}


def format_menu(menu, cap=MENU_MAX):
    """The menu as text lines (no indent)."""
    out = []
    for e in menu["links"][:cap]:
        d = e["description"]
        d = d if len(d) <= DESC_MAX else d[:DESC_MAX - 3].rstrip() + "..."
        out.append("%s (%s)%s -- %s" % (e["slug"], e["type"] or "?", "  [hub]" if e["hub"] else "", d or "(no description)"))
    if len(menu["links"]) > cap:
        out.append("(+%d more)" % (len(menu["links"]) - cap))
    if menu["unresolved"]:
        u = menu["unresolved"]
        out.append("unresolved: " + ", ".join(u[:8]) + (" (+%d more)" % (len(u) - 8) if len(u) > 8 else ""))
    if menu["hubs_skipped"]:
        h = menu["hubs_skipped"]
        out.append("skipped %d hubs: " % len(h) + ", ".join("%s (in %d)" % (x["slug"], x["inbound"]) for x in h[:8])
                   + (" (+%d more)" % (len(h) - 8) if len(h) > 8 else ""))
    return out


# ------------------------------------------------------------------------------------ rerank: when it runs by itself
QUESTION_WORDS = frozenset("who what when where why how which did do does is are was were can should".split())
DECISION_WORDS = frozenset(("decide", "decided", "decision"))


def is_question_shaped(query):
    """True when the query ends with '?', starts with a question word, or has decide/decided/decision as a word. Dumb on
    purpose, so it is easy to predict: a name, a ticket key or a two-word topic stays False."""
    q = (query or "").strip()
    if q.endswith("?"):
        return True
    toks = [t.strip("\"'`()[]{}<>,.;:!?") for t in q.lower().split()]
    toks = [t for t in toks if t]
    return bool(toks) and (toks[0] in QUESTION_WORDS or any(t in DECISION_WORDS for t in toks))


def rerank_force(argv, environ=None):
    """(on, source) when the caller forced it, else None. --no-rerank beats --rerank; flags beat the environment.
    TALOS_RECALL_RERANK is the variable; RECALL_RERANK (the older name) still works when it is not set."""
    environ = os.environ if environ is None else environ
    if "--no-rerank" in argv:
        return (False, "--no-rerank")
    if "--rerank" in argv:
        return (True, "--rerank")
    for var in ("TALOS_RECALL_RERANK", "RECALL_RERANK"):
        v = str(environ.get(var, "")).strip().lower()
        if v in ("1", "true", "yes", "on"):
            return (True, "%s=1" % var)
        if v in ("0", "false", "no", "off"):
            return (False, "%s=0" % var)
    return None


def probe_seconds():
    """Seconds one COLD rerank took here (a fresh worker: start, load the models, rerank 15, exit: what a plain recall.py
    run pays), from .index/rerank-time.json as written by `mem_rerank.py --probe`. None when the file is missing, unreadable,
    or has no cold_seconds (an older install: only a warm time, which says nothing about the cold start)."""
    try:
        with open(RERANK_TIME_FILE) as fh:
            v = float(json.load(fh)["cold_seconds"])
    except Exception:  # noqa: BLE001
        return None
    return v if 0 <= v < float("inf") else None


def rerank_gate():
    """-> (ok, reason): may a question be reranked by default on this computer? reason is the text for the 'off' line."""
    try:
        import mem_rerank
        have = mem_rerank.installed()
    except Exception:  # noqa: BLE001
        have = False
    if not have:
        return False, "model not installed"
    secs = probe_seconds()
    if secs is None:
        return False, "no timing yet"
    if not secs < RERANK_MAX_SECONDS:
        return False, "it took %.1f s" % secs
    return True, "measured %.1f s" % secs


def rerank_decision(query, force, sem_state, gate):
    """-> {"on", "mode": forced|auto, "why", "off_note"}. off_note is the reason to tell the owner (auto mode only)."""
    if force is not None:
        return {"on": force[0], "mode": "forced", "why": "forced %s by %s" % ("on" if force[0] else "off", force[1]), "off_note": None}
    if not is_question_shaped(query):
        return {"on": False, "mode": "auto", "why": "auto: not a question", "off_note": None}
    if not gate[0]:
        return {"on": False, "mode": "auto", "why": "auto: off (%s)" % gate[1], "off_note": gate[1]}
    if sem_state not in ("live", "stale"):
        return {"on": False, "mode": "auto", "why": "auto: needs the semantic search stack", "off_note": None}
    return {"on": True, "mode": "auto", "why": "auto: a question, and a cold rerank took %s here" % gate[1].replace("measured ", ""), "off_note": None}


def note_rerank_off(reason):
    """Once a day, on stderr: reranking is not running by itself on this computer, and why."""
    if once_a_day(RERANK_NOTE_FILE):
        print("reranking is off on this computer (%s); use --rerank to force it" % reason, file=sys.stderr)


def _rerank(query, fused, methods, sem_state):
    """Cross-encoder re-sort of the top RERANK_TOP files. Fail soft: any problem leaves the order alone, and info["error"]
    says why (that is what the degraded warning prints). Nothing to reorder is not an error."""
    info = {"applied": False}
    RERANK_INFO[query] = info
    if len(fused) < 2:
        info["why"] = "fewer than two results"
        return fused
    if sem_state not in ("live", "stale"):
        info["why"] = "needs the semantic search stack (bash scripts/memory/setup.sh)"
        info["error"] = info["why"]
        return fused
    t0 = time.time()
    try:
        sys.path.insert(0, os.path.join(HERE, "memory"))
        import mem_rerank
        if not mem_rerank.installed():
            info["why"] = "the reranker model is not downloaded (bash scripts/memory/setup.sh --rerank)"
            info["error"] = info["why"]
            return fused
        head = fused[:RERANK_TOP]
        new, sc = mem_rerank.rerank(query, head)
        if sc is None:
            info["error"] = mem_rerank.LAST_ERROR or "the reranker did not run"
            info["why"] = "the reranker failed (%s); normal order" % info["error"]
            return fused
        before = {f: i for i, f in enumerate(head, 1)}
        for f in new:
            methods[f].add("rerank")
        info.update(applied=True, n=len(head), moved=sum(before[f] != i for i, f in enumerate(new, 1)), seconds=round(time.time() - t0, 1))
        return new + fused[RERANK_TOP:]
    except Exception as e:  # noqa: BLE001
        info["error"] = "%s: %s" % (type(e).__name__, e)
        info["why"] = info["error"]
        return fused


def search_one(query, k, expand, sem_hits, sem_err, sem_state, rerank=False, lex=None):
    if lex is None:
        lex = lexical_rank(query)
    sem, chunks = ([], {})
    if sem_state in ("live", "stale") and sem_err is None:
        sem, chunks = semantic_rank(sem_hits)
    score, methods = rrf([(lex, W_LEXICAL, "lexical"), (sem, W_SEMANTIC, "semantic")])
    now = time.time()
    for f in score:     # recency nudge: up to +15% for a note edited today, fading to nothing at 180 days.
        # Absolute age, not "newest of the matches": two notes written a second apart must not get a 15% gap.
        try:
            age_days = max(0.0, (now - os.path.getmtime(f)) / 86400.0)
        except OSError:
            age_days = 180.0
        score[f] *= 1.0 + 0.15 * max(0.0, 1.0 - age_days / 180.0)
    fused = sorted(score, key=lambda f: (-score[f], f))
    if rerank:
        fused = _rerank(query, fused, methods, sem_state)
    results = []
    for f in fused[:k]:
        ch = chunks.get(f)
        row = {"file": os.path.relpath(f, ROOT), "via": sorted(methods[f]), "snippet": snippet(f, query),
               "links": links_of(f) if expand else None}
        if expand:
            row["link_menu"] = link_menu(f)
        if ch:
            row.update(heading=ch["heading"], chunk=ch["text"][:400], chunk_score=ch["score"], line=line_of(f, ch["text"]))
        results.append(row)
    return results


# --------------------------------------------------------------------------- coverage and diagnosis
def coverage(query, results):
    """Describes what came back (never reorders it): corroboration drives confidence."""
    qterms = set(terms(query))
    if not results:
        return {"confidence": "none", "unmatched_terms": sorted(qterms),
                "gaps": ["Nothing matched. Absence here is a claim about the query and the index, NOT about the "
                         "world: re-query before concluding it is not recorded."]}
    covered = set()
    for r in results:
        blob = " ".join(str(r.get(x) or "") for x in ("file", "heading", "chunk", "snippet")).lower()
        covered |= {t for t in qterms if t in blob}
    missing = sorted(qterms - covered)
    both = sum(1 for r in results if len(r.get("via") or []) > 1)
    sem_backed = sum(1 for r in results if "semantic" in (r.get("via") or []))
    gaps, notes = [], []
    if missing and len(missing) > len(qterms) * 0.6:
        gaps.append("Most query terms appear nowhere in the results (%s): the match is fuzzy, so confirm it answers "
                    "the question." % ", ".join(missing[:6]))
    if sem_backed == 0:
        gaps.append("Semantic search contributed nothing; this is a keyword match only.")
    elif both == 0:
        gaps.append("No result was found by BOTH arms; single-arm hits are weaker evidence.")
    top = results[0]
    if top.get("chunk_score") is not None and top["chunk_score"] < 0.5:
        gaps.append("Weak top score (%.2f): treat as a lead, not an answer." % top["chunk_score"])
    old = [r["file"] for r in results[:3] if os.path.exists(os.path.join(ROOT, r["file"]))
           and (time.time() - os.path.getmtime(os.path.join(ROOT, r["file"]))) > 90 * 86400]
    if old:
        notes.append("Top hits older than 90 days: " + ", ".join(old))
    conf = "high" if both >= 2 else ("low" if both == 0 else "medium")
    return {"confidence": conf, "gaps": gaps, "notes": notes, "unmatched_terms": missing,
            "corroborated_hits": both, "semantic_hits": sem_backed}


def control_term():
    """A term that MUST exist in a non-empty corpus: the H1 of wiki/me.md, else the familiar's name from CLAUDE.md."""
    for path, rx in ((os.path.join(corpus.WIKI, "me.md"), r"^#\s+(.+)$"), (os.path.join(ROOT, "CLAUDE.md"), r"\*\*Name:\*\*\s*(.+)$")):
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                m = re.search(rx, fh.read(), re.M)
            if m:
                ts = terms(m.group(1))
                if ts:
                    return ts[0]
        except OSError:
            pass
    return "index"


def diagnose_empty(sem_state):
    """Run only on an empty or weak answer. -> (verdict, lines). verdict: broken | stale | empty."""
    files = corpus_files()
    if not files:
        return "broken", ["the corpus is EMPTY: no markdown under wiki/, memory/ or .learnings/ (excluding examples).",
                          "there is nothing to search yet; that is not evidence of absence."]
    ct = control_term()
    if not lexical_rank(ct):
        return "broken", ['positive control "%s" ALSO matched nothing.' % ct,
                          "the search path is degraded: do NOT report this as 'nothing recorded'."]
    lines = ['positive control "%s" matched: the lexical search path works.' % ct]
    if sem_state == "stale":
        return "stale", lines + ["the semantic index is more than %dh old: recent notes are not in it. Refresh: "
                                 "%s %s" % (STALE_HOURS, venv_python(), os.path.join(HERE, "memory", "mem_index.py"))]
    return "empty", lines


BANNERS = {"broken": "SEARCH DEGRADED -- this is NOT evidence of absence",
           "stale": "INDEX STALE -- recent material is not searchable semantically yet"}


SEM_WARNING = ("WARNING: MEANING SEARCH IS DOWN. These results come from keyword search only and can miss notes "
               "that use other words. Reason: %s. Diagnose: %s")
RR_WARNING = "NOTE: RERANKER DID NOT RUN (%s). Results are in normal order, not reranked. Reason: %s. Diagnose: %s"


def degraded_info(state, sem_err, decision, rr_info):
    """-> None when healthy, else {"semantic": {...}, "rerank": {...}} with only the parts that failed. A semantic search that
    is simply not set up (not installed, no index) is the opt-in state, not a failure; one that was tried and failed is.
    A rerank that was wanted (forced, or by default) and did not run is; one with nothing to reorder is not."""
    d = {}
    if state == "unavailable":
        d["semantic"] = {"reason": sem_err or "unknown",
                         "diagnose": "%s %s --top-k 3 test" % (venv_python(), MEM_SEARCH)}
    if decision.get("on") and rr_info.get("applied") is False and rr_info.get("error"):
        d["rerank"] = {"requested": decision["why"], "reason": rr_info["error"],
                       "diagnose": "bash scripts/memory/setup.sh --rerank   (and: %s %s --probe <agent folder> --force)"
                                   % (venv_python(), os.path.join(HERE, "memory", "mem_rerank.py"))}
    return d or None


def degraded_lines(deg):
    out = []
    if deg and "semantic" in deg:
        out.append(SEM_WARNING % (deg["semantic"]["reason"], deg["semantic"]["diagnose"]))
    if deg and "rerank" in deg:
        x = deg["rerank"]
        out.append(RR_WARNING % (x["requested"], x["reason"], x["diagnose"]))
    return out


def merge_degraded(per_query):
    """{query: degraded-or-None} -> one object: the first reason per part, plus the queries it hit."""
    agg = {}
    for q, d in per_query.items():
        for part, x in (d or {}).items():
            agg.setdefault(part, dict(x, queries=[]))["queries"].append(q)
    return agg or None


def run_queries(queries, k, expand, force=None):
    """-> (results per query, semantic state, status text, extra) where extra = {"decisions", "degraded"}.
    The keyword arm runs in a thread while the semantic subprocess answers; the thread opens nothing the other side uses."""
    lex_by_q, lex_err = {}, []

    def _lex():
        try:
            for q in queries:
                lex_by_q[q] = lexical_rank(q)
        except Exception as e:  # noqa: BLE001  re-raised below, on the main thread
            lex_err.append(e)

    th = threading.Thread(target=_lex, daemon=True)
    th.start()
    state, status_text = semantic_status()
    sem_by_q, sem_err = {}, None
    if state in ("live", "stale"):
        sem_by_q, sem_err = _semantic_call(queries, k)
        if sem_err is not None:
            state, status_text = "unavailable", "UNAVAILABLE: lexical only (%s)" % sem_err
    th.join()
    if lex_err:
        raise lex_err[0]
    gate = rerank_gate() if any(force is None and is_question_shaped(q) for q in queries) else (False, "")
    decisions, degraded, off_notes = {}, {}, []
    out = {}
    for q in queries:
        dec = rerank_decision(q, force, state, gate)
        decisions[q] = dec
        if dec["off_note"]:
            off_notes.append(dec["off_note"])
        out[q] = search_one(q, k, expand, sem_by_q.get(q, []), sem_err, state, dec["on"], lex_by_q.get(q))
        degraded[q] = degraded_info(state, sem_err, dec, RERANK_INFO.get(q, {}) if dec["on"] else {})
    if off_notes:
        note_rerank_off(off_notes[0])
    return out, state, status_text, {"decisions": decisions, "degraded": degraded}


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if argv else 2
    k = 8
    argv = list(argv)
    if "-k" in argv:
        i = argv.index("-k")
        try:
            k = int(argv[i + 1])
            if k < 1:
                raise ValueError
        except (IndexError, ValueError):
            print("recall: -k needs a positive number, e.g. -k 8", file=sys.stderr)
            return 2
        del argv[i:i + 2]
    global INCLUDE_HUBS
    FLAGS = ("--expand", "--json", "--batch", "--rerank", "--no-rerank", "--hubs")
    force = rerank_force(argv)
    INCLUDE_HUBS = "--hubs" in argv
    expand = "--expand" in argv
    as_json = "--json" in argv
    batch = "--batch" in argv
    global QUIET_NOTES
    QUIET_NOTES = as_json or batch
    # only the known flags are flags: a query word that starts with "-" ("-5 degrees", "--legacy") is part of the query
    positional = [a for a in argv if a not in FLAGS]
    if batch:
        queries = positional
    else:
        queries = [" ".join(positional)]
    queries = [q for q in queries if q.strip()]
    if not queries:
        print('usage: recall.py "<query>" [-k N] [--expand] [--json]  |  recall.py --batch "q1" "q2" ...', file=sys.stderr)
        return 2

    results, state, status_text, extra = run_queries(queries, k, expand, force)
    decisions, per_q_degraded = extra["decisions"], extra["degraded"]
    deg = merge_degraded(per_q_degraded)
    rerank = any(d["on"] for d in decisions.values())
    if rerank:
        try:
            import mem_rerank
            mem_rerank.close()
        except Exception:
            pass

    if batch or as_json:
        cov = {q: coverage(q, results[q]) for q in queries}
        payload = {"semantic": state, "semantic_status": status_text, "coverage": cov}
        if rerank:
            payload["rerank"] = {q: RERANK_INFO.get(q, {"applied": False}) if decisions[q]["on"] else {"applied": False} for q in queries}
        if deg:
            payload["degraded"] = deg
        zero = [q for q in queries if not results[q]]
        if zero:
            verdict, why = diagnose_empty(state)
            payload["empty_verdict"] = {"verdict": verdict, "why": why, "queries": zero}
        if batch:
            payload["batch"] = results
        else:
            payload.update(query=queries[0], results=results[queries[0]])
        print(json.dumps(payload, indent=2))
        return 0

    q = queries[0]
    res = results[q]
    rr_txt = ""
    warn = degraded_lines(deg)
    for line in warn:
        print(line)
    if decisions[q]["on"]:
        rr = RERANK_INFO.get(q, {})
        rr_txt = ("   (rerank: applied to the top %s, %s moved, %ss)" % (rr.get("n"), rr.get("moved"), rr.get("seconds"))
                  if rr.get("applied") else "   (rerank: requested but NOT applied: %s)" % rr.get("why", "unavailable"))
    print('recall: "%s"   (semantic: %s)%s\n' % (q, status_text, rr_txt))
    for i, r in enumerate(res, 1):
        print("%d. [%-16s] %s" % (i, "+".join(r["via"]), r["file"]))
        if r.get("heading") or r.get("line"):
            loc = ":%s" % r["line"] if r.get("line") else ""
            print("      @ %s%s%s" % (r["file"], loc, ("  (%s)" % r["heading"]) if r.get("heading") else ""))
        if r.get("chunk"):
            print("      > %s" % " ".join(r["chunk"].split())[:220])
        elif r["snippet"]:
            print("      > %s" % r["snippet"])
        if expand and r["links"]:
            print("      links:")
            for line in format_menu(r["link_menu"]):
                print("        %s" % line)
    cov = coverage(q, res)
    if (not res) or cov.get("confidence") in ("none", "low"):
        verdict, why = diagnose_empty(state)
        if verdict == "empty":
            banner = "NO RESULTS -- search verified working, nothing matched" if not res else \
                "WEAK MATCH -- search verified working, but nothing scored well"
        else:
            banner = BANNERS[verdict]
        print("\n%s" % banner)
        for line in why:
            print("    %s" % line)
        if verdict == "empty":
            print("    Absence is a claim about the QUERY, not the world: try other phrasings before concluding it is not recorded.")
        else:
            print("    Do not tell the user 'nothing recorded'. Say the search is degraded and name the cause above.")
    if cov["gaps"] or cov.get("notes"):
        print("\n  confidence: %s" % cov["confidence"])
        for g in cov["gaps"]:
            print("      gap: %s" % g)
        for n in cov.get("notes", []):
            print("      note: %s" % n)
    if warn:
        print()
        for line in warn:
            print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
