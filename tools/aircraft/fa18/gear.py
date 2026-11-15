"""
F/A-18C landing gear, arresting hook and launch bar.

Main legs swing aft into the lower fuselage and turn their wheel flat on the way; the twin-wheel
nose leg swings forward into its bay under the cockpit and carries the launch bar on its front
and the landing/taxi light. Doors: one on each main well (hanging down when open), two on the
nose bay.

Pivots (identity rest rotation, extras.axis in the model frame, positive as named):
  MainGear_L/R    leg retracts (bottom aft and up)          extras retractDeg
  MainTwist_L/R   wheel turns flat about the leg            extras twistDeg
  MainOleo_L/R    slide: extras.slide = axle travel hanging free
  MainDoor_L/R    door opens (swings down)                  extras openDeg
  NoseGear        leg retracts (bottom forward and up)      extras retractDeg
  NoseSteer       nose wheels turn right                    extras maxDeg
  NoseOleo        slide: extras.slide = axle travel hanging free
  LaunchBar       bar lowered                               extras downDeg
  NoseDoor_L/R    doors open                                extras openDeg
  Hook            hook lowered                              extras downDeg
  Wheel_L/R/N     rolling forward                           extras radius, contactBelow
"""

import math

import numpy as np

from lib import mesh as M
from lib.parts import hub, tyre
from . import dims as D
from . import fuselage as F


def turn_axis(pivot, axis, probe, want):
    """Axis such that a small positive turn about it moves `probe` along `want`."""
    a = np.asarray(axis, float) / np.linalg.norm(axis)
    moved = M.rot_axis(a, 0.05) @ (np.asarray(probe) - pivot) + pivot
    return a if np.dot(moved - probe, want) > 0 else -a


def lamp(center, axis, r, depth=0.03):
    return M.lathe([(0.0, 0.0), (0.0, r), (depth * 0.3, r * 0.96)], center, axis, n=18, close_start=False,
                   close_end=False)


def build(col, mats, parts):
    for side, sfx in ((1, "L"), (-1, "R")):
        main(col, mats, parts, side, sfx)
    nose(col, mats, parts)
    hook(col, mats, parts)


