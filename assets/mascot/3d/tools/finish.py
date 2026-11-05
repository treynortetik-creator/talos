"""Little Talos: raw Blender passes -> finished frames and web assets.

  python3 finish.py compose <render_dir> <frames_dir> [--clip a,b] [--cell 512]
      For every clip in <render_dir>/raw/<clip>/: draw the cream contours from the ID pass (raw/<clip>/id/), composite them
      over the colour pass, area-average SUPER -> cell with premultiplied alpha, write <frames_dir>/<clip>/0001.png...
      Layers (raw/<clip>-glow/) are downsampled the same way, no contours.
  python3 finish.py pack <frames_dir> <web_dir> <render_dir/meta.json> [--web 256]
      Per clip: sprite sheet (WebP, lossless) + JSON, animated WebP, WebM (VP9 + alpha), all at --web px.
  python3 finish.py preview <frames_dir> <out_dir> <proof.sh>        MP4 per clip on terracotta (proof.sh clip, burned label)
  python3 finish.py contact <frames_dir> <out.png>                    contact sheet of every clip, burned labels

Contours (black-figure "incised" part edges): a pixel is line if a pixel of a DIFFERENT part (or the background) lies within
half the pair's width, width = min(lw of the two parts) from ids.json. Parts with lw 0 (irises, core, gear, highlights, the
cream smile/brows tubes, blush, sweat) never get a contour, so an iris sits in its socket with no ring of its own, as in the icon.
Coverage is anti-aliased (1 px ramp at SUPER) before the area average.
"""
import json, math, os, subprocess, sys
from multiprocessing import Pool
import numpy as np
from PIL import Image

ANIM_WEBP_PX = 192          # the animated WebP is the fallback (Safari without HEVC, img tags): smaller to keep it light
CREAM = np.array([0xF3, 0xE6, 0xCF], np.float32)
TERRA = '#D9692B'
FONT = '/System/Library/Fonts/Supplemental/Arial.ttf'


def load(p):
    return np.asarray(Image.open(p).convert('RGBA')).astype(np.float32)


def _srgb(x):
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)


# the ID material writes code c as linear ((16c + 8) / 255) ** 2.2; the Standard view transform then sRGB-encodes it
_CODES = np.round(255 * _srgb(((16 * np.arange(16) + 8) / 255.0) ** 2.2))


def _nearest_code(ch):
    return np.abs(ch[..., None] - _CODES[None, None, :]).argmin(-1).astype(np.int32)


def decode_ids(a):
    r = _nearest_code(a[..., 0]); g = _nearest_code(a[..., 1])
    ids = r + 16 * g
    ids[a[..., 3] < 128] = 0
    return ids


def contour(ids, lw_px):
    """anti-aliased contour coverage 0..1"""
    h, w = ids.shape
    lwp = lw_px[ids]                                   # per-pixel line width (px); background = inf
    R = int(math.ceil(np.nanmax(lw_px[np.isfinite(lw_px)]) / 2 + 1))
    pad = R
    P = np.pad(ids, pad, mode='edge'); Lp = np.pad(lwp, pad, mode='edge')
    cov = np.zeros((h, w), np.float32)
    for dy in range(-R, R + 1):
        for dx in range(-R, R + 1):
            d = math.hypot(dx, dy)
            if d == 0 or d > R:
                continue
            sid = P[pad + dy:pad + dy + h, pad + dx:pad + dx + w]
            slw = Lp[pad + dy:pad + dy + h, pad + dx:pad + dx + w]
            m = np.minimum(lwp, slw)
            c = np.clip(m / 2 - d + 0.5, 0, 1) * (sid != ids)
            np.maximum(cov, c, out=cov)
    return cov


