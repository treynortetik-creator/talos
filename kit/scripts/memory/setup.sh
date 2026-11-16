#!/bin/bash
# setup.sh: turn on semantic memory search for this agent. OPT-IN; grep search works without it.
#
#   bash scripts/memory/setup.sh [--agent-dir DIR] [--embed-model auto|base|small] [--dry-run] [--no-index] [--no-job] [--no-uv-fetch]
#
# What it does, in order (each step is skipped if it is already done):
#   1. finds a Python 3.10+ (the semantic packages need it; Apple's python3 is 3.9):
#        uv, if installed (uses uv's own managed CPython, about 30 MB, never touches the system), else the first
#        python3.13 / 3.12 / 3.11 / 3.10 on PATH (Homebrew, pyenv), then a newer python3.14+ or plain python3 that is 3.10+. If there is none it says so and exits 3.
#        A stock Mac has only Apple's Python 3.9, so ON A MAC with none of the above this script fetches uv 0.13.8 itself:
#        the pinned release asset for this Mac's arch from github.com/astral-sh/uv, checked against a SHA-256 pinned
#        here, unpacked into its own folder ~/.local/share/talos/uv/0.13.8 (uv and uvx; no admin, no installer script run,
#        nothing put on PATH, ~/.local/bin never touched). That uv is called by its full path. If the download fails
#        (a blocked network) or the checksum differs, nothing is kept and it falls through to the message below.
#        --no-uv-fetch (or TALOS_MEMSEARCH_NO_UV_FETCH=1) skips the fetch; off a Mac it is never tried.
#        By hand:  brew install uv  (no Homebrew: curl -LsSf https://astral.sh/uv/install.sh | sh). Alternative: brew install python@3.12.
#        Nothing else breaks: recall.py keeps working, lexical only.
#   2. builds ONE shared venv at ~/.local/share/talos/venv (about 160 MB) and installs pinned packages
#   3. downloads the embedding model into ~/.local/share/talos/models/fastembed (a pinned folder: the default
#      cache is under the system temp dir, which macOS purges)
#   4. runs the first full index into <agent>/.index/memory.db (git-ignored; per agent)
#   5. if Chronos is installed (0.2.1+), enables the talos-memory-index job: a plain daily command that runs
#      scripts/memory/refresh-index.sh, no Claude involved, so it spends no plan usage. Session start and the
#      morning brief also refresh the index. --no-job skips this.
#
#   --embed-model auto   (default) small when this computer has less than 15 GiB of memory, base otherwise. Measured on
#                        a WSL distro: indexing peaks at about 1.5 GB with small and 2.6 GB with base, and the indexer
#                        stops itself at 4 GB; WSL gives its distro half of the PC's memory, so an 8 GB PC sees 4 GB.
#   --embed-model base   BAAI/bge-base-en-v1.5, about 210 MB download, 768 dimensions
#   --embed-model small  BAAI/bge-small-en-v1.5, about 67 MB, 384 dimensions (small computers, impatient people)
#   --dry-run            print exactly what would happen and create nothing
#   --no-index           build the venv and model but do not run the first index
#   --rerank             ALSO download the opt-in reranker model for `recall.py --rerank` (about 571 MB; see fetch-reranker.sh)
#   --venv-only          just create the shared venv (no packages, no model, no index); used by scripts/voice/setup.sh
#
# Remove it again with ./uninstall.sh --remove-memory-search (the per-agent .index/ goes with the agent folder).
# XDG_DATA_HOME moves ~/.local/share. Exit codes: 0 done, 3 no suitable Python (grep search still works), 1 error.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(python3 "$HERE/../_agent_root.py" "$0" 2 2>/dev/null)" || AGENT_DIR="$(cd "$HERE/../.." && pwd)"   # the agent folder, not the plugin release
MODEL=auto; RERANK=0; DRY=0; DO_INDEX=1; DO_JOB=1; PLAN_LABEL=""; VENV_ONLY=0
NO_UV_FETCH=0; [ "${TALOS_MEMSEARCH_NO_UV_FETCH:-}" = 1 ] && NO_UV_FETCH=1
PKGS="fastembed==0.8.0 sqlite-vec==0.1.9 apsw==3.53.1.0"
while [ $# -gt 0 ]; do
  case "$1" in
    --agent-dir) AGENT_DIR="$(cd "${2:?--agent-dir needs a folder}" && pwd)" || { echo "no such folder: $2" >&2; exit 1; }; shift 2 ;;
    --embed-model) MODEL="${2:?}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --no-index) DO_INDEX=0; shift ;;
    --no-job) DO_JOB=0; shift ;;
    --venv-only) VENV_ONLY=1; shift ;;
    --rerank) RERANK=1; shift ;;
    --no-uv-fetch) NO_UV_FETCH=1; shift ;;
    --as-agent-dir) PLAN_LABEL="${2:?}"; shift 2 ;;     # install.sh --dry-run only: what to print as the agent folder
    -h|--help) awk 'NR>1 { if ($0 ~ /^#/) print; else exit }' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done
