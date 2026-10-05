#!/usr/bin/env bash
# tts.sh: speak text, or render it to an audio file. Local and free.
#
#   bash scripts/tts.sh play "text"                 speak through the Mac's speakers
#   bash scripts/tts.sh file out.m4a "text"         render to a file (.m4a, .wav, .aiff, or .mp3 with ffmpeg)
#   echo "text" | bash scripts/tts.sh play -        text on stdin
#
# Engines: macOS `say` works with nothing installed. If you ran `bash scripts/voice/setup.sh --kokoro`, the Kokoro
# neural voice (more natural, about 350 MB of models) is used instead, and `say` is the automatic fallback if it
# fails. Force one with TALOS_TTS_ENGINE=say|kokoro. Voices: TALOS_SAY_VOICE (default: the system voice) and
# TALOS_TTS_VOICE (Kokoro, default af_heart).
#
# Long documents: do not speak a whole file. Write a short narration (what a person would say out loud, not a
# raw read of the markdown) and render that. Telegram plays .m4a and .mp3 inline; send it with the reply tool's
# `files`, and also send the same words as text.
set -euo pipefail
MODE="${1:-}"; shift || true
case "$MODE" in play|file) ;; *) echo "usage: tts.sh play \"text\" | tts.sh file out.m4a \"text\"" >&2; exit 2 ;; esac
OUT=""
if [ "$MODE" = file ]; then OUT="${1:?usage: tts.sh file <out> \"text\"}"; shift; fi
if [ "${1:-}" = "-" ]; then TEXT="$(cat)"; else TEXT="$*"; fi
[ -n "$TEXT" ] || { echo "tts.sh: no text" >&2; exit 1; }

DATA="${XDG_DATA_HOME:-$HOME/.local/share}/talos"
KPY="$DATA/venv/bin/python"
KSCRIPT="$(cd "$(dirname "$0")" && pwd)/voice/kokoro_tts.py"
ENGINE="${TALOS_TTS_ENGINE:-auto}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
SRC=""

have_kokoro() { [ -x "$KPY" ] && [ -f "$DATA/models/kokoro/kokoro-v1.0.onnx" ] && [ -f "$DATA/models/kokoro/voices-v1.0.bin" ] && "$KPY" -c 'import kokoro_onnx, soundfile' >/dev/null 2>&1; }
if [ "$ENGINE" != say ] && have_kokoro; then
  if "$KPY" "$KSCRIPT" "$TMP/out.wav" "$TEXT" "${TALOS_TTS_VOICE:-af_heart}" >/dev/null 2>&1; then SRC="$TMP/out.wav"; fi
fi
if [ -z "$SRC" ]; then
  [ "$ENGINE" = kokoro ] && { echo "tts.sh: TALOS_TTS_ENGINE=kokoro but Kokoro is not installed or failed (bash scripts/voice/setup.sh --kokoro)" >&2; exit 1; }
  command -v say >/dev/null 2>&1 || { echo "tts.sh: no speech engine: macOS 'say' is missing and Kokoro is not installed." >&2; exit 1; }
  # `--` ends the options: text that starts with "-" ("-5 degrees today", "-f /etc/hosts") must be spoken, never parsed
  if [ -n "${TALOS_SAY_VOICE:-}" ]; then say -v "$TALOS_SAY_VOICE" -o "$TMP/out.aiff" -- "$TEXT" 2>/dev/null || say -o "$TMP/out.aiff" -- "$TEXT"
  else say -o "$TMP/out.aiff" -- "$TEXT"; fi
  SRC="$TMP/out.aiff"
fi

if [ "$MODE" = play ]; then
  command -v afplay >/dev/null 2>&1 || { echo "tts.sh: afplay not found (macOS only)" >&2; exit 1; }
  afplay "$SRC"
  exit 0
fi
case "$OUT" in
  *.aiff|*.wav) cp "$SRC" "$OUT" ;;
  *.m4a)
    if command -v afconvert >/dev/null 2>&1; then afconvert -f m4af -d aac "$SRC" "$OUT"
    elif command -v ffmpeg >/dev/null 2>&1; then ffmpeg -nostdin -loglevel error -y -i "$SRC" "$OUT"
    else echo "tts.sh: need afconvert (macOS) or ffmpeg for .m4a" >&2; exit 1; fi ;;
  *.mp3)
    command -v ffmpeg >/dev/null 2>&1 || { echo "tts.sh: .mp3 needs ffmpeg (brew install ffmpeg); .m4a needs nothing extra" >&2; exit 1; }
    ffmpeg -nostdin -loglevel error -y -i "$SRC" "$OUT" ;;
  *) echo "tts.sh: output must end in .m4a, .wav, .aiff or .mp3" >&2; exit 2 ;;
esac
echo "$OUT"
