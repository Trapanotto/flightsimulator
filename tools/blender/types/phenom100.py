"""
Embraer Phenom 100EV in Trapanotto Airlines colours (HB-TEP).

Real dimensions: length 12.82 m, span 12.30 m, height 4.35 m; swept low wing, T-tail, two
PW617F turbofans on the rear fuselage, wrap-around windshield, retractable gear.
Blender frame: nose at -Y, up +Z, origin = 1.30 m above the ground.
"""

import numpy as np
from mathutils import Vector

from ac import geometry as g
from ac import texturing as tx
from ac.texturing import DARK, NAVY, RED, WHITE, WINDOW

ID = "phenom100"
SIZE = 12.8
GROUND_Z = -1.30
TEXTURE_SIZE = 2048
REG = "HB-TEP"
PREVIEW_VIEWS = {"eye": ((0.35, -3.10, 0.72), (0.35, -12.0, 0.2), 18)}

FUSE = g.Fuselage(
    nose_y=-6.30, tail_y=6.10, seg=48, stations=96,
    keys=[
        (0.000, 0.14, 0.04, -0.18, 2.2),
        (0.035, 0.38, 0.22, -0.38, 2.2),
        (0.100, 0.56, 0.42, -0.52, 2.4),
        (0.170, 0.68, 0.66, -0.60, 2.6),
        (0.240, 0.76, 0.86, -0.64, 2.8),
        (0.400, 0.78, 0.90, -0.66, 2.8),
        (0.580, 0.76, 0.88, -0.60, 2.8),
        (0.700, 0.62, 0.80, -0.38, 2.6),
        (0.820, 0.44, 0.70, -0.10, 2.5),
        (0.930, 0.26, 0.62, 0.15, 2.4),
        (1.000, 0.12, 0.58, 0.30, 2.4),
    ],
)

WING = g.Surface(
    planform=[(0.0, 2.65, -0.95), (0.16, 2.35, -0.78), (1.0, 1.00, 0.55)],
    half_span=6.15, root_z=-0.50, dihedral_deg=4.0, twist_deg=-3.0, airfoil=(0.02, 0.4, 0.13),
)
FIN = g.Surface(
    planform=[(0.0, 2.45, 3.70), (1.0, 1.40, 5.20)],
    half_span=1.90, root_z=0.55, vertical=True, airfoil=(0.0, 0.4, 0.11),
)
HSTAB = g.Surface(
    planform=[(0.0, 1.40, 5.15), (1.0, 0.80, 5.75)],
    half_span=2.50, root_z=2.40, dihedral_deg=-2.0, airfoil=(0.0, 0.4, 0.10),
)
ENGINE_X, ENGINE_Y, ENGINE_Z, ENGINE_LEN, ENGINE_R = 1.08, 1.85, 0.55, 2.05, 0.40
CABIN_WINDOWS_Y = [-2.25, -1.40, -0.55, 0.30]


def window(c):
    """Wrap-around windshield and the cockpit side windows; cabin windows are painted."""
    x, y, z = c
    if -4.25 < y < -3.40 and z > 0.28:
        return True
    if abs(x) > 0.55 and -3.45 < y < -2.95 and 0.22 < z < 0.78:
        return True
    return False


def build(col, m):
    parts = {}
    skin, glass = FUSE.build(col, m["airframe"], m["glass"], window)
    parts["Fuselage"], parts["Glass"] = skin, glass
    parts["Cabin"] = FUSE.interior(
        col, m["interior"], 0.13, 0.30, -0.36,
        seats=[(0.35, -3.25, 0.0), (-0.35, -3.25, 0.0)],
        panel=(-3.82, -0.02, 1.25, 0.36), window=window, screen_mat=m["screen"],
        yokes=[(0.35, -3.50, -0.05), (-0.35, -3.50, -0.05)], deck=(-4.9, -3.80, 0.19),
    )
    parts.update(g.build_surface(col, m["airframe"], WING, "Wing",
                                 controls=[("Flap", 0.14, 0.62), ("Aileron", 0.66, 0.95)],
                                 hinge_xc=0.74, breaks=(0.16,)))
    parts.update(g.build_surface(col, m["airframe"], FIN, "Fin", controls=[("Rudder", 0.04, 0.92)],
                                 hinge_xc=0.68, mirror=False, n_chord=22, tip=False))
    parts.update(g.build_surface(col, m["airframe"], HSTAB, "HStab",
                                 controls=[("Elevator", 0.05, 0.96)], hinge_xc=0.64, n_chord=22))
    g.merge_into(parts, ["HStab_L", "HStab_R"], "HStab", col)

    # Rear-mounted turbofans on short horizontal pylons.
    for side, sfx in ((1, "_L"), (-1, "_R")):
        front = (side * ENGINE_X, ENGINE_Y, ENGINE_Z)
        objs = g.turbofan(col, m["airframe"], m["intake"], m["metal"], front, ENGINE_LEN, ENGINE_R,
                          name="Engine" + sfx, fan_name="Fan" + sfx)
        for o in objs:
            parts[o.name] = o
        pv, pf = g.box(side * 0.80, ENGINE_Y + 0.95, ENGINE_Z, 0.62, 0.95, 0.10)
        parts["Pylon" + sfx] = g.make_object("Pylon" + sfx, pv, pf, col, m["airframe"], smooth_angle=30)
    build_gear(col, m, parts)
    build_details(col, m, parts)
    return parts


