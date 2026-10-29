"""
Airbus A320 (sharklets) in Trapanotto Airlines colours (HB-JTA).

Real dimensions: length 37.57 m, span 35.80 m, height 11.76 m, fuselage 3.95 m wide;
swept low wing with a trailing-edge kink, two underwing turbofans, conventional tail,
twin-wheel main and nose gear.
Blender frame: nose at -Y, up +Z, origin = fuselage centre, 3.60 m above the ground.
"""

import numpy as np
from mathutils import Vector

from ac import cockpit as ck
from ac import geometry as g
from ac import texturing as tx
from ac.texturing import DARK, NAVY, RED, WHITE, WINDOW

ID = "a320"
SIZE = 37.6
GROUND_Z = -3.60
TEXTURE_SIZE = 2048
REG = "HB-JTA"
PREVIEW_VIEWS = {"eye": ((0.52, -16.6, 1.10), (0.52, -40.0, 0.2), 20),
                 "panel": ((0.50, -16.35, 1.20), (0.1, -17.2, 0.55), 14)}

FUSE = g.Fuselage(
    nose_y=-18.80, tail_y=18.80, seg=56, stations=120,
    keys=[
        (0.000, 0.12, 0.05, -0.55, 2.0),
        (0.015, 0.78, 0.72, -1.25, 2.0),
        (0.040, 1.38, 1.38, -1.75, 2.0),
        (0.080, 1.82, 1.86, -2.00, 2.0),
        (0.120, 1.97, 2.05, -2.07, 2.0),
        (0.800, 1.97, 2.07, -2.07, 2.0),
        (0.880, 1.70, 2.00, -1.40, 2.0),
        (0.950, 1.00, 1.72, -0.20, 2.0),
        (1.000, 0.30, 1.48, 0.75, 2.0),
    ],
)

TAN = 0.51  # leading-edge sweep ~27 deg
WING = g.Surface(
    planform=[(0.0, 7.20, -3.60), (0.32, 4.10, -3.60 + 0.32 * 17.1 * TAN), (1.0, 1.55, -3.60 + 17.1 * TAN)],
    half_span=17.10, root_z=-1.40, dihedral_deg=5.1, twist_deg=-4.0, airfoil=(0.02, 0.4, 0.12),
)
HSTAB = g.Surface(
    planform=[(0.0, 3.90, 12.60), (1.0, 1.40, 16.30)],
    half_span=6.20, root_z=0.40, dihedral_deg=6.0, airfoil=(0.0, 0.4, 0.10),
)
FIN = g.Surface(
    planform=[(0.0, 6.00, 11.20), (1.0, 2.20, 16.00)],
    half_span=6.10, root_z=2.00, vertical=True, airfoil=(0.0, 0.4, 0.10),
)
ENGINE_B = 0.336
ENGINE_FRONT_Y, ENGINE_LEN, ENGINE_R, ENGINE_Z = -4.70, 4.40, 1.05, -2.00
DOORS_Y = [-14.55, -10.9, 0.55, 12.35]   # L1, overwing exits (painted narrower), L4
WINDOW_PITCH = 0.533


def window(c):
    """Cockpit glazing only (cabin windows are painted)."""
    x, y, z = c
    if -17.80 < y < -16.20 and 0.88 < z < 1.48 + 0.25 * (y + 17.8) / 1.6:
        return abs(x) > 0.25 or y < -17.2
    return False


