"""
PC-12 NG flight deck in the manner of the Honeywell Primus Apex: four 10-inch displays in a
row (PFD, MFD, MFD, PFD), the flight guidance panel on the glareshield, display controllers
under the PFDs, the gear handle and the standby instrument on the centre panel, a pedestal
with the radio panel, power, condition and flap levers and the trims, an overhead panel with
the electrical, engine, lights, ice-protection and cabin switches, two yokes, rudder pedals,
crew seats and a few cabin seats.

Frames (3x3, columns = x right, y up, z out of the surface as the pilot sees it) for each
mounting surface; pp(), oo(), ff(), tt() and gg() give design-frame points on them.
"""

import math

import numpy as np

from lib import airframe as A
from lib import cockpit_kit as K
from lib import mesh as M
from . import dims as D
from .fuselage import T

# --- main panel: leans forward 12 degrees, bottom edge at FS PANEL_FS, WL 1.55 ---------------
TILT = math.radians(12)
PANEL_O = np.array([0.0, D.PANEL_FS, 1.55])
VX = np.array([1.0, 0.0, 0.0])                                   # +BL (pilot's left)
VV = np.array([0.0, -math.sin(TILT), math.cos(TILT)])            # up the panel
VN = np.array([0.0, math.cos(TILT), math.sin(TILT)])             # out of the panel, aft
PANEL_R = np.column_stack([-VX, VV, VN])
PANEL_H = 0.50
PANEL_HALF = 0.665

# Displays: centre BL, height up the panel; 10.4 in screens (0.211 x 0.158 m visible).
SCREEN = (0.211, 0.158)
DISPLAY_V = 0.375
DISPLAYS = {"PFD1": 0.455, "MFD1": 0.152, "MFD2": -0.152, "PFD2": -0.455}


def pp(bl, v, s=0.0):
    return PANEL_O + VX * bl + VV * v + VN * s


# --- glareshield face (flight guidance panel): vertical, facing aft -------------------------
GLARE_O = np.array([0.0, D.PANEL_FS - 0.085, 2.075])
GLARE_R = np.column_stack([(-1.0, 0, 0), (0, 0, 1.0), (0, 1.0, 0)])


def gg(bl, dz, s=0.0):
    return GLARE_O + np.array([bl, s, dz])


# --- pedestal: sloping radio face, then the flat top with the levers -------------------------
FACE_TILT = math.radians(50)        # from the horizontal
PED_FACE_O = np.array([0.0, D.PANEL_FS + 0.02, 1.535])            # top centre of the face
PF_V = np.array([0.0, -math.cos(FACE_TILT), math.sin(FACE_TILT)])   # up the face
PF_N = np.array([0.0, math.sin(FACE_TILT), math.cos(FACE_TILT)])    # out (up and aft)
FACE_R = np.column_stack([(-1.0, 0, 0), PF_V, PF_N])
FACE_H = 0.215
PED_HALF = 0.145
PED_TOP_WL = PED_FACE_O[2] - FACE_H * math.sin(FACE_TILT)
PED_TOP_FS0 = PED_FACE_O[1] + FACE_H * math.cos(FACE_TILT)
PED_TOP_FS1 = 4.36
TOP_R = np.column_stack([(-1.0, 0, 0), (0, -1.0, 0), (0, 0, 1.0)])   # x right, y forward, z up


def ff(u, y, s=0.0):
    """Point on the radio face: u metres right of its left edge, y down from its top."""
    return PED_FACE_O + (PED_HALF - u) * np.array([1.0, 0, 0]) - PF_V * y + PF_N * s


def tt(bl, fs, s=0.0):
    """Point on the pedestal top."""
    return np.array([bl, fs, PED_TOP_WL + s])