# auto: the memory THIS system sees (inside WSL, the distro's share of the PC's). TALOS_MEM_BYTES stands in for it in tests.
MODEL_WHY=""
if [ "$MODEL" = auto ]; then
  _mem="${TALOS_MEM_BYTES:-}"
  if [ -z "$_mem" ]; then
    if [ -r /proc/meminfo ]; then _mem="$(awk '/^MemTotal:/ { printf "%.0f", $2 * 1024 }' /proc/meminfo)"
    else _mem="$(sysctl -n hw.memsize 2>/dev/null || true)"; fi
  fi
  case "$_mem" in ''|*[!0-9]*) MODEL=small; MODEL_WHY=" (auto: this computer's memory could not be read, so the small one)" ;;
    *) _gib=$(( _mem >> 30 ))
       if [ "$_gib" -lt 15 ]; then MODEL=small; else MODEL=base; fi
       MODEL_WHY=" (auto: $_gib GiB of memory here; small under 15 GiB)" ;;
  esac
fi
case "$MODEL" in
  base)  MODEL_NAME="BAAI/bge-base-en-v1.5";  MODEL_MB=210; DIM=768 ;;
  small) MODEL_NAME="BAAI/bge-small-en-v1.5"; MODEL_MB=67;  DIM=384 ;;
  *) echo "--embed-model must be auto, base or small" >&2; exit 2 ;;
esac
[ -f "$AGENT_DIR/scripts/memory/mem_index.py" ] || { echo "$AGENT_DIR does not look like a Talos agent folder (no scripts/memory/mem_index.py)" >&2; exit 1; }

DATA="${XDG_DATA_HOME:-$HOME/.local/share}/talos"
VENV="$DATA/venv"
PYV="$VENV/bin/python"
say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

# ---- find a python
UV_VER=0.13.8
UVDIR="$DATA/uv/$UV_VER"        # the fetched uv lives in a Talos-owned folder and is called by its full path: never on PATH, never ~/.local/bin
# uv prints its version as "uv 0.13.8 (<commit> <date> <target>)": the first two words are what is checked
talos_uv_ok() { [ -x "$UVDIR/uv" ] && case "$("$UVDIR/uv" --version 2>/dev/null)" in "uv $UV_VER" | "uv $UV_VER "*) true ;; *) false ;; esac; }
find_python() {
  if command -v uv >/dev/null 2>&1; then echo "uv"; return 0; fi
  local c p
  # 3.13 down to 3.10 are the tested range; the newest Python and a plain `python3` are tried last, because a very
  # new Python may not have wheels for every pinned package yet (the install then fails with a clear message)
  for c in python3.13 python3.12 python3.11 python3.10 python3.14 python3.15 python3; do
    p="$(command -v "$c" 2>/dev/null || true)"
    [ -n "$p" ] && "$p" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null && { echo "$p"; return 0; }
  done
  talos_uv_ok && { echo "$UVDIR/uv"; return 0; }
  return 1
}
PYSRC="$(find_python || true)"

