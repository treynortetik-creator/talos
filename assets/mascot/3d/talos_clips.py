"""Little Talos clip library: one pose function per clip, pure Python (no bpy), imported by talos_build.py.

A pose is a dict of bone -> channels, in MODEL axes (x = his left / screen right, y = away from the camera, z = up;
the model faces -y, the armature object then turns -12 deg so he faces a little to screen left, like the icon):
  FK bones  {'rot': (rx, ry, rz) degrees, 'loc': (x, y, z) BU offset, 'scale': (sx, sy, sz)}
            rotations compose down the chain (a child's rotation is applied in its parent's rotated frame).
            +ry turns a part clockwise as seen from the camera.
  arm_R / arm_L  2-bone IK in the TORSO rest frame: {'wrist': (x,y,z), 'pole': (x,y,z), 'hand': dir, 'spin': deg}
  leg_R / leg_L  2-bone IK in the ROOT frame: {'ankle': (x,y,z), 'pole': dir, 'yaw': deg, 'pitch': deg}
  props     {'eye_glow': 1.0, 'core_glow': 1.0}  (drive the emissive materials; 1 = the icon's colours)
Toggle bones (face_n normal smile, face_h beaming eyes + blush + grin, face_w worried brows + mouth, eyes, sweat, hammer)
show at scale 1 and hide at scale ~0.

Every clip is (n_frames, loop, fn(i) -> pose). Loops are periodic in n (frame n == frame 0, never rendered twice).
"""
import math
import os

TAU = math.tau


def lerp(a, b, t):
    if isinstance(a, (tuple, list)):
        return tuple(lerp(x, y, t) for x, y in zip(a, b))
    return a + (b - a) * t


