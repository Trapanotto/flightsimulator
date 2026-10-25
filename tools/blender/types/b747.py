"""
Boeing 747-400 in Trapanotto Airlines colours (HB-JTB).

Real dimensions: length 70.66 m, span 64.44 m (winglets), height 19.4 m, fuselage 6.5 m wide;
upper deck hump with the cockpit, 37.5 deg swept wing with winglets, four turbofans,
16-wheel main gear on four legs (two wing gears, two body gears), twin nose wheel.
Blender frame: nose at -Y, up +Z, origin = main-deck fuselage centre, 5.42 m above ground.
"""

import numpy as np
from mathutils import Vector

from ac import geometry as g
from ac import texturing as tx
from ac.texturing import DARK, NAVY, RED, WHITE, WINDOW

ID = "b747"
SIZE = 70.0
GROUND_Z = -5.42
TEXTURE_SIZE = 2048
REG = "HB-JTB"
PREVIEW_VIEWS = {"eye": ((0.55, -31.9, 4.2), (0.55, -80.0, 2.0), 20)}

FUSE = g.Fuselage(
    nose_y=-35.30, tail_y=35.30, seg=64, stations=150,
    keys=[
        (0.000, 0.20, 0.40, -1.00, 2.0),
        (0.012, 1.55, 2.20, -2.40, 2.0),
        (0.035, 2.60, 4.30, -3.20, 2.0),
        (0.070, 3.15, 5.30, -3.55, 2.0),
        (0.120, 3.25, 5.55, -3.60, 2.0),
        (0.270, 3.25, 5.45, -3.60, 2.0),
        (0.330, 3.25, 4.20, -3.60, 2.0),
        (0.380, 3.25, 3.60, -3.60, 2.0),
        (0.800, 3.25, 3.60, -3.60, 2.0),
        (0.880, 2.80, 3.50, -2.40, 2.0),
        (0.950, 1.60, 3.20, -0.40, 2.0),
        (1.000, 0.50, 3.00, 1.40, 2.0),
    ],
)

TAN = 0.77  # 37.5 deg leading-edge sweep
WING = g.Surface(
    planform=[(0.0, 14.8, -9.0), (0.30, 9.0, -9.0 + 0.30 * 29.8 * TAN), (1.0, 4.0, -9.0 + 29.8 * TAN)],
    half_span=29.8, root_z=-2.60, dihedral_deg=7.0, twist_deg=-4.0, airfoil=(0.02, 0.4, 0.11),
)
HSTAB = g.Surface(
    planform=[(0.0, 9.5, 27.0), (1.0, 3.0, 33.5)],
    half_span=11.0, root_z=1.60, dihedral_deg=7.0, airfoil=(0.0, 0.4, 0.10),
)
FIN = g.Surface(
    planform=[(0.0, 13.0, 22.0), (1.0, 5.0, 32.0)],
    half_span=10.5, root_z=3.40, vertical=True, airfoil=(0.0, 0.4, 0.10),
)
ENGINES = [(0.33, -2.0), (0.62, -1.6)]   # span fraction, drop below the wing
ENGINE_LEN, ENGINE_R = 6.0, 1.35
DOORS_Y = [-28.0, -18.5, -6.0, 6.5, 18.0, 27.5]
PITCH = 0.508


def window(c):
    """Cockpit glazing on the upper deck (cabin windows are painted)."""
    x, y, z = c
    return -33.3 < y < -31.3 and 3.35 < z < 4.75 and (abs(x) > 0.35 or y < -32.7)


def engine_front(b):
    x = WING.span_point(b)[0]
    le = WING.le_y(b)
    return x, le - 4.2


