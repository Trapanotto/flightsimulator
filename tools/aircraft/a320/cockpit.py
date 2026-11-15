"""
A320 flight deck: the main instrument panel with six display units (captain's PFD and ND, the
engine/warning display over the system display in the middle, the first officer's ND and
PFD), the standby instrument, the glareshield carrying the flight control unit and both EFIS
control panels, the overhead panel, the pedestal (MCDUs, thrust quadrant, engine masters,
ECAM control panel, radio management panels, transponder, rudder trim, parking brake), side
consoles with the sidesticks and tillers, rudder pedals, the crew seats and the bulkhead.

Frames (3x3, columns = x right, y up, z out of the surface as the pilot sees it) for each
mounting surface; pp(), gg(), oo(), mm() and tt() give design-frame points on them.
"""

import math

import numpy as np

from lib import airframe as A
from lib import cockpit_kit as K
from lib import mesh as M
from . import dims as D
from .fuselage import T

# --- main panel: leans back 13 degrees, lower edge at FS 3.06, WL 3.90 ----------------------
TILT = math.radians(13)
PANEL_O = np.array([0.0, 3.06, 4.00])
VX = np.array([1.0, 0.0, 0.0])
VV = np.array([0.0, -math.sin(TILT), math.cos(TILT)])
VN = np.array([0.0, math.cos(TILT), math.sin(TILT)])
PANEL_R = np.column_stack([-VX, VV, VN])
PANEL_H = 0.555
PANEL_HALF = 0.98

# Display units: 7.25 in screens of 0.184 m; centres by BL and height up the panel.
SCREEN = 0.184
DU_V = 0.425
DISPLAYS = {"PFD1": 0.745, "ND1": 0.495, "EWD": 0.0, "ND2": -0.495, "PFD2": -0.745}
SD_V = 0.188


def pp(bl, v, s=0.0):
    return PANEL_O + VX * bl + VV * v + VN * s


# --- glareshield face: vertical, facing aft -----------------------------------------------------
GLARE_O = np.array([0.0, 2.905, 4.605])
GLARE_R = np.column_stack([(-1.0, 0, 0), (0, 0, 1.0), (0, 1.0, 0)])


def gg(bl, dz, s=0.0):
    return GLARE_O + np.array([bl, s, dz])


# --- overhead: on the roof, facing down and aft. Looking up at it from the seat the top of the
# picture is aft: the panel's "up" is aft, so its labels read upright (as on the PC-12).
OVH_TILT = math.radians(17)
OVH_O = np.array([0.0, 3.15, 5.30])                               # forward edge, centre
OV_V = np.array([0.0, math.cos(OVH_TILT), math.sin(OVH_TILT)])    # up on the panel = aft
OV_N = np.array([0.0, math.sin(OVH_TILT), -math.cos(OVH_TILT)])   # out of the panel: down, aft
OVH_R = np.column_stack([(-1.0, 0, 0), OV_V, OV_N])
OVH_LEN = 0.86
OVH_HALF = 0.36


def oo(bl, d, s=0.0):
    """Point on the overhead panel: BL, d metres aft of its forward edge, s out of it."""
    return OVH_O + np.array([bl, 0, 0]) + OV_V * d + OV_N * s


# --- pedestal: the sloping MCDU face, then the flat top ----------------------------------------
PED_HALF = 0.255
PED_TOP_WL = 3.92
MCDU_TOP = np.array([0.0, 3.10, 4.075])         # forward (upper) edge of the MCDU face
MCDU_BOT = np.array([0.0, 3.43, PED_TOP_WL])
_mv = (MCDU_TOP - MCDU_BOT) / np.linalg.norm(MCDU_TOP - MCDU_BOT)
MV = _mv                                            # up the face (forward)
MN = np.cross(np.array([-1.0, 0, 0]), MV)           # out of the face: up and aft
MCDU_R = np.column_stack([(-1.0, 0, 0), MV, MN])
MCDU_LEN = float(np.linalg.norm(MCDU_TOP - MCDU_BOT))
PED_FS = (3.43, 4.48)
TOP_R = np.column_stack([(-1.0, 0, 0), (0, -1.0, 0), (0, 0, 1.0)])   # x right, y forward, z up


def mm(bl, d, s=0.0):
    """Point on the MCDU face: BL, d metres up the face from its lower edge."""
    return MCDU_BOT + np.array([bl, 0, 0]) + MV * d + MN * s


def tt(bl, fs, s=0.0):
    return np.array([bl, fs, PED_TOP_WL + s])


CONSOLE_WL = 4.10


