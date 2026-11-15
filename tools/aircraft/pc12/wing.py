"""
PC-12 wing: low wing of straight taper with 6 degrees of dihedral, thick at the root (17 %),
thinner at the tip (13 %), small canted winglets, long Fowler flaps on tracks with canoe
fairings, ailerons, and the main-gear wells in the lower skin with doors that follow it.
"""

import math

import bpy
import numpy as np

from lib import airframe as A
from lib import mesh as M
from lib import surfaces as S
from . import dims as D


def _t(a):
    return min(max((a - D.WING_ROOT_BL) / (D.TIP_BL - D.WING_ROOT_BL), 0.0), 1.0)


def _le(s):
    a = abs(s)
    le = D.WING_ROOT_LE_FS + _t(a) * D.LE_SWEEP_FS
    wl = D.WING_WL + max(0.0, a - D.WING_ROOT_BL) * math.tan(D.DIHEDRAL)
    return le, wl


def _chord(s):
    return D.ROOT_CHORD + _t(abs(s)) * (D.TIP_CHORD - D.ROOT_CHORD)


def _twist(s):
    return D.INCIDENCE_ROOT + _t(abs(s)) * (D.INCIDENCE_TIP - D.INCIDENCE_ROOT)


WING = S.Planform(_le, _chord, _twist)


def foil(s):
    return (D.CAMBER, 0.4, D.ROOT_TC + _t(abs(s)) * (D.TIP_TC - D.ROOT_TC))


def chord_wl(bl):
    return _le(bl)[1]


def piece(name, col, mat, plan, s0, s1, loop_fn, step=0.12, extra=(), caps=True, tip=None, origin=None,
          sharp=35):
    st = S.stations(s0, s1, step, extra)
    v, f = S.loft(plan, st, loop_fn, cap_start=caps, cap_end=caps and tip is None, tip=tip)
    return M.make_object(name, v, f, col, mat, smooth=True, sharp_angle=sharp, origin=origin)


def hinge(plan, s0, s1, x_nose):
    _, (cx, cy) = S.section_movable(foil(s0), x_nose)
    return plan.point(s0, cx, cy), plan.point(s1, cx, cy)


def oriented_axis(a, b, probe, want):
    axis = (b - a) / np.linalg.norm(b - a)
    mid = 0.5 * (a + b)
    moved = M.rot_axis(axis, 0.05) @ (probe - mid) + mid
    if np.dot(moved - probe, want) < 0:
        axis = -axis
    return M.model_axis(*axis), axis


def pivot(name, col, a, b, probe, want, extra_props=None):
    model_ax, _ = oriented_axis(a, b, probe, want)
    mid = 0.5 * (a + b)
    props = {"axis": model_ax}
    props.update(extra_props or {})
    return M.empty(name, col, M.P(*mid), props=props), mid


def surface_point(bl, fs, upper=False):
    """Point on the wing skin above or below (bl, fs) (design frame), and its rough normal."""
    x = (fs - _le(bl)[0]) / _chord(bl)
    for _ in range(3):
        xu, yu, xl, yl = S.naca4(*foil(bl), np.array([min(max(x, 0.0), 1.0)]))
        xx, yy = (xu, yu) if upper else (xl, yl)
        p = WING.point(bl, float(xx[0]), float(yy[0]))
        x += (fs - p[1]) / _chord(bl)
    side = 1 if bl >= 0 else -1
    n = np.array([-side * math.sin(D.DIHEDRAL), 0.0, math.cos(D.DIHEDRAL)])
    return p, (n if upper else -n)


# Main-gear well in the lower skin (|BL| range, FS range) and how it splits between the
# inboard wheel door and the door on the leg.
WELL_BL = (0.74, 2.24)
WELL_FS = (5.97, 6.66)
DOOR_SPLIT_BL = 1.60


def well_cutter(col, mat):
    parts = []
    for side in (1, -1):
        b0, b1 = WELL_BL
        f0, f1 = WELL_FS
        v = []
        for bl in (b0, b1):
            top = chord_wl(bl) - 0.012
            for fs in (f0, f1):
                v += [(side * bl, fs, 0.4), (side * bl, fs, top)]
        v = np.array(v)
        faces = [(0, 2, 6, 4), (1, 5, 7, 3), (0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6)]
        parts.append((v, faces))
    v, f = M.merge(parts)
    o = M.make_object("WellCutterMain", v, f, col, mat, smooth=False)
    # Make the box's normals point out whatever the corner order.
    return o


