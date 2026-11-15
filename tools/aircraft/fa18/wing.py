"""
F/A-18C wing: a thin trapezoid (5 % at the root, 3.5 % at the tip, 26.7 degrees of leading-edge
sweep, 3 degrees of anhedral) with full-span leading-edge flaps (one hinge line across the fold),
single-slotted trailing-edge flaps inboard of the fold, ailerons outboard of it, and the
launch rail on the tip. The root runs under the LEX into the fuselage.

Pivots (identity rest rotation, extras.axis in the model frame, positive as named):
  LEF_L/R       leading edge down          extras maxDeg
  TEF_L/R       trailing edge down         extras maxDeg
  Aileron_L/R   trailing edge down         extras upDeg, downDeg
"""

import math

import numpy as np

from lib import mesh as M
from lib import surfaces as S
from . import dims as D


def _le(s):
    a = abs(s)
    return D.WING_ROOT_LE_FS + a * math.tan(D.LE_SWEEP), D.WING_WL - a * math.tan(D.ANHEDRAL)


def _chord(s):
    t = min(abs(s) / D.WING_TIP_BL, 1.0)
    return D.WING_ROOT_CHORD + t * (D.WING_TIP_CHORD - D.WING_ROOT_CHORD)


WING = S.Planform(_le, _chord, lambda s: 0.0)


def foil(s):
    t = min(abs(s) / D.WING_TIP_BL, 1.0)
    return (0.0, 0.4, D.ROOT_TC + t * (D.TIP_TC - D.ROOT_TC))


def _upper(f, x):
    xu, yu, _, _ = S.naca4(*f, np.asarray(x, float))
    return np.stack([xu, yu], -1)


def _lower(f, x):
    _, _, xl, yl = S.naca4(*f, np.asarray(x, float))
    return np.stack([xl, yl], -1)


def loop_nose(f, x_end, n=22):
    """Leading-edge flap: upper skin from its hinge forward round the nose, lower skin back."""
    s = M.cosine_spacing(n)
    up = _upper(f, (s * x_end)[::-1])
    lo = _lower(f, (s * x_end)[1:])
    return np.vstack([up, lo])


def loop_box(f, x0, x1, n=26):
    """Fixed box between the leading-edge flap's hinge and the trailing-edge cove."""
    xs = x0 + (x1 - x0) * M.cosine_spacing(n)
    up = _upper(f, xs[::-1])            # x1 -> x0 on top
    lo = _lower(f, xs)                  # x0 -> x1 below
    return np.vstack([up, lo])


def loop_movable(f, x_nose, n=22):
    return S.section_movable(f, x_nose, n=n)[0]


def piece(name, col, mat, s0, s1, loop_fn, step=0.25, origin=None, extra=(), sharp=35):
    st = S.stations(s0, s1, step, extra)
    v, f = S.loft(WING, st, loop_fn, cap_start=True, cap_end=True)
    return M.make_object(name, v, f, col, mat, smooth=True, sharp_angle=sharp, origin=origin)


def hinge_axis(a, b, probe, want):
    axis = (b - a) / np.linalg.norm(b - a)
    mid = 0.5 * (a + b)
    moved = M.rot_axis(axis, 0.05) @ (probe - mid) + mid
    if np.dot(moved - probe, want) < 0:
        axis = -axis
    return axis


def surface_pivot(col, name, s0, s1, x_hinge, probe_x, want, props):
    """Pivot on a hinge line at chord share x_hinge between spans s0 and s1 (on the mean line)."""
    a = WING.point(s0, x_hinge, 0.0)
    b = WING.point(s1, x_hinge, 0.0)
    probe = WING.point(0.5 * (s0 + s1), probe_x, 0.0)
    axis = hinge_axis(a, b, probe, want)
    mid = 0.5 * (a + b)
    pr = {"axis": M.model_axis(*axis)}
    pr.update(props)
    return M.empty(name, col, M.P(*mid), props=pr), mid


def surface_point(bl, fs, upper=False):
    c = _chord(bl)
    x = (fs - _le(bl)[0]) / c
    f = foil(bl)
    p = (_upper if upper else _lower)(f, [min(max(x, 0.0), 1.0)])[0]
    return WING.point(bl, p[0], p[1])


