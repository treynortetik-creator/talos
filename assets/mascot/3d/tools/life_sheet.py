#!/usr/bin/env python3
"""A labelled contact sheet of the idle antics, from frames the REAL sprite view drew (CompanionAnticGuiTests, TALOS_RENDER_OUT=DIR).

  python3 tools/life_sheet.py FRAMES_DIR OUT_DIR [--manifest apps/desktop/Resources/companion/companion.json]

Writes OUT_DIR/life-sheet-normal.png (every new frame at the size it has on screen, 1x and 2x, on the app's dark ground #141110) and one
OUT_DIR/life-sheet-3x-<clip>.png per clip (the 2x frames magnified 3x, nearest neighbour). Each tile says clip, column and, under it,
the milliseconds the manifest holds that column for. Frames the manifest uses but the view did not draw are listed and exit 1.
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

GROUND = (0x14, 0x11, 0x10, 255)
FONT = '/System/Library/Fonts/Supplemental/Arial.ttf'
CLIPS = ['sit', 'nap', 'stretch', 'scratch', 'stumble', 'tinker', 'sleep', 'wake', 'wake-low']


def tiles(frames, m, clip, scale):
    out, missing = [], []
    ms = {}
    for col, t in m['clips'][clip]['frames']:
        ms[col] = ms.get(col, 0) + t
    for col in sorted(ms):
        p = os.path.join(frames, 'life-%s-%d-%dx.png' % (clip, col, scale))
        if os.path.exists(p):
            out.append((col, ms[col], Image.open(p).convert('RGBA')))
        else:
            missing.append(p)
    return out, missing


def sheet(rows, mag, label_h=34):
    """rows: [(title, [(col, ms, img)])] -> one image; every tile magnified `mag` times"""
    font = ImageFont.truetype(FONT, 15)
    small = ImageFont.truetype(FONT, 12)
    cw = max(i.width for _, ts in rows for _, _, i in ts) * mag + 8
    ch = max(i.height for _, ts in rows for _, _, i in ts) * mag + label_h
    per = max(len(ts) for _, ts in rows)
    im = Image.new('RGBA', (per * cw + 8, len(rows) * (ch + 22) + 8), GROUND)
    d = ImageDraw.Draw(im)
    for r, (title, ts) in enumerate(rows):
        y = 8 + r * (ch + 22)
        d.text((8, y), title, font=font, fill=(243, 230, 207, 255))
        for k, (col, ms, img) in enumerate(ts):
            x = 8 + k * cw
            big = img.resize((img.width * mag, img.height * mag), Image.NEAREST)
            im.alpha_composite(big, (x, y + 22))
            d.text((x + 2, y + 22 + big.height + 2), 'col %d  %d ms' % (col, ms), font=small, fill=(200, 190, 170, 255))
    return im.convert('RGB')


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    frames, out = args[0], args[1]
    man = sys.argv[sys.argv.index('--manifest') + 1] if '--manifest' in sys.argv else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..', 'apps', 'desktop', 'Resources', 'companion', 'companion.json')
    m = json.load(open(man))
    os.makedirs(out, exist_ok=True)
    all_missing = []
    normal = []
    for scale in (1, 2):
        for clip in CLIPS:
            t, miss = tiles(frames, m, clip, scale)
            all_missing += miss
            normal.append(('%s  (%dx render, on screen size)' % (clip, scale), t))
    sheet(normal, 1).save(os.path.join(out, 'life-sheet-normal.png'))
    for clip in CLIPS:
        t, _ = tiles(frames, m, clip, 2)
        sheet([('%s  (2x render, shown 3x)' % clip, t)], 3).save(os.path.join(out, 'life-sheet-3x-%s.png' % clip))
    if all_missing:
        print('MISSING frames the manifest uses:\n  ' + '\n  '.join(all_missing))
        sys.exit(1)
    print('sheets in', out)


if __name__ == '__main__':
    main()
