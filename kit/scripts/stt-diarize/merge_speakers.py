#!/usr/bin/env python3
"""merge_speakers.py: word timings (parakeet_run.py) + speaker segments (diar.py) -> speaker-labelled text.

    python merge_speakers.py parakeet.json diar.json [out.txt]      prints to stdout when no out file is given

Each word goes to the speaker whose segment overlaps it most; tiny sandwiched runs (2 words or fewer, under 1.2 s)
are absorbed into the surrounding speaker. Labels are Speaker 1, Speaker 2, ... by first appearance.
"""
import json
import sys


def main():
    if len(sys.argv) < 3:
        sys.exit("usage: merge_speakers.py parakeet.json diar.json [out.txt]")
    with open(sys.argv[1], encoding="utf-8") as f:
        P = json.load(f)
    with open(sys.argv[2], encoding="utf-8") as f:
        D = json.load(f)
    words = []
    for s in P["sentences"]:
        for t in s["tokens"]:
            if t["t"].startswith(" ") or not words or words[-1]["end"]:
                words.append({"a": t["start"], "b": t["end"], "w": t["t"].strip(), "end": False})
            else:
                words[-1]["w"] += t["t"]
                words[-1]["b"] = t["end"]
        if words:
            words[-1]["end"] = True
    if not words:
        sys.exit("merge_speakers.py: the transcript has no words")
    if not D:
        D = [[0.0, words[-1]["b"], 0]]

    def spk(t0, t1):
        best, bo = None, 0
        for a, b, k in D:
            o = min(b, t1) - max(a, t0)
            if o > bo:
                bo, best = o, k
        if best is None:
            m = (t0 + t1) / 2
            best = min(D, key=lambda x: min(abs(x[0] - m), abs(x[1] - m)))[2]
        return best

    for w in words:
        w["k"] = spk(w["a"], w["b"])

    def runs():
        r = []
        for w in words:
            if r and r[-1][0] == w["k"]:
                r[-1][1].append(w)
            else:
                r.append([w["k"], [w]])
        return r

    changed = True
    while changed:
        changed = False
        R = runs()
        for i in range(1, len(R) - 1):
            k, ws = R[i]
            if R[i - 1][0] == R[i + 1][0] != k and len(ws) <= 2 and ws[-1]["b"] - ws[0]["a"] < 1.2:
                for w in ws:
                    w["k"] = R[i - 1][0]
                changed = True
                break
    order = {}
    for w in words:
        order.setdefault(w["k"], len(order) + 1)
    lines = []
    for k, ws in runs():
        t = int(ws[0]["a"])
        lines.append("[%02d:%02d:%02d] Speaker %d: %s" % (t // 3600, t % 3600 // 60, t % 60, order[k], " ".join(w["w"] for w in ws)))
    text = "\n".join(lines) + "\n"
    if len(sys.argv) > 3:
        with open(sys.argv[3], "w", encoding="utf-8") as f:
            f.write(text)
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