def main(col, mats, parts, side, sfx):
    pv = np.array([side * D.MAIN_PIVOT[0], D.MAIN_PIVOT[1], D.MAIN_PIVOT[2]])
    knee = np.array([side * 1.30, 9.48, 0.80])
    axle_strut = np.array([side * 1.31, D.MAIN_AXLE_FS, D.MAIN_TYRE_R - 0.015])
    wheel_c = np.array([side * D.MAIN_TRACK / 2, D.MAIN_AXLE_FS, D.MAIN_TYRE_R - 0.015])
    ax = turn_axis(pv, (1.0, 0, 0), knee, np.array([0, 1.0, -0.2]))
    gear = M.empty(f"MainGear_{sfx}", col, M.P(*pv), props={"axis": M.model_axis(*ax), "retractDeg": D.MAIN_RETRACT_DEG})
    leg = [M.cylinder(pv - np.array([side * 0.12, 0, 0]), pv + np.array([side * 0.10, 0, 0]), 0.06, 14),
           M.tube_path([pv, knee + np.array([0, 0, 0.05])], [0.085, 0.075], 16)]
    o = M.make_object(f"MainLeg_{sfx}", *M.merge(leg), col, mats["gear_paint"], sharp_angle=40, origin=M.P(*pv))
    M.parent_keep(o, gear)
    strut = (knee - axle_strut) / np.linalg.norm(knee - axle_strut)
    tw_ax = turn_axis(knee, strut, wheel_c, np.array([0, 1.0, 0]))
    twist = M.empty(f"MainTwist_{sfx}", col, M.P(*knee), props={"axis": M.model_axis(*tw_ax), "twistDeg": D.MAIN_TWIST_DEG})
    M.parent_keep(twist, gear)
    oleo = M.empty(f"MainOleo_{sfx}", col, M.P(*knee),
                   props={"slide": [c * D.MAIN_STROKE for c in M.model_axis(*(-strut))]})
    M.parent_keep(oleo, twist)
    piston = M.cylinder(knee - strut * 0.02, axle_strut + strut * 0.05, 0.05, 14)
    po = M.make_object(f"MainPiston_{sfx}", *piston, col, mats["chrome"], sharp_angle=40, origin=M.P(*knee))
    M.parent_keep(po, oleo)
    fork = [M.rounded_box(axle_strut, (0.14, 0.16, 0.13), 0.03, 2),
            M.cylinder(axle_strut, wheel_c - np.array([side * 0.09, 0, 0]), 0.045, 12),
            # Torque links behind the piston.
            M.tube_path([knee - strut * 0.05 + np.array([0, 0.08, 0]), 0.5 * (knee + axle_strut) + np.array([0, 0.16, 0]),
                         axle_strut + np.array([0, 0.08, 0.06])], 0.018, 8)]
    fo = M.make_object(f"MainFork_{sfx}", *M.merge(fork), col, mats["gear_paint"], sharp_angle=40, origin=M.P(*knee))
    M.parent_keep(fo, oleo)
    wp = M.empty(f"Wheel_{sfx}", col, M.P(*wheel_c), props={"axis": [1.0, 0.0, 0.0], "radius": D.MAIN_TYRE_R,
                                                           "contactBelow": D.MAIN_TYRE_R - 0.015})
    M.parent_keep(wp, oleo)
    t = M.make_object(f"Tyre_{sfx}", *tyre(wheel_c, (side, 0, 0), D.MAIN_TYRE_R, D.MAIN_TYRE_W, 0.19, n=36), col,
                      mats["tire"], sharp_angle=70, origin=M.P(*wheel_c))
    h = M.make_object(f"Hub_{sfx}", *hub(wheel_c, (side, 0, 0), 0.19, D.MAIN_TYRE_W, bolts=10), col, mats["metal"],
                      sharp_angle=40, origin=M.P(*wheel_c))
    w = M.join([t, h], f"Wheel_{sfx}_mesh")
    M.parent_keep(w, wp)
    # Door on the well, under the body, hinged on its outboard edge; opens downwards.
    fs0, fs1 = 9.15, 10.75
    b0, b1 = 0.92, 1.33
    verts = []
    for bl in np.linspace(b0, b1, 4):
        for fs in np.linspace(fs0, fs1, 6):
            verts.append((side * bl, fs, F.wl_at(fs, bl, upper=False) - 0.004))
    vo = np.array(verts)
    vi = vo + np.array([0, 0, 0.012])
    n = len(vo)
    fo_ = M.grid_faces(4, 6)
    faces = list(fo_) + [tuple(i + n for i in reversed(x)) for x in fo_]
    hinge = np.array([side * b1, 0.5 * (fs0 + fs1), F.wl_at(0.5 * (fs0 + fs1), b1, upper=False)])
    d_ax = turn_axis(hinge, (0, 1.0, 0), np.array([side * b0, hinge[1], hinge[2]]), np.array([0, 0, -1.0]))
    dp = M.empty(f"MainDoor_{sfx}", col, M.P(*hinge), props={"axis": M.model_axis(*d_ax), "openDeg": 95.0})
    do = M.make_object(f"MainDoorMesh_{sfx}", np.vstack([vo, vi]), faces, col, mats["paint"], sharp_angle=50,
                       origin=M.P(*hinge))
    M.parent_keep(do, dp)
    parts[f"MainDoor_{sfx}"] = do
    # The well: a dark box in the belly.
    wv = []
    for bl in (b0 + 0.01, b1 - 0.01):
        for fs in (fs0 + 0.01, fs1 - 0.01):
            lo = F.wl_at(fs, bl, upper=False) + 0.005
            wv += [(side * bl, fs, lo), (side * bl, fs, lo + 0.42)]
    wv = np.array(wv)
    wf = [(0, 2, 6, 4)[::-1], (1, 5, 7, 3)[::-1], (0, 1, 3, 2), (4, 6, 7, 5), (1, 3, 7, 5)]
    M.make_object(f"MainWell_{sfx}", wv, wf, col, mats["well"], smooth=False, recalc=False)


