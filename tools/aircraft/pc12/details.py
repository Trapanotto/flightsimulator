"""PT6 exhaust stubs, antennas, pitot probes, static wicks, fuel caps and the exterior lights."""

import math

import numpy as np

from lib import mesh as M
from lib.parts import blade_antenna, ellipsoid
from . import dims as D
from . import wing as W
from .fuselage import T


def exhaust_stub(side):
    """Oval stack leaving the cowling side, turning aft and out (design frame)."""
    rows = []
    n = 18
    for t in np.linspace(0, 1, 9):
        fs = 1.02 + 0.36 * t
        out = 0.02 + 0.20 * t ** 1.4
        bl = side * (T.half_width_at(fs, 1.66) - 0.05 + out)
        wl = 1.66 - 0.07 * t
        a_h = 0.10 + 0.025 * t
        b_h = 0.065 + 0.012 * t
        tang = np.array([side * 0.45 * t + side * 0.05, 1.0, -0.12])
        tang /= np.linalg.norm(tang)
        u = np.array([0, 0, 1.0])
        v = np.cross(tang, u)
        v /= np.linalg.norm(v)
        u = np.cross(v, tang)
        c = np.array([bl, fs, wl])
        rows.append([c + a_h * math.cos(2 * math.pi * k / n) * u * 0.7 + b_h * math.sin(2 * math.pi * k / n) * v
                     + a_h * 0.3 * math.cos(2 * math.pi * k / n) * u for k in range(n)])
    outer = rows
    inner = [[c0 + (p - c0) * 0.86 for p in r] for r, c0 in
             ((r, np.mean(r, 0)) for r in rows)]
    v = np.array([p for r in outer for p in r] + [p for r in inner for p in r])
    m = len(rows) * n
    f = M.grid_faces(len(rows), n, wrap_cols=True)
    f += [tuple(i + m for i in reversed(face)) for face in M.grid_faces(len(rows), n, wrap_cols=True)]
    last = (len(rows) - 1) * n
    for k in range(n):
        a, b = last + k, last + (k + 1) % n
        f.append((b, a, a + m, b + m))
    return v, f


def build(col, mats, parts):
    ex = M.merge([exhaust_stub(1), exhaust_stub(-1)])
    parts["Exhaust"] = M.make_object("Exhaust", *ex, col, mats["exhaust"], sharp_angle=60)
    # --- antennas, probes, wicks ------------------------------------------------------------
    ants = [blade_antenna((0.0, 5.3, T.wl_at(5.3, 0.0) - 0.01), 0.24, 0.11, 0.10),     # COM 1
            blade_antenna((0.0, 9.6, T.wl_at(9.6, 0.0) - 0.01), 0.20, 0.10, 0.09),     # COM 2
            blade_antenna((0.0, 4.6, 0.81), -0.16, 0.08, 0.05),                          # transponder
            blade_antenna((0.0, 9.0, 0.86), -0.14, 0.07, 0.05),                          # DME
            ellipsoid((0.0, 7.0, T.wl_at(7.0, 0.0) + 0.004), 0.06, 0.09, 0.018)]          # GPS
    for side, sfx in ((1, "L"), (-1, "R")):
        # Pitot (and on the left the AOA vane) under the wing, ahead of the leading edge.
        base, _ = W.surface_point(side * 3.6, W._le(side * 3.6)[0] + 0.35)
        ants.append(M.tube_path([base + np.array([0, 0, 0.02]), base - np.array([0, 0, 0.13]),
                                 base + np.array([0, -0.42, -0.13])], [0.014, 0.012, 0.008], 10))
        tip = base + np.array([0, -0.42, -0.13])
        ants.append(M.cylinder(tip, tip + np.array([0, -0.06, 0]), 0.006, 8))
        # Winglet trailing-edge wick.
        tep = np.array([side * (D.TIP_BL + 0.32), W._le(side * D.TIP_BL)[0] + D.TIP_CHORD + 0.02,
                        W._le(side * D.TIP_BL)[1] + 0.45])
        ants.append(M.tube_path([tep, tep + np.array([0, 0.11, 0.03])], [0.003, 0.0018], 5))
    vane, _ = W.surface_point(2.7, W._le(2.7)[0] + 0.05)
    ants.append(M.rounded_box(vane + np.array([0, -0.06, -0.03]), (0.004, 0.06, 0.04), 0.002, 1))
    v, f = M.merge(ants)
    parts["Antennas"] = M.make_object("Antennas", v, f, col, mats["antenna"], sharp_angle=40)
    # --- fuel caps on the wing, tie-down rings ----------------------------------------------
    fit = []
    for side in (1, -1):
        cap, _ = W.surface_point(side * 5.7, W._le(side * 5.7)[0] + 0.35, upper=True)
        fit.append(M.cylinder(cap - np.array([0, 0, 0.006]), cap + np.array([0, 0, 0.008]), 0.05, 20))
        tie, _ = W.surface_point(side * 4.0, W._le(side * 4.0)[0] + 0.5)
        fit.append(M.tube_path([tie, tie - np.array([0, 0, 0.05])], 0.008, 8))
    fit.append(M.tube_path([(0, 12.6, T.wl_at(12.6, 0.0, False)), (0, 12.6, T.wl_at(12.6, 0.0, False) - 0.05)],
                           0.008, 8))
    v, f = M.merge(fit)
    parts["Fittings"] = M.make_object("Fittings", v, f, col, mats["steel"], sharp_angle=40)
    return lights(col, mats, parts)


