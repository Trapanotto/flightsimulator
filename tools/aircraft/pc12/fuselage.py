"""
PC-12 fuselage: the long nose over the PT6 with the chin inlet under the spinner, the
cabin of round-cornered square section, the tail cone sweeping up to the fin. Windows (the
two-piece windshield, cockpit side windows and nine cabin windows a side) are cut with
exact booleans; the nose-gear well is cut into the belly.
"""

import math

import bpy
import numpy as np

from lib import airframe as A
from lib import mesh as M
from . import dims as D

T = A.Tables(
    top=[(0.62, 2.03), (0.70, 2.05), (1.0, 2.09), (1.6, 2.135), (2.2, 2.17), (2.78, 2.21),
         (3.0, 2.28), (3.3, 2.46), (3.6, 2.60), (3.95, 2.68), (4.4, 2.71), (8.6, 2.71),
         (9.3, 2.68), (10.2, 2.58), (11.1, 2.46), (12.2, 2.33), (13.30, 2.20)],
    bot=[(0.62, 1.52), (0.68, 1.40), (0.78, 1.31), (1.0, 1.22), (1.6, 1.08), (2.2, 0.97),
         (2.8, 0.89), (3.4, 0.83), (4.0, 0.79), (4.6, 0.77), (7.6, 0.77), (8.4, 0.81),
         (9.2, 0.92), (10.2, 1.13), (11.2, 1.39), (12.3, 1.66), (13.30, 1.90)],
    half=[(0.62, 0.262), (0.68, 0.36), (0.78, 0.42), (1.0, 0.47), (1.6, 0.525), (2.2, 0.575),
          (2.8, 0.635), (3.4, 0.73), (4.0, 0.80), (4.6, 0.835), (8.2, 0.835), (9.0, 0.79),
          (10.0, 0.67), (11.0, 0.52), (12.0, 0.37), (13.0, 0.22), (13.30, 0.15)],
    mid=[(0.62, 1.78), (0.8, 1.74), (1.4, 1.68), (2.2, 1.64), (3.0, 1.62), (4.0, 1.68),
         (8.5, 1.70), (10.0, 1.82), (12.0, 1.97), (13.30, 2.0)],
    n_top=[(0.62, 2.0), (0.9, 2.2), (2.0, 2.3), (3.0, 2.4), (4.2, 2.8), (8.6, 2.8), (11.0, 2.4),
           (13.30, 2.1)],
    n_bot=[(0.62, 2.0), (0.9, 2.4), (2.0, 2.6), (3.4, 3.0), (8.6, 3.2), (10.5, 2.6), (13.30, 2.1)],
    tumble=[(0.62, 1.0), (2.0, 0.92), (3.4, 0.86), (4.4, 0.86), (8.6, 0.86), (11.0, 0.9),
            (13.30, 1.0)],
    n_ring=88,
)


def stations():
    return np.unique(np.round(np.concatenate([
        np.linspace(0.62, 0.70, 5), np.linspace(0.74, 2.78, 22), np.linspace(2.84, 4.6, 20),
        np.linspace(4.7, 9.4, 32), np.linspace(9.5, 13.30, 30)]), 4))


# Window outlines. Side views in (FS, WL).
WINDSHIELD = [(2.90, 2.17), (3.36, 2.17), (3.64, 2.63), (3.64, 2.85), (2.90, 2.85)]
COCKPIT_SIDE = [(3.52, 1.98), (4.20, 1.98), (4.20, 2.47), (3.94, 2.54), (3.64, 2.42)]
CABIN_WINDOW_FS = [4.62 + i * 0.585 for i in range(9)]
CABIN_WINDOW = (0.37, 0.43, 2.06)     # width, height, centre WL


def window_cutter(col, cut_mat):
    parts = []
    ws = M.rounded_polygon(WINDSHIELD, [0.02, 0.05, 0.05, 0.0, 0.0], 6)
    for lo, hi in ((0.016, 0.64), (-0.64, -0.016)):
        parts.append(M.prism(ws, 0, lo, hi, (1, 2)))
    for side in (1, -1):
        lo, hi = (0.45, 1.2) if side > 0 else (-1.2, -0.45)
        parts.append(M.prism(M.rounded_polygon(COCKPIT_SIDE, 0.05, 5), 0, lo, hi, (1, 2)))
        w, h, c = CABIN_WINDOW
        for fs in CABIN_WINDOW_FS:
            poly = [(fs - w / 2, c - h / 2), (fs + w / 2, c - h / 2), (fs + w / 2, c + h / 2),
                    (fs - w / 2, c + h / 2)]
            parts.append(M.prism(M.rounded_polygon(poly, 0.075, 5), 0, lo, hi, (1, 2)))
    v, f = M.merge(parts)
    return M.make_object("WindowCutter", v, f, col, cut_mat, smooth=False)


# Nose-gear well in the belly (FS, half width).
NOSE_WELL = (2.10, 3.46, 0.125)


def inlet_cutter(col, mat):
    parts = []
    # Chin inlet of the PT6 under the spinner: a wide oval facing forward.
    ring = []
    n = 28
    for k in range(n):
        a = 2 * math.pi * k / n
        ring.append((0.19 * math.cos(a), 1.385 + 0.068 * math.sin(a)))
    parts.append(M.prism(ring, 1, 0.55, 1.15, (0, 2)))
    v, f = M.merge(parts)
    return M.make_object("InletCutter", v, f, col, mat, smooth=False)


def well_cutter(col, mat):
    fs0, fs1, hw = NOSE_WELL
    poly = M.rounded_polygon([(-hw, fs0), (hw, fs0), (hw, fs1), (-hw, fs1)], 0.03, 3)
    v, f = M.prism(poly, 2, 0.0, 1.05, (0, 1))
    return M.make_object("WellCutter", v, f, col, mat, smooth=False)


def build(col, mats):
    cut_mat = bpy.data.materials.get("CUT") or bpy.data.materials.new("CUT")
    v, f = T.skin(stations())
    skin = M.make_object("Fuselage", v, f, col, mats["paint"], smooth=True)
    cutter = window_cutter(col, cut_mat)
    glass = A.cut_windows(skin, cutter, mats["glass"])
    M.delete_object(cutter)
    inlets = inlet_cutter(col, mats["intake"])
    M.boolean(skin, inlets, "DIFFERENCE")
    M.delete_object(inlets)
    well = well_cutter(col, mats["well"])
    M.boolean(skin, well, "DIFFERENCE")
    M.delete_object(well)
    lining = A.cabin_lining(skin, col, mats, 2.86, 9.55)
    return skin, glass, lining


def nose_well(col, mats):
    """Liner of the nose-gear well: a dark box open at the bottom, up into the pedestal."""
    fs0, fs1, hw = NOSE_WELL
    pts, faces = [], []
    top = 1.62
    for fs in (fs0 + 0.01, fs1 - 0.01):
        for bl, wl in ((-hw + 0.01, T.wl_at(fs, -hw + 0.01, False) - 0.02), (hw - 0.01, None),
                       (hw - 0.01, top), (-hw + 0.01, top)):
            if wl is None:
                wl = T.wl_at(fs, hw - 0.01, False) - 0.02
            pts.append((bl, fs, wl))
    # Two ends and three walls (sides and roof), facing inwards.
    faces = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 3, 7, 4), (1, 5, 6, 2), (3, 2, 6, 7)]
    return M.make_object("NoseWell", np.array(pts), faces, col, mats["well"], smooth=False, recalc=False)
