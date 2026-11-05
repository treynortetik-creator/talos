"""Figure masks from the 2D reference icons (assets/brand/talos-*-source.png).

The icon is a black-figure robot with cream lines on a flat terracotta field inside a Greek-key frame.
Background = the terracotta region 4-connected to a seed in the open field (flood fill), so the frame and
everything outside it are excluded; the figure = what the flood cannot reach inside the field, holes filled.

  python3 refmask.py <ref.png> <out-mask.png>      prints bbox + area, writes the mask (white = figure)
"""
import sys
import numpy as np
from PIL import Image
from collections import deque

TERRA = np.array([217, 105, 43])


def figure_mask(path, seed=(200, 300), tol=70):
    a = np.asarray(Image.open(path).convert('RGB')).astype(int)
    h, w, _ = a.shape
    near = np.abs(a - TERRA).sum(-1) < tol
    bg = np.zeros((h, w), bool)
    q = deque([seed]); bg[seed] = True
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            yy, xx = y + dy, x + dx
            if 0 <= yy < h and 0 <= xx < w and not bg[yy, xx] and near[yy, xx]:
                bg[yy, xx] = True; q.append((yy, xx))
    # field = bbox of the flooded background; figure = not background inside the field
    ys, xs = np.nonzero(bg)
    field = np.zeros_like(bg); field[ys.min():ys.max() + 1, xs.min():xs.max() + 1] = True
    fig = field & ~bg
    # drop the frame's inner edge: keep the largest connected component of fig
    lab = np.zeros(fig.shape, np.int32); best = (0, 0); n = 0
    for y0, x0 in zip(*np.nonzero(fig)):
        if lab[y0, x0]:
            continue
        n += 1; cnt = 0; q = deque([(y0, x0)]); lab[y0, x0] = n
        while q:
            y, x = q.popleft(); cnt += 1
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                yy, xx = y + dy, x + dx
                if 0 <= yy < h and 0 <= xx < w and fig[yy, xx] and not lab[yy, xx]:
                    lab[yy, xx] = n; q.append((yy, xx))
        if cnt > best[1]:
            best = (n, cnt)
    return lab == best[0]


if __name__ == '__main__':
    m = figure_mask(sys.argv[1])
    ys, xs = np.nonzero(m)
    print(f'bbox x {xs.min()}-{xs.max()} y {ys.min()}-{ys.max()}  w {xs.max()-xs.min()+1} h {ys.max()-ys.min()+1}  area {m.sum()}')
    Image.fromarray((m * 255).astype(np.uint8)).save(sys.argv[2])
