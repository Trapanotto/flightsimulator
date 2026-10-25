"""
Procedural aircraft geometry (Blender 5.x, bpy), shared by every aircraft type.

Coordinates (Blender): Y = backwards (nose at -Y), Z = up, metres, origin = the aircraft's
reference point (the game places it `gearHeight` above the ground).
The aircraft faces -Y, so the pilot's LEFT wing is at +X and the RIGHT wing at -X.
glTF export turns this into +Y up and nose towards +Z.

Each type (tools/blender/types/*.py) describes its shapes with numbers and calls the builders
below; nothing is modelled by hand, so every aircraft can be regenerated and tweaked.
"""

import math

import bmesh
import bpy
from mathutils import Matrix, Vector

# ---------------------------------------------------------------------------
# Interpolation, mesh helpers
# ---------------------------------------------------------------------------


def smooth_interp(keys, s, col):
    """Piecewise smoothstep interpolation of column `col` in a keyframe list sorted by [0]."""
    if s <= keys[0][0]:
        return keys[0][col]
    for a, b in zip(keys, keys[1:]):
        if s <= b[0]:
            t = (s - a[0]) / (b[0] - a[0])
            t = t * t * (3 - 2 * t)
            return a[col] + (b[col] - a[col]) * t
    return keys[-1][col]


def lerp_keys(keys, s, col):
    """Piecewise linear interpolation (planforms: straight edges stay straight)."""
    if s <= keys[0][0]:
        return keys[0][col]
    for a, b in zip(keys, keys[1:]):
        if s <= b[0]:
            t = (s - a[0]) / (b[0] - a[0])
            return a[col] + (b[col] - a[col]) * t
    return keys[-1][col]


def make_object(name, verts, faces, collection, material=None, smooth_angle=None):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    mesh.validate(clean_customdata=False)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    if material:
        obj.data.materials.append(material)
    for p in mesh.polygons:
        p.use_smooth = True
    if smooth_angle is not None:
        set_smooth_by_angle(obj, smooth_angle)
    return obj


def multi_material(name, groups, collection, smooth_angle=40):
    """One object from several (verts, faces, material) groups."""
    verts, faces, mats, idx = [], [], [], []
    for v, f, m in groups:
        off = len(verts)
        verts.extend(v)
        if m not in mats:
            mats.append(m)
        for face in f:
            faces.append(tuple(i + off for i in face))
            idx.append(mats.index(m))
    obj = make_object(name, verts, faces, collection, mats[0], smooth_angle)
    for m in mats[1:]:
        obj.data.materials.append(m)
    for poly, i in zip(obj.data.polygons, idx):
        poly.material_index = i
    return obj


