#!/usr/bin/env bash
# stt.sh: transcribe an audio file (a Telegram voice note, a recording) locally. Free, on-device, nothing is sent anywhere.
#
#   bash scripts/stt.sh <audio-file> [whisper-model]     whisper model default: base.en (about 150 MB; small.en is better, 490 MB)
#
# Engines, tried in this order, each skipped when it is not installed (suggested, never required):
#   parakeet  NVIDIA Parakeet TDT 0.6B v2 via parakeet-mlx (English, Apple Silicon): bash scripts/voice/setup.sh --parakeet
#   whisper   whisper.cpp:  brew install whisper-cpp ffmpeg   then   bash scripts/voice/setup.sh --stt [base.en|small.en]
# Force one with TALOS_STT=parakeet|whisper|auto (default auto). If Parakeet fails in auto mode, whisper.cpp is tried.
# ffmpeg converts any input format to the 16 kHz mono WAV both engines need. Prints the transcript on stdout.
# For "who said what" use scripts/stt-diarize/diarize_transcribe.sh. Guide: setup/local-models.md
set -euo pipefail
AUDIO="${1:?usage: stt.sh <audio-file> [model]}"
NAME="${2:-base.en}"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/talos"
MODEL="$DATA/models/ggml-${NAME}.bin"
PKPY="$DATA/venv-stt/bin/python"
PKSCRIPT="$(cd "$(dirname "$0")" && pwd)/stt-diarize/parakeet_run.py"
ENGINE="${TALOS_STT:-auto}"
case "$ENGINE" in auto|parakeet|whisper) ;; *) echo "stt.sh: TALOS_STT must be auto, parakeet or whisper (got '$ENGINE')" >&2; exit 2 ;; esac
WHISPER="$(command -v whisper-cli || command -v whisper-cpp || true)"
have_parakeet() { [ -x "$PKPY" ] && [ -f "$PKSCRIPT" ] && "$PKPY" -c 'import parakeet_mlx' >/dev/null 2>&1; }

USE_PK=0; USE_WH=0
if [ "$ENGINE" != whisper ] && have_parakeet; then USE_PK=1; fi
if [ "$ENGINE" != parakeet ] && [ -n "$WHISPER" ]; then USE_WH=1; fi
if [ "$ENGINE" = parakeet ] && [ "$USE_PK" = 0 ]; then
  echo "stt.sh: TALOS_STT=parakeet but Parakeet is not installed (Apple Silicon: bash scripts/voice/setup.sh --parakeet)" >&2; exit 1
fi
if [ "$USE_PK" = 0 ] && [ "$USE_WH" = 0 ]; then
  if [ "$ENGINE" = whisper ]; then echo "stt.sh: TALOS_STT=whisper but whisper-cli not found (brew install whisper-cpp)" >&2; exit 1; fi
  echo "stt.sh: no speech-to-text engine installed. Pick one (both are optional):" >&2
  echo "  whisper.cpp: brew install whisper-cpp ffmpeg && bash scripts/voice/setup.sh --stt" >&2
  echo "  Parakeet (Apple Silicon): bash scripts/voice/setup.sh --parakeet     see setup/local-models.md" >&2
  exit 1
fi
command -v ffmpeg >/dev/null 2>&1 || { echo "stt.sh: ffmpeg not found (brew install ffmpeg)" >&2; exit 1; }
if [ "$USE_PK" = 0 ]; then
  [ -f "$MODEL" ] || { echo "stt.sh: model missing: $MODEL (bash scripts/voice/setup.sh --stt $NAME)" >&2; exit 1; }
fi
[ -f "$AUDIO" ] || { echo "stt.sh: audio file not found: $AUDIO" >&2; exit 1; }
TMPD="$(mktemp -d)"; WAV="$TMPD/in.wav"; trap 'rm -rf "$TMPD"' EXIT
ffmpeg -nostdin -loglevel error -y -i "$AUDIO" -ar 16000 -ac 1 -c:a pcm_s16le "$WAV"

if [ "$USE_PK" = 1 ]; then
  if HF_HOME="${HF_HOME:-$DATA/models/hf}" "$PKPY" "$PKSCRIPT" "$WAV" --text 2>"$TMPD/pk.err" > "$TMPD/pk.txt" && [ -s "$TMPD/pk.txt" ]; then
    cat "$TMPD/pk.txt"; exit 0
  fi
  [ "$ENGINE" = parakeet ] && { echo "stt.sh: Parakeet failed: $(tail -n 1 "$TMPD/pk.err")" >&2; exit 1; }
  echo "stt.sh: Parakeet failed ($(tail -n 1 "$TMPD/pk.err")); trying whisper.cpp" >&2
  if [ "$USE_WH" = 0 ] || [ ! -f "$MODEL" ]; then echo "stt.sh: whisper.cpp is not set up either (brew install whisper-cpp; bash scripts/voice/setup.sh --stt)" >&2; exit 1; fi
fi
"$WHISPER" -m "$MODEL" -f "$WAV" -nt -np -l en 2>/dev/null | sed 's/^[[:space:]]*//'
