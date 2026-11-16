#!/usr/bin/env python3
"""mem_rerank.py: OPT-IN cross-encoder rerank for recall.py (bge-reranker-v2-m3, int8 ONNX, CPU).

Off unless asked for or measured fast. recall.py turns it on with --rerank, TALOS_RECALL_RERANK=1, or by itself for a question when the timing probe says it is quick (below), and only when the semantic search stack is
installed (scripts/memory/setup.sh) AND the reranker model has been downloaded (bash scripts/memory/setup.sh --rerank).

API (what recall.py calls):
    rerank(query, paths) -> (ordered_paths, scores | None)       paths are absolute file paths
    Scores each file's best chunk against the query and sorts descending (stable on ties).
    FAIL SOFT: any error (no model, no onnxruntime, worker crash, timeout) returns the input order unchanged with
    scores=None and prints ONE stderr note per process.

Where it runs: onnxruntime lives only in the memory venv, not in the system python3 that runs recall.py. So rerank()
runs in-process when onnxruntime imports, and otherwise talks to ONE persistent `mem_rerank.py --worker` child (the venv
python) that is spawned lazily and reused, so the model loads once per process even under `recall.py --batch`.

Best chunk per file: cosine(query, chunk vector) maximised over that file's chunks. Files with no indexed chunks fall back
to the first 1800 characters of the file. READ-ONLY: the index is opened read-only; this module never writes it.

Measured trade-off (one maintainer's 33-query bench, so a hint, not a promise): it helped hard, vague "what did we decide
about..." questions a lot and slightly hurt exact name / file lookups. That is why it is opt-in per query, not on.
Model dir: $TALOS_RERANK_MODEL_DIR or ${XDG_DATA_HOME:-~/.local/share}/talos/models/bge-reranker-v2-m3-int8 (about 571 MB).

`mem_rerank.py --probe <agent_dir> [--force]` (run with the venv python) times one COLD rerank (a fresh worker process, the way recall.py makes it) and one WARM rerank of up to 15 of the agent's
notes and keeps it in <agent_dir>/.index/rerank-time.json ({"seconds" (one warm rerank), "cold_seconds" (a fresh worker: start, load, rerank, exit), "n", "measured", "cpus"}). The install runs it once
after the model download; the daily index job runs it at most once per 20 hours (--force measures again). recall.py reads it:
it reranks question-shaped queries by default only when this file's cold_seconds is under 8.0 (a plain recall.py run starts a fresh worker).
"""
import json
import os
import select
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"), "talos")
MEM_PY = os.path.join(DATA, "venv", "bin", "python")
DEFAULT_MODEL_DIR = os.path.join(DATA, "models", "bge-reranker-v2-m3-int8")
PAD_ID, MAX_LEN, BATCH, DOC_CHARS = 1, 512, 8, 1800
WORKER_TIMEOUT_S = 180          # cold: model load plus embedder load plus scoring

_warned = False
LAST_ERROR = None               # the last failure, as text: recall.py reads it to say WHY a rerank did not run
_disabled = False               # after one failure, stop retrying in this process
_worker = None
_session = None                 # (tokenizer, onnx session, input names): in-process cache


def model_dir():
    return os.environ.get("TALOS_RERANK_MODEL_DIR") or DEFAULT_MODEL_DIR


def installed():
    """True when the reranker model files are on disk (recall.py checks this before it even tries)."""
    d = model_dir()
    return os.path.exists(os.path.join(d, "tokenizer.json")) and os.path.exists(os.path.join(d, "onnx", "model_int8.onnx"))


def _note(msg):
    global _warned
    if not _warned:
        _warned = True
        print("mem_rerank: %s; returning unreranked order" % msg, file=sys.stderr)


# ------------------------------------------------------------------ scoring core (venv only)
def _load_model():
    global _session
    if _session is None:
        import onnxruntime as ort
        from tokenizers import Tokenizer
        mdir = model_dir()
        tok = Tokenizer.from_file(os.path.join(mdir, "tokenizer.json"))
        tok.enable_truncation(max_length=MAX_LEN)
        tok.enable_padding(pad_id=PAD_ID, pad_token="<pad>")
        sess = ort.InferenceSession(os.path.join(mdir, "onnx", "model_int8.onnx"), ort.SessionOptions(),
                                    providers=["CPUExecutionProvider"])
        _session = (tok, sess, [i.name for i in sess.get_inputs()])
    return _session


