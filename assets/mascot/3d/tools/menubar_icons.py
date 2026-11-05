#!/usr/bin/env python3
"""The Mac menu-bar icon: Talos's head as a template image (black, alpha only), one per health state, at 1x and 2x.

  python3 tools/menubar_icons.py [OUT_DIR]               write the 10 PNGs (default apps/desktop/Resources/menubar)
  python3 tools/menubar_icons.py --sheet SHEET.png       also write a labelled contact sheet (light and dark bar, 1x, 2x, 4x zoom)

2x (36 px): the silhouette is taken from apps/web/public/brand/mascot-pleased-512.png (everything that is not the orange ground,
cut off under the chin), so helmet, crest and both ear cups come from the real art; the eyes are discs where the art's amber eyes
are, and the helmet's seams are cut through it. 1x (18 px): drawn by hand on the pixel grid (HEAD_1X below), because a shrunk
render of that detail is a blob. It keeps what the art has: the notched crest, the dome with its brim, two eyes, the ear cups.
Each state adds one simple shape on top of the head, always with a pixel of clear space around it. Files: talos-<state>-1x.png (18 px) and
talos-<state>-2x.png (36 px); the app loads them at 18 pt with isTemplate set, so macOS tints them for light, dark and
highlighted bars. The state names are the asset names in TalosDesktopCore/MenuBarIcon.swift.
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..'))
SOURCE = os.path.join(ROOT, 'apps/web/public/brand/mascot-pleased-512.png')
DEFAULT_OUT = os.path.join(ROOT, 'apps/desktop/Resources/menubar')
STATES = ['ok', 'working', 'needs-you', 'down', 'unknown']
LABELS = {'ok': 'ok', 'working': 'working', 'needs-you': 'needs you', 'down': 'down', 'unknown': 'unknown'}
HEIGHT = 18  # points; the image is square
SS = 16  # supersampling per output pixel
FONT = '/System/Library/Fonts/Supplemental/Arial.ttf'

# Where the head is in the 512 px source (the box holds crest, dome, both ear cups and the chin; the neck is below it).
BOX = (150, 36, 356, 248)
GROUND = np.array([217, 105, 43])
EYE_K = 1.2  # eye hole radius = amber radius x this (the art's cream ring is part of the eye)
LINE = 0.85  # width of a carved seam, in points
# The helmet's cream seams, traced on the art (box pixels) and cut out of the 2x silhouette so the crest, brim and ear cups read as parts.
SEAMS = [
    # crest base against the dome
    [(100, 60), (132, 67), (160, 85), (180, 115), (192, 138)],
    # the brim over the eyes: left ear to the face seam, then up and over to the right ear
    [(22, 120), (45, 107), (70, 102), (85, 115), (120, 108), (150, 118), (170, 138)],
    # ear cups
    [(25, 120), (17, 150), (25, 188)],
    [(172, 146), (167, 175), (178, 200)],
    # face seam
    [(85, 118), (81, 188)],
    # crest ribs
    [(121, 4), (130, 50)],
    [(170, 30), (150, 62)],
    [(195, 82), (170, 92)],
]
SHARP = 1.7  # alpha contrast around 0.5: crisper edges at 1x without hard stairs


def head():
    """-> (mask float 0..1 of the head, [(cx, cy, r)] of the two eyes), both in the box's own pixels"""
    rgb = np.array(Image.open(SOURCE).convert('RGB').crop(BOX)).astype(float)
    off_ground = np.linalg.norm(rgb - GROUND, axis=2)
    mask = ndimage.binary_fill_holes(off_ground > 40)
    amber = (rgb[..., 0] > 235) & (rgb[..., 1] > 130) & (rgb[..., 1] < 215) & (rgb[..., 2] < 120)
    amber = ndimage.binary_fill_holes(amber)
    lab, n = ndimage.label(amber)
    blobs = sorted(((lab == i).sum(), i) for i in range(1, n + 1))[-2:]
    eyes = []
    for area, i in blobs:
        cy, cx = ndimage.center_of_mass(lab == i)
        eyes.append((cx, cy, (area / np.pi) ** 0.5))
    # the art's neck and shoulder start under the box; the box ends at the chin, so only the arm claw could leak in
    lab, _ = ndimage.label(mask)
    keep = lab == lab[mask.shape[0] // 2, mask.shape[1] // 2]
    return keep.astype(float), eyes


# The 18 px head, by hand: '#' is ink. A swept crest cut by two notches, the dome and its brim slit, two 2x2 eyes
# in a solid rim, an ear cup on each side, a rounded chin. 18 wide and 18 tall, so it is centred and fills the box.
HEAD_1X = [
    '........###.......',
    '........##.###....',
    '........##.##.##..',
    '........##.##.##..',
    '.......###.##.###.',
    '......####.##.###.',
    '.....#############',
    '...###############',
    '..################',
    '.#..........#####.',
    '.################.',
    '##################',
    '####..#####..#####',
    '####..#####..#####',
    '##################',
    '.################.',
    '..##############..',
    '...############...',
]


def grid(rows):
    return np.array([[c == '#' for c in r] for r in rows], bool)


def near(mask, r=1):
    """pixels within r pixels (in every direction, diagonals too) of any ink"""
    return ndimage.binary_dilation(mask, structure=np.ones((3, 3), bool), iterations=r)


def render_1x(state):
    head = grid(HEAD_1X)
    n = HEIGHT
    yy, xx = np.mgrid[0:n, 0:n]
    ring = (np.hypot(xx - 2, yy - 2) < 2.7) & ~near(head)  # 5x5, one pixel off the head
    a = head.astype(float)
    if state == 'working':
        # a pulse: the badge spot holds a ring with a dot in it (the needs-you badge is solid)
        a = np.maximum(a, (ring & (np.hypot(xx - 2, yy - 2) > 1.6)) | ((xx == 2) & (yy == 2)))
    elif state == 'needs-you':
        a = np.maximum(a, ring)
    elif state == 'down':
        a = np.maximum(a * 0.45, (xx - yy >= 1) & (xx - yy <= 2))  # a 2 px slash over a dimmed head
    elif state == 'unknown':
        a = a * 0.42
    return (a * 255 + 0.5).astype(np.uint8)


def disc(draw, cx, cy, r, fill):
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)