def build(col, m):
    parts = {}
    skin, glass = FUSE.build(col, m["airframe"], m["glass"], window)
    parts["Fuselage"], parts["Glass"] = skin, glass
    parts["Cabin"] = FUSE.interior(
        col, m["interior"], 0.030, 0.075, 2.85,
        seats=[(0.60, -31.6, 0.0), (-0.60, -31.6, 0.0)],
        panel=(-32.55, 3.30, 2.0, 0.42), window=window, screen_mat=m["screen"],
        deck=(-33.0, -32.5, 3.53),
    )
    parts.update(g.build_surface(col, m["airframe"], WING, "Wing",
                                 controls=[("Flap", 0.06, 0.30), ("FlapOut", 0.32, 0.70),
                                           ("Aileron", 0.72, 0.94)],
                                 hinge_xc=0.78, breaks=(0.30,), tip=False, n_chord=30))
    for sfx in ("_L", "_R"):
        o = parts.pop("FlapOut" + sfx)
        o.name = "Flap_Out" + sfx
        parts[o.name] = o
    tip = Vector(WING.section(1.0, [(0.0, 0.0)])[0])
    wl = g.Surface(planform=[(0.0, 4.0, tip.y), (1.0, 1.2, tip.y + 3.2)], half_span=1.8,
                   root_x=tip.x, root_z=tip.z, vertical=True, cant_deg=25, airfoil=(0.0, 0.4, 0.08))
    parts.update(g.build_surface(col, m["airframe"], wl, "Winglet", n_chord=18))
    parts.update(g.build_surface(col, m["airframe"], HSTAB, "HStab",
                                 controls=[("Elevator", 0.05, 0.95)], hinge_xc=0.68, n_chord=22))
    g.merge_into(parts, ["HStab_L", "HStab_R"], "HStab", col)
    parts.update(g.build_surface(col, m["airframe"], FIN, "Fin", controls=[("Rudder", 0.04, 0.94)],
                                 hinge_xc=0.68, mirror=False, n_chord=22))

    for k, (b, drop) in enumerate(ENGINES, start=1):
        x, front_y = engine_front(b)
        wz = WING.section(b, [(0.3, -0.06)])[0][2]
        ez = wz + drop
        for side, sfx in ((1, f"_L{k}"), (-1, f"_R{k}")):
            for o in g.turbofan(col, m["airframe"], m["intake"], m["metal"], (side * x, front_y, ez),
                                ENGINE_LEN, ENGINE_R, name="Engine" + sfx, fan_name="Fan" + sfx):
                parts[o.name] = o
            pv, pf = g.box(side * x, front_y + 4.6, (wz + ez + ENGINE_R) / 2, 0.6, 5.0,
                           wz - ez - ENGINE_R + 0.3)
            parts["Pylon" + sfx] = g.make_object("Pylon" + sfx, pv, pf, col, m["airframe"], smooth_angle=30)
    build_gear(col, m, parts)
    build_details(col, m, parts)
    return parts


def bogie(x, y, z):
    return [(x - 0.55, y - 0.7, z), (x + 0.55, y - 0.7, z), (x - 0.55, y + 0.7, z), (x + 0.55, y + 0.7, z)]


def build_gear(col, m, parts):
    r, w = 0.62, 0.45
    for side, name, x, y, top_z in ((1, "Gear_L", 5.85, 2.1, -2.6), (-1, "Gear_R", 5.85, 2.1, -2.6),
                                    (1, "Gear_L2", 1.95, 5.1, -3.0), (-1, "Gear_R2", 1.95, 5.1, -3.0)):
        parts[name] = g.gear_leg(col, m["tire"], m["gear"], name, (side * x, y - 0.4, top_z),
                                 bogie(side * x, y, GROUND_Z + r), r, w, hinge_dir=(0, 1, 0),
                                 strut_r=0.22, bogie=True)
    parts["Gear_N"] = g.gear_leg(col, m["tire"], m["gear"], "Gear_N", (0, -27.5, -2.5),
                                 [(0.5, -27.8, GROUND_Z + r), (-0.5, -27.8, GROUND_Z + r)], r, w,
                                 hinge_dir=(1, 0, 0), strut_r=0.18)