def _score_pairs(query, docs):
    import numpy as np
    tok, sess, names = _load_model()
    out = []
    for i in range(0, len(docs), BATCH):
        enc = tok.encode_batch([(query, d) for d in docs[i:i + BATCH]])
        feed = {"input_ids": np.array([e.ids for e in enc], dtype=np.int64),
                "attention_mask": np.array([e.attention_mask for e in enc], dtype=np.int64)}
        feed = {k: v for k, v in feed.items() if k in names}
        out += sess.run(None, feed)[0].reshape(-1).tolist()
    return out


def _best_docs(query, paths):
    """One 'heading\\ntext'[:1800] doc per path: that file's best chunk by cosine. READ-ONLY."""
    import apsw
    import numpy as np
    import sqlite_vec
    sys.path.insert(0, HERE)
    import mem_common as M
    db = apsw.Connection(M.DB_PATH, flags=apsw.SQLITE_OPEN_READONLY)
    db.enableloadextension(True)
    db.loadextension(sqlite_vec.loadable_path())
    db.enableloadextension(False)
    hf_name = M.get_meta(db, "model") or M.MODELS[M.DEFAULT_MODEL][0]
    qv = M.embed_query(hf_name, query)
    docs = []
    try:
        for p in paths:
            rel = os.path.relpath(p, M.ROOT)
            rows = list(db.execute("SELECT id, heading, text FROM chunks WHERE path=?", (rel,)))
            best = None
            if rows:
                ids = [r[0] for r in rows]
                vecs = {rid: np.frombuffer(b, dtype=np.float32) for rid, b in db.execute(
                    "SELECT rowid, embedding FROM vec_chunks WHERE rowid IN (%s)" % ",".join("?" * len(ids)), ids)}
                cands = [(float(vecs[r[0]] @ qv), r) for r in rows if r[0] in vecs]
                if cands:
                    best = max(cands, key=lambda t: t[0])[1]
            if best:
                _, heading, text = best
                docs.append(((heading + "\n" + text) if heading else text)[:DOC_CHARS])
            else:                          # unindexed or brand-new file: use its head
                try:
                    with open(p, encoding="utf-8", errors="replace") as fh:
                        docs.append(fh.read(DOC_CHARS))
                except Exception:
                    docs.append("")
    finally:
        db.close()
    return docs


def _score_paths(query, paths):
    return _score_pairs(query, _best_docs(query, paths))


# ------------------------------------------------------------------ worker child (venv)
def _worker_main():
    real_out = os.fdopen(os.dup(1), "w")      # protocol channel
    sys.stdout = sys.stderr                    # stray prints from libraries must not corrupt it
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            resp = {"scores": _score_paths(req["query"], req["paths"])}
        except Exception as e:
            resp = {"error": "%s: %s" % (type(e).__name__, e)}
        real_out.write(json.dumps(resp) + "\n")
        real_out.flush()