def well_liner(col, mats):
    parts = []
    for side in (1, -1):
        b0, b1 = WELL_BL
        f0, f1 = WELL_FS
        v = []
        for bl in (b0 + 0.005, b1 - 0.005):
            lo = surface_point(side * bl, 0.5 * (f0 + f1))[0][2] - 0.01
            top = chord_wl(bl) + 0.11
            for fs in (f0 + 0.005, f1 - 0.005):
                v += [(side * bl, fs, lo), (side * bl, fs, top)]
        faces = [(0, 2, 6, 4), (1, 5, 7, 3), (0, 1, 3, 2), (4, 6, 7, 5), (1, 3, 7, 5)]
        parts.append((np.array(v), faces))
    v, f = M.merge(parts)
    return M.make_object("MainWells", v, f, col, mats["well"], smooth=False, recalc=False)


def build(col, mats, parts):
    box = lambda s: S.section_box(foil(s), D.WING_BOX_UPPER, D.WING_BOX_LOWER, n=46)  # noqa: E731
    mov = lambda s: S.section_movable(foil(s), D.WING_SURFACE_NOSE, n=26)[0]  # noqa: E731
    breaks = [D.WING_ROOT_BL, *D.FLAP_BL, *D.AILERON_BL, *WELL_BL]
    breaks = breaks + [-b for b in breaks]
    wing = piece("Wing", col, mats["paint"], WING, -D.TIP_BL, D.TIP_BL, box, step=0.16, extra=breaks)
    cut_mat = bpy.data.materials.get("CUT") or bpy.data.materials.new("CUT")
    cutter = well_cutter(col, cut_mat)
    M.boolean(wing, cutter, "DIFFERENCE")
    A.delete_faces_with_material(wing, "CUT")
    M.delete_object(cutter)
    parts["Wing"] = wing
    parts["MainWells"] = well_liner(col, mats)
    parts["WingCentreTE"] = piece("WingCentreTE", col, mats["paint"], WING, -D.FLAP_BL[0] + 0.01,
                                  D.FLAP_BL[0] - 0.01, mov, step=0.3)
    for side, sfx in ((1, "L"), (-1, "R")):
        parts[f"WingTipTE_{sfx}"] = piece(f"WingTipTE_{sfx}", col, mats["paint"], WING,
                                          side * (D.AILERON_BL[1] + 0.01), side * D.TIP_BL, mov, step=0.3)
        parts[f"Winglet_{sfx}"] = winglet(col, mats, side, sfx)
        # Flap: hinge at the nose; runs aft on its tracks and turns down (Fowler).
        f0, f1 = side * D.FLAP_BL[0], side * D.FLAP_BL[1]
        a, b = hinge(WING, f0, f1, D.WING_SURFACE_NOSE)
        te = WING.point(0.5 * (f0 + f1), 1.0, 0.0)
        slide = M.model_axis(0, 1.0, -0.18)
        p, mid = pivot(f"Flap_{sfx}", col, a, b, te, np.array([0, 0, -1.0]),
                       {"slide": [c * D.FLAP_SLIDE for c in slide], "maxDeg": D.FLAP_DEG})
        o = piece(f"Flap_{sfx}_mesh", col, mats["paint"], WING, f0, f1, mov, step=0.2, origin=M.P(*mid))
        M.parent_keep(o, p)
        parts[f"Flap_{sfx}"] = o
        a0, a1 = side * D.AILERON_BL[0], side * D.AILERON_BL[1]
        a, b = hinge(WING, a0, a1, D.WING_SURFACE_NOSE)
        te = WING.point(0.5 * (a0 + a1), 1.0, 0.0)
        p, mid = pivot(f"Aileron_{sfx}", col, a, b, te, np.array([0, 0, -1.0]),
                       {"upDeg": 22.0, "downDeg": 16.0})
        o = piece(f"Aileron_{sfx}_mesh", col, mats["paint"], WING, a0, a1, mov, step=0.2, origin=M.P(*mid))
        M.parent_keep(o, p)
        parts[f"Aileron_{sfx}"] = o
        wicks = []
        for bl in (a0 + side * 0.6, a1 - side * 0.35):
            tep = WING.point(bl, 1.0, 0.0)
            wicks.append(M.tube_path([tep - np.array([0, 0.02, 0]), tep + np.array([0, 0.11, -0.004])],
                                     [0.003, 0.0018], 5))
        w = M.make_object(f"Wicks_Aileron_{sfx}", *M.merge(wicks), col, mats["antenna"], sharp_angle=40,
                          origin=M.P(*mid))
        M.parent_keep(w, p)
    parts["FlapTracks"] = flap_tracks(col, mats)
    return wing


