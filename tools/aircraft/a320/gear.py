"""
A320 landing gear: the main legs with two wheels each swing inwards into the belly (the
wheels stay uncovered in their bays, as on the real aircraft), each with a door on the leg
and a hydraulic door that opens only while the gear moves; the nose leg with two wheels swings
forward into its well, closed by two doors that open in transit, with the taxi, take-off and
runway turn-off lights on the leg.

Pivots (identity rest rotation, extras.axis in the model frame, positive as named):
  MainGear_L/R   leg retracts (bottom swings inboard)    extras retractDeg
  MainOleo_L/R   slide: extras.slide = axle travel to hanging free
  MainDoor_L/R   hydraulic door opens                     extras openDeg
  NoseGear       leg retracts (bottom swings forward)    extras retractDeg
  NoseSteer      nose wheels turn right                   extras maxDeg
  NoseOleo       slide
  NoseDoor_L/R   doors open                               extras openDeg
  Wheel_L/R/N    rolling forward                          extras radius, contactBelow
"""

import math

import numpy as np

from lib import airframe as A
from lib import mesh as M
from lib.parts import hub, tyre
from . import dims as D
from .fuselage import NOSE_WELL, T, BELLY


def _rotated_axis(pivot, axis, probe, want):
    a = np.asarray(axis, float) / np.linalg.norm(axis)
    moved = M.rot_axis(a, 0.05) @ (probe - pivot) + pivot
    return a if np.dot(moved - probe, want) > 0 else -a


def lamp(center, axis, r, depth=0.03):
    return M.lathe([(0.0, 0.0), (0.0, r), (depth * 0.3, r * 0.96)], center, axis, n=16, close_start=False,
                   close_end=False)


def build(col, mats, parts):
    for side, sfx in ((1, "L"), (-1, "R")):
        main(col, mats, parts, side, sfx)
    nose(col, mats, parts)


def main(col, mats, parts, side, sfx):
    pbl, pfs, pwl = D.MAIN_PIVOT
    pv = np.array([side * pbl, pfs, pwl])
    axle = np.array([side * D.MAIN_BL, D.MAIN_AXLE_FS, D.MAIN_TYRE_R - 0.03])
    down = (axle - pv) / np.linalg.norm(axle - pv)
    ax = _rotated_axis(pv, (0, 1.0, 0), axle, np.array([-side, 0, 0]))
    gear = M.empty(f"MainGear_{sfx}", col, M.P(*pv), props={"axis": M.model_axis(*ax), "retractDeg": 90.0})
    collar = pv + down * 1.05
    leg = [M.cylinder(pv - np.array([0, 0.35, 0]), pv + np.array([0, 0.30, 0]), 0.09, 14),     # trunnion
           M.tube_path([pv, collar], [0.15, 0.135], 18),
           M.cylinder(collar - down * 0.02, collar + down * 0.06, 0.16, 18),
           # Side stay up to the wing, folding when the leg retracts (drawn straight here).
           M.tube_path([pv + down * 0.55, pv + down * 0.25 + np.array([side * 0.9, 0.05, 0.35])], 0.05, 10)]
    lo = M.make_object(f"MainLeg_{sfx}", *M.merge(leg), col, mats["gear_paint"], sharp_angle=40, origin=M.P(*pv))
    M.parent_keep(lo, gear)
    # Leg door: a plate on the outboard side, closing the leg's slot in the wing with the leg up.
    out = np.array([side, 0, 0])
    d0 = pv + out * 0.20 + down * 0.05
    d1 = pv + out * 0.20 + down * 1.45
    door_pts = [d0 + np.array([0, -0.32, 0]), d0 + np.array([0, 0.36, 0]), d1 + np.array([0, 0.30, 0]),
                d1 + np.array([0, -0.26, 0])]
    dv = np.array(door_pts + [p + out * 0.025 for p in door_pts])
    df = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    # The leg door is painted like the leg: one mesh (one draw) with it.
    door = M.make_object(f"MainLegDoor_{sfx}", dv, df, col, mats["gear_paint"], smooth=False, origin=M.P(*pv))
    M.parent_keep(door, gear)
    M.join([lo, door], f"MainLeg_{sfx}")
    # The oleo: piston, axle beam and wheels slide out of the cylinder when unloaded.
    oleo = M.empty(f"MainOleo_{sfx}", col, M.P(*collar),
                   props={"slide": [c * D.MAIN_STROKE for c in M.model_axis(*down)]})
    M.parent_keep(oleo, gear)
    w_off = D.MAIN_WHEEL_OFF
    piston = M.cylinder(collar - down * 0.35, axle + down * 0.02, 0.10, 16)
    beam = [M.cylinder(axle - np.array([w_off - 0.18, 0, 0]), axle + np.array([w_off - 0.18, 0, 0]), 0.075, 12),
            M.rounded_box(axle + np.array([0, 0, 0.05]), (0.28, 0.32, 0.22), 0.04, 2),
            # Torque links.
            M.tube_path([collar + np.array([0, -0.16, 0.0]), 0.5 * (collar + axle) + np.array([0, -0.34, 0]),
                         axle + np.array([0, -0.16, 0.18])], 0.035, 8)]
    bo = M.make_object(f"MainAxle_{sfx}", *M.merge(beam + [piston]), col, mats["gear_paint"], sharp_angle=40,
                       origin=M.P(*collar))
    M.parent_keep(bo, oleo)
    wp = M.empty(f"Wheel_{sfx}", col, M.P(*axle), props={"axis": [1.0, 0.0, 0.0], "radius": D.MAIN_TYRE_R,
                                                       "contactBelow": D.MAIN_TYRE_R - 0.03})
    M.parent_keep(wp, oleo)
    tyres, hubs = [], []
    for k in (-1, 1):
        c = axle + np.array([k * w_off, 0, 0])
        tyres.append(tyre(c, (k, 0, 0), D.MAIN_TYRE_R, D.MAIN_TYRE_W, 0.27, n=36))
        hubs.append(hub(c, (k, 0, 0), 0.27, D.MAIN_TYRE_W, bolts=10))
    t = M.make_object(f"Tyres_{sfx}", *M.merge(tyres), col, mats["tire"], sharp_angle=70, origin=M.P(*axle))
    h = M.make_object(f"Hubs_{sfx}", *M.merge(hubs), col, mats["metal"], sharp_angle=40, origin=M.P(*axle))
    M.parent_keep(t, wp)
    M.parent_keep(h, wp)
    parts[f"Wheel_{sfx}"] = t
    # Hydraulic door on the belly inboard of the bay, hinged near the centre line.
    b0, b1 = 1.30, 0.24
    f0, f1 = D.MAIN_AXLE_FS - 0.55, D.MAIN_AXLE_FS + 0.45

    def fn(u, v):
        return np.array([side * u, v, BELLY.wl_at(v, side * u, False) - 0.012]), np.array([0, 0, -1.0])

    dv, df = A.solid_patch(fn, (b0, b1), (f0, f1), 5, 6, 0.02)
    hinge = np.array([side * b1, 0.5 * (f0 + f1), BELLY.wl_at(0.5 * (f0 + f1), side * b1, False) - 0.012])
    probe = np.array([side * b0, hinge[1], hinge[2]])
    d_ax = _rotated_axis(hinge, (0, 1.0, 0), probe, np.array([0, 0, -1.0]))
    dp = M.empty(f"MainDoor_{sfx}", col, M.P(*hinge), props={"axis": M.model_axis(*d_ax), "openDeg": 85.0})
    do = M.make_object(f"MainDoorMesh_{sfx}", dv, df, col, mats["paint"], sharp_angle=50, origin=M.P(*hinge))
    M.parent_keep(do, dp)
    parts[f"MainDoor_{sfx}"] = do
    return gear


