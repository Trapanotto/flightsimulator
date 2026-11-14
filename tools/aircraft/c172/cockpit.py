"""
Cabin interior and the classic Cessna 172S steam-gauge panel.

Instruments: bezels, needles and markers are geometry; dial faces are discs with square UVs
that the game paints at runtime (crisp at any resolution, nothing to download). Every
instrument pivot is an empty whose extras.axis points out of the dial towards the pilot.
"""

import math

import numpy as np

from lib import mesh as M
from . import dims as D
from . import fuselage as F

TILT = math.radians(8)          # panel top leans forward
PANEL_O = np.array([0.0, D.PANEL_FS, 1.10])
VX = np.array([1.0, 0.0, 0.0])  # +BL (pilot's left)
VV = np.array([0.0, -math.sin(TILT), math.cos(TILT)])   # up the panel
VN = np.array([0.0, math.cos(TILT), math.sin(TILT)])    # out of the panel, towards the pilot
PANEL_H = 0.40
PANEL_HALF = 0.505

# Instrument layout: id -> (BL, height on the panel, visible dial radius)
GAUGES = {
    "ASI": (0.345, 0.300, 0.037), "AI": (0.250, 0.300, 0.037), "ALT": (0.155, 0.300, 0.037),
    "TC": (0.345, 0.205, 0.037), "HI": (0.250, 0.205, 0.037), "VSI": (0.155, 0.205, 0.037),
    "TACH": (0.385, 0.105, 0.033), "CDI1": (0.060, 0.300, 0.034), "CDI2": (0.060, 0.205, 0.034),
    "ADF": (0.060, 0.115, 0.034),
    "FUELL": (0.468, 0.330, 0.019), "FUELR": (0.468, 0.280, 0.019), "OILT": (0.468, 0.230, 0.019),
    "OILP": (0.468, 0.180, 0.019), "EGT": (0.468, 0.130, 0.019), "VAC": (0.468, 0.080, 0.019),
    "AMP": (0.310, 0.115, 0.019), "FF": (0.215, 0.115, 0.019), "FLAPS": (-0.215, 0.205, 0.020),
}
# Dials whose face turns (painted by the loader too, but not merged with the fixed ones).
TURNING_FACES = ("AI", "HI", "CDI1", "CDI2")


def pp(bl, v, s=0.0):
    """Point on the panel (design frame): BL, height up the panel, distance out of it."""
    return PANEL_O + VX * bl + VV * v + VN * s


def _disc(center, r, n=48, with_uv=True):
    verts = [center]
    uvs = []
    for k in range(n):
        a = 2 * math.pi * k / n
        verts.append(center + r * (-math.cos(a) * VX + math.sin(a) * VV))
    faces = [(0, 1 + k, 1 + (k + 1) % n) for k in range(n)]
    if with_uv:
        def uv(i):
            d = verts[i] - center
            # u grows to the pilot's right (-BL), v up the panel.
            return (0.5 - np.dot(d, VX) / (2 * r), 0.5 + np.dot(d, VV) / (2 * r))
        uvs = [uv(i) for f in faces for i in f]
    return np.array(verts), faces, uvs