def nose(col, mats, parts):
    pv = np.array(D.NOSE_PIVOT)
    axle = np.array([0.0, D.NOSE_AXLE_FS, D.NOSE_TYRE_R - 0.01])
    down = (axle - pv) / np.linalg.norm(axle - pv)
    ax = turn_axis(pv, (1.0, 0, 0), axle, np.array([0, -1.0, 0]))
    gear = M.empty("NoseGear", col, M.P(*pv), props={"axis": M.model_axis(*ax), "retractDeg": D.NOSE_RETRACT_DEG})
    collar = pv + down * 0.48
    upper = [M.cylinder(pv + np.array([-0.11, 0, 0]), pv + np.array([0.11, 0, 0]), 0.045, 12),
             M.cylinder(pv, collar, 0.07, 16),
             M.cylinder(collar - down * 0.02, collar + down * 0.04, 0.085, 16),
             # Drag brace folded along the leg.
             M.tube_path([pv + down * 0.32 + np.array([0, 0.07, 0]), pv + np.array([0, 0.09, -0.05])], 0.022, 8)]
    lc = pv + down * 0.30 + np.array([0, -0.085, 0])
    upper.append(M.lathe([(-0.07, 0.0), (-0.07, 0.065), (0.0, 0.07)], lc, (0, -1.0, -0.1), n=16,
                         close_start=True, close_end=False))
    u = M.make_object("NoseLeg", *M.merge(upper), col, mats["gear_paint"], sharp_angle=40, origin=M.P(*pv))
    M.parent_keep(u, gear)
    lo = M.make_object("Lamp_Landing", *lamp(lc + np.array([0, -0.002, 0]), (0, -1.0, -0.1), 0.06), col,
                       mats["landing"], sharp_angle=80, origin=M.P(*pv))
    M.parent_keep(lo, gear)
    glow = M.empty("Glow_Landing", col, M.P(*(lc + np.array([0, -0.04, 0]))), size=0.05, props={"kind": "Landing"})
    M.parent_keep(glow, gear)
    # Launch bar: hinged on the front of the strut, stowed up along it, lowered forward-down.
    lb_p = pv + down * 0.62 + np.array([0, -0.08, 0])
    lb_tip = lb_p + np.array([0, -0.12, 0.30])
    lb_ax = turn_axis(lb_p, (1.0, 0, 0), lb_tip, np.array([0, -1.0, -0.4]))
    lbar = M.empty("LaunchBar", col, M.P(*lb_p), props={"axis": M.model_axis(*lb_ax), "downDeg": 100.0})
    M.parent_keep(lbar, gear)
    bar = M.merge([M.tube_path([lb_p, lb_tip], [0.03, 0.022], 10),
                   M.rounded_box(lb_tip, (0.10, 0.05, 0.05), 0.012, 1)])
    bo = M.make_object("LaunchBar_mesh", *bar, col, mats["gear_paint"], sharp_angle=40, origin=M.P(*lb_p))
    M.parent_keep(bo, lbar)
    s_ax = turn_axis(collar, -down, axle + np.array([0, -0.2, 0]), np.array([-1.0, 0, 0]))
    steer = M.empty("NoseSteer", col, M.P(*collar), props={"axis": M.model_axis(*s_ax), "maxDeg": 75.0})
    M.parent_keep(steer, gear)
    oleo = M.empty("NoseOleo", col, M.P(*collar), props={"slide": [c * D.NOSE_STROKE for c in M.model_axis(*down)]})
    M.parent_keep(oleo, steer)
    piston = M.cylinder(collar - down * 0.08, axle + down * -0.02, 0.05, 14)
    po = M.make_object("NosePiston", *piston, col, mats["chrome"], sharp_angle=40, origin=M.P(*collar))
    M.parent_keep(po, oleo)
    axl = M.merge([M.cylinder(axle + np.array([-0.21, 0, 0]), axle + np.array([0.21, 0, 0]), 0.03, 10),
                   M.rounded_box(axle + np.array([0, 0.02, 0.05]), (0.12, 0.12, 0.12), 0.03, 2)])
    ao = M.make_object("NoseAxle", *axl, col, mats["gear_paint"], sharp_angle=40, origin=M.P(*collar))
    M.parent_keep(ao, oleo)
    wp = M.empty("Wheel_N", col, M.P(*axle), props={"axis": [1.0, 0.0, 0.0], "radius": D.NOSE_TYRE_R,
                                                   "contactBelow": D.NOSE_TYRE_R - 0.01})
    M.parent_keep(wp, oleo)
    ws = []
    for sx in (1, -1):
        c = axle + np.array([sx * D.NOSE_WHEEL_GAP, 0, 0])
        ws.append(M.make_object(f"TyreN_{sx}", *tyre(c, (sx, 0, 0), D.NOSE_TYRE_R, D.NOSE_TYRE_W, 0.13, n=30), col,
                                mats["tire"], sharp_angle=70, origin=M.P(*axle)))
        ws.append(M.make_object(f"HubN_{sx}", *hub(c, (sx, 0, 0), 0.13, D.NOSE_TYRE_W, bolts=6), col, mats["metal"],
                                sharp_angle=40, origin=M.P(*axle)))
    w = M.join(ws, "Wheel_N_mesh")
    M.parent_keep(w, wp)
    # Bay doors, hinged at the bay's sides.
    fs0, fs1, hw = 3.30, 4.62, 0.21
    for side, sfx in ((1, "L"), (-1, "R")):
        verts = []
        for bl in np.linspace(0.004, hw - 0.004, 3):
            for fs in np.linspace(fs0, fs1, 8):
                verts.append((side * bl, fs, F.wl_at(fs, bl, upper=False) - 0.003))
        vo = np.array(verts)
        vi = vo + np.array([0, 0, 0.01])
        n = len(vo)
        g = M.grid_faces(3, 8)
        faces = list(g) + [tuple(i + n for i in reversed(x)) for x in g]
        hinge = np.array([side * hw, 0.5 * (fs0 + fs1), F.wl_at(0.5 * (fs0 + fs1), hw, upper=False)])
        d_ax = turn_axis(hinge, (0, 1.0, 0), np.array([0.0, hinge[1], hinge[2]]), np.array([0, 0, -1.0]))
        dp = M.empty(f"NoseDoor_{sfx}", col, M.P(*hinge), props={"axis": M.model_axis(*d_ax), "openDeg": 85.0})
        do = M.make_object(f"NoseDoorMesh_{sfx}", np.vstack([vo, vi]), faces, col, mats["paint"], sharp_angle=50,
                           origin=M.P(*hinge))
        M.parent_keep(do, dp)
        parts[f"NoseDoor_{sfx}"] = do
    wv = []
    for bl in (-hw + 0.01, hw - 0.01):
        for fs in (fs0 + 0.01, fs1 - 0.01):
            lo = F.wl_at(fs, bl, upper=False) + 0.004
            wv += [(bl, fs, lo), (bl, fs, 1.98)]
    wf = [(0, 2, 6, 4)[::-1], (1, 5, 7, 3)[::-1], (0, 1, 3, 2), (4, 6, 7, 5), (1, 3, 7, 5)]
    M.make_object("NoseWell", np.array(wv), wf, col, mats["well"], smooth=False, recalc=False)


def hook(col, mats, parts):
    pv = np.array(D.HOOK_PIVOT)
    tip = pv + np.array([0, D.HOOK_LEN, 0.10])
    ax = turn_axis(pv, (1.0, 0, 0), tip, np.array([0, 0, -1.0]))
    piv = M.empty("Hook", col, M.P(*pv), props={"axis": M.model_axis(*ax), "downDeg": D.HOOK_DOWN_DEG})
    shank = M.merge([M.tube_path([pv, tip], [0.045, 0.035], 10),
                     M.tube_path([tip, tip + np.array([0, 0.10, -0.03]), tip + np.array([0, 0.13, -0.11])],
                                 [0.04, 0.04, 0.03], 10)])
    o = M.make_object("Hook_mesh", *shank, col, mats["hook"], sharp_angle=40, origin=M.P(*pv))
    M.parent_keep(o, piv)
    parts["Hook"] = o