def area_down(rgba, k):
    """premultiplied box average by an integer factor"""
    h, w, _ = rgba.shape
    a = rgba[..., 3:4] / 255.0
    pm = np.concatenate([rgba[..., :3] * a, a * 255.0], -1)
    pm = pm.reshape(h // k, k, w // k, k, 4).mean((1, 3))
    al = pm[..., 3:4] / 255.0
    rgb = np.where(al > 1e-4, pm[..., :3] / np.maximum(al, 1e-4), 0)
    out = np.concatenate([rgb, pm[..., 3:4]], -1)
    return np.clip(np.round(out), 0, 255).astype(np.uint8)


def compose_frame(col_p, id_p, lw_px, k):
    col = load(col_p)
    ids = decode_ids(load(id_p))
    cov = contour(ids, lw_px)[..., None]
    rgb = col[..., :3] * (1 - cov) + CREAM * cov
    al = np.maximum(col[..., 3:4], cov * 255.0)
    # where the colour pass is transparent and the line covers, rgb is cream (not black-premultiplied)
    rgb = np.where(col[..., 3:4] > 0, rgb, CREAM)
    return area_down(np.concatenate([rgb, al], -1), k)


_LW = None


def _init(lw):
    global _LW
    _LW = lw


def _compose_job(job):
    col_p, id_p, out_p, is_layer, cell = job
    k = Image.open(col_p).size[0] // cell
    if is_layer or not os.path.exists(id_p):
        out = area_down(load(col_p), k)
    else:
        out = compose_frame(col_p, id_p, _LW, k)
    Image.fromarray(out, 'RGBA').save(out_p, optimize=True)


def cmd_compose(rdir, fdir, clips=None, cell=512, sub='raw'):
    info = json.load(open(os.path.join(rdir, 'ids.json')))
    ppb = info['px_per_bu']
    n_ids = 256
    lw_px = np.zeros(n_ids, np.float32)
    lw_px[0] = np.inf
    for k, v in info['parts'].items():
        lw_px[int(k)] = v['lw'] * ppb
    raw = os.path.join(rdir, sub)
    for clip in sorted(os.listdir(raw)):
        if clips and clip.replace('-glow', '') not in clips:
            continue
        src = os.path.join(raw, clip)
        frames = sorted(f for f in os.listdir(src) if f.endswith('.png'))
        dst = os.path.join(fdir, clip); os.makedirs(dst, exist_ok=True)
        for f in os.listdir(dst):
            if f.endswith('.png'):
                os.remove(os.path.join(dst, f))
        jobs = [(os.path.join(src, f), os.path.join(src, 'id', f), os.path.join(dst, f), clip.endswith('-glow'), cell) for f in frames]
        with Pool(min(6, os.cpu_count() or 2), initializer=_init, initargs=(lw_px,)) as pool:
            pool.map(_compose_job, jobs)
        print(f'compose {clip}: {len(frames)} frames -> {dst}', flush=True)


def run(cmd):
    r = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if r.returncode:
        raise SystemExit(f'{cmd[0]} failed ({r.returncode}): {r.stderr.decode()[-400:]}')


def kb(p):
    return os.path.getsize(p) / 1024


def union_box(fdir, clips, pad=6):
    """one square crop shared by EVERY clip (so the app can swap clips without a jump): union of all alpha boxes"""
    x0 = y0 = 10 ** 9; x1 = y1 = -1; size = None
    for c in clips:
        d = os.path.join(fdir, c)
        for f in os.listdir(d):
            if not f.endswith('.png'):
                continue
            a = np.asarray(Image.open(os.path.join(d, f)))[..., 3]; size = a.shape[0]
            ys, xs = np.nonzero(a > 8)
            if len(xs):
                x0, x1, y0, y1 = min(x0, xs.min()), max(x1, xs.max()), min(y0, ys.min()), max(y1, ys.max())
    w, h = x1 - x0 + 1 + 2 * pad, y1 - y0 + 1 + 2 * pad; side = max(w, h)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    L = int(round(cx - side / 2)); T = int(round(cy - side / 2))
    L = max(0, min(size - side, L)); T = max(0, min(size - side, T))
    return (L, T, L + side, T + side)


def cmd_pack(fdir, wdir, meta_p, web=256):
    meta = json.load(open(meta_p))
    os.makedirs(wdir, exist_ok=True)
    report = {}
    box = [int(v) for v in union_box(fdir, list(meta['clips']))]
    side = box[2] - box[0]
    ox, oy = meta.get('origin_px', [meta['cell'] / 2, meta['cell'] * 0.9])
    anchor = [round(float((ox - box[0]) / side), 4), round(float((oy - box[1]) / side), 4)]
    print('crop', box, 'anchor', anchor)
    for clip, cm in meta['clips'].items():
        for layer in [clip] + [f'{clip}-{l}' for l in cm.get('layers', [])]:
            src = os.path.join(fdir, layer)
            frames = sorted(f for f in os.listdir(src) if f.endswith('.png'))
            n = len(frames); assert n == cm['frames'], (layer, n, cm['frames'])
            ims = [Image.open(os.path.join(src, f)).convert('RGBA').crop(box).resize((web, web), Image.LANCZOS) for f in frames]
            cols = math.ceil(math.sqrt(n)); rows = math.ceil(n / cols)
            sheet = Image.new('RGBA', (cols * web, rows * web), (0, 0, 0, 0))
            for i, im in enumerate(ims):
                sheet.paste(im, ((i % cols) * web, (i // cols) * web))
            sp = os.path.join(wdir, f'talos-{layer}-sheet.webp')
            sheet.save(sp, 'WEBP', quality=80, alpha_quality=100, method=4)
            js = {'image': os.path.basename(sp), 'video': {'webm': f'talos-{layer}.webm', 'mov': f'talos-{layer}.mov'}, 'animatedWebp': f'talos-{layer}.webp', 'frameWidth': web, 'frameHeight': web, 'frames': n, 'columns': cols, 'rows': rows,
                  'fps': meta['fps'], 'loop': cm['loop'], 'durationMs': round(n * 1000 / meta['fps']),
                  'anchor': anchor, 'anchorNote': 'ground point under the body, as a fraction of the frame (x, y from top-left)'}
            if 'hold' in cm:
                js['hold'] = cm['hold']
            if layer == clip and 'amplitude' in cm:
                js['amplitude'] = cm['amplitude']
            if layer != clip:
                js['layerOf'] = clip; js['blend'] = 'screen'
            elif cm.get('layers'):
                js['layers'] = {l: f'talos-{clip}-{l}-sheet.json' for l in cm['layers']}
            jp = os.path.join(wdir, f'talos-{layer}-sheet.json')
            json.dump(js, open(jp, 'w'), indent=1)
            # animated WebP (lossy with alpha; loop 0 = forever, 1 = play once)
            tmp = os.path.join(wdir, '_tmp'); os.makedirs(tmp, exist_ok=True)
            aw = ANIM_WEBP_PX
            for i, im in enumerate(ims):
                im.save(os.path.join(tmp, f'{i:04d}.png'))
                im.resize((aw, aw), Image.LANCZOS).save(os.path.join(tmp, f's{i:04d}.png'))
            wp = os.path.join(wdir, f'talos-{layer}.webp')
            dur = round(1000 / meta['fps'])
            run(['img2webp', '-loop', '0' if cm['loop'] else '1', '-lossy', '-q', '70', '-m', '4', '-d', str(dur)]
                + [os.path.join(tmp, f's{i:04d}.png') for i in range(n)] + ['-o', wp])
            # HEVC with alpha in .mov for Safari (macOS VideoToolbox)
            mv = os.path.join(wdir, f'talos-{layer}.mov')
            run(['ffmpeg', '-y', '-v', 'error', '-framerate', str(meta['fps']), '-i', os.path.join(tmp, '%04d.png'),
                 '-c:v', 'hevc_videotoolbox', '-allow_sw', '1', '-alpha_quality', '0.8', '-b:v', '900k', '-tag:v', 'hvc1', '-pix_fmt', 'bgra', mv])
            # WebM VP9 with alpha
            wm = os.path.join(wdir, f'talos-{layer}.webm')
            run(['ffmpeg', '-y', '-v', 'error', '-framerate', str(meta['fps']), '-i', os.path.join(tmp, '%04d.png'),
                 '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '32', '-row-mt', '1', '-auto-alt-ref', '0', wm])
            for f in os.listdir(tmp):
                os.remove(os.path.join(tmp, f))
            os.rmdir(tmp)
            report[layer] = {'sheet_kb': round(kb(sp), 1), 'webp_kb': round(kb(wp), 1), 'webm_kb': round(kb(wm), 1), 'mov_kb': round(kb(mv), 1),
                             'json_kb': round(kb(jp), 2), 'frames': n}
            print(f'{layer:16s} {n:3d}f  sheet {kb(sp):7.1f} KB  webp {kb(wp):7.1f} KB  webm {kb(wm):7.1f} KB  mov {kb(mv):7.1f} KB', flush=True)
    tot = {k: round(sum(v[k] for v in report.values()), 1) for k in ('sheet_kb', 'webp_kb', 'webm_kb', 'mov_kb', 'json_kb')}
    report['_total'] = tot
    json.dump(report, open(os.path.join(wdir, 'sizes.json'), 'w'), indent=1)
    print('TOTAL', tot)
    return report


def flatten(src_dir, dst_dir, size=720):
    os.makedirs(dst_dir, exist_ok=True)
    frames = sorted(f for f in os.listdir(src_dir) if f.endswith('.png'))
    for f in frames:
        im = Image.open(os.path.join(src_dir, f)).convert('RGBA').resize((size, size), Image.LANCZOS)
        bg = Image.new('RGBA', im.size, TERRA); bg.alpha_composite(im)
        bg.convert('RGB').save(os.path.join(dst_dir, f))
    return len(frames)


def cmd_preview(fdir, odir, proof, meta_p=None, repeat=3):
    os.makedirs(odir, exist_ok=True)
    meta = json.load(open(meta_p)) if meta_p else {'clips': {}}
    for clip in sorted(os.listdir(fdir)):
        src = os.path.join(fdir, clip)
        if not os.path.isdir(src):
            continue
        tmp = os.path.join(odir, '_flat'); n = flatten(src, tmp)
        cm = meta['clips'].get(clip.replace('-glow', ''), {})
        loops = repeat if cm.get('loop', True) else 1
        raw = os.path.join(odir, f'_{clip}.mp4')
        listing = []
        # loops repeat; one-shots play once then hold the last frame ~1 s
        seq = []
        for _ in range(loops):
            seq += list(range(1, n + 1))
        if not cm.get('loop', True):
            seq += [n] * 24
        for j, i in enumerate(seq):
            os.symlink(os.path.abspath(os.path.join(tmp, f'{i:04d}.png')), os.path.join(tmp, f's{j:05d}.png'))
        run(['ffmpeg', '-y', '-v', 'error', '-framerate', '24', '-i', os.path.join(tmp, 's%05d.png'), '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', raw])
        label = f'Little Talos 3D: {clip}  ({n} f @ 24 fps, {"loop" if cm.get("loop", True) else "one-shot"})'
        out = os.path.join(odir, f'talos-{clip}-preview.mp4')
        if proof and os.path.exists(proof):
            subprocess.run(['bash', proof, 'clip', raw, out, '--label', label], check=True, stdout=subprocess.DEVNULL)
            os.remove(raw)
        else:
            os.replace(raw, out)
        print('preview', out, f'{kb(out):.0f} KB')
        for f in os.listdir(tmp):
            os.remove(os.path.join(tmp, f))
        os.rmdir(tmp)


def cmd_contact(fdir, out, cols=6, size=300, clips=None):
    """one row per clip: `cols` evenly spaced frames, labelled"""
    from PIL import ImageDraw, ImageFont
    font = ImageFont.truetype(FONT, 22); small = ImageFont.truetype(FONT, 16)
    names = clips or sorted(d for d in os.listdir(fdir) if os.path.isdir(os.path.join(fdir, d)))
    W = 180 + cols * size; H = len(names) * (size + 10) + 10
    sheet = Image.new('RGB', (W, H), '#2a211c')
    d = ImageDraw.Draw(sheet)
    for r, clip in enumerate(names):
        src = os.path.join(fdir, clip)
        frames = sorted(f for f in os.listdir(src) if f.endswith('.png'))
        n = len(frames); y = 10 + r * (size + 10)
        d.text((14, y + size // 2 - 20), clip, font=font, fill='#F3E6CF')
        d.text((14, y + size // 2 + 10), f'{n} frames', font=small, fill='#cdbfa4')
        for c in range(cols):
            i = round(c * (n - 1) / max(1, cols - 1))
            im = Image.open(os.path.join(src, frames[i])).convert('RGBA').resize((size, size), Image.LANCZOS)
            bg = Image.new('RGBA', (size, size), TERRA); bg.alpha_composite(im)
            sheet.paste(bg.convert('RGB'), (180 + c * size, y))
            d.text((180 + c * size + 8, y + 6), f'{clip} #{i + 1}', font=small, fill='#141110')
    sheet.save(out)
    print('contact', out, sheet.size)


if __name__ == '__main__':
    a = sys.argv[1:]
    opt = lambda k, dflt=None: a[a.index(k) + 1] if k in a else dflt
    if a[0] == 'compose':
        cl = opt('--clip'); cmd_compose(a[1], a[2], cl.split(',') if cl else None, int(opt('--cell', 512)), opt('--sub', 'raw'))
    elif a[0] == 'pack':
        cmd_pack(a[1], a[2], a[3], int(opt('--web', 256)))
    elif a[0] == 'preview':
        cmd_preview(a[1], a[2], a[3], opt('--meta'))
    elif a[0] == 'contact':
        cl = opt('--clip'); cmd_contact(a[1], a[2], clips=cl.split(',') if cl else None)