def _flat_shape(poly, origin, s, thick=0.0008):
    """Thin plate in the panel plane from a 2D polygon (x = pilot's right, y = up)."""
    poly = np.asarray(poly, float)
    pts = []
    for z in (0.0, thick):
        for x, y in poly:
            pts.append(origin + (-x) * VX + y * VV + (s + z) * VN)
    n = len(poly)
    faces = [tuple(range(n))[::-1], tuple(range(n, 2 * n))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    return np.array(pts), faces


def _needle_poly(length, width, tail, tip="taper"):
    w = width / 2
    if tip == "arrow":
        return [(-w, -tail), (w, -tail), (w, length * 0.78), (w * 2.2, length * 0.78), (0, length),
                (-w * 2.2, length * 0.78), (-w, length * 0.78)]
    if tip == "wide":
        return [(-w * 0.6, -tail), (w * 0.6, -tail), (w, length * 0.55), (0, length), (-w, length * 0.55)]
    return [(-w, -tail), (w, -tail), (w * 0.55, length * 0.9), (0, length), (-w * 0.55, length * 0.9)]


class Builder:
    def __init__(self, col, mats, root):
        self.col, self.mats, self.root = col, mats, root
        self.static = {}   # material key -> list of (verts, faces)
        self.parts = {}

    def add(self, key, vf):
        self.static.setdefault(key, []).append(vf)

    def obj(self, name, vf, mat, parent=None, origin=None, uvs=None, sharp=40, smooth=True):
        v, f = vf
        o = M.make_object(name, v, f, self.col, self.mats[mat], smooth=smooth, sharp_angle=sharp,
                          origin=origin, uvs=uvs, recalc=uvs is None)
        M.parent_keep(o, parent or self.root)
        return o

    def pivot(self, name, at, axis_design, props=None, parent=None):
        pr = {"axis": M.model_axis(*axis_design)}
        pr.update(props or {})
        e = M.empty(name, self.col, M.P(*at), size=0.02, props=pr)
        M.parent_keep(e, parent or self.root)
        return e

    def flush(self):
        for key, items in self.static.items():
            v, f = M.merge(items)
            o = M.make_object(f"Cabin_{key}", v, f, self.col, self.mats[key], sharp_angle=40)
            M.parent_keep(o, self.root)


# ---------------------------------------------------------------------------
# Instruments
# ---------------------------------------------------------------------------

def bezel(b, gid, bl, v, r):
    c = pp(bl, v)
    prof = [(0.0, r + 0.0085), (0.006, r + 0.0083), (0.0105, r + 0.0062), (0.0118, r + 0.0025),
            (0.0112, r + 0.0004), (0.004, r), (0.0015, r)]
    b.add("gauge_bezel", M.lathe(prof, c, VN, n=40, close_start=False, close_end=False))
    # Glass over the dial (faint; reflections are what sell it).
    gv, gf, _ = _disc(c + VN * 0.0105, r + 0.0006, n=32, with_uv=False)
    b.add("gauge_glass", (gv, gf))


def face(b, gid, bl, v, r, s=0.0016, parent=None, name=None):
    c = pp(bl, v, s)
    verts, faces, uvs = _disc(c, r)
    return b.obj(name or f"Face_{gid}", (verts, faces), "gauge_face", parent=parent, origin=M.P(*c), uvs=uvs,
                 smooth=False)


def needle(b, name, bl, v, length, width, tail, s=0.006, tip="taper", mat="needle", hub=True, parent=None,
           center=None):
    c = pp(bl, v) if center is None else center
    piv = b.pivot(name, c + VN * s, VN, parent=parent)
    v_, f_ = _flat_shape(_needle_poly(length, width, tail, tip), c, s)
    parts = [(v_, f_)]
    if hub:
        parts.append(M.cylinder(c + VN * (s - 0.002), c + VN * (s + 0.0022), width * 0.9 + 0.0015, 14))
    b.obj(f"{name}_mesh", M.merge(parts), mat, parent=piv, origin=M.P(*(c + VN * s)), sharp=30)
    return piv


def instruments(b):
    for gid, (bl, v, r) in GAUGES.items():
        bezel(b, gid, bl, v, r)
        if gid not in TURNING_FACES:
            face(b, gid, bl, v, r)
    g = GAUGES
    # Single-needle dials.
    for gid, ln, w, tip in (("ASI", 0.86, 0.075, "taper"), ("VSI", 0.86, 0.075, "taper"),
                            ("TACH", 0.86, 0.075, "taper"), ("FUELL", 0.8, 0.11, "taper"),
                            ("FUELR", 0.8, 0.11, "taper"), ("OILT", 0.8, 0.11, "taper"),
                            ("OILP", 0.8, 0.11, "taper"), ("EGT", 0.8, 0.11, "taper"),
                            ("VAC", 0.8, 0.11, "taper"), ("AMP", 0.8, 0.11, "taper"),
                            ("FF", 0.8, 0.11, "taper"), ("FLAPS", 0.8, 0.11, "taper")):
        bl, v, r = g[gid]
        needle(b, f"Needle_{gid}", bl, v, ln * r, w * r, 0.18 * r, tip=tip)
    # Altimeter: 100 ft (long), 1000 ft (short, wide), 10 000 ft (thin, with a triangle).
    bl, v, r = g["ALT"]
    needle(b, "Needle_ALT10000", bl, v, 0.92 * r, 0.03 * r, 0.0, s=0.0045, tip="arrow", hub=False)
    needle(b, "Needle_ALT1000", bl, v, 0.55 * r, 0.12 * r, 0.12 * r, s=0.0058, tip="wide", hub=False)
    needle(b, "Needle_ALT100", bl, v, 0.88 * r, 0.075 * r, 0.2 * r, s=0.0071, tip="taper")
    # ADF: a long pointer over a fixed card.
    bl, v, r = g["ADF"]
    needle(b, "Needle_ADF", bl, v, 0.86 * r, 0.06 * r, 0.6 * r, tip="arrow", mat="needle_orange")
    cdi(b, "CDI1", True)
    cdi(b, "CDI2", False)
    attitude(b)
    heading(b)
    heading_bug(b)
    turn_coordinator(b)
    flag(b, "AI_Flag", "AI", -45, s=0.0052, radial=0.8)
    flag(b, "HI_Flag", "HI", 45, s=0.0055, radial=0.8)
    flag(b, "TC_Flag", "TC", -125, s=0.0045, radial=0.78)


def attitude(b):
    bl, v, r = GAUGES["AI"]
    c = pp(bl, v)
    roll = b.pivot("AI_Roll", c + VN * 0.0012, VN)
    verts, faces, uvs = _disc(c + VN * 0.0012, r * 1.02)
    b.obj("Face_AI", (verts, faces), "gauge_face", parent=roll, origin=M.P(*(c + VN * 0.0012)), uvs=uvs,
          smooth=False)
    # The pitch card: a smaller disc in front; the game slides its texture with the pitch.
    verts, faces, uvs = _disc(c + VN * 0.0028, r * 0.70)
    b.obj("AI_Pitch", (verts, faces), "ai_card", parent=roll, origin=M.P(*(c + VN * 0.0028)), uvs=uvs,
          smooth=False)
    # Fixed bank scale: marks at 10, 20, 30, 45, 60 and 90 degrees.
    for deg in (-90, -60, -45, -30, -20, -10, 10, 20, 30, 45, 60, 90):
        a = math.radians(deg)
        long_ = abs(deg) in (30, 60, 90)
        r0, r1 = r * (0.80 if long_ else 0.86), r * 0.98
        w = 0.0013 if long_ else 0.0009
        poly = np.array([(-w, r0), (w, r0), (w, r1), (-w, r1)])
        rot = np.array([[math.cos(a), math.sin(a)], [-math.sin(a), math.cos(a)]])
        b.add("needle", _flat_shape(poly @ rot.T, c, 0.0045))
    # Fixed index at the top (a white triangle) and the miniature aircraft (orange).
    b.add("needle", _flat_shape([(-0.0035, r * 0.98), (0.0035, r * 0.98), (0.0, r * 0.84)], c, 0.0045))
    wings = [(-0.62 * r, 0.006), (-0.2 * r, 0.006), (-0.12 * r, -0.008), (0.0, 0.0), (0.12 * r, -0.008),
             (0.2 * r, 0.006), (0.62 * r, 0.006), (0.62 * r, 0.0), (0.2 * r, 0.0), (0.12 * r, -0.013),
             (0.0, -0.005), (-0.12 * r, -0.013), (-0.2 * r, 0.0), (-0.62 * r, 0.0)]
    b.add("needle_orange", _flat_shape(wings, c, 0.0065, 0.0012))
    b.add("needle_orange", M.cylinder(c + VN * 0.0065, c + VN * 0.0085, 0.0022, 12))
    # Lower half of the case hides the card's bottom edge, like the real instrument's mask.
    mask = [(-r * math.cos(t), -r * math.sin(t)) for t in np.linspace(0.12, math.pi - 0.12, 18)]
    mask = [(-r * 0.99, -r * 0.72)] + [(x * 0.99, min(y * 0.99, -r * 0.72)) for x, y in mask] + [(r * 0.99, -r * 0.72)]
    b.add("gauge_bezel", _flat_shape(mask, c, 0.0040, 0.0006))


def heading(b):
    bl, v, r = GAUGES["HI"]
    c = pp(bl, v)
    card = b.pivot("HI_Card", c + VN * 0.0015, VN)
    verts, faces, uvs = _disc(c + VN * 0.0015, r)
    b.obj("Face_HI", (verts, faces), "gauge_face", parent=card, origin=M.P(*(c + VN * 0.0015)), uvs=uvs,
          smooth=False)
    # Fixed aircraft symbol and lubber marks every 45 degrees.
    plane = [(0, 0.5 * r), (0.04 * r, 0.42 * r), (0.04 * r, 0.12 * r), (0.42 * r, -0.02 * r), (0.42 * r, -0.08 * r),
             (0.04 * r, -0.04 * r), (0.04 * r, -0.32 * r), (0.15 * r, -0.42 * r), (0.15 * r, -0.47 * r),
             (0.0, -0.44 * r), (-0.15 * r, -0.47 * r), (-0.15 * r, -0.42 * r), (-0.04 * r, -0.32 * r),
             (-0.04 * r, -0.04 * r), (-0.42 * r, -0.08 * r), (-0.42 * r, -0.02 * r), (-0.04 * r, 0.12 * r),
             (-0.04 * r, 0.42 * r)]
    b.add("needle_orange", _flat_shape(plane, c, 0.005, 0.0012))
    for deg in range(0, 360, 45):
        a = math.radians(deg)
        rot = np.array([[math.cos(a), math.sin(a)], [-math.sin(a), math.cos(a)]])
        poly = np.array([(-0.003, r * 1.0), (0.003, r * 1.0), (0.0, r * 0.9)]) if deg == 0 else \
            np.array([(-0.001, r * 1.0), (0.001, r * 1.0), (0.001, r * 0.92), (-0.001, r * 0.92)])
        b.add("needle_orange" if deg == 0 else "needle", _flat_shape(poly @ rot.T, c, 0.005))


def turn_coordinator(b):
    bl, v, r = GAUGES["TC"]
    c = pp(bl, v)
    plane = [(0.0, 0.09 * r), (0.05 * r, 0.06 * r), (0.62 * r, 0.02 * r), (0.62 * r, -0.03 * r),
             (0.05 * r, -0.05 * r), (0.0, -0.08 * r), (-0.05 * r, -0.05 * r), (-0.62 * r, -0.03 * r),
             (-0.62 * r, 0.02 * r), (-0.05 * r, 0.06 * r)]
    piv = b.pivot("TC_Plane", c + VN * 0.006, VN)
    parts = [_flat_shape(plane, c, 0.006, 0.0012),
             _flat_shape([(-0.012 * r * 2, 0.06 * r), (0.012 * r * 2, 0.06 * r), (0.0, 0.26 * r)], c, 0.006, 0.0012),
             M.cylinder(c + VN * 0.004, c + VN * 0.0075, 0.075 * r, 14)]
    b.obj("TC_Plane_mesh", M.merge(parts), "needle", parent=piv, origin=M.P(*(c + VN * 0.006)))
    # Inclinometer: the ball runs in a curved tube below the centre.
    arc_r = 0.09
    ball_c = c - VV * (0.52 * r)
    centre = ball_c + VV * arc_r
    ball = b.pivot("TC_Ball", centre + VN * 0.004, VN, props={"arcRadius": arc_r})
    b.obj("TC_Ball_mesh", _sphere(ball_c + VN * 0.004, 0.0042), "plastic_black", parent=ball,
          origin=M.P(*(centre + VN * 0.004)))
    pts = [centre - arc_r * (math.sin(t) * (-VX) + math.cos(t) * VV) + VN * 0.004 for t in np.linspace(-0.2, 0.2, 9)]
    tube = M.tube_path(pts, 0.0055, 12)
    b.add("gauge_glass", tube)


def _sphere(c, r, nu=14, nv=8):
    verts = []
    for i in range(1, nv):
        th = math.pi * i / nv
        for k in range(nu):
            ph = 2 * math.pi * k / nu
            verts.append(c + r * np.array([math.sin(th) * math.cos(ph), math.sin(th) * math.sin(ph), math.cos(th)]))
    faces = M.grid_faces(nv - 1, nu, wrap_cols=True)
    top, bot = len(verts), len(verts) + 1
    verts += [c + np.array([0, 0, r]), c - np.array([0, 0, r])]
    faces += M.fan_cap(list(range(nu)), top, reverse=True)
    last = (nv - 2) * nu
    faces += M.fan_cap(list(range(last, last + nu)), bot)
    return np.array(verts), faces


def flag(b, name, gid, angle_deg, s=0.0035, radial=0.86):
    """Red flag plate on a dial; extras.slide moves it out behind the bezel (hidden)."""
    from . import controls as K
    bl, v, r = GAUGES[gid]
    a = math.radians(angle_deg)
    d = -math.sin(a) * VX + math.cos(a) * VV        # clockwise from 12 o'clock as the pilot sees it
    at = pp(bl, v, s) + d * radial * r
    piv = b.pivot(name, at, VN)
    # Hidden: inside the bezel ring (radius r .. r + 8 mm), behind its lip.
    piv["slide"] = [c * (1.11 - radial) * r for c in M.model_axis(*d)]
    K.attach(b, f"{name}_mesh", K.shared("flag", K.flag_shape, b.mats["knob_red"]), piv)
    return piv


def cdi(b, gid, glide):
    """VOR/ILS indicator: turning azimuth card (OBS), needle hinged at the top, flags."""
    from . import controls as K
    bl, v, r = GAUGES[gid]
    c = pp(bl, v)
    card = b.pivot(f"{gid}_Card", c + VN * 0.0015, VN)
    verts, faces, uvs = _disc(c + VN * 0.0015, r)
    b.obj(f"Face_{gid}", (verts, faces), "gauge_face", parent=card, origin=M.P(*(c + VN * 0.0015)), uvs=uvs,
          smooth=False)
    # Fixed parts: course index and reciprocal, the dots of the deviation scale.
    b.add("needle_orange", _flat_shape([(-0.0028, r * 0.99), (0.0028, r * 0.99), (0.0, r * 0.83)], c, 0.0032))
    b.add("needle", _flat_shape([(-0.0018, -r * 0.99), (0.0018, -r * 0.99), (0.0, -r * 0.86)], c, 0.0032))
    for i in range(-5, 6):
        if i == 0:
            continue
        b.add("needle", M.cylinder(c + VN * 0.0026 - VX * (i * 0.1 * r), c + VN * 0.0032 - VX * (i * 0.1 * r),
                                   0.0008, 8))
        if glide:
            b.add("needle", M.cylinder(c + VN * 0.0026 + VV * (i * 0.1 * r), c + VN * 0.0032 + VV * (i * 0.1 * r),
                                       0.0008, 8))
    b.add("needle", M.lathe([(0.0, 0.0028), (0.0, 0.0036), (0.0006, 0.0036), (0.0006, 0.0028)], c + VN * 0.0026, VN,
                            n=20, close_start=False, close_end=False))
    # Needle: hangs from a hinge near the top; the loader swings it.
    hinge = c + VV * 0.75 * r
    piv = b.pivot(f"{gid}_Needle", hinge + VN * 0.005, VN)
    bar = _flat_shape([(-0.0007, 0.0), (0.0007, 0.0), (0.0007, -1.62 * r), (-0.0007, -1.62 * r)], hinge, 0.005)
    b.obj(f"{gid}_Needle_mesh", bar, "needle", parent=piv, origin=M.P(*(hinge + VN * 0.005)))
    if glide:
        hinge = c + VX * 0.75 * r
        piv = b.pivot(f"{gid}_GS", hinge + VN * 0.0058, VN)
        bar = _flat_shape([(0.0, -0.0007), (1.62 * r, -0.0007), (1.62 * r, 0.0007), (0.0, 0.0007)], hinge, 0.0058)
        b.obj(f"{gid}_GS_mesh", bar, "needle", parent=piv, origin=M.P(*(hinge + VN * 0.0058)))
        flag(b, f"{gid}_GsFlag", gid, 90, radial=0.8)
    flag(b, f"{gid}_NavFlag", gid, 225, radial=0.78)
    # TO/FROM: a white triangle that turns over; it slides away when there is no signal.
    a = math.radians(45)
    d = -math.sin(a) * VX + math.cos(a) * VV
    at = c + d * 0.6 * r + VN * 0.0034
    piv = b.pivot(f"{gid}_ToFrom", at, VN)
    piv["slide"] = [x * 0.51 * r for x in M.model_axis(*d)]
    tri = np.array([(-0.0032, -0.0022, 0.0), (0.0032, -0.0022, 0.0), (0.0, 0.0028, 0.0),
                    (-0.0032, -0.0022, 0.0006), (0.0032, -0.0022, 0.0006), (0.0, 0.0028, 0.0006)])
    tri_f = [(2, 1, 0), (3, 4, 5), (0, 1, 4, 3), (1, 2, 5, 4), (2, 0, 3, 5)]
    K.attach(b, f"{gid}_ToFrom_mesh", K.shared("tofrom", lambda: (tri, tri_f), b.mats["needle"]), piv)


def heading_bug(b):
    bl, v, r = GAUGES["HI"]
    c = pp(bl, v)
    piv = b.pivot("HI_Bug", c + VN * 0.0026, VN)
    notch = [(-0.0034, r * 0.99), (-0.0034, r * 0.84), (-0.0012, r * 0.84), (-0.0012, r * 0.92), (0.0012, r * 0.92),
             (0.0012, r * 0.84), (0.0034, r * 0.84), (0.0034, r * 0.99)]
    b.obj("HI_Bug_mesh", _flat_shape(notch, c, 0.0026, 0.0008), "needle_orange", parent=piv,
          origin=M.P(*(c + VN * 0.0026)))


def compass(b):
    """Wet compass hanging at the top of the windshield centre."""
    c = np.array([0.0, 0.66, 1.885])
    # Housing ahead of the card; the card's aft half shows through a clear bubble.
    b.add("plastic_black", M.rounded_box(c + np.array([0, -0.026, 0.0]), (0.072, 0.05, 0.06), 0.012, 2))
    b.add("plastic_black", M.rounded_box(c + np.array([0, -0.03, 0.045]), (0.03, 0.03, 0.04), 0.006, 1))
    b.add("gauge_glass", M.rounded_box(c + np.array([0, 0.008, 0.0]), (0.066, 0.042, 0.03), 0.012, 3))
    # Lubber line in front of the card, facing the pilot.
    b.add("needle_orange", M.rounded_box(c + np.array([0, 0.029, 0.0]), (0.0012, 0.0015, 0.026), 0.0, 1))
    piv = b.pivot("Compass_Card", c, (0, 0, 1.0))
    # Card: a short cylinder band; u = 0 faces the pilot, increasing to the pilot's right.
    n, R, h = 72, 0.0255, 0.016
    verts, uvs, faces = [], [], []
    for k in range(n + 1):
        phi = 2 * math.pi * k / n
        d = np.array([-math.sin(phi), math.cos(phi), 0.0])   # phi = 0 points aft (to the pilot)
        for z in (-h / 2, h / 2):
            verts.append(c + R * d + np.array([0, 0, z]))
    for k in range(n):
        a, bb, cc, dd = 2 * k, 2 * k + 2, 2 * k + 3, 2 * k + 1
        faces.append((a, bb, cc, dd))
        uvs += [(k / n, 0.0), ((k + 1) / n, 0.0), ((k + 1) / n, 1.0), (k / n, 1.0)]
    o = b.obj("Face_COMPASS", (np.array(verts), faces), "gauge_face", parent=piv, origin=M.P(*c), uvs=uvs)
    return o


# ---------------------------------------------------------------------------
# Panel, controls, cabin
# ---------------------------------------------------------------------------

def panel(b):
    outline = [(-PANEL_HALF, 0.0), (PANEL_HALF, 0.0), (PANEL_HALF, PANEL_H), (-PANEL_HALF, PANEL_H)]
    poly = M.rounded_polygon(outline, 0.02, 3)
    pts, faces = [], []
    n = len(poly)
    for s in (-0.025, 0.0):
        for x, y in poly:
            pts.append(pp(x, y, s))
    faces = [tuple(range(n)), tuple(range(n, 2 * n))[::-1]]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    b.add("panel", (np.array(pts), faces))
    # Circuit breakers on the lower right.
    for row in range(2):
        for i in range(8):
            cb = pp(-0.30 - i * 0.022, 0.03 + row * 0.03, 0.0)
            b.add("plastic_black", M.cylinder(cb, cb + VN * 0.009, 0.0045, 10))
    # Glove box door on the right.
    b.add("interior_dark", _box_panel(pp(-0.40, 0.21, 0.002), 0.17, 0.10, 0.004))
    # Placards under the instruments.
    for gid in ("ASI", "AI", "ALT", "TC", "HI", "VSI"):
        bl, v, r = GAUGES[gid]
        b.add("placard", _box_panel(pp(bl, v - r - 0.016, 0.0006), 0.024, 0.005, 0.0006))


def _box_panel(center, w, h, depth):
    """Box on the panel plane: w along BL, h up the panel, depth out of it."""
    c = np.asarray(center)
    pts = []
    for dz in (0.0, depth):
        for dx, dy in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)):
            pts.append(c + dx * VX + dy * VV + (dz - depth / 2) * VN)
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return np.array(pts), faces