# --- overhead panel: on the roof ahead of the pilots' heads, facing down and a little aft ----
# Looking up at it from the seat, the top of the picture is aft: the panel's "up" is aft, so
# its labels read upright from the seat (and the frame stays right-handed).
OVH_TILT = math.radians(12)
OVH_O = np.array([0.0, 3.70, 2.505])                              # forward edge, centre
OV_V = np.array([0.0, math.cos(OVH_TILT), math.sin(OVH_TILT)])    # "up" on the panel = aft
OV_N = np.array([0.0, math.sin(OVH_TILT), -math.cos(OVH_TILT)])   # out of the panel: down, aft
OVH_R = np.column_stack([(-1.0, 0, 0), OV_V, OV_N])
OVH_LEN = 0.34
OVH_HALF = 0.25


def oo(bl, d, s=0.0):
    """Point on the overhead panel: BL, d metres aft of its forward edge, s out of it."""
    return OVH_O + np.array([bl, 0, 0]) + OV_V * d + OV_N * s


# ---------------------------------------------------------------------------------------------

def plate(origin, frame, w, h, depth, rad=0.004):
    """Rounded plate in a frame: centre `origin`, w x h, from the surface `depth` outwards."""
    v, f = M.rounded_box((0, 0, depth / 2), (w, h, depth), rad, 1)
    return K.to_design(origin, frame, v), f


def panel(b):
    # The panel: a slab with rounded corners, its lower corners cut for the knees.
    outline = [(-PANEL_HALF, 0.06), (-0.50, 0.0), (0.50, 0.0), (PANEL_HALF, 0.06), (PANEL_HALF, PANEL_H),
               (-PANEL_HALF, PANEL_H)]
    poly = M.rounded_polygon(outline, 0.025, 3)
    pts = []
    n = len(poly)
    for s in (-0.03, 0.0):
        for x, y in poly:
            pts.append(pp(-x, y, s))
    faces = [tuple(range(n)), tuple(range(n, 2 * n))[::-1]]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    b.add("panel", (np.array(pts), faces))
    # Display units: a bezel with the screen recessed and softkeys along the bottom.
    for did, bl in DISPLAYS.items():
        c = pp(bl, DISPLAY_V)
        w, h = SCREEN
        b.add("avionics_face", plate(c, PANEL_R, w + 0.045, h + 0.058, 0.016, 0.006))
        b.add("screen", plate(c + VN * 0.0005, PANEL_R, w + 0.006, h + 0.006, 0.0162, 0.002))
        for i in range(6):
            x = (i - 2.5) * (w / 6.0)
            k = c + (-x) * VX - VV * (h / 2 + 0.017) + VN * 0.016
            b.add("plastic_black", plate(k, PANEL_R, 0.024, 0.008, 0.004, 0.0015))
    # Display controllers under the PFDs, the centre strip, a few circuit breakers.
    for bl in (0.455, -0.455):
        b.add("avionics_face", plate(pp(bl, 0.205), PANEL_R, 0.25, 0.085, 0.012, 0.004))
    b.add("avionics_face", plate(pp(0.0, 0.135), PANEL_R, 0.13, 0.12, 0.010, 0.004))
    b.add("avionics_face", plate(pp(0.185, 0.17), PANEL_R, 0.13, 0.14, 0.008, 0.004))
    for row in range(2):
        for i in range(7):
            cb = pp(-0.30 - i * 0.025, 0.045 + row * 0.03)
            b.add("plastic_black", M.cylinder(cb, cb + VN * 0.008, 0.0045, 8))


def glareshield(b):
    """Padded hood from the panel's top edge forward to the windshield, with the FGP face."""
    rows = []
    us = np.linspace(-1, 1, 27)
    top = pp(0, PANEL_H)
    prof = [(top[1] + 0.012, top[2] - 0.005), (top[1] - 0.075, 2.035), (top[1] - 0.09, 2.085),
            (top[1] - 0.10, 2.125), (top[1] - 0.16, 2.150), (top[1] - 0.30, 2.165), (top[1] - 0.40, 2.17),
            (2.93, 2.175)]
    for u in us:
        row = []
        for fs, wl in prof:
            hw = T.half_width_at(fs, wl - 0.02, inset=0.025)
            row.append((u * hw, fs, wl - 0.025 * abs(u) ** 3))
        rows.append(row)
    v = np.array([p for r in rows for p in r])
    f = M.grid_faces(len(us), len(prof))
    b.add("glareshield", (v, f))
    # The flight guidance panel's face plate.
    b.add("avionics_face", plate(gg(0.0, 0.0, 0.002), GLARE_R, 0.64, 0.072, 0.012, 0.004))


