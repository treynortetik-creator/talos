#!/usr/bin/env python3
"""parakeet_run.py: transcribe a 16 kHz mono WAV with NVIDIA Parakeet TDT 0.6B v2 on Apple Silicon (parakeet-mlx).

    python parakeet_run.py in.wav out.json     word-level timings, used by diarize_transcribe.sh
    python parakeet_run.py in.wav --text       plain transcript on stdout, used by scripts/stt.sh

Needs `parakeet-mlx` (bash scripts/voice/setup.sh --parakeet). The weights come from mlx-community/parakeet-tdt-0.6b-v2.
"""
import json
import sys


def main():
    if len(sys.argv) < 3:
        sys.exit("usage: parakeet_run.py in.wav out.json | in.wav --text")
    try:
        from parakeet_mlx import from_pretrained
    except ImportError:
        sys.exit("parakeet_run.py: parakeet-mlx is not installed (Apple Silicon only): bash scripts/voice/setup.sh --parakeet")
    model = from_pretrained("mlx-community/parakeet-tdt-0.6b-v2")
    r = model.transcribe(sys.argv[1], chunk_duration=120, overlap_duration=15)
    if sys.argv[2] == "--text":
        print(r.text.strip())
        return
    out = {"text": r.text, "sentences": [
        {"start": s.start, "end": s.end, "text": s.text,
         "tokens": [{"t": t.text, "start": t.start, "end": t.end} for t in s.tokens]} for s in r.sentences]}
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        json.dump(out, f)
    print("%d sentences" % len(r.sentences))


if __name__ == "__main__":
    main()
