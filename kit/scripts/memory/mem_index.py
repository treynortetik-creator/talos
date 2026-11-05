#!/usr/bin/env python3
"""mem_index.py: index the agent's markdown memory into sqlite-vec. READ-ONLY on the source files.

Run it with the memory venv's python (scripts/memory/setup.sh builds the venv):

    ~/.local/share/talos/venv/bin/python scripts/memory/mem_index.py [--full] [--quiet] [--embed-model base|small]

Incremental by default: only files whose modification time changed are re-embedded, so a run with nothing to do
finishes in about a second and never even loads the model. --full wipes the index and rebuilds it (also the only
way to switch --embed-model on an existing index: two models' vectors cannot be mixed).

Safety, because this is the one thing in the kit that can run unattended for minutes:
  - single-flight: a lock folder holding the pid; a second run says "already running" and exits 0; a lock whose
    pid is dead is stolen
  - SIGTERM / SIGINT / SIGHUP unwind through `finally`, so a killed run releases the lock
  - it stops cleanly (partial work stays committed) if its memory use passes 4 GB
  - one transaction per file, so a crash never leaves half a file in the index
Writes only <agent>/.index/ (memory.db, a lock folder, index.log trimmed to 400 lines).
"""
import argparse
import os
import re
import resource
import shutil
import signal
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mem_common as M  # noqa: E402
import corpus  # noqa: E402

ap = argparse.ArgumentParser(description="Index the agent's markdown memory.")
ap.add_argument("--full", action="store_true", help="wipe and rebuild")
ap.add_argument("--quiet", action="store_true", help="no per-file progress (the summary line still prints)")
ap.add_argument("--embed-model", choices=sorted(M.MODELS), default=None)
ARGS = ap.parse_args()


def _bail(sig, _frm):
    raise SystemExit(128 + sig)


for _s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    try:
        signal.signal(_s, _bail)
    except (ValueError, OSError):
        pass


def log(msg, always=False):
    line = "%s %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    try:
        os.makedirs(M.INDEX_DIR, exist_ok=True)
        with open(M.LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass
    if always or not ARGS.quiet:
        print(msg, flush=True)


def trim_log(keep=400):
    try:
        with open(M.LOG_PATH, encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()
        if len(lines) > keep:
            with open(M.LOG_PATH, "w", encoding="utf-8") as fh:
                fh.writelines(lines[-keep:])
    except OSError:
        pass


def chunk_markdown(text, max_chars=M.MAX_CHARS):
    """Split into chunks of at most max_chars on paragraph and heading boundaries; remember the nearest heading."""
    chunks, cur, buf, blen = [], "", [], 0

    def flush():
        nonlocal buf, blen
        if buf:
            t = "\n".join(buf).strip()
            if t:
                chunks.append((cur, t))
        buf, blen = [], 0

    for ln in text.split("\n"):
        if re.match(r"^#{1,6}\s", ln):
            flush()
            cur = ln.lstrip("#").strip()
            continue
        if blen + len(ln) + 1 > max_chars and buf:
            flush()
        buf.append(ln)
        blen += len(ln) + 1
    flush()
    out = []
    for h, t in chunks:          # hard-split any pathological oversize chunk
        if len(t) <= max_chars * 2:
            out.append((h, t))
        else:
            for i in range(0, len(t), max_chars):
                out.append((h, t[i:i + max_chars]))
    return out


def setup(db, dim):
    db.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)")
    db.execute("CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, mtime REAL)")
    db.execute("CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, path TEXT, heading TEXT, text TEXT)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path)")
    db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[%d])" % dim)


def del_file(db, path):
    for (rid,) in list(db.execute("SELECT id FROM chunks WHERE path=?", (path,))):
        db.execute("DELETE FROM vec_chunks WHERE rowid=?", (rid,))
    db.execute("DELETE FROM chunks WHERE path=?", (path,))
    db.execute("DELETE FROM files WHERE path=?", (path,))


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def rss_bytes():
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return r if sys.platform == "darwin" else r * 1024


def resolve_model(db_exists):
    """-> (short_name, hf_name, dim). An existing index decides, unless --full is rebuilding it."""
    want = ARGS.embed_model or os.environ.get("TALOS_EMBED_MODEL") or None
    if db_exists and not ARGS.full:
        db = M.connect()
        try:
            stored = M.get_meta(db, "model")
        finally:
            db.close()
        if stored:
            short = next((k for k, v in M.MODELS.items() if v[0] == stored), None)
            if short is None:
                return None, stored, None
            if want and want != short:
                print("mem_index: this index was built with the '%s' model; you asked for '%s'. Vectors from two models "
                      "cannot be mixed. Re-run with --full to rebuild with '%s', or drop --embed-model." % (short, want, want),
                      file=sys.stderr)
                sys.exit(2)
            return short, M.MODELS[short][0], M.MODELS[short][1]
    short = want or M.DEFAULT_MODEL
    return short, M.MODELS[short][0], M.MODELS[short][1]


