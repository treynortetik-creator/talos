# Suggested local models (all optional)

Talos works with none of these. Each one is a suggestion that makes one thing better (a nicer voice, a more accurate
transcript, smarter search), and each is installed only if you run its command. Nothing here is downloaded
automatically, by `install.sh` or by a hook, unless you pass the flag yourself. Everything runs on your machine; no
audio or text leaves it.

Numbers below are either stated by the model's own page or measured by the author on the machine named next to
them. Where Talos has no measurement it says "not measured": read the model page before you download.
Apple Silicon (M1 or newer) is called out where a model needs it.

## Summary

| Model | Role | RAM | Disk | Needs Apple Silicon | Required? |
|---|---|---|---|---|---|
| Parakeet TDT 0.6B v2 (parakeet-mlx) | speech-to-text, English | not measured | about 2.3 GB model cache (author's measurement) plus Python packages | yes | no |
| sherpa-onnx diarization | label who spoke | not measured | not measured (small next to Parakeet) | no (the transcription half needs it) | no |
| whisper.cpp base.en / small.en | speech-to-text fallback | not measured | about 150 MB / 490 MB model, plus the `whisper-cpp` program | no | no |
| Qwen3-TTS 1.7B via mlx-audio | voice cloning from your own clip | not measured | not measured; check the model page | yes | no |
| Kokoro-82M | neural text-to-speech | not measured | about 350 MB (325 MB model, 28 MB voices) | no | no |
| macOS `say` | text-to-speech, last resort | negligible | none, ships with macOS | no | no |
| bge-base / bge-small via fastembed + sqlite-vec | semantic memory search | not measured | about 210 MB / 67 MB model, shared venv about 160 MB | no | no |
| bge-reranker-v2-m3 (int8 ONNX) | optional re-sort of search results (`recall.py --rerank`) | not measured | about 571 MB | no | no |

## What you get with nothing installed

- **Voice out:** `bash scripts/tts.sh play "text"` and `file out.m4a "text"` use macOS `say`. Not pretty, fully working.
- **Voice in:** `bash scripts/stt.sh note.ogg` prints a message listing your two options and exits; nothing else breaks.
  Voice notes can still be listened to by you.
- **Memory search:** `scripts/recall.py` uses plain text search (grep style). Fast, exact words only.
- **Speaker labels:** `scripts/stt-diarize/diarize_transcribe.sh` says which pieces are missing and how to add them.

Every script prints a one-line reason when it skips something it could not use, and falls through to the next choice.

## Speech to text

Order tried by `scripts/stt.sh`: Parakeet if installed, then whisper.cpp. Force one with `TALOS_STT=parakeet|whisper`
(default `auto`). If Parakeet fails in auto mode, whisper.cpp is tried.

### Parakeet TDT 0.6B v2 (preferred when present)

- **What:** NVIDIA's English speech recognition model, run on the Mac GPU through `parakeet-mlx` (weights
  `mlx-community/parakeet-tdt-0.6b-v2`). The author chose it over whisper large-v3-turbo because it is English-only,
  faster on Apple Silicon and more accurate on English in a single comparison (checked 2026-10-02 against NVIDIA's
  model card and the Hugging Face Open ASR leaderboard; on one 10.7-minute phone-quality call it did not invent filler
  words and its word timestamps were correct). That is one test, not a benchmark.
- **For:** voice notes, meeting recordings, anything you want transcribed accurately. It also gives word timings, which
  the speaker-labelling extra needs.
- **Needs:** Apple Silicon, `ffmpeg`, Python 3.10+ (uv manages one for you). Model cache about 2.3 GB (author's
  measurement). RAM: not measured.
- **Intel Macs:** not supported. Use whisper.cpp.
- **Install (opt-in):** `bash scripts/voice/setup.sh --parakeet` (add `--dry-run` first). It builds a dedicated venv at
  `~/.local/share/talos/venv-stt` with `parakeet-mlx==0.5.3` (the version tested) and pre-fetches the model into
  `~/.local/share/talos/models/hf`. Nothing is installed system-wide.