def render(state, scale):
    """-> uint8 alpha, (HEIGHT*scale) square. Geometry is in points (0..18) and scaled to the supersampled canvas."""
    if scale == 1:
        return render_1x(state)
    px = HEIGHT * scale
    big = px * SS
    k = big / HEIGHT  # canvas pixels per point
    mask, eyes = head()
    bw, bh = BOX[2] - BOX[0], BOX[3] - BOX[1]
    s = HEIGHT / bh  # points per source pixel: the head fills the height
    ox = (HEIGHT - bw * s) / 2
    head_img = Image.fromarray((mask * 255).astype(np.uint8)).resize((round(bw * s * k), round(bh * s * k)), Image.BILINEAR)
    alpha = Image.new('L', (big, big), 0)
    alpha.paste(head_img, (round(ox * k), 0))
    erase = Image.new('L', (big, big), 0)
    add = Image.new('L', (big, big), 0)
    de, da = ImageDraw.Draw(erase), ImageDraw.Draw(add)
    pt = lambda x, y: (ox + x * s, y * s)  # source pixel -> point
    for pts in SEAMS:
        line = [c * k for p in pts for c in pt(*p)]
        de.line(line, fill=255, width=round(LINE * k), joint='curve')
    for cx, cy, r in eyes:
        x, y = pt(cx, cy)
        disc(de, x * k, y * k, r * s * EYE_K * k, 255)
    gain = 1.0
    badge = (2.5, 2.5, 2.5)  # x, y, r in points: the top-left corner, where the dome leaves room; same spot at 1x
    if state in ('working', 'needs-you'):
        cx, cy, r = badge
        disc(de, cx * k, cy * k, (r + 1.0) * k, 255)  # a clear moat around it
        disc(da, cx * k, cy * k, r * k, 255)
        if state == 'working':  # a ring with a dot in it: the needs-you badge is solid
            disc(da, cx * k, cy * k, (r - 1.0) * k, 0)
            disc(da, cx * k, cy * k, 0.7 * k, 255)
    elif state == 'down':
        gain = 0.45
        da.line([1.5 * k, 0, 18 * k, 16.5 * k], fill=255, width=round(1.5 * k))  # a slash over the dimmed head
    elif state == 'unknown':
        gain = 0.42
    def pixels(layer):
        c = layer.reshape(px, SS, px, SS).mean(axis=(1, 3))
        return np.clip((c - 0.5) * SHARP + 0.5, 0, 1)

    head_a = np.asarray(alpha, float) / 255 * (1 - np.asarray(erase, float) / 255)
    a = np.maximum(pixels(head_a) * gain, pixels(np.asarray(add, float) / 255))
    return (a * 255 + 0.5).astype(np.uint8)


