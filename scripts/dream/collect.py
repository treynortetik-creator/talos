#!/usr/bin/env python3
"""dream/collect.py: step 1 of the nightly dream cycle. NO LLM.

Gathers wiki notes (wiki/**/*.md) and daily logs (memory/YYYY-MM-DD.md) changed in the last N days (git when the
agent folder is its own git repo, file modification times otherwise). HARD EXCLUDES any path with a 'personal'
component and any .env file. Daily-log lines pass a personal-name filter built from an OPTIONAL private vault
(file NAMES under <vault>/people/ and the lines of <vault>/_guard-terms.txt; vault note contents are never read).
No vault configured means an empty filter.

Caps at --max-notes (default 12: one session does all the reading), ranked by recency x link-poverty, in shards
of at most 4 notes. Adds no-LLM hints: Adamic-Adar missing-link candidates, wiki-lint hits for the changed notes,
and neighbour excerpts from ONE `scripts/recall.py --batch` call (lexical-only is fine; the degradation is
recorded in collect.json "errors").

Output: memory/dream/<date>/collect.json and shards/shard-NN.json. Works with no arguments (last day, today).

  python3 scripts/dream/collect.py
  python3 scripts/dream/collect.py --days 7 --max-notes 20 --no-recall
"""
import argparse
import datetime
import json
import math
import os
import re
import subprocess
import sys
import time
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

NOTE_CHARS = {"wiki": 6000, "daily-log": 5000}
EXCERPT_CHARS = 420
MAX_SHARD = 4
LINK_RE = re.compile(r"\[\[([^\]]+)\]\]")
FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.S)
STALE_OUTPUTS = ("verified.json", "dropped.json", "verify-summary.json", "judged.json", "run.json", "digest.txt")


def git(*args, timeout=60):
    try:
        r = subprocess.run(["git", "-C", C.ROOT, "-c", "core.quotepath=off"] + list(args),
                           capture_output=True, text=True, timeout=timeout)
        return r.stdout if r.returncode == 0 else ""
    except Exception:
        return ""


def git_is_own_repo():
    try:
        r = subprocess.run(["git", "-C", C.ROOT, "rev-parse", "--show-prefix"], capture_output=True, text=True, timeout=20)
        return r.returncode == 0 and r.stdout.strip() == ""
    except Exception:
        return False


def changed_paths(days):
    """agent-relative path -> epoch of last change, from git (if any) plus modification times."""
    found = {}
    cutoff = time.time() - days * 86400
    if git_is_own_repo():
        ts = 0
        out = git("log", "--since=%s days ago" % days, "--name-only", "--pretty=format:@@%ct", "--",
                  "wiki", "memory")
        for ln in out.splitlines():
            if ln.startswith("@@"):
                ts = int(ln[2:] or 0)
            elif ln.strip():
                found[ln.strip()] = max(found.get(ln.strip(), 0), ts)
        for ln in git("status", "--porcelain", "--untracked-files=all", "--", "wiki", "memory").splitlines():
            p = ln[3:].strip().strip('"')
            if " -> " in p:
                p = p.split(" -> ")[-1]
            if p:
                found.setdefault(p, 0)
    # mtime scan: also the only source outside git. 'personal' folders are walked for mtimes only so they can be
    # COUNTED and rejected; nothing in them is ever read.
    for top in ("wiki", "memory"):
        for dp, dn, fns in os.walk(os.path.join(C.ROOT, top)):
            dn[:] = [d for d in dn if not d.startswith(".") and d not in ("dream", "briefs")]
            for fn in fns:
                full = os.path.join(dp, fn)
                try:
                    m = os.path.getmtime(full)
                except OSError:
                    continue
                if m >= cutoff:
                    r = C.rel(full)
                    found[r] = max(found.get(r, 0), int(m))
    return found


def parse_note(path):
    txt = C.read(path)
    slug = os.path.splitext(os.path.basename(path))[0]
    links = {os.path.basename(l.split("|")[0].split("#")[0].strip()).lower() for l in LINK_RE.findall(txt) if l.strip()}
    return slug.lower(), {"slug": slug, "links": links}


def load_graph():
    """Adamic-Adar inputs: nodes (slug_lower -> {slug, links}) and an undirected adjacency over the wiki."""
    nodes = {}
    for root, dirs, files in os.walk(C.WIKI):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d.lower() not in C.SKIP_DIR_PARTS and d.lower() != "personal"]
        for fn in files:
            if fn.endswith(".md") and not fn.startswith("_") and fn.lower() not in C.SKIP_BASENAMES:
                s, d = parse_note(os.path.join(root, fn))
                nodes[s] = d
    adj = {s: set() for s in nodes}
    for s, d in nodes.items():
        for lk in d["links"]:
            if lk in nodes and lk != s:
                adj[s].add(lk)
                adj[lk].add(s)
    return nodes, adj