def glareshield(b):
    """Padded hood from the panel's top edge forward to the windshield base."""
    rows = []
    us = np.linspace(-1, 1, 25)
    # The lip overhangs the panel by about 5 cm: any more and it hides the panel's top row
    # (annunciators, audio panel) from the pilot's eye.
    prof = [(0.395, 1.49), (0.40, 1.505), (0.39, 1.52), (0.33, 1.548), (0.24, 1.568), (0.10, 1.575), (0.02, 1.565)]
    for u in us:
        row = []
        for fs, wl in prof:
            # Reach out to the cabin sides, which narrow towards the windshield.
            hw = F.half_width_at(fs, wl - 0.03, inset=0.015)
            row.append((u * hw, fs, wl - 0.03 * abs(u) ** 2))
        rows.append(row)
    v = np.array([p for r in rows for p in r])
    f = M.grid_faces(len(us), len(prof))
    b.add("glareshield", (v, f))
    # Firewall behind and below the panel, the floor and the baggage bulkhead, all cut to the
    # inside of the skin.
    b.add("interior_dark", _bulkhead(0.02, 0.03, 0.74, 1.60))
    b.add("interior", _bulkhead(3.30, 0.02, 0.74, 1.60))
    rows = []
    for fs in np.linspace(0.02, 3.30, 30):
        hw = F.half_width_at(fs, 0.80, inset=0.02)
        rows.append([(-hw, fs, 0.80), (hw, fs, 0.80)])
    v = np.array([p for r in rows for p in r])
    b.add("carpet", (v, M.grid_faces(len(rows), 2)))
    # Pedestal under the radio stack.
    b.add("interior_dark", M.rounded_box((-0.11, 0.52, 0.95), (0.17, 0.24, 0.30), 0.02, 2))