def winglet(col, mats, side, sfx, n_path=16):
    """Canted winglet growing out of the tip in a tight radius; its section shrinks upwards."""
    s_tip = side * D.TIP_BL
    le_fs, wl0 = _le(s_tip)
    c0 = _chord(s_tip)
    te0 = le_fs + c0
    phi_end = math.pi / 2 - D.WINGLET_CANT
    r = 0.16
    arc_len = r * phi_end
    total = arc_len + D.WINGLET_H
    foil0 = foil(s_tip)
    loop = S.section_full(foil0, n=40)
    rows = []
    for k in range(n_path + 1):
        u = k / n_path
        d = u * total
        if d <= arc_len:
            phi = d / r
            bl = D.TIP_BL + r * math.sin(phi)
            wl = wl0 + r * (1 - math.cos(phi))
        else:
            phi = phi_end
            e = d - arc_len
            bl = D.TIP_BL + r * math.sin(phi_end) + e * math.cos(phi_end)
            wl = wl0 + r * (1 - math.cos(phi_end)) + e * math.sin(phi_end)
        h = max(0.0, (d - arc_len) / D.WINGLET_H)
        chord = c0 + (0.36 - c0) * h ** 0.7
        te = te0 + 0.06 * h
        le = te - chord
        thick = 1.0 - 0.35 * h
        tdir = np.array([-side * math.sin(phi), 0.0, math.cos(phi)])
        base = np.array([side * bl, 0.0, wl])
        row = []
        for x, y in loop:
            p = base + np.array([0.0, le + x * chord, 0.0]) + tdir * (y * chord * thick)
            row.append(p)
        rows.append(row)
    k = len(rows[0])
    v = np.array([p for row in rows for p in row])
    f = M.grid_faces(len(rows), k, wrap_cols=True)
    c = len(v)
    v = np.vstack([v, [np.mean(rows[-1], 0)]])
    last = (len(rows) - 1) * k
    f += M.fan_cap(list(range(last, last + k)), c)
    return M.make_object(f"Winglet_{sfx}", v, f, col, mats["paint"], sharp_angle=50)


def flap_tracks(col, mats):
    """Canoe fairings under the wing that carry the flap tracks."""
    parts = []
    for side in (1, -1):
        for bl in (1.75, 3.05, 4.35):
            s = side * bl
            fs_le = _le(s)[0]
            c = _chord(s)
            fs0 = fs_le + 0.50 * c
            fs1 = fs_le + 1.17 * c
            rows = []
            n = 14
            for t in np.linspace(0, 1, 18):
                fs = fs0 + t * (fs1 - fs0)
                top, _ = surface_point(s, min(fs, fs_le + 0.69 * c))
                depth = 0.17 * math.sin(math.pi * min(t * 1.25, 1.0) ** 0.8) * (1 - 0.6 * t) + 0.012
                half = 0.045 * math.sin(math.pi * min(t * 1.1, 1.0) ** 0.6) + 0.006
                ring = []
                for k in range(n):
                    a = 2 * math.pi * k / n
                    ring.append((s + half * math.sin(a), fs, top[2] + 0.01 - depth * (0.5 - 0.5 * math.cos(a))))
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


def door_patch(bl0, bl1, side, thickness=0.006):
    """Door panel following the lower skin between two butt lines over the well's FS range."""
    f0, f1 = WELL_FS

    def fn(u, v):
        p, n = surface_point(side * u, v)
        return p, n

    return A.solid_patch(fn, (bl0, bl1), (f0 + 0.004, f1 - 0.004), 7, 6, thickness)
