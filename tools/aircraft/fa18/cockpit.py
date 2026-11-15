"""
F/A-18C front office: the main instrument panel (two digital display indicators left and
right, the up-front control under the head-up display, the multi-purpose colour display
between the knees, the fuel and engine indicator, the standby instruments, the caution
lights), its two angled wings with the gear handle (left) and the hook handle (right), the
glareshield with the head-up display and the angle-of-attack indexer, the left and right
consoles, the ejection seat, the stick and the rudder pedals.

Frames (3x3, columns = x right, y up, z out of the surface as the pilot sees it) for each
mounting surface; pp(), wing_point() and cl() give design-frame points on them.
"""

import math

import numpy as np

from lib import cockpit_kit as K
from lib import mesh as M
from . import dims as D
from . import fuselage as F

# --- main panel: nearly upright, leaning 10 degrees forward at the top ----------------------
TILT = math.radians(10)
PANEL_O = np.array([0.0, D.PANEL_FS, 2.04])
VX = np.array([1.0, 0.0, 0.0])
VV = np.array([0.0, -math.sin(TILT), math.cos(TILT)])
VN = np.array([0.0, math.cos(TILT), math.sin(TILT)])
PANEL_R = np.column_stack([-VX, VV, VN])
PANEL_H = 0.55
PANEL_HALF = 0.27

# The head-up display: the combiner glass and the plane its symbols are drawn in (normal to the
# boresight, so the picture can be computed for the eye point exactly).
HUD_FS = 3.90
HUD_CENTRE_WL = D.EYE[2] - 0.012
HUD_GLASS_H = 0.215
HUD_PLANE = (0.24, 0.22)


def pp(bl, v, s=0.0):
    return PANEL_O + VX * bl + VV * v + VN * s


# --- panel wings: turned 35 degrees towards the pilot -----------------------------------------
WING_ANG = math.radians(35)
WING_W = 0.20


def wing_frame(side):
    """Left (side 1) or right (side -1) wing of the panel, facing in towards the pilot."""
    c, s = math.cos(WING_ANG), math.sin(WING_ANG)
    n = np.array([-side * s, c, 0.12])
    n /= np.linalg.norm(n)
    up = np.array([0, 0, 1.0]) - n * n[2]
    up /= np.linalg.norm(up)
    x = np.cross(up, n)
    return np.column_stack([x, up, n])


WL_R = wing_frame(1)
WR_R = wing_frame(-1)


def wing_point(side, u, v, s=0.0):
    """On a wing: u metres from its left edge as the pilot sees it, v up from the bottom."""
    frame = WL_R if side > 0 else WR_R
    inner = pp(side * PANEL_HALF, 0.0)
    x, y, z = frame[:, 0], frame[:, 1], frame[:, 2]
    left = inner - x * WING_W if side > 0 else inner
    return left + x * u + y * v + z * s


# --- consoles: horizontal, at the pilot's hips -------------------------------------------------
CON_WL = 2.30
CON_BL = (0.255, 0.445)
CON_FS = (4.02, 5.30)
CON_R = np.column_stack([(-1.0, 0, 0), (0, -1.0, 0), (0, 0, 1.0)])


def cl(bl, fs, s=0.0):
    return np.array([bl, fs, CON_WL + s])


def plate(origin, frame, w, h, depth, rad=0.004):
    v, f = M.rounded_box((0, 0, depth / 2), (w, h, depth), rad, 1)
    return K.to_design(origin, frame, v), f


def _slab(poly, at, depth=0.025):
    n = len(poly)
    pts = [at(x, y, s) for s in (-depth, 0.0) for x, y in poly]
    faces = [tuple(range(n)), tuple(range(n, 2 * n))[::-1]]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    return np.array(pts), faces


def panel(b):
    outline = [(-PANEL_HALF, 0.0), (PANEL_HALF, 0.0), (PANEL_HALF, PANEL_H), (-PANEL_HALF, PANEL_H)]
    b.add("panel", _slab(M.rounded_polygon(outline, 0.012, 2), lambda x, y, s: pp(-x, y, s)))
    for side in (1, -1):
        poly = [(0.0, 0.0), (WING_W, 0.0), (WING_W, PANEL_H * (0.92 if side < 0 else 0.86)),
                (0.0, PANEL_H * (0.86 if side < 0 else 0.92))]
        b.add("panel", _slab(poly, lambda x, y, s, side=side: wing_point(side, x, y, s)))
    # Displays: the DDIs and the MPCD with their bezels; plates of the IFEI and the standby group.
    for bl, v in DISPLAY_SPOTS.values():
        b.add("avionics_face", plate(pp(bl, v), PANEL_R, 0.172, 0.172, 0.018, 0.008))
        b.add("screen", plate(pp(bl, v, 0.0005), PANEL_R, 0.136, 0.136, 0.0182, 0.003))
    b.add("avionics_face", plate(pp(0.165, 0.10), PANEL_R, 0.13, 0.11, 0.012, 0.004))
    b.add("avionics_face", plate(pp(-0.175, 0.125), PANEL_R, 0.16, 0.20, 0.008, 0.004))
    # The UFC: a box standing proud of the top centre.
    b.add("avionics_face", plate(pp(0.0, 0.445), PANEL_R, 0.215, 0.15, UFC_S, 0.006))


