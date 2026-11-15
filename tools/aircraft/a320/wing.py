"""
A320 wing: straight swept leading edge, the trailing-edge kink with the inboard trailing edge
running almost straight across, 5.1 degrees of dihedral, thin supercritical-looking sections.
Movables, each on its own pivot (identity rest rotation, extras.axis in the model frame):

  Slat_In_L/R      slat 1 (inboard of the pylon): leading edge down on its arc track
  Slat_Out_L/R     slats 2-5 together (the leading edge is one straight line)
  FlapIn_L/R       inboard Fowler flap: trailing edge down, slides aft (extras.slide)
  FlapOut_L/R      outboard Fowler flap
  Aileron_L/R      trailing edge down
  Spoiler1_L/R     spoiler 1 (ground spoiler only)
  Spoiler234_L/R   spoilers 2-4 (speed brake, roll and ground), trailing edge up
  Spoiler5_L/R     spoiler 5 (roll and ground)

and the three flap-track fairings, the wing-tip fences, static wicks.
"""

import math

import numpy as np

from lib import mesh as M
from lib import surfaces as S
from . import dims as D


def _a(s):
    return max(0.0, abs(s) - D.WING_ROOT_BL)


def _le(s):
    a = _a(s)
    return D.WING_ROOT_LE + a * math.tan(D.LE_SWEEP), D.WING_WL + a * math.tan(D.DIHEDRAL)


def chord(s):
    a = abs(s)
    if a <= D.WING_ROOT_BL:
        return D.ROOT_CHORD
    if a <= D.KINK_BL:
        t = (a - D.WING_ROOT_BL) / (D.KINK_BL - D.WING_ROOT_BL)
        return D.ROOT_CHORD + t * (D.KINK_CHORD - D.ROOT_CHORD)
    t = (a - D.KINK_BL) / (D.TIP_BL - D.KINK_BL)
    return D.KINK_CHORD + t * (D.TIP_CHORD - D.KINK_CHORD)


def _twist(s):
    t = min(_a(s) / (D.TIP_BL - D.WING_ROOT_BL), 1.0)
    return D.INCIDENCE_ROOT + t * (D.INCIDENCE_TIP - D.INCIDENCE_ROOT)


WING = S.Planform(_le, chord, _twist)


def tc(s):
    a = abs(s)
    return float(np.interp(a, [0, D.WING_ROOT_BL, D.KINK_BL, D.TIP_BL], [D.ROOT_TC, D.ROOT_TC, D.KINK_TC, D.TIP_TC]))


def foil(s):
    return (D.CAMBER, 0.42, tc(s))


def chord_wl(bl):
    return _le(bl)[1]


def piece(name, col, mat, plan, s0, s1, loop_fn, step=0.4, extra=(), caps=True, origin=None, sharp=35):
    st = S.stations(s0, s1, step, extra)
    v, f = S.loft(plan, st, loop_fn, cap_start=caps, cap_end=caps)
    return M.make_object(name, v, f, col, mat, smooth=True, sharp_angle=sharp, origin=origin)


def oriented_axis(a, b, probe, want):
    axis = (b - a) / np.linalg.norm(b - a)
    mid = 0.5 * (a + b)
    moved = M.rot_axis(axis, 0.05) @ (probe - mid) + mid
    if np.dot(moved - probe, want) < 0:
        axis = -axis
    return M.model_axis(*axis), axis


def pivot(name, col, a, b, probe, want, props=None, at=None):
    model_ax, _ = oriented_axis(a, b, probe, want)
    mid = 0.5 * (a + b) if at is None else at
    pr = {"axis": model_ax}
    pr.update(props or {})
    return M.empty(name, col, M.P(*mid), props=pr), mid


def surface_point(bl, fs, upper=False):
    """Point on the wing skin above or below (bl, fs), and its rough normal."""
    c = chord(bl)
    x = (fs - _le(bl)[0]) / c
    p = None
    for _ in range(4):
        xu, yu, xl, yl = S.naca4(*foil(bl), np.array([min(max(x, 0.0), 1.0)]))
        xx, yy = (xu, yu) if upper else (xl, yl)
        p = WING.point(bl, float(xx[0]), float(yy[0]))
        x += (fs - p[1]) / c
    side = 1 if bl >= 0 else -1
    n = np.array([-side * math.sin(D.DIHEDRAL), 0.0, math.cos(D.DIHEDRAL)])
    return p, (n if upper else -n)


def _normals2d(loop):
    d = np.roll(loop, -1, 0) - np.roll(loop, 1, 0)
    n = np.stack([d[:, 1], -d[:, 0]], -1)
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
    # Outward: away from the loop's centre.
    c = loop.mean(0)
    flip = np.sum((loop - c) * n, axis=1) < 0
    n[flip] *= -1
    return n


