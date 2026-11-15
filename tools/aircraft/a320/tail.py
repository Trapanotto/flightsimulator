"""
A320 tail: the swept fin with the rudder, the trimmable horizontal stabiliser (THS) with its
elevators, the dorsal fillet and the APU exhaust at the end of the cone.

  Stabilizer    THS, leading edge down = nose-up trim (extras upDeg, downDeg)
  Elevator      both elevators, trailing edge up (child of Stabilizer)
  Rudder        trailing edge right
"""

import math

import numpy as np

from lib import mesh as M
from lib import surfaces as S
from . import dims as D
from .fuselage import T
from .wing import oriented_axis, piece


def _fin_t(s):
    return (s - D.FIN_ROOT_WL) / (D.FIN_TOP_WL - D.FIN_ROOT_WL)


FIN = S.Planform(lambda s: (D.FIN_ROOT_LE + (s - D.FIN_ROOT_WL) * math.tan(D.FIN_SWEEP), 0.0),
                 lambda s: D.FIN_ROOT_CHORD + _fin_t(s) * (D.FIN_TOP_CHORD - D.FIN_ROOT_CHORD),
                 vertical=True)
FIN_FOIL = (0.0, 0.3, 0.105)


def _hs_t(s):
    return min(abs(s) / D.HSTAB_HALF, 1.0)


HSTAB = S.Planform(lambda s: (D.HSTAB_ROOT_LE + abs(s) * math.tan(D.HSTAB_SWEEP),
                              D.HSTAB_WL + abs(s) * math.tan(D.HSTAB_DIHEDRAL)),
                   lambda s: D.HSTAB_ROOT_CHORD + _hs_t(s) * (D.HSTAB_TIP_CHORD - D.HSTAB_ROOT_CHORD))
HS_FOIL = (0.0, 0.3, 0.10)


def _hinge(plan, foil, s0, s1, x_nose):
    _, (cx, cy) = S.section_movable(foil, x_nose)
    return plan.point(s0, cx, cy), plan.point(s1, cx, cy)


def build(col, mats, parts):
    # --- fin and rudder ---------------------------------------------------------------------
    box = S.section_box(FIN_FOIL, D.RUDDER_NOSE + 0.03, D.RUDDER_NOSE - 0.005, n=36, n_cove=5)
    mov, _ = S.section_movable(FIN_FOIL, D.RUDDER_NOSE + 0.008, n=22)
    full = S.section_full(FIN_FOIL, n=36)
    parts["Fin"] = piece("Fin", col, mats["paint"], FIN, 5.2, D.FIN_TOP_WL, lambda s: box, step=0.5)
    parts["FinCap"] = piece("FinCap", col, mats["paint"], FIN, D.FIN_TOP_WL - 0.02, D.FIN_TOP_WL + 0.14,
                            lambda s: full * np.array([1.0, 1.0 - 0.8 * max(0.0, s - D.FIN_TOP_WL) / 0.14]),
                            step=0.05, caps=True)
    rudder_top = D.FIN_TOP_WL - 0.06
    a, b = _hinge(FIN, FIN_FOIL, D.RUDDER_BOTTOM_WL, rudder_top, D.RUDDER_NOSE + 0.008)
    te = FIN.point(8.0, 1.0, 0.0)
    model_ax, _ = oriented_axis(a, b, te, np.array([-1.0, 0, 0]))
    mid = 0.5 * (a + b)
    rud = M.empty("Rudder", col, M.P(*mid), props={"axis": model_ax, "leftDeg": 30.0, "rightDeg": 30.0})
    r = piece("Rudder_mesh", col, mats["paint"], FIN, D.RUDDER_BOTTOM_WL, rudder_top, lambda s: mov,
              step=0.6, origin=M.P(*mid))
    M.parent_keep(r, rud)
    parts["Rudder"] = r
    # --- THS and elevators ------------------------------------------------------------------
    trim_at = np.array([0.0, D.THS_PIVOT_FS, D.HSTAB_WL + 0.05])
    stab = M.empty("Stabilizer", col, M.P(*trim_at),
                   props={"axis": M.model_axis(1.0, 0.0, 0.0), "upDeg": 13.5, "downDeg": 4.0})
    hbox = S.section_box(HS_FOIL, D.ELEV_NOSE + 0.03, D.ELEV_NOSE - 0.005, n=34, n_cove=5)
    hmov, _ = S.section_movable(HS_FOIL, D.ELEV_NOSE + 0.008, n=22)
    hs = piece("HStab", col, mats["paint"], HSTAB, -D.HSTAB_HALF, D.HSTAB_HALF, lambda s: hbox, step=0.5,
               extra=[0.0, 0.9, -0.9], origin=M.P(*trim_at))
    M.parent_keep(hs, stab)
    parts["HStab"] = hs
    for side, sfx in ((1, "L"), (-1, "R")):
        s0, s1 = side * 0.9, side * (D.HSTAB_HALF - 0.1)
        a, b = _hinge(HSTAB, HS_FOIL, s0, s1, D.ELEV_NOSE + 0.008)
        te = HSTAB.point(0.5 * (s0 + s1), 1.0, 0.0)
        model_ax, _ = oriented_axis(a, b, te, np.array([0, 0, 1.0]))
        emid = 0.5 * (a + b)
        elev = M.empty(f"Elevator_{sfx}", col, M.P(*emid),
                       props={"axis": model_ax, "upDeg": 30.0, "downDeg": 17.0})
        e = piece(f"Elevator_{sfx}_mesh", col, mats["paint"], HSTAB, s0, s1, lambda s: hmov, step=0.6,
                  origin=M.P(*emid))
        M.parent_keep(e, elev)
        M.parent_keep(elev, stab)
        parts[f"Elevator_{sfx}"] = e
    parts["TailFairings"] = fairings(col, mats)
    return stab


