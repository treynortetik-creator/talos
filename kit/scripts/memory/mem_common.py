"""mem_common.py: shared paths, model choice, chunking and the database connection for semantic memory.

Runs inside the Talos memory venv (Python 3.10+ with fastembed, sqlite-vec and apsw). It reads the agent's
markdown and writes ONLY <agent>/.index/. Everything is in-process (SQLite plus a local ONNX model): no
daemon, no server, nothing that can balloon in the background.

Why apsw: many Python builds ship a sqlite3 module compiled without loadable-extension support, and
sqlite-vec is a loadable extension. apsw bundles its own SQLite, so it works wherever the venv does.

Why a pinned model cache: fastembed defaults to a folder under the system temp directory, which macOS
purges, so the model silently re-downloads. The cache lives next to the venv instead.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import corpus  # noqa: E402

ROOT = corpus.ROOT
INDEX_DIR = os.path.join(ROOT, ".index")
DB_PATH = os.path.join(INDEX_DIR, "memory.db")
LOCK_DIR = os.path.join(INDEX_DIR, ".mem_index.lock.d")
LOG_PATH = os.path.join(INDEX_DIR, "index.log")

MODELS = {
    "base": ("BAAI/bge-base-en-v1.5", 768),    # about 210 MB, MIT licence. The default.
    "small": ("BAAI/bge-small-en-v1.5", 384),  # about 67 MB, MIT licence. For small Macs or impatient people.
}
DEFAULT_MODEL = "base"
MAX_CHARS = 1200      # chunk size in characters
BATCH = 32            # embedding batch: caps the onnxruntime memory arena (about 2 GB peak instead of 6)
RSS_LIMIT = 4 * 1024 ** 3   # an unattended indexer stops cleanly past this (macOS ru_maxrss is in bytes)


def data_home():
    return os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"), "talos")


MODEL_CACHE = os.path.join(data_home(), "models", "fastembed")

_embedder = {}


def get_embedder(model_name):
    if model_name not in _embedder:
        from fastembed import TextEmbedding  # imported late: it is slow, and a no-op index never needs it
        os.makedirs(MODEL_CACHE, exist_ok=True)
        _embedder[model_name] = TextEmbedding(model_name=model_name, cache_dir=MODEL_CACHE)
    return _embedder[model_name]


def _norm(v):
    import numpy as np
    v = np.asarray(v, dtype=np.float32)
    n = float(np.linalg.norm(v))
    return v / n if n > 0 else v


def embed_passages(model_name, texts):
    """List of passage texts -> list of L2-normalised float32 vectors."""
    return [_norm(v) for v in get_embedder(model_name).embed(list(texts), batch_size=BATCH)]


def embed_query(model_name, text):
    """One query -> normalised vector, using the model's query prefix when it has one."""
    emb = get_embedder(model_name)
    try:
        v = next(iter(emb.query_embed([text])))
    except Exception:
        v = next(iter(emb.embed([text])))
    return _norm(v)


def connect(db_path=DB_PATH):
    import apsw
    import sqlite_vec
    db = apsw.Connection(db_path)
    db.enableloadextension(True)
    db.loadextension(sqlite_vec.loadable_path())
    db.enableloadextension(False)
    db.execute("PRAGMA journal_mode=WAL")     # a search can read while the indexer writes
    db.execute("PRAGMA busy_timeout=5000")    # wait on a lock instead of erroring
    return db


def serialize(v):
    import numpy as np
    import sqlite_vec
    return sqlite_vec.serialize_float32(np.asarray(v, dtype=np.float32))


def get_meta(db, key, default=None):
    try:
        rows = list(db.execute("SELECT value FROM meta WHERE key=?", (key,)))
    except Exception:
        return default
    return rows[0][0] if rows else default
