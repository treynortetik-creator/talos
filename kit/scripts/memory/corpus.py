"""corpus.py: which files belong in the agent's searchable memory. Standard library only.

One definition, used by BOTH search arms, so the lexical search and the semantic index can never disagree
about what the corpus is. Python 3.9 compatible (recall.py runs on the system python).

Roots are wiki/, memory/ and .learnings/ under the agent folder, which is derived from this file's own
location (scripts/memory/corpus.py -> the folder two levels up), never from an environment variable.

Left out on purpose:
  - wiki/examples/        made-up people shipped with the kit; they would answer questions with fiction
  - _changelog*.md        append-only churn: appending one line re-embeds the whole file, and it is read
                          chronologically, not by similarity
  - GRADUATION_LOG.md     a graduated rule is already in CLAUDE.md, which is always in context
  - agent-log.md          append-only harness log; same churn problem
  - memory/briefs/        generated daily; restates notes that are already indexed
  - *.local.md            machine-local scratch
  - anything under a personal/ folder: a private vault is NEVER indexed into the work agent's search
  - memory/dream/<date>/preimage/   the dream cycle's byte-exact copies of notes it edited (for undo): near-duplicates
                          of real notes that would rank as if they were notes (see is_index_excluded)
"""
import os
import re
import sys

try:        # the agent folder, not the folder above this file (that is a plugin release in the plugin layout)
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from _agent_root import agent_root
    ROOT = agent_root(__file__, 2)
except ImportError:        # a lone copy of this file with no helper beside it: the old rule
    ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
try:        # where the wiki is: wiki/, or memory/wiki/ on a layout-2 agent (one resolver, scripts/_talos_layout.py)
    from _talos_layout import paths as _layout_paths
    WIKI = _layout_paths(ROOT)["wiki"]
except ImportError:        # a lone copy with no helper beside it: the old rule
    WIKI = os.path.join(ROOT, "wiki")
CORPUS_DIRS = ("wiki", "memory", ".learnings")


def corpus_dirs(root=None):
    """The top folders searched under `root`. On a layout-2 agent the wiki sits inside memory/, which is a root already, so a
    stray top-level wiki/ is not one."""
    root = root or ROOT
    try:
        from _talos_layout import paths
        wiki_top = os.path.relpath(paths(root)["wiki"], root).split(os.sep)[0]
    except ImportError:
        wiki_top = "wiki"
    return tuple(d for d in CORPUS_DIRS if d != "wiki" or wiki_top == "wiki")


EXCLUDE_NAMES = {"GRADUATION_LOG.md", "agent-log.md"}
EXCLUDE_PREFIXES = ("_changelog",)
EXCLUDE_DIR_PARTS = ("examples", "briefs", "personal", "node_modules", ".git")


# The dream cycle (scripts/dream/apply.py) saves a pre-edit copy of every note it changes under
# memory/dream/<date>/preimage/. They are near-duplicates of real notes; they stay on disk for the undo and nowhere else.
PREIMAGE_RE = re.compile(r"(^|[\\/])memory[\\/]dream[\\/][^\\/]+[\\/]preimage([\\/]|$)")


def is_index_excluded(path):
    """True for a markdown path the search must never index or return: a dream-cycle preimage copy. Works on a
    relative or an absolute path, with / or \\ separators."""
    return bool(PREIMAGE_RE.search(path))


def is_indexable(rel, dirs=CORPUS_DIRS):
    """rel: path relative to the agent folder, '/'-separated."""
    if is_index_excluded(rel):
        return False
    parts = rel.split("/")
    name = parts[-1]
    # case-insensitive throughout: on macOS (a case-insensitive filesystem) wiki/Personal/ IS wiki/personal/, and a
    # private vault must never be indexed because of how its folder happens to be capitalised
    low_name = name.lower()
    if not low_name.endswith(".md") or low_name.endswith(".local.md"):
        return False
    if low_name in {n.lower() for n in EXCLUDE_NAMES} or low_name.startswith(EXCLUDE_PREFIXES):
        return False
    if any(p.lower() in EXCLUDE_DIR_PARTS for p in parts[:-1]):
        return False
    return parts[0].lower() in dirs


def source_files(root=None):
    """Sorted absolute paths of every markdown file that belongs in the corpus. Never follows symlinks out."""
    root = root or ROOT
    out = []
    dirs = corpus_dirs(root)
    for d in dirs:
        base = os.path.join(root, d)
        if not os.path.isdir(base) or os.path.islink(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [x for x in dirnames if x.lower() not in EXCLUDE_DIR_PARTS and not os.path.islink(os.path.join(dirpath, x))]
            for fn in filenames:
                p = os.path.join(dirpath, fn)
                if os.path.islink(p):
                    continue
                rel = os.path.relpath(p, root).replace(os.sep, "/")
                if is_indexable(rel, dirs):
                    out.append(p)
    return sorted(out)
