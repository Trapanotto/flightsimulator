"""
Pilatus PC-12 NGX in Trapanotto Airlines colours (HB-TPC).

Real dimensions: length 14.40 m, span 16.28 m, height 4.26 m; low wing with winglets, T-tail,
ventral strakes, one PT6A turboprop with a five-blade propeller (2.67 m), retractable
trailing-link gear. Built in Stans, Switzerland.
Blender frame: nose at -Y, up +Z, origin = 1.85 m above the ground.
"""

import numpy as np
from mathutils import Vector

from ac import cockpit as ck
from ac import geometry as g
from ac import texturing as tx
from ac.texturing import BELLY, DARK, NAVY, RED, WHITE, WINDOW

ID = "pc12"
SIZE = 16.3
GROUND_Z = -1.85
TEXTURE_SIZE = 2048
REG = "HB-TPC"
PREVIEW_VIEWS = {
    "eye": ((0.38, -2.75, 0.82), (0.38, -12.0, 0.3), 18),
    "panel": ((0.36, -2.58, 0.90), (0.05, -3.45, 0.12), 14),
}

FUSE = g.Fuselage(
    nose_y=-6.60, tail_y=7.40, seg=48, stations=96,
    keys=[
        (0.000, 0.32, 0.20, -0.36, 2.4),
        (0.040, 0.50, 0.32, -0.58, 2.5),
        (0.100, 0.60, 0.40, -0.70, 2.6),
        (0.170, 0.68, 0.56, -0.76, 2.8),
        (0.220, 0.74, 0.86, -0.79, 3.0),
        (0.280, 0.78, 1.05, -0.81, 3.0),
        (0.400, 0.80, 1.08, -0.82, 3.0),
        (0.580, 0.80, 1.06, -0.80, 3.0),
        (0.680, 0.72, 0.98, -0.60, 2.8),
        (0.780, 0.55, 0.88, -0.33, 2.6),
        (0.880, 0.38, 0.81, -0.04, 2.5),
        (0.950, 0.26, 0.77, 0.13, 2.4),
        (1.000, 0.18, 0.73, 0.22, 2.4),
    ],
)

WING = g.Surface(
    planform=[(0.0, 2.45, -2.20), (0.18, 2.35, -2.18), (1.0, 1.20, -1.90)],
    half_span=8.10, root_z=-0.56, dihedral_deg=5.0, twist_deg=-2.5, airfoil=(0.02, 0.4, 0.15),
)
WINGLET = None  # built from the wing tip in build()
FIN = g.Surface(
    planform=[(0.0, 2.85, 4.25), (1.0, 1.70, 5.70)],
    half_span=2.10, root_z=0.80, vertical=True, airfoil=(0.0, 0.4, 0.11),
)
HSTAB = g.Surface(
    planform=[(0.0, 1.60, 5.85), (1.0, 0.95, 6.30)],
    half_span=2.62, root_z=2.86, dihedral_deg=-1.0, airfoil=(0.0, 0.4, 0.10),
)
DORSAL = g.Surface(
    planform=[(0.0, 1.60, 2.90), (1.0, 0.12, 4.40)],
    half_span=0.32, root_z=0.80, vertical=True, airfoil=(0.0, 0.4, 0.06),
)

PROP_C = Vector((0.0, -6.92, -0.05))


def window(c):
    """Cockpit glazing only: windshield and the two side windows; cabin windows are painted."""
    x, y, z = c
    if -3.72 < y < -2.78 and z > 0.50:
        return True
    if abs(x) > 0.55 and -2.88 < y < -2.10 and 0.32 < z < 0.95 - 0.12 * (y + 2.88):
        return True
    return False


# Honeywell Primus Apex: PFD, two MFDs (map, engine and systems), PFD; power and condition
# levers on the pedestal.
COCKPIT = {
    "floor": -0.30,
    "panel": dict(y=-3.45, z=0.30, w=1.30, h=0.40, tilt=10),
    "displays": [("PFD", 0.48, 0.03, 0.27, 0.21, "g1000"), ("MFD", 0.165, 0.03, 0.27, 0.21, "g1000"),
                 ("EICAS", -0.165, 0.03, 0.27, 0.21, "g1000"), ("PFD", -0.48, 0.03, 0.27, 0.21, "g1000")],
    "switches": [(0.60, -0.16, 8, 0.04, "toggle"), (-0.32, -0.16, 8, 0.04, "toggle"),
                 (0.06, -0.15, 3, 0.06, "knob")],
    "glare": dict(depth=0.34, h=0.08, fcu=(0.52, 0.04)),
    "pedestal": dict(y1=-2.80, w=0.26, z_front=0.0, z_rear=-0.10, lever_len=0.13,
                     levers=[(0.03, "knob", None), (-0.05, "knob", "ck_red")], trim_wheel=True),
    "controls": ("yoke", [(0.38, -3.10, 0.26, "L"), (-0.38, -3.10, 0.26, "R")]),
    "seats": [(0.38, -2.70, "ga"), (-0.38, -2.70, "ga")],
    "seat_mat": "ck_leather",
    "pedals": [(0.38, -3.30), (-0.38, -3.30)],
}


