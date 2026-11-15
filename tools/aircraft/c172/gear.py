"""Fixed tricycle gear: tubular spring-steel main legs, oleo nose strut, wheels and fairings."""

import math

import bmesh
import numpy as np
from mathutils import Vector

from lib import mesh as M
from lib.parts import hub, tyre
from . import dims as D


def fairing(nose_fs, length, center_bl, top_wl, half_w, axle_wl, n_sec=30, n_ring=36):
    """Speed fairing: a teardrop lofted along FS, its bottom cut open for the tyre."""
    rows = []
    ts = 0.5 * (1 - np.cos(np.linspace(0, math.pi, n_sec)))
    prof = 2.2 * np.sqrt(ts) * (1 - ts) ** 1.2
    prof /= prof.max()
    for t, f in zip(ts, prof):
        fs = nose_fs + t * length
        cz = axle_wl + 0.02
        hh = max(f, 0.03) * (top_wl - cz)
        hwid = max(f, 0.015) * half_w
        ring = []
        for k in range(n_ring):
            a = 2 * math.pi * k / n_ring
            c, s = math.cos(a), math.sin(a)
            ring.append((center_bl + hwid * np.sign(s) * abs(s) ** (2 / 3.0), fs,
                         cz + hh * np.sign(c) * abs(c) ** (2 / 2.6)))
        rows.append(ring)
    v = np.array([p for r in rows for p in r])
    f = M.grid_faces(n_sec, n_ring, wrap_cols=True)
    c = len(v)
    v = np.vstack([v, [np.mean(rows[0], 0)], [np.mean(rows[-1], 0)]])
    f += M.fan_cap(list(range(n_ring)), c, reverse=True)
    last = (n_sec - 1) * n_ring
    f += M.fan_cap(list(range(last, last + n_ring)), c + 1)
    return v, f


def cut_bottom(obj, wl, thickness=0.004):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    z = wl - M.REF[2] - obj.location.z
    geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
    bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, z), plane_no=(0, 0, 1), clear_inner=True)
    bm.to_mesh(obj.data)
    bm.free()
    mod = obj.modifiers.new("Solid", "SOLIDIFY")
    mod.thickness = thickness
    mod.offset = -1
    mod.use_rim = True
    M.apply_modifiers(obj)


