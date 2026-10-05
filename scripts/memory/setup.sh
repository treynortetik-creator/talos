#!/bin/bash
# setup.sh: turn on semantic memory search for this agent. OPT-IN; grep search works without it.
#
#   bash scripts/memory/setup.sh [--agent-dir DIR] [--embed-model base|small] [--dry-run] [--no-index] [--no-job]
#
# What it does, in order (each step is skipped if it is already done):
#   1. finds a Python 3.10+ (the semantic packages need it; Apple's python3 is 3.9):
#        uv, if installed (uses uv's own managed CPython, about 30 MB, never touches the system), else the first
#        python3.13 / 3.12 / 3.11 / 3.10 on PATH (Homebrew, pyenv), then a newer python3.14+ or plain python3 that is 3.10+. If there is none it says so and exits 3.
#        A stock Mac has only Apple's Python 3.9. The one command to fix that:  brew install uv
#        (no Homebrew: curl -LsSf https://astral.sh/uv/install.sh | sh). Alternative: brew install python@3.12.
#        Nothing else breaks: recall.py keeps working, lexical only.
#   2. builds ONE shared venv at ~/.local/share/talos/venv (about 160 MB) and installs pinned packages
#   3. downloads the embedding model into ~/.local/share/talos/models/fastembed (a pinned folder: the default
#      cache is under the system temp dir, which macOS purges)
#   4. runs the first full index into <agent>/.index/memory.db (git-ignored; per agent)
#   5. if Chronos is installed (0.2.1+), enables the talos-memory-index job: a plain daily command that runs
#      scripts/memory/refresh-index.sh, no Claude involved, so it spends no plan usage. Session start and the
#      morning brief also refresh the index. --no-job skips this.
#
#   --embed-model base   BAAI/bge-base-en-v1.5, about 210 MB download, 768 dimensions (default)
#   --embed-model small  BAAI/bge-small-en-v1.5, about 67 MB, 384 dimensions (small Macs, impatient people)
#   --dry-run            print exactly what would happen and create nothing
#   --no-index           build the venv and model but do not run the first index
#   --venv-only          just create the shared venv (no packages, no model, no index); used by scripts/voice/setup.sh
#
# Remove it again with ./uninstall.sh --remove-memory-search (the per-agent .index/ goes with the agent folder).
# XDG_DATA_HOME moves ~/.local/share. Exit codes: 0 done, 3 no suitable Python (grep search still works), 1 error.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(cd "$HERE/../.." && pwd)"
MODEL=base; DRY=0; DO_INDEX=1; DO_JOB=1; PLAN_LABEL=""; VENV_ONLY=0
PKGS="fastembed==0.8.0 sqlite-vec==0.1.9 apsw==3.53.1.0"
while [ $# -gt 0 ]; do
  case "$1" in
    --agent-dir) AGENT_DIR="$(cd "${2:?--agent-dir needs a folder}" && pwd)" || { echo "no such folder: $2" >&2; exit 1; }; shift 2 ;;
    --embed-model) MODEL="${2:?}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --no-index) DO_INDEX=0; shift ;;
    --no-job) DO_JOB=0; shift ;;
    --venv-only) VENV_ONLY=1; shift ;;
    --as-agent-dir) PLAN_LABEL="${2:?}"; shift 2 ;;     # install.sh --dry-run only: what to print as the agent folder
    -h|--help) awk 'NR>1 { if ($0 ~ /^#/) print; else exit }' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done
case "$MODEL" in
  base)  MODEL_NAME="BAAI/bge-base-en-v1.5";  MODEL_MB=210; DIM=768 ;;
  small) MODEL_NAME="BAAI/bge-small-en-v1.5"; MODEL_MB=67;  DIM=384 ;;
  *) echo "--embed-model must be base or small" >&2; exit 2 ;;
esac
[ -f "$AGENT_DIR/scripts/memory/mem_index.py" ] || { echo "$AGENT_DIR does not look like a Talos agent folder (no scripts/memory/mem_index.py)" >&2; exit 1; }

DATA="${XDG_DATA_HOME:-$HOME/.local/share}/talos"
VENV="$DATA/venv"
PYV="$VENV/bin/python"
say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

# ---- find a python
find_python() {
  if command -v uv >/dev/null 2>&1; then echo "uv"; return 0; fi
  local c p
  # 3.13 down to 3.10 are the tested range; the newest Python and a plain `python3` are tried last, because a very
  # new Python may not have wheels for every pinned package yet (the install then fails with a clear message)
  for c in python3.13 python3.12 python3.11 python3.10 python3.14 python3.15 python3; do
    p="$(command -v "$c" 2>/dev/null || true)"
    [ -n "$p" ] && "$p" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null && { echo "$p"; return 0; }
  done
  return 1
}
PYSRC="$(find_python || true)"

if [ "$VENV_ONLY" = 1 ]; then
  [ -n "$PYSRC" ] || { echo "no Python 3.10+ found. Run:  brew install uv   (no Homebrew: curl -LsSf https://astral.sh/uv/install.sh | sh)" >&2; exit 3; }
  [ "$DRY" = 1 ] && { echo "would create the shared venv at $VENV"; exit 0; }
  if [ ! -x "$PYV" ]; then
    mkdir -p "$DATA" || exit 1
    if [ "$PYSRC" = uv ]; then uv venv --quiet --python 3.12 "$VENV" || exit 1; else "$PYSRC" -m venv "$VENV" || exit 1; fi
  fi
  echo "shared venv ready at $VENV"; exit 0
