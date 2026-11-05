"""Tests for the desktop companion art. Each one fails when the thing it guards is broken (see the mutation cases).

  python3 -m unittest discover -s assets/mascot/3d/tools -p 'test_atlas.py'
"""
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
M3D = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import check_atlas as CA  # noqa: E402
import atlas as ATLAS  # noqa: E402
import atlas_proof as PROOF  # noqa: E402

COMMITTED = os.environ.get('TALOS_ATLAS_DIR') or CA.DEFAULT     # the override is only for proving the tests go red against a broken build
# sha256 over every pose of the 8 web clips and 3 stills as they were on origin/main 7fd8106 (the web assets must not change)
WEB_POSES_SHA = '842b3ea2cb829189a620891ff65c9e664ef3c6ef0b1bbd8493731c1390ca0225'
WEB_CLIPS = ['idle', 'working', 'talking', 'thinking', 'beaming', 'worried', 'wave', 'rounds']


def fails(root, skip=('palette',)):
    """the palette scan is most of a check's time and only the palette tests need it, so every other case skips it"""
    return CA.run(root, quiet=True, skip=skip).fails


def same_art(a, b, per_px=16, frac=0.002):
    """two RGBA renders of the same art: same shape, no pixel off by more than `per_px` levels in any channel, and at most `frac` of the
    pixels off by anything at all (GPU and Blender-build noise is a handful of pixels a few levels off; a real change is neither)"""
    if a.shape != b.shape:
        return False
    d = np.abs(a.astype(np.int16) - b.astype(np.int16)).max(axis=-1)
    return bool(d.max() <= per_px and (d > 0).mean() <= frac)


def blender():
    for c in (os.environ.get('BLENDER'), shutil.which('blender'), '/opt/homebrew/bin/blender'):
        if c and os.path.exists(c):
            return c
    return None


