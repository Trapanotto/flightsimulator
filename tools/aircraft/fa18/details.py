"""
F/A-18C details: pitot and angle-of-attack probes, the gun port, antennas, exterior lights
(position, tail and anti-collision lights, the electroluminescent formation strips), the
vapour sheets (LEX vortices and wing-tip trails, faded in by the loader) and the pilot.
"""

import math

import numpy as np

from lib import mesh as M
from lib.parts import blade_antenna, ellipsoid
from . import dims as D
from . import fuselage as F
from . import tail as T
from . import wing as W


def build(col, mats, parts):
    ants = []
    for side in (1, -1):
        # Pitot tubes on the nose sides just aft of the radome, angle-of-attack probes behind them.
        fs = 2.55
        base = np.array([side * (F.half_width_at(fs, 2.18) - 0.01), fs, 2.18])
        tip = base + np.array([side * 0.05, -0.32, 0.0])
        ants.append(M.tube_path([base, base + np.array([side * 0.05, -0.05, 0]), tip], [0.018, 0.012, 0.008], 8))
        ants.append(M.cylinder(tip, tip + np.array([0, -0.07, 0]), 0.006, 8))
        fs = 2.95
        b2 = np.array([side * (F.half_width_at(fs, 1.92) - 0.005), fs, 1.92])
        ants.append(M.rounded_box(b2 + np.array([side * 0.04, -0.03, 0]), (0.08, 0.07, 0.008), 0.003, 1))
    ants += [blade_antenna((0.0, 9.6, F.wl_at(9.6, 0.0) - 0.01), 0.20, 0.13, 0.12),
             blade_antenna((0.0, 3.0, F.wl_at(3.0, 0.0, False) + 0.01), -0.16, 0.10, 0.08),
             blade_antenna((0.0, 11.4, F.wl_at(11.4, 0.0, False) + 0.01), -0.18, 0.11, 0.08),
             ellipsoid((0.0, 7.4, F.wl_at(7.4, 0.0) + 0.004), 0.07, 0.12, 0.02)]
    parts["Antennas"] = M.make_object("Antennas", *M.merge(ants), col, mats["antenna"], sharp_angle=40)
    # Gun port on top of the nose and the gun gas vents behind it (dark).
    ports = []
    fs = 1.30
    top = F.wl_at(fs, 0.0)
    ports.append(ellipsoid((0.0, fs, top - 0.005), 0.035, 0.06, 0.012))
    for k in range(3):
        f2 = 1.6 + k * 0.09
        ports.append(M.rounded_box((0.0, f2, F.wl_at(f2, 0.0) - 0.003), (0.10, 0.03, 0.012), 0.004, 1))
    parts["Ports"] = M.make_object("Ports", *M.merge(ports), col, mats["intake"], sharp_angle=40)
    return lights(col, mats, parts)


def strip(p0, p1, normal, width=0.05, lift=0.006):
    """A thin quad from p0 to p1 lying on a surface with `normal`."""
    p0, p1, n = np.asarray(p0, float), np.asarray(p1, float), np.asarray(normal, float)
    d = (p1 - p0) / np.linalg.norm(p1 - p0)
    w = np.cross(n, d)
    w /= np.linalg.norm(w)
    v = [p0 + n * lift - w * width / 2, p1 + n * lift - w * width / 2, p1 + n * lift + w * width / 2,
         p0 + n * lift + w * width / 2]
    return np.array(v), [(0, 1, 2, 3)]


def lights(col, mats, parts):
    anchors = {}
    tip_le, tip_wl = W._le(D.WING_TIP_BL)
    for side, sfx, mat in ((1, "L", "nav_red"), (-1, "R", "nav_green")):
        # Position light on the outboard face of the tip, ahead of the rail adapter.
        x = np.array([side * (D.WING_TIP_BL + 0.02), tip_le + 0.18, tip_wl + 0.045])
        parts[f"Lamp_Nav_{sfx}"] = M.make_object(f"Lamp_Nav_{sfx}", *ellipsoid(x, 0.025, 0.05, 0.02), col, mats[mat],
                                                 sharp_angle=80)
        anchors[f"Glow_Nav_{sfx}"] = x + np.array([side * 0.03, -0.02, 0.01])
        # Fin tip: the anti-collision light on the outboard side and the white tail light aft.
        h = D.FIN_SPAN - 0.12
        s = T.fin_xform(T.FIN.point(h, 0.35, 0.03), side)
        parts[f"Lamp_Strobe_{sfx}"] = M.make_object(f"Lamp_Strobe_{sfx}", *ellipsoid(s, 0.022, 0.06, 0.03), col,
                                                    mats["strobe"], sharp_angle=80)
        anchors[f"Glow_Strobe_{sfx}"] = s + np.array([side * 0.04, 0, 0])
        t = T.fin_xform(T.FIN.point(D.FIN_SPAN - 0.06, 0.99, 0.0), side)
        parts[f"Lamp_Tail_{sfx}"] = M.make_object(f"Lamp_Tail_{sfx}", *ellipsoid(t, 0.018, 0.03, 0.022), col,
                                                  mats["nav_white"], sharp_angle=80)
        anchors[f"Glow_Tail_{sfx}"] = t + np.array([0, 0.03, 0])
    # Formation strips: nose sides under the windscreen, wing tips, fins, the aft fuselage sides.
    st = []
    for side in (1, -1):
        for fs0, fs1, wl in ((2.45, 3.05, 2.17), (11.6, 12.3, 2.31)):
            a = np.array([side * F.half_width_at(fs0, wl), fs0, wl])
            b = np.array([side * F.half_width_at(fs1, wl), fs1, wl])
            st.append(strip(a, b, (side, 0, 0.0), 0.05))
        a = W.surface_point(side * (D.WING_TIP_BL - 0.12), tip_le + 0.2, upper=True)
        b = W.surface_point(side * (D.WING_TIP_BL - 0.12), tip_le + 1.15, upper=True)
        st.append(strip(a, b, (0, 0, 1.0), 0.05))
        c, s_ = math.cos(D.FIN_CANT), math.sin(D.FIN_CANT)
        n = np.array([side * c, 0, -s_])
        a = T.fin_xform(T.FIN.point(D.FIN_SPAN - 0.42, 0.25, 0.03), side)
        b = T.fin_xform(T.FIN.point(D.FIN_SPAN - 0.42, 0.62, 0.03), side)
        st.append(strip(a, b, n, 0.05))
    parts["Lamp_Formation"] = M.make_object("Lamp_Formation", *M.merge(st), col, mats["formation"], smooth=False)
    empties = {}
    for name, p in anchors.items():
        empties[name] = M.empty(name, col, M.P(*p), size=0.05, props={"kind": name[5:]})
    vapour(col, mats, parts)
    return empties