def _ask_worker(query, paths):
    global _worker
    if _worker is None or _worker.poll() is not None:
        if not os.path.exists(MEM_PY):
            raise RuntimeError("the memory venv is missing at %s" % MEM_PY)
        _worker = subprocess.Popen([MEM_PY, os.path.abspath(__file__), "--worker"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
    _worker.stdin.write(json.dumps({"query": query, "paths": paths}) + "\n")
    _worker.stdin.flush()
    ready, _, _ = select.select([_worker.stdout], [], [], WORKER_TIMEOUT_S)
    if not ready:
        _kill_worker()
        raise TimeoutError("worker silent for %ds" % WORKER_TIMEOUT_S)
    line = _worker.stdout.readline()
    if not line:
        raise RuntimeError("worker exited unexpectedly")
    resp = json.loads(line)
    if "error" in resp:
        raise RuntimeError(resp["error"])
    return resp["scores"]


def _kill_worker():
    global _worker
    if _worker is not None:
        try:
            _worker.kill()                      # only the child this process started
            _worker.wait(timeout=5)
        except Exception:
            pass
        _worker = None


def close():
    """Shut the worker down (stdin EOF = clean exit). Safe to call any time."""
    global _worker
    if _worker is not None:
        try:
            _worker.stdin.close()
            _worker.wait(timeout=10)
        except Exception:
            _kill_worker()
        _worker = None


# ------------------------------------------------------------------ public API
def rerank(query, paths):
    """Return (ordered_paths, scores). On ANY failure: (list(paths), None) plus one stderr note."""
    global _disabled, LAST_ERROR
    paths = list(paths)
    if len(paths) < 2 or _disabled:
        return paths, None
    try:
        if not installed():
            raise RuntimeError("the reranker model is not downloaded (run: bash scripts/memory/setup.sh --rerank)")
        try:
            import onnxruntime  # noqa: F401  (importable in-process only inside the venv)
            scores = _score_paths(query, paths)
        except ImportError:
            scores = _ask_worker(query, paths)
        if len(scores) != len(paths):
            raise ValueError("got %d scores for %d files" % (len(scores), len(paths)))
        order = sorted(range(len(paths)), key=lambda i: -scores[i])     # stable
        return [paths[i] for i in order], [scores[i] for i in order]
    except Exception as e:
        _disabled = True
        LAST_ERROR = "%s: %s" % (type(e).__name__, e)
        _note(LAST_ERROR)
        _kill_worker()
        return paths, None


# ------------------------------------------------------------------ speed probe
PROBE_QUERY = "what did we decide about the next step"
PROBE_MAX_AGE_H = 20


def _probe_notes(agent_dir):
    found = []
    for root, dirs, files in os.walk(agent_dir):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d != "node_modules"]
        found += [os.path.join(root, f) for f in files if f.endswith(".md")]
    return sorted(found)[:15]


def time_cold(query, paths):
    """Seconds for ONE rerank the way recall.py really makes it: a fresh worker process that starts, loads the embedder and
    the reranker model, scores the paths and exits. None when that failed. (A rerank that finds the model in-process is not
    what a plain recall.py run does, so this always goes through a new worker child.)"""
    close()
    t0 = time.monotonic()
    try:
        scores = _ask_worker(query, list(paths))
        if len(scores) != len(paths):
            raise ValueError("got %d scores for %d files" % (len(scores), len(paths)))
        close()
    except Exception as e:  # noqa: BLE001
        _kill_worker()
        _note("cold timing: %s: %s" % (type(e).__name__, e))
        return None
    return time.monotonic() - t0


def probe(agent_dir, force=False):
    """Time one warm rerank and write <agent_dir>/.index/rerank-time.json. Prints one line; returns 0 on every path."""
    import datetime
    out = os.path.join(agent_dir, ".index", "rerank-time.json")
    if not force:
        try:
            with open(out) as fh:
                prev = json.load(fh)
            prev["cold_seconds"]        # a file from before the cold timing existed is measured again
            when = datetime.datetime.strptime(prev["measured"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
            age_h = (datetime.datetime.now(datetime.timezone.utc) - when).total_seconds() / 3600.0
            if 0 <= age_h < PROBE_MAX_AGE_H:
                print("reranking speed here: measured %.1f h ago (%s s); not timed again" % (age_h, prev["seconds"]))
                return 0
        except Exception:
            pass
    if not installed():
        print("reranking speed here: not timed (the reranker model is not downloaded)")
        return 0
    paths = _probe_notes(agent_dir)
    if len(paths) < 2:
        print("reranking speed here: not timed (too few notes to time)")
        return 0
    cold = time_cold(PROBE_QUERY, paths)            # first, so no worker of ours is warm yet
    _, scores = rerank(PROBE_QUERY, paths)          # loads the model: the warm-up, not timed
    if scores is not None:
        t0 = time.monotonic()
        _, scores = rerank(PROBE_QUERY, paths)
        secs = time.monotonic() - t0
    if scores is None:
        print("reranking speed here: the timing failed (the reranker did not run)")
        return 0
    rec = {"seconds": round(secs, 1), "n": len(paths),
           "measured": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "cpus": os.cpu_count()}
    if cold is not None:
        rec["cold_seconds"] = round(cold, 1)        # recall.py's default-on gate reads this one, not "seconds"
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = "%s.%d.tmp" % (out, os.getpid())
    with open(tmp, "w") as fh:
        json.dump(rec, fh)
        fh.write("\n")
    os.replace(tmp, out)
    print("reranking speed here: %s s for %d notes (%s)" % (rec["seconds"], rec["n"], "cold start %s s" % rec["cold_seconds"]
          if cold is not None else "cold start timing failed"))
    return 0


if __name__ == "__main__":
    if "--worker" in sys.argv:
        _worker_main()
    elif "--probe" in sys.argv and sys.argv.index("--probe") + 1 < len(sys.argv):
        sys.exit(probe(sys.argv[sys.argv.index("--probe") + 1], force="--force" in sys.argv))
    else:
        sys.exit("mem_rerank.py is a library for recall.py (--rerank). `--worker` runs the child process.")
