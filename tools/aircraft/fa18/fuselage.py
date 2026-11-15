"""
F/A-18C fuselage: one lofted skin whose sections carry the chines and the leading-edge
extensions, so the LEX grows out of the nose chines and blends into the forward fuselage as
on the real aircraft. A section is, from the top centre round the left side: the upper body
(a superellipse: radome, canopy bubble, the flat spine over the engines), the LEX shelf out to
its edge, a small round over the edge, the shelf's underside back in, and the lower body down
to the keel. The intakes, the engine nacelles and nozzles are their own parts (engines.py).

The windscreen and the canopy are cut out of the skin with exact booleans, so glass and frame
share the same edge; the canopy glass is its own part that pivots at its aft end.
"""

import math

import bpy
import numpy as np

from lib import airframe as A
from lib import mesh as M
from . import dims as D

KEY = A.Tables.key

# Key tables over FS (pchip between the keys).
TOP = [(0.0, 2.02), (0.25, 2.14), (0.8, 2.28), (1.5, 2.38), (2.3, 2.45), (3.0, 2.52), (3.38, 2.60),
       (3.7, 2.80), (4.15, 3.03), (4.6, 3.13), (5.0, 3.15), (5.5, 3.10), (6.0, 2.97), (6.4, 2.85),
       (7.0, 2.76), (8.0, 2.73), (9.5, 2.71), (11.0, 2.66), (12.5, 2.58), (14.0, 2.46),
       (15.2, 2.36), (15.95, 2.30)]
BOT = [(0.0, 2.02), (0.25, 1.89), (0.8, 1.76), (1.5, 1.66), (2.3, 1.59), (3.2, 1.51), (4.5, 1.43),
       (6.0, 1.38), (7.0, 1.33), (8.5, 1.27), (11.5, 1.27), (13.0, 1.33), (14.5, 1.46),
       (15.95, 1.62)]
CHINE = [(0.0, 2.02), (2.3, 2.07), (3.0, 2.15), (4.0, 2.21), (6.0, 2.25), (7.6, 2.27), (10.0, 2.27),
         (12.5, 2.22), (14.0, 2.13), (15.95, 2.02)]
# Half width of the upper body where it meets the shelf.
BODY = [(0.0, 0.0), (0.25, 0.14), (0.8, 0.24), (1.5, 0.32), (2.3, 0.37), (3.0, 0.41), (3.6, 0.45),
        (4.5, 0.47), (5.5, 0.47), (6.2, 0.50), (7.0, 0.62), (8.0, 0.86), (9.0, 1.04), (10.5, 1.13),
        (12.0, 1.10), (13.5, 1.02), (14.8, 0.90), (15.95, 0.80)]
# Half width of the chine / LEX edge (inside the round).
LEX = [(0.0, 0.0), (0.25, 0.14), (0.8, 0.24), (1.5, 0.32), (2.3, 0.37), (2.8, 0.45), (3.4, 0.55),
       (4.2, 0.69), (5.0, 0.85), (5.8, 1.03), (6.5, 1.24), (7.0, 1.46), (7.35, 1.66), (7.6, 1.86),
       (7.75, 1.70), (7.95, 1.30), (8.4, 1.20), (10.5, 1.24), (12.0, 1.20), (13.5, 1.10),
       (14.8, 0.94), (15.95, 0.82)]
# Half width of the lower body below the shelf.
LOW = [(0.0, 0.0), (0.25, 0.14), (0.8, 0.24), (1.5, 0.32), (2.3, 0.37), (3.0, 0.42), (4.0, 0.48),
       (5.0, 0.53), (6.0, 0.57), (6.5, 0.60), (7.3, 0.73), (8.0, 1.00), (8.7, 1.30), (9.2, 1.36),
       (11.5, 1.36), (12.5, 1.30), (14.0, 1.12), (14.8, 0.95), (15.95, 0.80)]
# Radius of the round over the edge, and the shelf's thickness at the body.
EDGE = [(0.0, 0.0), (0.25, 0.10), (2.3, 0.10), (2.9, 0.035), (3.5, 0.016), (7.5, 0.016),
        (8.0, 0.05), (12.0, 0.06), (14.0, 0.09), (15.95, 0.10)]
TU = [(0.0, 0.0), (0.25, 0.10), (2.3, 0.10), (3.0, 0.06), (4.0, 0.05), (7.5, 0.05), (8.3, 0.08),
      (15.95, 0.10)]
TL = [(0.0, 0.0), (0.25, 0.10), (2.3, 0.10), (3.0, 0.06), (4.0, 0.05), (7.5, 0.05), (8.3, 0.08),
      (15.95, 0.10)]