def nose(col, mats, parts):
    pv = np.array(D.NOSE_PIVOT)
    axle = np.array([0.0, D.NOSE_AXLE_FS, D.NOSE_TYRE_R - 0.02])
    down = (axle - pv) / np.linalg.norm(axle - pv)
    ax = _rotated_axis(pv, (1.0, 0, 0), axle, np.array([0, -1.0, 0]))
    gear = M.empty("NoseGear", col, M.P(*pv), props={"axis": M.model_axis(*ax), "retractDeg": 95.0})
    collar = pv + down * 0.95
    upper = [M.cylinder(pv + np.array([-0.18, 0, 0]), pv + np.array([0.18, 0, 0]), 0.06, 12),
             M.tube_path([pv, collar], [0.10, 0.09], 16),
             M.cylinder(collar - down * 0.02, collar + down * 0.05, 0.11, 16),
             # Drag brace forward up into the well.
             M.tube_path([pv + down * 0.6, pv + np.array([0, -0.75, 0.15])], 0.035, 8)]
    # Lamp housings on the leg: taxi and take-off ahead, turn-off lights to the sides.
    lc = pv + down * 0.42 + np.array([0, -0.12, 0])
    upper.append(M.rounded_box(lc + np.array([0, 0.03, 0]), (0.30, 0.10, 0.14), 0.03, 2))
    u = M.make_object("NoseLeg", *M.merge(upper), col, mats["gear_paint"], sharp_angle=40, origin=M.P(*pv))
    M.parent_keep(u, gear)
    for name, off, axis, r in (("Lamp_Taxi", (0.06, -0.02, 0.025), (0, -1.0, -0.10), 0.045),
                               ("Lamp_Takeoff", (-0.06, -0.02, 0.025), (0, -1.0, -0.04), 0.045),
                               ("Lamp_Turnoff_L", (0.135, 0.02, -0.03), (0.7, -0.7, -0.05), 0.035),
                               ("Lamp_Turnoff_R", (-0.135, 0.02, -0.03), (-0.7, -0.7, -0.05), 0.035)):
        p = lc + np.array(off)
        mat = {"Lamp_Taxi": "taxi", "Lamp_Takeoff": "takeoff"}.get(name, "turnoff")
        o = M.make_object(name, *lamp(p, axis, r), col, mats[mat], sharp_angle=80, origin=M.P(*pv))
        M.parent_keep(o, gear)
        kind = name[5:]
        g = M.empty(f"Glow_{kind}", col, M.P(*(p + 0.04 * np.asarray(axis) / np.linalg.norm(axis))), size=0.05,
                    props={"kind": kind})
        M.parent_keep(g, gear)
    import bpy
    M.join([bpy.data.objects["Lamp_Turnoff_L"], bpy.data.objects["Lamp_Turnoff_R"]], "Lamp_Turnoff")
    # Aft leg door, fixed to the leg.
    hw = NOSE_WELL[2]
    dpts = [pv + np.array([-hw + 0.02, 0.20, -0.05]), pv + np.array([hw - 0.02, 0.20, -0.05]),
            pv + down * 0.9 + np.array([hw - 0.02, 0.16, 0]), pv + down * 0.9 + np.array([-hw + 0.02, 0.16, 0])]
    dv = np.array(dpts + [p + np.array([0, 0.02, 0]) for p in dpts])
    df = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    nd = M.make_object("NoseLegDoor", dv, df, col, mats["gear_paint"], smooth=False, origin=M.P(*pv))
    M.parent_keep(nd, gear)
    M.join([u, nd], "NoseLeg")
    s_ax = _rotated_axis(collar, -down, axle + np.array([0, -0.3, 0]), np.array([-1.0, 0, 0]))
    steer = M.empty("NoseSteer", col, M.P(*collar), props={"axis": M.model_axis(*s_ax), "maxDeg": 75.0})
    M.parent_keep(steer, gear)
    oleo = M.empty("NoseOleo", col, M.P(*collar), props={"slide": [c * D.NOSE_STROKE for c in M.model_axis(*down)]})
    M.parent_keep(oleo, steer)
    piston = M.cylinder(collar - down * 0.2, axle + down * 0.02, 0.065, 14)
    w = D.NOSE_WHEEL_OFF
    beam = [M.cylinder(axle - np.array([w - 0.08, 0, 0]), axle + np.array([w - 0.08, 0, 0]), 0.05, 10),
            M.tube_path([collar + np.array([0, -0.1, 0]), 0.5 * (collar + axle) + np.array([0, -0.22, 0]),
                         axle + np.array([0, -0.08, 0.12])], 0.022, 8)]
    M.parent_keep(M.make_object("NoseAxle", *M.merge(beam + [piston]), col, mats["gear_paint"], sharp_angle=40,
                                origin=M.P(*collar)), oleo)
    wp = M.empty("Wheel_N", col, M.P(*axle), props={"axis": [1.0, 0.0, 0.0], "radius": D.NOSE_TYRE_R,
                                                   "contactBelow": D.NOSE_TYRE_R - 0.02})
    M.parent_keep(wp, oleo)
    tyres, hubs = [], []
    for k in (-1, 1):
        c = axle + np.array([k * w, 0, 0])
        tyres.append(tyre(c, (k, 0, 0), D.NOSE_TYRE_R, D.NOSE_TYRE_W, 0.18, n=30))
        hubs.append(hub(c, (k, 0, 0), 0.18, D.NOSE_TYRE_W, bolts=6))
    t = M.make_object("Tyres_N", *M.merge(tyres), col, mats["tire"], sharp_angle=70, origin=M.P(*axle))
    h = M.make_object("Hubs_N", *M.merge(hubs), col, mats["metal"], sharp_angle=40, origin=M.P(*axle))
    M.parent_keep(t, wp)
    M.parent_keep(h, wp)
    parts["Wheel_N"] = t
    # Forward doors, hinged at the well's sides.
    fs0, fs1, hw = NOSE_WELL
    for side, sfx in ((1, "L"), (-1, "R")):
        def fn(u, v, side=side):
            return np.array([side * u, v, T.wl_at(v, side * u, False) - 0.01]), np.array([0, 0, -1.0])

        dv, df = A.solid_patch(fn, (0.006, hw - 0.006), (fs0 + 0.01, fs1 - 0.01), 4, 10, 0.012)
        hinge_pt = np.array([side * hw, 0.5 * (fs0 + fs1), T.wl_at(0.5 * (fs0 + fs1), side * hw, False)])
        probe = np.array([0.0, hinge_pt[1], hinge_pt[2]])
        d_ax = _rotated_axis(hinge_pt, (0, 1.0, 0), probe, np.array([0, 0, -1.0]))
        dp = M.empty(f"NoseDoor_{sfx}", col, M.P(*hinge_pt), props={"axis": M.model_axis(*d_ax), "openDeg": 88.0})
        do = M.make_object(f"NoseDoorMesh_{sfx}", dv, df, col, mats["paint"], sharp_angle=50, origin=M.P(*hinge_pt))
        M.parent_keep(do, dp)
        parts[f"NoseDoor_{sfx}"] = do
    return gear