def plate(origin, frame, w, h, depth, rad=0.004):
    v, f = M.rounded_box((0, 0, depth / 2), (w, h, depth), rad, 1)
    return K.to_design(origin, frame, v), f


def slab(origin, frame, w, h, depth):
    v, f = M.rounded_box((0, 0, depth / 2), (w, h, depth), 0.0, 1)
    return K.to_design(origin, frame, v), f


def panel(b):
    # The panel: centre part with the display row, its lower centre carrying the SD, and side
    # wings cut away under the outer displays for the knees.
    outline = [(-PANEL_HALF, 0.30), (-0.34, 0.30), (-0.30, 0.0), (0.30, 0.0), (0.34, 0.30),
               (PANEL_HALF, 0.30), (PANEL_HALF, PANEL_H), (-PANEL_HALF, PANEL_H)]
    poly = M.rounded_polygon(outline, 0.02, 2)
    pts = []
    n = len(poly)
    for s in (-0.04, 0.0):
        for x, y in poly:
            pts.append(pp(-x, y, s))
    faces = [tuple(range(n)), tuple(range(n, 2 * n))[::-1]]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    b.add("panel", (np.array(pts), faces))
    # Knee panels under the side wings, set back.
    for sgn in (1, -1):
        b.add("panel", slab(pp(sgn * 0.66, 0.15, -0.12), PANEL_R, 0.62, 0.30, 0.02))
    # Display units: bezel and the recessed screen.
    units = dict(DISPLAYS)
    for did, bl in list(units.items()) + [("SD", 0.0)]:
        v = SD_V if did == "SD" else DU_V
        c = pp(bl, v)
        b.add("korry", plate(c, PANEL_R, 0.226, 0.226, 0.014, 0.006))
        b.add("screen", plate(c + VN * 0.0005, PANEL_R, SCREEN + 0.006, SCREEN + 0.006, 0.0142, 0.002))
        # Brightness knobs at the corners.
        for dx in (-0.098,):
            k = c + (-dx) * VX - VV * 0.098 + VN * 0.014
            b.add("plastic_black", M.cylinder(k, k + VN * 0.008, 0.0055, 10))
    # Standby instrument and clock left of the engine display.
    b.add("korry", plate(pp(0.245, 0.44), PANEL_R, 0.096, 0.096, 0.012, 0.004))
    b.add("korry", plate(pp(0.245, 0.315), PANEL_R, 0.075, 0.075, 0.010, 0.004))
    # Lower centre: brake pressure gauge, gear and autobrake plates.
    b.add("korry", plate(pp(0.205, 0.17), PANEL_R, 0.085, 0.150, 0.008, 0.004))
    b.add("korry", plate(pp(-0.235, 0.17), PANEL_R, 0.110, 0.230, 0.008, 0.004))
    # Captain's and first officer's lower panels: a row of dummy keys and the loudspeaker knobs.
    for sgn in (1, -1):
        b.add("korry", plate(pp(sgn * 0.62, 0.345, 0.0), PANEL_R, 0.50, 0.05, 0.006, 0.004))
        for i in range(6):
            K.static(b, "plastic_black", K.box(0, 0, 0.002, 0.022, 0.016, 0.004),
                     pp(sgn * (0.42 + i * 0.07), 0.345, 0.006), PANEL_R)


def glareshield(b):
    """Padded hood from the panel's top forward to the windshield, with its aft face."""
    rows = []
    us = np.linspace(-1, 1, 25)
    top = pp(0, PANEL_H)
    prof = [(top[1] + 0.01, top[2] - 0.01), (GLARE_O[1] + 0.005, 4.545), (GLARE_O[1], 4.55),
            (GLARE_O[1] - 0.002, 4.675), (GLARE_O[1] - 0.05, 4.70), (GLARE_O[1] - 0.20, 4.66),
            (2.42, 4.53), (2.14, 4.44)]
    for u in us:
        row = []
        for fs, wl in prof:
            hw = min(T.half_width_at(fs, wl - 0.02, inset=0.04), 1.30)
            row.append((u * hw, fs, wl - 0.03 * abs(u) ** 3))
        rows.append(row)
    v = np.array([p for r in rows for p in r])
    f = M.grid_faces(len(us), len(prof))
    b.add("glareshield", (v, f))
    # Plates: FCU in the middle, the EFIS panels and the warning lights either side.
    b.add("korry", plate(gg(0.0, 0.0, 0.002), GLARE_R, 0.58, 0.112, 0.022, 0.004))
    for sgn in (1, -1):
        b.add("korry", plate(gg(sgn * 0.485, 0.0, 0.002), GLARE_R, 0.33, 0.112, 0.018, 0.004))
        b.add("korry", plate(gg(sgn * 0.745, 0.0, 0.002), GLARE_R, 0.10, 0.10, 0.016, 0.004))


