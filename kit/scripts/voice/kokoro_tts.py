#!/usr/bin/env python3
"""kokoro_tts.py: render text to a WAV with the Kokoro-82M ONNX model (local, on-device). Optional voice engine.

    ~/.local/share/talos/venv/bin/python scripts/voice/kokoro_tts.py out.wav "text to speak" [voice]

Needs `kokoro-onnx` and `soundfile` in the shared Talos venv and the two model files in
~/.local/share/talos/models/kokoro/ (scripts/voice/setup.sh --kokoro installs all of it). scripts/tts.sh calls this
and falls back to macOS `say` if anything is missing. Default voice: af_heart (a US English voice); others include
af_bella, am_adam, am_michael, bf_emma, bm_george.
"""
import os
import sys


def models_dir():
    base = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    return os.path.join(base, "talos", "models", "kokoro")


def main():
    if len(sys.argv) < 3:
        sys.exit('usage: kokoro_tts.py out.wav "text" [voice]')
    out, text = sys.argv[1], sys.argv[2]
    voice = sys.argv[3] if len(sys.argv) > 3 else "af_heart"
    from kokoro_onnx import Kokoro
    import soundfile as sf
    d = models_dir()
    k = Kokoro(os.path.join(d, "kokoro-v1.0.onnx"), os.path.join(d, "voices-v1.0.bin"))
    samples, rate = k.create(text, voice=voice, speed=1.0, lang="en-us")
    sf.write(out, samples, rate)
    print(out)


if __name__ == "__main__":
    main()
