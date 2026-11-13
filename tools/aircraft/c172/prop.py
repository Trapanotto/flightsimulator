"""Propeller (McCauley 76 in, two blades, fixed pitch), spinner and the blurred disc."""

import math

import numpy as np

from lib import mesh as M
from . import dims as D

PITCH = 60 * 0.0254   # geometric pitch of the 1A170E/JHA7660, m


def _blade_sections(n_chord=18):
    """Radial stations: (r, chord, t/c, roundness 0 airfoil .. 1 circular shank)."""
    R = D.PROP_RADIUS
    rs = np.concatenate([np.linspace(0.12, 0.30, 6), np.linspace(0.33, 0.92, 14),
                         np.linspace(0.935, 0.995, 5)]) * R
    out = []
    for r in rs:
        x = r / R
        chord = float(np.interp(x, [0.12, 0.2, 0.3, 0.45, 0.7, 0.9, 1.0],
                                [0.050, 0.075, 0.135, 0.155, 0.14, 0.115, 0.10]))
        if x > 0.9:
            chord *= math.sqrt(max(1 - ((x - 0.9) / 0.1) ** 2, 0.02))
        tc = float(np.interp(x, [0.12, 0.22, 0.3, 0.5, 0.8, 1.0], [1.0, 0.45, 0.2, 0.12, 0.08, 0.06]))
        round_ = float(np.interp(x, [0.12, 0.2, 0.28], [1.0, 0.6, 0.0]))
        out.append((r, chord, tc, round_))
    return out


def _section(chord, tc, round_, n):
    """Loop of (along chord from the LE, thickness) with a flat face and a cambered back."""
    s = 0.5 * (1 - np.cos(np.linspace(0, math.pi, n)))
    yt = 5 * tc * (0.2969 * np.sqrt(s) - 0.126 * s - 0.3516 * s ** 2 + 0.2843 * s ** 3 - 0.1036 * s ** 4)
    back = np.stack([s * chord, 1.8 * yt * chord], -1)            # LE -> TE, forward side
    face = np.stack([s[::-1] * chord, -0.2 * yt[::-1] * chord], -1)  # TE -> LE, rear side
    loop = np.vstack([back, face[1:-1]])
    if round_ > 0:
        # Shank: blend towards a circle of the same centre.
        ang = np.linspace(0, 2 * math.pi, len(loop), endpoint=False)
        rad = 0.5 * max(chord, 0.05)
        circle = np.stack([chord * 0.35 - rad * np.cos(ang), rad * np.sin(ang)], -1)
        loop = loop * (1 - round_) + circle * round_
    return loop


def blade(angle):
    """One blade (design frame) pointing at `angle` around the axis (0 = up)."""
    hub = np.array([0.0, D.PROP_FS, D.PROP_AXIS_WL])
    fwd = np.array([0.0, -1.0, 0.0])
    radial = np.array([-math.sin(angle), 0.0, math.cos(angle)])
    # Clockwise seen from the cockpit: the upper blade moves to the pilot's right (-BL).
    rot_dir = np.cross(fwd, radial)
    rows = []
    n = 18
    for r, chord, tc, round_ in _blade_sections():
        beta = math.atan(PITCH / (2 * math.pi * r))
        le_dir = math.cos(beta) * rot_dir + math.sin(beta) * fwd
        thick_dir = -math.sin(beta) * rot_dir + math.cos(beta) * fwd
        loop = _section(chord, tc, round_, n)
        c = hub + radial * r
        rows.append([c + (0.35 * chord - x) * le_dir + y * thick_dir for x, y in loop])
    k = len(rows[0])
    v = np.array([p for row in rows for p in row])
    f = M.grid_faces(len(rows), k, wrap_cols=True)
    c0 = len(v)
    v = np.vstack([v, [np.mean(rows[0], 0)], [np.mean(rows[-1], 0)]])
    f += M.fan_cap(list(range(k)), c0, reverse=True)
    last = (len(rows) - 1) * k
    f += M.fan_cap(list(range(last, last + k)), c0 + 1)
    return v, f


def spinner():
    L = D.SPINNER_BASE_FS - D.SPINNER_TIP_FS
    prof = []
    for t in np.linspace(0, 1, 22):
        # Ogive: full radius at the backplate, a slightly blunt point.
        r = D.SPINNER_R * (1 - t ** 1.45) ** 0.72
        prof.append((t * L, r))
    prof[-1] = (L, 0.0)
    prof = [(-0.012, D.SPINNER_R * 0.985)] + prof
    origin = np.array([0.0, D.SPINNER_BASE_FS, D.PROP_AXIS_WL])
    return M.lathe(prof, origin, (0, -1.0, 0), n=48, close_start=True, close_end=False)


def disc(n=64):
    """Annulus in the propeller plane with planar UVs (the loader draws the blur on it)."""
    R = D.PROP_RADIUS * 1.01
    r0 = D.SPINNER_R * 0.9
    verts, uvs_v = [], []
    for ring_r in (r0, R):
        for k in range(n):
            a = 2 * math.pi * k / n
            x, z = ring_r * math.cos(a), ring_r * math.sin(a)
            verts.append((x, D.PROP_FS - 0.02, D.PROP_AXIS_WL + z))
            uvs_v.append((0.5 + x / (2 * R), 0.5 + z / (2 * R)))
    faces = [(k, (k + 1) % n, n + (k + 1) % n, n + k) for k in range(n)]
    uvs = [uvs_v[i] for f in faces for i in f]
    return np.array(verts), faces, uvs


def build(col, mats, parts):
    center = M.P(0.0, D.PROP_FS, D.PROP_AXIS_WL)
    prop = M.empty("Prop", col, center, props={"axis": [0.0, 0.0, 1.0]})
    blades = []
    for a in (0.0, math.pi):
        v, f = blade(a)
        blades.append(M.make_object("Blade", v, f, col, mats["prop_front"], sharp_angle=50,
                                    origin=center))
    b = M.join(blades, "PropBlades")
    b.data.materials.append(mats["prop_back"])
    b.data.materials.append(mats["prop_tip"])
    R = D.PROP_RADIUS
    for p in b.data.polygons:
        c = p.center + b.location
        rr = math.hypot(c.x, c.z - (D.PROP_AXIS_WL - M.REF[2]))
        if rr > R - 0.075:
            p.material_index = 2
        elif p.normal.y > 0:          # faces the cockpit
            p.material_index = 1
    M.parent_keep(b, prop)
    v, f = spinner()
    s = M.make_object("Spinner", v, f, col, mats["metal"], sharp_angle=70, origin=center)
    M.parent_keep(s, prop)
    v, f, uv = disc()
    d = M.make_object("PropDisc", v, f, col, mats["prop_disc"], uvs=uv, origin=center, recalc=False)
    M.parent_keep(d, prop)
    parts.update(PropBlades=b, Spinner=s, PropDisc=d)
    return prop
