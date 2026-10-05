#!/usr/bin/env python3
"""recall.py: hybrid memory search for the agent: lexical (always) plus semantic (when installed), fused.

    python3 scripts/recall.py "what did we decide about the vendor contract"
    python3 scripts/recall.py "vendor contract" -k 8 --expand        # + the [[links]] of each top hit
    python3 scripts/recall.py --batch "q1" "q2" "q3"                  # many queries, one process, JSON out
    python3 scripts/recall.py "..." --json

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

Single-writer caution: never fan this script out to parallel sub-agents. Gather with --batch in the main session
and paste the results into their briefs.
"""
import json
import os
import re
import sqlite3
import subprocess
import sys
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


def lexical_rank(query):
    """Files ranked by how many distinct query terms they contain, plus a bonus for a term in the name or title."""
    ws = terms(query)
    if not ws:
        return []
    score = defaultdict(float)
    for f in corpus_files():
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
        if not p:
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


def search_one(query, k, expand, sem_hits, sem_err, sem_state):
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
    results = []
    for f in fused[:k]:
        ch = chunks.get(f)
        row = {"file": os.path.relpath(f, ROOT), "via": sorted(methods[f]), "snippet": snippet(f, query),
               "links": links_of(f) if expand else None}
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
    for path, rx in ((os.path.join(ROOT, "wiki", "me.md"), r"^#\s+(.+)$"), (os.path.join(ROOT, "CLAUDE.md"), r"\*\*Name:\*\*\s*(.+)$")):
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


def run_queries(queries, k, expand):
    state, status_text = semantic_status()
    sem_by_q, sem_err = {}, None
    if state in ("live", "stale"):
        sem_by_q, sem_err = _semantic_call(queries, k)
        if sem_err is not None:
            state, status_text = "unavailable", "UNAVAILABLE: lexical only (%s)" % sem_err
    out = {}
    for q in queries:
        out[q] = search_one(q, k, expand, sem_by_q.get(q, []), sem_err, state)
    return out, state, status_text


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
    FLAGS = ("--expand", "--json", "--batch")
    expand = "--expand" in argv
    as_json = "--json" in argv
    batch = "--batch" in argv
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

    results, state, status_text = run_queries(queries, k, expand)

    if batch or as_json:
        cov = {q: coverage(q, results[q]) for q in queries}
        payload = {"semantic": state, "semantic_status": status_text, "coverage": cov}
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
    print('recall: "%s"   (semantic: %s)\n' % (q, status_text))
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
            print("      links: %s" % ", ".join("[[%s]]" % x for x in r["links"][:8]))
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
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
