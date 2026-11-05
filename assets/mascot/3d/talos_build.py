"""Little Talos, 3D. Builds the model, the rig, every clip action, saves talos.blend and (optionally) renders.

  blender -b --factory-startup -P talos_build.py -- [--save talos.blend] [--render stills|clips|all|none] [--out DIR]
                                                   [--clip idle,wave] [--super 2] [--cell 512] [--samples 8]

Method (a 3D-to-sprite pipeline: render a rigged model with a fixed camera, then flatten it to a sprite look):
  * fixed orthographic camera + fixed look, only the model moves; EEVEE, transparent film, Standard view transform, 8-bit RGBA
  * render at SUPER x the cell and area-average down (tools/finish.py)
  * emission-only materials (flat black-figure body, no lighting), so the render reads as the 2D icon
  * cream CONTOURS at every part edge from a per-part ID pass (screen space, tools/finish.py), the way a sketch look takes
    inner contours from a normal pass: black-figure pottery draws each part as black with a cream incised edge, so the ID
    boundaries give the part edges, the silhouette line and the rivet rings in one mechanism. (an inverted-hull outline was tried
    first, round 1: a hull only shows against things BEHIND the part, so the eye rings, rivet rings and bead separations
    never appeared.)
  * incised panel lines are MATERIAL lines in each part's own object coordinates (plane-distance masks), so they ride
    the surface through every pose (pg-animation rule 2, "lines hold"); parts are rigid and bone-parented, so nothing swims
  * every clip is a script (talos_clips.py): a model change is one re-render
Facial features (eyes, smile, ^^ eyes, blush, brows, worried mouth, sweat drop, rivets) are DRAWN IN REFERENCE-ICON
PIXELS and projected onto the 3D surface through the render camera, so from the render view they land where the icon has them.
"""
import bpy, bmesh, math, sys, os, json, time
from mathutils import Vector, Matrix, Quaternion, Euler

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import importlib
import talos_clips as TC
importlib.reload(TC)

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def arg(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default

SAVE = arg('--save', None)
RENDER = arg('--render', 'none')
OUT = arg('--out', '/tmp/talos-render')
CLIP_SEL = [c for c in str(arg('--clip', '')).split(',') if c]
SUP = int(arg('--super', 2)); CELL = int(arg('--cell', 512)); SAMPLES = int(arg('--samples', 8))

# ---------------------------------------------------------------- constants
YAW = math.radians(-12.0)          # he faces a little to screen left, like the icon
ELEV = math.radians(10.0)          # camera looks down 10 deg (the icon's feet: the near foot sits ~20 px lower)
ORTHO = 7.2                        # BU across the square cell
CAM_TARGET = Vector((-0.10, 0.0, 2.90))
REF_PX = 205.0                     # icon pixels per BU (head radius 1 BU = 205 px on the 1254 px icon)
REF_O = (605.0, 1150.0)            # icon pixel of the model origin (ground under the torso centre)
LW = 0.040                         # cream line width (hull thickness and incised line width), BU

def hexlin(h):
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple((v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4) for v in c) + (1.0,)

BLACK = '#141110'; CREAM = '#F3E6CF'; ICHOR = '#FFB15C'; TERRA = '#D9692B'
IRIS_STOPS = [(0.0, '#FFB15C'), (0.90, '#FFB15C'), (0.91, '#EE9036'), (1.0, '#EE9036')]
CORE_STOPS = [(0.0, '#F7A23C'), (0.55, '#E58428'), (0.85, '#C2601E'), (1.0, '#8A4216')]
GEAR = '#FFD36B'; GEAR_HUB = '#FFF0B8'; BLUSH = '#E25A3C'; BRONZE = '#EBAA45'; BRONZE_DK = '#8A5418'

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
COL = scene.collection
t0 = time.time()

# ---------------------------------------------------------------- camera geometry (world) + model <-> world
CAM_D = Vector((0, math.cos(ELEV), -math.sin(ELEV)))     # forward
CAM_R = Vector((1, 0, 0))
CAM_U = Vector((0, math.sin(ELEV), math.cos(ELEV)))
RZ = Matrix.Rotation(YAW, 3, 'Z'); RZi = RZ.inverted()
TO_CAM_M = RZi @ (-CAM_D)          # model-space direction toward the camera
UP_M = RZi @ CAM_U                 # model-space screen-up

def ref_ray(px, py):
    u = (px - REF_O[0]) / REF_PX; v = (REF_O[1] - py) / REF_PX
    o = RZi @ (CAM_R * u + CAM_U * v - CAM_D * 20.0)
    return o, RZi @ CAM_D

def ray_ellipsoid(o, d, c, r):
    oo = Vector(((o.x - c.x) / r[0], (o.y - c.y) / r[1], (o.z - c.z) / r[2]))
    dd = Vector((d.x / r[0], d.y / r[1], d.z / r[2]))
    a = dd.dot(dd); b = 2 * oo.dot(dd); cc = oo.dot(oo) - 1
    disc = b * b - 4 * a * cc
    if disc < 0:
        return None
    s = (-b - math.sqrt(disc)) / (2 * a)
    return o + d * s

def ell_normal(p, c, r):
    q = p - c
    return Vector((q.x / r[0] ** 2, q.y / r[1] ** 2, q.z / r[2] ** 2)).normalized()

# the icon's head is rolled HEAD_REF (about model Y through the neck pivot): un-roll icon points onto the REST head
NECK_PIVOT = Vector((0, 0, 2.62))
HEAD_C = Vector((0, 0, 3.50)); HEAD_R = (1.05, 0.96, 0.92)
TORSO_C = Vector((0, 0, 1.80)); TORSO_R = (1.0, 0.90, 0.78)

def on_part(px, py, c, r, roll_deg=0.0, pivot=NECK_PIVOT, lift=0.0):
    o, d = ref_ray(px, py)
    if roll_deg:
        R = Matrix.Rotation(math.radians(roll_deg), 3, 'Y').inverted()
        o = R @ (o - pivot) + pivot; d = R @ d
    p = ray_ellipsoid(o, d, c, r)
    if p is None:
        # just past the silhouette: take the ray's closest approach and push it onto the surface (a rim point)
        q = o + d * (c - o).dot(d) - c
        k = math.sqrt((q.x / r[0]) ** 2 + (q.y / r[1]) ** 2 + (q.z / r[2]) ** 2)
        p = c + q / k
        print(f'[talos] icon point ({px},{py}) is {k:.3f}x the part radius: put on the rim')
    n = ell_normal(p, c, r)
    return p + n * lift, n

HEAD_DX = 16.0      # critic r3 #9: the face read ~0.04 head widths too far to screen left
def on_head(px, py, lift=0.0, roll=TC.HEAD_REF[1]):
    return on_part(px + HEAD_DX, py, HEAD_C, HEAD_R, roll, lift=lift)

def on_torso(px, py, lift=0.0):
    return on_part(px, py, TORSO_C, TORSO_R, 0.0, lift=lift)

def frame_z(z, up=None):
    """rotation whose local Z = z and local Y as close to screen-up as possible (local X = screen right)"""
    z = z.normalized(); up = (up or UP_M).normalized()
    x = up.cross(z)
    if x.length < 1e-4:
        x = Vector((1, 0, 0))
    x.normalize(); y = z.cross(x).normalized()
    return Matrix((x, y, z)).transposed()

# ---------------------------------------------------------------- materials
def _clear(m):
    m.use_nodes = True
    for n in list(m.node_tree.nodes):
        m.node_tree.nodes.remove(n)
    return m.node_tree.nodes, m.node_tree.links

GLOW_MATS = set()        # materials kept in the eye-glow layer
DRIVEN = []              # (value node, armature prop)

def mat_flat(name, hexc, lines=None, line_hex=CREAM, glow=None):
    m = bpy.data.materials.new(name); N, L = _clear(m)
    out = N.new('ShaderNodeOutputMaterial'); em = N.new('ShaderNodeEmission')
    L.new(em.outputs['Emission'], out.inputs['Surface'])
    col = em.inputs['Color']
    if lines:
        mix = N.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MIX'; mix.clamp_factor = True
        mix.inputs[6].default_value = hexlin(hexc); mix.inputs[7].default_value = hexlin(line_hex)
        L.new(mix.outputs[2], col)
        L.new(line_mask(N, L, lines), mix.inputs[0])
    elif glow:
        mul = N.new('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'; mul.inputs[0].default_value = 1.0
        mul.inputs[6].default_value = hexlin(hexc)
        L.new(glow_factor(N, L, glow), mul.inputs[7])
        L.new(mul.outputs[2], col)
    else:
        col.default_value = hexlin(hexc)
    m['flat'] = hexc
    return m

def glow_factor(N, L, prop):
    """armature custom prop (driven) -> colour multiplier: 1 at prop 1, darker below, brighter above"""
    v = N.new('ShaderNodeValue'); v.outputs[0].default_value = 1.0; v.label = prop
    DRIVEN.append((v, prop))
    ma = N.new('ShaderNodeMath'); ma.operation = 'MULTIPLY_ADD'; ma.inputs[1].default_value = 0.55; ma.inputs[2].default_value = 0.45
    L.new(v.outputs[0], ma.inputs[0])
    c = N.new('ShaderNodeCombineXYZ')
    for k in range(3):
        L.new(ma.outputs[0], c.inputs[k])
    return c.outputs[0]

def mat_radial(name, stops, radius, center=(0.0, 0.0), glow=None):
    """emissive disc: colour ramp over the radial distance in the part's local XY plane (object coords)"""
    m = bpy.data.materials.new(name); N, L = _clear(m)
    out = N.new('ShaderNodeOutputMaterial'); em = N.new('ShaderNodeEmission')
    tc = N.new('ShaderNodeTexCoord')
    sub = N.new('ShaderNodeVectorMath'); sub.operation = 'SUBTRACT'; sub.inputs[1].default_value = (center[0], center[1], 0.0)
    mul = N.new('ShaderNodeVectorMath'); mul.operation = 'MULTIPLY'; mul.inputs[1].default_value = (1 / radius, 1 / radius, 0.0)
    ln = N.new('ShaderNodeVectorMath'); ln.operation = 'LENGTH'
    ramp = N.new('ShaderNodeValToRGB'); cr = ramp.color_ramp; cr.interpolation = 'LINEAR'
    cr.elements[0].position = stops[0][0]; cr.elements[0].color = hexlin(stops[0][1])
    cr.elements[1].position = stops[-1][0]; cr.elements[1].color = hexlin(stops[-1][1])
    for pos, h in stops[1:-1]:
        e = cr.elements.new(pos); e.color = hexlin(h)
    L.new(tc.outputs['Object'], sub.inputs[0]); L.new(sub.outputs[0], mul.inputs[0]); L.new(mul.outputs[0], ln.inputs[0])
    L.new(ln.outputs['Value'], ramp.inputs['Fac'])
    colout = ramp.outputs['Color']
    if glow:
        mm = N.new('ShaderNodeMix'); mm.data_type = 'RGBA'; mm.blend_type = 'MULTIPLY'; mm.inputs[0].default_value = 1.0
        L.new(colout, mm.inputs[6]); L.new(glow_factor(N, L, glow), mm.inputs[7]); colout = mm.outputs[2]
    L.new(colout, em.inputs['Color']); L.new(em.outputs['Emission'], out.inputs['Surface'])
    return m

def line_mask(N, L, lines):
    """lines: list of dicts {n: (x,y,z), d: float, w: half width, clip: [((x,y,z), d, sign)]} in object coords.
    mask = max over lines of (|n.p - d| < w) * prod(sign * (n2.p - d2) > 0)"""
    tc = N.new('ShaderNodeTexCoord')
    acc = None
    for ln in lines:
        n = Vector(ln['n']).normalized()
        dot = N.new('ShaderNodeVectorMath'); dot.operation = 'DOT_PRODUCT'; dot.inputs[1].default_value = n
        L.new(tc.outputs['Object'], dot.inputs[0])
        sub = N.new('ShaderNodeMath'); sub.operation = 'SUBTRACT'; sub.inputs[1].default_value = ln.get('d', 0.0)
        L.new(dot.outputs['Value'], sub.inputs[0])
        ab = N.new('ShaderNodeMath'); ab.operation = 'ABSOLUTE'; L.new(sub.outputs[0], ab.inputs[0])
        w = ln.get('w', LW / 2)
        mr = N.new('ShaderNodeMapRange'); mr.clamp = True
        mr.inputs['From Min'].default_value = w * 0.80; mr.inputs['From Max'].default_value = w * 1.12
        mr.inputs['To Min'].default_value = 1.0; mr.inputs['To Max'].default_value = 0.0
        L.new(ab.outputs[0], mr.inputs['Value'])
        cur = mr.outputs['Result']
        for cn, cd, sign in ln.get('clip', []):
            cn = Vector(cn).normalized()
            d2 = N.new('ShaderNodeVectorMath'); d2.operation = 'DOT_PRODUCT'; d2.inputs[1].default_value = cn * sign
            L.new(tc.outputs['Object'], d2.inputs[0])
            gt = N.new('ShaderNodeMath'); gt.operation = 'GREATER_THAN'; gt.inputs[1].default_value = cd * sign
            L.new(d2.outputs['Value'], gt.inputs[0])
            mu = N.new('ShaderNodeMath'); mu.operation = 'MULTIPLY'
            L.new(cur, mu.inputs[0]); L.new(gt.outputs[0], mu.inputs[1]); cur = mu.outputs[0]
        if acc is None:
            acc = cur
        else:
            mx = N.new('ShaderNodeMath'); mx.operation = 'MAXIMUM'; L.new(acc, mx.inputs[0]); L.new(cur, mx.inputs[1]); acc = mx.outputs[0]
    return acc

def mat_outline(name='outline', hexc=CREAM):
    m = bpy.data.materials.new(name); N, L = _clear(m)
    out = N.new('ShaderNodeOutputMaterial'); em = N.new('ShaderNodeEmission'); em.inputs['Color'].default_value = hexlin(hexc)
    L.new(em.outputs['Emission'], out.inputs['Surface'])
    m.use_backface_culling = True
    m['flat'] = hexc
    return m

OUTLINE = mat_outline()
OUTLINE_THIN = OUTLINE
M_BLACK = mat_flat('black', BLACK)
M_CREAM = mat_flat('cream', CREAM)
M_BLUSH = mat_flat('blush', BLUSH)
M_BRONZE = mat_flat('bronze', BRONZE, lines=[{'n': (0.7, 0.7, 0), 'd': 0.0, 'w': 0.022}], line_hex=BRONZE_DK)
M_ICHOR = mat_flat('ichor_arc', ICHOR, glow='eye_glow')
M_HAPPY = mat_flat('happy_eye', '#ED9539', glow='eye_glow')
M_GEAR = mat_flat('gear', GEAR, glow='core_glow')
M_IRIS_LITE = mat_flat('iris_lite', '#FFD27A', glow='eye_glow')
GLOW_MATS.add('iris_lite')
M_HUB = mat_flat('gear_hub', GEAR_HUB, glow='core_glow')
GLOW_MATS |= {'ichor_arc', 'happy_eye', 'gear', 'gear_hub'}

# ---------------------------------------------------------------- geometry
PARTS = []      # (object, bone)

def finish(name, bm, mats, hull=LW, smooth=True):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    for p in me.polygons:
        p.use_smooth = smooth
    ob = bpy.data.objects.new(name, me); COL.objects.link(ob)
    for m in mats:
        me.materials.append(m)
    ob['lw'] = float(hull)           # cream contour width at this part's edges (BU); 0 = no contour (emissive / cream parts)
    return ob

def bm_ellipsoid(r, seg=48, rings=24):
    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * r[0], v.co.y * r[1], v.co.z * r[2]))
    return bm