N_TOP = [(0.0, 2.0), (2.3, 2.0), (3.3, 2.1), (6.2, 2.2), (7.5, 2.8), (9.0, 3.6), (15.95, 3.4)]
N_BOT = [(0.0, 2.0), (2.3, 2.0), (3.5, 2.6), (6.0, 3.0), (9.0, 3.4), (15.95, 3.0)]

N_HUMP, N_SHELF, N_EDGE, N_LOW = 16, 7, 7, 16


def section(fs):
    """(n, 2) ring of (BL, WL), top centre first, round the left side, then the right."""
    k = lambda t: float(KEY(t, fs))  # noqa: E731
    top, bot, ch = k(TOP), k(BOT), k(CHINE)
    body, lex, low = k(BODY), k(LEX), k(LOW)
    r, tu, tl = k(EDGE), k(TU), k(TL)
    nt, nb = k(N_TOP), k(N_BOT)
    lex = max(lex, body, low - r * 0.5)
    tu = max(tu, r)
    tl = max(tl, r)
    pts = []
    # Upper body: superellipse from the top centre to the shelf.
    base = ch + tu
    for i in range(N_HUMP):
        th = (math.pi / 2) * i / N_HUMP
        x = body * math.sin(th) ** (2 / nt)
        y = base + (top - base) * math.cos(th) ** (2 / nt)
        pts.append((x, y))
    # Shelf top: from the body out to the edge, thinning to the round.
    for i in range(N_SHELF):
        s = i / (N_SHELF - 1)
        x = body + (lex - body) * s
        y = ch + r + (tu - r) * (1 - s) ** 1.6
        pts.append((x, y))
    # The round over the edge.
    for i in range(1, N_EDGE + 1):
        a = math.pi / 2 - math.pi * i / (N_EDGE + 1)
        pts.append((lex + r * math.cos(a), ch + r * math.sin(a)))
    # Shelf underside back in, then the lower body down to the keel.
    for i in range(N_SHELF):
        s = i / (N_SHELF - 1)
        x = lex + (low - lex) * s
        y = ch - r - (tl - r) * s ** 1.6
        pts.append((x, y))
    base = ch - tl
    for i in range(1, N_LOW + 1):
        th = (math.pi / 2) * i / N_LOW
        x = low * math.cos(th) ** (2 / nb)
        y = base - (base - bot) * math.sin(th) ** (2 / nb)
        pts.append((x, y))
    left = np.array(pts)
    # Right side: mirrored, from the keel back up to (but not including) the top centre.
    right = left[1:-1][::-1].copy()
    right[:, 0] *= -1
    return np.vstack([left, right])


