#!/usr/bin/env bash
# diarize_transcribe.sh: audio file -> speaker-labelled transcript on stdout. Local, free, optional.
#
#   bash scripts/stt-diarize/diarize_transcribe.sh <audio> [num_speakers] [-o out.txt]
#
# Parakeet TDT v2 (parakeet-mlx) transcribes with word timings; sherpa-onnx works out who spoke when; the two are
# merged into lines like "[00:01:05] Speaker 2: ...". num_speakers is optional but strongly recommended when you
# know it (automatic counting can over-split). Needs Apple Silicon and:
#   bash scripts/voice/setup.sh --parakeet --diarize        (and ffmpeg: brew install ffmpeg)
# Nothing leaves the machine. Work files are temporary and removed.
set -euo pipefail
AUDIO=""; NSPK=-1; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) OUT="${2:?-o needs a file}"; shift 2 ;;
    -h|--help) awk 'NR>1 { if ($0 ~ /^#/) print; else exit }' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) if [ -z "$AUDIO" ]; then AUDIO="$1"; else NSPK="$1"; fi; shift ;;
  esac
done
[ -n "$AUDIO" ] || { echo "usage: diarize_transcribe.sh <audio> [num_speakers] [-o out.txt]" >&2; exit 2; }
case "$NSPK" in -1|[1-9]|[1-9][0-9]) ;; *) echo "diarize_transcribe.sh: num_speakers must be a whole number" >&2; exit 2 ;; esac
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/talos"
PY="$DATA/venv-stt/bin/python"
export HF_HOME="${HF_HOME:-$DATA/models/hf}"

MISSING=""
command -v ffmpeg >/dev/null 2>&1 || MISSING="$MISSING ffmpeg(brew install ffmpeg)"
if [ ! -x "$PY" ]; then MISSING="$MISSING parakeet-mlx+sherpa-onnx(no $DATA/venv-stt)"
else
  "$PY" -c 'import parakeet_mlx' >/dev/null 2>&1 || MISSING="$MISSING parakeet-mlx"
  "$PY" -c 'import sherpa_onnx, soundfile' >/dev/null 2>&1 || MISSING="$MISSING sherpa-onnx"
fi
[ -f "$DATA/models/diarization/nemo_en_titanet_small.onnx" ] && [ -f "$DATA/models/diarization/sherpa-onnx-pyannote-segmentation-3-0/model.onnx" ] || MISSING="$MISSING diarization-models"
if [ -n "$MISSING" ]; then
  echo "diarize_transcribe.sh: missing:$MISSING" >&2
  echo "  fix: bash scripts/voice/setup.sh --parakeet --diarize   (Apple Silicon; --dry-run shows what it would do)" >&2
  exit 1
fi
[ -f "$AUDIO" ] || { echo "diarize_transcribe.sh: audio file not found: $AUDIO" >&2; exit 1; }

W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
ffmpeg -nostdin -loglevel error -y -i "$AUDIO" -ar 16000 -ac 1 -c:a pcm_s16le "$W/audio16k.wav"
echo "[1/3] transcribing (Parakeet)" >&2; "$PY" "$HERE/parakeet_run.py" "$W/audio16k.wav" "$W/parakeet.json" >&2
echo "[2/3] working out who spoke when (sherpa-onnx)" >&2; "$PY" "$HERE/diar.py" "$W/audio16k.wav" "$W/diar.json" "$NSPK" >&2
echo "[3/3] merging" >&2
if [ -n "$OUT" ]; then "$PY" "$HERE/merge_speakers.py" "$W/parakeet.json" "$W/diar.json" "$OUT"; echo "$OUT"
else "$PY" "$HERE/merge_speakers.py" "$W/parakeet.json" "$W/diar.json"; fi
