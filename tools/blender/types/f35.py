"""
Lockheed Martin F-35 Lightning II (A model) in Trapanotto Airlines display colours (T-35).

Real dimensions: length 15.67 m, span 10.70 m, height 4.38 m; chined nose, frameless bubble
canopy, caret intakes, trapezoidal wing (33 deg leading-edge sweep), twin canted fins,
all-moving stabilators, single round nozzle, tricycle gear.
Blender frame: nose at -Y, up +Z, origin = 1.76 m above the ground.
"""

import math

import numpy as np
from mathutils import Vector

from ac import geometry as g
from ac import texturing as tx
from ac.texturing import NAVY, RED, WHITE

ID = "f35"
SIZE = 15.7
GROUND_Z = -1.76
TEXTURE_SIZE = 2048
REG = "T-35"
PREVIEW_VIEWS = {"eye": ((0.0, -4.25, 0.86), (0.0, -14.0, 0.4), 18)}

FUSE = g.Fuselage(
    nose_y=-8.20, tail_y=7.30, seg=48, stations=100,
    keys=[
        (0.000, 0.03, 0.02, -0.03, 1.8),
        (0.050, 0.30, 0.22, -0.20, 1.7),
        (0.120, 0.48, 0.38, -0.32, 1.7),
        (0.200, 0.62, 0.50, -0.42, 1.8),
        (0.300, 0.92, 0.50, -0.45, 1.9),
        (0.400, 1.25, 0.55, -0.50, 1.9),
        (0.550, 1.45, 0.58, -0.52, 2.0),
        (0.700, 1.35, 0.55, -0.48, 2.0),
        (0.820, 1.05, 0.50, -0.45, 2.2),
        (0.920, 0.75, 0.46, -0.45, 2.6),
        (1.000, 0.56, 0.42, -0.42, 2.8),
    ],
)

WING = g.Surface(
    planform=[(0.0, 6.00, -1.60), (1.0, 1.20, 1.87)],
    half_span=5.35, root_z=-0.05, dihedral_deg=-2.0, airfoil=(0.0, 0.4, 0.05),
)
STAB = g.Surface(
    planform=[(0.0, 2.40, 4.60), (1.0, 0.90, 6.40)],
    half_span=2.35, root_x=1.0, root_z=-0.02, airfoil=(0.0, 0.4, 0.05),
)
FIN = g.Surface(
    planform=[(0.0, 3.00, 3.60), (1.0, 1.20, 5.60)],
    half_span=2.20, root_x=1.0, root_z=0.55, vertical=True, cant_deg=20, airfoil=(0.0, 0.4, 0.06),
)
CANOPY = (-5.45, -2.85)  # y range of the bubble


def window(c):
    """Opening under the bubble canopy (the canopy itself is a separate glass shell)."""
    x, y, z = c
    return CANOPY[0] + 0.1 < y < CANOPY[1] - 0.1 and abs(x) < 0.36 and z > 0.35


def canopy(col, glass, frame_mat):
    """Frameless bubble: lofted half-ellipses over the cockpit opening, plus a thin sill."""
    rings = []
    n = 24
    for t in g.cosine_stations(28):
        y = CANOPY[0] + (CANOPY[1] - CANOPY[0]) * t
        s = FUSE.s(y)
        _, zt, _, _ = FUSE.profile(s)
        h = 0.52 * math.sin(math.pi * t) ** 0.55 + 0.004
        w = 0.40 * math.sin(math.pi * min(1, t * 1.15)) ** 0.4 + 0.004
        base = zt - 0.06
        rings.append([(w * math.cos(math.pi * j / n), y, base + h * math.sin(math.pi * j / n) ** 0.7)
                      for j in range(n + 1)])
    v, f = g.loft(rings, closed=False)
    glass_obj = g.make_object("Canopy", v, f, col, glass)
    sill = []
    for side in (1, -1):
        pts = [Vector((side * r[0][0], r[0][1], r[0][2] + 0.01)) for r in rings[1:-1]]
        sill.append(g.tube(pts, 0.02, 6))
    frame = g.make_object("CanopyFrame", *g.merge_parts(sill), col, frame_mat, smooth_angle=40)
    return glass_obj, frame


