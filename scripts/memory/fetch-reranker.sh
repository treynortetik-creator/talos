#!/bin/bash
# fetch-reranker.sh: download the OPT-IN reranker model for `recall.py --rerank`. Nothing else needs it.
#
#   bash scripts/memory/fetch-reranker.sh [--dry-run]
#
# Model: bge-reranker-v2-m3, int8 ONNX export (about 571 MB of disk; RAM while scoring not measured), from the
# onnx-community/bge-reranker-v2-m3-ONNX repository on Hugging Face (a community export of BAAI/bge-reranker-v2-m3;
# read the model card for the licence before you use it). Saved to ${XDG_DATA_HOME:-~/.local/share}/talos/models/
# bge-reranker-v2-m3-int8/. It also needs the semantic search stack (bash scripts/memory/setup.sh): onnxruntime and
# tokenizers come with it. Delete the folder to remove it. Exit codes: 0 done, 1 error.
set -u
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
[ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] && { awk 'NR>1 { if ($0 ~ /^#/) print; else exit }' "$0" | sed 's/^# \{0,1\}//'; exit 0; }
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
echo "done. Try: python3 scripts/recall.py \"what did we decide about ...\" --rerank"
