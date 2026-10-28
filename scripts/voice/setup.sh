#!/bin/bash
# voice/setup.sh: opt-in voice. Text-to-speech works with macOS `say` and nothing else; this adds a better voice
# and speech-to-text.
#
#   bash scripts/voice/setup.sh --kokoro          Kokoro-82M neural voice: kokoro-onnx + soundfile into the shared
#                                                 Talos venv (the same one memory search uses, Python 3.10+), plus the model
#                                                 (about 325 MB) and voices (about 28 MB), about 350 MB in all
#   bash scripts/voice/setup.sh --stt [MODEL]     download a whisper.cpp model (default base.en, about 150 MB; small.en
#                                                 about 490 MB). You install the program yourself: brew install whisper-cpp ffmpeg
#   bash scripts/voice/setup.sh --qwen            Qwen3-TTS voice cloning (mlx-audio) into its own venv, ~/.local/share/talos/venv-qwen.
#                                                 Apple Silicon only. You supply your OWN reference clip (see setup/local-models.md)
#   bash scripts/voice/setup.sh --parakeet        Parakeet TDT 0.6B v2 speech-to-text (parakeet-mlx) into ~/.local/share/talos/venv-stt.
#                                                 Apple Silicon only. scripts/stt.sh prefers it over whisper.cpp
#   bash scripts/voice/setup.sh --diarize         sherpa-onnx + two small models so scripts/stt-diarize/diarize_transcribe.sh can label
#                                                 speakers (same venv-stt). Needs --parakeet too for the transcription half
#   --dry-run                                     print what would happen, change nothing
#
# Every option prints its disk, RAM and licence reminders BEFORE it does anything. Nothing is ever installed system-wide;
# nothing runs unless you ask for it by name. TALOS_FORCE_ARCH is a test hook that overrides the detected CPU.
#
# Everything lands under ~/.local/share/talos (XDG_DATA_HOME moves it). Remove it by deleting
# ~/.local/share/talos/models/kokoro and models/ggml-*.bin (and the venv if nothing else uses it).
set -u
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/talos"
VENV="$DATA/venv"; PYV="$VENV/bin/python"
KOKORO=0; STT=0; STT_MODEL=base.en; DRY=0; QWEN=0; PARAKEET=0; DIARIZE=0
ARCH="${TALOS_FORCE_ARCH:-$(uname -m)}"
SHERPA_BASE="${TALOS_SHERPA_BASE:-https://github.com/k2-fsa/sherpa-onnx/releases/download}"
QWEN_MODEL="${TALOS_QWEN_MODEL:-mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit}"
PARAKEET_MODEL="mlx-community/parakeet-tdt-0.6b-v2"
VENV_QWEN="$DATA/venv-qwen"; VENV_STT="$DATA/venv-stt"; VOICEDIR="${XDG_CONFIG_HOME:-$HOME/.config}/talos/voice"
KOKORO_BASE="${TALOS_KOKORO_BASE:-https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0}"      # overridable for tests
WHISPER_BASE="${TALOS_WHISPER_BASE:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main}"
while [ $# -gt 0 ]; do
  case "$1" in
    --kokoro) KOKORO=1; shift ;;
    --stt) STT=1; shift; case "${1:-}" in ""|--*) ;; *) STT_MODEL="$1"; shift ;; esac ;;
    --qwen) QWEN=1; shift ;;
    --parakeet) PARAKEET=1; shift ;;
    --diarize) DIARIZE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) awk 'NR>1 { if ($0 ~ /^#/) print; else exit }' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done
[ "$KOKORO" = 1 ] || [ "$STT" = 1 ] || [ "$QWEN" = 1 ] || [ "$PARAKEET" = 1 ] || [ "$DIARIZE" = 1 ] || { echo "nothing to do: pass --kokoro, --stt, --qwen, --parakeet and/or --diarize (see --help)" >&2; exit 2; }
case "$STT_MODEL" in *[!A-Za-z0-9._-]*|"") echo "bad model name" >&2; exit 2 ;; esac