def build(col, m):
    parts = {}
    skin, _ = FUSE.build(col, m["airframe"], None, window)
    parts["Fuselage"] = skin
    parts["Glass"], parts["CanopyFrame"] = canopy(col, m["glass"], m["frame"])
    parts["Cabin"] = FUSE.interior(
        col, m["interior"], 0.17, 0.35, -0.25,
        seats=[(0.0, -4.05, 0.0)], panel=(-4.85, 0.34, 0.56, 0.30), window=window,
        screen_mat=m["screen"],
    )
    parts.update(g.build_surface(col, m["airframe"], WING, "Wing",
                                 controls=[("Flap", 0.12, 0.50), ("Aileron", 0.52, 0.92)],
                                 hinge_xc=0.80, n_chord=24, tip=False))
    # All-moving stabilators: the whole surface turns (hinge near the leading edge).
    parts.update(g.build_surface(col, m["airframe"], STAB, "Stab",
                                 controls=[("Elevator", 0.0, 1.0)], hinge_xc=0.06, n_chord=20,
                                 tip=False))
    for k in ("Stab_L", "Stab_R"):
        if k in parts:
            bpy_obj = parts.pop(k)
            bpy_obj.parent = None
            bpy_obj.users_collection[0].objects.unlink(bpy_obj)
    parts.update(g.build_surface(col, m["airframe"], FIN, "Fin", controls=[("Rudder", 0.05, 0.85)],
                                 hinge_xc=0.72, n_chord=20, tip=False))
    # Nozzle: metal ring with serrated look (dark inside), and the exhaust disc.
    noz = g.lathe([(0.0, 0.58), (0.35, 0.56), (0.80, 0.48)], (0, 7.25, 0.0), (0, 1, 0), 36)
    inner = g.lathe([(0.80, 0.46), (0.40, 0.40), (0.30, 0.0)], (0, 7.25, 0.0), (0, 1, 0), 36)
    parts["Nozzle"] = g.multi_material("Nozzle", [(*noz, m["metal_dark"]), (*inner, m["intake"])], col)
    # Caret intakes: dark mouths on both sides behind the canopy.
    intakes = []
    for side in (1, -1):
        # Caret intake: dark mouth standing slightly off the side, raked back.
        v = [(side * 1.02, -3.30, 0.30), (side * 1.20, -3.05, 0.26), (side * 1.20, -3.05, -0.30),
             (side * 1.02, -3.30, -0.34), (side * 1.02, -2.40, 0.30), (side * 1.10, -2.40, 0.26),
             (side * 1.10, -2.40, -0.30), (side * 1.02, -2.40, -0.34)]
        f = [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
        intakes.append((v, f))
    parts["Intakes"] = g.make_object("Intakes", *g.merge_parts(intakes), col, m["intake"], smooth_angle=30)
    build_gear(col, m, parts)
    build_details(col, m, parts)
    return parts


def build_gear(col, m, parts):
    for side, name in ((1, "Gear_L"), (-1, "Gear_R")):
        parts[name] = g.gear_leg(col, m["tire"], m["gear_white"], name, (side * 1.25, 1.10, -0.56),
                                 [(side * 1.55, 1.35, -1.43)], 0.33, 0.20, hinge_dir=(0, 1, 0),
                                 strut_r=0.08)
    parts["Gear_N"] = g.gear_leg(col, m["tire"], m["gear_white"], "Gear_N", (0, -5.95, -0.32),
                                 [(0, -6.10, -1.49)], 0.27, 0.15, hinge_dir=(1, 0, 0), strut_r=0.065)


def build_details(col, m, parts):
    tip = Vector(WING.section(1.0, [(0.5, 0.0)])[0])
    g.light(col, "NavLight_L", m["nav_red"], (tip.x + 0.03, tip.y, tip.z), 0.035)
    g.light(col, "NavLight_R", m["nav_green"], (-tip.x - 0.03, tip.y, tip.z), 0.035)
    g.light(col, "Strobe_Tail", m["nav_white"], (0, 7.35, 0.48), 0.03)
    pitot = g.cylinder((0, -8.18, 0.0), (0, -8.45, 0.0), 0.012, 8)
    parts["Pitot"] = g.make_object("Pitot", *pitot, col, m["metal_dark"], smooth_angle=30)


def materials(principled, srgb):
    return dict(screen=principled("Screen", srgb(0.04, 0.07, 0.14), 0.2,
                                  emission=(0.10, 0.22, 0.45), strength=0.6))


ATLAS = ["Fuselage", "Wing_L", "Wing_R", "Flap_L", "Flap_R", "Aileron_L", "Aileron_R",
         "Elevator_L", "Elevator_R", "Fin_L", "Fin_R", "Rudder_L", "Rudder_R"]
SUBDIVIDE = {"Fuselage", "Glass"}
LOD2_SKIN = ATLAS + ["Glass", "Nozzle"]
LOD2_KEEP = ["Gear_L", "Gear_R", "Gear_N"]

META = {
    "gearHeight": -GROUND_Z,
    "eye": [0.0, 0.86, 4.25],
    "wingCam": [3.2, 0.25, -1.4],
    "hull": {"nose": [0, 0, 8.2], "wingL": [5.35, -0.24, -2.4], "wingR": [-5.35, -0.24, -2.4],
             "tail": [0, 2.62, -5.6]},
    "length": 15.67, "span": 10.7,
}

GREY = (0.36, 0.40, 0.46)


def livery(m):
    """Display scheme: navy body, light grey underside, red tips and a red spine stripe."""
    c = tx.Canvas(m, NAVY, 0.45)
    x, y, z, ax, nz = m.x, m.y, m.z, m.ax, m.nz
    fuse = m.part("Fuselage")
    wing = m.part("Wing_*", "Flap_*", "Aileron_*")
    stab = m.part("Elevator_*")
    fin = m.part("Fin_*", "Rudder_*")
    c.put((fuse | wing | stab) & (nz < -0.35), GREY, 0.5)
    c.put(fuse & (y < -7.2), (0.22, 0.24, 0.28), 0.5)  # radome
    c.put(fuse & (ax < 0.08) & (nz > 0.6) & (y > -2.6), RED, 0.35)  # spine stripe
    c.put(wing & (ax > 4.6), RED, 0.35)
    c.put(stab & (ax > 3.0), RED, 0.35)
    fin_top = fin & (z > 2.25)
    c.put(fin_top, RED, 0.35)
    # Edge treatment: lighter lines along leading edges, sawtooth panel joints.
    le = (wing | stab | fin) & (m.ny < -0.5)
    c.put(le, (0.28, 0.32, 0.40), 0.4)
    saw = fuse & (np.abs(((y * 3.0) % 1.0) - 0.5) < 0.012) & (np.abs(z) < 0.4) & (np.abs(m.nx) > 0.5)
    c.shade(saw, 1.35)
    lines = fuse & tx.near(y, (-6.4, -5.5, -2.4, 0.9, 3.6, 6.2), 0.006)
    c.shade(lines, 1.3)
    span = (z - 0.55) / math.cos(math.radians(20))
    tx.paint_logo(c, fin, y, span, 4.85, 1.25, 0.80)
    return c


def decals(col, parts):
    out = {"Fuselage": [], "Fin_L": [], "Fin_R": []}
    for side in (1, -1):
        ax_ = tx.side_axes(side)
        out["Fuselage"].append(tx.text_mesh(col, f"D_name_{side}", "TRAPANOTTO AIRLINES", 0.20,
                                            (side * 1.2, -0.6, 0.30), *ax_, WHITE, spacing=1.12))
        out["Fuselage"].append(tx.text_mesh(col, f"D_reg_{side}", REG, 0.30,
                                            (side * 0.6, -6.6, 0.0), *ax_, WHITE))
    return out
