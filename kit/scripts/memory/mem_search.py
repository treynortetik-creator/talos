#!/usr/bin/env python3
"""mem_search.py: semantic (nearest-neighbour) search over the agent's sqlite-vec index. Prints JSON.

Run it with the memory venv's python. Normally recall.py calls it for you.

    mem_search.py "query" [--top-k N]            one query
    echo '["q1","q2"]' | mem_search.py --stdin-queries [--top-k N]   many queries, ONE process (the model loads once)

Output: {"model": ..., "results": [{"path","heading","score","distance","snippet"}]}  (paths relative to the agent
folder), or {"model": ..., "batch": {query: [results]}}. Read-only on the index.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mem_common as M  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("query", nargs="*")
ap.add_argument("--top-k", type=int, default=10)
ap.add_argument("--stdin-queries", action="store_true")
ap.add_argument("--json", action="store_true")      # accepted for symmetry; output is always JSON
A = ap.parse_args()


def search(db, hf_name, query, topk):
    qv = M.embed_query(hf_name, query)
    # KNN has to live alone in a subquery (a sqlite-vec requirement); then join back to the chunk text.
    rows = list(db.execute(
        "SELECT c.path, c.heading, c.text, k.distance FROM "
        "  (SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ?) k "
        "  JOIN chunks c ON c.id = k.rowid ORDER BY k.distance",
        (M.serialize(qv), topk)))
    out = []
    for path, heading, text, dist in rows:
        d = float(dist)
        out.append({"path": path, "heading": heading or "",
                    "score": round(max(0.0, 1.0 - (d * d) / 2.0), 4),     # cosine similarity from L2 of unit vectors
                    "distance": round(d, 4), "snippet": text[:300]})
    return out


def main():
    if not os.path.exists(M.DB_PATH):
        print(json.dumps({"error": "no index", "results": []}))
        return 0
    db = M.connect()
    hf_name = M.get_meta(db, "model")
    if not hf_name:
        print(json.dumps({"error": "index has no model recorded; re-run mem_index.py --full", "results": []}))
        return 0
    if A.stdin_queries:
        queries = json.loads(sys.stdin.read() or "[]")
        print(json.dumps({"model": hf_name, "batch": {q: search(db, hf_name, q, A.top_k) for q in queries}}))
    else:
        query = " ".join(A.query).strip()
        if not query:
            print('usage: mem_search.py "query" [--top-k N]', file=sys.stderr)
            return 2
        print(json.dumps({"model": hf_name, "query": query, "results": search(db, hf_name, query, A.top_k)}))
    db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
