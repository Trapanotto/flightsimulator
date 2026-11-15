"""Small shapes every type uses: tyres, wheel hubs, ellipsoids (lamps, cuffs), blade antennas."""

import math

import numpy as np

from . import mesh as M


def tyre(axle_center, axis, r_out, width, rim_r, n=40):
    """Tyre as a lathe of a rounded section around the axle."""
    hw = width / 2
    prof = []
    for t in np.linspace(0, 1, 19):
        a = math.pi * t        # around the section, from one bead to the other
        # Superellipse section, flattened tread.
        ca, sa = math.cos(a), math.sin(a)
        x = -hw * np.sign(ca) * abs(ca) ** 0.55
        rr = rim_r + (r_out - rim_r) * (abs(sa) ** 0.45)
        prof.append((x, rr))
    prof = [(-hw * 0.82, rim_r * 0.98)] + prof + [(hw * 0.82, rim_r * 0.98)]
    prof = sorted(prof, key=lambda p: p[0])
    return M.lathe(prof, axle_center, axis, n=n, close_start=False, close_end=False)


def hub(axle_center, axis, rim_r, width, bolts=6):
    a = np.asarray(axis, float) / np.linalg.norm(axis)
    hw = width / 2
    prof = [(-hw * 0.82, 0.0), (-hw * 0.82, rim_r * 0.55), (-hw * 0.9, rim_r * 0.98),
            (hw * 0.9, rim_r * 0.98), (hw * 0.82, rim_r * 0.55), (hw * 0.82 + 0.012, rim_r * 0.35),
            (hw * 0.82 + 0.02, 0.0)]
    parts = [M.lathe(prof, axle_center, axis, n=28, close_start=False, close_end=False)]
    _, u, w = M.frame_from_axis(a)
    for k in range(bolts):
        ang = 2 * math.pi * k / bolts
        p = np.asarray(axle_center) + a * (hw * 0.82 + 0.004) + rim_r * 0.42 * (math.cos(ang) * u + math.sin(ang) * w)
        parts.append(M.cylinder(p, p + a * 0.012, 0.0065, 8))
    return M.merge(parts)


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