def bm_cyl(r, z0, z1, seg=48, r1=None):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r, radius2=(r1 if r1 is not None else r), depth=z1 - z0)
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, (z0 + z1) / 2))
    return bm

def bm_poly_extrude(pts2d, t):
    """closed 2D polygon in local XZ, extruded along local Y from -t/2 to t/2"""
    bm = bmesh.new()
    vs = [bm.verts.new((x, -t / 2, z)) for x, z in pts2d]
    f = bm.faces.new(vs)
    ext = bmesh.ops.extrude_face_region(bm, geom=[f])
    nv = [g for g in ext['geom'] if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=nv, vec=(0, t, 0))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm

def bm_ring_sector(r_out, r_in, a0, a1, t, seg=40):
    """annulus sector in local XZ (angles from +Z toward +X, degrees), extruded along Y"""
    pts = []
    for k in range(seg + 1):
        a = math.radians(a0 + (a1 - a0) * k / seg); pts.append((r_out * math.sin(a), r_out * math.cos(a)))
    for k in range(seg, -1, -1):
        a = math.radians(a0 + (a1 - a0) * k / seg); pts.append((r_in * math.sin(a), r_in * math.cos(a)))
    return bm_poly_extrude(pts, t)

def bm_dome(r, seg=48, rings=24):
    """half ellipsoid, flat bottom at z=0"""
    bm = bm_ellipsoid(r, seg, rings)
    res = bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, 0), plane_no=(0, 0, 1), clear_inner=True)
    edges = [e for e in res['geom_cut'] if isinstance(e, bmesh.types.BMEdge)]
    bmesh.ops.holes_fill(bm, edges=edges)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm

