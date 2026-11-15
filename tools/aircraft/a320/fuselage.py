"""
A320 fuselage: the rounded radome, the cockpit with its six panes (two windshields, the
sliding side windows and the aft side windows with their notched lower corner), the
constant section of 3.95 x 4.14 m, and the tail cone that sweeps up to the APU exhaust. The
cabin windows and the doors are painted (there is no cabin to see through them); the
cockpit windows are cut with exact booleans. Also the belly fairing over the wing box and
the main-gear bay, and the nose-gear well.
"""

import math

import bpy
import numpy as np

from lib import airframe as A
from lib import mesh as M
from . import dims as D

T = A.Tables(
    top=[(0.0, 3.37), (0.25, 3.70), (0.7, 4.07), (1.3, 4.37), (1.9, 4.55), (2.4, 4.66), (2.9, 5.08),
         (3.4, 5.47), (4.0, 5.72), (4.8, 5.87), (6.0, 5.93), (6.6, 5.94), (27.4, 5.94), (29.5, 5.90),
         (32.0, 5.68), (34.5, 5.36), (36.2, 5.08), (37.2, 4.86)],
    bot=[(0.0, 3.23), (0.25, 2.92), (0.7, 2.60), (1.3, 2.33), (2.2, 2.10), (3.2, 1.95), (4.6, 1.85),
         (6.6, 1.80), (23.6, 1.80), (25.4, 1.90), (27.5, 2.20), (29.5, 2.62), (31.5, 3.07), (33.5, 3.52),
         (35.5, 4.00), (37.2, 4.46)],
    half=[(0.0, 0.10), (0.25, 0.66), (0.7, 1.04), (1.3, 1.36), (2.0, 1.58), (2.8, 1.75), (3.6, 1.87),
          (4.6, 1.945), (5.6, 1.972), (6.6, 1.975), (27.4, 1.975), (29.0, 1.92), (31.0, 1.72),
          (33.0, 1.40), (35.0, 1.00), (36.4, 0.62), (37.2, 0.30)],
    mid=[(0.0, 3.30), (1.0, 3.40), (2.4, 3.60), (4.4, 3.86), (6.6, 3.97), (27.4, 3.97), (30.0, 4.12),
         (33.0, 4.40), (37.2, 4.66)],
    n_top=[(0.0, 2.0), (1.0, 2.05), (2.6, 2.15), (4.5, 2.05), (6.6, 2.0), (37.2, 2.0)],
    n_bot=[(0.0, 2.0), (6.6, 2.0), (27.4, 2.0), (33.0, 2.1), (37.2, 2.0)],
    tumble=[(0.0, 1.0), (1.4, 0.97), (2.6, 0.86), (3.6, 0.88), (5.0, 0.97), (6.6, 1.0), (37.2, 1.0)],
    n_ring=96,
)


def stations():
    return np.unique(np.round(np.concatenate([
        np.linspace(0.02, 0.25, 6), np.linspace(0.32, 2.3, 18), np.linspace(2.36, 5.0, 26),
        np.linspace(5.15, 6.6, 6), np.linspace(7.3, 26.7, 26), np.linspace(27.4, 37.2, 30)]), 4))


# Windshield panes in front view (BL, WL), cut along FS; side windows in side view (FS, WL).
WINDSHIELD = [(0.075, 4.66), (1.08, 4.70), (1.17, 4.83), (0.93, 5.40), (0.075, 5.47)]
SIDE_1 = [(3.06, 4.79), (3.98, 4.74), (3.98, 5.36), (3.36, 5.43)]
SIDE_2 = [(4.08, 4.75), (4.52, 4.77), (4.66, 4.92), (4.66, 5.14), (4.08, 5.33)]


def window_cutter(col, cut_mat):
    front, sides = [], []
    ws = M.rounded_polygon(WINDSHIELD, [0.03, 0.05, 0.05, 0.05, 0.03], 5)
    for sgn in (1, -1):
        poly = [(sgn * x, y) for x, y in ws]
        front.append(M.prism(poly, 1, 1.6, 3.6, (0, 2)))
        lo, hi = (0.95, 2.3) if sgn > 0 else (-2.3, -0.95)
        for w, r in ((SIDE_1, 0.04), (SIDE_2, 0.035)):
            sides.append(M.prism(M.rounded_polygon(w, r, 4), 0, lo, hi, (1, 2)))
    # The windshield's and the side windows' prisms overlap in space (not on the skin): the
    # exact boolean needs one clean cutter, so they are united first.
    a = M.make_object("WindowCutter", *M.merge(front), col, cut_mat, smooth=False)
    b = M.make_object("WindowCutterSides", *M.merge(sides), col, cut_mat, smooth=False)
    M.boolean(a, b, "UNION")
    M.delete_object(b)
    return a


