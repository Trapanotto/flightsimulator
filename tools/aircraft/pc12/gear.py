"""
PC-12 landing gear: trailing-link main legs that swing inwards into wells in the wing root,
a nose leg that swings aft into a well under the pedestal, the wheel doors (an inboard door
on each main well, a door on each main leg, two clamshell doors on the nose well), and the
landing and taxi lights on the legs.

Pivots (identity rest rotation, extras.axis in the model frame, positive as named):
  MainGear_L/R   leg retracts (swings inboard)          extras retractDeg
  MainArm_L/R    trailing arm: axle moves up (strut compresses); built compressed, extras
                 strokeDeg turns it down to hang free
  MainDoor_L/R   inboard door opens (outboard edge down) extras openDeg
  NoseGear       leg retracts (bottom swings aft)        extras retractDeg
  NoseSteer      nose wheel turns right                  extras maxDeg
  NoseOleo       slide: extras.slide = axle travel to hanging free
  NoseDoor_L/R   door opens                              extras openDeg
  Wheel_L/R/N    rolling forward                          extras radius, contactBelow
"""

import math

import numpy as np

from lib import airframe as A
from lib import mesh as M
from lib.parts import hub, tyre
from . import dims as D
from . import wing as W
from .fuselage import NOSE_WELL, T


def _rotated_axis(pivot, axis, probe, want):
    """Axis (design) such that a small positive turn about it moves `probe` along `want`."""
    a = np.asarray(axis, float) / np.linalg.norm(axis)
    moved = M.rot_axis(a, 0.05) @ (probe - pivot) + pivot
    return a if np.dot(moved - probe, want) > 0 else -a


def lamp(center, axis, r, depth=0.03):
    """A round lamp face (a shallow dish) looking along `axis`."""
    return M.lathe([(0.0, 0.0), (0.0, r), (depth * 0.3, r * 0.96)], center, axis, n=18, close_start=False,
                   close_end=False)


def build(col, mats, parts):
    main(col, mats, parts, 1, "L")
    main(col, mats, parts, -1, "R")
    nose(col, mats, parts)