def build(col, mats, parts):
    paint = mats["paint"]
    box = lambda s: loop_box(foil(s), D.LEF_X + 0.004, D.TEF_X + 0.01)  # noqa: E731
    full_front = lambda s: loop_box(foil(s), 0.0, D.TEF_X + 0.01)  # noqa: E731
    nose = lambda s: loop_nose(foil(s), D.LEF_X)  # noqa: E731
    mov = lambda s: loop_movable(foil(s), D.TEF_X)  # noqa: E731
    breaks = [D.LEF_BL[0], D.TEF_BL[0], D.TEF_BL[1], D.FOLD_BL, D.AIL_BL[0], D.AIL_BL[1]]
    objs = []
    for side, sfx in ((1, "L"), (-1, "R")):
        sg = side
        objs.append(piece(f"WingBox_{sfx}", col, paint, sg * D.LEF_BL[0], sg * D.WING_TIP_BL, box,
                          extra=[sg * b for b in breaks]))
        # Inboard of the leading-edge flap the wing is fixed from the nose: under the LEX.
        objs.append(piece(f"WingRoot_{sfx}", col, paint, sg * 0.85, sg * D.LEF_BL[0], full_front, step=0.3))
        # Fixed trailing edge where no surface moves: the root, the fold, the tip.
        for a, b in ((0.85, D.TEF_BL[0]), (D.TEF_BL[1], D.AIL_BL[0]), (D.AIL_BL[1], D.WING_TIP_BL)):
            objs.append(piece(f"WingTE_{sfx}_{a:.2f}", col, paint, sg * (a + 0.004), sg * (b - 0.004), mov,
                              step=0.4))
        # Leading-edge flap.
        p, mid = surface_pivot(col, f"LEF_{sfx}", sg * D.LEF_BL[0], sg * D.LEF_BL[1], D.LEF_X, 0.0,
                               np.array([0, 0, -1.0]), {"maxDeg": 34.0})
        o = piece(f"LEF_{sfx}_mesh", col, paint, sg * (D.LEF_BL[0] + 0.005), sg * D.LEF_BL[1], nose,
                  origin=M.P(*mid), extra=[sg * D.FOLD_BL])
        M.parent_keep(o, p)
        parts[f"LEF_{sfx}"] = o
        # Trailing-edge flap.
        p, mid = surface_pivot(col, f"TEF_{sfx}", sg * D.TEF_BL[0], sg * D.TEF_BL[1], D.TEF_X + 0.02, 1.0,
                               np.array([0, 0, -1.0]), {"maxDeg": 45.0})
        o = piece(f"TEF_{sfx}_mesh", col, paint, sg * (D.TEF_BL[0] + 0.006), sg * (D.TEF_BL[1] - 0.006), mov,
                  origin=M.P(*mid))
        M.parent_keep(o, p)
        parts[f"TEF_{sfx}"] = o
        # Aileron (droops with the flaps).
        p, mid = surface_pivot(col, f"Aileron_{sfx}", sg * D.AIL_BL[0], sg * D.AIL_BL[1], D.TEF_X + 0.02, 1.0,
                               np.array([0, 0, -1.0]), {"upDeg": 30.0, "downDeg": 45.0})
        o = piece(f"Aileron_{sfx}_mesh", col, paint, sg * (D.AIL_BL[0] + 0.006), sg * (D.AIL_BL[1] - 0.006), mov,
                  origin=M.P(*mid))
        M.parent_keep(o, p)
        parts[f"Aileron_{sfx}"] = o
    parts["Wing"] = M.join(objs, "Wing")
    parts["Rails"] = rails(col, mats)
    return parts["Wing"]


def rails(col, mats):
    """Wing-tip launch rails: an adapter on the tip and the rail beam with its nose fairing."""
    out = []
    for side in (1, -1):
        le, wl = _le(D.WING_TIP_BL)
        c = _chord(D.WING_TIP_BL)
        bl = side * (D.RAIL_BL[0] + D.RAIL_BL[1]) / 2
        w = D.RAIL_BL[1] - D.RAIL_BL[0]
        # Adapter: a slab along the tip chord.
        out.append(M.rounded_box((side * (D.WING_TIP_BL + 0.05), le + c * 0.5, wl), (0.11, c * 0.92, 0.07), 0.02, 2))
        # Rail: a long beam from ahead of the tip leading edge, with a pointed nose.
        fs0, fs1 = le - 0.55, le + c + 0.05
        out.append(M.rounded_box((bl, (fs0 + fs1) / 2 + 0.1, wl - 0.02), (w, fs1 - fs0 - 0.2, 0.11), 0.025, 2))
        prof = [(0.0, 0.0), (0.05, 0.03), (0.15, 0.05), (0.28, 0.058)]
        out.append(M.lathe(prof, (bl, fs0 - 0.08, wl - 0.02), (0, 1.0, 0), n=12, close_start=False))
        # The rail's T-slot underneath.
        out.append(M.rounded_box((bl, (fs0 + fs1) / 2 + 0.15, wl - 0.095), (0.05, fs1 - fs0 - 0.4, 0.05), 0.01, 1))
    return M.make_object("Rails", *M.merge(out), col, mats["paint"], sharp_angle=40)