def build(col, m):
    parts = {}
    skin, glass = FUSE.build(col, m["airframe"], m["glass"], window)
    parts["Fuselage"], parts["Glass"] = skin, glass
    parts["Cabin"] = FUSE.interior(
        col, m["interior"], 0.17, 0.36, -0.30,
        window=window, deck=(-4.60, -3.40, 0.43),
    )
    parts.update(ck.build(col, m, FUSE, COCKPIT))
    parts.update(g.build_surface(col, m["airframe"], WING, "Wing",
                                 controls=[("Flap", 0.10, 0.62), ("Aileron", 0.65, 0.94)],
                                 hinge_xc=0.74, breaks=(0.18,), tip=False))
    # Winglets: short upturned fins on the wing tips.
    tip = Vector(WING.section(1.0, [(0.0, 0.0)])[0])
    wl = g.Surface(planform=[(0.0, 1.15, tip.y), (1.0, 0.45, tip.y + 0.75)],
                   half_span=0.62, root_z=tip.z, root_x=tip.x, vertical=True, cant_deg=18,
                   airfoil=(0.0, 0.4, 0.09))
    parts.update(g.build_surface(col, m["airframe"], wl, "Winglet", n_chord=18))
    parts.update(g.build_surface(col, m["airframe"], FIN, "Fin", controls=[("Rudder", 0.04, 0.93)],
                                 hinge_xc=0.68, mirror=False, n_chord=22, tip=False))
    parts.update(g.build_surface(col, m["airframe"], HSTAB, "HStab",
                                 controls=[("Elevator", 0.06, 0.96)], hinge_xc=0.64, n_chord=22))
    g.merge_into(parts, ["HStab_L", "HStab_R"], "HStab", col)
    parts.update(g.build_surface(col, m["airframe"], DORSAL, "Dorsal", mirror=False, tip=False,
                                 n_chord=14))
    # Ventral strakes under the tail cone, splayed outwards.
    st = g.Surface(planform=[(0.0, 1.40, 5.20), (1.0, 0.55, 6.10)],
                   half_span=0.42, root_z=0.12, root_x=0.22, vertical=True, cant_deg=145,
                   airfoil=(0.0, 0.4, 0.07))
    parts.update(g.build_surface(col, m["airframe"], st, "Strake", n_chord=14, tip=False))

    parts["Spinner"] = g.spinner(col, m["airframe"], PROP_C + Vector((0, 0.18, 0)), 0.30, 0.72)
    parts["Propeller"] = g.propeller(col, m["prop"], m["prop_tip"], PROP_C, 1.33, blades=5,
                                     pitch=3.4, root_r=0.22, chord=0.24)
    parts["PropDisc"] = g.prop_disc(col, m["prop_disc"], PROP_C, 1.33)
    build_gear(col, m, parts)
    build_details(col, m, parts)
    return parts


def build_gear(col, m, parts):
    """Retractable trailing-link gear: mains fold inwards into the wing, nose gear backwards."""
    for side, name in ((1, "Gear_L"), (-1, "Gear_R")):
        top = Vector((side * 2.20, -0.75, -0.66))
        axle = Vector((side * 2.20, -0.38, -1.47))
        link = g.merge_parts([g.cylinder(axle + Vector((side * 0.10, -0.42, 0.20)), axle + Vector((side * 0.10, 0, 0)), 0.05)])
        parts[name] = g.gear_leg(col, m["tire"], m["gear"], name, top, [axle], 0.38, 0.20,
                                 hinge_dir=(0, 1, 0), extra_metal=[link], strut_r=0.075)
    parts["Gear_N"] = g.gear_leg(col, m["tire"], m["gear"], "Gear_N", (0, -5.15, -0.62),
                                 [(0, -5.32, -1.55)], 0.30, 0.16, hinge_dir=(1, 0, 0), strut_r=0.06)


