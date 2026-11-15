"""
F/A-18C intakes and engines: the D-shaped intakes under the LEX with their splitter plates and
dark ducts, the aft nacelles round the two F404s, the convergent-divergent nozzles (outer
petals, the inner flaps, the turbine face) and the afterburner flames.

The nozzles open and close in the game by a vertex displacement in their material (the
loader's job): the petals are modelled at the idle opening, NOZZLE_EXIT_BUILD, and each
vertex knows its engine from its side of the centre line. Flames are cones per engine
(Flame_L/R, origin at the nozzle exit), scaled and lit by the loader.
"""

import math

import numpy as np

from lib import mesh as M
from . import dims as D
from . import fuselage as F

# Intake opening (D shape): flat inboard wall, rounded outboard; in (BL, WL).
IN_BL = 0.73
OUT_BL = 1.36
LO_WL = 1.30
HI_WL = 2.20
LIP = 0.035


def d_ring(n, grow=0.0):
    """(n, 2) points round the D section, grown outward by `grow` (m)."""
    cx = IN_BL
    cy = 0.5 * (LO_WL + HI_WL)
    ry = 0.5 * (HI_WL - LO_WL) + grow
    rx = OUT_BL - IN_BL + grow
    pts = []
    n_flat = n // 4
    for i in range(n_flat):
        t = i / n_flat
        pts.append((cx - grow, cy - ry + 2 * ry * t))
    n_arc = n - n_flat
    for i in range(n_arc):
        a = math.pi / 2 - math.pi * i / n_arc
        # Superellipse: fuller than an ellipse, like the real intake.
        c, s = math.cos(a), math.sin(a)
        x = rx * abs(c) ** 0.8
        y = ry * math.copysign(abs(s) ** 0.8, s)
        pts.append((cx + x, cy + y))
    return np.array(pts)


def intake(side):
    """The duct's inside up to the lip, and the lip with the outer cowl back to where it fairs in."""
    n = 40
    path = [  # (offset outward, FS)
        (-0.05, 7.6), (-0.03, 6.9), (-0.012, D.INTAKE_LIP_FS + 0.06), (0.0, D.INTAKE_LIP_FS + 0.008),
        (LIP * 0.5, D.INTAKE_LIP_FS), (LIP, D.INTAKE_LIP_FS + 0.01), (LIP + 0.012, D.INTAKE_LIP_FS + 0.08),
        (LIP + 0.02, 6.9), (LIP + 0.02, 7.8), (LIP + 0.01, 8.5), (LIP - 0.01, 9.0)]

    def loft(sub):
        rows = [[(side * x, fs, y) for x, y in d_ring(n, g)] for g, fs in sub]
        return np.array([p for r in rows for p in r]), M.grid_faces(len(rows), n, wrap_cols=True)

    return loft(path[:4]), loft(path[3:])


def duct_plug(side):
    """Dark cap deep in the duct (the compressor face is far back)."""
    ring = d_ring(24, -0.06)
    c = len(ring)
    v = [(side * x, 7.58, y) for x, y in ring] + [(side * (IN_BL + 0.25), 7.58, 0.5 * (LO_WL + HI_WL))]
    f = M.fan_cap(list(range(c)), c)
    return np.array(v), f


def splitter(side):
    """Boundary-layer splitter plate standing off the fuselage, raked at its front."""
    bl = IN_BL - 0.045
    poly = [(6.12, LO_WL + 0.06), (6.40, HI_WL + 0.02), (7.3, HI_WL + 0.02), (7.3, LO_WL - 0.01)]
    p = M.rounded_polygon(poly, 0.02, 2)
    return M.prism(p, 0, side * bl - 0.008, side * bl + 0.008, (1, 2))


def nacelle(side):
    """Aft engine nacelle round one F404, from inside the body out to the nozzle hinge ring."""
    c = np.array([side * D.ENGINE_BL, 0.0, D.ENGINE_WL])
    prof = [(13.0, 0.36), (13.8, 0.44), (14.6, 0.465), (15.4, 0.465), (15.9, 0.452),
            (D.NOZZLE_HINGE_FS, D.NOZZLE_HINGE_R + 0.01)]
    n = 32
    rows = []
    for fs, r in prof:
        rows.append([c + np.array([r * math.cos(2 * math.pi * k / n), fs, r * math.sin(2 * math.pi * k / n)])
                     for k in range(n)])
    v = np.array([p for r in rows for p in r])
    f = M.grid_faces(len(rows), n, wrap_cols=True)
    return v, f