def _bulkhead(fs, thick, wl_min, wl_max):
    ring = F.inner_section(fs, 0.024, wl_min, wl_max)
    v, f = [], []
    n = len(ring)
    for d in (0.0, thick):
        for bl, wl in ring:
            v.append((bl, fs + d, wl))
    c0, c1 = len(v), len(v) + 1
    v += [(0.0, fs, ring[:, 1].mean()), (0.0, fs + thick, ring[:, 1].mean())]
    f += M.fan_cap(list(range(n)), c0)
    f += M.fan_cap(list(range(n, 2 * n)), c1, reverse=True)
    for i in range(n):
        j = (i + 1) % n
        f.append((i, j, n + j, n + i))
    return np.array(v), f


def seats(b):
    for bl in (0.27, -0.27):
        b.add("fabric", M.rounded_box((bl, 1.10, 1.03), (0.46, 0.50, 0.12), 0.04, 3))
        back = M.rounded_box((bl, 0.0, 0.0), (0.46, 0.11, 0.66), 0.04, 3)
        rot = M.rot_axis((1, 0, 0), math.radians(-12))
        bv = M.transform(back[0], rot=rot, offset=(0, 1.42, 1.43))
        b.add("fabric", (bv, back[1]))
        head = M.rounded_box((0.0, 0.0, 0.0), (0.26, 0.09, 0.17), 0.04, 3)
        hv = M.transform(head[0], rot=rot, offset=(bl, 1.50, 1.83))
        b.add("leather", (hv, head[1]))
        # Seat rails and frame.
        for dx in (-0.17, 0.17):
            b.add("steel", M.rounded_box((bl + dx, 1.10, 0.86), (0.03, 0.48, 0.10), 0.01, 1))
        # Door armrest.
        side = 1 if bl > 0 else -1
        b.add("interior_dark", M.rounded_box((side * 0.49, 0.95, 1.30), (0.05, 0.40, 0.06), 0.015, 2))
    # Rear bench.
    b.add("fabric", M.rounded_box((0.0, 2.05, 1.04), (0.96, 0.46, 0.13), 0.05, 3))
    back = M.rounded_box((0.0, 0.0, 0.0), (0.96, 0.10, 0.55), 0.04, 3)
    rot = M.rot_axis((1, 0, 0), math.radians(-14))
    b.add("fabric", (M.transform(back[0], rot=rot, offset=(0, 2.36, 1.36)), back[1]))


