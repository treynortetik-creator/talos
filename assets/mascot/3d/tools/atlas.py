#!/usr/bin/env python3
"""Little Talos -> the desktop companion's sprite atlases (DESKTOP-COMPANION-SPEC section 9).

  python3 tools/atlas.py measure              render every state once and print the largest even 2x cell the figure fits in
  python3 tools/atlas.py build [--out DIR]    render, finish and pack Resources/companion/* (default: apps/desktop/Resources/companion)
  python3 tools/atlas.py sheet <dir> <out>    one labelled contact sheet of a built atlas dir (for looking at)

Why this file exists: finish.py's sheets are per clip, square and uniform 24 fps, and don't fit. The desktop wants one 8-column
grid per atlas, 192x208 pt cells, a hold table of [column, ms], and 1x cells that are their own render, not a runtime scale.

How a frame is made (the same Talos model and rig, nothing redrawn):
  1. Blender renders the `d_*` clips of talos_clips.py (TALOS_DESKTOP=1) at EXACTLY the final pixel scale, supersampled and
     area-averaged by finish.py (the cream part lines come from the ID pass, as for the web clips). 2x: CELL2 px per 7.2 BU.
     1x: half of that, rendered again, never resized.
  2. One window of the final cell size is cut from every frame, positioned so the lowest planted foot of the idle pose lands on the
     anchor row. One window for every frame of every clip, so clips can be swapped in place.
  3. A separate outer cream stroke is drawn at final cell size: 3 px at 2x, 2 px at 1x (1.5 pt and 2 pt), because the part line
     that comes with the render is only about 1.3 px wide.
  4. Mini (the tondo) is cut from separate bust renders with heavier part lines, the gear hidden, clipped to a circle with a cream ring.
Everything is deterministic: same blend, same numbers, same bytes.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

os.environ['TALOS_DESKTOP'] = '1'
HERE = os.path.dirname(os.path.abspath(__file__))
M3D = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(M3D, '..', '..', '..'))
sys.path.insert(0, M3D)
sys.path.insert(0, HERE)
import talos_clips as TC  # noqa: E402
import finish  # noqa: E402

DEFAULT_OUT = os.path.join(REPO, 'apps', 'desktop', 'Resources', 'companion')
CREAM = np.array([0xF3, 0xE6, 0xCF], np.float32)
FONT = '/System/Library/Fonts/Supplemental/Arial.ttf'

CELL_PT = (96, 104)                       # the panel, in points
SCALES = {2: (192, 208), 1: (96, 104)}    # cell px per scale
ANCHOR = {2: (96, 200), 1: (48, 100)}     # feet anchor (x centre, y of the sole line) per scale; companion.json carries the 2x one
STROKE = {2: 3, 1: 2}                     # outer keyline px per scale (1.5 pt and 2 pt)
COLS = 8
MINI = {2: 88, 1: 44}
MINI_RING = {2: 3, 1: 2}
CELL2_RENDER = 232                        # px per 7.2 BU at 2x, from `measure`: the largest even cell every pose fits (width and height)
BUST_CENTER_Z = 3.45                      # BU, the bust circle's centre: high enough that the whole crest clears the ring, low enough that the core stays in (was 3.30; core_reach guards that)
BUST_RADIUS_BU = 2.25                     # was 1.86, which cut the crest: it reaches 2.0 BU from the old centre (see crest_reach)
BUST_LINE_K = 2.4                         # part lines of the bust are this many times heavier
SUPER = {2: 3, 1: 4}                      # supersampling per scale (area average back down)

MAIN_CLIPS = [r[3] for r in TC.ATLAS_ROWS] + ['d_ember']
LIFE_ATLAS = 'talos-life'                 # the idle antics: their own sheet, so the 8x9 and 8x3 sheets (and their bytes) stay as they were
LIFE_CLIPS = ['d_idle'] + [r[3] for r in TC.ATLAS_ROWS if r[1] == LIFE_ATLAS]     # d_idle gives the window origin
LOOPS_ATLAS = TC.LOOPS_ATLAS             # the idle life loops: their own sheet, LOOP_COLS wide, so the other sheets (and their bytes) stay as they were
LOOPS_CLIPS = ['d_idle'] + [r[3] for r in TC.ATLAS_ROWS if r[1] == LOOPS_ATLAS]
ATLAS_ROWS_N = {'talos': 9, 'talos-ext': 3, LIFE_ATLAS: 1 + max(r[2] for r in TC.ATLAS_ROWS if r[1] == LIFE_ATLAS),
                LOOPS_ATLAS: 1 + max(r[2] for r in TC.ATLAS_ROWS if r[1] == LOOPS_ATLAS)}
ATLAS_COLS = {'talos': COLS, 'talos-ext': COLS, LIFE_ATLAS: COLS, LOOPS_ATLAS: TC.LOOP_COLS}
BUST_CLIPS = ['d_bust', 'd_bust_ember']
CREST_PARTS = {'crest', 'crest_holder'}   # the part names whose pixels the mini ring must never cut
CORE_PARTS = {'core'}                     # the orange core of the badge: the mini ring must not cut it either (the outer bezel, port_ring, may lose a pixel or two)
# frames with the feet off the ground keep the shared window; every other frame is lifted or dropped (whole pixels) so its
# lowest foot sits on the anchor row. A walking figure turned from the camera has one foot nearer, hence lower, and a squash sinks
# the root: without this the sole wanders by several pixels and he would bob across the desktop.
AIRBORNE = {'jumping': {1, 2}}


def blender():
    return os.environ.get('BLENDER') or shutil.which('blender') or '/opt/homebrew/bin/blender'


def check_hidden(out, clips):
    """a clip's `hide` list must have matched objects ('[talos] hid N objects'): a prefix that matches nothing would ship the parts it
    meant to remove (the bust's rivets) without a word"""
    want = [c for c in clips if TC.DESKTOP_CLIPS.get(c, (0, 0, 0, {}))[3].get('hide')]
    got = [int(n) for n in re.findall(r'\[talos\] hid (\d+) objects', out)]
    if len(want) != len(got) or any(n <= 0 for n in got):
        raise SystemExit('hide matched nothing: clips %s asked to hide objects, the render reported %s' % (want, got))


def render_pass(clips, rdir, cell, sup):
    """Blender -> raw colour + ID passes under rdir/raw/<clip>; returns the meta (origin pixel, cell)"""
    cmd = [blender(), '-b', '--factory-startup', '-P', os.path.join(M3D, 'talos_build.py'), '--',
           '--render', 'clips', '--out', rdir, '--super', str(sup), '--cell', str(cell), '--clip', ','.join(clips)]
    r = subprocess.run(cmd, env=dict(os.environ, TALOS_DESKTOP='1'), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if r.returncode != 0 or '[talos] done' not in r.stdout or 'Traceback' in r.stdout:
        raise SystemExit('blender render failed (exit %s):\n%s' % (r.returncode, r.stdout[-1500:]))
    check_hidden(r.stdout, clips)
    meta = json.load(open(os.path.join(rdir, 'meta.json')))
    missing = [c for c in clips if c not in meta['clips']]
    if missing:
        raise SystemExit('clips not rendered (is TALOS_DESKTOP honoured?): %s' % missing)
    return meta


def compose(rdir, fdir, clips, cell, line_k=1.0):
    """finish.compose, optionally with every part line `line_k` times heavier"""
    if line_k != 1.0:
        heavy = rdir + '-heavy'
        shutil.rmtree(heavy, ignore_errors=True)
        os.makedirs(heavy)
        os.symlink(os.path.join(rdir, 'raw'), os.path.join(heavy, 'raw'))
        info = json.load(open(os.path.join(rdir, 'ids.json')))
        for v in info['parts'].values():
            v['lw'] = v['lw'] * line_k
        json.dump(info, open(os.path.join(heavy, 'ids.json'), 'w'))
        rdir = heavy
    os.makedirs(fdir, exist_ok=True)
    finish.cmd_compose(rdir, fdir, clips, cell)


def load(path):
    return np.asarray(Image.open(path).convert('RGBA'))


def frames_of(fdir, clip):
    d = os.path.join(fdir, clip)
    return [os.path.join(d, f) for f in sorted(os.listdir(d)) if f.endswith('.png')]


def sole_row(a):
    """last opaque row (bottom edge, exclusive) of a straight-alpha frame"""
    ys = np.nonzero((a[..., 3] >= 128).any(axis=1))[0]
    return int(ys.max()) + 1


def cut(a, x0, y0, w, h):
    """cut a w*h window at (x0, y0), padding with transparent where it leaves the frame"""
    out = np.zeros((h, w, 4), np.uint8)
    sx0, sy0 = max(0, x0), max(0, y0)
    sx1, sy1 = min(a.shape[1], x0 + w), min(a.shape[0], y0 + h)
    if sx1 > sx0 and sy1 > sy0:
        out[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = a[sy0:sy1, sx0:sx1]
    return out


def with_stroke(a, r):
    """add a separate outer cream stroke `r` px wide around the figure (anti-aliased, round)"""
    fa = a[..., 3].astype(np.float32) / 255.0
    inside = a[..., 3] >= 128
    d = ndimage.distance_transform_edt(~inside)
    sa = np.clip(r + 0.5 - d, 0.0, 1.0)
    sa = np.maximum(sa, fa)
    oa = fa + sa * (1 - fa)
    oa = np.maximum(oa, sa)
    rgb = np.where(oa[..., None] > 1e-4,
                   (a[..., :3].astype(np.float32) * fa[..., None] + CREAM * (oa - fa)[..., None]) / np.maximum(oa, 1e-4)[..., None], 0)
    out = np.concatenate([np.clip(np.round(rgb), 0, 255), np.round(oa[..., None] * 255)], -1).astype(np.uint8)
    out[out[..., 3] == 0] = 0
    return out


def tidy(a):
    """transparent pixels carry no colour (so a resize or a premultiply never fringes)"""
    a = a.copy()
    a[a[..., 3] == 0] = 0
    return a


def window_origin(meta, ref_frame, scale):
    """top-left of the one cell window for this scale: x from the model origin, y so the idle sole sits on the anchor row"""
    ox = meta['origin_px'][0]
    ax, ay = ANCHOR[scale]
    return int(round(ox)) - ax, sole_row(ref_frame) - ay


def build_main(work, out, cell2, only=None):
    """only='life' / 'loops': render just the antics sheet / the idle life loops (d_idle for the window, then those clips) and write only
    that sheet: a preview in a minute instead of the full build"""
    cells = {2: cell2, 1: cell2 // 2}
    only_atlas = {'life': LIFE_ATLAS, 'loops': LOOPS_ATLAS}.get(only)
    clips_ = {'life': LIFE_CLIPS, 'loops': LOOPS_CLIPS}.get(only, MAIN_CLIPS)
    rows_ = [r for r in TC.ATLAS_ROWS if only_atlas is None or r[1] == only_atlas]
    sheets = {}
    infos = {}
    for sc in (2, 1):
        rdir = os.path.join(work, 'r%dx' % sc)
        fdir = os.path.join(work, 'f%dx' % sc)
        meta = render_pass(clips_, rdir, cells[sc], SUPER[sc])
        compose(rdir, fdir, clips_, cells[sc])
        w, h = SCALES[sc]
        ref = load(frames_of(fdir, 'd_idle')[0])
        x0, y0 = window_origin(meta, ref, sc)
        infos[sc] = {'cell': cells[sc], 'window': [x0, y0]}
        for atlas, rows_n in ATLAS_ROWS_N.items():
            if only_atlas is None or atlas == only_atlas:
                sheets[(atlas, sc)] = np.zeros((rows_n * h, ATLAS_COLS[atlas] * w, 4), np.uint8)
        fy0s = {}
        for name, atlas, row, clip, ncols, loop, still, seq in rows_:
            fl = frames_of(fdir, clip)
            if len(fl) != ncols:
                raise SystemExit('%s: %d frames rendered, table says %d' % (clip, len(fl), ncols))
            for c, fp in enumerate(fl):
                full = load(fp)
                fy0 = y0 if c in AIRBORNE.get(name, set()) else sole_row(full) - ANCHOR[sc][1]
                fy0s[(name, c)] = fy0
                fr = tidy(with_stroke(cut(full, x0, fy0, w, h), STROKE[sc]))
                sheets[(atlas, sc)][row * h:(row + 1) * h, c * w:(c + 1) * w] = fr
        # ember: the eye and core glow alone, no stroke. Cell k is the pose of EMBER_ROWS[k]'s `still` column, cut with the SAME window
        # (x0 and the same y shift) as that body frame, so the glow sits on the body's own glow to the pixel
        if only_atlas:
            continue
        efl = frames_of(fdir, 'd_ember-glow')
        if len(efl) != len(TC.EMBER_ROWS):
            raise SystemExit('ember: %d cells rendered, table says %d' % (len(efl), len(TC.EMBER_ROWS)))
        es = np.zeros((h, len(TC.EMBER_ROWS) * w, 4), np.uint8)
        rows = {r[0]: r for r in TC.ATLAS_ROWS}
        for k, name in enumerate(TC.EMBER_ROWS):
            es[:, k * w:(k + 1) * w] = tidy(cut(load(efl[k]), x0, fy0s[(name, rows[name][6])], w, h))
        sheets[('ember', sc)] = es
    for (atlas, sc), arr in sheets.items():
        Image.fromarray(arr, 'RGBA').save(os.path.join(out, '%s-%dx.png' % (atlas, sc)), optimize=True)
    return infos


def circle_mask(size, r_out, r_in=None):
    yy, xx = np.mgrid[0:size, 0:size]
    d = np.hypot(xx + 0.5 - size / 2, yy + 0.5 - size / 2)
    inner = np.clip(r_in + 0.5 - d, 0, 1) if r_in is not None else None
    outer = np.clip(r_out + 0.5 - d, 0, 1)
    return outer, inner


def part_reach(rdir, clip, x0, y0, size, k, ppb, names, what):
    """per frame of a bust clip: how far (final px) the farthest pixel of the parts called `names` in the ID pass lies from the centre of the
    mini cell, with their own part line (BUST_LINE_K times heavier) added. The ID pass is the figure's own part ids, before any clipping, so a
    part the ring would cut off is still seen here. `x0`, `y0` is the cell window in final px, `k` the supersampling the render came with."""
    info = json.load(open(os.path.join(rdir, 'ids.json')))
    found = {int(i): v['lw'] for i, v in info['parts'].items() if v['name'] in names}
    if len(found) != len(names):
        raise SystemExit('%s guard: parts %s not all in the ID pass (found %s)' % (what, sorted(names), sorted(found)))
    half = max(found.values()) * BUST_LINE_K * ppb / 2
    reach = []
    for fp in sorted(os.path.join(rdir, 'raw', clip, 'id', f) for f in os.listdir(os.path.join(rdir, 'raw', clip, 'id')) if f.endswith('.png')):
        ids = finish.decode_ids(load(fp))
        ys, xs = np.nonzero(np.isin(ids, list(found)))
        if not len(ys):
            raise SystemExit('%s guard: no %s pixels in %s (the ID pass lost them)' % (what, what, fp))
        d = np.hypot((xs + 0.5) / k - x0 - size / 2, (ys + 0.5) / k - y0 - size / 2)
        reach.append(float(d.max()) + half)
    return reach


def crest_reach(rdir, clip, x0, y0, size, k, ppb):
    return part_reach(rdir, clip, x0, y0, size, k, ppb, CREST_PARTS, 'crest')


def core_reach(rdir, clip, x0, y0, size, k, ppb):
    return part_reach(rdir, clip, x0, y0, size, k, ppb, CORE_PARTS, 'core')


def build_mini(work, out, cell2):
    ppb2 = None
    for sc in (2, 1):
        size = MINI[sc]
        ppb = size / (2 * BUST_RADIUS_BU)                 # px per BU
        cell = int(round(ppb * 7.2))
        rdir = os.path.join(work, 'b%dx' % sc)
        fdir = os.path.join(work, 'bf%dx' % sc)
        meta = render_pass(BUST_CLIPS, rdir, cell, SUPER[sc])
        compose(rdir, fdir, BUST_CLIPS, cell, BUST_LINE_K)
        ox, oy = meta['origin_px']
        real_ppb = cell / 7.2
        cy = oy - BUST_CENTER_Z * np.cos(np.radians(meta['elev_deg'])) * real_ppb
        x0 = int(round(ox - size / 2)); y0 = int(round(cy - size / 2))
        ring = MINI_RING[sc]
        r_out = size / 2 - 1.0
        r_in = r_out - ring
        reach = crest_reach(rdir, 'd_bust', x0, y0, size, SUPER[sc], real_ppb)
        print('crest reach %dx (px from the centre, ring starts at %.1f): %s' % (sc, r_in, ' '.join('%.1f' % r for r in reach)))
        if max(reach) > r_in:
            raise SystemExit('crest clipped at %dx: bust %s reaches %.1f px from the centre, the inner ring starts at %.1f' % (
                sc, [i for i, r in enumerate(reach) if r > r_in], max(reach), r_in))
        creach = core_reach(rdir, 'd_bust', x0, y0, size, SUPER[sc], real_ppb)
        print('core reach %dx (px from the centre, ring starts at %.1f): %s' % (sc, r_in, ' '.join('%.1f' % r for r in creach)))
        if max(creach) > r_in:
            raise SystemExit('core clipped at %dx: bust %s reaches %.1f px from the centre, the inner ring starts at %.1f' % (
                sc, [i for i, r in enumerate(creach) if r > r_in], max(creach), r_in))
        outer, inner = circle_mask(size, r_out, r_in)
        sheet = np.zeros((size, 4 * size, 4), np.uint8)
        fl = frames_of(fdir, 'd_bust')
        if len(fl) != 4:
            raise SystemExit('bust: %d frames' % len(fl))
        for c, fp in enumerate(fl):
            fr = cut(load(fp), x0, y0, size, size).astype(np.float32)
            fa = fr[..., 3] / 255.0 * inner                # the figure, clipped inside the ring
            ring_a = np.clip(outer - inner, 0, 1)
            oa = fa + ring_a * (1 - fa)
            rgb = np.where(oa[..., None] > 1e-4, (fr[..., :3] * fa[..., None] + CREAM * (oa - fa)[..., None]) / np.maximum(oa, 1e-4)[..., None], 0)
            cell_img = np.concatenate([np.clip(np.round(rgb), 0, 255), np.round(oa[..., None] * 255)], -1).astype(np.uint8)
            sheet[:, c * size:(c + 1) * size] = tidy(cell_img)
        Image.fromarray(sheet, 'RGBA').save(os.path.join(out, 'mini-%dx.png' % sc), optimize=True)
        # mini-ember: 4 columns like mini, one cell per state in MINI_EMBER_STATES (the statue's column stays empty), clipped to the ring
        efl = frames_of(fdir, 'd_bust_ember-glow')
        if len(efl) != len(TC.MINI_EMBER_STATES):
            raise SystemExit('mini ember: %d cells' % len(efl))
        es = np.zeros((size, 4 * size, 4), np.uint8)
        for k, state in enumerate(TC.MINI_EMBER_STATES):
            gl = cut(load(efl[k]), x0, y0, size, size).astype(np.uint8)
            gl[..., 3] = np.round(gl[..., 3].astype(np.float32) * inner).astype(np.uint8)
            c = TC.MINI_STATES.index(state)
            es[:, c * size:(c + 1) * size] = tidy(gl)
        Image.fromarray(es, 'RGBA').save(os.path.join(out, 'mini-ember-%dx.png' % sc), optimize=True)


def manifest():
    clips = {}
    for name, atlas, row, clip, ncols, loop, still, seq in TC.ATLAS_ROWS:
        clips[name] = {'atlas': atlas, 'row': row, 'frames': [[c, ms] for c, ms in seq], 'loop': loop, 'still': still}
        if name in TC.EMBER_ROWS:
            # the ember layer may sit on this clip only while the displayed column is one of `cols`; `cell` is its column in the ember atlas
            clips[name]['ember'] = {'cell': TC.EMBER_ROWS.index(name), 'cols': [still]}
    for name, src, loop, still, seq in TC.ATLAS_ALIASES:
        row = next(r for r in TC.ATLAS_ROWS if r[0] == src)
        clips[name] = {'atlas': row[1], 'row': row[2], 'frames': [[c, ms] for c, ms in seq], 'loop': loop, 'still': still}
    return {
        'v': 1,
        'cell': {'2x': list(SCALES[2]), '1x': list(SCALES[1])},
        'anchor': list(ANCHOR[2]),
        'clips': clips,
        'atlases': {
            'talos': {'grid': [COLS, 9], 'files': {'2x': 'talos-2x.png', '1x': 'talos-1x.png'}},
            'talos-ext': {'grid': [COLS, 3], 'files': {'2x': 'talos-ext-2x.png', '1x': 'talos-ext-1x.png'}},
            LIFE_ATLAS: {'grid': [COLS, ATLAS_ROWS_N[LIFE_ATLAS]], 'files': {'2x': 'talos-life-2x.png', '1x': 'talos-life-1x.png'}},
            LOOPS_ATLAS: {'grid': [TC.LOOP_COLS, ATLAS_ROWS_N[LOOPS_ATLAS]], 'files': {'2x': 'talos-loops-2x.png', '1x': 'talos-loops-1x.png'}},
            'ember': {'grid': [len(TC.EMBER_ROWS), 1], 'files': {'2x': 'ember-2x.png', '1x': 'ember-1x.png'}},
            'mini': {'grid': [4, 1], 'cell': {'2x': [MINI[2], MINI[2]], '1x': [MINI[1], MINI[1]]},
                     'states': list(TC.MINI_STATES), 'files': {'2x': 'mini-2x.png', '1x': 'mini-1x.png'}},
            'mini-ember': {'grid': [4, 1], 'cell': {'2x': [MINI[2], MINI[2]], '1x': [MINI[1], MINI[1]]},
                           'states': list(TC.MINI_EMBER_STATES),
                           'files': {'2x': 'mini-ember-2x.png', '1x': 'mini-ember-1x.png'}},
        },
    }


def dump_manifest(o, ind=0, lead=0):
    """companion.json as committed (prettier's layout): objects one key per line (2 spaces); an array stays on one line while its line fits
    in 120 columns, else one element per line; so a rebuild changes only what changed. `lead` is the width of the text before the value"""
    if isinstance(o, dict):
        pad = ' ' * (ind + 2)
        parts = []
        for k, v in o.items():
            head = '%s%s: ' % (pad, json.dumps(k))
            parts.append(head + dump_manifest(v, ind + 2, len(head)))
        return '{\n' + ',\n'.join(parts) + '\n' + ' ' * ind + '}'
    flat = json.dumps(o, separators=(', ', ': '))
    if isinstance(o, list) and lead + len(flat) + 1 > 120 and o and isinstance(o[0], list):
        pad = ' ' * (ind + 2)
        return '[\n' + ',\n'.join(pad + json.dumps(e, separators=(', ', ': ')) for e in o) + '\n' + ' ' * ind + ']'
    return flat


def cmd_build(out, cell2, keep=None, only=None):
    os.makedirs(out, exist_ok=True)
    work = keep or tempfile.mkdtemp(prefix='talos-atlas-')
    os.makedirs(work, exist_ok=True)
    try:
        infos = build_main(work, out, cell2, only)
        if only is None:
            build_mini(work, out, cell2)
            with open(os.path.join(out, 'companion.json'), 'w') as fh:
                fh.write(dump_manifest(manifest()) + '\n')
        print('built', out, json.dumps(infos))
    finally:
        if not keep:
            shutil.rmtree(work, ignore_errors=True)


def cmd_measure():
    """largest even 2x cell (px per 7.2 BU) such that every pose of every state fits the cell with 3 px border + the stroke"""
    work = tempfile.mkdtemp(prefix='talos-measure-')
    try:
        cell = 512
        rdir = os.path.join(work, 'r'); fdir = os.path.join(work, 'f')
        meta = render_pass(MAIN_CLIPS, rdir, cell, 2)
        compose(rdir, fdir, MAIN_CLIPS, cell)
        ref = load(frames_of(fdir, 'd_idle')[0])
        sole = sole_row(ref)
        ox = meta['origin_px'][0]
        up = left = right = 0
        for name, atlas, row, clip, ncols, loop, still, seq in TC.ATLAS_ROWS:
            cu = cl = cr = 0
            for fp in frames_of(fdir, clip):
                a = load(fp)
                ys, xs = np.nonzero(a[..., 3] >= 128)
                cu = max(cu, sole - ys.min()); cl = max(cl, ox - xs.min()); cr = max(cr, xs.max() + 1 - ox)
            print('  %-14s up %3d  left %3d  right %3d' % (name, cu, cl, cr))
            up, left, right = max(up, cu), max(left, cl), max(right, cr)
        margin = 3 + STROKE[2]
        ax = ANCHOR[2][0]; ay = ANCHOR[2][1]
        k_up = (ay - margin) / up
        k_x = min((ax - margin) / left, (SCALES[2][0] - ax - margin) / right)
        k = min(k_up, k_x)
        cell2 = int(np.floor(cell * k / 2.0) * 2)
        print('at 512: up %d px, left %d, right %d from the anchor column' % (up, left, right))
        print('fits at %.3f of that: recommended CELL2_RENDER = %d (px/BU %.2f); limiting side: %s' % (k, cell2, cell2 / 7.2, 'height' if k_up <= k_x else 'width'))
    finally:
        shutil.rmtree(work, ignore_errors=True)


def cmd_sheet(src, out, scale=2):
    """a labelled sheet of a built atlas dir on three backdrops, every state once, shown at 1:1 (scale 1) or 2x-pixels"""
    m = json.load(open(os.path.join(src, 'companion.json')))
    sc = '%dx' % scale
    w, h = m['cell'][sc]
    font = ImageFont.truetype(FONT, 14)
    tiles = []
    for name, c in m['clips'].items():
        atlas = Image.open(os.path.join(src, m['atlases'][c['atlas']]['files'][sc]))
        cols = []
        for col, ms in c['frames']:
            cols.append(col)
        seen = []
        for col in cols:
            if col not in seen:
                seen.append(col)
        for col in seen:
            cell = atlas.crop((col * w, c['row'] * h, (col + 1) * w, (c['row'] + 1) * h))
            tiles.append((name, col, cell))
    perrow = 8
    nrows = (len(tiles) + perrow - 1) // perrow
    sheet = Image.new('RGB', (perrow * (w + 8), nrows * (h + 30)), '#7a7f86')
    d = ImageDraw.Draw(sheet)
    for i, (name, col, cell) in enumerate(tiles):
        x = (i % perrow) * (w + 8) + 4; y = (i // perrow) * (h + 30) + 4
        sheet.paste(cell, (x, y + 22), cell)
        d.text((x, y), '%s #%d' % (name, col), font=font, fill='white')
    sheet.save(out)
    print('sheet', out, sheet.size)


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest='cmd', required=True)
    sp.add_parser('measure')
    b = sp.add_parser('build'); b.add_argument('--out', default=DEFAULT_OUT); b.add_argument('--cell2', type=int, default=CELL2_RENDER)
    b.add_argument('--keep', default=None, help='keep renders in this dir')
    b.add_argument('--only', default=None, choices=['life', 'loops'], help='render only the antics sheet or the idle life loops (a preview; writes that sheet and no manifest)')
    s = sp.add_parser('sheet'); s.add_argument('dir'); s.add_argument('out'); s.add_argument('--scale', type=int, default=2)
    a = ap.parse_args()
    if a.cmd == 'measure':
        cmd_measure()
    elif a.cmd == 'build':
        if a.cell2 % 2:
            raise SystemExit('--cell2 must be even (the 1x pass is exactly half)')
        cmd_build(a.out, a.cell2, a.keep, a.only)
    elif a.cmd == 'sheet':
        cmd_sheet(a.dir, a.out, a.scale)


if __name__ == '__main__':
    main()