def pedestal(b):
    """Pedestal shell: sloping radio face, flat lever top, sides down to the floor."""
    hw = PED_HALF
    f0 = PED_FACE_O
    top_len = PED_TOP_FS1 - PED_TOP_FS0
    mid_wl = (D.COCKPIT_FLOOR_WL + PED_TOP_WL) / 2 - 0.005
    tall = PED_TOP_WL - D.COCKPIT_FLOOR_WL - 0.01
    b.add("interior_dark", M.rounded_box((0, PED_TOP_FS0 + top_len / 2, mid_wl), (2 * hw, top_len, tall), 0.02, 2))
    b.add("interior_dark", M.rounded_box((0, f0[1] + 0.07, mid_wl), (2 * hw, 0.14, tall), 0.015, 2))
    b.add("avionics_face", plate(ff(hw, FACE_H / 2), FACE_R, 2 * hw, FACE_H + 0.01, 0.012, 0.006))
    b.add("avionics_face", plate(tt(0, (PED_TOP_FS0 + PED_TOP_FS1) / 2), TOP_R, 2 * hw, top_len - 0.01, 0.008, 0.008))


def overhead(b):
    b.add("avionics_face", plate(oo(0, OVH_LEN / 2), OVH_R, 2 * OVH_HALF, OVH_LEN, 0.018, 0.012))
    # The roof console it hangs from.
    b.add("interior_dark", M.rounded_box((0, 3.86, 2.585), (2 * OVH_HALF + 0.03, OVH_LEN + 0.04, 0.09), 0.02, 2))


def floor_and_walls(b):
    rows = []
    for fs in np.linspace(3.30, 9.45, 30):
        hw = T.half_width_at(fs, D.COCKPIT_FLOOR_WL, inset=0.02)
        rows.append([(-hw, fs, D.COCKPIT_FLOOR_WL), (hw, fs, D.COCKPIT_FLOOR_WL)])
    v = np.array([p for r in rows for p in r])
    b.add("carpet", (v, M.grid_faces(len(rows), 2)))
    # Behind the panel (avionics bay wall) and the aft pressure bulkhead.
    b.add("interior_dark", A.bulkhead(T, 3.20, 0.02, D.COCKPIT_FLOOR_WL - 0.05, 2.2))
    b.add("interior", A.bulkhead(T, 9.48, 0.02, 0.85, 2.62))
    # Side consoles under the side windows with armrests.
    for side in (1, -1):
        b.add("interior_dark", M.rounded_box((side * 0.66, 4.0, 1.42), (0.08, 1.1, 0.10), 0.02, 2))


def seats(b):
    for bl in (D.SEAT_BL, -D.SEAT_BL):
        b.add("leather", M.rounded_box((bl, 4.24, 1.38), (0.46, 0.50, 0.12), 0.045, 3))
        back = M.rounded_box((0.0, 0.0, 0.0), (0.48, 0.12, 0.72), 0.05, 3)
        rot = M.rot_axis((1, 0, 0), math.radians(-14))
        b.add("leather", (M.transform(back[0], rot=rot, offset=(bl, 4.56, 1.80)), back[1]))
        head = M.rounded_box((0.0, 0.0, 0.0), (0.28, 0.10, 0.18), 0.04, 3)
        b.add("leather", (M.transform(head[0], rot=rot, offset=(bl, 4.66, 2.24)), head[1]))
        for dx in (-0.17, 0.17):
            b.add("steel", M.rounded_box((bl + dx, 4.24, 1.22), (0.03, 0.46, 0.18), 0.01, 1))
        for dx in (-0.255, 0.255):
            b.add("interior_dark", M.rounded_box((bl + dx, 4.36, 1.56), (0.05, 0.30, 0.05), 0.015, 2))
    # Executive cabin seats: forward-facing pairs and a club pair facing aft.
    for fs, facing in ((5.55, 1), (6.55, -1), (7.55, 1), (8.55, 1)):
        for bl in (0.42, -0.42):
            b.add("fabric", M.rounded_box((bl, fs, 1.22), (0.50, 0.50, 0.14), 0.05, 2))
            b.add("fabric", M.rounded_box((bl, fs + facing * 0.27, 1.62), (0.50, 0.12, 0.70), 0.05, 2))