def yokes(b):
    for bl, sfx in ((0.27, "L"), (-0.27, "R")):
        start = pp(bl, 0.10, -0.03)
        slide = b.pivot(f"Yoke_{sfx}", start, (0, 1, 0), props={"slide": M.model_axis(0, 1, 0)})
        slide["slide"] = [c * 0.075 for c in M.model_axis(0, 1, 0)]
        hub = start + np.array([0, 0.25, 0.0])
        shaft = M.cylinder(start, hub, 0.0115, 14)
        b.obj(f"YokeShaft_{sfx}", shaft, "chrome", parent=slide, origin=M.P(*start))
        roll = b.pivot(f"YokeRoll_{sfx}", hub, (0, -1, 0), parent=slide)
        # Ram's-horn yoke: hub, cross bar, two grips rising at the ends.
        parts = [M.rounded_box(hub + np.array([0, 0.015, 0.0]), (0.075, 0.04, 0.05), 0.012, 2)]
        bar_l = hub + np.array([0.14, 0.02, -0.01])
        bar_r = hub + np.array([-0.14, 0.02, -0.01])
        parts.append(M.tube_path([bar_r, hub + np.array([0, 0.03, -0.018]), bar_l], [0.012, 0.014, 0.012], 12))
        for end, sx in ((bar_l, 1), (bar_r, -1)):
            grip = [end, end + np.array([sx * 0.012, 0.008, 0.05]), end + np.array([sx * 0.006, 0.0, 0.11])]
            parts.append(M.tube_path(grip, [0.013, 0.016, 0.014], 14))
        b.obj(f"YokeWheel_{sfx}", M.merge(parts), "plastic_black", parent=roll, origin=M.P(*hub), sharp=50)
        # Centre badge.
        b.obj(f"YokeBadge_{sfx}", M.rounded_box(hub + np.array([0, 0.037, 0.0]), (0.05, 0.004, 0.032), 0.004, 1),
              "placard", parent=roll, origin=M.P(*hub))