def place(ob, loc, rot=None):
    M = Matrix.Translation(loc) @ ((rot.to_4x4() if rot is not None else Matrix.Identity(4)))
    ob.matrix_world = M
    return ob

def part(ob, bone):
    PARTS.append((ob, bone)); return ob

def tube(name, pts, r, mat, bone, hull=0.0):
    cu = bpy.data.curves.new(name + '_cu', 'CURVE'); cu.dimensions = '3D'
    cu.bevel_depth = r; cu.bevel_resolution = 4; cu.use_fill_caps = True
    sp = cu.splines.new('POLY'); sp.points.add(len(pts) - 1)
    for k, p in enumerate(pts):
        sp.points[k].co = (p.x, p.y, p.z, 1.0)
    tmp = bpy.data.objects.new(name + '_tmp', cu); COL.objects.link(tmp)
    bpy.context.view_layer.update()
    me = bpy.data.meshes.new_from_object(tmp.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    bpy.data.objects.remove(tmp); bpy.data.curves.remove(cu)
    # round caps: small spheres at both ends, merged in
    bm = bmesh.new(); bm.from_mesh(me)
    for p in (pts[0], pts[-1]):
        cap = bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=r)
        bmesh.ops.translate(bm, verts=cap['verts'], vec=p)
    bpy.data.meshes.remove(me)
    ob = finish(name, bm, [mat], hull=hull)
    return part(ob, bone)

def ref_curve(points_px, on, lift, n=24):
    """Catmull-Rom through icon pixel points -> 3D points on a part surface"""
    P = [Vector((x, y)) for x, y in points_px]
    out = []
    for k in range(n + 1):
        t = k / n * (len(P) - 1); i = min(int(t), len(P) - 2); f = t - i
        p0 = P[max(i - 1, 0)]; p1 = P[i]; p2 = P[i + 1]; p3 = P[min(i + 2, len(P) - 1)]
        q = 0.5 * ((2 * p1) + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f ** 3)
        out.append(on(q.x, q.y, lift)[0])
    return out

def rivet(p, n, bone, r=0.042, hull=0.026, name='rivet', min_facing=0.35):
    if n.dot(TO_CAM_M) < min_facing:          # critic r3: rivets seen edge-on read as dashes the flat icon never shows
        return None
    bm = bm_ellipsoid((r, r, r * 0.6), 16, 8)
    ob = finish(name, bm, [M_BLACK], hull=hull)
    place(ob, p + n * 0.004, frame_z(n))
    return part(ob, bone)

def decal_strip(name, outer_px, inner_px, on, lift, mat, bone_, lw=LW):
    """a flat-shaded patch on a part surface between two icon-pixel polylines (same point count): crescents, brows"""
    bm = bmesh.new()
    vo = [bm.verts.new(on(x, y, lift)[0]) for x, y in outer_px]
    vi = [bm.verts.new(on(x, y, lift)[0]) for x, y in inner_px]
    for k in range(len(vo) - 1):
        a, b, c, d = vo[k], vo[k + 1], vi[k + 1], vi[k]
        if a == d or (a.co - d.co).length < 1e-6:
            bm.faces.new((a, b, c))
        elif (b.co - c.co).length < 1e-6:
            bm.faces.new((a, b, d))
        else:
            bm.faces.new((a, b, c, d))
    ob = finish(name, bm, [mat], hull=lw, smooth=False)
    return part(ob, bone_)

def crescent_px(cx, cy, ro, T, a0=200, a1=-20, n=28):
    """icon-pixel crescent (the ^^ eye): outer arc over the top, inner edge offset inward by T*sin(pi f)^0.8"""
    out, inn = [], []
    for k in range(n + 1):
        f = k / n; a = math.radians(a0 + (a1 - a0) * f)
        ox, oy = cx + ro * math.cos(a), cy - ro * math.sin(a)
        t = T * math.sin(math.pi * f) ** 0.8
        out.append((ox, oy)); inn.append((cx + (ro - t) * math.cos(a), cy - (ro - t) * math.sin(a) + 0.35 * t))
    return out, inn

# ================================================================ RIG (rest pose, model space)
ARM_SH = {'R': Vector((-0.84, -0.02, 2.28)), 'L': Vector((0.84, -0.02, 2.28))}
L_UP, L_FO, L_HA = 0.48, 0.74, 0.40
REST_ARM_DIR = {'R': Vector((-math.sin(math.radians(12)), 0, -math.cos(math.radians(12)))),
                'L': Vector((math.sin(math.radians(12)), 0, -math.cos(math.radians(12))))}
HIP = {'R': Vector((-0.60, 0.0, 1.20)), 'L': Vector((0.62, 0.0, 1.20))}
KNEE_Z, ANKLE_Z = 0.80, 0.52

# porthole + eyes from the icon (pixels -> surface)
PH_P, PH_N = on_torso(555, 790)
EYE = {}
for side, (px, py) in (('R', (475, 462)), ('L', (675, 495))):
    p, n = on_head(px, py)
    ax = (n * 0.6 + TO_CAM_M * 0.4).normalized()
    EYE[side] = (p, n, ax)
FACE_P, FACE_N = on_head(556, 548)
SWEAT_P, SWEAT_N = on_part(784, 392, HEAD_C, HEAD_R, 7.0, lift=0.0)

arm_d = bpy.data.armatures.new('talos_rig')
ARM = bpy.data.objects.new('talos_rig', arm_d); COL.objects.link(ARM)
bpy.context.view_layer.objects.active = ARM
bpy.ops.object.mode_set(mode='EDIT')
BONES = []
def bone(name, head, tail, parent=None):
    eb = arm_d.edit_bones.new(name); eb.head = head; eb.tail = tail; eb.roll = 0.0
    if name in ('eye_R', 'eye_L'):
        eb.align_roll(UP_M)      # local Z = screen-up inside the disc plane, so a lid (scale z) squashes each eye the same way on screen
    if parent:
        eb.parent = arm_d.edit_bones[parent]; eb.use_connect = False
    BONES.append(name)

V = Vector
bone('root', V((0, 0, 0)), V((0, 0, 0.4)))
bone('pelvis', V((0, 0, 1.15)), V((0, 0, 1.45)), 'root')
bone('torso', V((0, 0, 1.20)), V((0, 0, 2.40)), 'pelvis')
bone('chest', V((0, 0, 1.80)), V((0, 0, 2.10)), 'torso')
bone('gear', PH_P, PH_P + PH_N * 0.2, 'chest')
bone('neck', V((0, 0, 2.50)), V((0, 0, 2.62)), 'torso')
bone('head', NECK_PIVOT, V((0, 0, 4.40)), 'neck')
bone('crest', V((0, 0, 4.35)), V((0, 0, 4.70)), 'head')
for s in ('R', 'L'):
    bone('eye_' + s, EYE[s][0], EYE[s][0] + EYE[s][2] * 0.2, 'head')
bone('face_n', FACE_P, FACE_P + FACE_N * 0.2, 'head')
bone('face_h', FACE_P, FACE_P + FACE_N * 0.2, 'head')
bone('face_w', FACE_P, FACE_P + FACE_N * 0.2, 'head')
bone('sweat', SWEAT_P, SWEAT_P + V((0, 0, 0.1)), 'head')
for s in ('R', 'L'):
    sh = ARM_SH[s]; dr = REST_ARM_DIR[s]
    el = sh + dr * L_UP; wr = el + dr * L_FO; cl = wr + dr * L_HA
    bone('upper_' + s, sh, el, 'torso'); bone('fore_' + s, el, wr, 'upper_' + s); bone('hand_' + s, wr, cl, 'fore_' + s)
    hp = HIP[s]
    bone('thigh_' + s, hp, V((hp.x, 0, KNEE_Z)), 'pelvis')
    bone('shin_' + s, V((hp.x, 0, KNEE_Z)), V((hp.x, 0, ANKLE_Z)), 'thigh_' + s)
    bone('foot_' + s, V((hp.x, 0, ANKLE_Z)), V((hp.x, -0.35, ANKLE_Z)), 'shin_' + s)
