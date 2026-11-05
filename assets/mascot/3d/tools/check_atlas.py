#!/usr/bin/env python3
"""Check the desktop companion atlases against DESKTOP-COMPANION-SPEC 11.1 acceptance 1 and 3.

  python3 tools/check_atlas.py [DIR]      DIR defaults to apps/desktop/Resources/companion; exit 0 = every check passed

Checks (each prints PASS or FAIL lines; any FAIL exits 1):
  grid      every PNG has exactly its grid size at both scales (8x9 / 8x3 of 192x208 and 96x104, 1x1, mini 4x1 of 88 / 44)
  manifest  every clip names a real atlas and row, every frame column is inside the grid and not empty, every ms is 80..4000,
            `still` is a valid non-empty column, the 2x and 1x sheets agree on which cells are filled
  border    nothing opaque within 3 px (2x) / 2 px (1x) of a cell edge
  feet      the sole line of every grounded frame is on the anchor row (airborne frames may only be higher)
  keyline   the cream outer line is at least 1.5 pt wide everywhere (3 px at 2x, 1.5 px at 1x)
  palette   every opaque pixel is a mix of black, cream and the ember family (nothing else)
  size      the files total under 4 MB
  hop       Poke plays the first four `jumping` columns: 0 and 3 stand on the anchor row, 1 and 2 are in the air (a hop that lands)
  walk      running-right and running-left are separate renders: no column of one is the mirror of the other
  hold      waiting and failed hold: they do not loop and they end on the column the ember is registered to
  hammer    `running`: the hammer takes at least 200 ms to go from the top pose to the strike (spec 9.2: no 125 ms snap)
  antics    every idle antic starts and ends on the idle stance (a clip cuts to Idle with no pop), the nap's sleep and wake join it, and
            the sleep ends on the frame the Asleep rest shows (talos-life sheet)
  ember     every clip that can sit still under the ember layer has its own ember cell that (a) lies on the body's own glow in that
            clip's still column (registration: at least 97% of the layer's pixels within 2 px of a warm body pixel; a layer cut from a
            different pose draws a second pair of eyes) and (b) changes the pixels under it by a visible amount (mean 15/255 or more
            between opacity 0 and 1, so the stepped opacity of spec 3.2 shows on a panel). Mini: the same for mini-ember.

border waiver at 1x: acceptance 1 says 3 px. At 1x the anchor row is 100 of 104 (half the spec's 2x anchor row 200 of 208) and the
outer stroke is 2 px, so a grounded sole ends 2 px from the bottom edge and the spec's own numbers cannot give 3. The check
holds 1x to 2 px and prints that as a named waiver line, never silently. The spec's acceptance text should say so.
"""
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))      # talos_clips (pure python, no Blender)
DEFAULT = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..', 'apps', 'desktop', 'Resources', 'companion'))

BLACK = (0x14, 0x11, 0x10)
CREAM = (0xF3, 0xE6, 0xCF)
EMBER = [(0xFF, 0xB1, 0x5C), (0xEE, 0x90, 0x36), (0xF7, 0xA2, 0x3C), (0xE5, 0x84, 0x28), (0xC2, 0x60, 0x1E), (0x8A, 0x42, 0x16),
         (0xFF, 0xD3, 0x6B), (0xFF, 0xF0, 0xB8), (0xE2, 0x5A, 0x3C), (0xEB, 0xAA, 0x45), (0x8A, 0x54, 0x18),
         (0xFF, 0xFF, 0x8A), (0xFF, 0xFF, 0xE0)]      # hot ember: the same glow driven 2x brighter, which is what the ember layer is (it must step visibly)
PALETTE = [BLACK, CREAM] + EMBER
PALETTE_TOL = 26.0            # RGB distance to the nearest mix of two palette colours
AIRBORNE = {'jumping': {1, 2}}   # the hop: frames in the air have the sole above the anchor (column 3 has landed)
MS_MIN, MS_MAX = 80, 4000
BYTES_MAX = 4 * 1024 * 1024
BORDER = {2: 3, 1: 2}                # 1x is the waiver above
BORDER_SPEC = 3
EMBER_INSIDE_MIN = 0.97
EMBER_TOL_PX = {2: 2, 1: 1}
EMBER_DELTA_MIN = 15.0
ANTICS = ('sit', 'nap', 'stretch', 'scratch', 'stumble', 'tinker')      # the idle antics of the talos-life sheet
ANTIC_IDLE_IOU = 0.85        # silhouette overlap of an antic's first and last cell with the idle stance
KEYLINE_MIN_PX = {2: 3.0, 1: 1.5}
SCALE_KEY = {2: '2x', 1: '1x'}