def build_details(col, m, parts):
    tip = Vector(WING.section(1.0, [(0.3, 0.0)])[0])
    ant = g.merge_parts([
        g.box(0.0, -14.0, 5.6, 0.04, 0.8, 0.4),
        g.box(0.0, 8.0, 3.62, 0.04, 0.8, 0.4),
        g.box(0.0, -10.0, -3.62, 0.04, 0.7, 0.35),
    ])
    parts["Antenna"] = g.make_object("Antenna", *ant, col, m["metal_dark"], smooth_angle=30)
    g.light(col, "NavLight_L", m["nav_red"], (tip.x + 0.2, tip.y, tip.z), 0.15)
    g.light(col, "NavLight_R", m["nav_green"], (-tip.x - 0.2, tip.y, tip.z), 0.15)
    g.light(col, "Strobe_Tail", m["nav_white"], (0, 35.32, 3.0), 0.12)
    g.light(col, "Beacon", m["nav_red"], (0, -4.0, 3.62), 0.16)


def materials(principled, srgb):
    return dict(screen=principled("Screen", srgb(0.04, 0.07, 0.14), 0.2,
                                  emission=(0.10, 0.22, 0.45), strength=0.6))


ENGINE_NAMES = [f"Engine_{s}{k}" for k in (1, 2) for s in ("L", "R")]
PYLON_NAMES = [f"Pylon_{s}{k}" for k in (1, 2) for s in ("L", "R")]
ATLAS = ["Fuselage", "Wing_L", "Wing_R", "Flap_L", "Flap_R", "Flap_Out_L", "Flap_Out_R",
         "Aileron_L", "Aileron_R", "HStab", "Elevator_L", "Elevator_R", "Fin", "Rudder",
         "Winglet_L", "Winglet_R"] + ENGINE_NAMES + PYLON_NAMES
SUBDIVIDE = {"Fuselage", "Glass"} | set(ENGINE_NAMES)
LOD2_SKIN = ATLAS + ["Glass"] + [f"EngineIntake_{n[7:]}" for n in ENGINE_NAMES]
LOD2_KEEP = ["Gear_L", "Gear_R", "Gear_L2", "Gear_R2", "Gear_N"]
LOD2_TARGET = 4000

META = {
    "gearHeight": -GROUND_Z,
    "eye": [0.55, 4.2, 31.9],
    "wingCam": [16.0, 1.5, -6.0],
    "hull": {"nose": [0, 0.4, 35.3], "wingL": [31.5, 2.0, -16.0], "wingR": [-31.5, 2.0, -16.0],
             "tail": [0, 13.9, -32.0]},
    "length": 70.66, "span": 64.44,
}