class Mutated(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='atlas-test-')
        shutil.copytree(COMMITTED, self.dir, dirs_exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def manifest(self, fn):
        p = os.path.join(self.dir, 'companion.json')
        m = json.load(open(p))
        fn(m)
        json.dump(m, open(p, 'w'))

    def image(self, name, fn):
        p = os.path.join(self.dir, name)
        a = np.array(Image.open(p).convert('RGBA'))
        fn(a)
        Image.fromarray(a, 'RGBA').save(p)

    def test_committed_art_passes(self):
        self.assertEqual(fails(COMMITTED), [])

    def test_ms_out_of_range_fails(self):
        self.manifest(lambda m: m['clips']['waving']['frames'].__setitem__(0, [0, 10]))
        self.assertTrue(any('ms 10' in f for f in fails(self.dir)))
        self.manifest(lambda m: m['clips']['waving']['frames'].__setitem__(0, [0, 4001]))
        self.assertTrue(any('ms 4001' in f for f in fails(self.dir)))

    def test_bad_still_fails(self):
        self.manifest(lambda m: m['clips']['failed'].__setitem__('still', 9))
        self.assertTrue(any('still column valid' in f for f in fails(self.dir)))

    def test_empty_cell_in_a_clip_fails(self):
        self.manifest(lambda m: m['clips']['landed']['frames'].append([5, 100]))
        self.assertTrue(any('every used column is drawn' in f for f in fails(self.dir)))

    def test_an_antic_that_does_not_end_standing_fails(self):
        """the nap's last cell is the lying frame: Idle would pop up from the floor"""
        self.manifest(lambda m: m['clips']['nap']['frames'].append([5, 200]))
        self.assertTrue(any('antic nap' in f and 'last cell is the idle stance' in f for f in fails(self.dir)))

    def test_a_sleep_that_does_not_end_on_the_asleep_rest_fails(self):
        self.manifest(lambda m: m['clips']['sleep']['frames'].append([3, 200]))
        self.assertTrue(any('sleep ends and wake starts on the nap still' in f for f in fails(self.dir)))

    def test_a_mirrored_z_fails(self):
        """the Z's were once drawn backwards (an S): mirror the whole nap row and the check must go red"""
        def f(a):
            h, w = 208, 192
            a[1 * h:2 * h, 5 * w:8 * w] = a[1 * h:2 * h, 5 * w:8 * w][:, ::-1]
        self.image('talos-life-2x.png', f)
        self.assertTrue(any('nap 2x' in x and 'the Z is not mirrored' in x for x in fails(self.dir)))

    def test_a_blank_antic_cell_fails(self):
        def f(a):
            h, w = 208, 192
            a[2 * h:3 * h, 3 * w:4 * w] = 0                  # stretch #3, the yawn
        self.image('talos-life-2x.png', f)
        self.assertTrue(any('clip stretch 2x: every used column is drawn' in x for x in fails(self.dir)))

    def test_missing_atlas_file_fails(self):
        os.remove(os.path.join(self.dir, 'talos-1x.png'))
        self.assertTrue(any('file talos-1x.png' in f for f in fails(self.dir)))

    def test_wrong_grid_fails(self):
        self.image('talos-2x.png', lambda a: None)
        p = os.path.join(self.dir, 'talos-2x.png')
        Image.open(p).crop((0, 0, 1536, 1800)).save(p)
        self.assertTrue(any('grid talos 2x' in f for f in fails(self.dir)))

    def test_touching_the_cell_border_fails(self):
        def f(a):
            a[0:208, 0:1] = (243, 230, 207, 255)           # a line down the left edge of the idle cell
        self.image('talos-2x.png', f)
        self.assertTrue(any(x.startswith('border idle 2x #0') for x in fails(self.dir)))

    def test_feet_off_the_anchor_fails(self):
        def f(a):
            cell = a[0:208, 0:192].copy()
            a[0:208, 0:192] = 0
            a[0:200, 0:192] = cell[8:208]                  # idle #0 lifted 8 px: sole at 192, not 200
        self.image('talos-2x.png', f)
        self.assertTrue(any(x.startswith('feet idle 2x #0') for x in fails(self.dir)))

    def test_thin_keyline_fails(self):
        # drop the cream outer line to one pixel of cream: erase every cream pixel whose neighbour is transparent but one step in
        def f(a):
            c = a[0:208, 0:192]
            op = c[..., 3] >= 128
            from scipy import ndimage
            d = ndimage.distance_transform_edt(op)
            c[(d <= 2.0) & op] = 0
        self.image('talos-2x.png', f)
        self.assertTrue(any(x.startswith('keyline idle 2x #0') for x in fails(self.dir)))

    def test_fourth_colour_fails(self):
        def f(a):
            a[20:60, 20:60, :3] = (40, 200, 60)
            a[20:60, 20:60, 3] = 255
        self.image('talos-2x.png', f)
        self.assertTrue(any(x.startswith('palette talos 2x') for x in fails(self.dir, skip=())))

    def test_1x_and_2x_disagree_fails(self):
        self.image('talos-1x.png', lambda a: a.__setitem__((slice(0, 104), slice(96, 192)), 0))
        self.assertTrue(any('2x and 1x draw the same columns' in f for f in fails(self.dir)))

    def test_over_budget_fails(self):
        # the size check adds up the listed files, so one incompressible PNG just over the 4 MB budget is enough
        noise = (np.random.RandomState(1).rand(1100, 1100, 4) * 255).astype(np.uint8)
        noise[..., 3] = 255
        Image.fromarray(noise, 'RGBA').save(os.path.join(self.dir, 'ember-1x.png'))
        self.assertTrue(any('size under 4 MB' in f for f in fails(self.dir)))

    # ---- the ember layer (spec 3.2). The first cut was one idle-stance cell: four eyes on Working and Needs you, no visible step
    def ember_cell(self, name, fn, scale='2x'):
        m = json.load(open(os.path.join(self.dir, 'companion.json')))
        w, h = m['cell'][scale]
        k = m['clips'][name]['ember']['cell']
        self.image('ember-%s.png' % scale, lambda a: fn(a[:, k * w:(k + 1) * w]))

    def test_ember_off_the_glow_fails(self):
        def shift(c):
            c[:] = np.roll(c, 8, axis=1)                    # 8 px sideways: the eyes land beside the body's own eyes
        self.ember_cell('running', shift)
        self.assertTrue(any(x.startswith('ember running 2x #7 lies on the body glow') for x in fails(self.dir)))

    def test_one_idle_cell_for_every_pose_fails(self):
        """the original defect: the ember cut from the idle stance sat over the running pose"""
        m = json.load(open(os.path.join(self.dir, 'companion.json')))
        w = m['cell']['2x'][0]
        i, r = m['clips']['idle']['ember']['cell'], m['clips']['running']['ember']['cell']
        self.image('ember-2x.png', lambda a: a.__setitem__((slice(None), slice(r * w, (r + 1) * w)), a[:, i * w:(i + 1) * w].copy()))
        f = fails(self.dir)
        self.assertTrue(any(x.startswith('ember running 2x #7 lies on the body glow') for x in f), f)

    def test_ember_that_matches_the_baked_glow_fails(self):
        """a layer with the body's own colours changes nothing when its opacity steps"""
        m = json.load(open(os.path.join(self.dir, 'companion.json')))
        w, h = m['cell']['2x']
        c = m['clips']['idle']
        body = np.array(Image.open(os.path.join(self.dir, 'talos-2x.png')).convert('RGBA'))[c['row'] * h:(c['row'] + 1) * h, 0:w]

        def same(cell):
            mask = cell[..., 3] >= 128
            cell[..., :3][mask] = body[..., :3][mask]
        self.ember_cell('idle', same)
        self.assertTrue(any(x.startswith('ember idle 2x #0 steps visibly') for x in fails(self.dir)))

    def test_mini_ember_off_the_glow_fails(self):
        s = 88
        self.image('mini-ember-2x.png', lambda a: a.__setitem__((slice(None), slice(0, s)), np.roll(a[:, 0:s], 8, axis=1)))
        self.assertTrue(any(x.startswith('mini-ember pleased 2x lies on the glow') for x in fails(self.dir)))

    # ---- Poke's hop, the walk, the holds, the hammer
    def test_a_hop_that_does_not_land_fails(self):
        m = json.load(open(os.path.join(self.dir, 'companion.json')))
        w, h = m['cell']['2x']
        row = m['clips']['jumping']['row']
        self.image('talos-2x.png', lambda a: a.__setitem__((slice(row * h, (row + 1) * h), slice(3 * w, 4 * w)), a[row * h:(row + 1) * h, 2 * w:3 * w].copy()))
        self.assertTrue(any(x.startswith('hop: Poke lands') for x in fails(self.dir)))

    def test_mirrored_walk_fails(self):
        m = json.load(open(os.path.join(self.dir, 'companion.json')))
        w, h = m['cell']['2x']
        r, l = m['clips']['running-right']['row'], m['clips']['running-left']['row']

        def mirror(a):
            for col in range(8):
                a[l * h:(l + 1) * h, col * w:(col + 1) * w] = a[r * h:(r + 1) * h, col * w:(col + 1) * w][:, ::-1]
        self.image('talos-2x.png', mirror)
        self.assertTrue(any(x.startswith('walk: ') for x in fails(self.dir)))

    def test_waiting_that_loops_fails(self):
        self.manifest(lambda m: m['clips']['waiting'].__setitem__('loop', True))
        self.assertTrue(any(x.startswith('hold: waiting') for x in fails(self.dir)))

    def test_waiting_that_ends_off_its_held_pose_fails(self):
        self.manifest(lambda m: m['clips']['waiting']['frames'].append([2, 140]))
        self.assertTrue(any(x.startswith('hold: waiting') for x in fails(self.dir)))

    def test_a_snapping_hammer_fails(self):
        self.manifest(lambda m: m['clips']['running']['frames'].__setitem__(4, [4, 120]))
        self.assertTrue(any(x.startswith('hammer: ') for x in fails(self.dir)))


class Committed(unittest.TestCase):
    def sheets(self, scale):
        m = json.load(open(os.path.join(COMMITTED, 'companion.json')))
        return m, np.array(Image.open(os.path.join(COMMITTED, m['atlases']['talos']['files'][scale])).convert('RGBA'))

    def test_every_manifest_state_from_the_spec_exists(self):
        m = json.load(open(os.path.join(COMMITTED, 'companion.json')))
        for name in ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review', 'talking', 'statue', 'landed']:
            self.assertIn(name, m['clips'])
        self.assertEqual(m['anchor'], [96, 200])
        self.assertEqual(m['cell'], {'2x': [192, 208], '1x': [96, 104]})

    def test_hop_lands(self):
        """Poke plays columns 0-3 and cuts to Idle: column 3 must stand on the ground (it was 8.5 pt up)"""
        m, a = self.sheets('2x')
        w, h = m['cell']['2x']
        row = m['clips']['jumping']['row']
        soles = []
        for col in range(4):
            al = a[row * h:(row + 1) * h, col * w:(col + 1) * w, 3]
            soles.append(int(np.nonzero((al >= 128).any(axis=1))[0].max()) + 1)
        self.assertLessEqual(abs(soles[3] - soles[0]), 1, soles)
        self.assertGreaterEqual(soles[0] - min(soles[1], soles[2]), 6, soles)

    def test_ember_layer_is_glow_only_and_warm(self):
        a = np.array(Image.open(os.path.join(COMMITTED, 'ember-2x.png')).convert('RGBA'))
        op = a[..., 3] > 128
        self.assertTrue(op.any())
        self.assertLess(op.mean(), 0.02)
        rgb = a[..., :3][op].astype(int)
        self.assertTrue((rgb[:, 0] > rgb[:, 2] + 25).all(), 'ember pixels must be warm')

    def test_every_ember_state_has_its_own_cell(self):
        """Idle, settled Working, Needs you and every Reduce Motion still: one cell each, none shared"""
        m = json.load(open(os.path.join(COMMITTED, 'companion.json')))
        cells = {n: c['ember']['cell'] for n, c in m['clips'].items() if 'ember' in c}
        for name in ('idle', 'running', 'waiting', 'failed', 'jumping'):
            self.assertIn(name, cells)
        self.assertEqual(len(set(cells.values())), len(cells))
        self.assertNotIn('statue', cells)                  # asleep: eyes dim, no ember
        self.assertEqual(m['atlases']['ember']['grid'], [len(cells), 1])

    def test_busts_have_no_rivets_and_the_prefix_matches_real_objects(self):
        """the bust renders hide the objects named `rivet*`; a prefix that matches nothing would ship them silently (spec 9.4)"""
        import talos_clips
        for clip in ('d_bust', 'd_bust_ember'):
            self.assertIn('rivet', talos_clips.DESKTOP_CLIPS[clip][3]['hide'])
        for clip in talos_clips.DESKTOP_CLIPS:
            if clip not in ('d_bust', 'd_bust_ember'):
                self.assertNotIn('hide', talos_clips.DESKTOP_CLIPS[clip][3])


class Antics(unittest.TestCase):
    """the idle antics sheet: the manifest grid drives it, it is small, and nothing in the older sheets moved"""

    def setUp(self):
        self.m = json.load(open(os.path.join(COMMITTED, 'companion.json')))

    def test_the_life_sheet_is_listed_with_its_grid_and_the_files_exist(self):
        at = self.m['atlases']['talos-life']
        self.assertEqual(at['grid'], [8, 6])
        for sc in ('2x', '1x'):
            self.assertTrue(os.path.exists(os.path.join(COMMITTED, at['files'][sc])))

    def test_every_antic_and_both_transitions_are_there(self):
        for name in ('sit', 'nap', 'stretch', 'scratch', 'stumble', 'tinker', 'sleep', 'wake'):
            c = self.m['clips'][name]
            self.assertEqual(c['atlas'], 'talos-life')
            self.assertNotIn('ember', c, 'the glow of an antic is in the body: an ember layer would sit on the wrong pose')
            self.assertFalse(c['loop'])
        self.assertGreaterEqual(len(CA.ANTICS), 6)

    def test_the_whole_art_stays_reasonably_small(self):
        total = sum(os.path.getsize(os.path.join(COMMITTED, f)) for f in os.listdir(COMMITTED))
        self.assertLess(total, 4 * 1024 * 1024, total)      # was 3 MiB before the idle life loops (about 1.7 MB of real frames)
        for sc in ('2x', '1x'):
            self.assertLess(os.path.getsize(os.path.join(COMMITTED, 'talos-life-%s.png' % sc)), 700 * 1024)

    def test_no_sheet_decodes_to_more_than_sixteen_mib(self):
        """the file size is small but the Mac holds each sheet decoded (width x height x 4 bytes): the loops sheet at 2x is 15.2 MiB, one
        row per clip with the empty cells of the shorter ones. A sheet that doubles this must be argued for, not slip in."""
        cap = 16 * 1024 * 1024
        sizes = {}
        for f in sorted(os.listdir(COMMITTED)):
            if f.endswith('.png'):
                w, h = Image.open(os.path.join(COMMITTED, f)).size
                sizes[f] = w * h * 4
        self.assertIn('talos-loops-2x.png', sizes)
        for f, n in sizes.items():
            self.assertLessEqual(n, cap, '%s decodes to %.1f MiB' % (f, n / 2 ** 20))

    def test_the_older_sheets_and_clips_are_exactly_as_they_were(self):
        import subprocess
        old = subprocess.run(['git', 'show', 'origin/main:apps/desktop/Resources/companion/companion.json'], cwd=M3D, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, text=True)
        if old.returncode != 0:
            self.skipTest('no origin/main to compare with')
        base = json.loads(old.stdout)
        for k, v in base['clips'].items():
            self.assertEqual(self.m['clips'][k], v, k)
        for k, v in base['atlases'].items():
            self.assertEqual(self.m['atlases'][k], v, k)

    def test_the_z_is_hidden_unless_a_pose_asks_for_it(self):
        import talos_clips as T
        os.environ['TALOS_DESKTOP'] = '1'
        shown = {k for k, (n, loop, fn, extra) in T.DESKTOP_CLIPS.items() for i in range(n) if 'zzz_a' in fn(i, n)}
        self.assertEqual(shown, {'d_nap'}, 'only the nap has Z letters')

    def test_the_antic_clips_are_pure_poses_with_known_bones(self):
        import talos_clips as T
        known = set(T.base()) | {'zzz_a', 'zzz_b'}
        for k in ('d_sit', 'd_nap', 'd_stretch', 'd_scratch', 'd_stumble', 'd_tinker'):
            n, loop, fn, extra = T.DESKTOP_CLIPS[k]
            for i in range(n):
                self.assertLessEqual(set(fn(i, n)) - known, set(), '%s %d names a bone the rig does not have' % (k, i))


class Loops(unittest.TestCase):
    """the idle life loops (talos-loops): real body poses, closed loops, planted feet, a sane size"""
    NAMES = ('idle-loop', 'idle-look', 'needs-loop', 'needs-beckon', 'needs-tap')

    def setUp(self):
        self.m = json.load(open(os.path.join(COMMITTED, 'companion.json')))
        import talos_clips as T
        self.T = T

    def test_the_sheet_and_every_loop_are_in_the_manifest_with_the_right_lengths(self):
        at = self.m['atlases']['talos-loops']
        self.assertEqual(at['grid'], [self.T.LOOP_COLS, 5])
        want = {'idle-loop': 4000, 'idle-look': 5000, 'needs-loop': 4000, 'needs-beckon': 3000, 'needs-tap': 3000}
        for n in self.NAMES:
            c = self.m['clips'][n]
            self.assertEqual(c['atlas'], 'talos-loops')
            self.assertNotIn('ember', c)
            self.assertEqual(sum(ms for _, ms in c['frames']), want[n], n)
            self.assertTrue(all(83 <= ms <= 420 for _, ms in c['frames']), n)
            self.assertEqual(c['loop'], n in ('idle-loop', 'needs-loop'))

    def test_every_pose_function_is_a_closed_loop_that_starts_on_its_rest_stance(self):
        T = self.T
        for n, fn in T.LOOP_FNS.items():
            L = T.LOOP_LEN[n]
            self.assertLess(max(abs(a - b) for a, b in zip(T.pose_vec(fn(0, L)), T.pose_vec(fn(L, L)))), 1e-6, '%s: frame n must equal frame 0' % n)
        base = T.pose_vec(T.base())
        for n in ('idle-loop', 'idle-look'):
            self.assertLess(max(abs(a - b) for a, b in zip(base, T.pose_vec(T.LOOP_FNS[n](0, T.LOOP_LEN[n])))), 0.5, '%s starts on the idle stance' % n)
        wait = T.pose_vec(T.c_waiting(0))
        for n in ('needs-loop', 'needs-beckon', 'needs-tap'):
            d = max(abs(a - b) for a, b in zip(wait, T.pose_vec(T.LOOP_FNS[n](0, T.LOOP_LEN[n]))))
            self.assertLess(d, 6.0, '%s starts on the waiting pose (off by %.1f)' % (n, d))

    def test_the_loops_move_the_body_not_the_figure(self):
        """no clip slides the root along the ground, and every ankle is counter-offset so the feet stay where they stood; the body channels
        (chest, torso, head, arms) all change over a loop"""
        T = self.T
        for n, fn in T.LOOP_FNS.items():
            L = T.LOOP_LEN[n]
            poses = [fn(i, L) for i in range(L)]
            for p in poses:
                self.assertEqual(p['root']['rot'], (0, 0, 0), n)
                for k, ref in (('leg_R', T.LEG_R_REF), ('leg_L', T.LEG_L_REF)):
                    world = tuple(p['root']['loc'][j] + p[k]['ankle'][j] for j in (0, 1))
                    tap = n == 'needs-tap' and k == 'leg_L'
                    self.assertTrue(tap or all(abs(world[j] - ref['ankle'][j]) < 1e-9 for j in (0, 1)), '%s %s: a foot slid' % (n, k))
            span = lambda f: max(f(p) for p in poses) - min(f(p) for p in poses)
            self.assertGreater(span(lambda p: p['chest']['scale'][2]) if n in ('idle-loop', 'idle-look') else span(lambda p: p['torso']['rot'][0]), 0.02, n)
            self.assertGreater(span(lambda p: p['head']['rot'][2]) + span(lambda p: p['head']['rot'][0]), 2.0, '%s: the head moves' % n)

    def test_the_cell_sampler_holds_to_its_limits_and_is_deterministic(self):
        T = self.T
        for n, fn in T.LOOP_FNS.items():
            cells = T.loop_cells(fn, T.LOOP_TOL[n], T.LOOP_LEN[n])
            self.assertEqual(cells, T.loop_cells(fn, T.LOOP_TOL[n], T.LOOP_LEN[n]))
            self.assertEqual(sum(h for _, h in cells), T.LOOP_LEN[n])
            self.assertTrue(all(T.LOOP_MIN_HOLD <= h <= T.LOOP_MAX_HOLD + 1 for _, h in cells), n)
            self.assertLessEqual(len(cells), T.LOOP_COLS)

    def test_the_loop_sheets_are_small_and_the_feet_stay_planted_in_the_pixels(self):
        total = 0
        for sc in ('2x', '1x'):
            total += os.path.getsize(os.path.join(COMMITTED, 'talos-loops-%s.png' % sc))
        self.assertLess(total, 1_900_000, total)
        img = np.asarray(Image.open(os.path.join(COMMITTED, 'talos-loops-2x.png')).convert('RGBA'))
        w, h = self.m['cell']['2x']
        for n in ('idle-loop', 'needs-loop'):
            c = self.m['clips'][n]
            left_x, right_x, soles, shapes = [], [], [], []
            for col, _ in c['frames']:
                cell = img[c['row'] * h:(c['row'] + 1) * h, col * w:(col + 1) * w, 3] >= 128
                ys = np.nonzero(cell.any(axis=1))[0]
                soles.append(int(ys.max()))
                xs = np.nonzero(cell[ys.max() - 14:ys.max() + 1])[1]       # the soles: each foot on its own side of the figure's middle
                left_x.append(float(xs[xs < w // 2].mean())); right_x.append(float(xs[xs >= w // 2].mean()))
                shapes.append(cell)
            self.assertLessEqual(max(soles) - min(soles), 1, '%s: soles %s' % (n, soles))
            for side, xs_ in (('left', left_x), ('right', right_x)):
                self.assertLess(max(xs_) - min(xs_), 3.0, '%s: the %s foot slid (%s)' % (n, side, xs_))
            # the body changes shape: after lining up the head tops, many pixels differ from cell 0
            worst = 0
            for s_ in shapes[1:]:
                worst = max(worst, int((s_ ^ shapes[0]).sum()))
            self.assertGreater(worst, 400, '%s: cells barely differ (%d px)' % (n, worst))


class HideGuard(unittest.TestCase):
    def test_a_hide_that_matched_nothing_is_an_error(self):
        with self.assertRaises(SystemExit):
            ATLAS.check_hidden('[talos] hid 0 objects [\'rivet\']\n', ['d_bust'])
        with self.assertRaises(SystemExit):
            ATLAS.check_hidden('[talos] done\n', ['d_bust', 'd_bust_ember'])       # asked, never reported
        ATLAS.check_hidden("[talos] hid 35 objects ['rivet']\n[talos] hid 35 objects ['rivet']\n", ['d_bust', 'd_bust_ember'])
        ATLAS.check_hidden('[talos] done\n', ['d_idle'])                              # nothing asked, nothing reported

    @unittest.skipUnless(blender(), 'needs Blender (the real rig); the owner Mac has it, the CI image does not')
    def test_blender_really_hides_the_rivets(self):
        """the real scene, one tiny render: the prefix matches rivets, and they are put back afterwards"""
        out = tempfile.mkdtemp(prefix='bust-probe-')
        try:
            r = subprocess.run([blender(), '-b', '--factory-startup', '-P', os.path.join(M3D, 'talos_build.py'), '--', '--render', 'clips', '--out', out,
                                '--super', '1', '--cell', '64', '--clip', 'd_bust'],
                               env=dict(os.environ, TALOS_DESKTOP='1'), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            self.assertEqual(r.returncode, 0, r.stdout[-800:])
            ATLAS.check_hidden(r.stdout, ['d_bust'])
            import re
            self.assertIn('restored', r.stdout)
            n = int(re.search(r'hid (\d+) objects', r.stdout).group(1))
            self.assertGreaterEqual(n, 20)
        finally:
            shutil.rmtree(out, ignore_errors=True)


class CrestGuard(unittest.TestCase):
    """the mini tondo must never cut the crest. The old checks (ring, corners, glow) pass clipped art, so build_mini measures the crest in
    the ID pass and refuses to build when it reaches the inner ring. Old framing: BUST_CENTER_Z 3.30, BUST_RADIUS_BU 1.86 (cut the crest 7 px)."""
    SIZE, K = 88, 3                      # 2x cell, supersampling
    R_IN = SIZE / 2 - 1.0 - 3            # 40 px: where the inner ring starts

    def fake_pass(self, crest_px):
        """a render dir whose ID pass holds a head (id 1) and one crest pixel at `crest_px` (final px, from the cell centre)"""
        import finish
        d = tempfile.mkdtemp(prefix='crest-fake-')
        self.addCleanup(shutil.rmtree, d, True)
        json.dump({'px_per_bu': 70.0, 'parts': {'1': {'name': 'head', 'lw': 0.04}, '7': {'name': 'crest', 'lw': 0.04},
                                                 '8': {'name': 'crest_holder', 'lw': 0.04}}}, open(os.path.join(d, 'ids.json'), 'w'))
        os.makedirs(os.path.join(d, 'raw', 'd_bust', 'id'))
        a = np.zeros((self.SIZE * self.K, self.SIZE * self.K, 4), np.uint8)
        c = self.SIZE * self.K // 2
        a[c, c] = [finish._CODES[1], finish._CODES[0], 0, 255]                              # the head, dead centre
        x = int(round(c + crest_px * self.K))
        a[c, x] = [finish._CODES[7], finish._CODES[0], 0, 255]                              # the crest, crest_px right of the centre
        Image.fromarray(a, 'RGBA').save(os.path.join(d, 'raw', 'd_bust', 'id', '0001.png'))
        return d

    def reach(self, crest_px):
        return ATLAS.crest_reach(self.fake_pass(crest_px), 'd_bust', 0, 0, self.SIZE, self.K, 23.7)[0]

    def test_reach_is_the_distance_of_the_farthest_crest_pixel_plus_its_line(self):
        r = self.reach(30)
        self.assertAlmostEqual(r, 30 + 0.04 * ATLAS.BUST_LINE_K * 23.7 / 2, delta=0.3)
        self.assertLess(self.reach(30), self.R_IN)
        self.assertGreater(self.reach(41), self.R_IN)           # a crest that reaches the ring is over the limit

    def test_the_head_is_not_the_crest(self):
        self.assertLess(self.reach(2), 6)                        # the head pixel at the centre does not count

    def test_a_pass_without_the_crest_parts_is_an_error(self):
        d = self.fake_pass(10)
        json.dump({'px_per_bu': 70.0, 'parts': {'1': {'name': 'head', 'lw': 0.04}}}, open(os.path.join(d, 'ids.json'), 'w'))
        with self.assertRaises(SystemExit):
            ATLAS.crest_reach(d, 'd_bust', 0, 0, self.SIZE, self.K, 23.7)

    def test_an_id_pass_that_lost_the_crest_is_an_error(self):
        import finish
        d = self.fake_pass(10)
        p = os.path.join(d, 'raw', 'd_bust', 'id', '0001.png')
        a = np.array(Image.open(p).convert('RGBA'))
        a[..., 0] = finish._CODES[1]
        Image.fromarray(a, 'RGBA').save(p)
        with self.assertRaises(SystemExit):
            ATLAS.crest_reach(d, 'd_bust', 0, 0, self.SIZE, self.K, 23.7)

    def fake_core(self, core_px):
        """a render dir whose ID pass holds a head (id 1) and one core pixel (id 9) `core_px` right of the cell centre"""
        import finish
        d = self.fake_pass(10)
        json.dump({'px_per_bu': 70.0, 'parts': {'1': {'name': 'head', 'lw': 0.04}, '7': {'name': 'crest', 'lw': 0.04},
                                                 '8': {'name': 'crest_holder', 'lw': 0.04}, '9': {'name': 'core', 'lw': 0.04}}}, open(os.path.join(d, 'ids.json'), 'w'))
        p = os.path.join(d, 'raw', 'd_bust', 'id', '0001.png')
        a = np.array(Image.open(p).convert('RGBA'))
        c = self.SIZE * self.K // 2
        a[c, int(round(c + core_px * self.K))] = [finish._CODES[9], finish._CODES[0], 0, 255]
        Image.fromarray(a, 'RGBA').save(p)
        return d

    def test_core_reach_is_the_farthest_core_pixel_plus_its_line(self):
        r = ATLAS.core_reach(self.fake_core(30), 'd_bust', 0, 0, self.SIZE, self.K, 23.7)[0]
        self.assertAlmostEqual(r, 30 + 0.04 * ATLAS.BUST_LINE_K * 23.7 / 2, delta=0.3)
        self.assertLess(r, self.R_IN)
        self.assertGreater(ATLAS.core_reach(self.fake_core(41), 'd_bust', 0, 0, self.SIZE, self.K, 23.7)[0], self.R_IN)

    def test_a_pass_without_a_core_part_is_an_error(self):
        with self.assertRaises(SystemExit):
            ATLAS.core_reach(self.fake_pass(10), 'd_bust', 0, 0, self.SIZE, self.K, 23.7)    # fake_pass has no core part

    def test_the_framing_constants_are_not_the_old_ones(self):
        self.assertNotEqual((ATLAS.BUST_CENTER_Z, ATLAS.BUST_RADIUS_BU), (3.30, 1.86))

    @unittest.skipUnless(blender(), 'needs Blender (the real rig); the owner Mac has it, the CI image does not')
    def test_the_old_framing_cannot_build_and_the_new_one_builds_the_committed_art(self):
        """the real entry point: build_mini with the real bust renders. Old values: refused, naming the crest. A framing that leaves the crest room but cuts the core: refused, naming the core. Current values: builds, and the
        four mini sheets match the committed pixels (same_art: EEVEE output differs by a few levels between GPUs and Blender builds, so not byte
        for byte, but a moved or cut crest is far outside the tolerance)."""
        work = tempfile.mkdtemp(prefix='crest-work-')
        out = tempfile.mkdtemp(prefix='crest-out-')
        old = (ATLAS.BUST_CENTER_Z, ATLAS.BUST_RADIUS_BU)
        try:
            ATLAS.BUST_CENTER_Z, ATLAS.BUST_RADIUS_BU = 3.30, 1.86
            with self.assertRaises(SystemExit) as cm:
                ATLAS.build_mini(os.path.join(work, 'old'), out, 0)
            self.assertIn('crest clipped', str(cm.exception))
            self.assertEqual(os.listdir(out), [])                # nothing was written for the clipped framing
        finally:
            ATLAS.BUST_CENTER_Z, ATLAS.BUST_RADIUS_BU = old
        try:
            ATLAS.BUST_CENTER_Z = 3.70                           # the ring moved up the figure: the crest has room, the core's bottom is cut
            with self.assertRaises(SystemExit) as cm:
                ATLAS.build_mini(os.path.join(work, 'high'), out, 0)
            self.assertIn('core clipped', str(cm.exception))
            self.assertEqual(os.listdir(out), [])
        finally:
            ATLAS.BUST_CENTER_Z, ATLAS.BUST_RADIUS_BU = old
        try:
            ATLAS.build_mini(os.path.join(work, 'new'), out, 0)
            for name in ('mini-1x', 'mini-2x', 'mini-ember-1x', 'mini-ember-2x'):
                a = np.array(Image.open(os.path.join(out, name + '.png')).convert('RGBA'))
                b = np.array(Image.open(os.path.join(COMMITTED, name + '.png')).convert('RGBA'))
                self.assertTrue(same_art(a, b), name + ' differs from the committed sheet')
        finally:
            shutil.rmtree(work, ignore_errors=True)
            shutil.rmtree(out, ignore_errors=True)


class SameArt(unittest.TestCase):
    """the comparison the Blender-backed test makes against the committed sheets"""

    def base(self):
        a = np.zeros((88, 352, 4), np.uint8)
        a[10:60, 20:200] = [200, 120, 40, 255]
        return a

    def test_identical_art_is_the_same(self):
        self.assertTrue(same_art(self.base(), self.base()))

    def test_a_few_pixels_a_few_levels_off_is_render_noise(self):
        b = self.base()
        b[30, 40:77, 0] += 10                                    # 37 px, 10 levels: what a different GPU did to talos-1x
        self.assertTrue(same_art(self.base(), b))

    def test_a_moved_crest_is_not(self):
        b = np.roll(self.base(), 3, axis=1)
        self.assertFalse(same_art(self.base(), b))

    def test_a_pixel_far_off_is_not(self):
        b = self.base()
        b[30, 40, 0] += 60
        self.assertFalse(same_art(self.base(), b))

    def test_a_different_size_is_not(self):
        self.assertFalse(same_art(self.base(), self.base()[:, :300]))


class BuildScript(unittest.TestCase):
    """build.sh against a stub Blender that only records how it was called (the script then fails at finish.py, which is not here)"""

    def calls(self, clips):
        tmp = tempfile.mkdtemp(prefix='build-sh-')
        try:
            three = os.path.join(tmp, 'mascot', '3d')
            os.makedirs(three)
            shutil.copy(os.path.join(M3D, 'build.sh'), three)
            log = os.path.join(tmp, 'calls.log')
            stub = os.path.join(tmp, 'blender')
            with open(stub, 'w') as fh:
                fh.write('#!/bin/bash\necho "DESKTOP=${TALOS_DESKTOP:-} $*" >> "%s"\n' % log)
            os.chmod(stub, 0o755)
            env = {k: v for k, v in os.environ.items() if k not in ('CLIPS', 'TALOS_DESKTOP')}
            env.update(BLENDER=stub, RENDER_DIR=os.path.join(tmp, 'r'))
            if clips:
                env['CLIPS'] = clips
            subprocess.run(['bash', os.path.join(three, 'build.sh')], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            return open(log).read().splitlines()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_a_partial_build_never_rewrites_the_blend(self):
        c = self.calls('idle')
        self.assertEqual(len(c), 1, c)
        self.assertFalse(any('--save' in x for x in c), c)

    def test_a_full_build_saves_the_blend_once_with_the_desktop_actions(self):
        c = self.calls('')
        saves = [x for x in c if '--save' in x]
        self.assertEqual(len(saves), 1, c)
        self.assertTrue(saves[0].startswith('DESKTOP=1 '), saves)


class RealSizeProof(unittest.TestCase):
    def test_sheets_are_real_size_tagged_and_show_ember_and_mini(self):
        out = tempfile.mkdtemp(prefix='proof-')
        try:
            photo = os.path.join(out, 'bg.png')
            Image.fromarray((np.indices((300, 400)).sum(0) % 255).astype(np.uint8)).convert('RGB').save(photo)
            PROOF.cmd_real(COMMITTED, out, photo)
            for sc, dpi in ((2, 144), (1, 72)):
                for bg in ('white', 'black', 'photo'):
                    im = Image.open(os.path.join(out, 'real-%dx-%s.png' % (sc, bg)))
                    self.assertAlmostEqual(im.info['dpi'][0], dpi, delta=1)
                    self.assertLess(im.width, 1500, 'wider than the panel it is meant to be judged on')
            # ember really is composited: with the layer removed the idle tile has fewer bright-yellow pixels
            m = json.load(open(os.path.join(COMMITTED, 'companion.json')))
            at = {k: Image.open(os.path.join(COMMITTED, v['files']['2x'])).convert('RGBA') for k, v in m['atlases'].items()}
            body = PROOF.cellimg(m, at, 'idle', 0)
            em = at['ember'].crop((0, 0, 192, 208))
            self.assertNotEqual(PROOF._with_ember(body, em, 0.6).tobytes(), body.tobytes())
        finally:
            shutil.rmtree(out, ignore_errors=True)


class WebClipsUntouched(unittest.TestCase):
    def load(self, env):
        if env:
            os.environ['TALOS_DESKTOP'] = '1'
        else:
            os.environ.pop('TALOS_DESKTOP', None)
        spec = importlib.util.spec_from_file_location('tc_%s' % env, os.path.join(M3D, 'talos_clips.py'))
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        return m

    def test_plain_build_has_exactly_the_web_clips_with_the_same_poses(self):
        saved = os.environ.get('TALOS_DESKTOP')
        try:
            m = self.load(False)
            self.assertEqual(list(m.CLIPS), WEB_CLIPS)
            h = hashlib.sha256()
            for k, (n, loop, fn, extra) in m.CLIPS.items():
                h.update(repr((k, n, loop, extra)).encode())
                for i in range(n):
                    h.update(repr(fn(i, n)).encode())
            for k, fn in m.STILLS.items():
                h.update(repr(fn(0)).encode())
            self.assertEqual(h.hexdigest(), WEB_POSES_SHA)
            d = self.load(True)
            self.assertEqual(list(d.CLIPS)[:8], WEB_CLIPS)
            self.assertTrue(all(c.startswith('d_') for c in list(d.CLIPS)[8:]))
        finally:
            if saved is None:
                os.environ.pop('TALOS_DESKTOP', None)
            else:
                os.environ['TALOS_DESKTOP'] = saved


if __name__ == '__main__':
    unittest.main()