def yokes(b):
    for bl, sfx in ((D.SEAT_BL, "L"), (-D.SEAT_BL, "R")):
        start = pp(bl, 0.115, -0.02)
        slide = b.pivot(f"Yoke_{sfx}", start, (0, 1, 0), props={"slide": [c * 0.08 for c in M.model_axis(0, 1, 0)]})
        hub = start + np.array([0, 0.28, -0.02])
        shaft = M.cylinder(start, hub, 0.014, 14)
        b.obj(f"YokeShaft_{sfx}", shaft, "chrome", parent=slide, origin=M.P(*start))
        roll = b.pivot(f"YokeRoll_{sfx}", hub, (0, -1, 0), parent=slide)
        parts = [M.rounded_box(hub + np.array([0, 0.02, 0.0]), (0.09, 0.045, 0.06), 0.014, 2)]
        bar_l = hub + np.array([0.15, 0.025, -0.02])
        bar_r = hub + np.array([-0.15, 0.025, -0.02])
        parts.append(M.tube_path([bar_r, hub + np.array([0, 0.035, -0.03]), bar_l], [0.013, 0.016, 0.013], 12))
        for end, sx in ((bar_l, 1), (bar_r, -1)):
            grip = [end, end + np.array([sx * 0.015, 0.01, 0.06]), end + np.array([sx * 0.008, 0.0, 0.125])]
            parts.append(M.tube_path(grip, [0.015, 0.018, 0.016], 14))
        b.obj(f"YokeWheel_{sfx}", M.merge(parts), "plastic_black", parent=roll, origin=M.P(*hub), sharp=50)
        b.obj(f"YokeBadge_{sfx}", M.rounded_box(hub + np.array([0, 0.043, 0.0]), (0.055, 0.004, 0.035), 0.004, 1),
              "placard", parent=roll, origin=M.P(*hub))
        b.parts[f"YokeRoll_{sfx}"] = roll
        b.parts[f"YokeHub_{sfx}"] = hub


def pedals(b):
    for which, dx in (("L", 0.09), ("R", -0.09)):
        piv = b.pivot(f"Pedals_{which}", np.array([0.0, 3.50, 1.40]), (0, -1, 0),
                      props={"slide": [c * 0.07 for c in M.model_axis(0, -1, 0)]})
        parts = []
        for seat in (D.SEAT_BL, -D.SEAT_BL):
            x = seat + dx
            top = np.array([x, 3.44, 1.44])
            foot = np.array([x, 3.56, 1.24])
            parts.append(M.tube_path([top, foot], 0.01, 8))
            pad = M.rounded_box((0, 0, 0), (0.08, 0.018, 0.14), 0.007, 1)
            rot = M.rot_axis((1, 0, 0), math.radians(-30))
            parts.append((M.transform(pad[0], rot=rot, offset=foot + np.array([0, 0.015, 0.02])), pad[1]))
        b.obj(f"Pedals_{which}_mesh", M.merge(parts), "steel", parent=piv, origin=M.P(0.0, 3.50, 1.40))


def build(col, mats, root):
    b = K.Builder(col, mats, root)
    panel(b)
    glareshield(b)
    pedestal(b)
    overhead(b)
    floor_and_walls(b)
    seats(b)
    yokes(b)
    pedals(b)
    from . import controls
    P = controls.build(b)
    b.flush()
    eye = M.empty("Eye", col, M.P(*D.EYE), size=0.03)
    M.parent_keep(eye, root)
    return P
