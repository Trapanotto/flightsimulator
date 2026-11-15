"""
Hartzell five-blade composite propeller (HC-E5A-3A, 2.67 m), spinner and the blurred disc.

Every blade has its own pivot `Blade_<i>` (child of `Prop`) whose extras.axis is the blade's
pitch axis: the loader turns it from feathered through fine to reverse. The blades are
modelled at BLADE_BUILD_DEG at 0.75 R (extras.buildDeg).
"""

import math

import numpy as np

from lib import mesh as M
from . import dims as D


def _sections():
    """Radial stations: (r, chord, t/c, roundness 0 airfoil .. 1 circular shank, sweep m)."""
    R = D.PROP_RADIUS
    rs = np.concatenate([np.linspace(0.11, 0.26, 6), np.linspace(0.29, 0.92, 15), np.linspace(0.935, 0.997, 5)]) * R
    out = []
    for r in rs:
        x = r / R
        chord = float(np.interp(x, [0.11, 0.2, 0.3, 0.45, 0.65, 0.85, 0.95, 1.0],
                                [0.075, 0.10, 0.20, 0.235, 0.225, 0.18, 0.14, 0.09]))
        if x > 0.93:
            chord *= math.sqrt(max(1 - ((x - 0.93) / 0.07) ** 2, 0.05))
        tc = float(np.interp(x, [0.11, 0.2, 0.3, 0.5, 0.8, 1.0], [1.0, 0.5, 0.2, 0.11, 0.07, 0.05]))
        round_ = float(np.interp(x, [0.11, 0.19, 0.27], [1.0, 0.65, 0.0]))
        # Scimitar: the tips sweep back against the rotation.
        sweep = 0.10 * max(0.0, (x - 0.55) / 0.45) ** 2
        out.append((r, chord, tc, round_, sweep))
    return out


def _section(chord, tc, round_, n):
    s = 0.5 * (1 - np.cos(np.linspace(0, math.pi, n)))
    yt = 5 * tc * (0.2969 * np.sqrt(s) - 0.126 * s - 0.3516 * s ** 2 + 0.2843 * s ** 3 - 0.1036 * s ** 4)
    back = np.stack([s * chord, 1.7 * yt * chord], -1)
    face = np.stack([s[::-1] * chord, -0.3 * yt[::-1] * chord], -1)
    loop = np.vstack([back, face[1:-1]])
    if round_ > 0:
        ang = np.linspace(0, 2 * math.pi, len(loop), endpoint=False)
        rad = 0.5 * max(chord, 0.07)
        circle = np.stack([chord * 0.35 - rad * np.cos(ang), rad * np.sin(ang)], -1)
        loop = loop * (1 - round_) + circle * round_
    return loop


def blade(angle):
    """One blade (design frame) pointing at `angle` round the axis (0 = up)."""
    hub = np.array([0.0, D.PROP_FS, D.PROP_AXIS_WL])
    fwd = np.array([0.0, -1.0, 0.0])
    radial = np.array([-math.sin(angle), 0.0, math.cos(angle)])
    # Clockwise seen from the cockpit: the upper blade moves to the pilot's right (-BL).
    rot_dir = np.cross(fwd, radial)
    r75 = 0.75 * D.PROP_RADIUS
    pitch = 2 * math.pi * r75 * math.tan(math.radians(D.BLADE_BUILD_DEG))
    rows = []
    n = 16
    for r, chord, tc, round_, sweep in _sections():
        beta = math.atan(pitch / (2 * math.pi * r)) if round_ < 1 else math.radians(D.BLADE_BUILD_DEG + 18)
        le_dir = math.cos(beta) * rot_dir + math.sin(beta) * fwd
        thick_dir = -math.sin(beta) * rot_dir + math.cos(beta) * fwd
        loop = _section(chord, tc, round_, n)
        c = hub + radial * r - rot_dir * sweep
        rows.append([c + (0.35 * chord - x) * le_dir + y * thick_dir for x, y in loop])
    k = len(rows[0])
    v = np.array([p for row in rows for p in row])
    f = M.grid_faces(len(rows), k, wrap_cols=True)
    c0 = len(v)
    v = np.vstack([v, [np.mean(rows[0], 0)], [np.mean(rows[-1], 0)]])
    f += M.fan_cap(list(range(k)), c0, reverse=True)
    last = (len(rows) - 1) * k
    f += M.fan_cap(list(range(last, last + k)), c0 + 1)
    return v, f, radial


def spinner():
    L = D.SPINNER_BASE_FS - D.SPINNER_TIP_FS
    prof = []
    for t in np.linspace(0, 1, 24):
        r = D.SPINNER_R * (1 - t ** 2.1) ** 0.55
        prof.append((t * L, r))
    prof[-1] = (L, 0.0)
    prof = [(-0.03, D.SPINNER_R * 0.99)] + prof
    origin = np.array([0.0, D.SPINNER_BASE_FS, D.PROP_AXIS_WL])
    return M.lathe(prof, origin, (0, -1.0, 0), n=48, close_start=True, close_end=False)


def disc(n=72):
    R = D.PROP_RADIUS * 1.005
    r0 = D.SPINNER_R * 0.9
    verts, uvs_v = [], []
    for ring_r in (r0, R):
        for k in range(n):
            a = 2 * math.pi * k / n
            x, z = ring_r * math.cos(a), ring_r * math.sin(a)
            verts.append((x, D.PROP_FS - 0.03, D.PROP_AXIS_WL + z))
            uvs_v.append((0.5 + x / (2 * R), 0.5 + z / (2 * R)))
    faces = [(k, (k + 1) % n, n + (k + 1) % n, n + k) for k in range(n)]
    uvs = [uvs_v[i] for f in faces for i in f]
    return np.array(verts), faces, uvs


def build(col, mats, parts):
    center = M.P(0.0, D.PROP_FS, D.PROP_AXIS_WL)
    prop = M.empty("Prop", col, center, props={"axis": [0.0, 0.0, 1.0]})
    hub = np.array([0.0, D.PROP_FS, D.PROP_AXIS_WL])
    for i in range(D.BLADES):
        a = 2 * math.pi * i / D.BLADES
        v, f, radial = blade(a)
        root = hub + radial * 0.2
        # The pitch axis runs out along the blade; positive turns the leading edge forward
        # (coarser pitch, towards feather).
        piv = M.empty(f"Blade_{i}", col, M.P(*root),
                      props={"axis": M.model_axis(*radial), "buildDeg": D.BLADE_BUILD_DEG})
        M.parent_keep(piv, prop)
        o = M.make_object(f"PropBlades_{i}", v, f, col, mats["prop_blade"], sharp_angle=50, origin=M.P(*root))
        M.parent_keep(o, piv)
        parts[f"PropBlades_{i}"] = o
    v, f = spinner()
    s = M.make_object("Spinner", v, f, col, mats["spinner"], sharp_angle=70, origin=center)
    M.parent_keep(s, prop)
    v, f, uv = disc()
    d = M.make_object("PropDisc", v, f, col, mats["prop_disc"], uvs=uv, origin=center, recalc=False)
    M.parent_keep(d, prop)
    parts.update(Spinner=s, PropDisc=d)
    return prop
