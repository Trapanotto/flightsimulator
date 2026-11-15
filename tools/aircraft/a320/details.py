"""Antennas, pitot probes and angle-of-attack vanes, wipers, the APU exhaust and the exterior
lights (lamps as emissive geometry plus Glow_<kind> anchors for the loader's sprites)."""

import math

import numpy as np

from lib import mesh as M
from lib.parts import blade_antenna, ellipsoid
from . import dims as D
from . import tail
from . import wing as W
from .fuselage import T


def side_point(fs, wl, side, out=0.0):
    return np.array([side * (T.half_width_at(fs, wl) + out), fs, wl])


def build(col, mats, parts):
    top = lambda fs: T.wl_at(fs, 0.0) - 0.01  # noqa: E731
    bot = lambda fs: T.wl_at(fs, 0.0, False) + 0.01  # noqa: E731
    ants = [blade_antenna((0.0, 9.2, top(9.2)), 0.36, 0.20, 0.16, 0.02),       # VHF 1
            blade_antenna((0.0, 23.5, top(23.5)), 0.30, 0.18, 0.14, 0.02),     # VHF 3
            blade_antenna((0.0, 8.0, bot(8.0)), -0.30, 0.18, 0.12, 0.02),      # VHF 2
            blade_antenna((0.0, 7.0, bot(7.0)), -0.12, 0.09, 0.05, 0.015),     # ATC
            blade_antenna((0.0, 25.0, bot(25.0)), -0.12, 0.09, 0.05, 0.015),   # DME
            ellipsoid((0.0, 13.5, top(13.5) + 0.01), 0.10, 0.16, 0.03),         # GPS
            ellipsoid((0.0, 14.4, top(14.4) + 0.01), 0.10, 0.16, 0.03)]
    for side in (1, -1):
        # Pitot probes (two on the left, one on the right) and the AoA vanes, on the nose sides.
        for fs, wl in ((2.45, 3.72),) + (((2.45, 3.40),) if side > 0 else ()):
            base = side_point(fs, wl, side, -0.01)
            o = np.array([side, 0, 0])
            ants.append(M.tube_path([base, base + o * 0.10, base + o * 0.11 + np.array([0, -0.18, 0])],
                                    [0.018, 0.014, 0.010], 8))
        vane = side_point(3.05, 3.25, side, 0.0)
        ants.append(M.rounded_box(vane + np.array([side * 0.03, 0.0, 0.0]), (0.006, 0.10, 0.06), 0.003, 1))
        tat = side_point(1.9, 3.15, side, -0.01)
        ants.append(M.tube_path([tat, tat + np.array([side * 0.07, 0.03, 0])], [0.012, 0.008], 6))
    v, f = M.merge(ants)
    parts["Antennas"] = M.make_object("Antennas", v, f, col, mats["antenna"], sharp_angle=40)
    # Wipers: parked along the lower frame of each windshield, pointing inboard.
    wip = []
    for side in (1, -1):
        p0 = np.array([side * 0.95, 0.0, 4.58])
        p0[1] = _windshield_fs(p0[0], p0[2]) - 0.02
        p1 = np.array([side * 0.25, 0.0, 4.53])
        p1[1] = _windshield_fs(p1[0], p1[2]) - 0.02
        wip.append(M.tube_path([p0, p1], 0.012, 6))
        wip.append(M.cylinder(p0 + np.array([0, 0.03, -0.02]), p0 + np.array([0, -0.03, 0.02]), 0.018, 10))
    v, f = M.merge(wip)
    parts["Wipers"] = M.make_object("Wipers", v, f, col, mats["antenna"], sharp_angle=40)
    parts["ApuExhaust"] = tail.apu_exhaust(col, mats)
    return lights(col, mats, parts)


def _windshield_fs(bl, wl):
    """FS of the skin in front of (bl, wl) on the nose."""
    for fs in np.linspace(1.5, 4.0, 251):
        hw = T.half_width_at(fs, wl) if wl <= float(T.key(T.top, fs)) else 0.0
        if hw >= abs(bl):
            return fs
    return 3.0