def main():
    t0 = time.time()
    os.makedirs(M.INDEX_DIR, exist_ok=True)
    try:
        os.mkdir(M.LOCK_DIR)
    except FileExistsError:
        holder = None
        try:
            holder = int(open(os.path.join(M.LOCK_DIR, "pid")).read().strip())
        except Exception:
            pass
        if holder and _alive(holder):
            log("mem_index: another index is already running (pid %d); skipping." % holder, always=True)
            return 0
        if not holder:
            # a lock folder with no pid yet is a run that is STARTING (mkdir happens a moment before the pid is
            # written): only call it abandoned if the folder is old
            try:
                young = (time.time() - os.path.getmtime(M.LOCK_DIR)) < 60
            except OSError:
                young = False
            if young:
                log("mem_index: another index is starting; skipping.", always=True)
                return 0
        shutil.rmtree(M.LOCK_DIR, ignore_errors=True)       # the holder died: steal the lock
        try:
            os.mkdir(M.LOCK_DIR)
        except FileExistsError:                              # lost the race to another run that stole it first
            log("mem_index: another index is already running; skipping.", always=True)
            return 0
    with open(os.path.join(M.LOCK_DIR, "pid"), "w") as fh:
        fh.write(str(os.getpid()))
    try:
        return run(t0)
    finally:
        shutil.rmtree(M.LOCK_DIR, ignore_errors=True)
        trim_log()


def run(t0):
    short, hf_name, dim = resolve_model(os.path.exists(M.DB_PATH))
    if dim is None:
        print("mem_index: the index records an unknown model (%s). Re-run with --full." % hf_name, file=sys.stderr)
        return 2
    db = M.connect()
    setup(db, dim)
    if ARGS.full:
        with db:
            db.execute("DROP TABLE IF EXISTS vec_chunks")
            db.execute("DELETE FROM chunks")
            db.execute("DELETE FROM files")
            db.execute("DELETE FROM meta")
        setup(db, dim)
        log("mem_index: FULL rebuild (model %s)" % short)
    with db:
        db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('model',?)", (hf_name,))
        db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('dim',?)", (str(dim),))
    files = corpus.source_files(M.ROOT)
    rel = {f: os.path.relpath(f, M.ROOT).replace(os.sep, "/") for f in files}
    stored = {r[0]: r[1] for r in db.execute("SELECT path, mtime FROM files")}
    changed = []
    for f in files:
        mt = os.path.getmtime(f)
        if stored.get(rel[f]) != mt:
            changed.append((f, mt))
    removed = set(stored) - set(rel.values())
    if removed:
        with db:
            for gone in removed:
                del_file(db, gone)
    log("mem_index: %d md files | %d new/changed | %d removed" % (len(files), len(changed), len(removed)), always=True)
    done = added = 0
    partial = False
    for f, mt in changed:
        try:
            text = open(f, encoding="utf-8", errors="replace").read()
        except OSError as e:
            log("  skip %s: %s" % (rel[f], e))
            continue
        ch = chunk_markdown(text)
        texts = [("%s\n%s" % (h, t)) if h else t for h, t in ch]
        embs = M.embed_passages(hf_name, texts) if texts else []
        with db:                                  # one transaction per file: atomic and fast
            del_file(db, rel[f])
            for (h, t), e in zip(ch, embs):
                db.execute("INSERT INTO chunks(path,heading,text) VALUES(?,?,?)", (rel[f], h, t))
                rid = db.last_insert_rowid()
                db.execute("INSERT INTO vec_chunks(rowid,embedding) VALUES(?,?)", (rid, M.serialize(e)))
            db.execute("INSERT OR REPLACE INTO files(path,mtime) VALUES(?,?)", (rel[f], mt))
        added += len(ch)
        done += 1
        if done % 25 == 0:
            log("  ...%d/%d files, %d chunks embedded" % (done, len(changed), added))
        if rss_bytes() > M.RSS_LIMIT:
            log("mem_index: memory use passed 4 GB; stopping early (what is done stays committed). Run again to continue.")
            partial = True
            break
    n = list(db.execute("SELECT COUNT(*) FROM chunks"))[0][0]
    db.close()
    log("mem_index: done in %.0fs | %d chunks added this run | %d chunks total | %s" % (time.time() - t0, added, n, M.DB_PATH), always=True)
    if not partial:
        # freshness marker, written ONLY on a clean finish: a killed or partial run must not read as "fresh"
        with open(os.path.join(M.INDEX_DIR, ".last-index-ok"), "w") as fh:
            fh.write(time.strftime("%Y-%m-%dT%H:%M:%S\n"))
    return 3 if partial else 0


if __name__ == "__main__":
    sys.exit(main())