- **Talos uses it:** `scripts/stt.sh <audio>` automatically.
- **Without it:** whisper.cpp, below.
- **Licence:** NVIDIA's model; the Hugging Face listing for the MLX conversion shows CC-BY-4.0 (checked 2026-10-28). Read the model card before use.

### whisper.cpp (fallback, works on Intel too)

- **What:** the C++ port of OpenAI Whisper. Models `base.en` (about 150 MB) and `small.en` (about 490 MB, better).
- **Install (opt-in):** `brew install whisper-cpp ffmpeg`, then `bash scripts/voice/setup.sh --stt` (or `--stt small.en`).
- **Talos uses it:** `scripts/stt.sh <audio> [model]`. The author's earlier setup saw one pass on a 159-second clip
  silently drop most of the words, and fixed it by transcribing long files in 25-second pieces; Talos does not do that
  yet, so for long recordings prefer Parakeet or split the file yourself.
- **Without it:** `stt.sh` prints the "no engine installed" message.
- **Licence:** MIT for whisper.cpp; check the model page for the weights.

### Speaker labels: sherpa-onnx diarization (extra)

- **What:** works out who spoke when (pyannote segmentation 3.0 plus a small speaker-embedding model, run by
  `sherpa-onnx`), then merges that with Parakeet's word timings.
- **For:** meetings and interviews: `bash scripts/stt-diarize/diarize_transcribe.sh meeting.m4a 3` prints
  `[00:01:05] Speaker 2: ...` lines. Labels are by first appearance; rename them by hand.
- **Tell it the number of speakers when you know it.** The author saw automatic counting split low-bitrate audio into
  far too many speakers. Speed seen on an M1 laptop: about 5-10 minutes of CPU for 10 minutes of audio. RAM and disk for
  this half: not measured.
- **Needs:** `--parakeet` as well (Apple Silicon) for the transcript. `--diarize` alone installs only the speaker half,
  which has no Apple Silicon requirement.
- **Install (opt-in):** `bash scripts/voice/setup.sh --parakeet --diarize`. Adds `sherpa-onnx==1.13.8` and `soundfile` to the
  same `venv-stt`, and downloads two small models into `~/.local/share/talos/models/diarization`. The download
  addresses are the ones the sherpa-onnx project publishes on its GitHub releases page; they were not fetched while
  writing this guide, so `--dry-run` first and expect to adjust if the project moved them.
- **Without it:** the script lists what is missing and exits. `stt.sh` is unaffected.
- **Licence and consent:** read each model page. Recording and labelling people is a consent question as well as a
  technical one.
- The author also tried pyannote community-1 (more accurate on the author's synthetic 6-speaker test) but it needs a
  separate venv and a model download with its own licence (CC-BY-4.0 per its listing). It is not part of this extra.

## Text to speech

Order tried by `scripts/tts.sh`: Qwen3-TTS, then Kokoro, then macOS `say`, skipping any that is not installed.
Choose with `TALOS_TTS=qwen|kokoro|say|auto` (default `auto`). A forced engine that is missing is an error; in auto mode
a failing engine falls through to the next. `play` and `file out.m4a "text"` work the same whichever engine speaks.

### Qwen3-TTS 1.7B, voice cloning (preferred when set up)

- **What:** Qwen's text-to-speech model, run through `mlx-audio` (model `mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit`;
  override with `TALOS_QWEN_MODEL`). It speaks in the voice of a short reference recording, so the voice stays the same
  from message to message.
- **Your voice, your responsibility:** Talos ships no voice files and no reference audio, and never will. You must supply
  your OWN reference clip, of a voice you have the right to clone (your own, or someone who agreed in writing). Cloning
  a voice without permission can be illegal and is unkind. Also read the model card's licence yourself before use.
  The author recorded Apache-2.0 from the mlx-audio and Qwen listings; that was not re-checked for this guide and
  is not legal advice.
- **Where the clip goes:** `${XDG_CONFIG_HOME:-~/.config}/talos/voice/ref.wav` (a short, clean, single-speaker recording)
  and `ref.txt` (exactly the words spoken in it). With no clip, Qwen is skipped with a one-line note on stderr.
