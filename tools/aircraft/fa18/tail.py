"""
F/A-18C tail: twin fins canted outward 20 degrees with rudders on their lower trailing edge,
all-moving stabilators with a little anhedral, and the speed brake on the spine between the
fins.

Pivots (identity rest rotation, extras.axis in the model frame, positive as named):
  Rudder_L/R      trailing edge right                    extras maxDeg
  Stabilator_L/R  leading edge down (trailing edge up)   extras upDeg, downDeg
  Speedbrake      opens (trailing edge up)               extras openDeg
"""

import math

import numpy as np

from lib import mesh as M
from lib import surfaces as S
from . import dims as D
from . import fuselage as F

FIN_FOIL = (0.0, 0.4, 0.045)
STAB_FOIL = (0.0, 0.4, 0.04)


def _fin_t(h):
    return min(max(h / D.FIN_SPAN, 0.0), 1.0)


# The fin in its own plane: span h along the fin, chord along FS; thickness along "BL".
FIN = S.Planform(lambda h: (D.FIN_ROOT_LE + h * math.tan(D.FIN_LE_SWEEP), 0.0),
                 lambda h: D.FIN_ROOT_CHORD + _fin_t(h) * (D.FIN_TIP_CHORD - D.FIN_ROOT_CHORD),
                 vertical=True)


def fin_xform(p, side):
    """Fin-plane point (thick, fs, h) -> design frame, canted outward on its side."""
    th, fs, h = p
    c, s = math.cos(D.FIN_CANT), math.sin(D.FIN_CANT)
    bl = D.FIN_ROOT_BL + h * s + th * c
    wl = D.FIN_ROOT_WL + h * c - th * s
    return np.array([side * bl, fs, wl])


def fin_loft(h0, h1, loop, side, step=0.2, cap=True):
    st = S.stations(h0, h1, step)
    rows = [[fin_xform(FIN.point(h, x, y), side) for x, y in loop] for h in st]
    n = len(rows[0])
    v = np.array([p for r in rows for p in r])
    f = M.grid_faces(len(rows), n, wrap_cols=True)
    if cap:
        c0 = len(v)
        v = np.vstack([v, v[:n].mean(0), v[-n:].mean(0)])
        f += M.fan_cap(list(range(n)), c0, reverse=True)
        f += M.fan_cap(list(range(len(v) - 2 - n, len(v) - 2)), c0 + 1)
    if side < 0:
        f = [tuple(reversed(x)) for x in f]
    return v, f


def _stab_t(s):
    return min(max((abs(s) - D.STAB_ROOT_BL) / (D.STAB_TIP_BL - D.STAB_ROOT_BL), 0.0), 1.0)


STAB = S.Planform(lambda s: (D.STAB_ROOT_LE + (abs(s) - D.STAB_ROOT_BL) * math.tan(D.STAB_LE_SWEEP),
                             D.STAB_WL - (abs(s) - D.STAB_ROOT_BL) * math.tan(D.STAB_ANHEDRAL)),
                  lambda s: D.STAB_ROOT_CHORD + _stab_t(s) * (D.STAB_TIP_CHORD - D.STAB_ROOT_CHORD))