def fairings(col, mats):
    parts = []
    # Dorsal fillet from the cone into the fin's leading edge.
    fs = np.linspace(26.6, D.FIN_ROOT_LE + 1.0, 22)
    rows = []
    n = 14
    for x in fs:
        base = float(T.key(T.top, x)) - 0.05
        t = (x - fs[0]) / (fs[-1] - fs[0])
        h = 0.75 * t ** 1.8 + 0.02
        w = 0.02 + 0.13 * math.sqrt(t)
        ring = []
        for k in range(n):
            a = 2 * math.pi * k / n
            u = (math.sin(a) + 1) / 2
            ring.append((w * math.cos(a) * (1 - 0.8 * u), x, base + h * u))
        rows.append(ring)
    v = np.array([p for r in rows for p in r])
    f = M.grid_faces(len(fs), n, wrap_cols=True)
    c = len(v)
    v = np.vstack([v, [np.mean(rows[0], 0)], [np.mean(rows[-1], 0)]])
    f += M.fan_cap(list(range(n)), c, reverse=True)
    last = (len(fs) - 1) * n
    f += M.fan_cap(list(range(last, last + n)), c + 1)
    parts.append((v, f))
    v, f = M.merge(parts)
    return M.make_object("TailFairings", v, f, col, mats["paint"], sharp_angle=45)


def apu_exhaust(col, mats):
    """The APU exhaust: a short oval pipe out of the cone's end, dark inside."""
    end = D.TAIL_END_FS
    c = np.array([0.0, end, float(T.key(T.mid, end)) + 0.02])
    outer = M.lathe([(-0.05, 0.27), (0.12, 0.24), (0.37, 0.20), (0.37, 0.17), (0.20, 0.17)], c, (0, 1.0, 0),
                    n=24, close_start=False, close_end=False)
    inner = M.lathe([(0.20, 0.17), (0.0, 0.0)], c, (0, 1.0, 0), n=24, close_start=False, close_end=False)
    a = M.make_object("ApuExhaust", *outer, col, mats["exhaust"], sharp_angle=50)
    b = M.make_object("ApuExhaustIn", *inner, col, mats["exhaust"], sharp_angle=50)
    return M.join([a, b], "ApuExhaust")