def build_gear(col, m, parts):
    for side, name in ((1, "Gear_L"), (-1, "Gear_R")):
        parts[name] = g.gear_leg(col, m["tire"], m["gear"], name, (side * 1.62, -0.18, -0.62),
                                 [(side * 1.62, 0.04, -1.04)], 0.26, 0.17, hinge_dir=(0, 1, 0),
                                 strut_r=0.065)
    parts["Gear_N"] = g.gear_leg(col, m["tire"], m["gear"], "Gear_N", (0, -4.62, -0.42),
                                 [(0, -4.74, -1.10)], 0.20, 0.13, hinge_dir=(1, 0, 0), strut_r=0.05)


def build_details(col, m, parts):
    tip = Vector(WING.section(1.0, [(0.30, 0.0)])[0])
    ant = g.merge_parts([
        g.box(0.0, -0.80, 0.97, 0.014, 0.28, 0.18),
        g.box(0.0, 1.20, 0.94, 0.014, 0.26, 0.16),
        g.box(0.0, -1.20, -0.74, 0.014, 0.24, 0.15),
        g.cylinder((0.30, -5.20, 0.10), (0.30, -5.55, 0.10), 0.012, 8),
        g.cylinder((-0.30, -5.20, 0.10), (-0.30, -5.55, 0.10), 0.012, 8),
    ])
    parts["Antenna"] = g.make_object("Antenna", *ant, col, m["metal_dark"], smooth_angle=30)
    g.light(col, "NavLight_L", m["nav_red"], (tip.x + 0.04, tip.y, tip.z))
    g.light(col, "NavLight_R", m["nav_green"], (-tip.x - 0.04, tip.y, tip.z))
    g.light(col, "Strobe_Tail", m["nav_white"], (0, 6.12, 0.45), 0.035)
    g.light(col, "Beacon", m["nav_red"], (0, 0.2, 0.93), 0.05)


def materials(principled, srgb):
    return dict(screen=principled("Screen", srgb(0.04, 0.07, 0.14), 0.2,
                                  emission=(0.10, 0.22, 0.45), strength=0.6))


ATLAS = ["Fuselage", "Wing_L", "Wing_R", "Flap_L", "Flap_R", "Aileron_L", "Aileron_R", "HStab",
         "Elevator_L", "Elevator_R", "Fin", "Rudder", "Engine_L", "Engine_R", "Pylon_L", "Pylon_R"]
SUBDIVIDE = {"Fuselage", "Glass", "Engine_L", "Engine_R"}
LOD2_SKIN = ATLAS + ["Glass", "EngineIntake_L", "EngineIntake_R"]
LOD2_KEEP = ["Gear_L", "Gear_R", "Gear_N"]

META = {
    "gearHeight": -GROUND_Z,
    "eye": [0.35, 0.72, 3.10],
    "wingCam": [3.0, -0.10, -0.30],
    "hull": {"nose": [0, -0.05, 6.3], "wingL": [6.15, -0.07, -1.0], "wingR": [-6.15, -0.07, -1.0],
             "tail": [0, 2.45, -5.9]},
    "length": 12.82, "span": 12.30,
}