def adamic_adar(nodes, adj):
    """Unlinked pairs that share neighbours, scored by sum of 1/log(degree of the shared neighbour)."""
    score = defaultdict(float)
    for v in nodes:
        nb = sorted(adj[v])
        if len(nb) < 2:
            continue
        w = 1.0 / math.log(max(len(nb), 2))
        for i in range(len(nb)):
            for j in range(i + 1, len(nb)):
                a, b = nb[i], nb[j]
                if b not in adj[a]:
                    score[(a, b)] += w
    return sorted(score.items(), key=lambda x: (-x[1], x[0]))


def ai_pairs(nodes, adj, changed_slugs, per_note=6, total=60):
    cs = {s.lower() for s in changed_slugs}
    out, cnt = [], {}
    for (a, b), sc in adamic_adar(nodes, adj):
        hit = [x for x in (a, b) if x in cs]
        if not hit or all(cnt.get(x, 0) >= per_note for x in hit):
            continue
        for x in hit:
            cnt[x] = cnt.get(x, 0) + 1
        out.append({"a": nodes[a]["slug"], "b": nodes[b]["slug"], "score": round(sc, 2), "shared": len(adj[a] & adj[b])})
        if len(out) >= total:
            break
    return out


def lint_hits(slugs):
    lint = os.path.join(C.ROOT, "scripts", "wiki-lint.py")
    if not os.path.isfile(lint) or not os.path.isdir(C.WIKI):
        return [], ""                          # skip quietly: the linter is optional here
    args = [sys.executable, lint, "wiki"]
    if os.path.isdir(C.MEM):
        args += ["--extra-dir", "memory"]
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=120, cwd=C.ROOT)
    except Exception as e:
        return [], "wiki-lint failed: %s" % type(e).__name__
    cs = {s.lower() for s in slugs}
    hits = []
    for ln in (r.stdout or "").splitlines():
        low = ln.lower()
        if any(re.search(r"(?<![a-z0-9-])" + re.escape(s) + r"(?![a-z0-9-])", low) for s in cs):
            hits.append(ln.strip()[:240])
        if len(hits) >= 40:
            break
    return hits, ""


def recall_neighbours(queries, k=8, timeout=300):
    """ONE recall.py --batch process (never parallel). -> ({query: [hits]}, [warnings]). Fail-soft."""
    if not queries:
        return {}, []
    rp = os.path.join(C.ROOT, "scripts", "recall.py")
    if not os.path.isfile(rp):
        return {}, ["recall.py not found: no neighbour excerpts"]
    try:
        r = subprocess.run([sys.executable, rp, "--batch"] + list(queries) + ["-k", str(k)],
                           capture_output=True, text=True, timeout=timeout, cwd=C.ROOT)
        d = json.loads(r.stdout)
    except Exception as e:
        return {}, ["recall --batch failed (%s): no neighbour excerpts" % type(e).__name__]
    warns = []
    if d.get("semantic") not in (None, "live"):
        warns.append("recall: semantic search is %s, neighbours are lexical only" % d.get("semantic"))
    return d.get("batch") or {}, warns


def neighbour_ok(relpath):
    r = relpath.replace(os.sep, "/")
    return (r.startswith("wiki/") and C.allowed_input(r) and not C.is_personal_path(os.path.join(C.ROOT, r)))


def title_desc(text, path):
    t = d = ""
    m = FM_RE.match(text)
    if m:
        tm = re.search(r"(?m)^title:\s*(.+?)\s*$", m.group(1))
        dm = re.search(r"(?m)^description:\s*(.+?)\s*$", m.group(1))
        t = tm.group(1).strip("\"' ") if tm else ""
        d = dm.group(1).strip("\"' ") if dm else ""
    if not t:
        hm = re.search(r"(?m)^#\s+(.+?)\s*$", text)
        t = hm.group(1) if hm else os.path.basename(path)[:-3].replace("-", " ")
    return t, d