def slat_loop(s, x_up=D.SLAT_CHORD, x_lo=0.055, out=0.005, inner=0.0008, n=20):
    """A shell over the leading edge: outer skin from the upper trailing edge round the nose to
    the lower edge, then back along the inside; chord units at span s."""
    c = chord(s)
    f = foil(s)
    xs = M.cosine_spacing(n)
    xu, yu, _, _ = S.naca4(*f, xs[::-1] * x_up)
    _, _, xl, yl = S.naca4(*f, xs[1:] * x_lo)
    base = np.vstack([np.stack([xu, yu], -1), np.stack([xl, yl], -1)])
    nrm = _normals2d(base)
    outer = base + nrm * (out / c)
    inside = base + nrm * (inner / c)
    return np.vstack([outer, inside[::-1]])


def spoiler_loop(s, x0=D.SPOILER_X[0], x1=D.SPOILER_X[1], t=0.012, lift=0.004, n=10):
    c = chord(s)
    xs = np.linspace(x0, x1, n)
    xu, yu, _, _ = S.naca4(*foil(s), xs)
    base = np.stack([xu, yu], -1)
    top = base + np.array([0, (lift + t) / c])
    bot = base + np.array([0, lift / c])
    # The trailing edge tapers onto the flap's nose.
    top[-1] = bot[-1] + np.array([0, 0.25 * t / c])
    return np.vstack([top[::-1], bot])


def build(col, mats, parts):
    box = lambda s: S.section_box(foil(s), D.WING_BOX_UPPER, D.WING_BOX_LOWER, n=40)  # noqa: E731
    mov = lambda s: S.section_movable(foil(s), D.FLAP_NOSE, n=22)[0]  # noqa: E731
    breaks = [D.WING_ROOT_BL, D.KINK_BL, *D.FLAP_IN, *D.FLAP_OUT, *D.AILERON]
    breaks = breaks + [-b for b in breaks]
    wing = piece("Wing", col, mats["paint"], WING, -D.TIP_BL, D.TIP_BL, box, step=0.5, extra=breaks)
    parts["Wing"] = wing
    parts["WingCentreTE"] = piece("WingCentreTE", col, mats["paint"], WING, -D.FLAP_IN[0] + 0.01,
                                  D.FLAP_IN[0] - 0.01, mov, step=1.0)
    for side, sfx in ((1, "L"), (-1, "R")):
        parts[f"WingTipTE_{sfx}"] = piece(f"WingTipTE_{sfx}", col, mats["paint"], WING,
                                          side * (D.AILERON[1] + 0.02), side * D.TIP_BL, mov, step=0.5)
        parts[f"Fence_{sfx}"] = fence(col, mats, side, sfx)
        down = np.array([0, 0, -1.0])
        for name, (b0, b1), slide in (("FlapIn", D.FLAP_IN, True), ("FlapOut", D.FLAP_OUT, True),
                                      ("Aileron", D.AILERON, False)):
            f0, f1 = side * (b0 + 0.02), side * (b1 - 0.02)
            _, (cx, cy) = S.section_movable(foil(f0), D.FLAP_NOSE)
            a, b = WING.point(f0, cx, cy), WING.point(f1, cx, cy)
            te = WING.point(0.5 * (f0 + f1), 1.0, 0.0)
            props = {"upDeg": 25.0, "downDeg": 20.0} if not slide else {"maxDeg": D.FLAP_DEG}
            if slide:
                # Aft and a little down along the tracks, scaled by the mean chord.
                c_mid = chord(0.5 * (f0 + f1))
                aft = np.array([0.0, 1.0, -0.16])
                aft /= np.linalg.norm(aft)
                props["slide"] = [x * D.FLAP_SLIDE * c_mid for x in M.model_axis(*aft)]
            p, mid = pivot(f"{name}_{sfx}", col, a, b, te, down, props)
            o = piece(f"{name}_{sfx}_mesh", col, mats["paint"], WING, f0, f1, mov, step=0.6, origin=M.P(*mid))
            M.parent_keep(o, p)
            parts[f"{name}_{sfx}"] = o
        # Spoilers: three groups, hinged at their forward edge.
        up = np.array([0, 0, 1.0])
        groups = (("Spoiler1", [D.SPOILERS[0]]), ("Spoiler234", D.SPOILERS[1:4]), ("Spoiler5", [D.SPOILERS[4]]))
        for name, panels in groups:
            s0, s1 = side * (panels[0][0] + 0.02), side * (panels[-1][1] - 0.02)
            a = WING.point(s0, D.SPOILER_X[0], float(S.naca4(*foil(s0), np.array([D.SPOILER_X[0]]))[1][0]))
            b = WING.point(s1, D.SPOILER_X[0], float(S.naca4(*foil(s1), np.array([D.SPOILER_X[0]]))[1][0]))
            te = WING.point(0.5 * (s0 + s1), D.SPOILER_X[1], 0.06)
            p, mid = pivot(f"{name}_{sfx}", col, a, b, te, up, {"maxDeg": 50.0})
            meshes = [piece(f"{name}_{sfx}_{i}", col, mats["paint"], WING, side * (p0 + 0.015), side * (p1 - 0.015),
                            spoiler_loop, step=0.8, origin=M.P(*mid), sharp=30)
                      for i, (p0, p1) in enumerate(panels)]
            o = M.join(meshes, f"{name}_{sfx}_mesh")
            M.parent_keep(o, p)
            parts[f"{name}_{sfx}"] = o
        # Slats: an arc track turns them forward and down about an axis behind the leading edge.
        for name, segs in (("Slat_In", D.SLATS[:1]), ("Slat_Out", D.SLATS[1:])):
            s0, s1 = side * segs[0][0], side * segs[-1][1]
            le0, le1 = WING.point(s0, 0.0, 0.0), WING.point(s1, 0.0, 0.0)
            back = np.array([0.0, 0.62, -0.30])
            a, b = le0 + back, le1 + back
            probe = 0.5 * (le0 + le1)
            p, mid = pivot(f"{name}_{sfx}", col, a, b, probe, np.array([0, 0, -1.0]), {"maxDeg": D.SLAT_DEG})
            meshes = [piece(f"{name}_{sfx}_{i}", col, mats["paint"], WING, side * (p0 + 0.02), side * (p1 - 0.02),
                            slat_loop, step=0.6, origin=M.P(*mid), sharp=30)
                      for i, (p0, p1) in enumerate(segs)]
            o = M.join(meshes, f"{name}_{sfx}_mesh")
            M.parent_keep(o, p)
            parts[f"{name}_{sfx}"] = o
    parts["FlapTracks"] = flap_tracks(col, mats)
    parts["Wicks"] = wicks(col, mats)
    return wing


