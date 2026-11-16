#!/bin/bash
# refresh-index.sh: refresh this agent's semantic memory index. Run daily by the talos-memory-index Chronos
# job, which is a plain command job (Chronos 0.2.1+): no Claude session starts, so it spends no plan usage.
# You can run it by hand too.
#
#   bash scripts/memory/refresh-index.sh
#
# Incremental: with nothing changed it takes about a second and never loads the model, plus, at most once a day and only when
# the reranker model is downloaded, one timed rerank (15-40 s on a slow computer; mem_rerank.py --probe). Writes only
# <agent folder>/.index/. Exit 0 = index fresh. Exit 1 = memory search is not installed, or the indexer failed
# (the message says which); Chronos then marks the day failed and notifies you per the job's notify setting.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(python3 "$HERE/../_agent_root.py" "$0" 2 2>/dev/null)" || AGENT_DIR="$(cd "$HERE/../.." && pwd)"   # the agent folder, not the plugin release
VENV="${XDG_DATA_HOME:-$HOME/.local/share}/talos/venv"
if [ ! -x "$VENV/bin/python" ] || [ ! -f "$VENV/.talos-memory-ok" ]; then
  echo "memory search is not installed (bash $AGENT_DIR/scripts/memory/setup.sh)"
  exit 1
fi
cd "$AGENT_DIR" || exit 1
"$VENV/bin/python" "$AGENT_DIR/scripts/memory/mem_index.py" --quiet; rc=$?
# the reranker's speed, timed once a day when its model is downloaded and the index is fresh (the probe skips if measured under 20 h ago)
RMD="${TALOS_RERANK_MODEL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/talos/models/bge-reranker-v2-m3-int8}"
if [ "$rc" = 0 ] && [ -f "$RMD/tokenizer.json" ] && [ -f "$RMD/onnx/model_int8.onnx" ]; then
  "$VENV/bin/python" "$AGENT_DIR/scripts/memory/mem_rerank.py" --probe "$AGENT_DIR" || true
fi
exit "$rc"
