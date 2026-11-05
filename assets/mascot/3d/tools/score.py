"""Silhouette + part measurements: a rendered still vs its reference icon (photo-to-3d-loop's ruler channel).

  python3 score.py <render.png> <ref-icon.png> <out-prefix>    writes <out-prefix>-overlay.png and prints JSON

Alignment: the render's alpha mask is scaled so its bbox HEIGHT equals the reference figure's (crest tip to foot sole),
bottoms aligned, then translated in x only (+-60 px search) for best IoU. No rotation, no camera fitting (rule 8).
Per-part numbers (all in units of the reference figure height H, origin = figure bbox bottom-centre):
  eyes / core: the orange (ichor) blobs: centre + equivalent radius
  bands: left / right silhouette extent per 10 horizontal bands
"""
import json, sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi
sys.path.insert(0, __import__('os').path.dirname(__file__))
from refmask import figure_mask


def orange(rgb, alpha=None):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    m = (r > 200) & (g > 120) & (g < 225) & (b < 150) & (r - b > 90)
    if alpha is not None:
        m &= alpha
    return m


def blobs(m, H, x0, y1, min_frac=0.00002):
    lab, n = ndi.label(m)
    out = []
    for k in range(1, n + 1):
        ys, xs = np.nonzero(lab == k)
        if len(xs) < min_frac * H * H:
            continue
        out.append({'x': (xs.mean() - x0) / H, 'y': (y1 - ys.mean()) / H, 'r': float(np.sqrt(len(xs) / np.pi) / H), 'n': int(len(xs))})
    return out


def parts(bl):
    """eyes = the two largest blobs above y 0.55; core = largest blob between 0.25 and 0.5"""
    eyes = sorted([b for b in bl if b['y'] > 0.55], key=lambda b: -b['n'])[:2]
    eyes = sorted(eyes, key=lambda b: b['x'])
    core = sorted([b for b in bl if 0.2 < b['y'] < 0.5], key=lambda b: -b['n'])[:1]
    return {'eye_R': eyes[0] if eyes else None, 'eye_L': eyes[1] if len(eyes) > 1 else None, 'core': core[0] if core else None}


def bbox(m):
    ys, xs = np.nonzero(m)
    return xs.min(), xs.max(), ys.min(), ys.max()


def main(render_p, ref_p, prefix):
    ref = figure_mask(ref_p)
    ref_rgb = np.asarray(Image.open(ref_p).convert('RGB')).astype(int)
    rx0, rx1, ry0, ry1 = bbox(ref); H = ry1 - ry0 + 1
    im = Image.open(render_p).convert('RGBA')
    a = np.asarray(im)
    am = a[..., 3] > 128
    x0, x1, y0, y1 = bbox(am)
    s = H / (y1 - y0 + 1)
    W, Hh = im.size
    big = im.resize((round(W * s), round(Hh * s)), Image.LANCZOS)
    ba = np.asarray(big)
    bm = ba[..., 3] > 128
    bx0, bx1, by0, by1 = bbox(bm)
    canvas_shape = ref.shape
    best = None
    for dx in range(-60, 61, 2):
        ox = (rx0 + rx1) // 2 - (bx0 + bx1) // 2 + dx; oy = ry1 - by1
        rm = np.zeros(canvas_shape, bool)
        ys, xs = np.nonzero(bm)
        yy = ys + oy; xx = xs + ox
        ok = (yy >= 0) & (yy < canvas_shape[0]) & (xx >= 0) & (xx < canvas_shape[1])
        rm[yy[ok], xx[ok]] = True
        iou = (rm & ref).sum() / (rm | ref).sum()
        if best is None or iou > best[0]:
            best = (iou, dx, ox, oy, rm)
    iou, dx, ox, oy, rm = best
    # render rgb placed on the same canvas for blob measurement
    rr = np.zeros(canvas_shape + (3,), int); ra = np.zeros(canvas_shape, bool)
    ys, xs = np.nonzero(bm)
    yy = ys + oy; xx = xs + ox; ok = (yy >= 0) & (yy < canvas_shape[0]) & (xx >= 0) & (xx < canvas_shape[1])
    rr[yy[ok], xx[ok]] = ba[ys[ok], xs[ok], :3]; ra[yy[ok], xx[ok]] = True
    cx = (rx0 + rx1) / 2
    ref_parts = parts(blobs(orange(ref_rgb, ref), H, cx, ry1))
    ren_parts = parts(blobs(orange(rr, ra), H, cx, ry1))
    bands = []
    for k in range(10):
        ya = ry0 + int(k * H / 10); yb = ry0 + int((k + 1) * H / 10)
        def ext(m):
            cols = np.nonzero(m[ya:yb].any(0))[0]
            return (round((cols.min() - cx) / H, 3), round((cols.max() - cx) / H, 3)) if len(cols) else None
        bands.append({'band': k, 'y_top': round((ry1 - ya) / H, 2), 'ref': ext(ref), 'render': ext(rm)})
    ov = np.zeros(canvas_shape + (3,), np.uint8)
    ov[ref & rm] = (235, 235, 235); ov[ref & ~rm] = (220, 40, 40); ov[rm & ~ref] = (40, 90, 230)
    Image.fromarray(ov).save(prefix + '-overlay.png')
    def rnd(d):
        return None if d is None else {k: (round(v, 4) if isinstance(v, float) else v) for k, v in d.items() if k != 'n'}
    res = {'iou': round(float(iou), 4), 'dx': dx, 'ref_H_px': int(H),
           'width_over_H': {'ref': round((rx1 - rx0 + 1) / H, 3), 'render': round((bbox(rm)[1] - bbox(rm)[0] + 1) / H, 3)},
           'parts': {k: {'ref': rnd(ref_parts[k]), 'render': rnd(ren_parts[k])} for k in ref_parts},
           'bands': bands}
    print(json.dumps(res, indent=1))
    json.dump(res, open(prefix + '-score.json', 'w'), indent=1)
    return res


if __name__ == '__main__':
    main(*sys.argv[1:4])