class Report:
    def __init__(self, quiet=False):
        self.fails = []
        self.passes = []
        self.quiet = quiet

    def check(self, ok, name, detail=''):
        (self.passes if ok else self.fails).append('%s%s' % (name, (': ' + detail) if detail else ''))
        if not self.quiet:
            print('%s %s%s' % ('PASS' if ok else 'FAIL', name, (': ' + detail) if detail else ''))
        return ok


def load(path):
    return np.asarray(Image.open(path).convert('RGBA'))


def cell(a, col, row, w, h):
    return a[row * h:(row + 1) * h, col * w:(col + 1) * w]


def segment_dist(px, a, b):
    a = np.array(a, np.float32); b = np.array(b, np.float32)
    ab = b - a
    t = np.clip(((px - a) @ ab) / max(float(ab @ ab), 1e-6), 0, 1)
    return np.linalg.norm(px - (a + t[:, None] * ab), axis=1)


def palette_worst(rgb):
    """worst distance of any pixel to the nearest straight mix of two palette colours (black, cream, ember family)"""
    px = rgb.reshape(-1, 3).astype(np.float32)
    if len(px) == 0:
        return 0.0
    px = np.unique(px, axis=0)
    best = np.full(len(px), 1e9, np.float32)
    n = len(PALETTE)
    for i in range(n):
        for j in range(i, n):
            best = np.minimum(best, segment_dist(px, PALETTE[i], PALETTE[j]))
    return float(best.max())


def keyline_px(c):
    """thinnest cream outer line of a cell: the distance from the outside to the nearest black pixel, minus the half pixel of the edge"""
    op = c[..., 3] >= 128
    if not op.any():
        return None
    d = ndimage.distance_transform_edt(op)
    rgb = c[..., :3].astype(np.int32)
    black = (np.abs(rgb - np.array(BLACK)).sum(-1) < 90) & op
    if not black.any():
        return None
    return float(d[black].min()) - 0.5


def ember_stats(body, em, tol):
    """(fraction of ember pixels within `tol` px of a warm body pixel, mean |change| of the body's RGB under the ember at opacity 1,
    ember pixel count). `body` and `em` are RGBA cells of the same size."""
    mask = em[..., 3] >= 128
    n = int(mask.sum())
    if n == 0:
        return 0.0, 0.0, 0
    rgb = body[..., :3].astype(np.int32)
    warm = (body[..., 3] >= 128) & (rgb[..., 0] >= 150) & (rgb[..., 0] - rgb[..., 2] >= 70)
    near = ndimage.binary_dilation(warm, iterations=tol) if tol else warm
    inside = float((near & mask).sum()) / n
    a = em[..., 3:4].astype(np.float32) / 255.0
    full = body[..., :3].astype(np.float32) * (1 - a) + em[..., :3].astype(np.float32) * a
    # the body shows through where the layer is partly clear; compare only where the layer is solid
    delta = float(np.abs(full - body[..., :3].astype(np.float32))[mask].mean())
    return inside, delta, n