def main(col, mats, parts, side, sfx):
    bl_wheel = side * D.MAIN_TRACK / 2
    bl_leg = bl_wheel - side * D.MAIN_WHEEL_OFFSET
    pv = np.array([bl_leg, D.MAIN_PIVOT_FS, D.MAIN_PIVOT_WL])
    knee = np.array([bl_leg, D.MAIN_PIVOT_FS, D.MAIN_KNEE_WL])
    axle = np.array([bl_wheel, D.MAIN_AXLE_FS, D.MAIN_TYRE_R - 0.012])   # tyre a little flattened
    # Retraction turns the leg's bottom inboard.
    ax = _rotated_axis(pv, (0, 1.0, 0), knee, np.array([-side, 0, 0]))
    gear = M.empty(f"MainGear_{sfx}", col, M.P(*pv),
                   props={"axis": M.model_axis(*ax), "retractDeg": D.MAIN_RETRACT_DEG})
    leg_parts = [
        M.cylinder(pv + np.array([0, -0.10, 0]), pv + np.array([0, 0.10, 0]), 0.04, 14),   # trunnion
        M.tube_path([pv, knee + np.array([0, 0, 0.05])], [0.05, 0.045], 16),
        M.rounded_box(knee + np.array([0, 0.03, 0.02]), (0.09, 0.12, 0.09), 0.02, 2),
        # Shock absorber from the leg down to the arm.
        M.cylinder(knee + np.array([0, 0.02, 0.36]), knee + np.array([0, 0.16, 0.06]), 0.028, 12),
    ]
    leg = M.make_object(f"MainLeg_{sfx}", *M.merge(leg_parts), col, mats["gear_paint"], sharp_angle=40,
                        origin=M.P(*pv))
    M.parent_keep(leg, gear)
    chrome = M.cylinder(knee + np.array([0, 0.16, 0.06]), knee + np.array([0, 0.18, -0.02]), 0.02, 10)
    # Landing light on the front of the leg, looking ahead and a little down.
    lc = np.array([bl_leg, D.MAIN_PIVOT_FS - 0.075, 0.98])
    housing = M.lathe([(-0.06, 0.0), (-0.06, 0.058), (0.0, 0.062), (0.004, 0.056)], lc, (0, -1.0, -0.05),
                      n=18, close_start=True, close_end=False)
    hv, hf = M.merge([housing, chrome])
    ho = M.make_object(f"LegFittings_{sfx}", hv, hf, col, mats["steel"], sharp_angle=40, origin=M.P(*pv))
    M.parent_keep(ho, gear)
    lo = M.make_object(f"Lamp_Landing_{sfx}", *lamp(lc + np.array([0, -0.002, 0]), (0, -1.0, -0.05), 0.052),
                       col, mats["landing"], sharp_angle=80, origin=M.P(*pv))
    M.parent_keep(lo, gear)
    glow = M.empty(f"Glow_Landing_{sfx}", col, M.P(*(lc + np.array([0, -0.03, 0]))), size=0.05,
                   props={"kind": f"Landing_{sfx}"})
    M.parent_keep(glow, gear)
    # Leg door: built where it closes the outboard part of the well with the leg up, then
    # turned down with the leg.
    dv, df = W.door_patch(W.DOOR_SPLIT_BL + 0.004, W.WELL_BL[1] - 0.006, side)
    rot = M.rot_axis(ax, -math.radians(D.MAIN_RETRACT_DEG))
    dv = (dv - pv) @ rot.T + pv
    door = M.make_object(f"MainLegDoor_{sfx}", dv, df, col, mats["paint"], sharp_angle=50, origin=M.P(*pv))
    M.parent_keep(door, gear)
    parts[f"MainLegDoor_{sfx}"] = door
    # Trailing arm with the wheel.
    arm_ax = _rotated_axis(knee, (1.0, 0, 0), axle, np.array([0, 0, 1.0]))
    stroke_deg = math.degrees(D.MAIN_STROKE / np.linalg.norm((axle - knee)[1:]))
    arm = M.empty(f"MainArm_{sfx}", col, M.P(*knee), props={"axis": M.model_axis(*arm_ax), "strokeDeg": stroke_deg})
    M.parent_keep(arm, gear)
    a_parts = [M.tube_path([knee, np.array([bl_leg, axle[1], axle[2]])], [0.04, 0.035], 14),
               M.cylinder(np.array([bl_leg, axle[1], axle[2]]), axle - np.array([side * 0.05, 0, 0]), 0.028, 12)]
    ao = M.make_object(f"MainArmMesh_{sfx}", *M.merge(a_parts), col, mats["gear_paint"], sharp_angle=40,
                       origin=M.P(*knee))
    M.parent_keep(ao, arm)
    wp = M.empty(f"Wheel_{sfx}", col, M.P(*axle),
                 props={"axis": [1.0, 0.0, 0.0], "radius": D.MAIN_TYRE_R, "contactBelow": D.MAIN_TYRE_R - 0.012})
    M.parent_keep(wp, arm)
    t = M.make_object(f"Tyre_{sfx}", *tyre(axle, (side, 0, 0), D.MAIN_TYRE_R, D.MAIN_TYRE_W, 0.13, n=36), col,
                      mats["tire"], sharp_angle=70, origin=M.P(*axle))
    h = M.make_object(f"Hub_{sfx}", *hub(axle, (side, 0, 0), 0.13, D.MAIN_TYRE_W, bolts=8), col, mats["metal"],
                      sharp_angle=40, origin=M.P(*axle))
    w = M.join([t, h], f"Wheel_{sfx}_mesh")
    M.parent_keep(w, wp)
    parts[f"Wheel_{sfx}"] = w
    # Inboard wheel door, hinged at its inboard edge.
    b0 = W.WELL_BL[0] + 0.006
    hv_, hf_ = W.door_patch(b0, W.DOOR_SPLIT_BL - 0.004, side)
    hinge_pt, _ = W.surface_point(side * b0, 0.5 * sum(W.WELL_FS))
    probe = hv_[-1]
    d_ax = _rotated_axis(hinge_pt, (0, 1.0, 0), probe, np.array([0, 0, -1.0]))
    dp = M.empty(f"MainDoor_{sfx}", col, M.P(*hinge_pt), props={"axis": M.model_axis(*d_ax), "openDeg": 88.0})
    do = M.make_object(f"MainDoorMesh_{sfx}", hv_, hf_, col, mats["paint"], sharp_angle=50, origin=M.P(*hinge_pt))
    M.parent_keep(do, dp)
    parts[f"MainDoor_{sfx}"] = do
    return gear