say() { printf '%s\n' "$*"; }
fetch() { # url dest  -- resumable, atomic, refuses an HTML error page
  local url="$1" dest="$2"
  [ -s "$dest" ] && { say "   already have $(basename "$dest")"; return 0; }
  mkdir -p "$(dirname "$dest")"
  curl -fL --retry 3 -C - -o "$dest.part" "$url" || { echo "download failed: $url" >&2; return 1; }
  mv "$dest.part" "$dest"; say "   downloaded $(basename "$dest")"
}

# ---- Apple Silicon gate: refuse before printing a plan or touching anything
if [ "$QWEN" = 1 ] || [ "$PARAKEET" = 1 ]; then
  if [ "$ARCH" != arm64 ]; then
    echo "refused: --qwen and --parakeet use MLX, which needs an Apple Silicon Mac (this machine reports '$ARCH')." >&2
    echo "         On an Intel Mac use macOS say, Kokoro (--kokoro) and whisper.cpp (--stt); all of those work. See setup/local-models.md" >&2
    exit 4
  fi
fi

# ---- reminders: printed for every new option BEFORE any action. The sizes below are not guesses: where the project has
# no measurement it says so, and you should read the model page before you start.
if [ "$QWEN" = 1 ]; then
  say "== Reminder: Qwen3-TTS voice cloning ($QWEN_MODEL)"
  say "   disk:    not measured for this guide; the model is downloaded from Hugging Face into $DATA/models/hf. Check the model page for the size first."
  say "   RAM:     not measured for this guide; it runs on the GPU/unified memory of your Mac. Close other heavy apps."
  say "   licence: read the model card yourself before you use it. The author recorded Apache-2.0 from the mlx-audio and Qwen listings, not re-checked here."
  say "   voice:   YOU supply the reference clip, and only of a voice you have the right to clone. Talos ships no voice files and no reference audio."
fi
if [ "$PARAKEET" = 1 ]; then
  say "== Reminder: Parakeet speech-to-text ($PARAKEET_MODEL)"
  say "   disk:    about 2.3 GB for the model cache (measured by the author for this model), plus the Python packages. Into $DATA/models/hf and $VENV_STT."
  say "   RAM:     not measured for this guide."
  say "   licence: the model is NVIDIA's; read its model card before you use it (not re-checked here)."
fi
if [ "$DIARIZE" = 1 ]; then
  say "== Reminder: speaker labelling (sherpa-onnx, pyannote segmentation 3.0, a small speaker-embedding model)"
  say "   disk:    not measured for this guide (the two models are small next to Parakeet), plus the Python packages. Into $DATA/models/diarization and $VENV_STT."
  say "   RAM/time: no RAM figure measured; the author saw about 5-10 minutes of CPU per 10 minutes of audio on an M1 laptop."
  say "   licence: read the model pages yourself (not re-checked here). Only record people who know and agree."
fi

mkvenv() { # path -- a dedicated venv under the Talos data folder, never system-wide
  local v="$1" py=""
  [ -x "$v/bin/python" ] && return 0
  if command -v uv >/dev/null 2>&1; then uv venv --quiet --python 3.13 "$v" && return 0; fi
  for c in python3.13 python3.12 python3.11 python3.10; do command -v "$c" >/dev/null 2>&1 && { py="$c"; break; }; done
  if [ -z "$py" ]; then echo "no Python 3.10+ found. One command fixes it: brew install uv   (then run this again)" >&2; return 3; fi
  "$py" -m venv "$v"
}
pipin() { # venv pkg...
  local v="$1"; shift
  if command -v uv >/dev/null 2>&1; then uv pip install --quiet --python "$v/bin/python" "$@"
  else "$v/bin/python" -m pip install --quiet --disable-pip-version-check "$@"; fi
}
prefetch() { # venv repo-id -- download model weights into the Talos HF cache
  HF_HOME="$DATA/models/hf" "$1/bin/python" -c 'import sys; from huggingface_hub import snapshot_download; snapshot_download(sys.argv[1])' "$2"
}