def lights(col, mats, parts):
    anchors = {}
    lamps = {}

    def add(mat, vf):
        lamps.setdefault(mat, []).append(vf)

    le_fs, wl = W._le(D.TIP_BL)
    for side, sfx, mat in ((1, "L", "nav_red"), (-1, "R", "nav_green")):
        x = np.array([side * (D.TIP_BL + 0.06), le_fs + 0.30, wl + 0.02])
        add(mat, ellipsoid(x, 0.04, 0.07, 0.035))
        anchors[f"Glow_Nav_{sfx}"] = x + np.array([side * 0.04, -0.04, 0])
        s = x + np.array([0, 0.16, 0.0])
        add("strobe", ellipsoid(s, 0.03, 0.05, 0.03))
        anchors[f"Glow_Strobe_{sfx}"] = s + np.array([side * 0.04, 0, 0])
        add("lens", ellipsoid(x + np.array([0, 0.08, 0]), 0.06, 0.17, 0.05))
        # Landing lights under the wing root, looking ahead and a little down.
        lp, _ = W.surface_point(side * 3.4, W._le(side * 3.4)[0] + 0.9)
        lp = lp + np.array([0, 0, -0.01])
        add("landing", M.lathe([(0.0, 0.0), (0.0, 0.10), (0.012, 0.096)], lp, (0, -1.0, -0.12), n=18,
                               close_start=False, close_end=False))
        anchors[f"Glow_Landing_{sfx}"] = lp + np.array([0, -0.05, -0.02])
        # Wing-scan lights on the fuselage, aimed out at the leading edge.
        wp = side_point(11.6, 4.05, side, 0.004)
        add("wing", M.lathe([(0.0, 0.0), (0.0, 0.04), (0.008, 0.037)], wp, (side * 1.0, 0.5, -0.25), n=14,
                            close_start=False, close_end=False))
        anchors[f"Glow_Wing_{sfx}"] = wp + np.array([side * 0.03, 0.01, 0])
        # Logo lights on the stabiliser's upper surface, aimed at the fin.
        bl = side * 2.4
        lg = tail.HSTAB.point(bl, 0.35, 0.06)
        add("logo", ellipsoid(lg, 0.035, 0.06, 0.02))
        anchors[f"Glow_Logo_{sfx}"] = lg + np.array([-side * 0.03, 0, 0.03])
    # Tail: white position light and strobe on the cone, beacons top and bottom.
    end = D.TAIL_END_FS - 0.25
    tl = np.array([0.0, end, float(T.key(T.top, end)) - 0.06])
    add("nav_white", ellipsoid(tl, 0.035, 0.05, 0.03))
    anchors["Glow_Tail"] = tl + np.array([0, 0.05, 0.02])
    ts = tl + np.array([0.0, -0.20, 0.0])
    add("strobe", ellipsoid(ts, 0.03, 0.05, 0.03))
    anchors["Glow_Strobe_Tail"] = ts + np.array([0, 0.0, 0.04])
    for kind, fs, upper in (("Beacon_Top", 17.2, True), ("Beacon_Bottom", 22.0, False)):
        z = T.wl_at(fs, 0.0, upper)
        if not upper:
            from .fuselage import BELLY
            z = min(z, BELLY.wl_at(fs, 0.0, False) if fs < 22.8 else z)
        c = np.array([0.0, fs, z])
        d = 1.0 if upper else -1.0
        add("beacon", M.lathe([(0, 0.07), (0.05, 0.065), (0.09, 0.035), (0.10, 0.0)], c, (0, 0, d), n=18,
                              close_start=True, close_end=False))
        anchors[f"Glow_{kind}"] = c + np.array([0, 0, d * 0.10])
    for mat, items in lamps.items():
        name = {"nav_red": "Lamp_NavRed", "nav_green": "Lamp_NavGreen", "nav_white": "Lamp_NavWhite",
                "strobe": "Lamp_Strobe", "beacon": "Lamp_Beacon", "landing": "Lamp_Landing", "wing": "Lamp_Wing",
                "logo": "Lamp_Logo", "lens": "Lens_Tips"}[mat]
        parts[name] = M.make_object(name, *M.merge(items), col, mats[mat], sharp_angle=80)
    empties = {}
    for name, p in anchors.items():
        empties[name] = M.empty(name, col, M.P(*p), size=0.08, props={"kind": name[5:]})
    return empties