def lights(col, mats, parts):
    """Lamps as emissive geometry plus anchor empties for the loader's glow sprites."""
    anchors = {}
    for side, sfx, mat in ((1, "L", "nav_red"), (-1, "R", "nav_green")):
        le_fs, wl = W._le(side * D.TIP_BL)
        x = np.array([side * (D.TIP_BL + 0.07), le_fs + 0.10, wl + 0.035])
        v, f = ellipsoid(x, 0.03, 0.05, 0.025)
        parts[f"Lamp_Nav_{sfx}"] = M.make_object(f"Lamp_Nav_{sfx}", v, f, col, mats[mat], sharp_angle=80)
        anchors[f"Glow_Nav_{sfx}"] = x + np.array([side * 0.03, -0.02, 0])
        s = x + np.array([0, 0.11, 0.0])
        v, f = ellipsoid(s, 0.022, 0.035, 0.02)
        parts[f"Lamp_Strobe_{sfx}"] = M.make_object(f"Lamp_Strobe_{sfx}", v, f, col, mats["strobe"], sharp_angle=80)
        anchors[f"Glow_Strobe_{sfx}"] = s + np.array([side * 0.03, 0, 0])
        r = np.array([side * (D.TIP_BL - 0.10), le_fs + 0.015, wl + 0.01])
        v, f = M.lathe([(0.0, 0.0), (0.0, 0.035), (0.006, 0.033)], r, (0, -1.0, 0), n=16, close_start=False,
                       close_end=False)
        parts[f"Lamp_Recog_{sfx}"] = M.make_object(f"Lamp_Recog_{sfx}", v, f, col, mats["recognition"],
                                                  sharp_angle=80)
        anchors[f"Glow_Recog_{sfx}"] = r + np.array([0, -0.03, 0])
        v, f = ellipsoid(x + np.array([0, 0.05, 0]), 0.045, 0.12, 0.04)
        parts[f"Lens_{sfx}"] = M.make_object(f"Lens_{sfx}", v, f, col, mats["lens"], sharp_angle=80)
    # Tail position light on the cone's end, beacon on the bullet fairing.
    tail = np.array([0.0, 13.33, 2.02])
    v, f = ellipsoid(tail, 0.02, 0.03, 0.022)
    parts["Lamp_Tail"] = M.make_object("Lamp_Tail", v, f, col, mats["nav_white"], sharp_angle=80)
    anchors["Glow_Tail"] = tail + np.array([0, 0.03, 0])
    top = np.array([0.0, 13.25, D.HSTAB_WL + 0.12])
    v, f = M.lathe([(0, 0.036), (0.035, 0.034), (0.06, 0.018), (0.068, 0.0)], top, (0, 0, 1.0), n=20,
                   close_start=True, close_end=False)
    parts["Lamp_Beacon"] = M.make_object("Lamp_Beacon", v, f, col, mats["beacon"], sharp_angle=60)
    anchors["Glow_Beacon"] = top + np.array([0, 0, 0.06])
    # Ice-inspection light on the left side, aimed at the wing's leading edge.
    ice_at = np.array([T.half_width_at(4.75, 1.55) + 0.005, 4.75, 1.55])
    v, f = M.lathe([(0.0, 0.0), (0.0, 0.026), (0.008, 0.024)], ice_at, (1.0, 0.4, -0.25), n=14, close_start=False,
                   close_end=False)
    parts["Lamp_Ice"] = M.make_object("Lamp_Ice", v, f, col, mats["ice"], sharp_angle=80)
    anchors["Glow_Ice"] = ice_at + np.array([0.02, 0.01, 0])
    empties = {}
    for name, p in anchors.items():
        empties[name] = M.empty(name, col, M.P(*p), size=0.05, props={"kind": name[5:]})
    return empties