def build_details(col, m, parts):
    # Exhaust stacks either side of the cowling, swept back.
    ex = []
    for side in (1, -1):
        ex.append(g.tube([Vector((side * 0.52, -5.45, 0.05)), Vector((side * 0.70, -5.18, 0.02)),
                          Vector((side * 0.76, -4.95, 0.00))], 0.11, 12))
    parts["Exhaust"] = g.make_object("Exhaust", *g.merge_parts(ex), col, m["metal_dark"], smooth_angle=50)
    # Engine intake under the spinner.
    intake = g.ellipsoid((0, -6.30, -0.50), 0.28, 0.30, 0.12, 14, 8)
    parts["Intake"] = g.make_object("Intake", *intake, col, m["intake"], smooth_angle=40)
    # Antennas on top and under the fuselage, pitot under the left wing.
    tip_left = Vector(WING.section(0.55, [(0.0, -0.03)])[0])
    ant = g.merge_parts([
        g.box(0.0, 0.40, 1.15, 0.015, 0.30, 0.22),
        g.box(0.0, 2.20, 1.10, 0.015, 0.28, 0.20),
        g.box(0.0, 0.80, -0.90, 0.015, 0.25, 0.18),
        g.cylinder(tip_left, tip_left + Vector((0, -0.55, -0.02)), 0.014, 8),
    ])
    parts["Antenna"] = g.make_object("Antenna", *ant, col, m["metal_dark"], smooth_angle=30)
    tip = Vector(WING.section(1.0, [(0.30, 0.0)])[0])
    g.light(col, "NavLight_L", m["nav_red"], (tip.x + 0.05, tip.y, tip.z - 0.05))
    g.light(col, "NavLight_R", m["nav_green"], (-tip.x - 0.05, tip.y, tip.z - 0.05))
    g.light(col, "Strobe_Tail", m["nav_white"], (0, 7.42, 0.48), 0.035)
    g.light(col, "Beacon", m["nav_red"], (0, 1.2, 1.12), 0.05)


def materials(principled, srgb):
    return ck.materials(principled, srgb)


ATLAS = ["Fuselage", "Wing_L", "Wing_R", "Flap_L", "Flap_R", "Aileron_L", "Aileron_R", "HStab",
         "Elevator_L", "Elevator_R", "Fin", "Rudder", "Dorsal", "Winglet_L", "Winglet_R",
         "Strake_L", "Strake_R", "Spinner"]
SUBDIVIDE = {"Fuselage", "Spinner", "Glass"}
LOD2_SKIN = ATLAS + ["Glass"]
LOD2_KEEP = ["Gear_L", "Gear_R", "Gear_N", "PropDisc"]

META = {
    "gearHeight": -GROUND_Z,
    "eye": [0.38, 0.82, 2.75],
    "wingCam": [3.2, -0.2, 0.2],
    "hull": {"nose": [0, -0.05, 7.4], "wingL": [8.1, 0.5, 1.6], "wingR": [-8.1, 0.5, 1.6],
             "tail": [0, 2.95, -7.4]},
    "length": 14.4, "span": 16.28,
}

# Cabin windows (painted): six per side, rounded rectangles.
CABIN_WINDOWS_Y = [-1.70, -0.98, -0.26, 0.46, 1.18]