if [ "$QWEN" = 1 ]; then
  say "== Qwen3-TTS"
  say "   venv:     $VENV_QWEN   packages: mlx-audio 'pillow<13' (unpinned mlx-audio; the author hit a Pillow 13 import bug on Python 3.12-3.14)"
  say "   model:    $QWEN_MODEL -> $DATA/models/hf"
  say "   your voice goes in: $VOICEDIR/ref.wav and ref.txt (the exact words spoken in the clip)"
  if [ "$DRY" != 1 ]; then
    mkvenv "$VENV_QWEN" || exit $?
    pipin "$VENV_QWEN" mlx-audio 'pillow<13' || exit 1
    "$VENV_QWEN/bin/python" -c 'import mlx_audio' || { echo "installed, but mlx_audio does not import" >&2; exit 1; }
    prefetch "$VENV_QWEN" "$QWEN_MODEL" || { echo "model download failed; it will be retried on first use" >&2; }
    mkdir -p "$VOICEDIR"
    say "   ok. Last step is yours: put your reference clip at $VOICEDIR/ref.wav and its transcript at ref.txt."
    say "   Until both exist scripts/tts.sh skips Qwen and uses Kokoro or say."
  fi
fi
if [ "$PARAKEET" = 1 ]; then
  say "== Parakeet"
  say "   venv:     $VENV_STT   packages: parakeet-mlx==0.5.3 (version the author tested)"
  say "   model:    $PARAKEET_MODEL -> $DATA/models/hf   (also needs ffmpeg: brew install ffmpeg)"
  if [ "$DRY" != 1 ]; then
    mkvenv "$VENV_STT" || exit $?
    pipin "$VENV_STT" parakeet-mlx==0.5.3 || exit 1
    "$VENV_STT/bin/python" -c 'import parakeet_mlx' || { echo "installed, but parakeet_mlx does not import" >&2; exit 1; }
    prefetch "$VENV_STT" "$PARAKEET_MODEL" || { echo "model download failed; it will be retried on first use" >&2; }
    say "   ok: scripts/stt.sh will now prefer Parakeet (TALOS_STT=whisper forces whisper.cpp)"
  fi
fi
if [ "$DIARIZE" = 1 ]; then
  say "== Speaker labelling"
  say "   venv:     $VENV_STT   packages: sherpa-onnx==1.13.8 (version the author tested) soundfile"
  say "   models:   $SHERPA_BASE/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
  say "             $SHERPA_BASE/speaker-recongition-models/nemo_en_titanet_small.onnx   -> $DATA/models/diarization"
  [ "$PARAKEET" = 1 ] || say "   note: transcription for diarize_transcribe.sh needs --parakeet (Apple Silicon); this option alone only adds the speaker half"
  if [ "$DRY" != 1 ]; then
    mkvenv "$VENV_STT" || exit $?
    pipin "$VENV_STT" sherpa-onnx==1.13.8 soundfile || exit 1
    fetch "$SHERPA_BASE/speaker-recongition-models/nemo_en_titanet_small.onnx" "$DATA/models/diarization/nemo_en_titanet_small.onnx" || exit 1
    if [ ! -f "$DATA/models/diarization/sherpa-onnx-pyannote-segmentation-3-0/model.onnx" ]; then
      fetch "$SHERPA_BASE/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2" "$DATA/models/diarization/seg.tar.bz2" || exit 1
      tar -xjf "$DATA/models/diarization/seg.tar.bz2" -C "$DATA/models/diarization" && rm -f "$DATA/models/diarization/seg.tar.bz2" || { echo "could not unpack the segmentation model" >&2; exit 1; }
    fi
    "$VENV_STT/bin/python" -c 'import sherpa_onnx, soundfile' || { echo "installed, but sherpa_onnx does not import" >&2; exit 1; }
    say "   ok: bash scripts/stt-diarize/diarize_transcribe.sh <audio> [num_speakers]"
  fi
fi

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
    say "   ok: scripts/tts.sh will now use Kokoro (TALOS_TTS=say forces the system voice)"
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