# the nap's floating Z's: two loose letters, world-placed (no parent), hidden unless a pose shows them (see FK / solve)
bone('zzz_a', V((0, 0, 0)), V((0, 0, 0.1)))
bone('zzz_b', V((0, 0, 0)), V((0, 0, 0.1)))
bone('hammer', ARM_SH['R'] + REST_ARM_DIR['R'] * (L_UP + L_FO + L_HA), ARM_SH['R'] + REST_ARM_DIR['R'] * (L_UP + L_FO + L_HA) + V((0, 0, 0.1)), 'hand_R')
bpy.ops.object.mode_set(mode='OBJECT')
bpy.context.view_layer.update()
for k in ('eye_glow', 'core_glow'):
    ARM[k] = 1.0

# ================================================================ MODEL
# --- head ------------------------------------------------------------------
# Corinthian faceplate (critic r1 #1): the brim is a chevron, two planes that dip to a V over the nose seam and rise
# toward the temples; a raised ridge band runs from the V back over the dome to the crest plinth.
# z = BD + BK*|x| - BA*y, solved from three icon points (V on the seam z .44, the peak ~.50 at 30 deg, the ear top ~.28)
BK, BA, BD = 0.319, 0.514, -0.023
BRIM_L = ((BK, BA, 1.0), BD)                          # his right half (x < 0)
BRIM_RT = ((-BK, BA, 1.0), BD)                        # his left half (x > 0)   (r2: these two were swapped, the brim fell to eye height)
V_PT = Vector((0.0, -0.89, 0.44))
CREST_BASE = Vector((0.13, 0.09, 0.99))
rb_n = V_PT.normalized().cross(CREST_BASE.normalized()).normalized()
head_lines = [
    {'n': BRIM_L[0], 'd': BRIM_L[1], 'clip': [((1, 0, 0), 0.0, -1), ((0, 1, 0), 0.4, -1)]},
    {'n': BRIM_RT[0], 'd': BRIM_RT[1], 'clip': [((1, 0, 0), 0.0, 1), ((0, 1, 0), 0.4, -1)]},
    {'n': (1, 0, 0), 'd': 0.0, 'clip': [((0, 0, 1), 0.44, -1), ((0, 0, 1), -0.36, 1), ((0, 1, 0), 0.0, -1)]},  # face seam, V to smile
    {'n': (0, -0.26, 1.0), 'd': -0.32, 'clip': [((0, 1, 0), 0.30, -1)]},                                 # jaw line
]
# planes are n.p = d with n un-normalised: line_mask normalises n, so scale d to match
for ln in head_lines:
    nl = Vector(ln['n']).length
    ln['d'] = ln['d'] / nl
    ln['clip'] = [(cn, cd / Vector(cn).length, sg) for cn, cd, sg in ln['clip']]
M_HEAD = mat_flat('head', BLACK, lines=head_lines)
head = finish('head', bm_ellipsoid(HEAD_R, 64, 32), [M_HEAD]); place(head, HEAD_C); part(head, 'head')
bm = bm_ellipsoid(tuple(r * 1.035 for r in HEAD_R), 96, 48)
for co, no in ((Vector((0, 0, 0)), -rb_n), (-rb_n * 0.17, rb_n), (Vector((0, 0, BD)), Vector((-BK, BA, 1)).normalized())):
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=co, plane_no=no, clear_inner=True)
ridge = finish('helmet_ridge', bm, [M_BLACK]); place(ridge, HEAD_C); part(ridge, 'head')

# ears: concentric discs on both sides
for s, sx, tw in (('R', -1, -0.12), ('L', 1, -0.50)):
    ax = Vector((sx, tw, -0.02)).normalized()          # r1: tabs edge-on -> turned toward the camera; r2: his right one tucks behind the face
    c = HEAD_C + Vector((sx * 0.98, -0.12 if s == 'L' else 0.0, -0.05))
    bm = bm_dome((0.36, 0.36, 0.19), 40, 12)
    e = finish('ear_cap_' + s, bm, [M_BLACK]); place(e, c, frame_z(ax, Vector((0, 0, 1)))); part(e, 'head')
    if s == 'L':
        for k, (rr_, z0, z1) in enumerate(((0.25, 0.08, 0.19), (0.15, 0.12, 0.24))):
            e = finish(f'ear{k}_' + s, bm_cyl(rr_, z0, z1), [M_BLACK]); place(e, c, frame_z(ax, Vector((0, 0, 1)))); part(e, 'head')

# crest: one slab in a plane turned toward the camera (twisted perspective, like the vase painting), radial plate lines
CREST_TH0, CREST_TH1 = -6.0, 90.0
def crest_rout(th):
    f = (th - CREST_TH0) / (CREST_TH1 - CREST_TH0)
    return 1.76 - 0.54 * f ** 1.3
def polar(th, r):
    return Vector((r * math.sin(math.radians(th)), r * math.cos(math.radians(th))))
pts = []
# front edge: from the base (th 6, r 0.8) nearly straight up, then a ROUNDED tip onto the outer edge (critic r1 #4)
F0, F1 = polar(6.0, 0.80), polar(-3.0, crest_rout(CREST_TH0) - 0.16)
for k in range(8):
    f = k / 7; q = F0.lerp(F1, f)
    q = polar(math.degrees(math.atan2(q.x, q.y)) + 5.5 * math.sin(math.pi * f), q.length)   # concave sweep back: the Greek hook
    pts.append(q)
T1 = polar(4.0, crest_rout(4.0)); C = polar(-3.0, crest_rout(CREST_TH0) + 0.02)
for k in range(1, 9):
    t = k / 8; pts.append((1 - t) ** 2 * F1 + 2 * (1 - t) * t * C + t * t * T1)
for k in range(1, 41):
    th = 4.0 + (CREST_TH1 - 4.0) * k / 40; pts.append(polar(th, crest_rout(th)))
for k in range(1, 20):
    th = CREST_TH1 - (CREST_TH1 - 6.0) * k / 20; pts.append(polar(th, 0.80))
pts = [(v.x, v.y) for v in pts]
plate_lines = []
for th in [13 + (CREST_TH1 - 13) * k / 7 for k in range(0, 7)]:
    t = math.radians(th)
    plate_lines.append({'n': (math.cos(t), 0, -math.sin(t)), 'd': 0.0, 'clip': [((math.sin(t), 0, math.cos(t)), 0.9, 1)]})
M_CREST = mat_flat('crest', BLACK, lines=plate_lines)
crest = finish('crest', bm_poly_extrude(pts, 0.13), [M_CREST], smooth=False)
CREST_A = math.radians(38.0)       # crest u-axis: 38 deg from his left (x) toward the back (y)
u_dir = Vector((math.cos(CREST_A), math.sin(CREST_A), 0)); n_dir = Vector((0, 0, 1)).cross(u_dir)
crest_rot = Matrix((u_dir, n_dir, Vector((0, 0, 1)))).transposed()
place(crest, HEAD_C + Vector((-0.06, 0.10, 0.02)), crest_rot); part(crest, 'crest')
pp = [polar(4 + 24 * k / 12, 1.065) for k in range(13)] + [polar(4 + 24 * k / 12, 0.86) for k in range(12, -1, -1)]
pl = finish('crest_holder', bm_poly_extrude([(v.x, v.y) for v in pp], 0.17), [M_BLACK], smooth=False)
place(pl, HEAD_C + Vector((-0.06, 0.10, 0.02)), crest_rot); part(pl, 'crest')

# eyes: socket (hull ring) + iris (emissive radial) + highlight, on the eye bone
for s in ('R', 'L'):
    p, n, ax = EYE[s]
    R = frame_z(ax)
    sk = finish('eye_socket_' + s, bm_cyl(0.285, -0.12, 0.09), [M_BLACK], hull=0.042); place(sk, p, R); part(sk, 'eye_' + s)
    mi = mat_radial('iris_' + s, IRIS_STOPS, 0.20, center=(0.0, 0.0), glow='eye_glow'); GLOW_MATS.add(mi.name)
    mi.node_tree.nodes['Color Ramp'].color_ramp.interpolation = 'CONSTANT'
    ir = finish('eye_iris_' + s, bm_cyl(0.20, 0.0, 0.10), [mi], hull=0.0); place(ir, p, R); part(ir, 'eye_' + s)
    lc = finish('eye_lite_' + s, bm_cyl(0.105, 0.0, 0.104, seg=32), [M_IRIS_LITE], hull=0.0)
    place(lc, p + R @ Vector((-0.055, -0.06, 0.0)), R); part(lc, 'eye_' + s)
    hl = finish('eye_hl_' + s, bm_cyl(0.074, 0.0, 0.11, seg=24), [M_CREAM], hull=0.0)
    place(hl, p + R @ Vector((0.065, 0.07, 0.0)), R); part(hl, 'eye_' + s)