def main(argv=None):
    ap = argparse.ArgumentParser(description="Gather what changed and cut it into shards. No LLM.")
    ap.add_argument("--days", type=float, default=1)
    ap.add_argument("--date", default=None, help="run folder name (default: today, local date)")
    ap.add_argument("--max-notes", type=int, default=12)
    ap.add_argument("--shard-size", type=int, default=MAX_SHARD)
    ap.add_argument("--no-recall", action="store_true")
    ap.add_argument("--force", action="store_true", help="re-collect even if a ledger says the night was applied")
    a = ap.parse_args(argv)
    date = a.date or C.today()
    run = C.run_dir(date)
    if os.path.exists(os.path.join(run, "applied.json")) and not a.force:
        print("dream collect %s: this night was already applied (applied.json exists); revert it or pass --force" % date)
        return 1

    nf = C.NameFilter()
    raw = changed_paths(a.days)
    excluded_personal = sum(1 for p in raw if C.is_personal_path(os.path.join(C.ROOT, p)))
    keep = {p: ts for p, ts in raw.items() if C.allowed_input(p) and os.path.isfile(os.path.join(C.ROOT, p))}
    nodes, adj = load_graph()
    now = time.time()
    scored = []
    for p, ts in keep.items():
        full = os.path.join(C.ROOT, p)
        mt = max(ts, int(os.path.getmtime(full)))
        age = max((now - mt) / 86400.0, 0.0)
        slug = os.path.basename(p)[:-3].lower()
        deg = len(adj.get(slug, ()))
        scored.append(((1.0 / (1 + age)) * (1.0 / (1 + deg)) + 1e-9, p, mt, deg))
    scored.sort(key=lambda x: (-x[0], x[1]))
    chosen, rolled = scored[:max(a.max_notes, 0)], scored[max(a.max_notes, 0):]

    notes, dropped_lines = [], 0
    for sc, p, mt, deg in chosen:
        text = C.read(os.path.join(C.ROOT, p))
        k = C.kind_of(p)
        if k == "daily-log":
            text, nd = nf.filter_text(text)
            dropped_lines += nd
        t, d = title_desc(text, p)
        if k == "daily-log":
            t = os.path.basename(p)[:-3] + " daily log"
        notes.append({"path": p, "slug": os.path.basename(p)[:-3], "kind": k, "title": t, "description": d,
                      "mtime": datetime.datetime.fromtimestamp(mt).isoformat(timespec="minutes"),
                      "degree": deg, "score": round(sc, 5),
                      "text": text[:NOTE_CHARS[k]], "truncated": len(text) > NOTE_CHARS[k]})

    errors = []
    pairs = ai_pairs(nodes, adj, [n["slug"] for n in notes if n["kind"] == "wiki"])
    lint, err = lint_hits([n["slug"] for n in notes])
    if err:
        errors.append(err)

    nb = {}
    if not a.no_recall and notes:
        qmap = {n["path"]: (n["title"] + " " + n["description"])[:200].strip() for n in notes}
        res, warns = recall_neighbours(sorted(set(q for q in qmap.values() if q)))
        errors += warns
        for pth, q in qmap.items():
            lst = []
            for h in res.get(q, []):
                f = h.get("file", "")
                if f == pth or not neighbour_ok(f):
                    continue
                ex = " ".join((h.get("chunk") or h.get("snippet") or "").split())[:EXCERPT_CHARS]
                if ex:
                    lst.append({"path": f, "slug": os.path.basename(f)[:-3], "heading": h.get("heading", ""),
                                "line": h.get("line"), "excerpt": ex})
                if len(lst) >= 4:
                    break
            nb[pth] = lst
    elif a.no_recall:
        errors.append("recall skipped (--no-recall)")

    sdir = os.path.join(run, "shards")
    os.makedirs(sdir, exist_ok=True)
    for old in os.listdir(sdir):
        if old.startswith("shard-"):
            os.remove(os.path.join(sdir, old))
    for sub in ("proposals",):
        d = os.path.join(run, sub)
        if os.path.isdir(d):
            for old in os.listdir(d):
                if old.endswith(".json"):
                    os.remove(os.path.join(d, old))
    for fn in STALE_OUTPUTS:
        if os.path.isfile(os.path.join(run, fn)):
            os.remove(os.path.join(run, fn))
    os.makedirs(os.path.join(run, "proposals"), exist_ok=True)
    size = max(1, min(a.shard_size, MAX_SHARD))
    shards = 0
    for i in range(0, len(notes), size):
        grp = notes[i:i + size]
        slugs = {n["slug"].lower() for n in grp}
        sh = {"date": date, "shard": shards + 1,
              "instructions": "The text and excerpt fields are your only evidence. Quote them verbatim.",
              "notes": [dict(n, neighbours=nb.get(n["path"], [])) for n in grp],
              "candidate_links": [p for p in pairs if p["a"].lower() in slugs or p["b"].lower() in slugs][:15],
              "lint_hits": [l for l in lint if any(s in l.lower() for s in slugs)][:10]}
        shards += 1
        C.jdump(sh, os.path.join(sdir, "shard-%02d.json" % shards))

    coll = {"date": date, "days": a.days, "generated": datetime.datetime.now().isoformat(timespec="seconds"),
            "note_count": len(notes), "shard_count": shards, "max_notes": a.max_notes,
            "personal_paths_excluded": excluded_personal, "daily_log_lines_dropped": dropped_lines,
            "name_filter_terms": len(nf.terms), "vault_configured": bool(C.vault_dir()),
            "notes": [{k: v for k, v in n.items() if k != "text"} for n in notes],
            "rolled_over": [p for (_, p, _, _) in rolled],
            "candidate_links": pairs, "lint_hits": lint, "errors": errors}
    C.jdump(coll, os.path.join(run, "collect.json"))
    print("dream collect %s: %d notes (%d rolled over), %d shards, %d link candidates, %d lint hits, "
          "%d personal paths excluded, %d daily-log lines dropped" %
          (date, len(notes), len(rolled), shards, len(pairs), len(lint), excluded_personal, dropped_lines))
    for e in errors:
        print("  note:", e)
    print("run dir:", run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
