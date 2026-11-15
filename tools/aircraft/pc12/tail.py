"""
PC-12 tail: swept fin with a rudder that reaches below the tail cone, the T-tail on top with
a trimmable stabiliser (the PC-12 trims in pitch by moving the whole stabiliser) carrying the
elevator, the bullet fairing at the junction, a dorsal fin and two ventral strakes.
"""

import math

import numpy as np

from lib import mesh as M
from lib import surfaces as S
from . import dims as D
from .wing import oriented_axis, piece


def _fin_t(s):
    return (s - D.FIN_ROOT_WL) / (D.FIN_TOP_WL - D.FIN_ROOT_WL)


FIN = S.Planform(lambda s: (D.FIN_ROOT_LE + _fin_t(s) * (D.FIN_TOP_LE - D.FIN_ROOT_LE), 0.0),
                 lambda s: D.FIN_ROOT_CHORD + _fin_t(s) * (D.FIN_TOP_CHORD - D.FIN_ROOT_CHORD),
                 vertical=True)
FIN_FOIL = (0.0, 0.3, 0.10)


def _hs_t(s):
    return min(abs(s) / D.HSTAB_HALF, 1.0)


HSTAB = S.Planform(lambda s: (D.HSTAB_ROOT_LE + _hs_t(s) * (D.HSTAB_TIP_LE - D.HSTAB_ROOT_LE), D.HSTAB_WL),
                   lambda s: D.HSTAB_ROOT_CHORD + _hs_t(s) * (D.HSTAB_TIP_CHORD - D.HSTAB_ROOT_CHORD))
HS_FOIL = (0.0, 0.3, 0.11)
RUDDER_TOP_WL = 3.96


def _hinge(plan, foil, s0, s1, x_nose):
    _, (cx, cy) = S.section_movable(foil, x_nose)
    return plan.point(s0, cx, cy), plan.point(s1, cx, cy)


def build(col, mats, parts):
    # --- fin and rudder ---------------------------------------------------------------------
    box = S.section_box(FIN_FOIL, D.RUDDER_NOSE + 0.02, D.RUDDER_NOSE - 0.005, n=36, n_cove=5)
    mov, _ = S.section_movable(FIN_FOIL, D.RUDDER_NOSE + 0.008, n=24)
    parts["Fin"] = piece("Fin", col, mats["paint"], FIN, 2.10, D.FIN_TOP_WL, lambda s: box, step=0.14)
    a, b = _hinge(FIN, FIN_FOIL, D.RUDDER_BOTTOM_WL, RUDDER_TOP_WL, D.RUDDER_NOSE + 0.008)
    te = FIN.point(3.0, 1.0, 0.0)
    model_ax, _ = oriented_axis(a, b, te, np.array([-1.0, 0, 0]))
    mid = 0.5 * (a + b)
    rud = M.empty("Rudder", col, M.P(*mid), props={"axis": model_ax, "leftDeg": 25.0, "rightDeg": 25.0})
    r = piece("Rudder_mesh", col, mats["paint"], FIN, D.RUDDER_BOTTOM_WL, RUDDER_TOP_WL, lambda s: mov,
              step=0.14, origin=M.P(*mid))
    M.parent_keep(r, rud)
    parts["Rudder"] = r
    wicks = []
    for s in (2.6, 3.6):
        tep = FIN.point(s, 1.0, 0.0)
        wicks.append(M.tube_path([tep - np.array([0, 0.02, 0]), tep + np.array([0, 0.11, -0.02])], [0.003, 0.0018], 5))
    w = M.make_object("Wicks_Rudder", *M.merge(wicks), col, mats["antenna"], sharp_angle=40, origin=M.P(*mid))
    M.parent_keep(w, rud)
    # --- stabiliser (trims) and elevator ----------------------------------------------------
    trim_at = np.array([0.0, D.HSTAB_TRIM_FS, D.HSTAB_WL])
    stab = M.empty("Stabilizer", col, M.P(*trim_at),
                   props={"axis": M.model_axis(1.0, 0.0, 0.0), "upDeg": D.STAB_TRIM_UP_DEG,
                          "downDeg": D.STAB_TRIM_DN_DEG})
    # Positive about +BL turns the leading edge down (nose-up trim), as the elevator's sense.
    hbox = S.section_box(HS_FOIL, D.ELEV_NOSE + 0.02, D.ELEV_NOSE - 0.005, n=36, n_cove=5)
    hmov, _ = S.section_movable(HS_FOIL, D.ELEV_NOSE + 0.008, n=24)
    hfull = S.section_full(HS_FOIL, n=36)
    hs = piece("HStab", col, mats["paint"], HSTAB, -D.ELEV_HORN_BL, D.ELEV_HORN_BL, lambda s: hbox, step=0.16,
               extra=[0.0], origin=M.P(*trim_at))
    M.parent_keep(hs, stab)
    parts["HStab"] = hs
    a, b = _hinge(HSTAB, HS_FOIL, -D.HSTAB_HALF, D.HSTAB_HALF, D.ELEV_NOSE + 0.008)
    te = HSTAB.point(1.0, 1.0, 0.0)
    model_ax, _ = oriented_axis(a, b, te, np.array([0, 0, 1.0]))
    emid = 0.5 * (a + b)
    elev = M.empty("Elevator", col, M.P(*emid), props={"axis": model_ax, "upDeg": 25.0, "downDeg": 18.0})
    meshes = []
    for side, sfx in ((1, "L"), (-1, "R")):
        s_in, s_horn = side * 0.10, side * (D.ELEV_HORN_BL + 0.012)
        meshes.append(piece(f"Elevator_{sfx}1", col, mats["paint"], HSTAB, s_in, side * D.ELEV_HORN_BL,
                            lambda s: hmov, step=0.16, origin=M.P(*emid)))
        tip_len = D.HSTAB_HALF - abs(s_horn) - 0.06
        meshes.append(piece(f"ElevatorHorn_{sfx}", col, mats["paint"], HSTAB, s_horn, s_horn + side * 0.06,
                            lambda s: hfull, step=0.1, tip=(tip_len, 0.0, 8), origin=M.P(*emid)))
    e = M.join(meshes, "Elevator_mesh")
    M.parent_keep(e, elev)
    M.parent_keep(elev, stab)
    parts["Elevator"] = e
    wicks = []
    for side in (1, -1):
        for s in (1.2, 2.1):
            tep = HSTAB.point(side * s, 1.0, 0.0)
            wicks.append(M.tube_path([tep - np.array([0, 0.02, 0]), tep + np.array([0, 0.1, 0.0])], [0.003, 0.0018], 5))
    w = M.make_object("Wicks_Elevator", *M.merge(wicks), col, mats["antenna"], sharp_angle=40, origin=M.P(*emid))
    M.parent_keep(w, elev)
    # --- fairings -------------------------------------------------------------------------
    parts["TailFairings"] = fairings(col, mats)
    return stab