def run(root, quiet=False, skip=()):
    r = Report(quiet)
    mp = os.path.join(root, 'companion.json')
    if not r.check(os.path.exists(mp), 'manifest exists', mp):
        return r
    m = json.load(open(mp))
    r.check(m.get('v') == 1, 'manifest v is 1')
    atl = m['atlases']
    imgs = {}
    total = os.path.getsize(mp)
    for name, at in atl.items():
        gw, gh = at['grid']
        for sc in (2, 1):
            f = at['files'][SCALE_KEY[sc]]
            p = os.path.join(root, f)
            if not r.check(os.path.exists(p), 'file %s' % f):
                continue
            total += os.path.getsize(p)
            a = load(p)
            imgs[(name, sc)] = a
            cw, ch = (at.get('cell') or m['cell'])[SCALE_KEY[sc]]
            r.check(a.shape[1] == gw * cw and a.shape[0] == gh * ch, 'grid %s %s' % (name, SCALE_KEY[sc]),
                    '%dx%d expected %dx%d' % (a.shape[1], a.shape[0], gw * cw, gh * ch))
    r.check(total < BYTES_MAX, 'size under 4 MB', '%d bytes' % total)
    r.check(BORDER[2] == BORDER_SPEC and BORDER[1] == 2, 'border waiver: 1x held to 2 px, not the spec 3 (anchor row 100 + 2 px stroke leaves 2 px)')
    cw2, ch2 = m['cell']['2x']; cw1, ch1 = m['cell']['1x']
    ax, ay = m['anchor']
    anchors = {2: (ax, ay), 1: (ax // 2, ay // 2)}
    cellsz = {2: (cw2, ch2), 1: (cw1, ch1)}
    used = {}
    for cname, c in m['clips'].items():
        at = atl.get(c['atlas'])
        if not r.check(at is not None, 'clip %s names an atlas' % cname, c['atlas']):
            continue
        gw, gh = at['grid']
        r.check(0 <= c['row'] < gh, 'clip %s row in grid' % cname)
        cols = set()
        for col, ms in c['frames']:
            r.check(0 <= col < gw, 'clip %s column %d in grid' % (cname, col))
            r.check(MS_MIN <= ms <= MS_MAX, 'clip %s frame ms %d in 80..4000' % (cname, ms))
            cols.add(col)
        r.check(c['still'] in range(gw), 'clip %s still column valid' % cname)
        cols.add(c['still'])
        r.check(isinstance(c['loop'], bool), 'clip %s loop is a bool' % cname)
        for sc in (2, 1):
            a = imgs.get((c['atlas'], sc))
            if a is None:
                continue
            w, h = cellsz[sc]
            filled = {col for col in range(gw) if (cell(a, col, c['row'], w, h)[..., 3] > 0).any()}
            r.check(cols <= filled, 'clip %s %s: every used column is drawn' % (cname, SCALE_KEY[sc]),
                    'missing %s' % sorted(cols - filled))
            used[(cname, sc)] = filled
            b = BORDER[sc]
            ay_ = anchors[sc][1]
            for col in sorted(cols & filled):
                cl = cell(a, col, c['row'], w, h)
                al = cl[..., 3]
                edge = np.concatenate([al[:b].ravel(), al[-b:].ravel(), al[:, :b].ravel(), al[:, -b:].ravel()])
                r.check(not (edge > 0).any(), 'border %s %s #%d' % (cname, SCALE_KEY[sc], col))
                ys = np.nonzero((al >= 128).any(axis=1))[0]
                bottom = int(ys.max()) + 1 - ((3, 2)[sc == 1])        # minus the outer stroke
                grounded = col not in AIRBORNE.get(cname, set())
                ok = (abs(bottom - ay_) <= 1) if grounded else (bottom <= ay_ + 1)
                r.check(ok, 'feet %s %s #%d' % (cname, SCALE_KEY[sc], col), 'sole %d anchor %d' % (bottom, ay_))
                kp = keyline_px(cl)
                if kp is not None:
                    r.check(kp >= KEYLINE_MIN_PX[sc] - 0.01, 'keyline %s %s #%d' % (cname, SCALE_KEY[sc], col), '%.2f px' % kp)
    for sc in (2, 1):
        for cname in m['clips']:
            pass
    for cname in m['clips']:
        if (cname, 2) in used and (cname, 1) in used:
            r.check(used[(cname, 2)] == used[(cname, 1)], 'clip %s: 2x and 1x draw the same columns' % cname)
    for name, at in atl.items():
        if 'palette' in skip:
            break
        for sc in (2, 1):
            a = imgs.get((name, sc))
            if a is None:
                continue
            op = a[..., 3] >= 250
            worst = palette_worst(a[..., :3][op])
            r.check(worst <= PALETTE_TOL, 'palette %s %s' % (name, SCALE_KEY[sc]), 'worst %.1f' % worst)
    # hop, walk, hold, hammer: behaviours the spec states that no per-cell check sees
    ca, ch_ = cellsz[2]
    ta = imgs.get(('talos', 2))
    if ta is not None and ta.shape == (9 * ch_, 8 * ca, 4) and 'jumping' in m['clips'] and 'running-right' in m['clips']:
        def sole(col, rowname):
            al = cell(ta, col, m['clips'][rowname]['row'], ca, ch_)[..., 3]
            return int(np.nonzero((al >= 128).any(axis=1))[0].max()) + 1
        so = [sole(col, 'jumping') for col in range(4)]
        r.check(abs(so[0] - so[3]) <= 1 and so[0] - so[1] >= 6 and so[0] - so[2] >= 6 and so[2] <= so[1],
                'hop: Poke lands (jumping columns 0-3 rise and come back to the same sole row)', 'soles %s' % so)
        rr, ll = m['clips']['running-right']['row'], m['clips']['running-left']['row']
        worst = min(float(np.abs(cell(ta, col, rr, ca, ch_)[..., 3].astype(int) - cell(ta, col, ll, ca, ch_)[:, ::-1, 3].astype(int)).mean())
                    for col in range(8))
        r.check(worst > 3.0, 'walk: the two directions are separate renders, not a mirror', 'closest column differs by %.1f' % worst)
    for cname in ('waiting', 'failed'):
        c = m['clips'].get(cname)
        if c:
            r.check(c['loop'] is False and c['frames'][-1][0] in c.get('ember', {}).get('cols', [c['still']]),
                    'hold: %s does not loop and ends on its still column' % cname)
    run_ = m['clips'].get('running')
    if run_:
        try:
            import talos_clips
            lift = talos_clips.HAMMER_LIFT
            cols = [f[0] for f in run_['frames']]
            top = next(i for i, c in enumerate(cols) if lift[c] >= 0.95)
            strike = next(i for i in range(top, len(cols)) if lift[cols[i]] <= 0.05)
            fall_ms = sum(run_['frames'][i][1] for i in range(top + 1, strike))
            r.check(fall_ms >= 200, 'hammer: running takes 200 ms or more from the top pose to the strike', '%d ms' % fall_ms)
        except Exception as e:                                 # a missing module or an unexpected table is a failure, never a skip
            r.check(False, 'hammer: could not measure the fall', repr(e))
    # antics: every one starts and ends standing as in Idle, so Idle takes over with no pop; sleep and wake meet the nap's still
    if any(a in m['clips'] for a in ANTICS):
        for sc in (2, 1):
            ta_, tl_ = imgs.get(('talos', sc)), imgs.get(('talos-life', sc))
            if ta_ is None or tl_ is None:
                continue
            w, h = cellsz[sc]
            idle_m = cell(ta_, m['clips']['idle']['still'], m['clips']['idle']['row'], w, h)[..., 3] >= 128
            def iou(c):
                a_ = cell(tl_, c['col'], c['row'], w, h)[..., 3] >= 128
                return float((a_ & idle_m).sum()) / max(1, float((a_ | idle_m).sum()))
            for name in ANTICS:
                c = m['clips'].get(name)
                if not r.check(c is not None, 'antic %s is in the manifest' % name):
                    continue
                for end, col in (('first', c['frames'][0][0]), ('last', c['frames'][-1][0])):
                    v = iou({'col': col, 'row': c['row']})
                    r.check(v >= ANTIC_IDLE_IOU, 'antic %s %s: its %s cell is the idle stance' % (name, SCALE_KEY[sc], end), 'overlap %.2f' % v)
            sl, wk, nap = m['clips'].get('sleep'), m['clips'].get('wake'), m['clips'].get('nap')
            if r.check(None not in (sl, wk, nap), 'sleep, wake and nap are all in the manifest'):
                r.check(sl['frames'][-1][0] == nap['still'] == wk['frames'][0][0], 'sleep ends and wake starts on the nap still (the Asleep rest)')
                r.check(iou({'col': sl['frames'][0][0], 'row': sl['row']}) >= ANTIC_IDLE_IOU and iou({'col': wk['frames'][-1][0], 'row': wk['row']}) >= ANTIC_IDLE_IOU,
                        'sleep starts and wake ends on the idle stance %s' % SCALE_KEY[sc])
                wl = m['clips'].get('wake-low')
                if r.check(wl is not None, 'wake-low is in the manifest (a wake cut early in the nap gets up from the seat)'):
                    r.check(wl['row'] == nap['row'] and iou({'col': wl['frames'][-1][0], 'row': wl['row']}) >= ANTIC_IDLE_IOU,
                            'wake-low shares the nap row and ends on the idle stance %s' % SCALE_KEY[sc])
    # the nap's Z's: the big one reads as a Z (its diagonal runs from top right to bottom left, not an S the other way), and every lying cell
    # shows both Z's apart from the body (a Z fused to the helmet outline reads as a bump on it)
    nap_c = m['clips'].get('nap')
    if nap_c is not None:
        for sc in (2, 1):
            tl_ = imgs.get(('talos-life', sc))
            if tl_ is None:
                continue
            w, h = cellsz[sc]
            for col in (5, 6, 7):
                if col not in [f[0] for f in nap_c['frames']]:
                    continue
                a_ = cell(tl_, col, nap_c['row'], w, h)[..., 3] >= 128
                lab, k = ndimage.label(a_)
                sizes = ndimage.sum(a_, lab, range(1, k + 1)) if k else []
                body = int(np.argmax(sizes)) + 1 if k else 0
                z = [i + 1 for i in range(k) if i + 1 != body and sizes[i] >= 0.0015 * w * h]
                if not r.check(len(z) >= 2, 'nap %s #%d: both Z\'s stand clear of the body' % (SCALE_KEY[sc], col), '%d separate shapes' % len(z)):
                    continue
                big = max(z, key=lambda i: sizes[i - 1])
                ys, xs = np.nonzero(lab == big)
                y0, y1 = ys.min(), ys.max()
                t = (ys - y0) / max(1, y1 - y0)
                upper, lower = xs[(t > 0.3) & (t < 0.45)], xs[(t > 0.55) & (t < 0.7)]
                r.check(len(upper) > 0 and len(lower) > 0 and upper.mean() > lower.mean() + 0.05 * (xs.max() - xs.min()),
                        'nap %s #%d: the Z is not mirrored' % (SCALE_KEY[sc], col))
    # ember: registered to the body's glow in every column it may sit on, and strong enough to see
    emb = atl.get('ember')
    r.check(emb is not None, 'ember atlas is listed')
    for cname, c in m['clips'].items():
        if 'ember' not in c or emb is None:
            continue
        k = c['ember']['cell']
        r.check(0 <= k < emb['grid'][0], 'clip %s ember cell in grid' % cname)
        r.check(bool(c['ember']['cols']) and all(col in range(atl[c['atlas']]['grid'][0]) for col in c['ember']['cols']), 'clip %s ember columns valid' % cname)
        for sc in (2, 1):
            ea, ba = imgs.get(('ember', sc)), imgs.get((c['atlas'], sc))
            if ea is None or ba is None or not (0 <= k < emb['grid'][0]):
                continue
            w, h = cellsz[sc]
            ec = cell(ea, k, 0, w, h)
            for col in c['ember']['cols']:
                bc = cell(ba, col, c['row'], w, h)
                if bc.shape[:2] != ec.shape[:2] or bc.shape[:2] != (h, w):      # a wrong grid is reported by the grid check, not a crash here
                    continue
                inside, delta, n = ember_stats(bc, ec, EMBER_TOL_PX[sc])
                r.check(n > 0 and inside >= EMBER_INSIDE_MIN, 'ember %s %s #%d lies on the body glow' % (cname, SCALE_KEY[sc], col),
                        '%.1f%% inside, %d px' % (100 * inside, n))
                r.check(delta >= EMBER_DELTA_MIN, 'ember %s %s #%d steps visibly' % (cname, SCALE_KEY[sc], col), 'mean %.1f/255' % delta)
    me, mi_ = atl.get('mini-ember'), atl['mini']
    r.check(me is not None and me.get('states') == ['pleased', 'worried', 'waiting'], 'mini-ember lists its states')
    for state in (me or {}).get('states', []):
        col = mi_['states'].index(state)
        for sc in (2, 1):
            ea, ba = imgs.get(('mini-ember', sc)), imgs.get(('mini', sc))
            if ea is None or ba is None:
                continue
            s_ = mi_['cell'][SCALE_KEY[sc]][0]
            bc, ec = cell(ba, col, 0, s_, s_), cell(ea, col, 0, s_, s_)
            if bc.shape[:2] != (s_, s_) or ec.shape[:2] != (s_, s_):
                continue
            inside, delta, n = ember_stats(bc, ec, EMBER_TOL_PX[sc])
            r.check(n > 0 and inside >= EMBER_INSIDE_MIN, 'mini-ember %s %s lies on the glow' % (state, SCALE_KEY[sc]), '%.1f%% inside, %d px' % (100 * inside, n))
            r.check(delta >= EMBER_DELTA_MIN, 'mini-ember %s %s steps visibly' % (state, SCALE_KEY[sc]), 'mean %.1f/255' % delta)
    # mini: four states, ring on the border row, core visible
    mi = atl['mini']
    r.check(len(mi['states']) == 4, 'mini has four states')
    for sc in (2, 1):
        a = imgs.get(('mini', sc))
        if a is None:
            continue
        s = mi['cell'][SCALE_KEY[sc]][0]
        for k in range(4):
            c = cell(a, k, 0, s, s)
            r.check((c[..., 3] > 0).sum() > s * s * 0.5, 'mini %s state %d is drawn' % (SCALE_KEY[sc], k))
            r.check(c[0, 0, 3] == 0, 'mini %s state %d corner is clear' % (SCALE_KEY[sc], k))
    return r


def main():
    args = [x for x in sys.argv[1:] if not x.startswith('--')]
    root = args[0] if args else DEFAULT
    r = run(root, '--quiet' in sys.argv)
    print('\n%d passed, %d failed' % (len(r.passes), len(r.fails)))
    sys.exit(1 if r.fails else 0)


if __name__ == '__main__':
    main()
