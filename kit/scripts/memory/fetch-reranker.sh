#!/bin/bash
# fetch-reranker.sh: download the OPT-IN reranker model for `recall.py --rerank`. Nothing else needs it.
#
#   bash scripts/memory/fetch-reranker.sh [--dry-run] [--if-enough-memory]
#
#   --if-enough-memory  the installer's default: skip (one line, exit 3) on a computer with under 3 GiB of memory, or when its
#                       memory cannot be read. Without it, an explicit run always downloads.
#
# Model: bge-reranker-v2-m3, int8 ONNX export (about 571 MB of disk; about 1.7 GB of RAM while it sorts the top 15, 15-40 s
# per query on 4 CPUs), from the
# onnx-community/bge-reranker-v2-m3-ONNX repository on Hugging Face (a community export of BAAI/bge-reranker-v2-m3;
# read the model card for the licence before you use it). Saved to ${XDG_DATA_HOME:-~/.local/share}/talos/models/
# bge-reranker-v2-m3-int8/. It also needs the semantic search stack (bash scripts/memory/setup.sh): onnxruntime and
# tokenizers come with it. Delete the folder to remove it. Exit codes: 0 done, 1 error, 3 skipped for memory.
set -u
DRY=0; MEMGATE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --if-enough-memory) MEMGATE=1; shift ;;
    -h|--help) awk 'NR>1 { if ($0 ~ /^#/) print; else exit }' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "usage: fetch-reranker.sh [--dry-run] [--if-enough-memory]" >&2; exit 2 ;;
  esac
done
if [ "$MEMGATE" = 1 ]; then
  # the memory THIS system sees (inside WSL, the distro's share of the PC's); TALOS_MEM_BYTES stands in for it in tests
  _mem="${TALOS_MEM_BYTES:-}"
  if [ -z "$_mem" ]; then
    if [ -r /proc/meminfo ]; then _mem="$(awk '/^MemTotal:/ { printf "%.0f", $2 * 1024 }' /proc/meminfo)"
    else _mem="$(sysctl -n hw.memsize 2>/dev/null || true)"; fi
  fi
  _why=""
  case "$_mem" in
    ''|*[!0-9]*) _why="this computer's memory could not be read" ;;
    *) _gib=$(( _mem >> 30 ))
       [ "$_gib" -lt 3 ] && _why="$_gib GiB of memory here; it needs about 2 GB while it sorts" ;;
  esac
  if [ -n "$_why" ]; then
    if [ "$DRY" = 1 ]; then echo "reranker: would be skipped ($_why). Add it later: bash scripts/memory/fetch-reranker.sh"; exit 0; fi
    echo "reranker: skipped ($_why). Add it later: bash scripts/memory/fetch-reranker.sh"; exit 3
  fi
fi
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/talos/models/bge-reranker-v2-m3-int8"
BASE="https://huggingface.co/onnx-community/bge-reranker-v2-m3-ONNX/resolve/main"
echo "reranker model: bge-reranker-v2-m3 (int8 ONNX)"
echo "  disk:   about 571 MB in $DEST"
echo "  source: $BASE   (check the model card for its licence)"
echo "  files:  tokenizer.json, config.json, onnx/model_int8.onnx"
if [ "$DRY" = 1 ]; then echo "Dry run: nothing was downloaded."; exit 0; fi
command -v curl >/dev/null 2>&1 || { echo "curl not found" >&2; exit 1; }
mkdir -p "$DEST/onnx" || exit 1
get() {   # $1 = path under the repo, $2 = local file
  [ -s "$2" ] && { echo "  have $1"; return 0; }
  echo "  fetching $1"
  curl -fL --retry 2 -o "$2.part" "$BASE/$1" && mv "$2.part" "$2" || { rm -f "$2.part"; echo "download of $1 failed" >&2; return 1; }
}
get tokenizer.json "$DEST/tokenizer.json" && get config.json "$DEST/config.json" && get onnx/model_int8.onnx "$DEST/onnx/model_int8.onnx" || exit 1
# the install's marker means "wanted and not there yet": done now, so the doctor stops warning
HERE="$(cd "$(dirname "$0")" && pwd)"
_agent="$(python3 "$HERE/../_agent_root.py" "$0" 2 2>/dev/null)" && [ -n "$_agent" ] && rm -f "$_agent/.index/.rerank-wanted"
echo "done. Try: python3 scripts/recall.py \"what did we decide about ...\" --rerank"
