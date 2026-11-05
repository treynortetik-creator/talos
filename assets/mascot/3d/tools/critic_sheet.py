"""Critic boards: each render still beside its reference icon at the SAME figure scale (contact-sheet rule: the column
alignment is the signal). Render scaled so its alpha bbox height = the icon figure's, bottoms aligned, centred on the icon
figure, flattened on the icon's terracotta.

  python3 critic_sheet.py <stills_dir> <brand_dir> <out_dir>
writes <out_dir>/board-<name>.png (full figure, reference left | render right) and board-<name>-head.png (head close-up)
"""
import os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont
sys.path.insert(0, os.path.dirname(__file__))
from refmask import figure_mask

FONT = '/System/Library/Fonts/Supplemental/Arial.ttf'
TERRA = (0xD9, 0x69, 0x2B, 255)
PAIRS = {'ref-pleased': 'talos-pleased-source.png', 'ref-beaming': 'talos-beaming-source.png', 'ref-worried': 'talos-worried-source.png'}


def bbox(m):
    ys, xs = np.nonzero(m)
    return xs.min(), xs.max(), ys.min(), ys.max()


def aligned(render_p, ref_p):
    ref = figure_mask(ref_p); rx0, rx1, ry0, ry1 = bbox(ref); H = ry1 - ry0 + 1
    im = Image.open(render_p).convert('RGBA'); a = np.asarray(im)[..., 3] > 128
    x0, x1, y0, y1 = bbox(a); s = H / (y1 - y0 + 1)
    big = im.resize((round(im.size[0] * s), round(im.size[1] * s)), Image.LANCZOS)
    bx0, bx1, by0, by1 = bbox(np.asarray(big)[..., 3] > 128)
    canvas = Image.new('RGBA', Image.open(ref_p).size, TERRA)
    ox = (rx0 + rx1) // 2 - (bx0 + bx1) // 2; oy = ry1 - by1
    canvas.alpha_composite(big, (ox, oy)) if ox >= 0 and oy >= 0 else canvas.paste(big, (ox, oy), big)
    return canvas.convert('RGB'), Image.open(ref_p).convert('RGB')


def label(im, text):
    d = ImageDraw.Draw(im); f = ImageFont.truetype(FONT, 34)
    d.rectangle((0, 0, im.size[0], 50), fill=(20, 17, 16)); d.text((16, 7), text, font=f, fill=(243, 230, 207))
    return im


def main(sdir, bdir, odir):
    os.makedirs(odir, exist_ok=True)
    for name, refn in PAIRS.items():
        rp = os.path.join(sdir, name, '0001.png')
        if not os.path.exists(rp):
            continue
        ren, ref = aligned(rp, os.path.join(bdir, refn))
        crop = (100, 60, 1154, 1194)
        a = label(ref.crop(crop), 'REFERENCE (approved 2D icon)'); b = label(ren.crop(crop), 'RENDER (3D, same scale)')
        board = Image.new('RGB', (a.size[0] * 2 + 20, a.size[1]), (40, 33, 28)); board.paste(a, (0, 0)); board.paste(b, (a.size[0] + 20, 0))
        board.save(os.path.join(odir, f'board-{name}.png'))
        hc = (330, 60, 900, 640)
        a = label(ref.crop(hc).resize((855, 870), Image.LANCZOS), 'REFERENCE head'); b = label(ren.crop(hc).resize((855, 870), Image.LANCZOS), 'RENDER head')
        board = Image.new('RGB', (a.size[0] * 2 + 20, a.size[1]), (40, 33, 28)); board.paste(a, (0, 0)); board.paste(b, (a.size[0] + 20, 0))
        board.save(os.path.join(odir, f'board-{name}-head.png'))
        print('board', name)


if __name__ == '__main__':
    main(*sys.argv[1:4])