# Airbus A320: PFD and ND per pilot, ECAM (engine/warning and system display) in the middle,
# FCU on the glareshield, side sticks on the outboard consoles, thrust levers and MCDU on the
# pedestal, overhead panel.
COCKPIT = {
    "floor": 0.10,
    "panel": dict(y=-17.20, z=0.62, w=1.70, h=0.46, tilt=10),
    "displays": [("PFD", 0.66, 0.06, 0.19, 0.19, "plain"), ("ND", 0.44, 0.06, 0.19, 0.19, "plain"),
                 ("EWD", 0.0, 0.11, 0.19, 0.19, "plain"), ("SD", 0.0, -0.11, 0.19, 0.19, "plain"),
                 ("ND", -0.44, 0.06, 0.19, 0.19, "plain"), ("PFD", -0.66, 0.06, 0.19, 0.19, "plain")],
    "switches": [(0.75, -0.15, 6, 0.045, "knob"), (-0.53, -0.15, 6, 0.045, "knob"),
                 (0.30, -0.17, 3, 0.05, "annunciator"), (-0.20, -0.17, 3, 0.05, "annunciator")],
    "glare": dict(depth=0.30, h=0.085, fcu=(0.90, 0.05)),
    "pedestal": dict(y1=-16.0, w=0.50, z_front=0.58, z_rear=0.52, lever_len=0.13,
                     levers=[(0.06, "airliner", None), (-0.06, "airliner", None)],
                     display=(0.14, 0.11)),
    "overhead": dict(y0=-16.95, y1=-15.9, w=0.90, drop=0.06),
    "consoles": dict(x=0.95, y0=-17.05, y1=-16.0, w=0.26, z=0.58),
    "controls": ("stick", [(0.92, -16.62, 0.585, "L"), (-0.92, -16.62, 0.585, "R")]),
    "seats": [(0.55, -16.30, "airliner"), (-0.55, -16.30, "airliner")],
    "pedals": [(0.55, -16.95), (-0.55, -16.95)],
}


def build(col, m):
    parts = {}
    skin, glass = FUSE.build(col, m["airframe"], m["glass"], window)
    parts["Fuselage"], parts["Glass"] = skin, glass
    parts["Cabin"] = FUSE.interior(
        col, m["interior"], 0.025, 0.085, 0.10,
        window=window, deck=(-17.55, -17.15, 0.84),
    )
    parts.update(ck.build(col, m, FUSE, COCKPIT))
    parts.update(g.build_surface(col, m["airframe"], WING, "Wing",
                                 controls=[("Flap", 0.07, 0.31), ("FlapOut", 0.33, 0.70),
                                           ("Aileron", 0.72, 0.95)],
                                 hinge_xc=0.76, breaks=(0.32,), tip=False, n_chord=30))
    # The game moves surfaces named Flap_*: rename the outer flaps.
    for sfx in ("_L", "_R"):
        o = parts.pop("FlapOut" + sfx)
        o.name = "Flap_Out" + sfx
        parts[o.name] = o
    # Sharklets: tall blended winglets.
    tip = Vector(WING.section(1.0, [(0.0, 0.0)])[0])
    sk = g.Surface(planform=[(0.0, 1.50, tip.y), (0.25, 0.80, tip.y + 1.05), (1.0, 0.35, tip.y + 1.90)],
                   half_span=2.40, root_x=tip.x, root_z=tip.z, vertical=True, cant_deg=12,
                   airfoil=(0.0, 0.4, 0.08))
    parts.update(g.build_surface(col, m["airframe"], sk, "Sharklet", n_chord=18))
    parts.update(g.build_surface(col, m["airframe"], HSTAB, "HStab",
                                 controls=[("Elevator", 0.05, 0.95)], hinge_xc=0.66, n_chord=22))
    g.merge_into(parts, ["HStab_L", "HStab_R"], "HStab", col)
    parts.update(g.build_surface(col, m["airframe"], FIN, "Fin", controls=[("Rudder", 0.04, 0.94)],
                                 hinge_xc=0.66, mirror=False, n_chord=22))

    ex = Vector(WING.section(ENGINE_B, [(0.0, 0.0)])[0]).x
    for side, sfx in ((1, "_L"), (-1, "_R")):
        front = (side * ex, ENGINE_FRONT_Y, ENGINE_Z)
        for o in g.turbofan(col, m["airframe"], m["intake"], m["metal"], front, ENGINE_LEN, ENGINE_R,
                            name="Engine" + sfx, fan_name="Fan" + sfx):
            parts[o.name] = o
        wz = WING.section(ENGINE_B, [(0.3, -0.06)])[0][2]
        pv, pf = g.box(side * ex, ENGINE_FRONT_Y + 3.0, (wz + ENGINE_Z + ENGINE_R) / 2, 0.42, 3.6,
                       wz - ENGINE_Z - ENGINE_R + 0.2)
        parts["Pylon" + sfx] = g.make_object("Pylon" + sfx, pv, pf, col, m["airframe"], smooth_angle=30)
    build_gear(col, m, parts)
    build_details(col, m, parts)
    return parts