def fairings(col, mats):
    parts = []
    # Bullet at the fin-stabiliser junction.
    prof = []
    L = 1.62
    for t in np.linspace(0, 1, 22):
        r = 0.105 * math.sqrt(max(math.sin(math.pi * min(t * 1.15, 1.0)), 0.0)) ** 0.9 * (1 - 0.5 * t) + 0.004
        prof.append((t * L, r))
    prof[0] = (0.0, 0.0)
    parts.append(M.lathe(prof, (0.0, 12.62, D.HSTAB_WL + 0.03), (0, 1.0, 0), n=24, close_start=False,
                         close_end=True))
    # Dorsal fin: a thin fillet from the cone into the fin's leading edge.
    from .fuselage import T
    fs = np.linspace(9.4, 11.55, 24)
    rows = []
    n = 16
    for x in fs:
        base = float(T.key(T.top, x)) - 0.03
        t = (x - fs[0]) / (fs[-1] - fs[0])
        h = 0.42 * t ** 1.5 + 0.02
        w = 0.012 + 0.04 * math.sqrt(t)
        ring = []
        for k in range(n):
            a = 2 * math.pi * k / n
            u = (math.sin(a) + 1) / 2
            ring.append((w * math.cos(a) * (1 - 0.85 * u), x, base + h * u))
        rows.append(ring)
    v = np.array([p for r in rows for p in r])
    f = M.grid_faces(len(fs), n, wrap_cols=True)
    c = len(v)
    v = np.vstack([v, [np.mean(rows[0], 0)], [np.mean(rows[-1], 0)]])
    f += M.fan_cap(list(range(n)), c, reverse=True)
    last = (len(fs) - 1) * n
    f += M.fan_cap(list(range(last, last + n)), c + 1)
    parts.append((v, f))
    # Ventral strakes: two fins under the tail cone, leaning out.
    for side in (1, -1):
        root = []
        for x in np.linspace(11.0, 12.9, 12):
            wl = float(T.key(T.bot, x))
            bl = 0.55 * float(T.key(T.half, x))
            root.append((x, bl, T.wl_at(x, bl, False)))
        h = 0.26
        lean = math.radians(40)
        d = np.array([side * math.sin(lean), 0.0, -math.cos(lean)])
        rows = []
        for i, (x, bl, wl) in enumerate(root):
            t = i / (len(root) - 1)
            hh = h * math.sin(math.pi * min(t * 1.3, 1.0) ** 0.7) * (1 - 0.35 * t) + 0.01
            base = np.array([side * bl, x, wl + 0.01])
            th = 0.012
            nrm = np.array([math.cos(lean), 0.0, side * math.sin(lean)]) * side
            rows.append([base + nrm * th, base + d * hh + nrm * th * 0.3, base + d * hh - nrm * th * 0.3,
                         base - nrm * th])
        v = np.array([p for r in rows for p in r])
        f = M.grid_faces(len(rows), 4, wrap_cols=True)
        f += [(0, 1, 2, 3)[::-1], tuple(range((len(rows) - 1) * 4, len(rows) * 4))]
        parts.append((v, f))
    v, f = M.merge(parts)
    return M.make_object("TailFairings", v, f, col, mats["paint"], sharp_angle=45)
