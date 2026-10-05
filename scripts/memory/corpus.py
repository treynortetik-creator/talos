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
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
CORPUS_DIRS = ("wiki", "memory", ".learnings")
EXCLUDE_NAMES = {"GRADUATION_LOG.md", "agent-log.md"}
EXCLUDE_PREFIXES = ("_changelog",)
EXCLUDE_DIR_PARTS = ("examples", "briefs", "personal", "node_modules", ".git")


def is_indexable(rel):
    """rel: path relative to the agent folder, '/'-separated."""
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
    return parts[0].lower() in CORPUS_DIRS


def source_files(root=None):
    """Sorted absolute paths of every markdown file that belongs in the corpus. Never follows symlinks out."""
    root = root or ROOT
    out = []
    for d in CORPUS_DIRS:
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
                if is_indexable(rel):
                    out.append(p)
    return sorted(out)