def overhead(b):
    b.add("panel_light", plate(oo(0, OVH_LEN / 2), OVH_R, 2 * OVH_HALF, OVH_LEN, 0.02, 0.01))
    # Its housing up into the roof.
    c = oo(0, OVH_LEN / 2, -0.03)
    b.add("interior_dark", plate(c, OVH_R, 2 * OVH_HALF + 0.04, OVH_LEN + 0.04, 0.03, 0.01))
    # Panel strips: the rows of the overhead are separate panels with screwed edges.
    for d in (0.17, 0.34, 0.50, 0.66):
        b.add("interior_dark", slab(oo(0, d, 0.02), OVH_R, 2 * OVH_HALF - 0.01, 0.004, 0.001))
    b.add("interior_dark", slab(oo(0.12, OVH_LEN / 2, 0.02), OVH_R, 0.004, OVH_LEN - 0.01, 0.001))
    b.add("interior_dark", slab(oo(-0.12, OVH_LEN / 2, 0.02), OVH_R, 0.004, OVH_LEN - 0.01, 0.001))


def pedestal(b):
    hw = PED_HALF
    f0, f1 = PED_FS
    tall = PED_TOP_WL - D.FLOOR_WL
    b.add("panel", M.rounded_box((0, (f0 + f1) / 2, D.FLOOR_WL + tall / 2 - 0.004), (2 * hw, f1 - f0, tall), 0.02, 2))
    # The sloping front with the MCDUs: a wedge from the top down to the floor.
    pts = []
    for bl in (hw, -hw):
        pts += [(bl, MCDU_TOP[1], MCDU_TOP[2]), (bl, MCDU_BOT[1], MCDU_BOT[2]), (bl, MCDU_BOT[1], D.FLOOR_WL),
                (bl, MCDU_TOP[1], D.FLOOR_WL)]
    faces = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    b.add("panel", (np.array(pts), faces))
    b.add("korry", plate(mm(0, MCDU_LEN / 2), MCDU_R, 2 * hw - 0.01, MCDU_LEN - 0.01, 0.004, 0.004))
    # The flat top's panels (thrust quadrant, engine, ECAM, radios), each a dark plate.
    for fs0, fs1 in ((3.44, 3.84), (3.85, 3.97), (3.98, 4.08), (4.09, 4.255), (4.26, 4.345), (4.35, 4.47)):
        b.add("korry", plate(tt(0, (fs0 + fs1) / 2), TOP_R, 2 * hw - 0.01, fs1 - fs0 - 0.004, 0.004, 0.004))
    # Thrust quadrant housing with the slots and detent marks.
    b.add("panel", M.rounded_box((0.0, 3.64, PED_TOP_WL + 0.03), (0.20, 0.38, 0.06), 0.02, 2))


def floor_and_walls(b):
    rows = []
    for fs in np.linspace(2.7, 5.5, 14):
        hw = T.half_width_at(fs, D.FLOOR_WL, inset=0.02)
        rows.append([(-hw, fs, D.FLOOR_WL), (hw, fs, D.FLOOR_WL)])
    v = np.array([p for r in rows for p in r])
    b.add("carpet", (v, M.grid_faces(len(rows), 2)))
    # Behind the panel, the aft bulkhead with the door.
    b.add("interior_dark", A.bulkhead(T, 2.62, 0.02, D.FLOOR_WL - 0.05, 4.62))
    b.add("interior", A.bulkhead(T, 5.50, 0.03, D.FLOOR_WL - 0.02, 5.85))
    b.add("interior_dark", M.rounded_box((0.0, 5.48, 4.45), (0.82, 0.04, 1.90), 0.02, 2))
    # Side consoles with the sidesticks, the tillers, the side walls below the windows.
    for sgn in (1, -1):
        b.add("panel", M.rounded_box((sgn * 1.12, 3.95, (CONSOLE_WL + D.FLOOR_WL) / 2 + 0.02),
                                     (0.30, 1.35, CONSOLE_WL - D.FLOOR_WL), 0.03, 2))
        b.add("korry", M.rounded_box((sgn * 1.10, 3.95, CONSOLE_WL + 0.003), (0.26, 1.30, 0.008), 0.004, 1))
        b.add("panel", M.rounded_box((sgn * 1.12, 3.40, CONSOLE_WL + 0.15), (0.30, 0.30, 0.30), 0.03, 2))