def livery(m):
    c = tx.Canvas(m, WHITE, 0.28)
    x, y, z, ax, nz = m.x, m.y, m.z, m.ax, m.nz
    fuse = m.part("Fuselage")
    wing = m.part("Wing_*", "Flap_*", "Aileron_*")
    tail_h = m.part("HStab", "Elevator_*")
    fin = m.part("Fin", "Rudder")
    eng = m.part("Engine_*")
    side = np.abs(m.nx) > 0.3

    # Navy lower fuselage under a red line that sweeps up to the tail.
    t = np.clip((y + 5.6) / 11.5, 0, 1)
    zl = -0.32 + 0.70 * tx.smoothstep(0.40, 1.0, t)
    c.put(fuse & (z < zl), NAVY, 0.30)
    c.put(fuse & (np.abs(z - zl - 0.045) < 0.045) & (y > -5.6), RED, 0.26)
    # Radome slightly darker grey.
    c.put(fuse & (y < -5.75), (0.80, 0.81, 0.83), 0.35)
    # Painted oval cabin windows.
    for wy in CABIN_WINDOWS_Y:
        w = tx.rounded_rect(y, z, wy, 0.42, 0.17, 0.22, 0.15) & fuse & side
        c.put(w, WINDOW, 0.05)
        r = tx.rounded_rect(y, z, wy, 0.42, 0.19, 0.24, 0.16) & fuse & side & ~w
        c.put(r, DARK, 0.5)
    rim = fuse & ~glass_mask(m, 0.0) & glass_mask(m, 0.035)
    c.put(rim, DARK, 0.6)
    # Engines navy with a red intake lip, tail navy with red band, red stab tips.
    c.put(eng, NAVY, 0.30)
    c.put(eng & (y < ENGINE_Y + 0.12), RED, 0.25)
    c.put(fin & (z > 1.05 + 0.25 * (y - 3.9)), NAVY, 0.30)
    c.put(fin & (np.abs(z - (0.98 + 0.25 * (y - 3.9))) < 0.06), RED, 0.30)
    c.put(tail_h & (ax > 2.05), RED, 0.30)
    c.put(wing & (ax > 5.6), RED, 0.30)
    le = (wing | tail_h) & (m.ny < -0.6)
    c.put(le, (0.70, 0.72, 0.75), 0.25, 0.8)
    lines = fuse & tx.near(y, (-5.75, -4.9, -2.75, 1.4, 3.2, 4.8), 0.005)
    door = (x > 0.3) & side
    d = tx.rounded_rect(y, z, -2.75, 0.18, 0.36, 0.66, 0.08)
    di = tx.rounded_rect(y, z, -2.75, 0.18, 0.352, 0.652, 0.08)
    lines |= fuse & door & d & ~di
    lines |= wing & tx.near(ax, (1.5, 2.6, 3.7, 4.8), 0.005)
    tx.paint_logo(c, fin, y, z, 4.85, 1.72, 0.62)
    c.shade(lines, 0.6)
    return c


def glass_mask(m, grow):
    y, z, ax = m.y, m.z, m.ax
    ws = (y > -4.25 - grow) & (y < -3.40 + grow) & (z > 0.28 - grow)
    sw = (ax > 0.5) & (y > -3.45 - grow) & (y < -2.95 + grow) & (z > 0.22 - grow) & (z < 0.78 + grow)
    return ws | sw


def decals(col, parts):
    out = {"Fuselage": [], "Fin": [], "Engine_L": [], "Engine_R": []}
    for side in (1, -1):
        ax_ = tx.side_axes(side)
        out["Fuselage"].append(tx.text_mesh(col, f"D_name_{side}", "TRAPANOTTO AIRLINES", 0.16,
                                            (side * 0.85, -0.95, 0.74), *ax_, NAVY, spacing=1.12))
        out["Fuselage"].append(tx.text_mesh(col, f"D_model_{side}", "PHENOM 100", 0.10,
                                            (side * 0.70, -4.85, 0.20), *ax_, NAVY, spacing=1.2))
        out["Fuselage"].append(tx.text_mesh(col, f"D_reg_{side}", REG, 0.20,
                                            (side * 0.70, 1.15, 0.18), *ax_, NAVY))
        out["Fuselage"].extend(tx.swiss_flag(col, f"D_flag_{side}", 0.12,
                                             (side * 0.70, 1.95, 0.18), *ax_))
    for side, target in ((1, "Engine_L"), (-1, "Engine_R")):
        ax_ = tx.side_axes(side)
        out[target].append(tx.text_mesh(col, f"D_eng_{side}", "TRAPANOTTO", 0.13,
                                        (side * (ENGINE_X + ENGINE_R), ENGINE_Y + 0.95, ENGINE_Z),
                                        *ax_, WHITE))
    return out
