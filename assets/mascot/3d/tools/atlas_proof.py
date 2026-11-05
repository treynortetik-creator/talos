#!/usr/bin/env python3
"""Real-size proof of the desktop companion atlases (DESKTOP-COMPANION-SPEC 11.1 acceptance 4).

  python3 tools/atlas_proof.py sheet <atlas_dir> <out.png> <photo>   every state at 1:1 (one atlas pixel = one screen pixel at 2x)
                                                                     on white, black and a photo, every tile labelled
  python3 tools/atlas_proof.py real <atlas_dir> <out_dir> <photo>    REAL-SIZE proof: real-<2x|1x>-<white|black|photo>.png, one small PNG per
                                                                     backdrop with the density tag set (144 dpi for 2x, 72 dpi for 1x), so a
                                                                     viewer at 100% shows 1 point = 1 point on a Retina panel. Every state's
                                                                     still, the ember layer ON at its resting opacity, and Mini at 44 pt
  python3 tools/atlas_proof.py frames <atlas_dir> <out_dir> <photo>  PNG frames of every state playing its hold table (25 fps), labelled
  then:  bash scripts/claude-code/proof.sh clip <out_dir>/%05d.png ...  or ffmpeg, to make the 720p mp4

The label is burned into the pixels (ffmpeg here has no drawtext).
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FONT = '/System/Library/Fonts/Supplemental/Arial.ttf'
FPS = 25
ORDER = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review', 'talking', 'statue', 'landed']
NOTE = {'idle': 'Ready (blinks every ~12 s)', 'running-right': 'Rounds, walking right', 'running-left': 'Rounds, walking left',
        'waving': 'Hello / Needs you', 'jumping': 'Done (first 4 frames = Poke hop)', 'failed': 'Down / Trouble',
        'waiting': 'Needs you (holds)', 'running': 'Working (one strike per 2 s)', 'review': 'Fidget', 'talking': 'Bubble appears',
        'statue': 'Asleep / quiet', 'landed': 'Dropped'}


def load(d):
    m = json.load(open(os.path.join(d, 'companion.json')))
    at = {k: Image.open(os.path.join(d, v['files']['2x'])).convert('RGBA') for k, v in m['atlases'].items()}
    return m, at


def cellimg(m, at, clip, col, scale='2x'):
    w, h = m['cell'][scale]
    c = m['clips'][clip]
    return at[c['atlas']].crop((col * w, c['row'] * h, (col + 1) * w, (c['row'] + 1) * h))


def mini(m, at, k):
    s = m['atlases']['mini']['cell']['2x'][0]
    return at['mini'].crop((k * s, 0, (k + 1) * s, s))


def label(img, text, size=15):
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(FONT, size)
    w = d.textlength(text, font=f)
    d.rectangle((0, 0, w + 12, size + 8), fill=(0, 0, 0))
    d.text((6, 3), text, font=f, fill=(255, 255, 255))


def cmd_sheet(d, out, photo):
    m, at = load(d)
    w, h = m['cell']['2x']
    tiles = []
    for name in ORDER:
        c = m['clips'][name]
        for col in sorted({c['still']} | {f[0] for f in c['frames'][:1]}):
            tiles.append((name, col))
    bgs = [('white', Image.new('RGBA', (1, 1), (255, 255, 255, 255))), ('black', Image.new('RGBA', (1, 1), (0, 0, 0, 255))),
           ('photo', Image.open(photo).convert('RGBA'))]
    per = 6
    rows = (len(tiles) + per - 1) // per
    pad = 6
    W = per * (w + pad) + pad
    H = rows * (h + 24 + pad) + pad
    panels = []
    for bname, bg in bgs:
        sheet = bg.resize((W, H)) if bname != 'photo' else bg.resize((W, int(W * bg.height / bg.width))).crop((0, 0, W, H))
        for i, (name, col) in enumerate(tiles):
            x = pad + (i % per) * (w + pad); y = pad + (i // per) * (h + 24 + pad)
            sheet.alpha_composite(cellimg(m, at, name, col), (x, y + 22))
            label(sheet, '', 1)
            lab = Image.new('RGBA', (w, 20), (0, 0, 0, 255))
            ImageDraw.Draw(lab).text((4, 2), '%s #%d on %s' % (name, col, bname), font=ImageFont.truetype(FONT, 13), fill=(255, 255, 255))
            sheet.alpha_composite(lab, (x, y))
        panels.append(sheet)
    # mini row
    out_img = Image.new('RGBA', (W * 3 + 8, H), (40, 40, 40, 255))
    for i, p in enumerate(panels):
        out_img.paste(p, (i * (W + 4), 0))
    out_img.convert('RGB').save(out)
    print('sheet', out, out_img.size)


EMBER_REST = 0.6          # the proof shows the ember layer on, at a resting opacity (the real value is C-PANEL's)
REAL_PER_ROW = 6


def _with_ember(base, em, alpha):
    if em is None:
        return base
    a = em.copy()
    px = a.load()
    for y in range(a.height):
        for x in range(a.width):
            r, g, b, al = px[x, y]
            if al:
                px[x, y] = (r, g, b, int(al * alpha))
    out = base.copy()
    out.alpha_composite(a)
    return out


def real_sheet(d, scale, bgname, bg):
    """one real-size sheet: the 12 stills (ember on), then Mini's four states (ember on where there is one)"""
    m = json.load(open(os.path.join(d, 'companion.json')))
    sc = '%dx' % scale
    at = {k: Image.open(os.path.join(d, v['files'][sc])).convert('RGBA') for k, v in m['atlases'].items()}
    w, h = m['cell'][sc]
    ms = m['atlases']['mini']['cell'][sc][0]
    pad = 8
    lab_h = 16
    font = ImageFont.truetype(FONT, 11 if scale == 2 else 9)
    tiles = []
    for name in ORDER:
        c = m['clips'][name]
        body = cellimg(m, at, name, c['still'], sc)
        em = None
        if 'ember' in c:
            k = c['ember']['cell']
            em = at['ember'].crop((k * w, 0, (k + 1) * w, h))
        tiles.append(('%s' % name, _with_ember(body, em, EMBER_REST), w, h))
    mm = m['atlases']['mini']
    for k, state in enumerate(mm['states']):
        body = at['mini'].crop((k * ms, 0, (k + 1) * ms, ms))
        em = at['mini-ember'].crop((k * ms, 0, (k + 1) * ms, ms)) if state in m['atlases']['mini-ember']['states'] else None
        tiles.append(('mini %s' % state, _with_ember(body, em, EMBER_REST), ms, ms))
    W = REAL_PER_ROW * (w + pad) + pad
    rows = []
    cur = []
    for t in tiles:
        cur.append(t)
        if len(cur) == REAL_PER_ROW:
            rows.append(cur); cur = []
    if cur:
        rows.append(cur)
    H = pad + sum(max(t[3] for t in r) + lab_h + pad for r in rows)
    sheet = bg.convert('RGBA').resize((W, H)) if bgname != 'photo' else bg.convert('RGBA').resize((W, int(W * bg.height / bg.width))).crop((0, 0, W, H))
    y = pad
    for r in rows:
        rh = max(t[3] for t in r)
        for i, (lab, img, tw, th) in enumerate(r):
            x = pad + i * (w + pad)
            plate = Image.new('RGBA', (int(ImageDraw.Draw(sheet).textlength(lab, font=font)) + 8, lab_h - 2), (0, 0, 0, 255))
            ImageDraw.Draw(plate).text((4, 1), lab, font=font, fill=(255, 255, 255))
            sheet.alpha_composite(plate, (x, y))
            sheet.alpha_composite(img, (x + (w - tw) // 2, y + lab_h + (rh - th)))
        y += rh + lab_h + pad
    return sheet.convert('RGB')


def cmd_real(d, out, photo):
    os.makedirs(out, exist_ok=True)
    bgs = [('white', Image.new('RGB', (1, 1), (255, 255, 255))), ('black', Image.new('RGB', (1, 1), (0, 0, 0))), ('photo', Image.open(photo).convert('RGB'))]
    for scale, dpi in ((2, 144), (1, 72)):
        for bname, bg in bgs:
            img = real_sheet(d, scale, bname, bg)
            path = os.path.join(out, 'real-%dx-%s.png' % (scale, bname))
            img.save(path, dpi=(dpi, dpi))
            print('real', path, img.size, '%d dpi' % dpi)


def cmd_frames(d, out, photo):
    m, at = load(d)
    os.makedirs(out, exist_ok=True)
    for f in os.listdir(out):
        os.remove(os.path.join(out, f))
    bg = Image.open(photo).convert('RGBA').resize((1280, 720))
    n = 0
    w, h = m['cell']['2x']
    k = 2   # shown at 2x of the retina pixels so a 720p video is readable; the sheet is the 1:1 proof

    def put(img):
        nonlocal n
        img.convert('RGB').save(os.path.join(out, '%05d.png' % n)); n += 1

    mini_state = {'idle': 0, 'running-right': 0, 'running-left': 0, 'waving': 0, 'jumping': 0, 'failed': 1, 'waiting': 2, 'running': 0,
                  'review': 0, 'talking': 0, 'statue': 3, 'landed': 0}
    for name in ORDER:
        c = m['clips'][name]
        seq = list(c['frames'])
        reps = 1 if not c['loop'] else 3
        timeline = []
        if name == 'idle':
            seq = [(0, 900), (1, 90), (2, 140), (1, 90), (0, 700)]     # a blink, not 12 s of staring
        for _ in range(reps):
            timeline += seq
        if name in ('waiting',):
            timeline = [(0, 900), (1, 700), (0, 900), (2, 140), (0, 700)]
        if not c['loop']:
            timeline += [(c['still'], 900)]
        total = sum(ms for _, ms in timeline)
        t = 0.0
        frames = int(total / 1000 * FPS)
        for fi in range(frames):
            tt = fi * 1000.0 / FPS
            acc = 0
            col = timeline[-1][0]
            for cc, ms in timeline:
                if tt < acc + ms:
                    col = cc; break
                acc += ms
            fr = bg.copy()
            sprite = cellimg(m, at, name, col).resize((w * k, h * k), Image.NEAREST)
            fr.alpha_composite(sprite, (320 - w * k // 2, 340 - h * k // 2))
            ms_img = mini(m, at, mini_state[name]).resize((88 * k, 88 * k), Image.NEAREST)
            fr.alpha_composite(ms_img, (900, 380))
            label(fr, '%s: %s   (frame col %d)' % (name, NOTE[name], col), 22)
            lab = Image.new('RGBA', (300, 28), (0, 0, 0, 255))
            ImageDraw.Draw(lab).text((6, 4), 'Mini (tondo) for this state', font=ImageFont.truetype(FONT, 16), fill=(255, 255, 255))
            fr.alpha_composite(lab, (900, 346))
            put(fr)
    print('frames', n, out)


if __name__ == '__main__':
    a = sys.argv[1:]
    if a and a[0] == 'sheet':
        cmd_sheet(a[1], a[2], a[3])
    elif a and a[0] == 'real':
        cmd_real(a[1], a[2], a[3])
    elif a and a[0] == 'frames':
        cmd_frames(a[1], a[2], a[3])
    else:
        print(__doc__); sys.exit(2)