def nozzle(side):
    """Outer petals (a serrated exit), the inner flaps and a ring of the throat, at the idle opening."""
    c = np.array([side * D.ENGINE_BL, 0.0, D.ENGINE_WL])
    n_pet = 12
    per = 4
    n = n_pet * per
    rows_o, rows_i = [], []
    steps = 7
    for j in range(steps + 1):
        t = j / steps
        fs = D.NOZZLE_HINGE_FS + t * D.NOZZLE_LEN
        r = D.NOZZLE_HINGE_R + (D.NOZZLE_EXIT_BUILD - D.NOZZLE_HINGE_R) * t
        ro, ri = [], []
        for k in range(n):
            a = 2 * math.pi * k / n
            # Petal edges are slightly sunk (the seams between them) and stick out at the exit.
            seam = 1.0 - 0.012 * (k % per == 0)
            tip = (0.05 if (k % per) in (1, 2) else 0.0) * t ** 4
            ro.append(c + np.array([r * seam * math.cos(a), fs + tip, r * seam * math.sin(a)]))
            ri.append(c + np.array([(r - 0.025) * math.cos(a), fs + tip - 0.01, (r - 0.025) * math.sin(a)]))
        rows_o.append(ro)
        rows_i.append(ri)
    vo = np.array([p for r in rows_o for p in r])
    vi = np.array([p for r in rows_i for p in r])
    m = len(vo)
    f = M.grid_faces(steps + 1, n, wrap_cols=True)
    fi = [tuple(i + m for i in reversed(x)) for x in M.grid_faces(steps + 1, n, wrap_cols=True)]
    last = steps * n
    rim = [(last + k, last + (k + 1) % n, m + last + (k + 1) % n, m + last + k) for k in range(n)]
    return np.vstack([vo, vi]), f + fi + rim


def nozzle_inner(side):
    """The convergent section inside, the flame holder ring and the turbine face (dark)."""
    c = (side * D.ENGINE_BL, 0.0, D.ENGINE_WL)
    prof = [(-0.9, 0.0), (-0.9, 0.30), (-0.55, 0.36), (-0.15, 0.40), (0.0, 0.415)]
    v, f = M.lathe(prof, (c[0], D.NOZZLE_HINGE_FS, c[2]), (0, 1.0, 0), n=28, close_start=False, close_end=False)
    return v, f


def flame(side):
    """Afterburner plume: a cone from the exit, its origin at the exit. uv.x runs along it."""
    n = 18
    L = 3.2
    prof = [(0.0, 0.30), (0.25, 0.31), (0.8, 0.26), (1.6, 0.18), (2.4, 0.10), (L, 0.02)]
    c = np.array([side * D.ENGINE_BL, D.NOZZLE_HINGE_FS + D.NOZZLE_LEN, D.ENGINE_WL])
    verts, uvs_v, faces = [], [], []
    for j, (s, r) in enumerate(prof):
        for k in range(n + 1):
            a = 2 * math.pi * k / n
            verts.append(c + np.array([r * math.cos(a), s, r * math.sin(a)]))
            uvs_v.append((s / L, k / n))
    for j in range(len(prof) - 1):
        for k in range(n):
            a = j * (n + 1) + k
            faces.append((a, a + 1, a + n + 2, a + n + 1))
    uvs = [uvs_v[i] for fc in faces for i in fc]
    return np.array(verts), faces, uvs, c


def build(col, mats, parts):
    paint, intake_mat = mats["paint"], mats["intake"]
    ins, plugs, splits, nacs, inners = [], [], [], [], []
    noz = []
    ducts = []
    for side, sfx in ((1, "L"), (-1, "R")):
        inner, outer = intake(side)
        ducts.append(inner)
        ins.append(outer)
        plugs.append(duct_plug(side))
        splits.append(splitter(side))
        nacs.append(nacelle(side))
        noz.append(nozzle(side))
        inners.append(nozzle_inner(side))
        v, f, uvs, c = flame(side)
        o = M.make_object(f"Flame_{sfx}_mesh", v, f, col, mats["flame"], smooth=True, origin=M.P(*c), uvs=uvs,
                          recalc=False)
        piv = M.empty(f"Flame_{sfx}", col, M.P(*c), props={"axis": [0.0, 0.0, 1.0]})
        M.parent_keep(o, piv)
        # The afterburner's glow sprite, a little behind the exit.
        M.empty(f"Glow_AB_{sfx}", col, M.P(*(c + np.array([0, 0.7, 0]))), size=0.05, props={"kind": f"AB_{sfx}"})
    parts["Intakes"] = M.make_object("Intakes", *M.merge(ins), col, paint, sharp_angle=55)
    parts["Ducts"] = M.make_object("Ducts", *M.merge(ducts + plugs), col, intake_mat, sharp_angle=60)
    parts["Splitters"] = M.make_object("Splitters", *M.merge(splits), col, paint, sharp_angle=40)
    parts["Nacelles"] = M.make_object("Nacelles", *M.merge(nacs), col, paint, sharp_angle=50)
    parts["Nozzles"] = M.make_object("Nozzles", *M.merge(noz), col, mats["nozzle"], sharp_angle=60)
    parts["NozzleInner"] = M.make_object("NozzleInner", *M.merge(inners), col, mats["exhaust_in"], sharp_angle=60)
    return parts
