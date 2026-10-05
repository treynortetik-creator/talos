#!/usr/bin/env bash
# stt.sh: transcribe an audio file (a Telegram voice note, a recording) locally with whisper.cpp. Free, on-device.
#
#   bash scripts/stt.sh <audio-file> [model]        model default: base.en (about 150 MB; small.en is better, 490 MB)
#
# One-time setup:  brew install whisper-cpp ffmpeg   then   bash scripts/voice/setup.sh --stt [base.en|small.en]
# which downloads the model to ~/.local/share/talos/models/ggml-<model>.bin. ffmpeg converts any input format to
# the 16 kHz mono WAV whisper.cpp needs. Prints the transcript on stdout; nothing is sent anywhere.
set -euo pipefail
AUDIO="${1:?usage: stt.sh <audio-file> [model]}"
NAME="${2:-base.en}"
MODEL="${XDG_DATA_HOME:-$HOME/.local/share}/talos/models/ggml-${NAME}.bin"
WHISPER="$(command -v whisper-cli || command -v whisper-cpp || true)"
[ -n "$WHISPER" ] || { echo "stt.sh: whisper-cli not found (brew install whisper-cpp)" >&2; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || { echo "stt.sh: ffmpeg not found (brew install ffmpeg)" >&2; exit 1; }
[ -f "$MODEL" ] || { echo "stt.sh: model missing: $MODEL (bash scripts/voice/setup.sh --stt $NAME)" >&2; exit 1; }
[ -f "$AUDIO" ] || { echo "stt.sh: audio file not found: $AUDIO" >&2; exit 1; }
TMPD="$(mktemp -d)"; WAV="$TMPD/in.wav"; trap 'rm -rf "$TMPD"' EXIT
ffmpeg -nostdin -loglevel error -y -i "$AUDIO" -ar 16000 -ac 1 -c:a pcm_s16le "$WAV"
"$WHISPER" -m "$MODEL" -f "$WAV" -nt -np -l en 2>/dev/null | sed 's/^[[:space:]]*//'
