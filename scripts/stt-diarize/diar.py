#!/usr/bin/env python3
"""diar.py: who spoke when, with sherpa-onnx (pyannote segmentation 3.0 + a speaker-embedding model). On-device.

    python diar.py in.wav out.json [num_speakers]      num_speakers -1 (default) = automatic

Writes [[start, end, speaker], ...]. Models: $XDG_DATA_HOME/talos/models/diarization/ (bash scripts/voice/setup.sh
--diarize). The automatic speaker count can over-split quiet or low-bitrate audio; pass the real number when you know it.
"""
import json
import os
import sys
from collections import Counter


def main():
    if len(sys.argv) < 3:
        sys.exit("usage: diar.py in.wav out.json [num_speakers]")
    try:
        import sherpa_onnx
        import soundfile as sf
    except ImportError:
        sys.exit("diar.py: sherpa-onnx / soundfile are not installed: bash scripts/voice/setup.sh --diarize")
    n = int(sys.argv[3]) if len(sys.argv) > 3 else -1
    d = os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"), "talos", "models", "diarization")
    seg = os.path.join(d, "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx")
    emb = os.path.join(d, "nemo_en_titanet_small.onnx")
    for p in (seg, emb):
        if not os.path.isfile(p):
            sys.exit("diar.py: model missing: %s (bash scripts/voice/setup.sh --diarize)" % p)
    cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=seg), num_threads=4),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=emb, num_threads=4),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=n, threshold=0.5),
        min_duration_on=0.3, min_duration_off=0.5)
    sd = sherpa_onnx.OfflineSpeakerDiarization(cfg)
    audio, rate = sf.read(sys.argv[1], dtype="float32")
    if rate != sd.sample_rate:
        sys.exit("diar.py: expected %d Hz audio, got %d (diarize_transcribe.sh converts for you)" % (sd.sample_rate, rate))
    segs = [(s.start, s.end, s.speaker) for s in sd.process(audio).sort_by_start_time()]
    with open(sys.argv[2], "w") as f:
        json.dump(segs, f)
    c = Counter()
    for a, b, k in segs:
        c[k] += b - a
    print(len(segs), "segments", {k: round(v) for k, v in c.items()})


if __name__ == "__main__":
    main()
