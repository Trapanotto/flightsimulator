"""Struts, lights, antennas, pitot tube, fuel caps, handles, exhaust and other small parts."""

import math

import numpy as np

from lib import mesh as M
from . import dims as D
from . import wing as W


def streamline_bar(a, b, chord, thick, n=16, taper=0.8):
    """Strut with a teardrop section, its chord kept parallel to the flight direction (FS)."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    axis = (b - a) / np.linalg.norm(b - a)
    fwd = np.array([0.0, -1.0, 0.0])
    fwd = fwd - axis * np.dot(fwd, axis)
    fwd /= np.linalg.norm(fwd)
    side = np.cross(axis, fwd)
    rows = []
    steps = 10
    for i in range(steps + 1):
        t = i / steps
        p = a + (b - a) * t
        sc = 1.0 - (1 - taper) * abs(2 * t - 1) ** 2
        ring = []
        for k in range(n):
            ang = 2 * math.pi * k / n
            x = math.cos(ang)
            # Teardrop: round nose forward, thin tail aft.
            along = 0.5 * chord * sc * (x if x > 0 else x * 1.0)
            half_t = 0.5 * thick * sc * math.sin(ang) * (1 - 0.55 * max(-x, 0) ** 1.5)
            ring.append(p + fwd * (along + 0.12 * chord * sc) + side * half_t)
        rows.append(ring)
    v = np.array([q for r in rows for q in r])
    f = M.grid_faces(len(rows), n, wrap_cols=True)
    c = len(v)
    v = np.vstack([v, [np.mean(rows[0], 0)], [np.mean(rows[-1], 0)]])
    f += M.fan_cap(list(range(n)), c, reverse=True)
    last = steps * n
    f += M.fan_cap(list(range(last, last + n)), c + 1)
    return v, f


def ellipsoid(c, rx, ry, rz, nu=16, nv=10):
    verts, faces = [], []
    for i in range(1, nv):
        th = math.pi * i / nv
        for k in range(nu):
            ph = 2 * math.pi * k / nu
            verts.append((c[0] + rx * math.sin(th) * math.cos(ph), c[1] + ry * math.sin(th) * math.sin(ph),
                          c[2] + rz * math.cos(th)))
    faces = M.grid_faces(nv - 1, nu, wrap_cols=True)
    top, bot = len(verts), len(verts) + 1
    verts += [(c[0], c[1], c[2] + rz), (c[0], c[1], c[2] - rz)]
    faces += M.fan_cap(list(range(nu)), top, reverse=True)
    last = (nv - 2) * nu
    faces += M.fan_cap(list(range(last, last + nu)), bot)
    return np.array(verts), faces


def blade_antenna(base, height, chord, sweep, thick=0.012):
    """Swept blade antenna standing on `base` (design frame)."""
    b = np.asarray(base, float)
    pts = [b + (0, -chord / 2, 0), b + (0, chord / 2, 0), b + (0, chord / 2 + sweep, height),
           b + (0, sweep + chord * 0.1, height)]
    poly = [(p[1], p[2]) for p in pts]
    poly = M.rounded_polygon(poly, 0.015, 3)
    return M.prism(poly, 0, b[0] - thick / 2, b[0] + thick / 2, (1, 2))


def build(col, mats, parts):
    paint, fixed_metal, dark = [], [], []
    # --- lift struts ---------------------------------------------------------------------
    for side in (1, -1):
        bot = np.array([side * 0.50, 1.20, 0.86])
        top = W.wing_surface(side * 2.62, 0.22, upper=False) + np.array([0, 0, 0.01])
        paint.append(streamline_bar(bot, top, 0.115, 0.036))
        # Cuffs where the strut meets wing and fuselage.
        paint.append(ellipsoid(top - np.array([0, 0, 0.03]), 0.045, 0.11, 0.05))
        paint.append(ellipsoid(bot + np.array([side * 0.0, 0.0, 0.0]), 0.05, 0.12, 0.045))
        # Step and handle on the strut for refuelling.
        p = bot + (top - bot) * 0.12
        fixed_metal.append(M.rounded_box(p + np.array([side * 0.0, 0.0, 0.0]), (0.03, 0.10, 0.012), 0.003, 1))
    v, f = M.merge(paint)
    parts["Struts"] = M.make_object("Struts", v, f, col, mats["paint"], sharp_angle=45)
    # --- door handles, fuel caps, pitot, tie-downs -------------------------------------
    for side in (1, -1):
        bl = side * 0.545
        fixed_metal.append(M.rounded_box((bl, 1.28, 1.36), (0.018, 0.12, 0.022), 0.008, 2))
        cap = W.wing_surface(side * 1.62, 0.30, upper=True)
        fixed_metal.append(M.cylinder(cap - np.array([0, 0, 0.012]), cap + np.array([0, 0, 0.012]), 0.045, 20))
        fixed_metal.append(M.cylinder(cap + np.array([0, 0, 0.008]), cap + np.array([0, 0, 0.016]), 0.02, 12))
        tie = W.wing_surface(side * 3.3, 0.3, upper=False)
        fixed_metal.append(M.tube_path([tie, tie - np.array([0, 0, 0.05])], 0.008, 8))
    pitot_base = W.wing_surface(3.55, 0.25, upper=False)
    fixed_metal.append(M.tube_path([pitot_base + np.array([0, 0, 0.02]), pitot_base - np.array([0, 0, 0.09]),
                                    pitot_base + np.array([0, -0.35, -0.09])], [0.012, 0.01, 0.007], 10))
    vent = W.wing_surface(2.9, 0.2, upper=False)
    fixed_metal.append(M.tube_path([vent + np.array([0, 0, 0.01]), vent + np.array([0, -0.06, -0.14])], 0.006, 8))
    # Tail tie-down ring under the tailcone.
    fixed_metal.append(M.tube_path([(0, 6.25, 1.09), (0, 6.25, 1.03)], 0.008, 8))
    v, f = M.merge(fixed_metal)
    parts["Fittings"] = M.make_object("Fittings", v, f, col, mats["steel"], sharp_angle=40)
    # --- exhaust (right side, under the cowling) ----------------------------------------
    ex = M.tube_path([(-0.20, -0.22, 0.86), (-0.22, -0.12, 0.81), (-0.24, 0.02, 0.78)], 0.026, 14, cap=False)
    parts["Exhaust"] = M.make_object("Exhaust", *ex, col, mats["exhaust"], sharp_angle=50)
    # --- antennas -----------------------------------------------------------------------
    ants = [blade_antenna((0.0, 3.05, 1.53), 0.24, 0.10, 0.12),
            blade_antenna((0.0, 3.45, 1.48), 0.20, 0.09, 0.10),
            blade_antenna((0.0, 1.90, 0.735), -0.11, 0.06, 0.03),   # transponder under the belly
            M.tube_path([(0.0, 4.6, 1.44), (0.0, 4.75, 1.80)], [0.006, 0.003], 6)]   # ELT whip
    # VOR "cat whiskers" on the fin.
    for side in (1, -1):
        root = np.array([side * 0.03, 6.62, 2.50])
        ants.append(M.tube_path([root, root + np.array([side * 0.40, -0.30, 0.02])], [0.006, 0.004], 6))
    v, f = M.merge(ants)
    parts["Antennas"] = M.make_object("Antennas", v, f, col, mats["antenna"], sharp_angle=40)
    return lights(col, mats, parts)


def lights(col, mats, parts):
    """Lamps as emissive geometry plus anchor empties for the loader's glow sprites."""
    anchors = {}
    for side, sfx, mat in ((1, "L", "nav_red"), (-1, "R", "nav_green")):
        bl = side * (D.SPAN / 2 - 0.035)
        le = W.WING.point(side * D.TIP_BL, 0.06, 0.0)
        nav = np.array([bl, le[1] + 0.02, le[2] - 0.01])
        v, f = ellipsoid(nav, 0.022, 0.035, 0.02)
        parts[f"Lamp_Nav_{sfx}"] = M.make_object(f"Lamp_Nav_{sfx}", v, f, col, mats[mat], sharp_angle=80)
        anchors[f"Glow_Nav_{sfx}"] = nav + np.array([side * 0.02, -0.01, 0])
        strobe = nav + np.array([0, 0.07, 0.0])
        v, f = ellipsoid(strobe, 0.018, 0.025, 0.016)
        parts[f"Lamp_Strobe_{sfx}"] = M.make_object(f"Lamp_Strobe_{sfx}", v, f, col, mats["strobe"], sharp_angle=80)
        anchors[f"Glow_Strobe_{sfx}"] = strobe + np.array([side * 0.02, 0, 0])
        # Clear lens over both.
        v, f = ellipsoid(nav + np.array([0, 0.035, 0]), 0.03, 0.085, 0.03)
        parts[f"Lens_{sfx}"] = M.make_object(f"Lens_{sfx}", v, f, col, mats["lens"], sharp_angle=80)
    # Landing and taxi lights in the left wing leading edge (172S).
    for name, bl, tilt in (("Landing", 2.98, -0.04), ("Taxi", 3.18, -0.10)):
        le = W.WING.point(bl, 0.0, 0.0)
        c = le + np.array([0, -0.004, -0.004])
        axis = np.array([0, -1.0, tilt])
        v, f = M.lathe([(0.0, 0.0), (0.0, 0.042), (0.006, 0.040)], c, axis, n=20, close_start=False,
                       close_end=False)
        parts[f"Lamp_{name}"] = M.make_object(f"Lamp_{name}", v, f, col, mats["landing"], sharp_angle=80)
        anchors[f"Glow_{name}"] = c + np.array([0, -0.02, 0])
    # Tail position light at the bottom of the rudder trailing edge, beacon on the fin top.
    tail = W.FIN.point(D.RUDDER_BOTTOM_WL + 0.03, 1.0, 0.0) + np.array([0, 0.012, 0])
    v, f = ellipsoid(tail, 0.014, 0.024, 0.016)
    parts["Lamp_Tail"] = M.make_object("Lamp_Tail", v, f, col, mats["nav_white"], sharp_angle=80)
    anchors["Glow_Tail"] = tail + np.array([0, 0.02, 0])
    top = W.FIN.point(D.FIN_TOP_WL, 0.45, 0.0)
    beacon = top + np.array([0, 0, 0.055])
    v, f = M.lathe([(0, 0.032), (0.03, 0.03), (0.055, 0.016), (0.062, 0.0)], top + np.array([0, 0, 0.0]),
                   (0, 0, 1.0), n=20, close_start=True, close_end=False)
    parts["Lamp_Beacon"] = M.make_object("Lamp_Beacon", v, f, col, mats["beacon"], sharp_angle=60)
    anchors["Glow_Beacon"] = beacon
    empties = {}
    for name, p in anchors.items():
        empties[name] = M.empty(name, col, M.P(*p), size=0.05, props={"kind": name[5:]})
    return empties
