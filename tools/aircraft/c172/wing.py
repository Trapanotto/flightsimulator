"""Wing, flaps, ailerons, horizontal tail with elevator and trim tab, fin with rudder."""

import math

import numpy as np

from lib import mesh as M
from lib import surfaces as S
from . import dims as D


# ---------------------------------------------------------------------------
# Planforms
# ---------------------------------------------------------------------------

def _wing_le(s):
    a = abs(s)
    if a <= D.PANEL_BREAK_BL:
        le = D.WING_ROOT_LE_FS
    else:
        t = (a - D.PANEL_BREAK_BL) / (D.TIP_BL - D.PANEL_BREAK_BL)
        le = D.WING_ROOT_LE_FS + t * (D.ROOT_CHORD - D.TIP_CHORD)
    wl = D.WING_WL + max(0.0, a - D.WING_ROOT_BL) * math.tan(D.DIHEDRAL)
    return le, wl


def _wing_chord(s):
    return D.WING_TE_FS - _wing_le(s)[0]


def _wing_twist(s):
    a = abs(s)
    if a <= D.WING_ROOT_BL:
        return D.INCIDENCE_ROOT
    t = min((a - D.WING_ROOT_BL) / (D.SPAN / 2 - D.WING_ROOT_BL), 1.0)
    return D.INCIDENCE_ROOT + t * (D.INCIDENCE_TIP - D.INCIDENCE_ROOT)


WING = S.Planform(_wing_le, _wing_chord, _wing_twist)


def _hstab_le(s):
    t = abs(s) / D.HSTAB_HALF
    return D.HSTAB_ROOT_LE + t * (D.HSTAB_TIP_LE - D.HSTAB_ROOT_LE), D.HSTAB_WL


def _hstab_chord(s):
    t = min(abs(s) / D.HSTAB_HALF, 1.0)
    return D.HSTAB_ROOT_CHORD + t * (D.HSTAB_TIP_CHORD - D.HSTAB_ROOT_CHORD)


HSTAB = S.Planform(_hstab_le, _hstab_chord)


def _fin_t(s):
    return (s - D.FIN_ROOT_WL) / (D.FIN_TOP_WL - D.FIN_ROOT_WL)


FIN = S.Planform(lambda s: (D.FIN_ROOT_LE + _fin_t(s) * (D.FIN_TOP_LE - D.FIN_ROOT_LE), 0.0),
                 lambda s: D.FIN_ROOT_CHORD + _fin_t(s) * (D.FIN_TOP_CHORD - D.FIN_ROOT_CHORD),
                 vertical=True)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def piece(name, col, mat, plan, s0, s1, loop_fn, step=0.12, extra=(), caps=True, tip=None,
          origin=None, sharp=35):
    st = S.stations(s0, s1, step, extra)
    v, f = S.loft(plan, st, loop_fn, cap_start=caps, cap_end=caps and tip is None, tip=tip)
    return M.make_object(name, v, f, col, mat, smooth=True, sharp_angle=sharp, origin=origin)


def hinge(plan, s0, s1, foil, x_nose):
    """Pivot point and hinge axis (design frame) of a movable part between two span stations."""
    _, (cx, cy) = S.section_movable(foil, x_nose)
    a = plan.point(s0, cx, cy)
    b = plan.point(s1, cx, cy)
    return a, b


def oriented_axis(a, b, probe, want):
    """
    Hinge axis a->b or b->a such that a small positive rotation moves `probe` (a point on the
    trailing edge) in the direction `want` (design-frame vector). Returned in the model frame.
    """
    axis = (b - a) / np.linalg.norm(b - a)
    mid = 0.5 * (a + b)
    moved = M.rot_axis(axis, 0.05) @ (probe - mid) + mid
    if np.dot(moved - probe, want) < 0:
        axis = -axis
    return M.model_axis(*axis), axis


def pivot(name, col, a, b, probe, want, extra_props=None):
    model_ax, design_ax = oriented_axis(a, b, probe, want)
    mid = 0.5 * (a + b)
    props = {"axis": model_ax}
    props.update(extra_props or {})
    return M.empty(name, col, M.P(*mid), props=props), mid


# ---------------------------------------------------------------------------
# Wing
# ---------------------------------------------------------------------------