# smile (normal), ^^ eyes + blush + grin (beaming), brows + wavy mouth (worried): drawn in icon pixels
oh = lambda x, y, l: on_head(x, y, l)
tube('smile', ref_curve([(515, 535), (531, 549), (552, 556), (576, 553), (600, 541)], oh, 0.006), 0.018, M_CREAM, 'face_n')
tube('grin', ref_curve([(495, 507), (515, 532), (545, 547), (580, 551), (612, 546), (640, 535), (655, 524)], oh, 0.006), 0.019, M_CREAM, 'face_h')
o_, i_ = crescent_px(482, 484, 43, 27); decal_strip('happy_eye_R', o_, i_, oh, 0.012, M_HAPPY, 'face_h', lw=0.036)
o_, i_ = crescent_px(679, 502, 47, 28); decal_strip('happy_eye_L', o_, i_, oh, 0.012, M_HAPPY, 'face_h', lw=0.036)
for s, (px, py, rx, ry) in (('R', (457, 511, 17, 9)), ('L', (697, 536, 18, 9))):
    p, n = on_head(px, py, 0.004)
    bl = finish('blush_' + s, bm_cyl(1.0, 0.0, 0.02, seg=32), [M_BLUSH], hull=0.0)
    for v in bl.data.vertices:
        v.co.x *= rx / REF_PX; v.co.y *= ry / REF_PX * 1.15
    place(bl, p, frame_z((n + TO_CAM_M * 0.5).normalized())); part(bl, 'face_h')
tube('brow_R', ref_curve([(462, 394), (480, 398), (500, 395), (524, 380)], oh, 0.006), 0.019, M_CREAM, 'face_w')
tube('brow_L', ref_curve([(645, 396), (660, 410), (680, 420), (705, 425)], oh, 0.006), 0.019, M_CREAM, 'face_w')
tube('mouth_worried', ref_curve([(525, 548), (537, 541), (550, 547), (565, 544), (580, 550), (597, 560)], oh, 0.006), 0.017, M_CREAM, 'face_w')
# sweat drop (worried): a cream teardrop on the helmet
bm = bm_ellipsoid((0.085, 0.09, 0.04), 20, 12)
for v in bm.verts:
    if v.co.y > 0:
        k = min(1.0, v.co.y / 0.09)
        v.co.x *= (1 - k) ** 0.9; v.co.z *= (1 - k) ** 0.9; v.co.y *= 1.9
sw = finish('sweat', bm, [M_CREAM], hull=0.0)
place(sw, SWEAT_P + SWEAT_N * 0.04, frame_z((SWEAT_N + TO_CAM_M).normalized(), Vector((0, 0, 1)))); part(sw, 'sweat')

# head rivets (icon pixels)
for px, py in [(437, 397), (628, 405), (745, 435), (600, 470), (724, 561), (666, 344), (512, 336)]:
    p, n = on_head(px, py)
    rivet(p, n, 'head')

# --- torso -----------------------------------------------------------------
torso_lines = [
    {'n': (0, 0, 1), 'd': -0.01},                                                    # waist band through the porthole
    {'n': (1, 0, 0), 'd': -0.05, 'clip': [((0, 1, 0), 0.0, -1)]},                     # front seam (passes behind the porthole)
    {'n': (0, -0.22, 1.0), 'd': -0.58, 'clip': [((0, 1, 0), 0.2, -1)]},               # lower belly band
]
for ln in torso_lines:
    nl = Vector(ln['n']).length; ln['d'] /= nl
M_TORSO = mat_flat('torso', BLACK, lines=torso_lines)
torso = finish('torso', bm_ellipsoid(TORSO_R, 64, 32), [M_TORSO]); place(torso, TORSO_C); part(torso, 'chest')
for k, (r, z0, z1) in enumerate(((0.66, 2.45, 2.53), (0.52, 2.52, 2.60))):
    c = finish(f'collar_{k}', bm_cyl(r, z0, z1), [M_BLACK]); place(c, Vector((0, -0.02, 0))); part(c, 'torso')
# porthole
R = frame_z(PH_N)
for name, r, z0, z1 in (('port_ring', 0.42, -0.08, 0.05), ('port_inner', 0.31, -0.02, 0.085)):
    o = finish(name, bm_cyl(r, z0, z1, seg=64), [M_BLACK]); place(o, PH_P, R); part(o, 'chest')
M_CORE = mat_radial('core', CORE_STOPS, 0.25, glow='core_glow'); GLOW_MATS.add('core')
o = finish('core', bm_cyl(0.25, 0.0, 0.095, seg=64), [M_CORE], hull=0.0); place(o, PH_P, R); part(o, 'chest')
for k in range(8):
    a = math.tau * (k + 0.5) / 8
    q = PH_P + R @ Vector((0.365 * math.cos(a), 0.365 * math.sin(a), 0.05))
    rivet(q, PH_N, 'chest', r=0.026, hull=0.016)
# gear (spins on the gear bone)
gp = []
for k in range(8 * 4):
    a = math.tau * k / 32; tooth = (k % 4) in (0, 1)
    rr = 0.20 if tooth else 0.155
    a2 = a + (math.tau / 64 if tooth else 0)
    gp.append((rr * math.cos(a), rr * math.sin(a)))
bm = bmesh.new(); vs = [bm.verts.new((x, y, 0.0)) for x, y in gp]; f = bm.faces.new(vs)
ext = bmesh.ops.extrude_face_region(bm, geom=[f]); bmesh.ops.translate(bm, verts=[g for g in ext['geom'] if isinstance(g, bmesh.types.BMVert)], vec=(0, 0, 0.02))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
g = finish('gear', bm, [M_GEAR], hull=0.0, smooth=False); place(g, PH_P + PH_N * 0.097, R); part(g, 'gear')
hb = finish('gear_hub', bm_cyl(0.05, 0.0, 0.03, seg=24), [M_HUB], hull=0.0); place(hb, PH_P + PH_N * 0.1, R); part(hb, 'gear')
# torso rivets (spherical placement on the ellipsoid, his front)
for az, el in [(-60, 30), (-34, 50), (36, 48), (60, 30), (-64, 4), (-62, -22), (-50, -42), (56, -14), (44, -40)]:
    a, e = math.radians(az), math.radians(el)
    d = Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e)))
    o, _ = TORSO_C, None
    p = ray_ellipsoid(TORSO_C + d * 3, -d, TORSO_C, TORSO_R)
    rivet(p, ell_normal(p, TORSO_C, TORSO_R), 'chest', min_facing=0.15)

# --- arms ------------------------------------------------------------------
def bead(name, c, r, axis, bone_, mat=M_BLACK, hull=LW):
    bm = bm_ellipsoid(r, 32, 16)
    ob = finish(name, bm, [mat], hull=hull); place(ob, c, frame_z(axis, Vector((0, -1, 0)) if abs(axis.y) < 0.9 else Vector((0, 0, 1))))
    return part(ob, bone_)

