#!/usr/bin/env python3
"""qwen_tts.py: render text to a WAV with Qwen3-TTS (voice cloning) through mlx-audio. Optional, Apple Silicon only.

    ~/.local/share/talos/venv-qwen/bin/python scripts/voice/qwen_tts.py out.wav "text" ref.wav ref.txt

ref.wav is a short, clean recording of a voice YOU have the right to clone; ref.txt holds exactly the words spoken
in it. Talos ships neither. Environment: TALOS_QWEN_MODEL (default mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit),
HF_HOME (scripts/tts.sh points it at ~/.local/share/talos/models/hf). The model is downloaded on first use if
scripts/voice/setup.sh --qwen has not already fetched it. scripts/tts.sh calls this and falls back to Kokoro or
macOS `say` if it fails. mlx-audio is imported only when it is needed.
"""
import glob
import os
import subprocess
import sys

DEFAULT_MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit"


def main():
    if len(sys.argv) < 5:
        sys.exit('usage: qwen_tts.py out.wav "text" ref.wav ref.txt')
    out, text, ref_wav, ref_txt = sys.argv[1:5]
    for p in (ref_wav, ref_txt):
        if not os.path.isfile(p):
            sys.exit("qwen_tts.py: reference file not found: %s" % p)
    try:
        import mlx_audio  # noqa: F401  (lazy: only to give a clear message when it is absent)
    except ImportError:
        sys.exit("qwen_tts.py: mlx-audio is not installed (Apple Silicon only): bash scripts/voice/setup.sh --qwen")
    with open(ref_txt, encoding="utf-8") as f:
        ref_text = f.read().strip()
    model = os.environ.get("TALOS_QWEN_MODEL") or DEFAULT_MODEL
    outdir = os.path.join(os.path.dirname(os.path.abspath(out)), ".qwen-" + str(os.getpid()))
    os.makedirs(outdir, exist_ok=True)
    cmd = [sys.executable, "-m", "mlx_audio.tts.generate", "--model", model, "--text", text,
           "--ref_audio", ref_wav, "--ref_text", ref_text, "--lang_code", "en",
           "--output_path", outdir, "--file_prefix", "out", "--audio_format", "wav", "--join_audio"]
    try:
        r = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, universal_newlines=True)
        made = sorted(glob.glob(os.path.join(outdir, "out*.wav")))
        if r.returncode != 0 or not made or os.path.getsize(made[0]) == 0:
            tail = (r.stderr or "").strip().splitlines()[-1:] or ["no audio produced"]
            sys.exit("qwen_tts.py: generation failed: %s" % tail[0])
        os.replace(made[0], out)
    finally:
        for p in glob.glob(os.path.join(outdir, "*")):
            try:
                os.remove(p)
            except OSError:
                pass
        try:
            os.rmdir(outdir)
        except OSError:
            pass
    print(out)


if __name__ == "__main__":
    main()