def livery(m):
    c = tx.Canvas(m, WHITE, 0.28)
    x, y, z, ax, nz = m.x, m.y, m.z, m.ax, m.nz
    fuse = m.part("Fuselage")
    wing = m.part("Wing_*", "Flap_*", "Aileron_*")
    tail_h = m.part("HStab", "Elevator_*")
    fin = m.part("Fin", "Rudder")
    eng = m.part("Engine_*")
    wl = m.part("Winglet_*")
    side = np.abs(m.nx) > 0.25

    zl = -1.55
    c.put(fuse & (z < zl - 0.30), NAVY, 0.30)
    c.put(fuse & (np.abs(z - zl) < 0.22) & (y > -33.0) & (y < 33.0), RED, 0.26)
    c.put(fuse & (np.abs(z - zl - 0.38) < 0.05) & (y > -32.5) & (y < 32.5), NAVY, 0.26)
    # Main deck windows (gaps at the doors) and upper deck windows.
    wy = np.round((y + 30.0) / PITCH) * PITCH - 30.0
    row = fuse & side & (y > -31.0) & (y < 29.5)
    for dy in DOORS_Y:
        row &= np.abs(wy - dy) > 1.1
    c.put(row & tx.rounded_rect(y, z, wy, 0.75, 0.15, 0.22, 0.13), WINDOW, 0.05)
    uy = np.round((y + 29.0) / PITCH) * PITCH - 29.0
    upper = fuse & side & (y > -30.0) & (y < -13.5) & (np.abs(uy + 25.0) > 0.8)
    c.put(upper & tx.rounded_rect(y, z, uy, 4.35, 0.14, 0.20, 0.12), WINDOW, 0.05)
    lines = np.zeros(m.shape, bool)
    for dy in DOORS_Y:
        d = tx.rounded_rect(y, z, dy, 0.25, 0.55, 1.05, 0.15)
        di = tx.rounded_rect(y, z, dy, 0.25, 0.535, 1.035, 0.15)
        lines |= fuse & side & d & ~di
    rim = fuse & ~glass_mask(m, 0.0) & glass_mask(m, 0.08)
    c.put(rim, DARK, 0.6)
    c.put(fuse & (y < -34.6), (0.80, 0.81, 0.83), 0.35)
    c.put(eng, NAVY, 0.30)
    c.put(eng & (m.ny < -0.5), RED, 0.25)
    c.put(fin, NAVY, 0.30)
    c.put(fin & (np.abs(z - (5.4 + 0.30 * (y - 22.0))) < 0.35), RED, 0.30)
    c.put(wl, RED, 0.30)
    c.put(tail_h & (ax > 9.8), RED, 0.30)
    le = (wing | tail_h) & (m.ny < -0.6)
    c.put(le, (0.72, 0.74, 0.77), 0.25, 0.8)
    lines |= fuse & tx.near(y, (-34.6, -26.0, -12.0, 10.0, 26.0, 32.5), 0.012)
    lines |= wing & tx.near(ax, (6, 11, 16, 21, 26), 0.012)
    tx.paint_logo(c, fin, y, z, 28.6, 9.0, 6.0)
    c.shade(lines, 0.62)
    return c


def glass_mask(m, grow):
    y, z, ax = m.y, m.z, m.ax
    return (y > -33.3 - grow) & (y < -31.3 + grow) & (z > 3.35 - grow) & (z < 4.75 + grow) & (
        (ax > 0.35 - grow) | (y < -32.7 + grow))


def decals(col, parts):
    out = {"Fuselage": [], "Engine_L1": [], "Engine_R1": [], "Engine_L2": [], "Engine_R2": []}
    for side in (1, -1):
        ax_ = tx.side_axes(side)
        out["Fuselage"].append(tx.text_mesh(col, f"D_name_{side}", "TRAPANOTTO AIRLINES", 1.9,
                                            (side * 3.3, 2.0, 2.15), *ax_, NAVY, spacing=1.12))
        out["Fuselage"].append(tx.text_mesh(col, f"D_reg_{side}", REG, 0.7,
                                            (side * 3.3, 24.5, -0.4), *ax_, NAVY))
        out["Fuselage"].extend(tx.swiss_flag(col, f"D_flag_{side}", 0.7,
                                             (side * 3.3, -26.0, 1.4), *ax_))
        out["Fuselage"].append(tx.text_mesh(col, f"D_type_{side}", "747-400", 0.45,
                                            (side * 3.0, -30.5, -1.0), *ax_, NAVY))
    for k, (b, drop) in enumerate(ENGINES, start=1):
        x, front_y = engine_front(b)
        ez = WING.section(b, [(0.3, -0.06)])[0][2] + drop
        for side, s in ((1, "L"), (-1, "R")):
            ax_ = tx.side_axes(side)
            out[f"Engine_{s}{k}"].append(tx.text_mesh(col, f"D_eng_{s}{k}", "TRAPANOTTO", 0.55,
                                                      (side * (x + ENGINE_R), front_y + 3.0, ez),
                                                      *ax_, WHITE))
    return out