CLAMP_OPEN = {'R': 25.0, 'L': 15.0}     # opening of the C, degrees clockwise (seen from the camera) from the hand axis
for s, sx in (('R', -1), ('L', 1)):
    sh = ARM_SH[s]; dr = REST_ARM_DIR[s]
    el = sh + dr * L_UP; wr = el + dr * L_FO; cl = wr + dr * L_HA
    bead('shoulder_' + s, sh + Vector((sx * 0.02, 0, 0)), (0.26, 0.26, 0.26), dr, 'upper_' + s)
    # r4: separate round beads with a big elbow ball (a scalloped chain, not a ribbed hose)
    bead('upperarm_' + s, sh + dr * (L_UP * 0.55), (0.235, 0.235, 0.235), dr, 'upper_' + s)
    bead('elbow_' + s, el, (0.255, 0.255, 0.255), dr, 'fore_' + s)
    bead('fore1_' + s, el + dr * (L_FO * 0.40), (0.225, 0.225, 0.225), dr, 'fore_' + s)
    bead('fore2_' + s, el + dr * (L_FO * 0.74), (0.21, 0.21, 0.21), dr, 'fore_' + s)
    bead('wrist_' + s, wr, (0.19, 0.19, 0.17), dr, 'hand_' + s)
    if s == 'L':                                   # r5: the icon's lowered arm carries rivets on its beads
        for bc, br, bn_ in ((el, 0.255, 'fore_L'), (el + dr * (L_FO * 0.74), 0.21, 'fore_L')):
            q = ray_ellipsoid(bc + Vector((0.06, -3, 0.0)), Vector((0, 1, 0)), bc, (br, br, br))
            rivet(q, (q - bc).normalized(), bn_, r=0.036, hull=0.022)
    # wrist knob ring + dot facing the camera (critic r1 #6: ~1.7x)
    kp = wr + Vector((0, -0.18, 0))
    rivet(kp + Vector((0, 0.02, 0)), Vector((0, -1, 0)), 'hand_' + s, r=0.065, hull=0.03)
    # clamp: a thick C in the plane facing the camera, opening rotated CLAMP_OPEN from the hand axis
    ang_axis = math.degrees(math.atan2(dr.x, dr.z))            # hand axis angle from +Z toward +X (screen clockwise)
    op = ang_axis + CLAMP_OPEN[s]
    gap = 40.0
    # crab-claw C: full thickness through the back, tapering to pointed tips at the opening (r3 too thick, r4 too thin: 0.21 BU)
    a0, a1 = op + gap / 2, op + 360 - gap / 2; ptsC = []; N = 64
    for k in range(N + 1):
        f = k / N; a = math.radians(a0 + (a1 - a0) * f); t = min(1.0, 3.2 * min(f, 1 - f)) ** 0.6
        ptsC.append((0.42 * math.sin(a), 0.42 * math.cos(a)))
    for k in range(N, -1, -1):
        f = k / N; a = math.radians(a0 + (a1 - a0) * f); t = min(1.0, 9.0 * min(f, 1 - f)) ** 0.5
        ri = 0.42 - 0.12 - 0.12 * t
        ptsC.append((ri * math.sin(a), ri * math.cos(a)))
    bm = bm_poly_extrude(ptsC, 0.17)
    cm = finish('clamp_' + s, bm, [mat_flat('clamp_' + s, BLACK, lines=[{'n': (math.cos(math.radians(op + 180)), 0, -math.sin(math.radians(op + 180))), 'd': 0.0, 'clip': [((math.sin(math.radians(op + 180)), 0, math.cos(math.radians(op + 180))), 0.1, 1)]}])], smooth=True)
    place(cm, cl); part(cm, 'hand_' + s)

# hammer (working), held in his right clamp
hm_axis = REST_ARM_DIR['R']
hc = ARM_SH['R'] + hm_axis * (L_UP + L_FO + L_HA)
h1 = finish('hammer_handle', bm_cyl(0.06, -0.05, 0.80, seg=16), [M_BLACK], hull=0.03); place(h1, hc, frame_z(hm_axis, Vector((0, -1, 0)))); part(h1, 'hammer')
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
for v in bm.verts:
    v.co = Vector((v.co.x * 0.46, v.co.y * 0.22, v.co.z * 0.24))
h2 = finish('hammer_head', bm, [mat_flat('hammer_head', BLACK, lines=[{'n': (1, 0, 0), 'd': 0.11}, {'n': (1, 0, 0), 'd': -0.11}])], hull=0.036, smooth=False)
place(h2, hc + hm_axis * 0.80, frame_z(hm_axis, Vector((0, -1, 0)))); part(h2, 'hammer')

# --- legs ------------------------------------------------------------------
FOOT_YAW = {'R': -44.0, 'L': 46.0}
for s, sx in (('R', -1), ('L', 1)):
    hp = HIP[s]; kn = Vector((hp.x, 0, KNEE_Z)); an = Vector((hp.x, 0, ANKLE_Z))
    down = Vector((0, 0, -1))
    bead('hipball_' + s, hp + Vector((sx * 0.02, 0, -0.08)), (0.29, 0.27, 0.23), down, 'thigh_' + s)
    KR = (0.25, 0.24, 0.19); kc = kn + Vector((0, 0, -0.04))
    kb = bead('knee_' + s, kc, KR, down, 'shin_' + s)
    for dx in (-0.09, 0.09):
        q = ray_ellipsoid(kc + Vector((dx, -3, 0)), Vector((0, 1, 0)), kc, KR)
        rivet(q, ell_normal(q, kc, KR), 'shin_' + s, r=0.036, hull=0.022)
    yaw = math.radians(FOOT_YAW[s])
    Rf = Matrix.Rotation(yaw, 3, 'Z')
    bm = bmesh.new(); bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=40, radius1=0.25, radius2=0.16, depth=0.26)
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, 0.44))
    ank = finish('ankle_' + s, bm, [M_BLACK])
    place(ank, Vector((an.x, 0, 0)), Rf); part(ank, 'foot_' + s)
    FR = (0.42, 0.60, 0.40)
    fp = Vector((an.x, 0, 0)) + Rf @ Vector((0, -0.20, 0))      # toe-heavy shoe: the dome sits forward of the ankle
    ft = finish('foot_' + s, bm_dome(FR, 48, 24), [M_BLACK]); place(ft, fp, Rf); part(ft, 'foot_' + s)
    for lx, lz in ((-0.20, 0.14), (0.16, 0.20)):
        q = ray_ellipsoid(fp + Rf @ Vector((lx, -3, lz)), Rf @ Vector((0, 1, 0)), fp, FR)
        rivet(q, ell_normal(q, fp, FR), 'foot_' + s)
# the bronze nail at his left ankle (the myth's one vein of ichor)
nail_p = Vector((HIP['L'].x, 0, 0)) + Vector((0.24, -0.10, 0.44))
nail_ax = Vector((0.80, -0.58, 0.10)).normalized()
ns = finish('nail_stem', bm_cyl(0.045, -0.12, 0.10, seg=16), [M_BRONZE], hull=0.02); place(ns, nail_p, frame_z(nail_ax)); part(ns, 'foot_L')
nh = finish('nail_head', bm_ellipsoid((0.12, 0.12, 0.11), 32, 16), [M_BRONZE], hull=0.04); place(nh, nail_p + nail_ax * 0.12, frame_z(nail_ax)); part(nh, 'foot_L')

# --- the nap's Z's: a flat black Z with the same cream contour as every other part, turned square to the camera. Added last so no
# earlier part's ID changes.
_Z = [(0, 1), (1, 1), (1, .8), (.36, .2), (1, .2), (1, 0), (0, 0), (0, .2), (.64, .8), (0, .8)]
def _z_outline(size):
    return [((x - 0.5) * size, (y - 0.5) * size) for x, y in _Z]
_zn = TO_CAM_M.normalized(); _zu = RZi @ CAM_U
# Local x runs to screen RIGHT, local y away from the camera, local z up (a letter in the x-z plane reads correctly seen from -y; the first
# version took x to screen left and y toward the camera, which drew every Z backwards).
_zx = _zu.cross(_zn).normalized(); _zu = _zn.cross(_zx).normalized()
Z_ROT = Matrix((_zx, -_zn, _zu)).transposed()
for _nm, _size in (('zzz_a', 0.96), ('zzz_b', 0.66)):
    _zo = finish(_nm, bm_poly_extrude(_z_outline(_size), 0.16), [M_BLACK], hull=0.034, smooth=False)
    place(_zo, Vector((0, 0, 0)), Z_ROT); part(_zo, _nm)

# ---------------------------------------------------------------- parent every part to its bone (rest pose)
bpy.context.view_layer.update()
for ob, bn in PARTS:
    M = ob.matrix_world.copy()
    ob.parent = ARM; ob.parent_type = 'BONE'; ob.parent_bone = bn
    bpy.context.view_layer.update()
    ob.matrix_world = M
bpy.context.view_layer.update()
ARM.rotation_euler = (0, 0, YAW)

# drivers: armature custom props -> material glow values
for node, prop in DRIVEN:
    fc = node.outputs[0].driver_add('default_value'); d = fc.driver; d.type = 'AVERAGE'
    v = d.variables.new(); v.name = 'p'; v.type = 'SINGLE_PROP'
    v.targets[0].id_type = 'OBJECT'; v.targets[0].id = ARM; v.targets[0].data_path = f'["{prop}"]'