# ---- no usable Python on a Mac: fetch a pinned uv into $UVDIR (no admin, nothing run from the download but uv itself)
FETCH_NOTE=""; FETCH_FAIL=""; FETCH_TMP=""
fetch_clean() { [ -z "$FETCH_TMP" ] || rm -rf "$FETCH_TMP"; FETCH_TMP=""; }
fetch_uv() {
  local asset sum tmp pack arm oldtrap
  # Rosetta: a shell run as x86_64 on an Apple-silicon Mac still wants the native uv
  arm="$(sysctl -n hw.optional.arm64 2>/dev/null || true)"
  case "$arm:$(uname -m)" in
    1:*|*:arm64|*:aarch64) asset=uv-aarch64-apple-darwin.tar.gz; sum=6b71028a6b904f2ae3340ef52e595512de807d06c0a20eaef2f692581b246558 ;;
    *:x86_64) asset=uv-x86_64-apple-darwin.tar.gz; sum=a04c2ffeac28b2003a2c13caf538ab425fcd7def3e4a41571f4a8fb370a66af3 ;;
    *) FETCH_FAIL="no uv download for this Mac's processor ($(uname -m))"; return 1 ;;
  esac
  pack="${asset%.tar.gz}"
  if [ "$DRY" = 1 ]; then FETCH_NOTE="would fetch uv $UV_VER into $UVDIR (no admin; checked against its published SHA-256)"; return 0; fi
  oldtrap="$(trap -p EXIT INT TERM)"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/talos-uv.XXXXXX")" || { FETCH_FAIL="could not download uv (no temp folder)"; return 1; }
  FETCH_TMP="$tmp"; trap 'fetch_clean' EXIT; trap 'fetch_clean; exit 130' INT; trap 'fetch_clean; exit 143' TERM
  fetch_uv_get "$asset" "$sum" "$tmp" "$pack"; local rc=$?
  fetch_clean; trap - EXIT INT TERM; [ -z "$oldtrap" ] || eval "$oldtrap"
  return $rc
}
fetch_uv_get() { # asset sum tmp pack: sets FETCH_FAIL / FETCH_NOTE
  local asset="$1" sum="$2" tmp="$3" pack="$4" own="" url stage
  # A test hands in its own tarball and its sum; only a path inside the test sandbox is taken, and the real download
  # below never has an override.
  # (the sandbox must exist and the tarball must be a plain file, not a link: a missing sandbox or a link must never widen it)
  if [ -n "${TALOS_TEST_SANDBOX:-}" ] && [ -d "$TALOS_TEST_SANDBOX" ] && [ -n "${TALOS_UV_TEST_TARBALL:-}" ] \
    && [ -n "${TALOS_UV_TEST_SHA256:-}" ] && [ -f "$TALOS_UV_TEST_TARBALL" ] && [ ! -L "$TALOS_UV_TEST_TARBALL" ]; then
    local sbx; sbx="$(cd "$TALOS_TEST_SANDBOX" 2>/dev/null && pwd -P)"
    own="$(cd "$(dirname "$TALOS_UV_TEST_TARBALL")" 2>/dev/null && pwd -P)/$(basename "$TALOS_UV_TEST_TARBALL")"
    case "$own" in "$sbx"/*) [ -n "$sbx" ] || own="" ;; *) own="" ;; esac
  fi
  if [ -n "$own" ] && [ -f "$own" ]; then
    cp "$own" "$tmp/$asset" || { FETCH_FAIL="could not download uv (test tarball)"; return 1; }
    sum="$TALOS_UV_TEST_SHA256"
  else
    url="https://github.com/astral-sh/uv/releases/download/$UV_VER/$asset"
    if ! curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 180 -o "$tmp/$asset" "$url" 2>/dev/null; then
      FETCH_FAIL="could not download uv (network?)"; return 1
    fi
  fi
  if ! ( cd "$tmp" && printf '%s  %s\n' "$sum" "$asset" | shasum -a 256 -c - >/dev/null 2>&1 ); then
    FETCH_FAIL="the downloaded uv did not match its published checksum: not used"; return 1
  fi
  if ! tar -xzf "$tmp/$asset" -C "$tmp" 2>/dev/null || [ ! -f "$tmp/$pack/uv" ] || [ ! -f "$tmp/$pack/uvx" ]; then
    FETCH_FAIL="the downloaded uv could not be unpacked: not used"; return 1
  fi
  # a broken copy from an earlier run goes first; both files are staged, then the folder appears in one move
  rm -rf "$UVDIR"
  stage="$UVDIR.new.$$"
  # (another run that put a good uv in place meanwhile wins: this one's copy is dropped, never moved inside it)
  if ! mkdir -p "$stage" || ! cp "$tmp/$pack/uv" "$tmp/$pack/uvx" "$stage/" || ! chmod +x "$stage/uv" "$stage/uvx" \
    || { [ -e "$UVDIR" ] && rm -rf "$stage" && talos_uv_ok; } || ! mv "$stage" "$UVDIR"; then
    [ -d "$stage" ] || { talos_uv_ok && FETCH_NOTE="uv $UV_VER is in $UVDIR (another run put it there)" && return 0; }
    rm -rf "$stage"; rmdir "$DATA/uv" 2>/dev/null
    FETCH_FAIL="could not put uv into $UVDIR"; return 1
  fi
  FETCH_NOTE="uv $UV_VER fetched into $UVDIR (no admin; checked against its published SHA-256); it then downloads its own Python 3.12 (about 30 MB)"
}
if [ -z "$PYSRC" ] && [ "$NO_UV_FETCH" != 1 ] && [ "$(uname -s)" = Darwin ]; then
  if fetch_uv; then
    if [ "$DRY" = 1 ]; then PYSRC="$UVDIR/uv"; else PYSRC="$(find_python || true)"; fi
  fi
fi
# UVBIN: the uv to call ("uv" from PATH, or the Talos-owned one by full path); empty when the python is a plain interpreter
UVBIN=""; case "$PYSRC" in uv|"$UVDIR/uv") UVBIN="$PYSRC" ;; esac

if [ "$VENV_ONLY" = 1 ]; then
  [ -n "$PYSRC" ] || { [ -z "$FETCH_FAIL" ] || echo "$FETCH_FAIL" >&2; echo "no Python 3.10+ found. Run:  brew install uv   (no Homebrew: curl -LsSf https://astral.sh/uv/install.sh | sh)" >&2; exit 3; }
  [ "$DRY" = 1 ] && { echo "would create the shared venv at $VENV"; exit 0; }
  if [ ! -x "$PYV" ]; then
    mkdir -p "$DATA" || exit 1
    if [ -n "$UVBIN" ]; then "$UVBIN" venv --quiet --seed --python 3.12 "$VENV" || exit 1; else "$PYSRC" -m venv "$VENV" || exit 1; fi
  fi
  echo "shared venv ready at $VENV"; exit 0
fi

step "Semantic memory search: plan"
say "   agent folder:  ${PLAN_LABEL:-$AGENT_DIR}"
say "   venv:          $VENV   (shared by every agent; about 160 MB)"
say "   packages:      $PKGS"
say "   model:         $MODEL_NAME  ($MODEL, about ${MODEL_MB} MB, ${DIM} dimensions, MIT licence)$MODEL_WHY"
say "   model cache:   $DATA/models/fastembed"
say "   index:         ${PLAN_LABEL:-$AGENT_DIR}/.index/memory.db   (first index: about 1-3 minutes for ~500 notes)"
if [ -n "$PYSRC" ]; then
  if [ -n "$FETCH_NOTE" ]; then say "   python:        $FETCH_NOTE"
  elif [ -n "$UVBIN" ]; then say "   python:        uv (managed CPython 3.12, about 30 MB if not cached)"; else say "   python:        $PYSRC"; fi
else
  say "   python:        NONE FOUND (need 3.10+; Apple's python3 is 3.9)"
fi
say "   reranker:      $([ "$RERANK" = 1 ] && echo 'download bge-reranker-v2-m3 int8 (about 571 MB) for recall.py --rerank' || echo 'not requested (add --rerank for recall.py --rerank)')"
say "   job:           $([ "$DO_JOB" = 1 ] && echo 'enable talos-memory-index in Chronos, if Chronos is installed' || echo 'skipped (--no-job)')"

if [ -z "$PYSRC" ]; then
  say ""
  [ -z "$FETCH_FAIL" ] || say "$FETCH_FAIL"
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
    if [ -n "$UVBIN" ]; then "$UVBIN" venv --quiet --seed --python 3.12 "$VENV" || { echo "uv could not create the venv" >&2; exit 1; }
    else "$PYSRC" -m venv "$VENV" || { echo "could not create the venv with $PYSRC" >&2; exit 1; }; fi
  fi
  "$PYV" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' \
    || { echo "the existing venv at $VENV uses a Python older than 3.10. Remove it (rm -rf \"$VENV\") and run this again." >&2; exit 1; }
  say "   installing the pinned packages (about 160 MB)"
  if [ -n "$UVBIN" ]; then "$UVBIN" pip install --quiet --python "$PYV" $PKGS || { echo "package install failed" >&2; exit 1; }
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

if [ "$RERANK" = 1 ]; then
  step "Reranker model"
  bash "$AGENT_DIR/scripts/memory/fetch-reranker.sh" || say "   the reranker download failed; search works without it. Retry: bash scripts/memory/fetch-reranker.sh"
fi

step "Done"
say "Try:  python3 $AGENT_DIR/scripts/recall.py \"something your notes mention\""