def cone(path, radii, n=14):
    """A tube along a path with uv (u along it, v round it), for the vapour sheets."""
    pts = np.asarray(path, float)
    verts, uv_v = [], []
    for i, p in enumerate(pts):
        t = pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]
        t /= np.linalg.norm(t)
        _, u, w = M.frame_from_axis(t)
        for k in range(n + 1):
            a = 2 * math.pi * k / n
            verts.append(p + radii[i] * (math.cos(a) * u + math.sin(a) * w))
            uv_v.append((i / (len(pts) - 1), k / n))
    faces = []
    for i in range(len(pts) - 1):
        for k in range(n):
            a = i * (n + 1) + k
            faces.append((a, a + n + 1, a + n + 2, a + 1))
    return np.array(verts), faces, uv_v


def vapour(col, mats, parts):
    """LEX vortices (cones over the LEX and the wing) and wing-tip trails (thin tubes)."""
    for name, mat, gen in (("VapourLex", "vapour_lex", _lex_paths), ("VapourTip", "vapour_tip", _tip_paths)):
        vs, fs, uvs, off = [], [], [], 0
        for path, radii in gen():
            v, f, uv = cone(path, radii)
            vs.append(v)
            fs += [tuple(i + off for i in x) for x in f]
            uvs += [uv[i] for x in f for i in x]
            off += len(v)
        parts[name] = M.make_object(name, np.vstack(vs), fs, col, mats[mat], smooth=True, uvs=uvs, recalc=False)


def _lex_paths():
    out = []
    for side in (1, -1):
        path = [(side * 0.62, 4.6, 2.32), (side * 0.95, 5.6, 2.40), (side * 1.35, 7.0, 2.50),
                (side * 1.85, 8.8, 2.62), (side * 2.3, 10.8, 2.75), (side * 2.6, 12.6, 2.85)]
        out.append((path, [0.02, 0.10, 0.22, 0.34, 0.42, 0.45]))
    return out


def _tip_paths():
    out = []
    le, wl = W._le(D.WING_TIP_BL)
    for side in (1, -1):
        p0 = np.array([side * (D.WING_TIP_BL - 0.05), le + 1.2, wl + 0.02])
        path = [p0 + np.array([0, k * 1.0, 0.02 * k]) for k in range(7)]
        out.append((path, [0.01, 0.04, 0.06, 0.07, 0.08, 0.08, 0.06]))
    return out


def pilot(col, mats):
    """The pilot: torso, arms, legs on the pedals and a helmet with its visor (seen from outside)."""
    sx = D.EYE
    body, helmet = [], []
    hip = np.array([0.0, 4.68, 2.36])
    neck = np.array([0.0, 4.73, 2.68])
    body.append(M.tube_path([hip, 0.5 * (hip + neck) + np.array([0, 0.02, 0]), neck], [0.16, 0.19, 0.12], 14))
    # Right hand on the stick, left hand on the throttles.
    for side, hand in ((1, np.array([0.36, 4.50, 2.42])), (-1, np.array([0.0, 4.22, 2.44]))):
        sh = neck + np.array([side * 0.19, 0.03, -0.06])
        el = np.array([side * 0.24, 4.60, 2.32])
        body.append(M.tube_path([sh, el, hand], [0.06, 0.05, 0.04], 10))
        knee = np.array([side * 0.13, 4.22, 2.40])
        foot = np.array([side * 0.13, 3.92, 2.14])
        body.append(M.tube_path([hip + np.array([side * 0.1, 0, -0.04]), knee, foot], [0.085, 0.07, 0.05], 10))
    head = np.array([sx[0], sx[1] + 0.07, sx[2] + 0.06])
    helmet.append(ellipsoid(head, 0.13, 0.145, 0.15, 18, 12))
    visor = ellipsoid(head + np.array([0, -0.06, -0.02]), 0.125, 0.10, 0.09, 16, 10)
    v = visor[0]
    keep = v[:, 1] < head[1] - 0.06
    b = M.make_object("PilotBody", *M.merge(body), col, mats["flight_suit"], sharp_angle=60)
    h = M.make_object("PilotHelmet", *M.merge(helmet), col, mats["helmet"], sharp_angle=60)
    vo = M.make_object("PilotVisor", *visor, col, mats["visor"], sharp_angle=60)
    del keep
    return M.join([b, h, vo], "Pilot")