def seats(b):
    for bl in (D.SEAT_BL, -D.SEAT_BL):
        b.add("sheepskin", M.rounded_box((bl, 4.12, 4.05), (0.50, 0.50, 0.13), 0.05, 3))
        back = M.rounded_box((0.0, 0.0, 0.0), (0.52, 0.13, 0.78), 0.06, 3)
        rot = M.rot_axis((1, 0, 0), math.radians(-12))
        b.add("sheepskin", (M.transform(back[0], rot=rot, offset=(bl, 4.44, 4.50)), back[1]))
        head = M.rounded_box((0.0, 0.0, 0.0), (0.30, 0.11, 0.20), 0.045, 3)
        b.add("sheepskin", (M.transform(head[0], rot=rot, offset=(bl, 4.53, 5.00)), head[1]))
        b.add("steel", M.rounded_box((bl, 4.15, 3.76), (0.30, 0.40, 0.26), 0.02, 1))
        for dx in (-0.29, 0.29):
            b.add("interior_dark", M.rounded_box((bl + dx, 4.24, 4.28), (0.06, 0.34, 0.05), 0.018, 2))


def sidesticks(b):
    for bl, sfx in ((1.02, "L"), (-1.02, "R")):
        base = np.array([bl, 3.86, CONSOLE_WL + 0.01])
        b.add("plastic_black", M.cylinder(base, base + np.array([0, 0, 0.012]), 0.045, 16))
        pitch = b.pivot(f"Sidestick_{sfx}", base, (1, 0, 0))
        roll = b.pivot(f"SidestickRoll_{sfx}", base, (0, -1, 0), parent=pitch)
        grip = [M.cylinder(base, base + np.array([0, 0, 0.06]), 0.012, 10),
                M.tube_path([base + np.array([0, 0, 0.05]), base + np.array([0, -0.01, 0.12]),
                             base + np.array([0, -0.025, 0.17])], [0.022, 0.026, 0.022], 14)]
        b.obj(f"SidestickGrip_{sfx}", M.merge(grip), "plastic_black", parent=roll, origin=M.P(*base), sharp=50)
        b.parts[f"SidestickRoll_{sfx}"] = roll
        b.parts[f"SidestickTop_{sfx}"] = base + np.array([0, -0.025, 0.17])
        # Tiller ahead of the stick: a small wheel on the console.
        tb = np.array([bl, 3.48, CONSOLE_WL + 0.30])
        tl = b.pivot(f"Tiller_{sfx}", tb, (0, 0, 1))
        tw = [M.lathe([(-0.008, 0.0), (-0.008, 0.06), (0.008, 0.06), (0.008, 0.0)], (0, 0, 0), (0, 0, 1.0), n=18,
                      close_start=True, close_end=True),
              M.cylinder((0.04, 0, 0.008), (0.04, 0, 0.04), 0.008, 8)]
        v, f = M.merge(tw)
        b.obj(f"TillerWheel_{sfx}", (v + tb, f), "plastic_black", parent=tl, origin=M.P(*tb))


def pedals(b):
    for which, dx in (("L", 0.10), ("R", -0.10)):
        piv = b.pivot(f"Pedals_{which}", np.array([0.0, 2.95, 3.95]), (0, -1, 0),
                      props={"slide": [c * 0.08 for c in M.model_axis(0, -1, 0)]})
        parts = []
        for seat in (D.SEAT_BL, -D.SEAT_BL):
            x = seat + dx
            top = np.array([x, 2.86, 3.98])
            foot = np.array([x, 2.98, 3.72])
            parts.append(M.tube_path([top, foot], 0.012, 8))
            pad = M.rounded_box((0, 0, 0), (0.09, 0.02, 0.17), 0.008, 1)
            rot = M.rot_axis((1, 0, 0), math.radians(-25))
            parts.append((M.transform(pad[0], rot=rot, offset=foot + np.array([0, 0.02, 0.03])), pad[1]))
        b.obj(f"Pedals_{which}_mesh", M.merge(parts), "steel", parent=piv, origin=M.P(0.0, 2.95, 3.95))


def build(col, mats, root):
    b = K.Builder(col, mats, root)
    panel(b)
    glareshield(b)
    overhead(b)
    pedestal(b)
    floor_and_walls(b)
    seats(b)
    sidesticks(b)
    pedals(b)
    from . import controls
    P = controls.build(b)
    b.flush()
    eye = M.empty("Eye", col, M.P(*D.EYE), size=0.03)
    M.parent_keep(eye, root)
    return P