def build_gear(col, m, parts):
    for side, name in ((1, "Gear_L"), (-1, "Gear_R")):
        top = (side * 3.80, 0.90, -1.50)
        axles = [(side * 3.48, 1.05, -3.04), (side * 4.12, 1.05, -3.04)]
        parts[name] = g.gear_leg(col, m["tire"], m["gear"], name, top, axles, 0.57, 0.40,
                                 hinge_dir=(0, 1, 0), strut_r=0.16)
    parts["Gear_N"] = g.gear_leg(col, m["tire"], m["gear"], "Gear_N", (0, -15.30, -1.70),
                                 [(0.26, -15.50, -3.15), (-0.26, -15.50, -3.15)], 0.45, 0.28,
                                 hinge_dir=(1, 0, 0), strut_r=0.12)


def build_details(col, m, parts):
    tip = Vector(WING.section(1.0, [(0.3, 0.0)])[0])
    ant = g.merge_parts([
        g.box(0.0, -9.0, 2.12, 0.03, 0.55, 0.30),
        g.box(0.0, 4.0, 2.12, 0.03, 0.55, 0.30),
        g.box(0.0, -6.0, -2.12, 0.03, 0.50, 0.28),
    ])
    parts["Antenna"] = g.make_object("Antenna", *ant, col, m["metal_dark"], smooth_angle=30)
    g.light(col, "NavLight_L", m["nav_red"], (tip.x + 0.1, tip.y, tip.z), 0.09)
    g.light(col, "NavLight_R", m["nav_green"], (-tip.x - 0.1, tip.y, tip.z), 0.09)
    g.light(col, "Strobe_Tail", m["nav_white"], (0, 18.82, 1.0), 0.08)
    g.light(col, "Beacon", m["nav_red"], (0, -2.0, 2.10), 0.10)


def materials(principled, srgb):
    return ck.materials(principled, srgb)


ATLAS = ["Fuselage", "Wing_L", "Wing_R", "Flap_L", "Flap_R", "Flap_Out_L", "Flap_Out_R",
         "Aileron_L", "Aileron_R", "HStab", "Elevator_L", "Elevator_R", "Fin", "Rudder",
         "Sharklet_L", "Sharklet_R", "Engine_L", "Engine_R", "Pylon_L", "Pylon_R"]
SUBDIVIDE = {"Fuselage", "Glass", "Engine_L", "Engine_R"}
LOD2_SKIN = ATLAS + ["Glass", "EngineIntake_L", "EngineIntake_R"]
LOD2_KEEP = ["Gear_L", "Gear_R", "Gear_N"]
LOD2_TARGET = 3000

META = {
    "gearHeight": -GROUND_Z,
    "eye": [0.52, 1.10, 16.6],
    "wingCam": [9.0, 0.6, -1.0],
    "hull": {"nose": [0, 0, 18.8], "wingL": [17.6, 2.6, -6.5], "wingR": [-17.6, 2.6, -6.5],
             "tail": [0, 8.1, -16.5]},
    "length": 37.57, "span": 35.8,
}