def build(col, mats, parts):
    paint = mats["paint"]
    full = S.section_full(FIN_FOIL, n=30)
    box = S.section_box(FIN_FOIL, D.RUDDER_X + 0.02, D.RUDDER_X - 0.005, n=30, n_cove=5)
    mov, (hx, hy) = S.section_movable(FIN_FOIL, D.RUDDER_X + 0.008, n=20)
    fins = []
    r0, r1 = D.RUDDER_SPAN
    for side, sfx in ((1, "L"), (-1, "R")):
        # Fin: the full section above and below the rudder, the box beside it.
        fins.append(fin_loft(-0.25, r0, full, side))
        fins.append(fin_loft(r0, r1, box, side))
        fins.append(fin_loft(r1, D.FIN_SPAN, full, side, step=0.18))
        a = fin_xform(FIN.point(r0, hx, hy), side)
        b = fin_xform(FIN.point(r1, hx, hy), side)
        axis = (b - a) / np.linalg.norm(b - a)
        probe = fin_xform(FIN.point(0.5 * (r0 + r1), 1.0, 0.0), side)
        # Trailing edge right (towards -BL) for a positive turn, on both fins.
        want = np.array([-1.0, 0, 0])
        mid = 0.5 * (a + b)
        if np.dot(M.rot_axis(axis, 0.05) @ (probe - mid) + mid - probe, want) < 0:
            axis = -axis
        piv = M.empty(f"Rudder_{sfx}", col, M.P(*mid), props={"axis": M.model_axis(*axis), "maxDeg": 30.0})
        v, f = fin_loft(r0 + 0.006, r1 - 0.006, mov, side)
        o = M.make_object(f"Rudder_{sfx}_mesh", v, f, col, paint, sharp_angle=35, origin=M.P(*mid))
        M.parent_keep(o, piv)
        parts[f"Rudder_{sfx}"] = o
        # Stabilator: about a lateral axis through its pivot near the root.
        pv = np.array([side * D.STAB_ROOT_BL, D.STAB_PIVOT_FS, D.STAB_WL])
        ax = np.array([side * math.cos(D.STAB_ANHEDRAL), 0.0, -math.sin(D.STAB_ANHEDRAL)])
        probe = np.array([side * 2.0, 16.4, D.STAB_WL])
        if np.dot(M.rot_axis(ax, 0.05) @ (probe - pv) + pv - probe, np.array([0, 0, 1.0])) < 0:
            ax = -ax
        piv = M.empty(f"Stabilator_{sfx}", col, M.P(*pv),
                      props={"axis": M.model_axis(*ax), "upDeg": 24.0, "downDeg": 10.5})
        st = S.stations(side * (D.STAB_ROOT_BL - 0.12), side * D.STAB_TIP_BL, 0.25)
        sfull = S.section_full(STAB_FOIL, n=30)
        v, f = S.loft(STAB, st, lambda s: sfull, cap_start=True, cap_end=True)
        o = M.make_object(f"Stabilator_{sfx}_mesh", v, f, col, paint, sharp_angle=35, origin=M.P(*pv))
        M.parent_keep(o, piv)
        parts[f"Stabilator_{sfx}"] = o
    parts["Fins"] = M.make_object("Fins", *M.merge(fins), col, paint, sharp_angle=35)
    parts["Speedbrake"] = speedbrake(col, mats)
    return parts


def speedbrake(col, mats):
    fs0, fs1 = D.SPEEDBRAKE_FS
    hw = D.SPEEDBRAKE_HALF
    nu, nv = 9, 8
    verts = []
    for i in range(nu):
        bl = -hw + 2 * hw * i / (nu - 1)
        for j in range(nv):
            fs = fs0 + (fs1 - fs0) * j / (nv - 1)
            verts.append((bl, fs, F.wl_at(fs, bl) + 0.006))
    vo = np.array(verts)
    vi = vo - np.array([0, 0, 0.03])
    n = len(vo)
    fo = M.grid_faces(nu, nv)
    faces = [tuple(reversed(x)) for x in fo] + [tuple(i + n for i in x) for x in fo]
    idx = lambda i, j: i * nv + j  # noqa: E731
    ring = [idx(0, j) for j in range(nv)] + [idx(i, nv - 1) for i in range(1, nu)] + \
           [idx(nu - 1, j) for j in range(nv - 2, -1, -1)] + [idx(i, 0) for i in range(nu - 2, 0, -1)]
    for a, b in zip(ring, ring[1:] + ring[:1]):
        faces.append((a, b, b + n, a + n))
    v = np.vstack([vo, vi])
    hinge = np.array([0.0, fs0 + 0.02, F.wl_at(fs0, 0.0) - 0.01])
    piv = M.empty("Speedbrake", col, M.P(*hinge),
                  props={"axis": M.model_axis(1.0, 0, 0), "openDeg": D.SPEEDBRAKE_DEG})
    # Positive about +BL lifts the trailing edge (towards +WL).
    probe = np.array([0, fs1, hinge[2]])
    if np.dot(M.rot_axis((1.0, 0, 0), 0.05) @ (probe - hinge) + hinge - probe, np.array([0, 0, 1.0])) < 0:
        piv["axis"] = M.model_axis(-1.0, 0, 0)
    o = M.make_object("Speedbrake_mesh", v, faces, col, mats["paint"], sharp_angle=40, origin=M.P(*hinge))
    M.parent_keep(o, piv)
    # The well under it: a dark tray.
    wv = [(-hw + 0.02, fs0 + 0.02, F.wl_at(fs0, 0) - 0.12), (hw - 0.02, fs0 + 0.02, F.wl_at(fs0, 0) - 0.12),
          (hw - 0.02, fs1 - 0.03, F.wl_at(fs1, 0) - 0.08), (-hw + 0.02, fs1 - 0.03, F.wl_at(fs1, 0) - 0.08)]
    well = M.make_object("SpeedbrakeWell", np.array(wv), [(0, 1, 2, 3)], col, mats["well"], smooth=False)
    return o
