#!/bin/bash
# Little Talos 3D: rebuild everything with one command (see README.md).
#   bash assets/mascot/3d/build.sh            full build: talos.blend, frames, web assets, previews, contact sheet
#   python3 assets/mascot/3d/tools/atlas.py build   the desktop companion atlases (apps/desktop/Resources/companion)
#   CLIPS=idle,wave bash .../build.sh         only some clips (frames + web for those; previews/contact for all present)
# Env: BLENDER (default: blender on PATH, else /opt/homebrew/bin/blender), SUPER (3), CELL (512), WEB (256),
#      RENDER_DIR (raw passes, not committed; default $TMPDIR/talos-render), PROOF (path to a proof.sh for labelled MP4 previews;
#      without it the previews are made with plain ffmpeg and no label).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; M="$(dirname "$HERE")"
BLENDER=${BLENDER:-$(command -v blender || echo /opt/homebrew/bin/blender)}
SUPER=${SUPER:-3}; CELL=${CELL:-512}; WEB=${WEB:-256}
R=${RENDER_DIR:-${TMPDIR:-/tmp}/talos-render}
CLIPARG=(); [ -n "${CLIPS:-}" ] && CLIPARG=(--clip "$CLIPS")
t0=$(date +%s)
# no --save here: a plain-web Blender run only knows the 8 web actions, so saving from it (and then skipping the second save on a partial
# CLIPS= build) used to strip the d_* actions out of the committed talos.blend. The blend is written once, by the desktop-aware run below.
"$BLENDER" -b --factory-startup -P "$HERE/talos_build.py" -- --render clips --out "$R" \
  --super "$SUPER" --cell "$CELL" ${CLIPARG[@]+"${CLIPARG[@]}"} 2>&1 | grep -E "\[talos\]|Error|rror" || true
# the saved scene carries the web clips AND the desktop companion's d_* actions (TALOS_DESKTOP=1; nothing is rendered): see tools/atlas.py.
# A partial build (CLIPS=...) leaves talos.blend alone.
if [ -z "${CLIPS:-}" ]; then
  TALOS_DESKTOP=1 "$BLENDER" -b --factory-startup -P "$HERE/talos_build.py" -- --save "$HERE/talos.blend" --render none 2>&1 | grep -E "\[talos\] (saved|built)|rror" || true
fi
python3 "$HERE/tools/finish.py" compose "$R" "$M/frames" --cell "$CELL" ${CLIPS:+--clip "$CLIPS"}
python3 "$HERE/tools/finish.py" pack "$M/frames" "$M/web" "$R/meta.json" --web "$WEB"
cp "$R/meta.json" "$M/web/talos-clips.meta.json"
python3 "$HERE/tools/finish.py" preview "$M/frames" "$M/preview" "${PROOF:-}" --meta "$R/meta.json"
python3 "$HERE/tools/finish.py" contact "$M/frames" "$M/contact-sheet.png"
echo "built in $(( $(date +%s) - t0 )) s"