# ================================================================ POSE SOLVER (FK + 2-bone IK -> keyed matrix_basis)
REST = {}
for b in arm_d.bones:
    REST[b.name] = {'head': b.head_local.copy(), 'tail': b.tail_local.copy(), 'ml': b.matrix_local.copy(),
                    'parent': b.parent.name if b.parent else None}

def T_about(head, rot=None, scale=None, loc=None):
    M = Matrix.Translation(head)
    if rot is not None:
        M = M @ rot.to_4x4()
    if scale is not None:
        if isinstance(scale, Matrix):
            S = scale.to_4x4()
        else:
            S = Matrix.Diagonal((scale[0], scale[1], scale[2], 1.0))
        M = M @ S
    M = M @ Matrix.Translation(-head)
    if loc is not None:
        M = Matrix.Translation(Vector(loc)) @ M
    return M

def eye_lid_scale(name, sc):
    """Lid squash for eye_R / eye_L. A pose scale is applied in the bone's own axes (matrix_basis keeps only a diagonal scale, a shear is
    dropped when it is keyed). The eye bones used roll 0, so their local Z was an arbitrary direction in each tilted disc: the lid
    cut one disc across its width (a thin tilted slit) and barely touched the other (a round oval). The eye bones are now rolled so
    local Z is screen-up in the disc, and the scale is built in that frame so it keys exactly. Other bones pass through unchanged."""
    if sc is None or name not in ('eye_R', 'eye_L'):
        return sc
    k, ky, kz = sc
    if abs(kz - k) < 1e-9 and abs(ky - k) < 1e-9:
        return sc
    B = REST[name]['ml'].to_3x3()
    return B @ Matrix.Diagonal((k, k, kz)) @ B.transposed()

def eul(d):
    return Euler([math.radians(a) for a in d], 'XYZ').to_matrix()

def frame_from(axis, front):
    axis = axis.normalized(); f = front - axis * front.dot(axis)
    if f.length < 1e-4:
        f = Vector((0, 0, 1)) - axis * axis.z
    f.normalize(); s = axis.cross(f)
    return Matrix((axis, f, s)).transposed()

def seg_rot(rest_axis, new_axis, front=Vector((0, -1, 0)), spin=0.0):
    B0 = frame_from(rest_axis, Vector((0, -1, 0)))
    B1 = frame_from(new_axis, front)
    Rw = B1 @ B0.transposed()
    if spin:
        Rw = Matrix.Rotation(math.radians(spin), 3, (B1 @ Vector((0, 1, 0)))) @ Rw
    return Rw

def ik2(A, W, L1, L2, pole):
    d = W - A; dist = d.length
    dist = max(abs(L1 - L2) + 1e-3, min(L1 + L2 - 1e-3, dist)); u = d.normalized()
    v = pole - u * pole.dot(u)
    if v.length < 1e-5:
        v = Vector((0, 0, -1)) - u * (-u.z)
    v.normalize()
    ca = (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist); ca = max(-1, min(1, ca)); sa = math.sqrt(1 - ca * ca)
    E = A + L1 * (ca * u + sa * v)
    W2 = A + u * dist
    return E, W2

FK = ['root', 'pelvis', 'torso', 'chest', 'gear', 'neck', 'head', 'crest', 'eye_R', 'eye_L', 'face_n', 'face_h', 'face_w', 'sweat', 'zzz_a', 'zzz_b']
ZZZ_HIDDEN = {'scale': (1e-4, 1e-4, 1e-4)}      # a pose that does not mention a Z has none: every older clip renders as before

def solve(pose):
    T = {}
    def fk(name):
        r = REST[name]; ch = pose.get(name, ZZZ_HIDDEN if name.startswith('zzz') else {})
        Tp = T[r['parent']] if r['parent'] else Matrix.Identity(4)
        rot = eul(ch['rot']) if 'rot' in ch else None
        T[name] = Tp @ T_about(r['head'], rot, eye_lid_scale(name, ch.get('scale')), ch.get('loc'))
    for nme in FK:
        fk(nme)
    # arms: IK in the torso rest frame
    for s in ('R', 'L'):
        a = pose['arm_' + s]; Tt = T['torso']
        A = (Tt @ REST['upper_' + s]['head'].to_4d()).to_3d()
        W = (Tt @ Vector(a['wrist']).to_4d()).to_3d()
        Rt = Tt.to_3x3().normalized()
        pole = Rt @ Vector(a['pole']); hand = (Rt @ Vector(a['hand'])).normalized()
        E, W2 = ik2(A, W, L_UP, L_FO, pole)
        ra = REST_ARM_DIR[s]
        front = Rt @ Vector((0, -1, 0))
        R1 = seg_rot(ra, E - A, front); R2 = seg_rot(ra, W2 - E, front); R3 = seg_rot(ra, hand, front, a.get('spin', 0.0))
        T['upper_' + s] = Matrix.Translation(A) @ R1.to_4x4() @ Matrix.Translation(-REST['upper_' + s]['head'])
        T['fore_' + s] = Matrix.Translation(E) @ R2.to_4x4() @ Matrix.Translation(-REST['fore_' + s]['head'])
        T['hand_' + s] = Matrix.Translation(W2) @ R3.to_4x4() @ Matrix.Translation(-REST['hand_' + s]['head'])
    hch = pose.get('hammer', {})
    T['hammer'] = T['hand_R'] @ T_about(REST['hammer']['head'], None, hch.get('scale'))
    # legs: IK in the root frame
    for s in ('R', 'L'):
        lg = pose['leg_' + s]; Tr = T['root']; Tpel = T['pelvis']
        A = (Tpel @ REST['thigh_' + s]['head'].to_4d()).to_3d()
        W = (Tr @ Vector(lg['ankle']).to_4d()).to_3d()
        Rr = Tr.to_3x3().normalized()
        E, W2 = ik2(A, W, HIP[s].z - KNEE_Z, KNEE_Z - ANKLE_Z, Rr @ Vector(lg['pole']))
        down = Vector((0, 0, -1)); front = Rr @ Vector((0, -1, 0))
        R1 = seg_rot(down, E - A, front); R2 = seg_rot(down, W2 - E, front)
        Rf = Rr @ Matrix.Rotation(math.radians(lg.get('yaw', 0.0)), 3, 'Z') @ Matrix.Rotation(math.radians(lg.get('pitch', 0.0)), 3, 'X')
        rest_yaw = Matrix.Rotation(math.radians(FOOT_YAW[s]), 3, 'Z')
        Rf = Rf @ rest_yaw.inverted()
        T['thigh_' + s] = Matrix.Translation(A) @ R1.to_4x4() @ Matrix.Translation(-REST['thigh_' + s]['head'])
        T['shin_' + s] = Matrix.Translation(E) @ R2.to_4x4() @ Matrix.Translation(-REST['shin_' + s]['head'])
        T['foot_' + s] = Matrix.Translation(W2) @ Rf.to_4x4() @ Matrix.Translation(-REST['foot_' + s]['head'])
    return T

def apply_pose(pose, frame=None):
    T = solve(pose)
    for name in BONES:
        r = REST[name]
        Tp = T[r['parent']] if r['parent'] else Matrix.Identity(4)
        basis = r['ml'].inverted() @ Tp.inverted() @ T[name] @ r['ml']
        pb = ARM.pose.bones[name]
        pb.rotation_mode = 'QUATERNION'
        pb.matrix_basis = basis
        if frame is not None:
            for ch in ('location', 'rotation_quaternion', 'scale'):
                pb.keyframe_insert(ch, frame=frame)
    for k, v in pose.get('props', {}).items():
        ARM[k] = float(v)
        if frame is not None:
            ARM.keyframe_insert(f'["{k}"]', frame=frame)

# NOTE: the rest pose built the hand with the rest yaw baked into the foot parts: apply_pose handles it (rest_yaw above)

# ================================================================ ACTIONS
bpy.context.preferences.edit.keyframe_new_interpolation_type = 'LINEAR'
ARM.animation_data_create()
ACTIONS = {}
def make_action(name, n, fn):
    act = bpy.data.actions.new(name); act.use_fake_user = True
    ARM.animation_data.action = act
    for i in range(n):
        apply_pose(fn(i), frame=i + 1)
    ACTIONS[name] = (act, n)
    return act

todo = {}
for nm, fn in TC.STILLS.items():
    todo[nm] = (1, fn)
