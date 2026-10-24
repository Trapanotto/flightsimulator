"""
Trapanotto TR-1 "Alpenfalke" – procedural geometry (Blender 5.x, bpy).

Coordinates (Blender): Y = backwards (nose at -Y), Z = up, metres.
The aircraft faces -Y, so the pilot's LEFT wing is at +X and the RIGHT wing at -X.
glTF export turns this into +Y up and nose towards +Z.

Every part is built from numbers in this file, so the model can be regenerated
and tweaked without touching a .blend file.
"""

import math

import bmesh
import bpy
from mathutils import Matrix, Vector

# ---------------------------------------------------------------------------
# Main dimensions
# ---------------------------------------------------------------------------
NOSE_Y = -5.40  # front of the cowling (spinner sits in front of it)
TAIL_Y = 5.40
FUSE_LEN = TAIL_Y - NOSE_Y
GROUND_Z = -1.53

WING = dict(root_le_y=-1.15, root_chord=2.10, tip_chord=1.00, half_span=4.55,
            sweep=0.40, dihedral_deg=6.0, root_z=-0.42, twist_deg=-2.0)
HSTAB = dict(root_le_y=3.95, root_chord=1.20, tip_chord=0.62, half_span=1.80,
             sweep=0.28, root_z=0.20)
FIN = dict(root_le_y=3.55, root_chord=1.80, tip_chord=0.80, height=1.75,
           sweep=1.15, root_z=0.30)

# Fuselage keyframes: station s (0 nose .. 1 tail) -> half width, top z, bottom z
FUSE_KEYS = [
    (0.00, 0.36, 0.30, -0.34),
    (0.04, 0.46, 0.41, -0.47),
    (0.12, 0.52, 0.47, -0.55),
    (0.25, 0.55, 0.50, -0.56),
    (0.36, 0.56, 0.52, -0.55),
    (0.50, 0.55, 0.52, -0.52),
    (0.62, 0.48, 0.50, -0.42),
    (0.78, 0.30, 0.43, -0.17),
    (0.92, 0.17, 0.38, 0.03),
    (1.00, 0.09, 0.34, 0.14),
]

# Canopy: station -> height above the fuselage top line
CANOPY_KEYS = [(0.300, 0.00), (0.335, 0.30), (0.40, 0.47), (0.47, 0.52),
               (0.56, 0.44), (0.615, 0.12), (0.63, 0.00)]
COCKPIT_S = (0.315, 0.615)  # opening in the fuselage under the canopy


def smooth_interp(keys, s, col):
    """Piecewise smoothstep interpolation of column `col` in keyframe list."""
    if s <= keys[0][0]:
        return keys[0][col]
    for a, b in zip(keys, keys[1:]):
        if s <= b[0]:
            t = (s - a[0]) / (b[0] - a[0])
            t = t * t * (3 - 2 * t)
            return a[col] + (b[col] - a[col]) * t
    return keys[-1][col]


def fuse_profile(s):
    return (smooth_interp(FUSE_KEYS, s, 1), smooth_interp(FUSE_KEYS, s, 2),
            smooth_interp(FUSE_KEYS, s, 3))


def station_y(s):
    return NOSE_Y + s * FUSE_LEN


def y_to_station(y):
    return (y - NOSE_Y) / FUSE_LEN


# ---------------------------------------------------------------------------
# Mesh helpers
# ---------------------------------------------------------------------------

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


def cosine_stations(n, cluster_ends=True):
    if cluster_ends:
        return [0.5 - 0.5 * math.cos(math.pi * i / (n - 1)) for i in range(n)]
    return [i / (n - 1) for i in range(n)]


# ---------------------------------------------------------------------------
# Airfoils
# ---------------------------------------------------------------------------

def naca4(xc, m, p, t):
    """Upper and lower z/c for NACA 4-digit airfoil at chord fraction xc."""
    yt = 5 * t * (0.2969 * math.sqrt(max(xc, 0)) - 0.1260 * xc - 0.3516 * xc ** 2
                  + 0.2843 * xc ** 3 - 0.1036 * xc ** 4)  # closed trailing edge
    if m == 0:
        yc = 0.0
    elif xc < p:
        yc = m / p ** 2 * (2 * p * xc - xc ** 2)
    else:
        yc = m / (1 - p) ** 2 * ((1 - 2 * p) + 2 * p * xc - xc ** 2)
    return yc + yt, yc - yt