def pedals(b):
    # Left pedals of both seats move together, so do the right ones.
    for which, dx in (("L", 0.09), ("R", -0.09)):
        piv = b.pivot(f"Pedals_{which}", np.array([0.0, 0.16, 1.05]), (0, -1, 0),
                      props={"slide": [c * 0.06 for c in M.model_axis(0, -1, 0)]})
        parts = []
        for seat in (0.27, -0.27):
            x = seat + dx
            top = np.array([x, 0.08, 1.06])
            foot = np.array([x, 0.16, 0.90])
            parts.append(M.tube_path([top, foot], 0.009, 8))
            pad = M.rounded_box((0, 0, 0), (0.075, 0.016, 0.11), 0.006, 1)
            rot = M.rot_axis((1, 0, 0), math.radians(-35))
            parts.append((M.transform(pad[0], rot=rot, offset=foot + np.array([0, 0.015, 0.0])), pad[1]))
        b.obj(f"Pedals_{which}_mesh", M.merge(parts), "steel", parent=piv, origin=M.P(0.0, 0.16, 1.05))


def build(col, mats, root):
    b = Builder(col, mats, root)
    panel(b)
    instruments(b)
    compass(b)
    glareshield(b)
    seats(b)
    yokes(b)
    pedals(b)
    from . import controls
    controls.build(b)
    b.flush()
    eye = M.empty("Eye", col, M.P(*D.EYE), size=0.03)
    M.parent_keep(eye, root)
    return b