DISPLAY_SPOTS = {"DDI_L": (0.168, 0.33), "DDI_R": (-0.168, 0.33), "MPCD": (0.0, 0.115)}
DISPLAY_SIZE = 0.128
UFC_S = 0.035


def glareshield(b):
    """Hood from the panel's top forward to the windscreen; the HUD stands on it."""
    top = pp(0, PANEL_H)
    prof = [(top[1] + 0.02, top[2] - 0.01), (top[1] - 0.02, top[2] + 0.04), (top[1] - 0.10, top[2] + 0.06),
            (D.WINDSCREEN_FS + 0.05, 2.505)]
    rows = []
    us = np.linspace(-1, 1, 21)
    for u in us:
        row = []
        for fs, wl in prof:
            hw = F.half_width_at(fs, min(wl, 2.5)) - 0.03
            row.append((u * hw, fs, wl - 0.02 * abs(u) ** 3))
        rows.append(row)
    v = np.array([p for r in rows for p in r])
    b.add("glareshield", (v, M.grid_faces(len(us), len(prof))))
    # HUD: the projector body, the combiner frame (the glass is its own part).
    hud_top = top[2] + 0.03
    b.add("plastic_black", M.rounded_box((0, 3.62, hud_top + 0.02), (0.20, 0.22, 0.05), 0.015, 2))
    b.add("plastic_black", M.rounded_box((0, 3.82, hud_top - 0.005), (0.24, 0.12, 0.02), 0.008, 2))
    for dx in (0.128, -0.128):
        b.add("panel", M.rounded_box((dx, HUD_FS, HUD_CENTRE_WL - 0.01), (0.008, 0.012, HUD_GLASS_H + 0.03), 0.003, 1))
    b.add("panel", M.rounded_box((0, HUD_FS, HUD_CENTRE_WL + HUD_GLASS_H / 2 + 0.004), (0.268, 0.014, 0.012),
                                 0.004, 1))


def consoles(b):
    for side in (1, -1):
        bl0, bl1 = CON_BL
        cx = side * (bl0 + bl1) / 2
        w = bl1 - bl0
        L = CON_FS[1] - CON_FS[0]
        cy = (CON_FS[0] + CON_FS[1]) / 2
        b.add("interior_dark", M.rounded_box((cx, cy, (CON_WL + D.COCKPIT_FLOOR_WL) / 2 - 0.004),
                                             (w, L, CON_WL - D.COCKPIT_FLOOR_WL), 0.012, 2))
        for f0, f1 in ((4.04, 4.28), (4.30, 4.70), (4.72, 4.98), (5.00, 5.28)):
            b.add("avionics_face", plate(cl(cx, (f0 + f1) / 2), CON_R, w - 0.01, f1 - f0 - 0.008, 0.006, 0.003))
        b.add("interior_dark", M.rounded_box((side * 0.45, 4.9, 2.47), (0.05, 1.6, 0.06), 0.015, 2))


def tub(b):
    rows = []
    for fs in np.linspace(3.80, 5.55, 12):
        rows.append([(-0.30, fs, D.COCKPIT_FLOOR_WL), (0.30, fs, D.COCKPIT_FLOOR_WL)])
    v = np.array([p for r in rows for p in r])
    b.add("interior_dark", (v, M.grid_faces(len(rows), 2)))
    b.add("interior", M.rounded_box((0, 5.62, 2.38), (0.80, 0.04, 0.62), 0.01, 1))
    b.add("interior_dark", M.rounded_box((0, 3.60, 2.05), (0.58, 0.20, 0.10), 0.01, 1))