def airfoil_ring(x0, x1, n, m, p, t, thickness_scale=1.0):
    """Closed ring of (xc, zc): upper surface x1 -> x0, then lower x0 -> x1."""
    if x0 <= 0.0:
        xs = [x1 * (1 - math.cos(0.5 * math.pi * i / (n - 1))) for i in range(n)]
    else:
        xs = [x0 + (x1 - x0) * i / (n - 1) for i in range(n)]
    upper = []
    lower = []
    for xc in xs:
        u, lo = naca4(xc, m, p, t)
        mid = (u + lo) / 2
        upper.append((xc, mid + (u - mid) * thickness_scale))
        lower.append((xc, mid + (lo - mid) * thickness_scale))
    # Drop points shared by upper and lower surface: the leading edge (x0 = 0)
    # and a closed trailing edge (x1 = 1).
    lo = lower[1:] if x0 <= 0.0 else lower
    if x1 >= 1.0:
        lo = lo[:-1]
    return list(reversed(upper)) + lo


# ---------------------------------------------------------------------------
# Fuselage, canopy, cockpit
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


def build_fuselage(col, mat, res=1.0):
    seg = int(32 * res) // 2 * 2
    n_st = int(64 * res)
    stations = cosine_stations(n_st)
    rings = []
    meta = []
    for s in stations:
        hw, zt, zb = fuse_profile(s)
        y = station_y(s)
        ring = [(x, y, z) for x, z in superellipse_ring(hw, zt, zb, seg)]
        rings.append(ring)
        meta.append(s)

    top = opening_skip(seg)

    def skip(i, j):
        # Cockpit opening: top faces between the canopy rails.
        s = (meta[i] + meta[i + 1]) / 2
        return COCKPIT_S[0] < s < COCKPIT_S[1] and top(j)

    verts, faces = loft(rings, cap_start=True, cap_end=True, skip=skip)
    return make_object("Fuselage", verts, faces, col, mat, smooth_angle=60)


def canopy_height(s):
    return smooth_interp(CANOPY_KEYS, s, 1)


def canopy_halfwidth(s):
    hw, _, _ = fuse_profile(s)
    return hw * 0.78


def build_canopy(col, glass, frame_mat, res=1.0):
    seg = int(24 * res)
    st = [COCKPIT_S[0] - 0.02 + (COCKPIT_S[1] - COCKPIT_S[0] + 0.035) * t
          for t in cosine_stations(int(36 * res))]
    rings = []
    for s in st:
        _, zt, _ = fuse_profile(s)
        h = max(canopy_height(s), 0.004)
        w = canopy_halfwidth(s)
        base = zt - 0.04
        y = station_y(s)
        ring = []
        for j in range(seg + 1):
            a = math.pi * j / seg  # 0 = right sill, pi = left sill
            ring.append((w * math.cos(a), y, base + (h + 0.04) * math.sin(a) ** 0.8))
        rings.append(ring)
    verts, faces = loft(rings, closed=False)
    glass_obj = make_object("Canopy", verts, faces, col, glass)

    # Frame: windshield arch, middle arch, sill rails.
    frame_parts = []
    for s in (0.343, 0.468, 0.60):
        _, zt, _ = fuse_profile(s)
        h = canopy_height(s)
        w = canopy_halfwidth(s)
        base = zt - 0.04
        pts = [Vector((w * math.cos(math.pi * j / 20) * 1.01, station_y(s),
                       base + (h + 0.04) * math.sin(math.pi * j / 20) ** 0.8 + 0.006))
               for j in range(21)]
        frame_parts.append(tube(pts, 0.022))
    for side in (1, -1):
        pts = []
        for t in cosine_stations(16):
            s = COCKPIT_S[0] + (COCKPIT_S[1] - COCKPIT_S[0]) * t
            _, zt, _ = fuse_profile(s)
            pts.append(Vector((side * canopy_halfwidth(s) * 1.01, station_y(s), zt - 0.03)))
        frame_parts.append(tube(pts, 0.025))
    v, f = merge_parts(frame_parts)
    frame_obj = make_object("CanopyFrame", v, f, col, frame_mat)
    return glass_obj, frame_obj