def livery(m):
    c = tx.Canvas(m, WHITE, 0.30)
    x, y, z, ax, nz = m.x, m.y, m.z, m.ax, m.nz
    fuse = m.part("Fuselage")
    wing = m.part("Wing_*", "Flap_*", "Aileron_*")
    winglet = m.part("Winglet_*")
    tail_h = m.part("HStab", "Elevator_*")
    fin = m.part("Fin", "Rudder", "Dorsal")
    side = np.abs(m.nx) > 0.3

    # Navy belly under a sweeping red line that rises towards the tail.
    t = np.clip((y + 6.0) / 13.0, 0, 1)
    zl = -0.30 + 0.62 * tx.smoothstep(0.45, 1.0, t)
    c.put(fuse & (z < zl), NAVY, 0.32)
    c.put(fuse & (np.abs(z - zl - 0.05) < 0.05) & (y > -6.0), RED, 0.28)
    c.put(fuse & (np.abs(z - zl - 0.13) < 0.012) & (y > -5.6), NAVY, 0.28)
    c.put(m.part("Spinner"), WHITE, 0.25)
    c.put(m.part("Spinner") & (y > -6.85), RED, 0.25)
    # Painted cabin windows and window line, dark windshield frames.
    for wy in CABIN_WINDOWS_Y:
        w = tx.rounded_rect(y, z, wy, 0.55, 0.20, 0.24, 0.08) & fuse & side
        c.put(w, WINDOW, 0.05)
        rim = tx.rounded_rect(y, z, wy, 0.55, 0.225, 0.265, 0.09) & fuse & side & ~w
        c.put(rim, DARK, 0.5)
    rim = fuse & ~glass_mask(m, 0.0) & glass_mask(m, 0.04)
    c.put(rim, DARK, 0.6)
    # Fin navy with a red band, tail plane and winglets red tips.
    c.put(fin & (z > 1.30 + 0.22 * (y - 4.4)), NAVY, 0.30)
    c.put(fin & (np.abs(z - (1.22 + 0.22 * (y - 4.4))) < 0.07), RED, 0.30)
    c.put(tail_h & (ax > 2.15), RED, 0.30)
    c.put(winglet, RED, 0.30)
    walk = wing & (nz > 0.6) & (ax > 0.85) & (ax < 1.65) & (y > -2.1) & (y < -0.2)
    c.put(walk, (0.30, 0.31, 0.32), 0.95)
    # De-ice boots on the wing and tail leading edges.
    le = (wing | tail_h) & (m.ny < -0.55)
    c.put(le, (0.16, 0.17, 0.18), 0.85)
    c.put(fin & (m.ny < -0.6) & (z > 0.9), (0.16, 0.17, 0.18), 0.85)

    # Doors (airstair front left, cargo rear left) and panel lines.
    lines = fuse & tx.near(y, (-5.9, -5.0, -4.25, 3.0, 4.6, 6.0), 0.006)
    door = (x > 0.3) & side
    d1 = tx.rounded_rect(y, z, -2.05, 0.15, 0.36, 0.70, 0.06)
    d1i = tx.rounded_rect(y, z, -2.05, 0.15, 0.352, 0.692, 0.06)
    d2 = tx.rounded_rect(y, z, 2.15, 0.20, 0.66, 0.66, 0.06)
    d2i = tx.rounded_rect(y, z, 2.15, 0.20, 0.652, 0.652, 0.06)
    lines |= fuse & door & ((d1 & ~d1i) | (d2 & ~d2i))
    lines |= wing & tx.near(ax, (1.7, 3.0, 4.4, 5.8, 7.2), 0.005)
    tx.paint_logo(c, fin, y, z, 5.55, 2.05, 0.7)
    c.shade(lines, 0.6)
    soot = fuse & (y > -5.3) & (y < -2.0) & (np.abs(z) < 0.35) & side
    s = np.exp(-np.clip(y + 5.0, 0, None) / 1.6) * tx.smoothstep(0.35, 0.0, np.abs(z))
    c.col *= (1 - 0.4 * np.where(soot, s, 0))[..., None]
    return c


def glass_mask(m, grow):
    y, z, ax = m.y, m.z, m.ax
    ws = (y > -3.72 - grow) & (y < -2.78 + grow) & (z > 0.50 - grow)
    sw = (ax > 0.5) & (y > -2.88 - grow) & (y < -2.10 + grow) & (z > 0.32 - grow) & (
        z < 0.95 - 0.12 * (y + 2.88) + grow)
    return ws | sw


def decals(col, parts):
    out = {"Fuselage": [], "Fin": [], "Wing_L": []}
    for side in (1, -1):
        ax_ = tx.side_axes(side)
        out["Fuselage"].append(tx.text_mesh(col, f"D_name_{side}", "TRAPANOTTO AIRLINES", 0.19,
                                            (side * 0.85, -0.25, 0.95), *ax_, NAVY, spacing=1.12))
        out["Fuselage"].append(tx.text_mesh(col, f"D_model_{side}", "PC-12 NGX", 0.12,
                                            (side * 0.75, -4.70, 0.10), *ax_, NAVY, spacing=1.2))
        out["Fuselage"].append(tx.text_mesh(col, f"D_reg_{side}", REG, 0.28,
                                            (side * 0.55, 4.40, 0.42), *ax_, NAVY))
        out["Fuselage"].extend(tx.swiss_flag(col, f"D_flag_{side}", 0.16,
                                             (side * 0.55, 5.55, 0.42), *ax_))
    out["Wing_L"].append(tx.text_mesh(col, "D_reg_wing", REG, 0.80, (4.4, -1.30, -0.30),
                                      (1, 0, 0), (0, -1, 0), NAVY))
    return out