def build_wing(col, mats, parts):
    foil = D.WING_FOIL
    box = S.section_box(foil, D.WING_BOX_UPPER, D.WING_BOX_LOWER, n=44)
    mov, _ = S.section_movable(foil, D.WING_SURFACE_NOSE, n=26)
    full = S.section_full(foil, n=44)
    breaks = [D.WING_ROOT_BL, D.PANEL_BREAK_BL, *D.FLAP_BL, *D.AILERON_BL]
    breaks = breaks + [-b for b in breaks]
    parts["Wing"] = piece("Wing", col, mats["paint"], WING, -D.TIP_BL, D.TIP_BL, lambda s: box,
                          step=0.14, extra=breaks)
    parts["WingCentreTE"] = piece("WingCentreTE", col, mats["paint"], WING, -D.FLAP_BL[0] + 0.01,
                                  D.FLAP_BL[0] - 0.01, lambda s: mov, step=0.2)
    for side, sfx in ((1, "L"), (-1, "R")):
        # Fixed trailing edge between aileron and tip, and the moulded tip.
        parts[f"WingTipTE_{sfx}"] = piece(f"WingTipTE_{sfx}", col, mats["paint"], WING,
                                          side * (D.AILERON_BL[1] + 0.01), side * D.TIP_BL,
                                          lambda s: mov, step=0.2)
        tip_len = D.SPAN / 2 - D.TIP_BL
        parts[f"WingTip_{sfx}"] = piece(f"WingTip_{sfx}", col, mats["paint"], WING,
                                        side * (D.TIP_BL - 0.001), side * D.TIP_BL, lambda s: full,
                                        step=0.5, caps=True, tip=(tip_len, 0.035, 9))
        # Flap: hinge at the nose; moves back along its tracks and turns down (Fowler-like).
        f0, f1 = side * D.FLAP_BL[0], side * D.FLAP_BL[1]
        a, b = hinge(WING, f0, f1, foil, D.WING_SURFACE_NOSE)
        te = WING.point(0.5 * (f0 + f1), 1.0, 0.0)
        slide = M.model_axis(0, 1.0, -0.22)
        p, mid = pivot(f"Flap_{sfx}", col, a, b, te, np.array([0, 0, -1.0]),
                       {"slide": [c * 0.155 for c in slide], "maxDeg": 30.0})
        o = piece(f"Flap_{sfx}_mesh", col, mats["paint"], WING, f0, f1, lambda s: mov, step=0.18,
                  origin=M.P(*mid))
        M.parent_keep(o, p)
        parts[f"Flap_{sfx}"] = o
        # Aileron (172S: 20 deg up, 15 deg down). Positive = trailing edge down.
        a0, a1 = side * D.AILERON_BL[0], side * D.AILERON_BL[1]
        a, b = hinge(WING, a0, a1, foil, D.WING_SURFACE_NOSE)
        te = WING.point(0.5 * (a0 + a1), 1.0, 0.0)
        p, mid = pivot(f"Aileron_{sfx}", col, a, b, te, np.array([0, 0, -1.0]),
                       {"upDeg": 20.0, "downDeg": 15.0})
        o = piece(f"Aileron_{sfx}_mesh", col, mats["paint"], WING, a0, a1, lambda s: mov, step=0.18,
                  origin=M.P(*mid))
        M.parent_keep(o, p)
        parts[f"Aileron_{sfx}"] = o


def wing_point(bl, x, y):
    """Point on the wing (design frame) at butt line `bl`, chord fraction x, thickness y."""
    return WING.point(bl, x, y)


def wing_surface(bl, x, upper=True):
    xu, yu, xl, yl = S.naca4(*D.WING_FOIL, np.array([x]))
    return WING.point(bl, float((xu if upper else xl)[0]), float((yu if upper else yl)[0]))


# ---------------------------------------------------------------------------
# Horizontal tail
# ---------------------------------------------------------------------------