- **Needs:** Apple Silicon (MLX), Python 3.10+. The author hit a Pillow 13 import problem on Python 3.12-3.14, so the
  installer asks for Python 3.13 (via uv) and `pillow<13`. RAM and disk: not measured; check the model page.
  Speed on an M5 laptop with 32 GB (the author's test, a related 6-bit VoiceDesign variant, not this exact Base model):
  a 5-second clip in 3.9 seconds once the model was cached; the audio transcribed back word-perfect.
- **Intel Macs:** not supported. Use Kokoro or `say`.
- **Install (opt-in):** `bash scripts/voice/setup.sh --qwen` (add `--dry-run` first). Dedicated venv at
  `~/.local/share/talos/venv-qwen`; model in `~/.local/share/talos/models/hf`. `mlx-audio` is not version-pinned.
- **Talos uses it:** `scripts/tts.sh` through `scripts/voice/qwen_tts.py`.
- **Without it:** Kokoro, then `say`.

### Kokoro-82M (the middle option)

- **What:** a small neural voice that runs through ONNX on any Mac. About 350 MB: the 325 MB model plus 28 MB of voices.
  Default voice `af_heart`; `TALOS_TTS_VOICE` picks another (`am_adam`, `am_michael`, `bf_emma`, `bm_george`...).
- **Speed:** about 7 seconds per clip on the author's 16 GB M1 laptop.
- **Needs:** Python 3.10+ (the shared Talos venv). Works on Intel Macs.
- **Install (opt-in):** `bash scripts/voice/setup.sh --kokoro`, or `./install.sh --with-voice`.
- **Without it:** `say`.
- **Licence:** check the model page.

### macOS `say` (last resort)

Ships with macOS; no setup. `TALOS_SAY_VOICE` picks a system voice.

## Semantic memory search

- **What:** embeddings turn your notes into vectors so a vague question ("what did we decide about the vendor") can find
  the right note even when the words differ. `bge-base-en-v1.5` (about 210 MB, 768 dimensions) or `bge-small-en-v1.5`
  (about 67 MB, 384 dimensions), run by `fastembed`, stored with `sqlite-vec` in a shared venv (about 160 MB).
- **Install (opt-in):** the existing flag, not a new one: `./install.sh --with-memory-search [--embed-model small]`, or
  `bash scripts/memory/setup.sh`. Details, flags and removal: [`memory-search.md`](memory-search.md).
- **Without it:** `scripts/recall.py` falls back to plain text search.
- **Optional reranker:** `bash scripts/memory/setup.sh --rerank` (or `./install.sh --with-reranker`) downloads
  bge-reranker-v2-m3 as an int8 ONNX file (about 571 MB; the Hugging Face listing is the community export
  `onnx-community/bge-reranker-v2-m3-ONNX`, size checked 2026-10-28; read its model card for the licence). Then
  `python3 scripts/recall.py "what did we decide about X" --rerank` re-sorts the top 15 files by their best chunk. It costs
  several seconds a query and is opt-in per query. On the author's fixed set of 33 questions (one machine, one wiki, so a
  hint and not a promise) it helped vague "what did we decide" questions a lot and hurt exact name and file lookups, so
  ask for it on the former. Swapping bge-base for Qwen3-Embedding-0.6B was a wash there, and Talos does not ship that.
- **RAM:** not measured. **Licence:** check the model pages.

## Removing things

Delete what you installed: `~/.local/share/talos/venv-qwen`, `venv-stt`, `models/hf`, `models/diarization`,
`models/kokoro`, `models/ggml-*.bin`, and your own `~/.config/talos/voice/` clip. Nothing else was changed.
Keep the shared `venv` if memory search uses it.

## Checked versus inferred

- Checked by the author on their own machines: the versions `parakeet-mlx 0.5.3` and `sherpa-onnx 1.13.8`, the 2.3 GB
  Parakeet cache, the Kokoro and whisper sizes, the speeds named above.
- Not run for this guide: any real download or install. `bash scripts/test-localmodels.sh` tests the scripts against fake
  programs only.