def half_width_at(fs, wl):
    """Half width of the skin at a station and height (for parts that must fit inside)."""
    ring = section(fs)
    left = ring[: len(ring) // 2 + 1]
    best = 0.0
    for a, b in zip(left[:-1], left[1:]):
        if (a[1] - wl) * (b[1] - wl) <= 0 and a[1] != b[1]:
            t = (wl - a[1]) / (b[1] - a[1])
            best = max(best, a[0] + t * (b[0] - a[0]))
    return best


def wl_at(fs, bl, upper=True):
    ring = section(fs)
    n = len(ring) // 2 + 1
    left = ring[:n]
    best = None
    for a, b in zip(left[:-1], left[1:]):
        if (a[0] - abs(bl)) * (b[0] - abs(bl)) <= 0 and a[0] != b[0]:
            t = (abs(bl) - a[0]) / (b[0] - a[0])
            w = a[1] + t * (b[1] - a[1])
            if best is None or (w > best if upper else w < best):
                best = w
    return best if best is not None else float(KEY(TOP if upper else BOT, fs))


def stations():
    return np.unique(np.round(np.concatenate([
        [0.0, 0.01, 0.04, 0.09, 0.16], np.linspace(0.25, 2.3, 14), np.linspace(2.4, 6.4, 34),
        np.linspace(6.5, 8.6, 18), np.linspace(8.8, 15.95, 30)]), 4))


def skin_mesh():
    st = stations()
    rows = []
    for fs in st:
        ring = section(max(fs, 1e-3))
        if fs < 1e-6:
            ring = ring * 0 + np.array([0.0, KEY(TOP, 0.0)])
        rows.append(np.column_stack([ring[:, 0], np.full(len(ring), fs), ring[:, 1]]))
    n = len(rows[0])
    verts = np.vstack(rows)
    faces = M.grid_faces(len(st), n, wrap_cols=True)
    # Drop the degenerate quads of the tip row and close it with a pole.
    faces = faces[n:]
    pole = len(verts)
    verts = np.vstack([verts, [[0.0, -0.002, KEY(TOP, 0.0)]]])
    faces += M.fan_cap(list(range(n, 2 * n)), pole, reverse=True)
    last = (len(st) - 1) * n
    c1 = len(verts)
    verts = np.vstack([verts, [[0.0, st[-1], rows[-1][:, 2].mean()]]])
    faces += M.fan_cap(list(range(last, last + n)), c1)
    return verts, faces


# Glazing in side view (FS, WL): the windscreen and the canopy, split by the canopy bow.
def sill(fs):
    return 2.50 + 0.035 * (fs - 3.4) + 0.012 * max(fs - 5.6, 0) * 10


WINDSCREEN = [(D.WINDSCREEN_FS, 2.49), (4.11, 2.515), (4.11, 3.3), (3.30, 3.3)]
CANOPY = [(4.19, 2.515), (5.2, 2.55), (5.9, 2.62), (6.26, 2.72), (6.26, 3.3), (4.19, 3.3)]


def glass_cutter(col, mat, poly, name):
    p = M.rounded_polygon(poly, [0.0, 0.0, 0.0, 0.0] if len(poly) == 4 else [0.0, 0.05, 0.08, 0.0, 0.0, 0.0], 4)
    v, f = M.prism(p, 0, -1.2, 1.2, (1, 2))
    return M.make_object(name, v, f, col, mat, smooth=False)


def build(col, mats):
    cut_mat = bpy.data.materials.get("CUT") or bpy.data.materials.new("CUT")
    v, f = skin_mesh()
    skin = M.make_object("Fuselage", v, f, col, mats["paint"], smooth=True, sharp_angle=50)
    c1 = glass_cutter(col, cut_mat, WINDSCREEN, "CutWindscreen")
    c2 = glass_cutter(col, cut_mat, CANOPY, "CutCanopy")
    canopy_cut = M.duplicate(c2, "CutCanopyKeep")
    both = M.join([c1, c2], "GlassCutter")
    glass_all = A.cut_windows(skin, both, mats["glass"])
    M.delete_object(both)
    # Split the glass into the fixed windscreen and the canopy that opens.
    canopy_glass = M.duplicate(glass_all, "CanopyGlass")
    M.boolean(canopy_glass, canopy_cut, "INTERSECT")
    M.boolean(glass_all, canopy_cut, "DIFFERENCE")
    M.delete_object(canopy_cut)
    for g in (glass_all, canopy_glass):
        g.data.materials.clear()
        g.data.materials.append(mats["glass"])
    glass_all.name = "Glass"
    glass_all.data.name = "Glass"
    lining = A.cabin_lining(skin, col, mats, 3.30, 6.40)
    return skin, glass_all, canopy_glass, lining


def canopy_frame(col, mats):
    """Frame of the canopy (rim along the sill, the bow) and the windscreen arch."""
    def outline(poly_fs, out=0.012):
        pts = []
        for fs, wl in poly_fs:
            hw = half_width_at(fs, wl)
            pts.append((hw + out, fs, wl))
        return pts

    parts = []
    # Canopy rim: along both sills and over the bow, a flat strip on the skin.
    rim = [(fs, 2.515 + (fs - 4.19) * 0.04 + max(fs - 5.6, 0) * 0.22) for fs in np.linspace(4.19, 6.24, 14)]
    for side in (1, -1):
        p = [(side * x, y, z) for x, y, z in outline(rim, 0.006)]
        parts.append(M.tube_path(p, 0.022, 8))
    bow = []
    for t in np.linspace(-1, 1, 21):
        a = t * math.pi / 2
        # Points over the canopy section at the bow, a little outside the skin.
        fs = 4.17
        ring = section(fs)
        # Walk the upper ring by angle from the centre line.
        top = KEY(TOP, fs)
        hw = half_width_at(fs, 2.55)
        bow.append((hw * math.sin(a) * 1.02, fs, 2.53 + (top - 2.53 + 0.012) * math.cos(a) ** 0.62))
    parts.append(M.tube_path(bow, 0.028, 8))
    frame = M.make_object("CanopyFrame", *M.merge(parts), col, mats["paint"], sharp_angle=50)
    arch = []
    for t in np.linspace(-1, 1, 21):
        a = t * math.pi / 2
        fs = 4.13
        top = KEY(TOP, fs)
        hw = half_width_at(fs, 2.55)
        arch.append((hw * math.sin(a) * 1.02, fs, 2.53 + (top - 2.53 + 0.010) * math.cos(a) ** 0.62))
    w = M.make_object("WindscreenArch", *M.tube_path(arch, 0.024, 8), col, mats["paint"], sharp_angle=50)
    return frame, w