def livery(m):
    c = tx.Canvas(m, WHITE, 0.28)
    x, y, z, ax, nz = m.x, m.y, m.z, m.ax, m.nz
    fuse = m.part("Fuselage")
    wing = m.part("Wing_*", "Flap_*", "Aileron_*")
    tail_h = m.part("HStab", "Elevator_*")
    fin = m.part("Fin", "Rudder")
    eng = m.part("Engine_*")
    shark = m.part("Sharklet_*")
    side = np.abs(m.nx) > 0.25

    # Belly navy, red cheatline, navy pinstripe.
    zl = -0.95
    c.put(fuse & (z < zl - 0.18), NAVY, 0.30)
    c.put(fuse & (np.abs(z - zl) < 0.13) & (y > -17.0) & (y < 17.0), RED, 0.26)
    c.put(fuse & (np.abs(z - zl - 0.22) < 0.03) & (y > -16.6) & (y < 16.6), NAVY, 0.26)
    # Cabin windows: one row, gaps at the doors and overwing exits.
    wy = np.round((y + 12.6) / WINDOW_PITCH) * WINDOW_PITCH - 12.6
    row = fuse & side & (y > -13.6) & (y < 11.2)
    for dy in DOORS_Y:
        row &= np.abs(wy - dy) > 0.7
    win = row & tx.rounded_rect(y, z, wy, 0.42, 0.115, 0.17, 0.10)
    c.put(win, WINDOW, 0.05)
    # Doors (L1, L4 big; overwing exits small) as panel outlines.
    lines = np.zeros(m.shape, bool)
    for dy, hw_, hh in ((-14.55, 0.42, 0.95), (12.35, 0.42, 0.95), (-10.9, 0.30, 0.85),
                        (0.0, 0.26, 0.50), (1.1, 0.26, 0.50)):
        d = tx.rounded_rect(y, z, dy, 0.10, hw_, hh, 0.12)
        di = tx.rounded_rect(y, z, dy, 0.10, hw_ - 0.012, hh - 0.012, 0.12)
        lines |= fuse & side & d & ~di
    # Cockpit window frames.
    rim = fuse & ~glass_mask(m, 0.0) & glass_mask(m, 0.06)
    c.put(rim, DARK, 0.6)
    # Radome, engines, tail, sharklets.
    c.put(fuse & (y < -18.2), (0.80, 0.81, 0.83), 0.35)
    c.put(eng, NAVY, 0.30)
    c.put(eng & (y < ENGINE_FRONT_Y + 0.25), RED, 0.25)
    c.put(fin, NAVY, 0.30)
    c.put(fin & (np.abs(z - (3.2 + 0.25 * (y - 12.0))) < 0.22), RED, 0.30)
    c.put(shark, RED, 0.30)
    c.put(tail_h & (ax > 5.6), RED, 0.30)
    le = (wing | tail_h) & (m.ny < -0.6)
    c.put(le, (0.72, 0.74, 0.77), 0.25, 0.8)
    walk = wing & (nz > 0.6) & (ax > 2.2) & (ax < 4.2) & (y > -2.8) & (y < 0.5)
    c.put(walk, (0.55, 0.56, 0.58), 0.9)
    lines |= fuse & tx.near(y, (-17.9, -14.0, -6.8, 7.0, 14.6, 16.8), 0.008)
    lines |= wing & tx.near(ax, (4, 7, 10, 13, 15.5), 0.008)
    tx.paint_logo(c, fin, y, z, 14.6, 5.7, 3.1)
    c.shade(lines, 0.62)
    return c


def glass_mask(m, grow):
    y, z, ax = m.y, m.z, m.ax
    top = 1.48 + 0.25 * (y + 17.8) / 1.6
    return (y > -17.80 - grow) & (y < -16.20 + grow) & (z > 0.88 - grow) & (z < top + grow) & (
        (ax > 0.25 - grow) | (y < -17.2 + grow))


def decals(col, parts):
    out = {"Fuselage": [], "Fin": [], "Engine_L": [], "Engine_R": []}
    for side in (1, -1):
        ax_ = tx.side_axes(side)
        out["Fuselage"].append(tx.text_mesh(col, f"D_name_{side}", "TRAPANOTTO AIRLINES", 1.05,
                                            (side * 2.0, -2.5, 1.05), *ax_, NAVY, spacing=1.12))
        out["Fuselage"].append(tx.text_mesh(col, f"D_reg_{side}", REG, 0.42,
                                            (side * 2.0, 13.6, -0.30), *ax_, NAVY))
        out["Fuselage"].extend(tx.swiss_flag(col, f"D_flag_{side}", 0.40,
                                             (side * 2.0, -13.2, 0.55), *ax_))
        out["Fuselage"].append(tx.text_mesh(col, f"D_type_{side}", "A320", 0.28,
                                            (side * 1.6, -15.9, -0.55), *ax_, NAVY))
    for side, target in ((1, "Engine_L"), (-1, "Engine_R")):
        ax_ = tx.side_axes(side)
        ex = Vector(WING.section(ENGINE_B, [(0.0, 0.0)])[0]).x
        out[target].append(tx.text_mesh(col, f"D_eng_{side}", "TRAPANOTTO", 0.42,
                                        (side * (ex + ENGINE_R), ENGINE_FRONT_Y + 2.2, ENGINE_Z),
                                        *ax_, WHITE))
    return out