def png(state, scale):
    a = render(state, scale)
    out = np.zeros(a.shape + (4,), np.uint8)
    out[..., 3] = a  # black everywhere; macOS tints by alpha
    return Image.fromarray(out, 'RGBA')


def write(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    for st in STATES:
        for sc in (1, 2):
            png(st, sc).save(os.path.join(out_dir, 'talos-%s-%dx.png' % (st, sc)), optimize=True)


def sheet(path, icons_dir):
    """Every state, light and dark bar, at 18 pt (1x: 18 px, 2x: 36 px) and 4x zoomed, each with its state name burned in."""
    font = ImageFont.truetype(FONT, 14)
    small = ImageFont.truetype(FONT, 12)
    bars = [('light bar', (236, 236, 236), (28, 28, 28)), ('dark bar', (46, 46, 46), (240, 240, 240))]
    rows = [('18 pt @1x (18 px)', 1, 1), ('18 pt @2x (36 px)', 2, 1), ('@1x zoomed 4x', 1, 4), ('@2x zoomed 4x', 2, 4)]
    col_w, row_h, left, top = 170, [], 150, 34
    row_h = [24 * m * sc + 34 for _, sc, m in rows]
    block = sum(row_h) + 28
    img = Image.new('RGB', (left + col_w * len(STATES), top + block * len(bars)), (90, 90, 90))
    d = ImageDraw.Draw(img)
    for si, st in enumerate(STATES):
        d.text((left + si * col_w + 10, 8), LABELS[st], font=font, fill=(255, 255, 255))
    for bi, (bname, bg, fg) in enumerate(bars):
        y0 = top + bi * block
        d.rectangle([0, y0, img.width, y0 + block - 4], fill=bg)
        y = y0 + 6
        for ri, (rname, sc, m) in enumerate(rows):
            d.text((8, y + 4), bname if ri == 0 else '', font=font, fill=fg)
            d.text((8, y + 22), rname, font=small, fill=fg)
            for si, st in enumerate(STATES):
                src = Image.open(os.path.join(icons_dir, 'talos-%s-%dx.png' % (st, sc))).convert('RGBA')
                a = src.split()[3]
                if m > 1:
                    a = a.resize((a.width * m, a.height * m), Image.NEAREST)
                tint = Image.new('RGB', a.size, fg)
                x = left + si * col_w + 10
                img.paste(tint, (x, y), a)
                d.text((x, y + a.height + 4), LABELS[st], font=small, fill=fg)
            y += row_h[ri]
    img.save(path)


if __name__ == '__main__':
    args = sys.argv[1:]
    sheet_path = None
    if '--sheet' in args:
        i = args.index('--sheet')
        sheet_path = args[i + 1]
        del args[i:i + 2]
    out = args[0] if args else DEFAULT_OUT
    write(out)
    if sheet_path:
        sheet(sheet_path, out)