fi

step "Semantic memory search: plan"
say "   agent folder:  ${PLAN_LABEL:-$AGENT_DIR}"
say "   venv:          $VENV   (shared by every agent; about 160 MB)"
say "   packages:      $PKGS"
say "   model:         $MODEL_NAME  ($MODEL, about ${MODEL_MB} MB, ${DIM} dimensions, MIT licence)"
say "   model cache:   $DATA/models/fastembed"
say "   index:         ${PLAN_LABEL:-$AGENT_DIR}/.index/memory.db   (first index: about 1-3 minutes for ~500 notes)"
if [ -n "$PYSRC" ]; then
  if [ "$PYSRC" = uv ]; then say "   python:        uv (managed CPython 3.12, about 30 MB if not cached)"; else say "   python:        $PYSRC"; fi
else
  say "   python:        NONE FOUND (need 3.10+; Apple's python3 is 3.9)"
fi
say "   job:           $([ "$DO_JOB" = 1 ] && echo 'enable talos-memory-index in Chronos, if Chronos is installed' || echo 'skipped (--no-job)')"

if [ -z "$PYSRC" ]; then
  say ""
  say "Semantic search needs Python 3.10 or newer, and a stock Mac only has Apple's 3.9. Run this one command:"
  say ""
  say "    brew install uv"
  say ""
  say "(no Homebrew: curl -LsSf https://astral.sh/uv/install.sh | sh. Prefer plain Python: brew install python@3.12.)"
  say "Then run this again:  bash $AGENT_DIR/scripts/memory/setup.sh"
  say "Nothing is broken meanwhile: grep search (scripts/recall.py, scripts/wiki-search.sh) works as it is."
  [ "$DRY" = 1 ] && exit 0
  exit 3
fi
if [ "$DRY" = 1 ]; then say ""; say "Dry run: nothing was created."; exit 0; fi

# ---- venv
step "Python environment"
have_pkgs() { "$PYV" -c 'import fastembed, sqlite_vec, apsw' >/dev/null 2>&1; }
if [ -x "$PYV" ] && have_pkgs; then
  say "   venv already has the packages: $PYV"
  : > "$VENV/.talos-memory-ok"
else
  mkdir -p "$DATA" || { echo "cannot create $DATA" >&2; exit 1; }
  if [ ! -x "$PYV" ]; then
    if [ "$PYSRC" = uv ]; then uv venv --quiet --python 3.12 "$VENV" || { echo "uv could not create the venv" >&2; exit 1; }
    else "$PYSRC" -m venv "$VENV" || { echo "could not create the venv with $PYSRC" >&2; exit 1; }; fi
  fi
  "$PYV" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' \
    || { echo "the existing venv at $VENV uses a Python older than 3.10. Remove it (rm -rf \"$VENV\") and run this again." >&2; exit 1; }
  say "   installing the pinned packages (about 160 MB)"
  if command -v uv >/dev/null 2>&1; then uv pip install --quiet --python "$PYV" $PKGS || { echo "package install failed" >&2; exit 1; }
  else "$PYV" -m pip install --quiet --disable-pip-version-check $PKGS || { echo "package install failed" >&2; exit 1; }; fi
  have_pkgs || { echo "installed, but the packages do not import; look above" >&2; exit 1; }
  # a marker that THIS venv has the memory-search packages: the venv is shared, and a voice-only venv has none of
  # them, so "the python exists" must not be mistaken for "memory search is installed"
  : > "$VENV/.talos-memory-ok"
  say "   ok"
fi

# ---- model
step "Embedding model ($MODEL_NAME)"
( cd "$AGENT_DIR/scripts/memory" && "$PYV" - "$MODEL_NAME" <<'PYEOF'
import sys
import mem_common as M
M.get_embedder(sys.argv[1])
print("   model ready in", M.MODEL_CACHE)
PYEOF
) || { echo "model download failed (network?). Re-run this when online; grep search still works." >&2; exit 1; }

# ---- first index
if [ "$DO_INDEX" = 1 ]; then
  step "First index"
  "$PYV" "$AGENT_DIR/scripts/memory/mem_index.py" --full --embed-model "$MODEL" || { echo "indexing failed; see $AGENT_DIR/.index/index.log" >&2; exit 1; }
fi

# ---- the refresh job
if [ "$DO_JOB" = 1 ] && [ -f "${CHRONOS_CONFIG:-$HOME/.config/chronos/config.json}" ] && [ -f "$AGENT_DIR/scripts/talos-jobs.py" ]; then
  step "Chronos job"
  python3 "$AGENT_DIR/scripts/talos-jobs.py" register --agent-dir "$AGENT_DIR" --kit-dir "$AGENT_DIR" >/dev/null 2>&1 || true
  python3 "$AGENT_DIR/scripts/talos-jobs.py" enable talos-memory-index && \
    say "   talos-memory-index enabled (daily 06:41; a plain command, no Claude usage). Disable: python3 scripts/talos-jobs.py disable talos-memory-index" \
    || say "   could not enable the job (register it first: python3 scripts/talos-jobs.py register --agent-dir \"$AGENT_DIR\")"
fi

step "Done"
say "Try:  python3 $AGENT_DIR/scripts/recall.py \"something your notes mention\""