for nm, (n, loop, fn, extra) in TC.CLIPS.items():
    if RENDER != 'stills' and (not CLIP_SEL or nm in CLIP_SEL):
        todo[nm] = (n, (lambda f, n=n: (lambda i: f(i, n)))(fn))
for nm, (n, fn) in todo.items():
    make_action(nm, n, fn)
print(f'[talos] built {len(PARTS)} parts, {len(BONES)} bones, {len(ACTIONS)} actions in {time.time() - t0:.1f}s', flush=True)

def set_action(name):
    act, n = ACTIONS[name]
    ARM.animation_data.action = act
    try:
        if act.slots:
            ARM.animation_data.action_slot = act.slots[0]
    except Exception:
        pass
    scene.frame_start = 1; scene.frame_end = n
    return n

# ================================================================ CAMERA / RENDER
cam_d = bpy.data.cameras.new('cam'); cam_d.type = 'ORTHO'; cam_d.ortho_scale = ORTHO
cam_d.clip_start = 0.1; cam_d.clip_end = 100
cam = bpy.data.objects.new('cam', cam_d); COL.objects.link(cam)
cam.location = CAM_TARGET - CAM_D * 30.0
cam.rotation_euler = (math.radians(90) - ELEV, 0, 0)
scene.camera = cam
r = scene.render
r.engine = 'BLENDER_EEVEE'
r.resolution_x = r.resolution_y = CELL * SUP; r.resolution_percentage = 100
r.film_transparent = True
r.image_settings.file_format = 'PNG'; r.image_settings.color_mode = 'RGBA'; r.image_settings.color_depth = '8'
r.image_settings.compression = 15
scene.view_settings.view_transform = 'Standard'; scene.view_settings.look = 'None'
scene.display_settings.display_device = 'sRGB'
scene.render.fps = 24
scene.render.dither_intensity = 0.0
e = scene.eevee
e.taa_render_samples = SAMPLES
for attr, val in (('use_shadows', False), ('use_raytracing', False), ('use_gtao', False)):
    if hasattr(e, attr):
        setattr(e, attr, val)
w = bpy.data.worlds.new('w'); w.use_nodes = True
w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.0
scene.world = w

if SAVE:
    ARM.animation_data.action = ACTIONS['idle'][0] if 'idle' in ACTIONS else None
    # libraries.write, not wm.save_as_mainfile: the operator stores its last-used directory (a local home path) in the file
    ids = {scene, ARM, cam, *bpy.data.objects, *bpy.data.actions, *bpy.data.materials, *bpy.data.worlds}
    bpy.data.libraries.write(SAVE, ids, fake_user=False, compress=True)
    print('[talos] saved', SAVE, flush=True)

def glow_layer(on):
    """eye-glow layer: every non-glow material becomes a holdout (keeps occlusion), glow materials stay"""
    for m in bpy.data.materials:
        if m.name in GLOW_MATS or not m.use_nodes:
            continue
        N = m.node_tree.nodes; L = m.node_tree.links
        out = next(n for n in N if n.type == 'OUTPUT_MATERIAL')
        if on:
            ho = N.get('HOLD') or N.new('ShaderNodeHoldout'); ho.name = 'HOLD'
            m['_src'] = out.inputs['Surface'].links[0].from_node.name if out.inputs['Surface'].links else ''
            L.new(ho.outputs[0], out.inputs['Surface'])
        else:
            src = N.get(m.get('_src', ''))
            if src:
                L.new(src.outputs[0], out.inputs['Surface'])

# per-part ID pass: unique flat colour per part (pass_index -> R, G in steps of 16), no AA
ID_INFO = {'px_per_bu': CELL * SUP / ORTHO, 'parts': {}}
for k, (ob, bn) in enumerate(PARTS, start=1):
    ob.pass_index = k
    ID_INFO['parts'][k] = {'name': ob.name, 'lw': ob.get('lw', 0.0)}
M_ID = bpy.data.materials.new('id_pass'); N, L = _clear(M_ID)
oi = N.new('ShaderNodeObjectInfo'); out = N.new('ShaderNodeOutputMaterial'); em = N.new('ShaderNodeEmission')
def mnode(op, a, b=None):
    m = N.new('ShaderNodeMath'); m.operation = op
    if isinstance(a, float): m.inputs[0].default_value = a
    else: L.new(a, m.inputs[0])
    if b is not None:
        if isinstance(b, float): m.inputs[1].default_value = b
        else: L.new(b, m.inputs[1])
    return m.outputs[0]
idx = oi.outputs['Object Index']
rr = mnode('POWER', mnode('DIVIDE', mnode('ADD', mnode('MULTIPLY', mnode('MODULO', idx, 16.0), 16.0), 8.0), 255.0), 2.2)
gg = mnode('POWER', mnode('DIVIDE', mnode('ADD', mnode('MULTIPLY', mnode('FLOOR', mnode('DIVIDE', idx, 16.0)), 16.0), 8.0), 255.0), 2.2)
cc = N.new('ShaderNodeCombineXYZ'); L.new(rr, cc.inputs[0]); L.new(gg, cc.inputs[1])
L.new(cc.outputs[0], em.inputs['Color']); L.new(em.outputs['Emission'], out.inputs['Surface'])

def id_pass(on):
    vl = bpy.context.view_layer
    vl.material_override = M_ID if on else None
    scene.eevee.taa_render_samples = 1 if on else SAMPLES
    scene.render.filter_size = 0.0 if on else 1.5

def hide_objects(prefixes, on):
    """a clip's `hide` list: objects whose name starts with a prefix are left out of the render (and its ID pass) while the clip renders"""
    if not prefixes:
        return
    n = 0
    for ob in bpy.data.objects:
        if ob.name.startswith(tuple(prefixes)):
            ob.hide_render = on
            n += 1
    print(f'[talos] {"hid" if on else "restored"} {n} objects {prefixes}', flush=True)

def render_clip(name, outdir, layer=None):
    n = set_action(name)
    os.makedirs(outdir, exist_ok=True)
    for f in os.listdir(outdir):
        if f.endswith('.png'):
            os.remove(os.path.join(outdir, f))
    t = time.time()
    for i in range(n):
        scene.frame_set(i + 1)
        r.filepath = os.path.join(outdir, f'{i + 1:04d}.png')
        bpy.ops.render.render(write_still=True)
        if layer is None:
            id_pass(True)
            r.filepath = os.path.join(outdir, 'id', f'{i + 1:04d}.png')
            bpy.ops.render.render(write_still=True)
            id_pass(False)
    print(f'[talos] {name}{"/" + layer if layer else ""}: {n} frames {time.time() - t:.1f}s', flush=True)

os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, 'ids.json'), 'w') as fh:
    json.dump(ID_INFO, fh, indent=1)
_o = Vector((0, 0, 0)) - CAM_TARGET
ORIGIN_PX = [round(CELL / 2 + _o.dot(CAM_R) * CELL / ORTHO, 2), round(CELL / 2 - _o.dot(CAM_U) * CELL / ORTHO, 2)]   # ground under the torso, in cell px
meta = {'cell': CELL, 'super': SUP, 'fps': 24, 'ortho': ORTHO, 'elev_deg': math.degrees(ELEV), 'yaw_deg': math.degrees(YAW),
        'origin_px': ORIGIN_PX, 'clips': {}}
if RENDER in ('stills', 'all'):
    for nm in TC.STILLS:
        render_clip(nm, os.path.join(OUT, 'stills-raw', nm))
if RENDER in ('clips', 'all'):
    for nm, (n, loop, fn, extra) in TC.CLIPS.items():
        if CLIP_SEL and nm not in CLIP_SEL:
            continue
        hide_objects(extra.get('hide', []), True)
        render_clip(nm, os.path.join(OUT, 'raw', nm))
        meta['clips'][nm] = dict({'frames': n, 'loop': loop}, **extra)
        if nm == 'talking':
            meta['clips'][nm]['amplitude'] = [round(TC.talk_amp(i, n), 4) for i in range(n)]
        if 'glow' in extra.get('layers', []):
            glow_layer(True)
            render_clip(nm, os.path.join(OUT, 'raw', nm + '-glow'), 'glow')
            glow_layer(False)
        hide_objects(extra.get('hide', []), False)
    with open(os.path.join(OUT, 'meta.json'), 'w') as fh:
        json.dump(meta, fh, indent=1)
print(f'[talos] done {time.time() - t0:.1f}s', flush=True)