def seat(b):
    """Ejection seat: bucket, back with the parachute pack, the head box, side rails."""
    b.add("seat_frame", M.rounded_box((0, 4.56, 2.18), (0.46, 0.44, 0.10), 0.02, 2))
    b.add("seat_cushion", M.rounded_box((0, 4.54, 2.25), (0.40, 0.40, 0.06), 0.02, 2))
    rot = M.rot_axis((1, 0, 0), math.radians(-16))
    back = M.rounded_box((0, 0, 0), (0.44, 0.13, 0.62), 0.03, 2)
    b.add("seat_cushion", (M.transform(back[0], rot=rot, offset=(0, 4.86, 2.58)), back[1]))
    head = M.rounded_box((0, 0, 0), (0.30, 0.16, 0.30), 0.04, 2)
    b.add("seat_frame", (M.transform(head[0], rot=rot, offset=(0, 4.95, 3.02)), head[1]))
    for dx in (-0.235, 0.235):
        rail = M.rounded_box((0, 0, 0), (0.04, 0.10, 1.05), 0.012, 1)
        b.add("seat_frame", (M.transform(rail[0], rot=rot, offset=(dx, 4.90, 2.62)), rail[1]))
    # The ejection handle on the front of the bucket, yellow and black.
    b.add("eject", M.tube_path([(0.07, 4.35, 2.19), (0.08, 4.32, 2.26), (-0.08, 4.32, 2.26), (-0.07, 4.35, 2.19)],
                               0.011, 8))


def stick(b):
    base = np.array([0.0, 4.16, D.COCKPIT_FLOOR_WL + 0.03])
    pitch = b.pivot("Stick", base, (1, 0, 0))
    roll = b.pivot("StickRoll", base, (0, -1, 0), parent=pitch)
    grip_top = base + np.array([0.0, 0.05, 0.40])
    parts = [M.cylinder(base, base + np.array([0, 0.03, 0.30]), 0.014, 12),
             M.tube_path([base + np.array([0, 0.03, 0.29]), base + np.array([0, 0.045, 0.36]), grip_top],
                         [0.022, 0.024, 0.02], 12),
             M.rounded_box(grip_top + np.array([0, 0.0, 0.01]), (0.045, 0.05, 0.035), 0.012, 2)]
    b.obj("StickGrip", M.merge(parts), "plastic_black", parent=roll, origin=M.P(*base), sharp=50)
    b.add("plastic_black", M.lathe([(0.0, 0.09), (0.05, 0.06), (0.10, 0.025)], base, (0, 0, 1.0), n=16,
                                   close_start=True, close_end=False))
    # Weapon release button and the trigger: dummies.
    b.obj("StickDummies", M.merge([M.cylinder(grip_top + np.array([0.014, 0.0, 0.026]),
                                              grip_top + np.array([0.014, 0.0, 0.036]), 0.006, 10),
                                   M.rounded_box(grip_top + np.array([0, -0.035, -0.04]), (0.012, 0.02, 0.03),
                                                 0.004, 1)]),
          "knob_red", parent=roll, origin=M.P(*base))
    b.parts["StickRoll"] = roll
    b.parts["GripTop"] = grip_top


def pedals(b):
    for which, dx in (("L", 0.13), ("R", -0.13)):
        piv = b.pivot(f"Pedals_{which}", np.array([dx, 3.84, 2.25]), (0, -1, 0),
                      props={"slide": [c * 0.06 for c in M.model_axis(0, -1, 0)]})
        foot = np.array([dx, 3.86, 2.12])
        pad = M.rounded_box((0, 0, 0), (0.10, 0.02, 0.16), 0.008, 1)
        rot = M.rot_axis((1, 0, 0), math.radians(-25))
        parts = [(M.transform(pad[0], rot=rot, offset=foot), pad[1]),
                 M.tube_path([foot + np.array([0, -0.03, 0.04]), np.array([dx, 3.80, 2.20])], 0.01, 8)]
        b.obj(f"Pedals_{which}_mesh", M.merge(parts), "steel", parent=piv, origin=M.P(dx, 3.84, 2.25))


def mirrors(b):
    for bl, fs in ((0.20, 4.16), (0.0, 4.14), (-0.20, 4.16)):
        top = float(F.KEY(F.TOP, fs))
        wl = top - 0.05 if bl == 0 else top - 0.10
        b.add("chrome", M.rounded_box((bl, fs + 0.035, wl), (0.06, 0.005, 0.02), 0.003, 1))
        b.add("plastic_black", M.rounded_box((bl, fs + 0.03, wl), (0.066, 0.004, 0.026), 0.004, 1))


def build(col, mats, root):
    b = K.Builder(col, mats, root)
    panel(b)
    glareshield(b)
    consoles(b)
    tub(b)
    seat(b)
    stick(b)
    pedals(b)
    mirrors(b)
    from . import controls
    P = controls.build(b)
    b.flush()
    eye = M.empty("Eye", col, M.P(*D.EYE), size=0.03)
    M.parent_keep(eye, root)
    return P