def smooth(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def ease_out_back(t, s=1.6):
    t = max(0.0, min(1.0, t)) - 1
    return t * t * ((s + 1) * t + s) + 1


def seg(i, a, b):
    """0..1 progress of frame i through [a, b], smoothstepped"""
    return smooth((i - a) / max(1e-6, (b - a)))


def bump(i, a, b):
    """0 -> 1 -> 0 sine bump over [a, b]"""
    if i <= a or i >= b:
        return 0.0
    return math.sin(math.pi * (i - a) / (b - a))


HIDE = (1e-4, 1e-4, 1e-4)
SHOW = (1.0, 1.0, 1.0)

# ---------------------------------------------------------------- the icon pose ("Pleased")
ARM_R_REF = {'wrist': (-1.58, -0.30, 2.86), 'pole': (-0.3, 0.3, -1.0), 'hand': (-0.25, -0.10, 0.95), 'spin': 0.0}
ARM_L_REF = {'wrist': (1.62, -0.22, 1.52), 'pole': (1.0, 0.1, 0.35), 'hand': (0.05, -0.12, -1.0), 'spin': 0.0}
ARM_L_DOWN = ARM_L_REF
ARM_R_DOWN = {'wrist': (-1.36, -0.22, 1.28), 'pole': (-1.0, 0.1, 0.25), 'hand': (-0.08, -0.12, -1.0), 'spin': 0.0}
LEG_R_REF = {'ankle': (-0.70, 0.0, 0.52), 'pole': (0, -1, 0), 'yaw': -44.0, 'pitch': 0.0}
LEG_L_REF = {'ankle': (0.76, 0.05, 0.52), 'pole': (0, -1, 0), 'yaw': 46.0, 'pitch': 0.0}
HEAD_REF = (0.0, 7.0, 0.0)          # the icon's head tilt: a 7 deg clockwise roll


def base():
    return {
        'root': {'loc': (0, 0, 0), 'rot': (0, 0, 0)},
        'pelvis': {'rot': (0, 0, 0)},
        'torso': {'rot': (0, 0, 0)},
        'chest': {'scale': SHOW},
        'gear': {'rot': (0, 0, 0)},
        'neck': {'rot': (0, 0, 0)},
        'head': {'rot': HEAD_REF},
        'crest': {'rot': (0, 0, 0)},
        'eye_R': {'scale': SHOW, 'loc': (0, 0, 0)},
        'eye_L': {'scale': SHOW, 'loc': (0, 0, 0)},
        'face_n': {'scale': SHOW},
        'face_h': {'scale': HIDE},
        'face_w': {'scale': HIDE},
        'sweat': {'scale': HIDE, 'loc': (0, 0, 0)},
        'hammer': {'scale': HIDE},
        'arm_R': dict(ARM_R_REF),
        'arm_L': dict(ARM_L_REF),
        'leg_R': dict(LEG_R_REF),
        'leg_L': dict(LEG_L_REF),
        'props': {'eye_glow': 1.0, 'core_glow': 1.0},
    }


def add(v, d):
    return tuple(a + b for a, b in zip(v, d))


def blink_amount(i, at, dur=6):
    """eyelid closure 0..1, a quick close and a slower open"""
    t = i - at
    if t < 0 or t > dur:
        return 0.0
    c = dur * 0.4
    return smooth(t / c) if t < c else 1 - smooth((t - c) / (dur - c))


WORRY_EYE = 0.78     # critic r3 #4: the icon's worried lenses are ~25% smaller


def eyes_blink(p, b, k=1.0):
    s = (k, k, k * max(0.06, 1 - 0.94 * b))
    p['eye_R']['scale'] = s; p['eye_L']['scale'] = s


def breathe(p, ph, amp=1.0):
    """chest swell + body bob for phase ph in turns"""
    s = math.sin(TAU * ph)
    p['chest']['scale'] = (1 + 0.012 * s * amp, 1 + 0.012 * s * amp, 1 + 0.022 * s * amp)
    p['root']['loc'] = (0, 0, 0.022 * amp * (0.5 + 0.5 * s))
    p['head']['rot'] = add(p['head']['rot'], (-1.2 * s * amp, 0, 0))
    p['crest']['rot'] = (1.5 * math.sin(TAU * ph - 0.9) * amp, 0, 0)


# ---------------------------------------------------------------- clips
def c_ref(i):
    return base()


def c_ref_beaming(i):
    p = base()
    p['face_n']['scale'] = HIDE; p['face_h']['scale'] = SHOW
    p['eye_R']['scale'] = HIDE; p['eye_L']['scale'] = HIDE
    return p


def worried_arm(scr=0.0):
    """his right clamp on the helmet side, scratching (scr in -1..1 moves it along the helmet)"""
    return {'wrist': (-1.22 + 0.05 * scr, -0.10, 3.46 + 0.06 * scr), 'pole': (-1.0, 0.1, -0.3),
            'hand': (0.75 + 0.12 * scr, 0.05, 0.65), 'spin': 10.0 + 8 * scr}


def c_ref_worried(i):
    p = base()
    p['face_n']['scale'] = HIDE; p['face_w']['scale'] = SHOW; p['sweat']['scale'] = SHOW
    p['arm_R'] = worried_arm()
    p['head']['rot'] = (2.0, 7.0, 0.0)
    eyes_blink(p, 0.0, WORRY_EYE)
    return p


def c_idle(i, n=72):
    """gentle breathe and bob, one blink, core glow pulse"""
    p = base()
    ph = i / n
    breathe(p, ph)
    sw = math.sin(TAU * ph)
    p['arm_R'] = dict(ARM_R_REF, wrist=add(ARM_R_REF['wrist'], (0.02 * sw, 0, 0.035 * math.sin(TAU * ph - 0.6))),
                      spin=4 * math.sin(TAU * ph - 0.3))
    p['arm_L'] = dict(ARM_L_REF, wrist=add(ARM_L_REF['wrist'], (0, 0, 0.02 * math.sin(TAU * ph - 0.5))))
    eyes_blink(p, blink_amount(i, 40, 7))
    p['props']['core_glow'] = 1.0 + 0.22 * math.sin(TAU * 2 * ph)
    p['props']['eye_glow'] = 1.0 + 0.05 * math.sin(TAU * ph)
    return p


def c_working(i, n=48):
    """focused: hammer taps (3 per loop), the gear spins fast, eye glow flickers"""
    p = base()
    ph = i / n
    breathe(p, ph * 2, 0.5)
    p['hammer']['scale'] = SHOW
    # tap cycle: 16 frames: lift 0-9, strike 9-12, rebound/hold 12-16
    k = i % 16
    if k < 9:
        lift = smooth(k / 9)
    elif k < 12:
        lift = 1 - ((k - 9) / 3) ** 2
    else:
        lift = -0.08 * bump(k, 12, 16)
    hit = 1.0 if k == 12 else (0.5 if k == 13 else 0.0)
    # his right arm swings in the screen plane: hammer raised up-and-out (lift 1) -> struck down-and-out (lift 0)
    up_w, dn_w = (-1.52, -0.20, 2.62), (-1.62, -0.25, 2.12)
    up_h, dn_h = (-0.45, -0.05, 0.90), (-0.95, -0.10, -0.25)
    p['arm_R'] = {'wrist': lerp(dn_w, up_w, lift), 'pole': (-0.3, 0.3, -1.0), 'hand': lerp(dn_h, up_h, lift), 'spin': 0.0}
    p['torso']['rot'] = (3.0, -2.0 + 2.0 * lift, -5.0)
    p['head']['rot'] = (7.0 - 2.5 * hit, 4.0, -9.0)
    p['eye_R']['loc'] = (-0.01, 0, -0.02); p['eye_L']['loc'] = (-0.01, 0, -0.02)
    p['gear']['rot'] = (0, -360.0 * 3 * ph, 0)
    fl = 0.12 * math.sin(TAU * 7 * ph) + 0.08 * math.sin(TAU * 11 * ph + 1.3)
    p['props']['eye_glow'] = 1.12 + fl + 0.25 * hit
    p['props']['core_glow'] = 1.25 + 0.15 * math.sin(TAU * 6 * ph) + 0.3 * hit
    return p


def talk_amp(i, n=48):
    """synthetic speech amplitude 0..1, periodic in n: syllables ~5 per second under a phrase envelope"""
    t = i / n
    syl = 0.5 + 0.5 * math.sin(TAU * 10 * t - 0.4)
    syl2 = 0.5 + 0.5 * math.sin(TAU * 6 * t + 1.1)
    env = 0.55 + 0.45 * math.sin(TAU * 2 * t + 0.3)
    a = (0.65 * syl + 0.35 * syl2) * env
    return max(0.0, min(1.0, a * 1.15))


def c_talking(i, n=48):
    """voice mode: eye glow and a slight head bob ride the amplitude curve (talk_amp, also in the clip json)"""
    p = base()
    ph = i / n
    breathe(p, ph, 0.6)
    a = talk_amp(i, n)
    a_lag = talk_amp((i - 2) % n, n)
    p['head']['rot'] = add(p['head']['rot'], (-3.5 * a_lag, 1.5 * math.sin(TAU * ph), 2.0 * math.sin(TAU * 2 * ph)))
    p['root']['loc'] = add(p['root']['loc'], (0, 0, 0.018 * a_lag))
    p['face_n']['scale'] = (1.0 + 0.10 * a, 1.0, 1.0 + 0.9 * a)
    p['props']['eye_glow'] = 0.85 + 0.55 * a
    p['props']['core_glow'] = 1.0 + 0.2 * a
    sw = math.sin(TAU * ph)
    p['arm_R'] = dict(ARM_R_REF, wrist=add(ARM_R_REF['wrist'], (0.04 * sw, 0, 0.05 * math.sin(TAU * 2 * ph))), spin=8 * sw)
    p['arm_L'] = dict(ARM_L_REF, wrist=add(ARM_L_REF['wrist'], (0.03 * sw, -0.03, 0.03 * math.cos(TAU * ph))))
    return p


def c_thinking(i, n=72):
    """head tilt with his right clamp to the chin, eyes up, slow pondering sway"""
    p = base()
    ph = i / n
    breathe(p, ph, 0.7)
    sw = math.sin(TAU * ph)
    p['head']['rot'] = (-6.0 + 1.5 * sw, 14.0 + 3.0 * math.sin(TAU * ph - 0.4), -10.0 + 2 * sw)
    p['torso']['rot'] = (0, 2.0, 0)
    tap = 0.03 * max(0.0, math.sin(TAU * 3 * ph)) ** 4
    # his right clamp cradles the side of his jaw from below; the other arm folds under it
    p['arm_R'] = {'wrist': (-1.18, -0.45, 2.30 + tap), 'pole': (-1.0, 0.2, -0.9), 'hand': (0.55, -0.35, 0.75), 'spin': 0.0}
    p['arm_L'] = dict(ARM_L_REF, wrist=(1.30, -0.30, 1.40))
    p['eye_R']['loc'] = (0.03, 0, 0.055); p['eye_L']['loc'] = (0.03, 0, 0.055)
    eyes_blink(p, blink_amount(i, 50, 7))
    p['props']['core_glow'] = 0.9 + 0.1 * math.sin(TAU * ph)
    p['gear']['rot'] = (0, -90.0 * ph, 0)
    return p


def c_beaming(i, n=36):
    """success: squash, hop, land, settle; ^^ eyes and blush throughout"""
    p = base()
    p['face_n']['scale'] = HIDE; p['face_h']['scale'] = SHOW
    p['eye_R']['scale'] = HIDE; p['eye_L']['scale'] = HIDE
    # 0-6 squash, 6-18 air, 18-24 land squash, 24-36 settle
    sq = bump(i, 0, 8) * 1.0 + bump(i, 17, 26) * 0.8
    air = math.sin(math.pi * (i - 6) / 12) if 6 <= i <= 18 else 0.0
    p['root']['loc'] = (0, 0, 0.55 * air - 0.10 * sq)
    p['chest']['scale'] = (1 + 0.05 * sq - 0.02 * air, 1 + 0.05 * sq, 1 - 0.07 * sq + 0.04 * air)
    up = smooth((i - 4) / 6) * (1 - smooth((i - 22) / 12))
    p['arm_R'] = {'wrist': lerp(ARM_R_REF['wrist'], (-1.45, -0.25, 3.45), up), 'pole': (-0.4, 0.3, -1.0),
                  'hand': lerp(ARM_R_REF['hand'], (-0.2, -0.1, 1.0), up), 'spin': 0.0 + 15 * up}
    p['arm_L'] = {'wrist': lerp(ARM_L_REF['wrist'], (1.45, -0.25, 3.25), up), 'pole': lerp((1.0, 0.1, 0.25), (0.4, 0.3, -1.0), up),
                  'hand': lerp(ARM_L_REF['hand'], (0.25, -0.1, 1.0), up), 'spin': -20 * up}
    tuck = air
    p['leg_R'] = dict(LEG_R_REF, ankle=add(LEG_R_REF['ankle'], (0, -0.05 * tuck, 0.16 * tuck + 0.10 * sq)), pitch=-12 * tuck)
    p['leg_L'] = dict(LEG_L_REF, ankle=add(LEG_L_REF['ankle'], (0, -0.05 * tuck, 0.16 * tuck + 0.10 * sq)), pitch=-12 * tuck)
    p['head']['rot'] = add(HEAD_REF, (-6 * air + 5 * sq, 0, 0))
    p['crest']['rot'] = (-8 * air + 10 * sq, 0, 0)
    p['props']['core_glow'] = 1.0 + 0.35 * smooth(i / 10) * (1 - smooth((i - 24) / 12)) + 0.1
    p['props']['eye_glow'] = 1.2
    return p


def c_worried(i, n=48):
    """error: eyes go anxious, his right clamp rises to scratch the helmet, a sweat drop appears; hold the last frame"""
    p = base()
    t_face = smooth(i / 5)
    if i >= 3:
        p['face_n']['scale'] = HIDE; p['face_w']['scale'] = SHOW
    rise = smooth((i - 2) / 14)
    scr = math.sin(TAU * (i - 16) / 8) if 16 <= i <= 40 else 0.0
    scr *= 1 - smooth((i - 34) / 6)
    target = worried_arm(scr)
    p['arm_R'] = {'wrist': lerp(ARM_R_REF['wrist'], target['wrist'], rise), 'pole': lerp(ARM_R_REF['pole'], target['pole'], rise),
                  'hand': lerp(ARM_R_REF['hand'], target['hand'], rise), 'spin': lerp(ARM_R_REF['spin'], target['spin'], rise)}
    p['head']['rot'] = lerp(HEAD_REF, (2.0, 7.0, 0.0), rise)
    p['head']['rot'] = add(p['head']['rot'], (0, 1.5 * scr, 0))
    p['torso']['rot'] = (0, -2.0 * rise, 0)
    p['root']['loc'] = (0, 0, -0.03 * rise)
    ds = smooth((i - 12) / 6)
    p['sweat']['scale'] = (max(1e-4, ds),) * 3
    p['sweat']['loc'] = (0, 0, -0.12 * smooth((i - 18) / 30))
    eyes_blink(p, blink_amount(i, 1, 5), 1.0 - (1.0 - WORRY_EYE) * t_face)
    p['props']['eye_glow'] = 1.0 - 0.15 * t_face
    p['props']['core_glow'] = 1.0 - 0.25 * t_face
    return p


def c_wave(i, n=48):
    """hello: his right arm rises high and waves twice, then settles back to the icon pose"""
    p = base()
    ph = i / n
    breathe(p, ph, 0.6)
    up = smooth(i / 8) * (1 - smooth((i - 38) / 10))
    w = math.sin(TAU * (i - 8) / 14) if 8 <= i <= 40 else 0.0
    w *= smooth((i - 6) / 4) * (1 - smooth((i - 34) / 6))
    high = {'wrist': (-1.45 + 0.20 * w, -0.35, 3.62 - 0.05 * abs(w)), 'pole': (-0.5, 0.3, -1.0), 'hand': (-0.1 + 0.55 * w, -0.15, 1.0), 'spin': 0.0}
    p['arm_R'] = {k: lerp(ARM_R_REF[k], high[k], up) for k in ('wrist', 'pole', 'hand', 'spin')}
    p['head']['rot'] = add(p['head']['rot'], (0, 3 * up + 2 * w * up, 4 * up))
    p['torso']['rot'] = (0, 2.5 * up, 3 * up)
    p['props']['eye_glow'] = 1.0 + 0.15 * up
    if 10 <= i <= 36:
        p['face_n']['scale'] = (1.25, 1.0, 1.25)
    return p


def c_rounds(i, n=32):
    """his patrol (the myth: Talos walked the coast of Crete three times a day): a walk in place, one stride per loop"""
    p = base()
    ph = i / n
    s = math.sin(TAU * ph); c = math.cos(TAU * ph)
    p['root']['loc'] = (0.03 * s, 0, 0.05 * abs(math.sin(TAU * ph + 0.35)))
    p['root']['rot'] = (0, 0, 0)
    p['pelvis']['rot'] = (0, 3.0 * s, 0)
    p['torso']['rot'] = (3.0, -2.0 * s, 4.0 * s)
    p['head']['rot'] = (1.5 * math.sin(TAU * 2 * ph + 0.6), 2.0 * s + 3.0, -2.0 * s)
    p['crest']['rot'] = (3.0 * math.sin(TAU * 2 * ph - 0.6), 0, 0)
    # feet: each lifts for half the cycle
    def foot(ref, phase, side):
        lift = max(0.0, math.sin(TAU * (ph + phase)))
        fwd = math.cos(TAU * (ph + phase))
        return dict(ref, ankle=add(ref['ankle'], (0, -0.14 * fwd, 0.22 * lift)), pitch=-14 * lift * (1 if fwd > 0 else 0.5),
                    yaw=ref['yaw'] * 0.6)
    p['leg_R'] = foot(LEG_R_REF, 0.0, -1)
    p['leg_L'] = foot(LEG_L_REF, 0.5, 1)
    # arms swing opposite the legs
    p['arm_R'] = dict(ARM_R_DOWN, wrist=add(ARM_R_DOWN['wrist'], (0.05, 0.30 * c, 0.10 + 0.06 * abs(c))), hand=(-0.08, 0.35 * c, -1.0))
    p['arm_L'] = dict(ARM_L_DOWN, wrist=add(ARM_L_DOWN['wrist'], (-0.05, -0.30 * c, 0.10 + 0.06 * abs(c))), hand=(0.08, -0.35 * c, -1.0))
    p['gear']['rot'] = (0, -360.0 * ph, 0)
    p['props']['core_glow'] = 1.05 + 0.1 * math.sin(TAU * 2 * ph)
    return p


# ================================================================ desktop companion clips (C-ART)
# Added for the desktop companion atlases (DESKTOP-COMPANION-SPEC 9). Nothing above this line is changed: the 8 clips and 3 stills
# above keep their exact poses. Each `d_*` clip below is rendered only at the frames the atlas needs: the `pick` tables
# sample the existing 24 fps clips (a hold table), the new poses are authored at the atlas frame count.
def blend(a, b, t):
    """pose a -> pose b by t (0..1), channel by channel"""
    if isinstance(a, dict):
        return {k: blend(a[k], b[k], t) if k in b else a[k] for k in a}
    if isinstance(a, (tuple, list)):
        return tuple(blend(x, y, t) for x, y in zip(a, b))
    return a + (b - a) * t


def c_blink(i, n=3):
    """idle blink with a still body: open, half, closed (the idle row; breathing is the ember layer's job)"""
    p = base()
    eyes_blink(p, (0.0, 0.55, 1.0)[min(i, 2)])
    return p


def c_walk(i, n=8, yaw=0.0):
    """one stride of the patrol in n frames, with the whole figure turned `yaw` degrees about the vertical (never mirrored)"""
    p = c_rounds(i * (32 // n), 32)
    p['root']['rot'] = (0, 0, yaw)
    p['head']['rot'] = add(p['head']['rot'], (0, 0, -0.25 * yaw))      # the head looks a little more toward the way he is going
    p['crest']['rot'] = add(p['crest']['rot'], (0, 0, -CREST_KEEP * yaw))   # the crest is one flat slab drawn toward the camera: keep it turned to us
    return p


WALK_RIGHT_YAW = 64.0
WALK_LEFT_YAW = -50.0
CREST_KEEP = 0.6


def c_walk_right(i, n=8):
    return c_walk(i, n, WALK_RIGHT_YAW)


def c_walk_left(i, n=8):
    return c_walk(i, n, WALK_LEFT_YAW)


def hammer_down(p):
    """his right clamp carries the hammer low at his side"""
    p['hammer']['scale'] = SHOW
    p['arm_R'] = dict(ARM_R_DOWN)
    return p


def c_waiting(i, n=3):
    """your turn: hammer down, face turned up to you, his other clamp held out open. 0 looks up, 1 leans in a touch, 2 blinks"""
    p = hammer_down(base())
    lean = (0.0, 1.0, 0.0)[min(i, 2)]
    p['head']['rot'] = (-9.0 - 2.0 * lean, 5.0, 3.0 + 1.5 * lean)
    p['torso']['rot'] = (-1.5, 0, 0)
    p['eye_R']['loc'] = (0.035, 0, 0.06); p['eye_L']['loc'] = (0.035, 0, 0.06)
    p['arm_L'] = {'wrist': (1.78, -0.42, 2.12 + 0.05 * lean), 'pole': (1.0, 0.1, -0.2), 'hand': (0.55, -0.35, 0.55), 'spin': 0.0}
    if i == 2:
        eyes_blink(p, 1.0)
        p['eye_R']['loc'] = (0.035, 0, 0.06); p['eye_L']['loc'] = (0.035, 0, 0.06)
    p['props']['core_glow'] = 1.1
    return p


# the hammer row: lift, strike, rebound, settle. Slow and level: no snap, no head jerk, no gear spin, no eye flicker
HAMMER_LIFT = (0.12, 0.40, 0.78, 1.0, 0.42, 0.0, -0.07, 0.0)


def c_hammer(i, n=8):
    p = base()
    lift = HAMMER_LIFT[i % len(HAMMER_LIFT)]
    hit = 1.0 if i == 5 else 0.0
    p['hammer']['scale'] = SHOW
    # the same swing as `working`, reeled in so the hammer stays inside the cell (the strike points down-and-out, not straight out)
    up_w, dn_w = (-1.32, -0.20, 2.66), (-1.34, -0.25, 2.04)
    up_h, dn_h = (-0.40, -0.05, 0.92), (-0.55, -0.10, -0.83)
    p['arm_R'] = {'wrist': lerp(dn_w, up_w, lift), 'pole': (-0.3, 0.3, -1.0), 'hand': lerp(dn_h, up_h, lift), 'spin': 0.0}
    p['torso']['rot'] = (3.0, -2.0 + 1.0 * lift, -5.0)
    p['head']['rot'] = (7.0, 4.0, -9.0)
    p['eye_R']['loc'] = (-0.01, 0, -0.02); p['eye_L']['loc'] = (-0.01, 0, -0.02)
    p['props']['eye_glow'] = 1.12
    p['props']['core_glow'] = 1.25 + 0.2 * hit
    return p


def c_statue(i=0, n=1):
    """on guard, asleep: stood straight, head level, eyes lidded and dim, core low"""
    p = hammer_down(base())
    p['head']['rot'] = (3.0, 0.0, 0.0)
    p['arm_L'] = dict(ARM_L_DOWN)
    p['arm_R'] = dict(ARM_R_DOWN, wrist=add(ARM_R_DOWN['wrist'], (-0.24, 0.0, 0.0)))   # the hammer head stands clear of the toe, not fused to the boot
    eyes_blink(p, 0.78)
    p['props']['eye_glow'] = 0.22
    p['props']['core_glow'] = 0.3
    return p


def c_landed(i, n=3):
    """a drop: deep squash, a small stretch back, settled"""
    p = base()
    sq = (2.2, -0.45, 0.0)[min(i, 2)]
    p['root']['loc'] = (0, 0, -0.15 * sq)
    p['chest']['scale'] = (1 + 0.05 * sq, 1 + 0.05 * sq, 1 - 0.07 * sq)
    p['leg_R'] = dict(LEG_R_REF, ankle=add(LEG_R_REF['ankle'], (0, 0, 0.10 * max(sq, 0))))
    p['leg_L'] = dict(LEG_L_REF, ankle=add(LEG_L_REF['ankle'], (0, 0, 0.10 * max(sq, 0))))
    p['head']['rot'] = add(HEAD_REF, ((5 if i else 2) * sq, 0, 0))   # frame 0 is the blink: a deep pitch skews the lids of the two discs apart, so it nods less there
    p['crest']['rot'] = (10 * sq, 0, 0)
    out = 0.35 * max(sq, 0)
    p['arm_R'] = dict(ARM_R_REF, wrist=add(ARM_R_REF['wrist'], (-0.30 * out, 0, -0.30 * out)))
    p['arm_L'] = dict(ARM_L_REF, wrist=add(ARM_L_REF['wrist'], (0.30 * out, 0, 0.05 * out)))
    eyes_blink(p, 0.5 if i == 0 else 0.0)
    return p


REVIEW_K = (0.45, 0.85, 1.0, 1.0, 0.85, 0.45)


def c_review(i, n=6):
    """Fidget: from the still idle stance into the thinking pose (clamp to the jaw) and back"""
    p = blend(base(), c_thinking(20, 72), REVIEW_K[min(i, 5)])
    p['arm_L'] = dict(p['arm_L'], wrist=add(p['arm_L']['wrist'], (0.14, 0.0, 0.0)))   # the hanging clamp stays clear of the shin and ankle disc
    return p


# ---------------------------------------------------------------- idle antics (the `talos-life` sheet)
# Little things he does while nobody is using him: sit and swing his feet, nap, stretch and yawn, look around and scratch his
# head, a stumble he recovers from, tinkering with his hammer. Every one starts and ends on the idle stance, so a clip cuts to Idle
# cleanly. Each pose is authored for its cell (no source clip), at most 8 per row; the hold table in ATLAS_ROWS repeats cells.
# Z hides by default (talos_build.py): a pose that wants one sets `zzz_a` / `zzz_b` scale and loc (world position, in BU).
def plant(p, dz):
    """sink the body by dz and keep both feet on the ground (the ankles are in the root frame, so they ride down with it)"""
    p['root']['loc'] = add(p['root']['loc'], (0, 0, -dz))
    for k, ref in (('leg_R', LEG_R_REF), ('leg_L', LEG_L_REF)):
        p[k] = dict(p.get(k, ref), ankle=add(p.get(k, ref)['ankle'], (0, 0, dz)))
    return p


def look(p, yaw=0.0, pitch=0.0, roll=0.0, eyes=(0.0, 0.0)):
    p['head']['rot'] = add(HEAD_REF, (pitch, roll, yaw))
    p['eye_R']['loc'] = (eyes[0], 0, eyes[1]); p['eye_L']['loc'] = (eyes[0], 0, eyes[1])
    return p


SIT_DZ = 0.86
# his hands when he sits: out to the sides and behind the feet, flat on the ground (torso frame, so they ride down with the body)
SIT_ARM_R = {'wrist': (-2.35, 0.35, 1.05), 'pole': (-1.0, 0.3, 0.2), 'hand': (-0.3, 0.1, -1.0), 'spin': 0.0}
SIT_ARM_L = {'wrist': (2.39, 0.35, 1.05), 'pole': (1.0, 0.3, 0.2), 'hand': (0.3, 0.1, -1.0), 'spin': 0.0}


def arms_to(p, tR, tL, t):
    """both arms from the idle stance toward the targets by t (0..1): a clamp never jumps from head height to the ground in one cell"""
    p['arm_R'] = {k: lerp(ARM_R_REF[k], tR[k], t) for k in ('wrist', 'pole', 'hand', 'spin')}
    p['arm_L'] = {k: lerp(ARM_L_REF[k], tL[k], t) for k in ('wrist', 'pole', 'hand', 'spin')}
    return p


def c_sit(i, n=7):
    """sits down on the ground with his legs out to the sides, then swings his feet: 0 the idle stance, 1 crouch,
    2 seated, 3 swing (right foot), 4 swing (left foot), 5 glance aside, 6 rising"""
    p = base()
    if i == 0:
        return p
    dz = (0.0, 0.40, SIT_DZ, SIT_DZ, SIT_DZ, SIT_DZ, 0.40)[i]
    p['root']['loc'] = (0, 0, -dz)
    spread = (0.0, 0.3, 1.0, 1.0, 1.0, 1.0, 0.3)[i]
    sw = {3: (1.0, -1.0), 4: (-1.0, 1.0)}.get(i, (0.0, 0.0))     # (right foot, left foot) swing
    for k, ref, sx, s_ in (('leg_R', LEG_R_REF, -1, sw[0]), ('leg_L', LEG_L_REF, 1, sw[1])):
        a = ref['ankle']
        p[k] = dict(ref, ankle=(a[0] + sx * 0.75 * spread, -0.30 * spread - 0.10 * s_, a[2] + dz - 0.12 * spread + 0.30 * max(s_, 0.0)),
                    pole=(sx * 0.5, -1, 0.2), pitch=-(18 * spread + 26 * s_), yaw=ref['yaw'] * (1 - 0.6 * spread))
    p['torso']['rot'] = (4.0 * spread + (8 if i in (1, 6) else 0), 0, 0)
    arms_to(p, SIT_ARM_R, SIT_ARM_L, (0.0, 0.3, 1.0, 1.0, 1.0, 1.0, 0.3)[i])
    if i == 5:
        look(p, yaw=-14, pitch=3, eyes=(-0.04, 0.0))
    elif i in (3, 4):
        look(p, yaw=(4.0 if i == 3 else -4.0), pitch=-2, roll=4 + (3 if i == 3 else -3))
        p['face_n']['scale'] = (1.15, 1.0, 1.2)
    else:
        look(p)
    p['crest']['rot'] = (-3 * spread, 0, 0)
    return p


NAP_LYING = 90.0
NAP_SHIFT = 2.55      # BU: centres the lying figure in the cell (head end to screen right)
NAP_RISE = 0.80       # BU: how high the lying figure's axis sits (it lies on the arm and the head, not hovering)
NAP_LIE = (0.0, 0.0, 0.0, 0.5, 0.85, 1.0, 1.0, 1.0)


def c_nap(i, n=8):
    """lies down for a nap: 0 the idle stance, 1 crouch, 2 sits, 3 leans back, 4 almost down, 5-7 lying on his side, eyes shut and dim,
    the core glow breathing slowly, Z's floating up. Column 5 is the long Asleep rest: no animation, one still frame"""
    if i == 0:
        return base()
    if i == 1:
        p = base()
        plant(p, 0.40)
        p['torso']['rot'] = (8.0, 0, 0)
        arms_to(p, SIT_ARM_R, SIT_ARM_L, 0.3)
        look(p, pitch=6)
        return p
    p = base()
    if i == 2:
        p = c_sit(2)
        p['torso']['rot'] = (-6.0, 0, 0)
        eyes_blink(p, 0.55)
        look(p, pitch=7)
        return p
    # lying on his side, head to screen right, face to us
    lie = NAP_LIE[i]
    p['root']['rot'] = (0, NAP_LYING * lie, 0)
    p['root']['loc'] = (-NAP_SHIFT * lie, 0, NAP_RISE * lie)
    for k, ref, sx in (('leg_R', LEG_R_REF, -1), ('leg_L', LEG_L_REF, 1)):
        a = ref['ankle']
        p[k] = dict(ref, ankle=(a[0] * 0.7, a[1] - 0.45 * lie, a[2] + 0.55 * lie), pole=(0, -1, 0), pitch=0.0)
    arms_to(p, NAP_ARM_R, NAP_ARM_L, 1.0)
    shut = smooth(lie * 1.6)
    eyes_blink(p, 0.55 + 0.45 * shut if lie < 1 else 1.0)
    look(p, pitch=-4 * lie, roll=-NAP_HEAD_ROLL * lie)
    breath = {5: 1.0, 6: 0.35}.get(i, 0.0)
    p['chest']['scale'] = (1 + 0.02 * breath, 1 + 0.02 * breath, 1 + 0.035 * breath)
    p['props']['eye_glow'] = 0.18
    p['props']['core_glow'] = 0.30 + 0.45 * breath
    # Z floats up from his head, one then two: a bigger Z, a smaller one following. Clear of the head and the arm in every cell.
    if i >= 5:
        k = i - 5
        za = (0.0, 0.55, 1.1)[k]
        p['zzz_a'] = {'scale': SHOW, 'loc': (NAP_ZX + 0.25 * za, 0, NAP_ZZ + 0.42 * za)}
        zb = (0.0, 0.45, 1.0)[k]
        p['zzz_b'] = {'scale': SHOW, 'loc': (NAP_ZX - 1.35 + 0.2 * zb, 0, NAP_ZZ - 0.25 + 0.38 * zb)}
    return p


NAP_HEAD_ROLL = 38.0
# lying: both arms tucked in against his front, so he lies on his side and not on his elbows
NAP_ARM_R = {'wrist': (-0.95, -1.05, 1.75), 'pole': (-0.6, -0.5, -1.0), 'hand': (0.6, -0.4, -0.5), 'spin': 0.0}
NAP_ARM_L = {'wrist': (0.95, -1.05, 1.55), 'pole': (0.6, -0.5, -1.0), 'hand': (-0.6, -0.4, -0.5), 'spin': 0.0}
NAP_ZX = 1.35     # world x of the big Z in the lying cells (BU)
NAP_ZZ = 3.55


def c_stretch(i, n=7):
    """a big stretch: 0 is the idle stance, 1-2 arms rise, 3-4 arms up and out with the head back and the eyes squeezed shut, 5 lets go, 6 shakes it off"""
    p = base()
    up = (0.0, 0.45, 0.85, 1.0, 1.08, 0.35, 0.0)[i]
    yawn = (0.0, 0.0, 0.3, 1.0, 1.0, 0.2, 0.0)[i]
    p['arm_R'] = {'wrist': lerp(ARM_R_REF['wrist'], (-1.70, -0.20, 3.60), up), 'pole': lerp(ARM_R_REF['pole'], (-0.8, 0.3, -1.0), up),
                  'hand': lerp(ARM_R_REF['hand'], (-0.35, -0.05, 1.0), up), 'spin': 0.0}
    p['arm_L'] = {'wrist': lerp(ARM_L_REF['wrist'], (1.70, -0.20, 3.50), up), 'pole': lerp(ARM_L_REF['pole'], (0.8, 0.3, -1.0), up),
                  'hand': lerp(ARM_L_REF['hand'], (0.35, -0.05, 1.0), up), 'spin': 0.0}
    p['torso']['rot'] = (-7.0 * up, 0, 0)
    p['chest']['scale'] = (1 + 0.05 * up, 1 + 0.05 * up, 1 + 0.06 * up)
    p['head']['rot'] = add(HEAD_REF, (-15.0 * yawn - 2 * up + (6 if i == 6 else 0), 0, 0))
    p['crest']['rot'] = (-8 * yawn, 0, 0)
    p['root']['loc'] = (0, 0, 0.10 * up if i not in (6,) else -0.10)
    for k, ref in (('leg_R', LEG_R_REF), ('leg_L', LEG_L_REF)):
        p[k] = dict(ref, ankle=add(ref['ankle'], (0, 0, 0.10 * up if i != 6 else 0.10)))
    if i in (3, 4):      # the big stretch: eyes squeezed shut and a wide grin (the beaming face), the same on both sides
        p['face_n']['scale'] = HIDE; p['face_h']['scale'] = SHOW
        p['eye_R']['scale'] = HIDE; p['eye_L']['scale'] = HIDE
    else:
        eyes_blink(p, yawn)
    p['props']['core_glow'] = 1.0 + 0.2 * up
    p['props']['eye_glow'] = 1.0 - 0.25 * yawn
    return p


def c_scratch(i, n=7):
    """looks left, looks right, then scratches his head with his right clamp: 0 left, 1 right, 2 front (the idle stance), 3 raising, 4-5 scratch, 6 lowering"""
    p = base()
    ph = {3: 0.5, 4: 1.0, 5: 1.0, 6: 0.5}.get(i, 0.0)
    scr = {4: 1.0, 5: -1.0}.get(i, 0.0)
    tgt = worried_arm(0.0)
    tgt = dict(tgt, wrist=(-1.50, -0.32, 3.52), hand=(0.60, 0.05, 0.80))
    p['arm_R'] = {'wrist': lerp(ARM_R_REF['wrist'], tgt['wrist'], ph), 'pole': lerp(ARM_R_REF['pole'], tgt['pole'], ph),
                  'hand': lerp(ARM_R_REF['hand'], tgt['hand'], ph), 'spin': 26.0 * scr * (ph > 0.9)}
    if ph > 0.9:
        p['arm_R']['wrist'] = add(p['arm_R']['wrist'], (0.14 * scr, 0.0, 0.14 * scr))
    yaw = {0: -24, 1: 24, 2: 0}.get(i, 0)
    eyes = {0: (-0.05, 0.0), 1: (0.05, 0.0)}.get(i, (0.0, 0.0))
    if ph:
        look(p, yaw=0, pitch=-3, roll=-11 * ph, eyes=(-0.02, 0.05))
        p['torso']['rot'] = (0, -1.5 * ph, 0)
    else:
        look(p, yaw=yaw, eyes=eyes)
    if i in (4, 5):
        eyes_blink(p, 0.6)
    return p


def c_stumble(i, n=8):
    """a trip he recovers from: 0 steps, 1 toe catches, 2-3 pitches forward, arms out, 4 catches himself, 5 straightens, 6-7 shakes his head"""
    p = base()
    pitch = (0.0, 6.0, 20.0, 22.0, 6.0, -2.0, 0.0, 0.0)[i]
    flail = (0.0, 0.3, 1.0, 1.0, 0.6, 0.2, 0.0, 0.0)[i]
    p['torso']['rot'] = (pitch, 0, 0)
    p['pelvis']['rot'] = (0.3 * pitch, 0, 0)
    p['head']['rot'] = add(HEAD_REF, (-0.35 * pitch + (4 if i == 5 else 0), 0, {6: 10, 7: -10}.get(i, 0)))
    p['root']['loc'] = (0, 0, -0.08 * flail)
    out = flail
    p['arm_R'] = {'wrist': lerp(ARM_R_REF['wrist'], (-1.85, -0.55, 3.00), out), 'pole': (-0.6, 0.3, -1.0),
                  'hand': lerp(ARM_R_REF['hand'], (-0.7, -0.2, 0.8), out), 'spin': 0.0}
    p['arm_L'] = {'wrist': lerp(ARM_L_REF['wrist'], (1.85, -0.55, 2.55), out), 'pole': (0.6, 0.3, -1.0),
                  'hand': lerp(ARM_L_REF['hand'], (0.7, -0.2, 0.5), out), 'spin': 0.0}
    toe = {1: 1.0, 2: 0.7, 3: 0.0}.get(i, 0.0)
    la = LEG_L_REF['ankle']
    p['leg_L'] = dict(LEG_L_REF, ankle=(la[0], la[1] - 0.45 * toe - (0.2 if i == 3 else 0), la[2] + 0.22 * toe - (0.0)), pitch=-26 * toe)
    ra = LEG_R_REF['ankle']
    if i in (2, 3):
        p['leg_R'] = dict(LEG_R_REF, ankle=(ra[0], ra[1] + 0.25, ra[2] + 0.28), pitch=22)
    if i == 4:
        p['leg_L'] = dict(LEG_L_REF, ankle=(la[0], la[1] - 0.55, la[2]), pitch=-6)
    if i in (2, 3):
        p['face_n']['scale'] = (1.1, 1.0, 1.8)
        p['eye_R']['scale'] = (1.18, 1.18, 1.18); p['eye_L']['scale'] = (1.18, 1.18, 1.18)
    p['props']['eye_glow'] = 1.0 + 0.3 * flail
    return p


def c_tinker(i, n=8):
    """tinkers with his hammer: 0 takes it out, 1-2 holds it up and turns it over, looking at it, 3-4 two light taps (3 up, 4 down), 5 nods, 6 puts it away,
    7 the idle stance. The other clamp stays at his side, so nothing crosses the core"""
    p = base()
    if i == 7:       # the last cell is the idle stance (hammer put away): the clip cuts to Idle with no pop
        return p
    held = (0.5, 1.0, 1.0, 1.0, 1.0, 1.0, 0.5, 0.0)[i]
    p['hammer']['scale'] = SHOW if held >= 1.0 else (0.6, 0.6, 0.6)
    turn = {2: 1.0}.get(i, 0.0)
    strike = 1.0 if i == 4 else 0.0
    up_w, dn_w = (-1.30, -0.30, 2.62), (-1.28, -0.35, 2.12)
    up_h, dn_h = (-0.30, -0.05, 0.92), (-0.55, -0.15, -0.40)
    w = lerp(up_w, dn_w, strike); h = lerp(up_h, dn_h, strike)
    p['arm_R'] = {'wrist': lerp(ARM_R_REF['wrist'], w, held), 'pole': lerp(ARM_R_REF['pole'], (-0.3, 0.3, -1.0), held),
                  'hand': lerp(ARM_R_REF['hand'], (h[0] + 0.12 * turn, h[1], h[2] - 0.2 * turn), held), 'spin': 50 * turn}
    p['head']['rot'] = add(HEAD_REF, (9.0 * held - (6 if i == 5 else 0) + 3 * strike, 0, -4 * held))
    p['torso']['rot'] = (3.0 * held, 0, 0)
    p['eye_R']['loc'] = (0.0, 0, -0.05 * held); p['eye_L']['loc'] = (0.0, 0, -0.05 * held)
    p['props']['core_glow'] = 1.0 + 0.2 * strike + 0.05 * held
    p['props']['eye_glow'] = 1.0 + 0.1 * held
    if i == 5:
        eyes_blink(p, 0.9)
    return p


# ---------------------------------------------------------------- idle life loops (the `talos-loops` sheet)
# What he does all day: stands and lives. Five loops authored at 24 fps (4 to 5 s for the standing ones, 3 s for the Needs-you extras) and sampled to the atlas cells
# by loop_cells: a pose is held while the true motion stays within a tolerance, so fast moments get many cells and slow ones few. Every channel is a sine in whole turns that is zero on frame 0
# (osc), so frame 0 is the idle stance (the clip cuts to and from Idle with no pop) and the loop closes on itself. Everything is a
# POSE of the rig: chest, shoulders, hips, arms, head, eyes. Nothing slides the whole figure: the root moves a little over planted
# feet (stand), and the build lifts every frame so the lowest foot is on the anchor row.
LOOP_N = 120


def osc(ph, k=1, a=0.0):
    """a sine of k turns per loop with phase a (radians), shifted so it is exactly 0 at ph 0 (and so at the loop's end)"""
    return math.sin(TAU * k * ph - a) - math.sin(-a)


def track(i, keys):
    """a value that eases from key to key: keys is [(frame, value)...], each leg smoothstepped (stops at every key, so a hold is a flat leg)"""
    if i <= keys[0][0]:
        return keys[0][1]
    for (t0, v0), (t1, v1) in zip(keys, keys[1:]):
        if i <= t1:
            return lerp(v0, v1, smooth((i - t0) / (t1 - t0)))
    return keys[-1][1]


def stand(p, dx, dz=0.0):
    """move the hips by (dx, dz) and keep both feet where they were: the ankles are in the root frame, so they take the opposite offset"""
    p['root']['loc'] = add(p['root']['loc'], (dx, 0, dz))
    for k, ref in (('leg_R', LEG_R_REF), ('leg_L', LEG_L_REF)):
        q = p.get(k, ref)
        p[k] = dict(q, ankle=add(q['ankle'], (-dx, 0, -dz)))
    return p


def blink_at(p, i, at):
    """a blink starting on source frame `at`: half shut, shut two frames on, half again, open (about a quarter of a second)"""
    keys = [(at - 1, 0.0), (at + 1, 0.55), (at + 3, 1.0), (at + 5, 0.5), (at + 7, 0.0)]
    amount = 0.0 if i <= keys[0][0] or i >= keys[-1][0] else next(
        lerp(v0, v1, (i - t0) / (t1 - t0)) for (t0, v0), (t1, v1) in zip(keys, keys[1:]) if i <= t1)
    if amount > 0:
        eyes_blink(p, amount)


def idle_life(p, i, n):
    """the standing life shared by the idle loop and the look-around: breath in the chest and shoulders, a slow weight shift with the hips
    following, the arms hanging and swaying, the head drifting and tilting, the glow breathing with him"""
    ph = i / n
    b = osc(ph, 1, 0.0)                     # breath
    w = osc(ph, 1, 1.3)                     # weight shift (hips one way, then the other, once a loop)
    d = osc(ph, 1, 2.6)                     # arm sway, a beat behind the body
    p['chest']['scale'] = (1 + 0.030 * b, 1 + 0.024 * b, 1 + 0.050 * b)
    p['torso']['rot'] = add(p['torso']['rot'], (-1.4 * b, -1.6 * w, 1.6 * osc(ph, 1, 2.0)))
    p['pelvis']['rot'] = add(p['pelvis']['rot'], (0, 3.2 * w, 0))
    stand(p, 0.085 * w, -0.030 * abs(w))
    # the unloaded foot's heel eases up a touch, the loaded one stays flat
    for k, ref, side in (('leg_R', LEG_R_REF, -1), ('leg_L', LEG_L_REF, 1)):
        q = p[k]
        free = max(0.0, -w * side)
        p[k] = dict(q, ankle=add(q['ankle'], (0, 0, 0.03 * free)), pitch=q['pitch'] - 4.0 * free)
    sh = 0.075 * osc(ph, 1, 0.5)            # the shoulders rise with the breath
    p['arm_R'] = dict(ARM_R_REF, wrist=add(ARM_R_REF['wrist'], (0.06 * d, 0.07 * osc(ph, 1, 3.2), sh)),
                      spin=9.0 * osc(ph, 1, 1.0))
    p['arm_L'] = dict(ARM_L_REF, wrist=add(ARM_L_REF['wrist'], (0.10 * osc(ph, 1, 2.2), 0.09 * osc(ph, 1, 3.4), sh * 0.8)),
                      hand=add(ARM_L_REF['hand'], (0.10 * osc(ph, 1, 3.0), 0.0, 0.0)))
    p['head']['rot'] = add(p['head']['rot'], (3.0 * osc(ph, 1, 2.2) - 1.8 * b, 4.0 * osc(ph, 2, 0.6), 5.0 * osc(ph, 1, 0.4)))
    p['crest']['rot'] = (2.6 * osc(ph, 1, 0.9), 0, 0)
    p['eye_R']['loc'] = (0.022 * osc(ph, 1, 0.4), 0, 0.012 * b); p['eye_L']['loc'] = p['eye_R']['loc']
    p['props']['core_glow'] = 1.0 + 0.18 * osc(ph, 2, 0.5)
    p['props']['eye_glow'] = 1.0 + 0.05 * b
    return p


IDLE_BLINK, LOOK_BLINK, NEEDS_BLINK = 62, 50, 80      # source frame each loop's one blink starts on


def c_idle_loop(i, n=96):
    """idle, 4 s: breathing, a weight shift, swaying arms, a drifting head, one blink"""
    p = idle_life(base(), i, n)
    blink_at(p, i, IDLE_BLINK)
    return p


def c_idle_look(i, n=LOOP_N):
    """a look around, 5 s: the eyes lead, the head turns to screen left, holds, turns to screen right, holds, comes back; the body
    follows by a few degrees. The standing life carries on underneath"""
    p = idle_life(base(), i, n)
    head = track(i, [(0, 0.0), (12, 0.0), (30, -23.0), (46, -23.0), (68, 21.0), (86, 21.0), (108, 0.0), (120, 0.0)])
    eyes = track(i, [(0, 0.0), (8, 0.0), (14, -0.055), (46, -0.055), (60, 0.055), (86, 0.055), (102, 0.0), (120, 0.0)])
    body = track(i, [(0, 0.0), (16, 0.0), (36, -3.8), (50, -3.8), (72, 3.4), (90, 3.4), (112, 0.0), (120, 0.0)])
    lift = track(i, [(0, 0.0), (30, 1.0), (46, 1.0), (68, 1.0), (86, 1.0), (108, 0.0), (120, 0.0)])
    p['head']['rot'] = add(p['head']['rot'], (-1.5 * lift, -0.12 * head, head))
    p['torso']['rot'] = add(p['torso']['rot'], (0, 0, body))
    p['pelvis']['rot'] = add(p['pelvis']['rot'], (0, 0, body * 0.5))
    p['eye_R']['loc'] = add(p['eye_R']['loc'], (eyes, 0, 0)); p['eye_L']['loc'] = p['eye_R']['loc']
    # the clamps hang a little behind the turn
    p['arm_L'] = dict(p['arm_L'], wrist=add(p['arm_L']['wrist'], (0.0, -0.05 * body, 0.0)))
    blink_at(p, i, LOOK_BLINK)
    return p


def needs_life(p, i, n):
    """the Needs-you standing life, shared by its three clips: he rocks gently heel to toe over planted feet (`n` frames a rock), the hammer
    clamp hangs and swings a beat behind, the crest follows, the core glows a little warmer than Idle's. Zero on frame 0, which is the
    waiting pose (hammer down, face turned up to you, his free clamp held out)"""
    ph = i / n
    r = osc(ph, 1, 0.0)                      # the rock: + is toward the toes
    p['torso']['rot'] = (-1.5 + 2.4 * r, 0, 1.0 * osc(ph, 1, 1.5))
    p['pelvis']['rot'] = (1.0 * r, 0, 0)
    stand(p, 0.0, -0.025 * abs(r))
    fwd, back = max(r, 0.0), max(-r, 0.0)
    for k, ref in (('leg_R', LEG_R_REF), ('leg_L', LEG_L_REF)):      # heels come up on the way forward, toes on the way back
        p[k] = dict(ref, ankle=add(ref['ankle'], (0, 0, 0.035 * fwd)), pitch=-7.0 * fwd + 4.0 * back)
    p['head']['rot'] = (-9.0 - 1.8 * r, 5.0, 3.0 + 1.5 * osc(ph, 1, 0.8))
    p['arm_R'] = dict(ARM_R_DOWN, wrist=add(ARM_R_DOWN['wrist'], (0.03 * osc(ph, 1, 1.4), 0.10 * osc(ph, 1, 2.2), 0.03 * osc(ph, 1, 0.6))))
    p['crest']['rot'] = (2.0 * osc(ph, 1, 0.9), 0, 0)
    p['props']['core_glow'] = 1.1 + 0.16 * osc(ph, 2, 0.5)
    return p


def beckon_arm(p, cur, k):
    """his free clamp: `k` 0..1 raises it a little, `cur` 0..1 curls it toward himself (the beckon)"""
    p['arm_L'] = {'wrist': (1.78 - 0.20 * cur - 0.04 * k, -0.42 + 0.06 * cur, 2.12 + 0.07 * k + 0.12 * cur),
                  'pole': (1.0, 0.1, -0.2), 'hand': (0.55 - 0.45 * cur, -0.35 - 0.10 * cur, 0.55 + 0.30 * cur), 'spin': -12.0 * cur}
    return p


def c_needs_loop(i, n=96):
    """Needs you, the base loop, 4 s: waiting for you. Rocks gently heel to toe, glances away and back to you, his clamp drifts and lifts a
    little, one blink. It plays whenever nothing else does, so he is never a frozen frame"""
    p = needs_life(hammer_down(base()), i, n)
    r = osc(i / n, 1, 0.0)
    f = n / 120.0                               # the keys below are for a 120-frame loop
    glance = track(i, [(t * f, v) for t, v in [(0, 0.0), (30, 0.0), (42, 1.0), (62, 1.0), (74, 0.0), (120, 0.0)]])
    p['head']['rot'] = add(p['head']['rot'], (6.0 * glance, -2.0 * glance, 13.0 * glance))
    eye = (0.035 - 0.07 * glance, 0, 0.06 - 0.09 * glance)
    p['eye_R']['loc'] = eye; p['eye_L']['loc'] = eye
    lift = track(i, [(t * f, v) for t, v in [(0, 0.0), (66, 0.0), (84, 1.0), (104, 0.0), (120, 0.0)]])
    beckon_arm(p, 0.25 * lift, lift)
    blink_at(p, i, NEEDS_BLINK)
    return p


def c_needs_beckon(i, n=72):
    """Needs you, 3 s: he looks right at you, nods, and his free clamp curls toward himself twice (come here), the face brightening"""
    p = needs_life(hammer_down(base()), i, n)
    k = track(i, [(0, 0.0), (8, 1.0), (60, 1.0), (72, 0.0)])
    cur = 0.5 - 0.5 * math.cos(TAU * 2 * (i - 10) / 40.0) if 10 <= i <= 50 else 0.0
    nod = max(0.0, math.sin(TAU * 2 * (i - 10) / 40.0)) if 10 <= i <= 50 else 0.0
    p['head']['rot'] = add(p['head']['rot'], (3.5 * nod + 2.0 * k, -2.0 * k, 0.0))
    beckon_arm(p, cur, k)
    p['face_n']['scale'] = (1 + 0.16 * k, 1.0, 1 + 0.2 * k)
    p['props']['core_glow'] = 1.1 + 0.16 * osc(i / n, 2, 0.5) + 0.12 * k
    return p


def c_needs_tap(i, n=72):
    """Needs you, 3 s: a patient little toe tap. He glances down at his foot, taps twice with the toe of his left foot, looks back up, one blink"""
    p = needs_life(hammer_down(base()), i, n)
    down = track(i, [(0, 0.0), (8, 1.0), (50, 1.0), (60, 0.0), (72, 0.0)])
    tap = max(0.0, math.sin(TAU * 2 * (i - 12) / 34.0)) ** 2 if 12 <= i <= 46 else 0.0
    p['head']['rot'] = add(p['head']['rot'], (9.0 * down, 0.0, 6.0 * down))
    eye = (0.035 - 0.03 * down, 0, 0.06 - 0.14 * down)
    p['eye_R']['loc'] = eye; p['eye_L']['loc'] = eye
    q = p['leg_L']
    p['leg_L'] = dict(q, ankle=add(q['ankle'], (0, 0, 0.05 * tap)), pitch=q['pitch'] + 16.0 * tap)     # the toe comes up and drops: heel stays down
    beckon_arm(p, 0.0, 0.0)
    p['arm_L']['wrist'] = add(p['arm_L']['wrist'], (-0.06 * down, 0.0, -0.10 * down))
    blink_at(p, i, 56)
    return p


# The ember layer (spec 3.2): the eye and core glow ALONE, drawn brighter than the glow baked into the body, so that stepping its opacity
# between 0 and 1 changes visible pixels. It must sit exactly on the body's own glow, so there is one ember cell per clip that can hold
# still (Idle, settled Working, Needs you, and every Reduce Motion still), each rendered from the very pose of that clip's `still` column.
# A single idle-stance cell (the first cut) was 7-15 px off the running and waiting poses and drew four eyes.
EMBER_EYE = 2.0
EMBER_CORE = 2.0
EMBER_ROWS = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review', 'talking', 'landed']


def _boost(p):
    p['props']['eye_glow'] = EMBER_EYE
    p['props']['core_glow'] = EMBER_CORE
    return p


def c_ember(i=0, n=len(EMBER_ROWS)):
    """cell i of the ember atlas: the pose of EMBER_ROWS[i]'s still column, glow layer only, boosted"""
    row = next(r for r in ATLAS_ROWS if r[0] == EMBER_ROWS[i])
    cnt, _loop, fn, _extra = DESKTOP_CLIPS[row[3]]
    return _boost(fn(row[6], cnt))


def _hide_gear(p):
    p['gear']['scale'] = HIDE
    return p


def c_bust(i, n=4):
    """Mini's four busts: pleased, worried, waiting, statue. The gear is hidden (the bust has no gear)"""
    if i == 0:
        p = base()
    elif i == 1:
        p = c_worried(47, 48)
    elif i == 2:
        p = c_waiting(0, 3)
    else:
        p = c_statue(0, 1)
    return _hide_gear(p)


MINI_EMBER_STATES = ('pleased', 'worried', 'waiting')      # the statue sleeps: no ember cell


def c_bust_ember(i=0, n=3):
    return _boost(c_bust(i, 4))


# ---- the atlas tables. A `d_*` clip holds the rendered frames of one row; frame k is column k.
# `pick` = (source clip, [source frame indices]) for rows that retime an existing clip; new rows are authored at their own count.
# `seq` = the playback sequence [(column, ms)] that goes into companion.json
def _pick(src_fn, src_n, idxs):
    def f(i, n):
        return src_fn(idxs[i], src_n)
    return f


LOOP_LEN = {'idle-loop': 96, 'idle-look': 120, 'needs-loop': 96, 'needs-beckon': 72, 'needs-tap': 72}
LOOP_TOL = {'idle-loop': 2.6, 'idle-look': 4.4, 'needs-loop': 4.4, 'needs-beckon': 4.0, 'needs-tap': 5.0}    # how far (weighted pose units, about one pixel at the shown size) a held cell may be from the pose it stands for
LOOP_MAX_HOLD = 8        # source frames: no cell is held longer than a third of a second
LOOP_MIN_HOLD = 2        # source frames: 83 ms, above the atlas's 80 ms floor
_POSE_W = {'rot': 1.0, 'loc': 40.0, 'scale': 40.0, 'ankle': 40.0, 'wrist': 40.0, 'hand': 20.0, 'spin': 0.4, 'pitch': 1.0}


def pose_vec(p):
    """a pose as a flat list of weighted numbers, so two poses can be compared in roughly screen pixels (degrees count 1, a body unit 40)"""
    out = []
    for bone in sorted(p):
        ch = p[bone]
        for key in sorted(ch):
            w = _POSE_W.get(key, 6.0 if key.endswith('_glow') else 0.0)
            v = ch[key]
            out.extend(w * x for x in (v if isinstance(v, (tuple, list)) else (v,)))
    return out


def loop_cells(fn, tol, n):
    """which source frames become cells, and for how long each is held: [(source frame, hold in source frames)].
    Walks the loop and holds one pose for as long as the true motion stays within `tol` of it (never past LOOP_MAX_HOLD, never under
    LOOP_MIN_HOLD), so fast moments (a blink, a head turn, a beckon) get many cells and slow ones (a hold, a long breath) few. The pose a
    cell shows is the one in the middle of its hold, which halves the lag a held pose has behind the motion."""
    vecs = [pose_vec(fn(i)) for i in range(n)]
    cells, a = [], 0
    while a < n:
        best = None
        for b in range(a + LOOP_MIN_HOLD, min(a + LOOP_MAX_HOLD, n) + 1):
            mid = (a + b) // 2
            if max(max(abs(x - y) for x, y in zip(vecs[f], vecs[mid])) for f in range(a, b)) <= tol:
                best = b
        b = best or min(a + LOOP_MIN_HOLD, n)
        if n - b == 1:                      # never leave a one-frame tail
            b = n
        cells.append(((a + b) // 2, b - a))
        a = b
    return cells


def _loop_hold(cells):
    """the playback table: [(column, ms)], the cells in order. Rounded on the running total, so the loop adds up to exactly its length
    (120 frames is 5000 ms), not a few milliseconds short"""
    out, acc, shown = [], 0, 0
    for k, (_, hold) in enumerate(cells):
        acc += hold
        t = int(round(acc * 1000 / 24))
        out.append((k, t - shown))
        shown = t
    return out


LOOP_FNS = {'idle-loop': c_idle_loop, 'idle-look': c_idle_look, 'needs-loop': c_needs_loop, 'needs-beckon': c_needs_beckon, 'needs-tap': c_needs_tap}
LOOP_CELLS = {k: loop_cells(f, LOOP_TOL[k], LOOP_LEN[k]) for k, f in LOOP_FNS.items()}
LOOP_IDS = {k: [c[0] for c in v] for k, v in LOOP_CELLS.items()}
LOOP_COLS = max(len(v) for v in LOOP_CELLS.values())
LOOPS_ATLAS = 'talos-loops'


ATLAS_ROWS = [
    # name, atlas, row, d_clip, ncols, loop, still, seq
    ('idle', 'talos', 0, 'd_idle', 3, True, 0, [(0, 4000), (0, 4000), (0, 3600), (1, 90), (2, 140), (1, 90)]),
    ('running-right', 'talos', 1, 'd_running_right', 8, True, 0, [(k, 140) for k in range(8)]),
    ('running-left', 'talos', 2, 'd_running_left', 8, True, 0, [(k, 140) for k in range(8)]),
    ('waving', 'talos', 3, 'd_waving', 8, False, 2, list(zip(range(8), (140, 120, 120, 120, 120, 120, 140, 260)))),
    ('jumping', 'talos', 4, 'd_jumping', 8, False, 7, list(zip(range(8), (110, 110, 130, 110, 130, 130, 150, 300)))),
    ('failed', 'talos', 5, 'd_failed', 7, False, 6, list(zip(range(7), (120, 140, 140, 160, 200, 200, 300)))),
    # waiting HOLDS (spec 2.2 row 3: "Holds. Ember pulses slowly"; 3.2: ember runs only while no clip plays, one mover): lean in, settle, one
    # blink, then rest on column 0 for good. loop is false so the controller's held frame is the ember's registered frame
    ('waiting', 'talos', 6, 'd_waiting', 3, False, 0, [(1, 300), (0, 300), (2, 140), (0, 600)]),
    # running: column 4 is the rebound half way down; the hammer takes 220 ms from the top pose to the strike (was 120: a snap, spec 9.2)
    ('running', 'talos', 7, 'd_running', 8, True, 7, list(zip(range(8), (280, 300, 260, 300, 220, 180, 200, 260)))),
    ('review', 'talos', 8, 'd_review', 6, False, 2, list(zip(range(6), (140, 160, 700, 700, 160, 140)))),
    ('talking', 'talos-ext', 0, 'd_talking', 6, False, 0, [(k, 200) for k in range(6)]),
    ('statue', 'talos-ext', 1, 'd_statue', 1, False, 0, [(0, 4000)]),
    ('landed', 'talos-ext', 2, 'd_landed', 3, False, 2, [(0, 100), (1, 120), (2, 200)]),
    # the antics (sheet `talos-life`): hold tables repeat cells, so a 10 s moment costs 6 to 8 cells
    ('sit', 'talos-life', 0, 'd_sit', 7, False, 0, [(0, 200), (1, 220), (2, 260), (3, 700), (4, 700), (3, 700), (4, 700), (3, 700), (4, 700), (5, 1100), (2, 600), (6, 240), (0, 200)]),
    ('nap', 'talos-life', 1, 'd_nap', 8, False, 5, [(0, 200), (1, 240), (2, 300), (3, 320), (4, 350), (5, 1600), (6, 1600), (7, 1600), (6, 1600), (5, 1600), (6, 1600), (7, 1600), (6, 1600), (4, 350), (3, 320), (2, 300), (1, 240), (0, 200)]),
    ('stretch', 'talos-life', 2, 'd_stretch', 7, False, 0, [(0, 300), (1, 200), (2, 200), (3, 900), (4, 700), (3, 700), (5, 220), (6, 260), (0, 400)]),
    ('scratch', 'talos-life', 3, 'd_scratch', 7, False, 2, [(2, 150), (0, 900), (1, 900), (2, 400), (3, 220), (4, 200), (5, 200), (4, 200), (5, 200), (4, 200), (5, 200), (6, 240), (2, 400)]),
    ('stumble', 'talos-life', 4, 'd_stumble', 8, False, 0, [(0, 300), (1, 130), (2, 130), (3, 220), (4, 160), (5, 200), (6, 260), (7, 260), (6, 200), (0, 300)]),
    ('tinker', 'talos-life', 5, 'd_tinker', 8, False, 0, [(7, 150), (0, 240), (1, 600), (2, 600), (1, 600), (3, 300), (4, 160), (3, 300), (4, 160), (5, 500), (6, 240), (7, 300)]),
    # the idle life (sheet `talos-loops`, LOOP_COLS wide): loops that play for as long as he stands. They carry their own glow in the body, so
    # none has an ember cell. A loop starts and ends on its rest stance (idle-loop and idle-look on Idle, needs-loop on Needs you)
    ('idle-loop', LOOPS_ATLAS, 0, 'd_idle_loop', len(LOOP_IDS['idle-loop']), True, 0, _loop_hold(LOOP_CELLS['idle-loop'])),
    ('idle-look', LOOPS_ATLAS, 1, 'd_idle_look', len(LOOP_IDS['idle-look']), False, 0, _loop_hold(LOOP_CELLS['idle-look'])),
    ('needs-loop', LOOPS_ATLAS, 2, 'd_needs_loop', len(LOOP_IDS['needs-loop']), True, 0, _loop_hold(LOOP_CELLS['needs-loop'])),
    ('needs-beckon', LOOPS_ATLAS, 3, 'd_needs_beckon', len(LOOP_IDS['needs-beckon']), False, 0, _loop_hold(LOOP_CELLS['needs-beckon'])),
    ('needs-tap', LOOPS_ATLAS, 4, 'd_needs_tap', len(LOOP_IDS['needs-tap']), False, 0, _loop_hold(LOOP_CELLS['needs-tap'])),
]
# transitions that reuse a cell row under another name (same atlas row, a different hold table): going to sleep is the lying-down half of
# the nap, waking is the getting-up. (name, source row, loop, still, seq)
ATLAS_ALIASES = [
    ('sleep', 'nap', False, 5, [(0, 200), (1, 240), (2, 300), (3, 320), (4, 350), (5, 500)]),
    ('wake', 'nap', False, 0, [(5, 200), (4, 280), (3, 320), (2, 300), (1, 240), (0, 200)]),
    ('wake-low', 'nap', False, 0, [(2, 200), (1, 240), (0, 200)]),
]


def c_wave_desktop(i, n=48):
    """the web wave, with the raised clamp held 0.17 further out so it never ducks behind the head (it read as a hump with a notch)"""
    p = c_wave(i, n)
    r = p['arm_R']; k = smooth(min(1.0, max(0.0, (r['wrist'][2] - ARM_R_REF['wrist'][2]) / 0.7)))
    p['arm_R'] = dict(r, wrist=add(r['wrist'], (-0.17 * k, 0.0, 0.0)))
    return p


WAVE_PICK = [0, 6, 11, 18, 25, 32, 40, 47]
# the first four columns are Poke's hop: crouch (on the ground), rise, peak, and LANDED (source frame 18, air 0). A click plays 0-3 and cuts
# to Idle, so column 3 must stand on the anchor row (it was frame 15, still 0.71 up, and he never landed)
JUMP_PICK = [4, 9, 12, 18, 21, 26, 31, 35]
FAIL_PICK = [0, 6, 12, 18, 24, 34, 47]
TALK_PICK = [1, 4, 6, 10, 13, 16]
MINI_STATES = ('pleased', 'worried', 'waiting', 'statue')
DESKTOP_CLIPS = {
    'd_idle': (3, False, c_blink, {}),
    'd_running_right': (8, True, c_walk_right, {}),
    'd_running_left': (8, True, c_walk_left, {}),
    'd_waving': (8, False, _pick(c_wave_desktop, 48, WAVE_PICK), {}),
    'd_jumping': (8, False, _pick(c_beaming, 36, JUMP_PICK), {}),
    'd_failed': (7, False, _pick(c_worried, 48, FAIL_PICK), {}),
    'd_waiting': (3, True, c_waiting, {}),
    'd_running': (8, True, c_hammer, {}),
    'd_review': (6, False, c_review, {}),
    'd_talking': (6, False, _pick(c_talking, 48, TALK_PICK), {}),
    'd_statue': (1, False, c_statue, {}),
    'd_landed': (3, False, c_landed, {}),
    'd_sit': (7, False, c_sit, {}),
    'd_nap': (8, False, c_nap, {}),
    'd_stretch': (7, False, c_stretch, {}),
    'd_scratch': (7, False, c_scratch, {}),
    'd_stumble': (8, False, c_stumble, {}),
    'd_tinker': (8, False, c_tinker, {}),
    'd_idle_loop': (len(LOOP_IDS['idle-loop']), True, _pick(c_idle_loop, LOOP_LEN['idle-loop'], LOOP_IDS['idle-loop']), {}),
    'd_idle_look': (len(LOOP_IDS['idle-look']), False, _pick(c_idle_look, LOOP_LEN['idle-look'], LOOP_IDS['idle-look']), {}),
    'd_needs_loop': (len(LOOP_IDS['needs-loop']), True, _pick(c_needs_loop, LOOP_LEN['needs-loop'], LOOP_IDS['needs-loop']), {}),
    'd_needs_beckon': (len(LOOP_IDS['needs-beckon']), False, _pick(c_needs_beckon, LOOP_LEN['needs-beckon'], LOOP_IDS['needs-beckon']), {}),
    'd_needs_tap': (len(LOOP_IDS['needs-tap']), False, _pick(c_needs_tap, LOOP_LEN['needs-tap'], LOOP_IDS['needs-tap']), {}),
    'd_ember': (len(EMBER_ROWS), False, c_ember, {'layers': ['glow']}),
    # the busts have no gear and no rivets (spec 9.4): `hide` is object-name prefixes switched off for the render (talos_build.py)
    'd_bust': (4, False, c_bust, {'hide': ['rivet']}),
    'd_bust_ember': (len(MINI_EMBER_STATES), False, c_bust_ember, {'layers': ['glow'], 'hide': ['rivet']}),
}


# name -> (frames, loop, fn, extra json)
CLIPS = {
    'idle': (72, True, c_idle, {}),
    'working': (48, True, c_working, {}),
    'talking': (48, True, c_talking, {'layers': ['glow']}),
    'thinking': (72, True, c_thinking, {}),
    'beaming': (36, False, c_beaming, {'hold': 'last'}),
    'worried': (48, False, c_worried, {'hold': 'last'}),
    'wave': (48, False, c_wave, {'hold': 'last'}),
    'rounds': (32, True, c_rounds, {}),
}
# The d_* clips join CLIPS only when TALOS_DESKTOP=1 (tools/atlas.py and the blend save set it). A plain build.sh run keeps rendering
# and packing exactly the 8 web clips, so the committed web assets cannot change by accident.
if os.environ.get('TALOS_DESKTOP') == '1':
    CLIPS.update(DESKTOP_CLIPS)
# stills matched against the three reference icons (critic + silhouette score)
STILLS = {
    'ref-pleased': c_ref,
    'ref-beaming': c_ref_beaming,
    'ref-worried': c_ref_worried,
}