def build(col, mats, parts):
    fixed = []
    # --- main gear -----------------------------------------------------------------
    for side, sfx in ((1, "L"), (-1, "R")):
        bl = side * D.MAIN_TRACK / 2
        axle = np.array([bl, D.MAIN_AXLE_FS, D.MAIN_TYRE_R - 0.008])  # tyre slightly flattened
        axis = (side, 0, 0)
        # Spring-steel leg: tapered tube from the fuselage box down and out to the axle.
        leg_pts = [(side * 0.40, 1.40, 0.78), (side * 0.62, 1.42, 0.62), (side * 0.86, 1.445, 0.45),
                   (side * 1.06, 1.465, 0.31), (side * (abs(bl) - 0.11), 1.473, axle[2] + 0.015)]
        leg = M.tube_path(leg_pts, [0.027, 0.025, 0.023, 0.021, 0.019], 14)
        step = M.rounded_box((side * 0.70, 1.33, 0.585), (0.10, 0.14, 0.012), 0.004, 2)
        step_arm = M.cylinder((side * 0.66, 1.415, 0.57), (side * 0.70, 1.33, 0.585), 0.008, 8)
        v, f = M.merge([leg, step_arm])
        fixed.append(M.make_object(f"GearLeg_{sfx}", v, f, col, mats["gear_paint"], sharp_angle=50))
        v, f = step
        fixed.append(M.make_object(f"GearStep_{sfx}", v, f, col, mats["steel"], sharp_angle=40))
        # Brake caliper (fixed) on the inboard side.
        cal = M.rounded_box((side * (abs(bl) - 0.085), D.MAIN_AXLE_FS - 0.07, axle[2] + 0.04),
                            (0.03, 0.05, 0.06), 0.008, 2)
        fixed.append(M.make_object(f"Caliper_{sfx}", *cal, col, mats["steel"], sharp_angle=40))
        # Speed fairing, fixed to the axle.
        v, f = fairing(D.MAIN_AXLE_FS - 0.34, 1.02, bl, 0.445, 0.13, axle[2])
        fo = M.make_object(f"WheelFairing_{sfx}", v, f, col, mats["paint"], sharp_angle=60)
        cut_bottom(fo, 0.06)
        parts[f"WheelFairing_{sfx}"] = fo
        # Wheel (rotating node).
        piv = M.empty(f"Wheel_{sfx}", col, M.P(*axle), props={"axis": [1.0, 0.0, 0.0], "radius": D.MAIN_TYRE_R})
        tv, tf = tyre(axle, axis, D.MAIN_TYRE_R, D.MAIN_TYRE_W, 0.085)
        t = M.make_object(f"Tyre_{sfx}", tv, tf, col, mats["tire"], sharp_angle=70, origin=M.P(*axle))
        hv, hf = hub(axle, axis, 0.085, D.MAIN_TYRE_W)
        h = M.make_object(f"Hub_{sfx}", hv, hf, col, mats["metal"], sharp_angle=40, origin=M.P(*axle))
        disc = M.cylinder(axle - np.array(axis) * 0.065, axle - np.array(axis) * 0.073, 0.095, 28)
        dobj = M.make_object(f"BrakeDisc_{sfx}", *disc, col, mats["steel"], sharp_angle=40, origin=M.P(*axle))
        w = M.join([t, h, dobj], f"Wheel_{sfx}_mesh")
        M.parent_keep(w, piv)
        parts[f"Wheel_{sfx}"] = w
    # --- nose gear -----------------------------------------------------------------
    axle = np.array([0.0, D.NOSE_AXLE_FS, D.NOSE_TYRE_R - 0.006])
    top = np.array([0.0, -0.06, 0.86])
    fork_top = np.array([0.0, -0.15, 0.44])
    strut_axis = (top - fork_top) / np.linalg.norm(top - fork_top)
    upper = M.cylinder(top, top - strut_axis * 0.28, 0.036, 20)
    collar = M.cylinder(top - strut_axis * 0.27, top - strut_axis * 0.30, 0.042, 20)
    fixed.append(M.make_object("NoseStrut", *M.merge([upper, collar]), col, mats["gear_paint"], sharp_angle=40))
    # Steering: everything below the collar turns about the strut axis.
    steer_origin = top - strut_axis * 0.30
    probe = axle + np.array([0, -0.2, 0])
    ax = strut_axis
    moved = M.rot_axis(ax, 0.05) @ (probe - steer_origin) + steer_origin
    if moved[0] > probe[0]:   # want the front of the wheel to move right (-BL) for positive
        ax = -ax
    steer = M.empty("NoseSteer", col, M.P(*steer_origin), props={"axis": M.model_axis(*ax), "maxDeg": 10.0})
    piston = M.cylinder(steer_origin, fork_top, 0.025, 18)
    fork_w = 0.075
    fork = M.merge([
        M.rounded_box(fork_top + np.array([0, 0, -0.01]), (2 * fork_w + 0.03, 0.06, 0.035), 0.01, 2),
        M.tube_path([fork_top + np.array([fork_w, 0, -0.02]), axle + np.array([fork_w, 0.0, 0.0])], 0.012, 10),
        M.tube_path([fork_top + np.array([-fork_w, 0, -0.02]), axle + np.array([-fork_w, 0.0, 0.0])], 0.012, 10),
    ])
    # Torque links (scissors) in front of the strut.
    mid = 0.5 * (steer_origin + fork_top) + np.array([0, -0.07, 0])
    links = M.merge([M.tube_path([steer_origin + np.array([0, -0.02, -0.02]), mid, fork_top + np.array([0, -0.03, 0.02])],
                                 0.008, 8)])
    po = M.make_object("NosePiston", *piston, col, mats["chrome"], sharp_angle=40, origin=M.P(*steer_origin))
    fo = M.make_object("NoseFork", *M.merge([fork, links]), col, mats["gear_paint"], sharp_angle=40,
                       origin=M.P(*steer_origin))
    v, f = fairing(D.NOSE_AXLE_FS - 0.30, 0.76, 0.0, 0.39, 0.112, axle[2])
    nf = M.make_object("NoseFairing", v, f, col, mats["paint"], sharp_angle=60, origin=M.P(*steer_origin))
    cut_bottom(nf, 0.055)
    # The fork passes through the top of the fairing; that is how the real one is built.
    for o in (po, fo, nf):
        M.parent_keep(o, steer)
    parts["NoseFairing"] = nf
    wp = M.empty("Wheel_N", col, M.P(*axle), props={"axis": [1.0, 0.0, 0.0], "radius": D.NOSE_TYRE_R})
    M.parent_keep(wp, steer)
    tv, tf = tyre(axle, (1, 0, 0), D.NOSE_TYRE_R, D.NOSE_TYRE_W, 0.068)
    t = M.make_object("Tyre_N", tv, tf, col, mats["tire"], sharp_angle=70, origin=M.P(*axle))
    hv, hf = hub(axle, (1, 0, 0), 0.068, D.NOSE_TYRE_W)
    h = M.make_object("Hub_N", hv, hf, col, mats["metal"], sharp_angle=40, origin=M.P(*axle))
    w = M.join([t, h], "Wheel_N_mesh")
    M.parent_keep(w, wp)
    parts["Wheel_N"] = w
    parts["GearFixed"] = M.join(fixed[:1] + [o for o in fixed[1:]], "GearFixed")
    return steer