# Nose-gear well (FS range, half width).
NOSE_WELL = (3.02, 5.62, 0.40)


def well_cutter(col, mat):
    fs0, fs1, hw = NOSE_WELL
    poly = M.rounded_polygon([(-hw, fs0), (hw, fs0), (hw, fs1), (-hw, fs1)], 0.05, 3)
    v, f = M.prism(poly, 2, 0.5, 2.6, (0, 1))
    return M.make_object("WellCutter", v, f, col, mat, smooth=False)


def build(col, mats):
    cut_mat = bpy.data.materials.get("CUT") or bpy.data.materials.new("CUT")
    v, f = T.skin(stations())
    skin = M.make_object("Fuselage", v, f, col, mats["paint"], smooth=True)
    print("fuselage faces", len(skin.data.polygons))
    cutter = window_cutter(col, cut_mat)
    glass = A.cut_windows(skin, cutter, mats["glass"])
    print("after windows", len(skin.data.polygons), len(glass.data.polygons))
    M.delete_object(cutter)
    well = well_cutter(col, mats["well"])
    M.boolean(skin, well, "DIFFERENCE")
    M.delete_object(well)
    lining = A.cabin_lining(skin, col, mats, 1.95, 5.55)
    return skin, glass, lining


def nose_well(col, mats):
    """Liner of the nose-gear well: a dark box open at the bottom, up to the cockpit floor."""
    fs0, fs1, hw = NOSE_WELL
    pts = []
    top = D.FLOOR_WL - 0.12
    for fs in (fs0 + 0.01, fs1 - 0.01):
        for bl, wl in ((-hw + 0.01, None), (hw - 0.01, None), (hw - 0.01, top), (-hw + 0.01, top)):
            if wl is None:
                wl = T.wl_at(fs, bl, False) - 0.03
            pts.append((bl, fs, wl))
    faces = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 3, 7, 4), (1, 5, 6, 2), (3, 2, 6, 7)]
    return M.make_object("NoseWell", np.array(pts), faces, col, mats["well"], smooth=False, recalc=False)


# ---- belly fairing --------------------------------------------------------------------------

BELLY = A.Tables(
    top=[(10.4, 3.10), (22.9, 3.10)],
    bot=[(10.4, 1.97), (11.4, 1.72), (12.8, 1.58), (14.5, 1.53), (19.5, 1.53), (21.3, 1.60),
         (22.3, 1.74), (22.9, 1.92)],
    half=[(10.4, 1.15), (11.4, 1.80), (12.8, 2.35), (14.5, 2.72), (19.8, 2.72), (21.3, 2.30),
          (22.3, 1.80), (22.9, 1.25)],
    mid=[(10.4, 2.45), (22.9, 2.45)],
    n_top=[(10.4, 2.0), (22.9, 2.0)],
    n_bot=[(10.4, 2.4), (13.0, 3.4), (20.0, 3.4), (22.9, 2.4)],
    tumble=[(10.4, 1.0), (22.9, 1.0)],
    n_ring=72,
)
# Where the retracted main wheels sit (|BL|, FS, radius of the opening).
WHEEL_WELL = (1.985, D.MAIN_AXLE_FS, 0.63)


def belly(col, mats):
    st = np.unique(np.round(np.concatenate([np.linspace(10.4, 12.8, 10), np.linspace(13.2, 20.6, 16),
                                           np.linspace(21.0, 22.9, 8)]), 4))
    v, f = BELLY.skin(st)
    fair = M.make_object("BellyFairing", v, f, col, mats["paint"], smooth=True, sharp_angle=60)
    cut_mat = bpy.data.materials.get("CUT") or bpy.data.materials.new("CUT")
    parts = []
    bl, fs, r = WHEEL_WELL
    for sgn in (1, -1):
        ring = [(sgn * bl + r * math.cos(a), fs + r * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 28, endpoint=False)]
        parts.append(M.prism(ring, 2, 1.2, 2.1, (0, 1)))
    cutter = M.make_object("WheelWellCutter", *M.merge(parts), col, cut_mat, smooth=False)
    M.boolean(fair, cutter, "DIFFERENCE")
    A.delete_faces_with_material(fair, "CUT")
    M.delete_object(cutter)
    return fair


def wheel_wells(col, mats):
    """Dark round bays the retracted main wheels sit in."""
    parts = []
    bl, fs, r = WHEEL_WELL
    for sgn in (1, -1):
        c = np.array([sgn * bl, fs, 1.50])
        parts.append(M.lathe([(0.0, r - 0.01), (0.55, r - 0.01), (0.56, 0.0)], c, (0, 0, 1.0), n=28,
                             close_start=False, close_end=True))
    v, f = M.merge(parts)
    return M.make_object("MainWells", v, f, col, mats["well"], smooth=False)