def build_htail(col, mats, parts):
    foil = D.HSTAB_FOIL
    box = S.section_box(foil, D.ELEV_NOSE + 0.02, D.ELEV_NOSE - 0.005, n=34, n_cove=5)
    mov, _ = S.section_movable(foil, D.ELEV_NOSE + 0.008, n=24)
    cut, _ = S.section_movable(foil, D.ELEV_NOSE + 0.008, n=23, x_end=0.88)
    tab, _ = S.section_movable(foil, 0.886, n=8, n_nose=6)
    full = S.section_full(foil, n=34)
    parts["HStab"] = piece("HStab", col, mats["paint"], HSTAB, -D.HSTAB_HORN_BL, D.HSTAB_HORN_BL,
                           lambda s: box, step=0.15, extra=[0.0])
    # One elevator node moves both halves (they are joined by a torque tube).
    a, b = hinge(HSTAB, -D.HSTAB_HALF, D.HSTAB_HALF, foil, D.ELEV_NOSE + 0.008)
    te = HSTAB.point(1.0, 1.0, 0.0)
    elev, mid = pivot("Elevator", col, a, b, te, np.array([0, 0, 1.0]),
                      {"upDeg": 28.0, "downDeg": 23.0})
    meshes = []
    for side, sfx in ((1, "L"), (-1, "R")):
        s_in, s_horn = side * D.ELEV_INNER_BL, side * (D.HSTAB_HORN_BL + 0.012)
        if side > 0:
            meshes.append(piece("Elevator_L_mesh", col, mats["paint"], HSTAB, s_in, side * D.HSTAB_HORN_BL,
                                lambda s: mov, step=0.15, origin=M.P(*mid)))
        else:
            # The right elevator carries the trim tab in a notch of its trailing edge.
            t0, t1 = -0.16, -0.62
            meshes.append(piece("Elevator_R1", col, mats["paint"], HSTAB, s_in, t0, lambda s: mov,
                                step=0.15, origin=M.P(*mid)))
            meshes.append(piece("Elevator_R2", col, mats["paint"], HSTAB, t0, t1, lambda s: cut,
                                step=0.15, origin=M.P(*mid), sharp=60))
            meshes.append(piece("Elevator_R3", col, mats["paint"], HSTAB, t1, -D.HSTAB_HORN_BL,
                                lambda s: mov, step=0.15, origin=M.P(*mid)))
            ta, tb = hinge(HSTAB, t0 - 0.005, t1 + 0.005, foil, 0.886)
            tte = HSTAB.point(0.5 * (t0 + t1), 1.0, 0.0)
            tp, tmid = pivot("TrimTab", col, ta, tb, tte, np.array([0, 0, 1.0]),
                             {"upDeg": 22.0, "downDeg": 19.0})
            tab_obj = piece("TrimTab_mesh", col, mats["paint"], HSTAB, t0 - 0.005, t1 + 0.005,
                            lambda s: tab, step=0.2, origin=M.P(*tmid), sharp=60)
            M.parent_keep(tab_obj, tp)
            M.parent_keep(tp, elev)
            parts["TrimTab"] = tab_obj
        # Horn balance: outboard the elevator runs to the leading edge, with a round tip.
        tip_len = D.HSTAB_HALF - abs(s_horn) - 0.06
        meshes.append(piece(f"ElevatorHorn_{sfx}", col, mats["paint"], HSTAB, s_horn,
                            s_horn + side * 0.06, lambda s: full, step=0.1,
                            tip=(tip_len, 0.0, 8), origin=M.P(*mid)))
    e = M.join(meshes, "Elevator_mesh")
    M.parent_keep(e, elev)
    parts["Elevator"] = e


# ---------------------------------------------------------------------------
# Fin and rudder
# ---------------------------------------------------------------------------

def build_vtail(col, mats, parts):
    foil = D.FIN_FOIL
    box = S.section_box(foil, D.RUDDER_NOSE + 0.02, D.RUDDER_NOSE - 0.005, n=34, n_cove=5)
    mov, _ = S.section_movable(foil, D.RUDDER_NOSE + 0.008, n=24)
    full = S.section_full(foil, n=34)
    parts["Fin"] = piece("Fin", col, mats["paint"], FIN, D.FIN_ROOT_WL - 0.12, D.RUDDER_HORN_WL,
                         lambda s: box, step=0.12)
    a, b = hinge(FIN, D.RUDDER_BOTTOM_WL, D.FIN_TOP_WL, foil, D.RUDDER_NOSE + 0.008)
    te = FIN.point(1.8, 1.0, 0.0)
    # Positive = trailing edge to the right (nose right); right is -BL.
    rud, mid = pivot("Rudder", col, a, b, te, np.array([-1.0, 0, 0]),
                     {"leftDeg": 17.7, "rightDeg": 16.2})
    m1 = piece("Rudder_main", col, mats["paint"], FIN, D.RUDDER_BOTTOM_WL, D.RUDDER_HORN_WL + 0.012,
               lambda s: mov, step=0.12, origin=M.P(*mid))
    tip_len = D.FIN_TOP_WL - D.RUDDER_HORN_WL - 0.07
    m2 = piece("Rudder_horn", col, mats["paint"], FIN, D.RUDDER_HORN_WL + 0.012,
               D.RUDDER_HORN_WL + 0.07, lambda s: full, step=0.1, tip=(tip_len, 0.0, 8),
               origin=M.P(*mid))
    r = M.join([m1, m2], "Rudder_mesh")
    M.parent_keep(r, rud)
    parts["Rudder"] = r
    parts["Dorsal"] = dorsal(col, mats)


def dorsal(col, mats):
    """Dorsal fin: a thin fillet from the tailcone into the fin's leading edge."""
    from .fuselage import key, TOP
    fs = np.linspace(4.15, 6.05, 26)
    rows = []
    n = 16
    for x in fs:
        base = float(key(TOP, x)) - 0.03
        t = (x - 4.15) / (6.05 - 4.15)
        h = 0.36 * t ** 1.35 + 0.03
        w = 0.012 + 0.03 * math.sqrt(t)
        ring = []
        for k in range(n):
            a = 2 * math.pi * k / n
            # Lens section: wide at the base, sharp at the top.
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
    return M.make_object("Dorsal", v, f, col, mats["paint"], smooth=True, sharp_angle=60)