def set_smooth_by_angle(obj, angle_deg):
    """Marks edges sharper than angle as sharp (works without operators/context)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    lim = math.radians(angle_deg)
    for e in bm.edges:
        if len(e.link_faces) == 2:
            e.smooth = e.calc_face_angle(0) < lim
        else:
            e.smooth = False
    bm.to_mesh(obj.data)
    bm.free()


def remove_loose(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()


def loft(rings, closed=True, cap_start=False, cap_end=False, skip=None):
    """Quads between consecutive rings of equal length. skip(i, j) can drop faces (openings)."""
    verts = [v for r in rings for v in r]
    n = len(rings[0])
    faces = []
    for i in range(len(rings) - 1):
        for j in range(n if closed else n - 1):
            if skip and skip(i, j):
                continue
            a = i * n + j
            b = i * n + (j + 1) % n
            c = (i + 1) * n + (j + 1) % n
            d = (i + 1) * n + j
            faces.append((a, b, c, d))
    if cap_start:
        faces.append(tuple(reversed(range(n))))
    if cap_end:
        last = (len(rings) - 1) * n
        faces.append(tuple(last + j for j in range(n)))
    return verts, faces


def mirror_x(verts, faces):
    return [(-v[0], v[1], v[2]) for v in verts], [tuple(reversed(f)) for f in faces]


def merge_parts(parts):
    verts, faces = [], []
    for v, f in parts:
        off = len(verts)
        verts.extend(v)
        faces.extend(tuple(i + off for i in face) for face in f)
    return verts, faces


def transform_part(part, matrix):
    v, f = part
    return [tuple(matrix @ Vector(p)) for p in v], f


def cosine_stations(n, cluster_ends=True):
    if cluster_ends:
        return [0.5 - 0.5 * math.cos(math.pi * i / (n - 1)) for i in range(n)]
    return [i / (n - 1) for i in range(n)]


def box(cx, cy, cz, sx, sy, sz):
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    v = [(cx + x * hx, cy + y * hy, cz + z * hz) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return v, f


def tube(points, radius, seg=8, radii=None):
    """Swept circle along a polyline, capped ends. `radii` per point overrides `radius`."""
    rings = []
    for i, p in enumerate(points):
        a = points[max(i - 1, 0)]
        b = points[min(i + 1, len(points) - 1)]
        t = (b - a).normalized()
        ref = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
        u = t.cross(ref).normalized()
        w = t.cross(u).normalized()
        r = radii[i] if radii else radius
        rings.append([tuple(p + r * (math.cos(2 * math.pi * k / seg) * u
                                     + math.sin(2 * math.pi * k / seg) * w))
                      for k in range(seg)])
    return loft(rings, cap_start=True, cap_end=True)


def flat_bar(points, width, thick):
    """Rectangular section swept along a polyline (spring-steel gear legs, struts)."""
    rings = []
    for i, p in enumerate(points):
        a = points[max(i - 1, 0)]
        b = points[min(i + 1, len(points) - 1)]
        t = (b - a).normalized()
        ref = Vector((0, 1, 0)) if abs(t.y) < 0.9 else Vector((1, 0, 0))
        u = t.cross(ref).normalized()  # across the bar (thickness)
        w = t.cross(u).normalized()    # along the width
        rings.append([tuple(p + su * thick / 2 * u + sw * width / 2 * w)
                      for su, sw in ((1, 1), (-1, 1), (-1, -1), (1, -1))])
    return loft(rings, cap_start=True, cap_end=True)


def cylinder(p0, p1, r, seg=12):
    return tube([Vector(p0), Vector(p1)], r, seg)


def lathe(profile, axis_origin, axis_dir, seg=32, cap_start=False, cap_end=False):
    """Surface of revolution: profile [(along, radius)] around an axis (nacelles, spinners)."""
    o, d = Vector(axis_origin), Vector(axis_dir).normalized()
    ref = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))
    u = d.cross(ref).normalized()
    w = d.cross(u).normalized()
    rings = []
    for along, r in profile:
        c = o + d * along
        rings.append([tuple(c + max(r, 0.0005) * (math.cos(2 * math.pi * k / seg) * w
                                                  + math.sin(2 * math.pi * k / seg) * u))
                      for k in range(seg)])
    return loft(rings, cap_start=cap_start, cap_end=cap_end)


def disc(center, normal, r, seg=32):
    c, n = Vector(center), Vector(normal).normalized()
    ref = Vector((0, 0, 1)) if abs(n.z) < 0.9 else Vector((1, 0, 0))
    u = n.cross(ref).normalized()
    w = n.cross(u).normalized()
    v = [tuple(c)] + [tuple(c + r * (math.cos(2 * math.pi * k / seg) * w
                                     + math.sin(2 * math.pi * k / seg) * u)) for k in range(seg)]
    f = [(0, 1 + k, 1 + (k + 1) % seg) for k in range(seg)]
    return v, f


def ellipsoid(center, rx, ry, rz, seg=16, rings_n=10):
    c = Vector(center)
    rings = []
    for i in range(1, rings_n):
        phi = math.pi * i / rings_n
        rings.append([(c.x + rx * math.sin(phi) * math.cos(2 * math.pi * k / seg),
                       c.y + ry * math.cos(phi),
                       c.z + rz * math.sin(phi) * math.sin(2 * math.pi * k / seg)) for k in range(seg)])
    v, f = loft(rings)
    top = len(v)
    v.append((c.x, c.y + ry, c.z))
    bot = len(v)
    v.append((c.x, c.y - ry, c.z))
    n = seg
    for k in range(n):
        f.append((top, (k + 1) % n, k))
        last = (rings_n - 2) * n
        f.append((bot, last + k, last + (k + 1) % n))
    return v, f


def move_to(obj, col):
    for c in obj.users_collection:
        c.objects.unlink(obj)
    col.objects.link(obj)


# ---------------------------------------------------------------------------
# Airfoils
# ---------------------------------------------------------------------------

def naca4(xc, m, p, t):
    """Upper and lower z/c for a NACA 4-digit airfoil at chord fraction xc (closed TE)."""
    yt = 5 * t * (0.2969 * math.sqrt(max(xc, 0)) - 0.1260 * xc - 0.3516 * xc ** 2
                  + 0.2843 * xc ** 3 - 0.1036 * xc ** 4)
    if m == 0:
        yc = 0.0
    elif xc < p:
        yc = m / p ** 2 * (2 * p * xc - xc ** 2)
    else:
        yc = m / (1 - p) ** 2 * ((1 - 2 * p) + 2 * p * xc - xc ** 2)
    return yc + yt, yc - yt


def airfoil_ring(x0, x1, n, m, p, t):
    """Closed ring of (xc, zc): upper surface x1 -> x0, then lower x0 -> x1."""
    if x0 <= 0.0:
        xs = [x1 * (1 - math.cos(0.5 * math.pi * i / (n - 1))) for i in range(n)]
    else:
        xs = [x0 + (x1 - x0) * i / (n - 1) for i in range(n)]
    upper, lower = [], []
    for xc in xs:
        u, lo = naca4(xc, m, p, t)
        upper.append((xc, u))
        lower.append((xc, lo))
    lo = lower[1:] if x0 <= 0.0 else lower
    if x1 >= 1.0:
        lo = lo[:-1]
    return list(reversed(upper)) + lo


# ---------------------------------------------------------------------------
# Fuselage with window openings
# ---------------------------------------------------------------------------

def superellipse_ring(hw, zt, zb, seg, n_exp=2.6):
    ring = []
    for j in range(seg):
        th = 2 * math.pi * j / seg  # 0 = top, clockwise seen from the front
        sx, cz = math.sin(th), math.cos(th)
        x = hw * math.copysign(abs(sx) ** (2 / n_exp), sx)
        mag = abs(cz) ** (2 / n_exp)
        z = zt * mag if cz >= 0 else zb * mag
        ring.append((x, z))
    return ring


class Fuselage:
    """
    Fuselage from cross-section keys: (s, half width, top z, bottom z, superellipse exponent),
    s = 0 at nose_y .. 1 at tail_y. Optional `centre_z` keys bend the centre line.
    """

    def __init__(self, nose_y, tail_y, keys, seg=40, stations=80):
        self.nose_y, self.tail_y = nose_y, tail_y
        self.keys, self.seg, self.n_st = keys, seg // 2 * 2, stations

    def y(self, s):
        return self.nose_y + s * (self.tail_y - self.nose_y)

    def s(self, y):
        return (y - self.nose_y) / (self.tail_y - self.nose_y)

    def profile(self, s):
        k = self.keys
        return (smooth_interp(k, s, 1), smooth_interp(k, s, 2), smooth_interp(k, s, 3),
                smooth_interp(k, s, 4) if len(k[0]) > 4 else 2.6)

    def surface_z(self, s, x, top=True):
        """Approximate skin height above/below the centre at lateral offset x."""
        hw, zt, zb, n = self.profile(s)
        r = min(1.0, abs(x) / max(hw, 1e-6))
        mag = (1 - r ** n) ** (1 / n)
        return zt * mag if top else zb * mag

    def rings(self, scale=1.0, stations=None):
        out = []
        for s in stations or cosine_stations(self.n_st):
            hw, zt, zb, n = self.profile(s)
            y = self.y(s)
            out.append([(x, y, z) for x, z in
                        superellipse_ring(hw * scale, zt * scale, zb * scale, self.seg, n)])
        return out

    def build(self, col, mat, glass_mat=None, window=None, name="Fuselage"):
        """
        Skin, plus a separate glass object for the faces where window(centre: Vector) is True.
        Returns (skin, glass or None).
        """
        rings = self.rings()
        verts, faces = loft(rings, cap_start=True, cap_end=True)
        skin_f, glass_f = [], []
        for f in faces:
            if window and len(f) == 4:
                c = sum((Vector(verts[i]) for i in f), Vector()) / 4
                if window(c):
                    glass_f.append(f)
                    continue
            skin_f.append(f)
        skin = make_object(name, verts, skin_f, col, mat, smooth_angle=60)
        remove_loose(skin)
        glass = None
        if glass_f and glass_mat:
            # Glass sits a few millimetres inside the skin line.
            gv = []
            for v in verts:
                p = Vector(v)
                s = self.s(p.y)
                _, zt, zb, _ = self.profile(s)
                cz = (zt + zb) / 2
                d = Vector((p.x, 0, p.z - cz))
                gv.append(tuple(p - d.normalized() * 0.006) if d.length > 0.01 else v)
            glass = make_object(name + "Glass", gv, glass_f, col, glass_mat)
            remove_loose(glass)
            glass.name = "Glass" if name == "Fuselage" else name + "Glass"
        return skin, glass

    def interior(self, col, mat, s0, s1, floor_z, seats=(), panel=None, window=None,
                 screen_mat=None, yokes=(), deck=None):
        """
        Cabin tub seen through the windows: inner skin (open where window(centre) is True),
        rear bulkhead, seats and instrument panel with a dark firewall below it.
        """
        st = [s0 + (s1 - s0) * t for t in cosine_stations(16)]
        rings = []
        for s in st:
            hw, zt, zb, n = self.profile(s)
            y = self.y(s)
            rings.append([(x, y, max(z, floor_z)) for x, z in
                          superellipse_ring(hw * 0.96, zt * 0.96, zb * 0.96, self.seg, n)])
        v, f = loft(rings)
        if window:
            # Faces under a window would hide the view out: test them at the skin position.
            keep = []
            for face in f:
                c = sum((Vector(v[i]) for i in face), Vector()) / len(face)
                outer = Vector((c.x / 0.96, c.y, c.z / 0.96))
                if not window(outer):
                    keep.append(face)
            f = keep
        n = self.seg
        last = (len(rings) - 1) * n
        f.append(tuple(reversed(range(last, last + n))))  # rear bulkhead
        parts = [(v, [tuple(reversed(face)) for face in f])]
        for (x, y, lift) in seats:
            parts.append(box(x, y + 0.22, floor_z + 0.24 + lift, 0.44, 0.46, 0.10))  # cushion
            parts.append(box(x, y + 0.47, floor_z + 0.56 + lift, 0.44, 0.10, 0.58))  # back
            parts.append(box(x, y + 0.48, floor_z + 0.92 + lift, 0.24, 0.10, 0.15))  # headrest
        if panel:
            y, z, w, h = panel
            parts.append(box(0, y, z, w, 0.10, h))
            low = z - h / 2
            parts.append(box(0, y - 0.04, (floor_z + low) / 2, w, 0.04, low - floor_z))  # firewall
            parts.append(box(0, y + 0.08, z + h / 2 + 0.015, w * 1.02, 0.22, 0.03))  # glare shield
        if deck:
            # Dark deck under the windshield: closes the view into the nose from inside.
            y0, y1, dz = deck
            hw = self.profile(self.s((y0 + y1) / 2))[0]
            parts.append(box(0, (y0 + y1) / 2, dz, hw * 1.9, abs(y1 - y0), 0.02))
        for (x, y, z) in yokes:
            parts.append(cylinder((x, y - 0.25, z), (x, y, z), 0.02, 8))                # shaft
            parts.append(box(x, y, z, 0.30, 0.03, 0.05))                                # horns
            parts.append(box(x - 0.14, y, z + 0.06, 0.03, 0.03, 0.12))
            parts.append(box(x + 0.14, y, z + 0.06, 0.03, 0.03, 0.12))
        v, f = merge_parts(parts)
        cabin = make_object("Cabin", v, f, col, mat, smooth_angle=30)
        if panel and screen_mat:
            # Two flat displays on the panel face (glass cockpit), slightly proud of it.
            y, z, w, h = panel
            sv = [box(cx, y + 0.052, z + 0.02, w * 0.36, 0.006, h * 0.62)
                  for cx in (-w * 0.22, w * 0.22)]
            make_object("Screens", *merge_parts(sv), col, screen_mat, smooth_angle=30)
        return cabin


# ---------------------------------------------------------------------------
# Lifting surfaces (wings, stabilisers, fins, winglets)
# ---------------------------------------------------------------------------

class Surface:
    """
    A lifting surface for the right half (+X, pilot's left; mirrored for the other side).
    planform: [(b, chord, le_y)] with b = 0 root .. 1 tip, linear in between.
    Placement: root at (root_x, root_z); spanwise direction tilted by dihedral (or, for
    vertical surfaces, `vertical=True` and `cant_deg` from vertical).
    """

    def __init__(self, planform, half_span, root_z, root_x=0.0, dihedral_deg=0.0, twist_deg=0.0,
                 airfoil=(0.02, 0.4, 0.12), vertical=False, cant_deg=0.0):
        self.planform, self.half_span = planform, half_span
        self.root_x, self.root_z = root_x, root_z
        self.dihedral = math.radians(dihedral_deg)
        self.twist = math.radians(twist_deg)
        self.airfoil = airfoil
        self.vertical, self.cant = vertical, math.radians(cant_deg)

    def chord(self, b):
        return lerp_keys(self.planform, b, 1)

    def le_y(self, b):
        return lerp_keys(self.planform, b, 2)

    def span_point(self, b):
        """Point of the chord plane at span fraction b (x, z) and the thickness direction."""
        d = b * self.half_span
        if self.vertical:
            x = self.root_x + d * math.sin(self.cant)
            z = self.root_z + d * math.cos(self.cant)
            thick = Vector((math.cos(self.cant), 0, -math.sin(self.cant)))
        else:
            x = self.root_x + d * math.cos(self.dihedral)
            z = self.root_z + d * math.sin(self.dihedral)
            thick = Vector((-math.sin(self.dihedral), 0, math.cos(self.dihedral)))
        return x, z, thick

    def section(self, b, ring, thickness_scale=1.0, chord_scale=1.0):
        c = self.chord(b)
        y_le = self.le_y(b)
        x0, z0, thick = self.span_point(b)
        tw = self.twist * b
        yq = y_le + 0.25 * c
        pts = []
        for xc, zc in ring:
            xc2 = 0.5 + (xc - 0.5) * chord_scale
            dy = y_le + xc2 * c - yq
            dt = zc * c * thickness_scale
            # Twist about the quarter chord, nose down for negative twist.
            dy, dt = dy * math.cos(tw) - dt * math.sin(tw), dy * math.sin(tw) + dt * math.cos(tw)
            p = Vector((x0, yq + dy, z0)) + thick * dt
            pts.append(tuple(p))
        return pts

    def piece(self, b0, b1, x0, x1, n_chord, n_span=3, tip=False, root_cap=True):
        m, p, t = self.airfoil
        ring = airfoil_ring(x0, x1, n_chord, m, p, t)
        rings = []
        if tip:
            prof = [(1.0, 1.0), (0.93, 0.98), (0.75, 0.93), (0.45, 0.82), (0.12, 0.62)]
            for k, (ts, cs) in zip((0, 0.35, 0.65, 0.88, 1.0), prof):
                rings.append(self.section(b0 + (b1 - b0) * k, ring, ts, cs))
        else:
            for i in range(n_span):
                rings.append(self.section(b0 + (b1 - b0) * i / (n_span - 1), ring))
        return loft(rings, cap_start=root_cap, cap_end=True)

    def hinge(self, b0, b1, xc):
        return [Vector(self.section(b, [(xc, 0.0)])[0]) for b in (b0, b1)]


def build_surface(col, mat, surf, name, controls=(), res=1.0, mirror=True, tip=True, n_chord=28,
                  hinge_xc=0.74, breaks=()):
    """
    Fixed part + control surfaces. controls: [(Name, b0, b1)] cut at hinge_xc.
    Returns {name: obj}; mirrored objects get _L (+X) / _R (-X) suffixes.
    """
    nc = int(n_chord * res)
    edges = sorted({0.0, 1.0, *breaks, *[c[1] for c in controls], *[c[2] for c in controls]})
    pieces = []
    tip_b = 0.94 if tip else 1.0
    for a, b in zip(edges, edges[1:]):
        b_end = min(b, tip_b)
        if b_end <= a:
            continue
        covered = any(c[1] <= a + 1e-6 and b <= c[2] + 1e-6 for c in controls)
        n_span = max(2, int(3 + 6 * (b_end - a)))
        pieces.append(surf.piece(a, b_end, 0.0, hinge_xc - 0.01 if covered else 1.0, nc, n_span))
    if tip:
        pieces.append(surf.piece(tip_b, 1.0, 0.0, 1.0, nc, tip=True))
    base_v, base_f = merge_parts(pieces)
    objs = {}
    sides = ((1, "_L"), (-1, "_R")) if mirror else ((1, ""),)
    for side, suffix in sides:
        v, f = (base_v, base_f) if side == 1 else mirror_x(base_v, base_f)
        objs[name + suffix] = make_object(name + suffix, v, f, col, mat, smooth_angle=35)
        for cname, b0, b1 in controls:
            cv, cf = surf.piece(b0 + 0.004, b1 - 0.004, hinge_xc, 1.0, max(6, nc // 4), 3)
            axis = surf.hinge(b0 + 0.004, b1 - 0.004, hinge_xc + 0.005)
            if side == -1:
                cv, cf = mirror_x(cv, cf)
                axis = [Vector((-a.x, a.y, a.z)) for a in axis]
            o = make_object(cname + suffix, cv, cf, col, mat, smooth_angle=35)
            o["hinge"] = [list(axis[0]), list(axis[1])]
            objs[o.name] = o
    return objs


def merge_into(objs, names, new_name, col):
    """Joins several objects of the same material into one (keeps the first's material)."""
    parts = []
    for n in names:
        o = objs.pop(n)
        v = [tuple(o.matrix_world @ vv.co) for vv in o.data.vertices]
        f = [tuple(p.vertices) for p in o.data.polygons]
        parts.append((v, f))
        mat = o.data.materials[0]
        bpy.data.objects.remove(o)
    v, f = merge_parts(parts)
    obj = make_object(new_name, v, f, col, mat, smooth_angle=35)
    objs[new_name] = obj
    return obj


# ---------------------------------------------------------------------------
# Propellers, spinners, turbofans
# ---------------------------------------------------------------------------

def spinner(col, mat, center, radius, length, name="Spinner", seg=32):
    c = Vector(center)
    prof = []
    for t in cosine_stations(14):
        r = radius * (1 - (1 - t) ** 2) ** 0.55
        prof.append((t * length, max(r, 0.002)))
    v, f = lathe(prof, c - Vector((0, length, 0)), (0, 1, 0), seg, cap_end=True)
    return make_object(name, v, f, col, mat)


def propeller(col, blade_mat, tip_mat, center, radius, blades=3, pitch=2.0, root_r=0.12,
              chord=0.18, name="Propeller", res=1.0, spin_dir=1):
    """Twisted blades around the -Y flight axis, tips painted with tip_mat."""
    c0 = Vector(center)
    nc = int(12 * res)
    ring = airfoil_ring(0.0, 1.0, nc, 0.04, 0.4, 0.09)
    tip_paint = radius - 0.11
    rs = [root_r, root_r + 0.06] + [root_r + (radius - root_r) * k for k in (0.25, 0.45, 0.65, 0.8)]
    rs += [tip_paint, radius - 0.06, radius - 0.025, radius - 0.004]
    rs = sorted(set(round(r, 4) for r in rs))

    def ch(r):
        t = (r - root_r) / (radius - root_r)
        return chord * (0.62 + 1.4 * t - 1.5 * t * t) * (0.35 + 0.65 * min(1, (radius - r) / 0.08))

    def section(r):
        c = ch(r)
        beta = math.atan(pitch / (2 * math.pi * r)) * spin_dir
        cd = Vector((math.cos(beta), -math.sin(beta), 0))
        nd = Vector((math.sin(beta), math.cos(beta), 0))
        return [tuple(c0 + Vector((0, 0, r)) + cd * (xc - 0.4) * c + nd * zc * c) for xc, zc in ring]

    split = rs.index(round(tip_paint, 4))
    inner = loft([section(r) for r in rs[: split + 1]], cap_start=True)
    outer = loft([section(r) for r in rs[split:]], cap_end=True)
    bparts, tparts = [], []
    for k in range(blades):
        rot = Matrix.Rotation(2 * math.pi / blades * k, 3, "Y")
        for parts, (v, f) in ((bparts, inner), (tparts, outer)):
            parts.append(([tuple(rot @ (Vector(p) - c0) + c0) for p in v], f))
    obj = multi_material(name, [(*merge_parts(bparts), blade_mat), (*merge_parts(tparts), tip_mat)],
                         col, smooth_angle=50)
    obj["spin_center"] = list(c0)
    return obj


def prop_disc(col, mat, center, radius, name="PropDisc"):
    v, f = disc(Vector(center) - Vector((0, 0.02, 0)), (0, -1, 0), radius, 48)
    o = make_object(name, v, f, col, mat)
    o["spin_center"] = list(center)
    return o


def turbofan(col, skin_mat, dark_mat, metal_mat, front, length, radius, name="Engine", fan_name="Fan",
             res=1.0, cowl_keys=None):
    """
    Podded turbofan along +Y from `front`: nacelle skin (lathe), dark intake lip and fan face
    (separate spinning Fan object with blades), exhaust cone.
    """
    f0 = Vector(front)
    seg = int(36 * res)
    keys = cowl_keys or [(0.0, 0.86), (0.02, 0.97), (0.07, 1.0), (0.45, 0.99), (0.8, 0.86), (1.0, 0.70)]
    outer = [(t * length, radius * k) for t, k in keys]
    lip = [(0.0, radius * 0.86), (0.0, radius * 0.78), (0.10 * length, radius * 0.80)]
    nacelle = lathe(outer, f0, (0, 1, 0), seg)
    inner = lathe(list(reversed(lip)), f0, (0, 1, 0), seg)
    nv, nf = nacelle
    skin = make_object(name, nv, nf, col, skin_mat, smooth_angle=50)
    iv, iff = inner
    intake = make_object(name + "Intake", iv, iff, col, dark_mat, smooth_angle=50)
    # Exhaust: dark core ring and a metal cone.
    core = lathe([(length, radius * 0.70), (length - 0.02, radius * 0.52)], f0, (0, 1, 0), seg)
    cone = lathe([(length - 0.05, radius * 0.45), (length + radius * 0.6, radius * 0.25),
                  (length + radius * 1.1, 0.002)], f0, (0, 1, 0), seg)
    ex = multi_material(name + "Exhaust", [(*core, dark_mat), (*cone, metal_mat)], col)
    # Fan: hub cone + flat blades, spins about the flight axis.
    fan_c = f0 + Vector((0, 0.10 * length, 0))
    hub = lathe([(-radius * 0.25, 0.002), (0.0, radius * 0.28), (0.04, radius * 0.28)], fan_c, (0, 1, 0), 24)
    blades = []
    nb = 22
    for k in range(nb):
        a = 2 * math.pi * k / nb
        r0, r1 = radius * 0.27, radius * 0.78
        tw = 0.6
        pts = []
        for r, tw_k in ((r0, 1.0), (r1, 0.55)):
            ca, sa = math.cos(a), math.sin(a)
            radial = Vector((sa, 0, ca))
            tang = Vector((ca, 0, -sa))
            for s in (-1, 1):
                pts.append(tuple(fan_c + radial * r + tang * s * radius * 0.07
                                 + Vector((0, s * radius * 0.06 * tw * tw_k, 0))))
        blades.append((pts, [(0, 1, 3, 2), (2, 3, 1, 0)]))
    fan = multi_material(fan_name, [(*hub, metal_mat), (*merge_parts(blades), dark_mat)], col)
    fan["spin_center"] = list(fan_c)
    return [skin, intake, ex, fan]


def pylon(col, mat, top_front, bottom_front, length, width, name="Pylon"):
    """Swept slab between wing and nacelle."""
    a, b = Vector(top_front), Vector(bottom_front)
    v = []
    for p, l in ((a, length), (b, length * 0.8)):
        for dy in (0, l):
            for dx in (-width / 2, width / 2):
                v.append(tuple(p + Vector((dx, dy, 0))))
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return make_object(name, v, f, col, mat, smooth_angle=30)


# ---------------------------------------------------------------------------
# Landing gear
# ---------------------------------------------------------------------------

def wheel(center, r_out, width, seg=20):
    """Tyre around the X axis plus a hub."""
    c = Vector(center)
    tube_r = width / 2
    major = r_out - tube_r
    rings = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        ring = []
        for k in range(10):
            b = 2 * math.pi * k / 10
            rr = major + tube_r * math.cos(b)
            ring.append((c.x + tube_r * math.sin(b) * 1.1, c.y + rr * math.sin(a), c.z + rr * math.cos(a)))
        rings.append(ring)
    tyre = loft(rings + [rings[0]], closed=True)
    hub = cylinder(c - Vector((width * 0.42, 0, 0)), c + Vector((width * 0.42, 0, 0)), major * 0.75, 16)
    return tyre, hub


def gear_leg(col, tire_mat, metal_mat, name, top, axles, r, w, hinge_dir=None, extra_metal=(),
             strut_r=0.06, bogie=False):
    """
    One gear leg: oleo from `top` to the axle line, one or more wheels.
    hinge_dir: (dx, dy, dz) folding axis through `top` (None = fixed gear).
    """
    top = Vector(top)
    axles = [Vector(a) for a in axles]
    centre = sum(axles, Vector()) / len(axles)
    metal = [cylinder(top, centre + Vector((0, 0, r * 0.9)), strut_r),
             cylinder(centre + Vector((0, 0, r * 0.9)), centre + Vector((0, 0, r * 0.2)), strut_r * 0.75)]
    if bogie and len(axles) > 1:
        ys = [a.y for a in axles]
        metal.append(cylinder(Vector((centre.x, min(ys), centre.z)), Vector((centre.x, max(ys), centre.z)),
                              strut_r * 0.7))
    xs = sorted({round(a.x, 3) for a in axles})
    if len(xs) > 1:
        for y in sorted({round(a.y, 3) for a in axles}):
            metal.append(cylinder(Vector((xs[0], y, centre.z)), Vector((xs[-1], y, centre.z)), strut_r * 0.5))
    tyres = []
    for a in axles:
        t, hub = wheel(a, r, w)
        tyres.append(t)
        metal.append(hub)
    metal.extend(extra_metal)
    obj = multi_material(name, [(*merge_parts(tyres), tire_mat), (*merge_parts(metal), metal_mat)], col)
    if hinge_dir:
        obj["hinge"] = [list(top), list(top + Vector(hinge_dir))]
    return obj


def wheel_fairing(center, length, width, height):
    """Teardrop 'speed pant' around a fixed-gear wheel."""
    c = Vector(center)
    prof = []
    for t in cosine_stations(14):
        y = -0.42 * length + t * length
        k = math.sin(math.pi * min(1, t * 1.25)) ** 0.6 if t < 0.8 else (1 - (t - 0.8) / 0.2) ** 0.8 * 0.95
        prof.append((y, max(k, 0.02)))
    rings = []
    seg = 20
    for y, k in prof:
        rings.append([(c.x + width / 2 * k * math.sin(2 * math.pi * j / seg), c.y + y,
                       c.z + height / 2 * k * math.cos(2 * math.pi * j / seg)) for j in range(seg)])
    return loft(rings, cap_start=True, cap_end=True)


# ---------------------------------------------------------------------------
# Lights
# ---------------------------------------------------------------------------

def light(col, name, mat, location, radius=0.045):
    v, f = ellipsoid(location, radius, radius * 1.6, radius, 12, 8)
    return make_object(name, v, f, col, mat)
