#!/bin/bash
# voice/setup.sh: opt-in voice. Text-to-speech works with macOS `say` and nothing else; this adds a better voice
# and speech-to-text.
#
#   bash scripts/voice/setup.sh --kokoro          Kokoro-82M neural voice: kokoro-onnx + soundfile into the shared
#                                                 Talos venv (the same one memory search uses, Python 3.10+), plus the model
#                                                 (about 325 MB) and voices (about 28 MB), about 350 MB in all
#   bash scripts/voice/setup.sh --stt [MODEL]     download a whisper.cpp model (default base.en, about 150 MB; small.en
#                                                 about 490 MB). You install the program yourself: brew install whisper-cpp ffmpeg
#   --dry-run                                     print what would happen, change nothing
#
# Everything lands under ~/.local/share/talos (XDG_DATA_HOME moves it). Remove it by deleting
# ~/.local/share/talos/models/kokoro and models/ggml-*.bin (and the venv if nothing else uses it).
set -u
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/talos"
VENV="$DATA/venv"; PYV="$VENV/bin/python"
KOKORO=0; STT=0; STT_MODEL=base.en; DRY=0
KOKORO_BASE="${TALOS_KOKORO_BASE:-https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0}"      # overridable for tests
WHISPER_BASE="${TALOS_WHISPER_BASE:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main}"
while [ $# -gt 0 ]; do
  case "$1" in
    --kokoro) KOKORO=1; shift ;;
    --stt) STT=1; shift; case "${1:-}" in ""|--*) ;; *) STT_MODEL="$1"; shift ;; esac ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) awk 'NR>1 { if ($0 ~ /^#/) print; else exit }' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done
[ "$KOKORO" = 1 ] || [ "$STT" = 1 ] || { echo "nothing to do: pass --kokoro and/or --stt (see --help)" >&2; exit 2; }
case "$STT_MODEL" in *[!A-Za-z0-9._-]*|"") echo "bad model name" >&2; exit 2 ;; esac

say() { printf '%s\n' "$*"; }
fetch() { # url dest  -- resumable, atomic, refuses an HTML error page
  local url="$1" dest="$2"
  [ -s "$dest" ] && { say "   already have $(basename "$dest")"; return 0; }
  mkdir -p "$(dirname "$dest")"
  curl -fL --retry 3 -C - -o "$dest.part" "$url" || { echo "download failed: $url" >&2; return 1; }
  mv "$dest.part" "$dest"; say "   downloaded $(basename "$dest")"
}

if [ "$KOKORO" = 1 ]; then
  say "== Kokoro voice"
  say "   packages: kokoro-onnx soundfile (into $VENV)"
  say "   model:    $KOKORO_BASE/kokoro-v1.0.onnx (about 325 MB) and voices-v1.0.bin (about 28 MB) -> $DATA/models/kokoro"
  if [ "$DRY" != 1 ]; then
    if [ ! -x "$PYV" ]; then
      say "   no shared venv yet; creating one (needs Python 3.10+)"
      bash "$(cd "$(dirname "$0")" && pwd)/../memory/setup.sh" --venv-only || { echo "could not create the venv. Install Python 3.10+ with one command (brew install uv) and run this again." >&2; exit 3; }
    fi
    if command -v uv >/dev/null 2>&1; then uv pip install --quiet --python "$PYV" kokoro-onnx soundfile || exit 1
    else "$PYV" -m pip install --quiet --disable-pip-version-check kokoro-onnx soundfile || exit 1; fi
    fetch "$KOKORO_BASE/kokoro-v1.0.onnx" "$DATA/models/kokoro/kokoro-v1.0.onnx" || exit 1
    fetch "$KOKORO_BASE/voices-v1.0.bin" "$DATA/models/kokoro/voices-v1.0.bin" || exit 1
    "$PYV" -c 'import kokoro_onnx, soundfile' || { echo "installed, but kokoro_onnx does not import" >&2; exit 1; }
    say "   ok: scripts/tts.sh will now use Kokoro (TALOS_TTS_ENGINE=say forces the system voice)"
  fi
fi
if [ "$STT" = 1 ]; then
  say "== Speech-to-text (whisper.cpp model $STT_MODEL)"
  say "   model: $WHISPER_BASE/ggml-$STT_MODEL.bin -> $DATA/models/ggml-$STT_MODEL.bin"
  command -v whisper-cli >/dev/null 2>&1 || command -v whisper-cpp >/dev/null 2>&1 || say "   note: whisper.cpp is not installed yet:  brew install whisper-cpp ffmpeg"
  if [ "$DRY" != 1 ]; then fetch "$WHISPER_BASE/ggml-$STT_MODEL.bin" "$DATA/models/ggml-$STT_MODEL.bin" || exit 1; fi
fi
[ "$DRY" = 1 ] && say "Dry run: nothing was changed."
exit 0