def nose(col, mats, parts):
    pv = np.array([0.0, D.NOSE_PIVOT_FS, D.NOSE_PIVOT_WL])
    axle = np.array([0.0, D.NOSE_AXLE_FS, D.NOSE_TYRE_R - 0.008])
    down = (axle - pv) / np.linalg.norm(axle - pv)
    ax = _rotated_axis(pv, (1.0, 0, 0), axle, np.array([0, 1.0, 0]))
    gear = M.empty("NoseGear", col, M.P(*pv), props={"axis": M.model_axis(*ax), "retractDeg": D.NOSE_RETRACT_DEG})
    collar = pv + down * 0.42
    upper = [M.cylinder(pv + np.array([-0.09, 0, 0]), pv + np.array([0.09, 0, 0]), 0.035, 12),
             M.cylinder(pv, collar, 0.048, 16),
             M.cylinder(collar - down * 0.01, collar + down * 0.03, 0.058, 16),
             # Drag brace up to the well's roof.
             M.cylinder(pv + down * 0.2, pv + np.array([0, -0.12, 0.10]), 0.018, 8)]
    lc = pv + down * 0.25 + np.array([0, -0.055, 0])
    upper.append(M.lathe([(-0.05, 0.0), (-0.05, 0.045), (0.0, 0.048)], lc, (0, -1.0, -0.12), n=16,
                         close_start=True, close_end=False))
    u = M.make_object("NoseLeg", *M.merge(upper), col, mats["gear_paint"], sharp_angle=40, origin=M.P(*pv))
    M.parent_keep(u, gear)
    lo = M.make_object("Lamp_Taxi", *lamp(lc + np.array([0, -0.002, 0]), (0, -1.0, -0.12), 0.04), col,
                       mats["landing"], sharp_angle=80, origin=M.P(*pv))
    M.parent_keep(lo, gear)
    glow = M.empty("Glow_Taxi", col, M.P(*(lc + np.array([0, -0.03, 0]))), size=0.05, props={"kind": "Taxi"})
    M.parent_keep(glow, gear)
    # Steering: everything below the collar turns about the leg's axis.
    s_ax = _rotated_axis(collar, -down, axle + np.array([0, -0.2, 0]), np.array([-1.0, 0, 0]))
    steer = M.empty("NoseSteer", col, M.P(*collar), props={"axis": M.model_axis(*s_ax), "maxDeg": 50.0})
    M.parent_keep(steer, gear)
    slide = [c * D.NOSE_STROKE for c in M.model_axis(*down)]
    oleo = M.empty("NoseOleo", col, M.P(*collar), props={"slide": slide})
    M.parent_keep(oleo, steer)
    fork_top = axle - down * 0.30
    piston = M.cylinder(collar - down * 0.06, fork_top, 0.032, 14)
    fw = 0.095
    fork = M.merge([
        M.rounded_box(fork_top, (2 * fw + 0.03, 0.08, 0.04), 0.012, 2),
        M.tube_path([fork_top + np.array([fw, 0, 0]), axle + np.array([fw, 0.0, 0.0])], 0.016, 10),
        M.tube_path([fork_top + np.array([-fw, 0, 0]), axle + np.array([-fw, 0.0, 0.0])], 0.016, 10),
        # Torque links.
        M.tube_path([collar + np.array([0, -0.03, -0.02]), 0.5 * (collar + fork_top) + np.array([0, -0.09, 0]),
                     fork_top + np.array([0, -0.04, 0.02])], 0.01, 8),
    ])
    po = M.make_object("NosePiston", *piston, col, mats["chrome"], sharp_angle=40, origin=M.P(*collar))
    fo = M.make_object("NoseFork", *fork, col, mats["gear_paint"], sharp_angle=40, origin=M.P(*collar))
    M.parent_keep(po, oleo)
    M.parent_keep(fo, oleo)
    wp = M.empty("Wheel_N", col, M.P(*axle),
                 props={"axis": [1.0, 0.0, 0.0], "radius": D.NOSE_TYRE_R, "contactBelow": D.NOSE_TYRE_R - 0.008})
    M.parent_keep(wp, oleo)
    t = M.make_object("Tyre_N", *tyre(axle, (1, 0, 0), D.NOSE_TYRE_R, D.NOSE_TYRE_W, 0.09, n=32), col, mats["tire"],
                      sharp_angle=70, origin=M.P(*axle))
    h = M.make_object("Hub_N", *hub(axle, (1, 0, 0), 0.09, D.NOSE_TYRE_W, bolts=6), col, mats["metal"],
                      sharp_angle=40, origin=M.P(*axle))
    w = M.join([t, h], "Wheel_N_mesh")
    M.parent_keep(w, wp)
    parts["Wheel_N"] = w
    # Clamshell doors, hinged at the well's sides, meeting on the centre line.
    fs0, fs1, hw = NOSE_WELL
    for side, sfx in ((1, "L"), (-1, "R")):
        def fn(u, v):
            wl = T.wl_at(v, side * u, False)
            return np.array([side * u, v, wl]), np.array([0, 0, -1.0])

        dv, df = A.solid_patch(fn, (0.004, hw - 0.004), (fs0 + 0.006, fs1 - 0.006), 4, 10, 0.006)
        hinge_pt = np.array([side * hw, 0.5 * (fs0 + fs1), T.wl_at(0.5 * (fs0 + fs1), side * hw, False)])
        probe = np.array([0.0, hinge_pt[1], hinge_pt[2]])
        d_ax = _rotated_axis(hinge_pt, (0, 1.0, 0), probe, np.array([0, 0, -1.0]))
        dp = M.empty(f"NoseDoor_{sfx}", col, M.P(*hinge_pt), props={"axis": M.model_axis(*d_ax), "openDeg": 85.0})
        do = M.make_object(f"NoseDoorMesh_{sfx}", dv, df, col, mats["paint"], sharp_angle=50, origin=M.P(*hinge_pt))
        M.parent_keep(do, dp)
        parts[f"NoseDoor_{sfx}"] = do
    return gear