def fence(col, mats, side, sfx):
    """Wing-tip fence: an arrowhead plate above and below the tip."""
    s = side * (D.TIP_BL + 0.03)
    le, wl = _le(D.TIP_BL)
    c = chord(D.TIP_BL)
    parts = []
    for sgn, h, back in ((1, D.FENCE_UP, 0.55), (-1, D.FENCE_DOWN, 0.25)):
        poly = [(le + 0.05, wl), (le + c + 0.30, wl), (le + c + 0.30 + back * 0.4, wl + sgn * h),
                (le + c - 0.05 + back * 0.4, wl + sgn * h)]
        poly = M.rounded_polygon(poly, [0.15, 0.02, 0.04, 0.06], 3)
        parts.append(M.prism(poly, 0, s - 0.035, s + 0.035, (1, 2)))
    v, f = M.merge(parts)
    return M.make_object(f"Fence_{sfx}", v, f, col, mats["paint"], sharp_angle=50)


def flap_tracks(col, mats):
    """The canoe fairings under the wing that carry the flap tracks."""
    parts = []
    for side in (1, -1):
        for bl in D.FLAP_TRACKS:
            s = side * bl
            fs_le = _le(s)[0]
            c = chord(s)
            fs0 = fs_le + 0.52 * c
            fs1 = fs_le + 1.28 * c
            rows = []
            n = 16
            for t in np.linspace(0, 1, 22):
                fs = fs0 + t * (fs1 - fs0)
                top, _ = surface_point(s, min(fs, fs_le + 0.70 * c))
                depth = (0.30 + 0.035 * c) * math.sin(math.pi * min(t * 1.2, 1.0) ** 0.75) * (1 - 0.55 * t) + 0.02
                half = 0.11 * math.sin(math.pi * min(t * 1.08, 1.0) ** 0.6) + 0.01
                ring = []
                for k in range(n):
                    a = 2 * math.pi * k / n
                    ring.append((s + half * math.sin(a), fs, top[2] + 0.02 - depth * (0.5 - 0.5 * math.cos(a))))
                rows.append(ring)
            v = np.array([p for r in rows for p in r])
            f = M.grid_faces(len(rows), n, wrap_cols=True)
            cc = len(v)
            v = np.vstack([v, [np.mean(rows[0], 0)], [np.mean(rows[-1], 0)]])
            f += M.fan_cap(list(range(n)), cc, reverse=True)
            last = (len(rows) - 1) * n
            f += M.fan_cap(list(range(last, last + n)), cc + 1)
            parts.append((v, f))
    v, f = M.merge(parts)
    return M.make_object("FlapTracks", v, f, col, mats["paint"], sharp_angle=50)


def wicks(col, mats):
    parts = []
    for side in (1, -1):
        for bl in (13.4, 14.6, 15.6, 16.5):
            tep = WING.point(side * bl, 1.0, 0.0)
            parts.append(M.tube_path([tep - np.array([0, 0.03, 0]), tep + np.array([0, 0.16, -0.005])],
                                     [0.004, 0.0025], 5))
    v, f = M.merge(parts)
    return M.make_object("Wicks", v, f, col, mats["antenna"], sharp_angle=40)