def tube(points, radius, seg=8):
    """Simple swept circle along a polyline, open ends."""
    rings = []
    for i, p in enumerate(points):
        a = points[max(i - 1, 0)]
        b = points[min(i + 1, len(points) - 1)]
        t = (b - a).normalized()
        ref = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
        u = t.cross(ref).normalized()
        w = t.cross(u).normalized()
        rings.append([tuple(p + radius * (math.cos(2 * math.pi * k / seg) * u
                                          + math.sin(2 * math.pi * k / seg) * w))
                      for k in range(seg)])
    return loft(rings, cap_start=True, cap_end=True)


def merge_parts(parts):
    verts, faces = [], []
    for v, f in parts:
        off = len(verts)
        verts.extend(v)
        faces.extend(tuple(i + off for i in face) for face in f)
    return verts, faces


def box(cx, cy, cz, sx, sy, sz):
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    v = [(cx + x * hx, cy + y * hy, cz + z * hz)
         for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return v, f


def opening_skip(seg):
    """Faces of the top quarter of a fuselage ring that form the cockpit opening."""
    top_span = max(2, seg // 8)

    def skip(j):
        jj = j if j < seg // 2 else j - seg
        return -top_span <= jj < top_span

    return skip


def build_cockpit(col, interior, res=1.0):
    """Inner skin under the canopy (follows the fuselage shape), seats, panels, sticks."""
    seg = int(32 * res) // 2 * 2
    s0, s1 = COCKPIT_S
    stations = [s0 + (s1 - s0) * t for t in cosine_stations(int(14 * res))]
    rings = []
    for s in stations:
        hw, zt, zb = fuse_profile(s)
        y = station_y(s)
        rings.append([(x, y, z) for x, z in superellipse_ring(hw * 0.97, zt * 0.97, zb * 0.55, seg)])
    top = opening_skip(seg)
    v, f = loft(rings, skip=lambda i, j: top(j))
    n = seg
    last = (len(rings) - 1) * n
    f.append(tuple(range(n)))                       # front wall
    f.append(tuple(reversed(range(last, last + n))))  # rear wall
    tub = (v, [tuple(reversed(face)) for face in f])  # visible from inside

    parts = [tub]
    for seat_y, lift in ((-1.25, 0.0), (0.0, 0.16)):
        parts.append(box(0, seat_y + 0.25, -0.18 + lift, 0.48, 0.5, 0.12))   # cushion
        parts.append(box(0, seat_y + 0.52, 0.14 + lift, 0.48, 0.12, 0.75))   # back
        parts.append(box(0, seat_y + 0.55, 0.60 + lift, 0.28, 0.14, 0.22))   # headrest
        parts.append(box(0, seat_y - 0.55, 0.30 + lift, 0.62, 0.10, 0.30))   # panel
        parts.append(box(0, seat_y - 0.50, 0.47 + lift, 0.66, 0.30, 0.05))   # glare shield
        parts.append(box(0, seat_y - 0.10, -0.02 + lift, 0.04, 0.04, 0.42))  # stick
    v, f = merge_parts(parts)
    return make_object("Cockpit", v, f, col, interior, smooth_angle=30)


# ---------------------------------------------------------------------------
# Lifting surfaces
# ---------------------------------------------------------------------------

def wing_section(b, ring, spec, thickness_scale=1.0, chord_scale=1.0):
    """Places an airfoil ring at span fraction b of the right wing."""
    c = spec["root_chord"] + (spec["tip_chord"] - spec["root_chord"]) * b
    span = b * spec["half_span"]
    y_le = spec["root_le_y"] + spec["sweep"] * b
    z0 = spec["root_z"] + span * math.tan(math.radians(spec["dihedral_deg"]))
    tw = math.radians(spec["twist_deg"] * b)
    yq = y_le + 0.25 * c
    pts = []
    for xc, zc in ring:
        # Rounded tip: shrink chord around mid chord.
        xc2 = 0.5 + (xc - 0.5) * chord_scale
        y = y_le + xc2 * c
        z = z0 + zc * c * thickness_scale
        dy, dz = y - yq, z - z0
        y = yq + dy * math.cos(tw) - dz * math.sin(tw)
        z = z0 + dy * math.sin(tw) + dz * math.cos(tw)
        pts.append((span, y, z))
    return pts


def lifting_piece(spec, b0, b1, x0, x1, section_fn, airfoil, n_chord, n_span=3, tip=False):
    m, p, t = airfoil
    ring = airfoil_ring(x0, x1, n_chord, m, p, t)
    rings = []
    bs = [b0 + (b1 - b0) * i / (n_span - 1) for i in range(n_span)]
    if tip:
        # Rounded tip: thickness and chord fade over the last sections.
        prof = [(1.0, 1.0), (0.93, 0.98), (0.75, 0.93), (0.45, 0.82), (0.12, 0.62)]
        bs = [b0 + (b1 - b0) * k for k in (0, 0.35, 0.65, 0.88, 1.0)]
        for bb, (ts, cs) in zip(bs, prof):
            rings.append(section_fn(bb, ring, spec, ts, cs))
    else:
        for bb in bs:
            rings.append(section_fn(bb, ring, spec))
    return loft(rings, cap_start=True, cap_end=True)


def hinge_axis(spec, section_fn, b0, b1, xc):
    """World-space hinge line of a control surface (start, end), at mid thickness."""
    pts = []
    for b in (b0, b1):
        ring = [(xc, 0.0)]
        pts.append(Vector(section_fn(b, ring, spec)[0]))
    return pts


def build_wing(col, mat, res=1.0):
    nc = int(28 * res)
    af = (0.02, 0.4, 0.12)
    sec = wing_section
    pieces = {
        "WingRoot": lifting_piece(WING, 0.0, 0.13, 0.0, 1.0, sec, af, nc, 2),
        "WingInner": lifting_piece(WING, 0.13, 0.56, 0.0, 0.735, sec, af, nc, 3),
        "WingOuter": lifting_piece(WING, 0.56, 0.93, 0.0, 0.735, sec, af, nc, 3),
        "WingTip": lifting_piece(WING, 0.93, 1.0, 0.0, 1.0, sec, af, nc, tip=True),
    }
    surfaces = {
        "Flap": (lifting_piece(WING, 0.135, 0.555, 0.745, 1.0, sec, af, max(6, nc // 4), 3),
                 hinge_axis(WING, sec, 0.135, 0.555, 0.75)),
        "Aileron": (lifting_piece(WING, 0.565, 0.925, 0.745, 1.0, sec, af, max(6, nc // 4), 3),
                    hinge_axis(WING, sec, 0.565, 0.925, 0.75)),
    }
    objs = {}
    v, f = merge_parts(list(pieces.values()))
    for side, suffix in ((1, "L"), (-1, "R")):
        vv, ff = (v, f) if side == 1 else mirror_x(v, f)
        objs[f"Wing_{suffix}"] = make_object(f"Wing_{suffix}", vv, ff, col, mat, smooth_angle=35)
        for name, ((sv, sf), axis) in surfaces.items():
            svv, sff = (sv, sf) if side == 1 else mirror_x(sv, sf)
            ax = axis if side == 1 else [Vector((-a.x, a.y, a.z)) for a in axis]
            o = make_object(f"{name}_{suffix}", svv, sff, col, mat, smooth_angle=35)
            o["hinge"] = [list(ax[0]), list(ax[1])]
            objs[o.name] = o
    return objs


def stab_section(b, ring, spec, thickness_scale=1.0, chord_scale=1.0):
    c = spec["root_chord"] + (spec["tip_chord"] - spec["root_chord"]) * b
    y_le = spec["root_le_y"] + spec["sweep"] * b
    return [(b * spec["half_span"], y_le + (0.5 + (xc - 0.5) * chord_scale) * c,
             spec["root_z"] + zc * c * thickness_scale) for xc, zc in ring]


def fin_section(b, ring, spec, thickness_scale=1.0, chord_scale=1.0):
    c = spec["root_chord"] + (spec["tip_chord"] - spec["root_chord"]) * b
    y_le = spec["root_le_y"] + spec["sweep"] * b
    # Thickness runs along X; the ring's zc is used as the X offset.
    return [(zc * c * thickness_scale, y_le + (0.5 + (xc - 0.5) * chord_scale) * c,
             spec["root_z"] + b * spec["height"]) for xc, zc in ring]


def build_tail(col, mat, res=1.0):
    nc = int(20 * res)
    af = (0.0, 0.4, 0.10)
    objs = {}
    # Horizontal stabiliser (both halves in one object) + two elevators.
    stab = merge_parts([lifting_piece(HSTAB, 0.0, 0.92, 0.0, 0.66, stab_section, af, nc, 3),
                        lifting_piece(HSTAB, 0.92, 1.0, 0.0, 1.0, stab_section, af, nc, tip=True)])
    sv, sf = stab
    mv, mf = mirror_x(sv, sf)
    v, f = merge_parts([(sv, sf), (mv, mf)])
    objs["HStab"] = make_object("HStab", v, f, col, mat, smooth_angle=35)
    ev, ef = lifting_piece(HSTAB, 0.05, 0.915, 0.67, 1.0, stab_section, af, max(6, nc // 3), 3)
    axis = hinge_axis(HSTAB, stab_section, 0.05, 0.915, 0.67)
    for side, suffix in ((1, "L"), (-1, "R")):
        vv, ff = (ev, ef) if side == 1 else mirror_x(ev, ef)
        ax = axis if side == 1 else [Vector((-a.x, a.y, a.z)) for a in axis]
        o = make_object(f"Elevator_{suffix}", vv, ff, col, mat, smooth_angle=35)
        o["hinge"] = [list(ax[0]), list(ax[1])]
        objs[o.name] = o
    # Fin + rudder.
    fv, ff = merge_parts([lifting_piece(FIN, 0.0, 0.94, 0.0, 0.68, fin_section, af, nc, 3),
                          lifting_piece(FIN, 0.94, 1.0, 0.0, 1.0, fin_section, af, nc, tip=True)])
    objs["Fin"] = make_object("Fin", fv, ff, col, mat, smooth_angle=35)
    rv, rf = lifting_piece(FIN, 0.04, 0.935, 0.69, 1.0, fin_section, af, max(6, nc // 3), 3)
    o = make_object("Rudder", rv, rf, col, mat, smooth_angle=35)
    o["hinge"] = [list(v) for v in hinge_axis(FIN, fin_section, 0.04, 0.935, 0.69)]
    objs["Rudder"] = o
    return objs


# ---------------------------------------------------------------------------
# Propeller, spinner
# ---------------------------------------------------------------------------
PROP_Y = -5.56
PROP_RADIUS = 1.2


def build_spinner(col, mat, res=1.0):
    seg = int(32 * res)
    rings = []
    tip_y, base_y, r_base = -6.02, NOSE_Y + 0.02, 0.33
    for t in cosine_stations(int(14 * res)):
        y = tip_y + (base_y - tip_y) * t
        r = r_base * (1 - (1 - t) ** 2) ** 0.55
        r = max(r, 0.002)
        rings.append([(r * math.sin(2 * math.pi * j / seg), y, r * math.cos(2 * math.pi * j / seg))
                      for j in range(seg)])
    v, f = loft(rings, cap_end=True)
    return make_object("Spinner", v, f, col, mat)


def build_propeller(col, blade_mat, tip_mat, res=1.0):
    """Four twisted blades, origin on the spin axis. Tips get a separate (yellow) material."""
    nc = int(12 * res)
    ring = airfoil_ring(0.0, 1.0, nc, 0.04, 0.4, 0.09)
    pitch = 2.3
    r_tip_paint = PROP_RADIUS - 0.12
    radii = [0.16, 0.25, 0.4, 0.55, 0.7, 0.85, 1.0, r_tip_paint, 1.13, 1.17, 1.195]
    chords = {0.16: 0.12, 0.25: 0.19, 0.4: 0.22, 0.55: 0.22, 0.7: 0.2, 0.85: 0.17,
              1.0: 0.14, r_tip_paint: 0.12, 1.13: 0.105, 1.17: 0.08, 1.195: 0.045}

    def section(r):
        c = chords[r]
        beta = math.atan(pitch / (2 * math.pi * r))
        cd = Vector((math.cos(beta), -math.sin(beta), 0))  # chord direction
        nd = Vector((math.sin(beta), math.cos(beta), 0))   # thickness direction
        return [tuple(Vector((0, PROP_Y, 0)) + Vector((0, 0, r)) + cd * (xc - 0.4) * c
                      + nd * zc * c) for xc, zc in ring]

    blade_parts, tip_parts = [], []
    split = radii.index(r_tip_paint)
    inner = loft([section(r) for r in radii[: split + 1]], cap_start=True)
    outer = loft([section(r) for r in radii[split:]], cap_end=True)
    for k in range(4):
        rot = Matrix.Rotation(math.pi / 2 * k, 3, "Y")
        for parts, (v, f) in ((blade_parts, inner), (tip_parts, outer)):
            vv = [tuple(rot @ (Vector(p) - Vector((0, PROP_Y, 0))) + Vector((0, PROP_Y, 0)))
                  for p in v]
            parts.append((vv, f))
    bv, bf = merge_parts(blade_parts)
    tv, tf = merge_parts(tip_parts)
    nb = len(bf)
    obj = make_object("Propeller", bv + tv, bf + [tuple(i + len(bv) for i in fc) for fc in tf],
                      col, blade_mat, smooth_angle=50)
    obj.data.materials.append(tip_mat)
    for i, poly in enumerate(obj.data.polygons):
        poly.material_index = 0 if i < nb else 1
    return obj


def build_prop_disc(col, mat):
    seg = 48
    v = [(0, PROP_Y - 0.02, 0)] + [(PROP_RADIUS * math.sin(2 * math.pi * j / seg), PROP_Y - 0.02,
                                    PROP_RADIUS * math.cos(2 * math.pi * j / seg)) for j in range(seg)]
    f = [(0, 1 + (j + 1) % seg, 1 + j) for j in range(seg)]
    return make_object("PropDisc", v, f, col, mat)


# ---------------------------------------------------------------------------
# Landing gear
# ---------------------------------------------------------------------------

def cylinder(p0, p1, r, seg=12):
    p0, p1 = Vector(p0), Vector(p1)
    return tube([p0, p1], r, seg)


def wheel(center, r_out, width, seg=20):
    """Tyre as a rounded ring around the X axis, with a hub."""
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
    verts, faces = loft(rings + [rings[0]], closed=True)
    hub = cylinder(c - Vector((width * 0.42, 0, 0)), c + Vector((width * 0.42, 0, 0)), major * 0.75, 16)
    return (verts, faces), hub


def build_gear(col, tire_mat, metal_mat):
    objs = {}
    specs = {
        "Gear_L": dict(top=(1.45, -0.20, -0.33), axle=(1.48, -0.15, -1.25), r=0.28, w=0.16),
        "Gear_R": dict(top=(-1.45, -0.20, -0.33), axle=(-1.48, -0.15, -1.25), r=0.28, w=0.16),
        "Gear_N": dict(top=(0.0, -4.30, -0.48), axle=(0.0, -4.42, -1.33), r=0.20, w=0.12),
    }
    for name, s in specs.items():
        top, axle = Vector(s["top"]), Vector(s["axle"])
        side = 1 if axle.x > 0.01 else (-1 if axle.x < -0.01 else 0)
        offset = Vector((-side * (s["w"] / 2 + 0.05), 0, 0)) if side else Vector((s["w"] / 2 + 0.05, 0, 0))
        fork = axle + offset
        mid = top.lerp(fork + Vector((0, 0, 0.25)), 0.55)
        metal = [cylinder(top, mid, 0.065), cylinder(mid, fork + Vector((0, 0, 0.12)), 0.048),
                 cylinder(fork + Vector((0, 0, 0.12)), fork, 0.035),
                 cylinder(axle - offset * 0.2, fork, 0.03)]
        if not side:  # nose: fork on both sides
            metal.append(cylinder(axle - offset, axle - offset + Vector((0, 0, 0.3)), 0.03))
            metal.append(cylinder(axle - offset, axle + offset, 0.025))
        (tv, tf), hub = wheel(axle, s["r"], s["w"])
        mv, mf = merge_parts(metal + [hub])
        obj = make_object(name, tv + mv, tf + [tuple(i + len(tv) for i in fc) for fc in mf],
                          col, tire_mat, smooth_angle=40)
        obj.data.materials.append(metal_mat)
        for i, poly in enumerate(obj.data.polygons):
            poly.material_index = 0 if i < len(tf) else 1
        # Main gear folds inwards about the flight axis, nose gear backwards about the lateral axis.
        obj["hinge"] = ([list(top), list(top + Vector((0, 1, 0)))] if side
                        else [list(top), list(top + Vector((1, 0, 0)))])
        objs[name] = obj
    return objs


# ---------------------------------------------------------------------------
# Small details
# ---------------------------------------------------------------------------

def build_details(col, metal_dark, intake_mat):
    parts = []
    for side in (1, -1):
        for dy in (0.0, 0.22):
            y = -3.95 + dy
            parts.append(cylinder((side * 0.50, y, 0.08), (side * 0.62, y + 0.12, -0.02), 0.06, 10))
    exhaust = make_object("Exhausts", *merge_parts(parts), col, metal_dark, smooth_angle=50)
    # Chin intake: dark lip under the spinner.
    v, f = box(0, NOSE_Y + 0.30, -0.43, 0.32, 0.16, 0.08)
    intake = make_object("Intake", v, f, col, intake_mat, smooth_angle=30)
    # Antenna blade behind the canopy, pitot under the left wing.
    # Swept blade antenna: a thin quad strip leaning backwards.
    av = [(-0.008, 1.72, 0.48), (-0.008, 1.95, 0.48), (-0.008, 2.06, 0.70), (-0.008, 1.94, 0.70),
          (0.008, 1.72, 0.48), (0.008, 1.95, 0.48), (0.008, 2.06, 0.70), (0.008, 1.94, 0.70)]
    af = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    pv, pf = cylinder((3.2, -0.6, -0.30), (3.2, -1.15, -0.30), 0.012, 8)  # left wing
    misc = make_object("Antenna", *merge_parts([(av, af), (pv, pf)]), col, metal_dark, smooth_angle=30)
    return [exhaust, intake, misc]


def build_lights(col, red, green, white):
    objs = []
    tip_b = 1.0
    # Red on the left wing (+X), green on the right (-X).
    for name, side, mat in (("NavLight_L", 1, red), ("NavLight_R", -1, green)):
        y = WING["root_le_y"] + WING["sweep"] * tip_b + WING["tip_chord"] * 0.35
        z = WING["root_z"] + WING["half_span"] * math.tan(math.radians(WING["dihedral_deg"]))
        bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=0.045,
                                             location=(side * (WING["half_span"] + 0.01), y, z))
        o = bpy.context.active_object
        o.name = name
        o.data.materials.append(mat)
        move_to(o, col)
        objs.append(o)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=0.04,
                                         location=(0, FIN["root_le_y"] + FIN["sweep"] + 0.45,
                                                   FIN["root_z"] + FIN["height"] + 0.02))
    o = bpy.context.active_object
    o.name = "Strobe_Tail"
    o.data.materials.append(white)
    move_to(o, col)
    objs.append(o)
    return objs


def move_to(obj, col):
    for c in obj.users_collection:
        c.objects.unlink(obj)
    col.objects.link(obj)
