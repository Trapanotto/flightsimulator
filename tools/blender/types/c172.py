"""
Cessna 172 Skyhawk in Trapanotto Airlines colours (HB-TCA).

Real dimensions: length 8.28 m, span 11.00 m, height 2.72 m; high wing with lift struts,
fixed tricycle gear with wheel fairings, two-blade propeller (1.9 m), four seats.
Blender frame: nose at -Y, up +Z, origin = 1.19 m above the ground.
"""

import numpy as np
from mathutils import Vector

from ac import cockpit as ck
from ac import geometry as g
from ac import texturing as tx
from ac.texturing import BELLY, DARK, NAVY, RED, WHITE

ID = "c172"
PREVIEW_VIEWS = {
    "roof": ((-2.6, -4.2, 2.4), (0, -1.2, 0.8), 45),
    "eye": ((0.27, -0.78, 0.62), (0.27, -6.0, 0.45), 18),
    "panel": ((0.24, -0.72, 0.66), (0.05, -1.66, 0.10), 14),
}
SIZE = 11.0
GROUND_Z = -1.19
TEXTURE_SIZE = 2048
REG = "HB-TCA"

FUSE = g.Fuselage(
    nose_y=-3.62, tail_y=4.40, seg=44, stations=84,
    keys=[
        # s, half width, top z, bottom z, superellipse exponent
        (0.000, 0.30, 0.20, -0.30, 2.4),
        (0.030, 0.40, 0.28, -0.40, 2.6),
        (0.100, 0.49, 0.36, -0.50, 3.0),
        (0.180, 0.53, 0.44, -0.54, 3.2),
        (0.225, 0.55, 0.58, -0.55, 3.5),
        (0.290, 0.57, 0.79, -0.56, 3.8),
        (0.420, 0.57, 0.81, -0.53, 3.8),
        (0.520, 0.55, 0.79, -0.47, 3.5),
        (0.600, 0.47, 0.67, -0.36, 3.0),
        (0.700, 0.36, 0.53, -0.22, 2.8),
        (0.820, 0.25, 0.44, -0.06, 2.6),
        (0.930, 0.16, 0.40, 0.08, 2.5),
        (1.000, 0.10, 0.38, 0.16, 2.4),
    ],
)

WING = g.Surface(
    planform=[(0.0, 1.63, -1.30), (0.42, 1.63, -1.30), (1.0, 1.14, -1.22)],
    half_span=5.50, root_z=0.82, dihedral_deg=1.73, twist_deg=-3.0, airfoil=(0.02, 0.4, 0.12),
)
HSTAB = g.Surface(
    planform=[(0.0, 1.32, 3.02), (1.0, 0.82, 3.30)],
    half_span=1.72, root_z=0.16, airfoil=(0.0, 0.4, 0.09),
)
FIN = g.Surface(
    planform=[(0.0, 1.55, 2.86), (1.0, 0.78, 3.78)],
    half_span=1.22, root_z=0.37, vertical=True, airfoil=(0.0, 0.4, 0.10),
)
DORSAL = g.Surface(
    planform=[(0.0, 1.45, 1.45), (1.0, 0.10, 2.88)],
    half_span=0.32, root_z=0.37, vertical=True, airfoil=(0.0, 0.4, 0.06),
)

PROP_C = Vector((0.0, -3.70, -0.04))
STRUT_FUSE = Vector((0.50, -0.38, -0.46))
STRUT_WING_B = 0.47


def window(c):
    """Cabin glazing on the fuselage: windshield, two side windows each side, rear window."""
    x, y, z = c
    ax = abs(x)
    if -2.05 < y < -1.33 and z > 0.47:                      # windshield
        return True
    if ax > 0.38 and 0.24 < z < 0.74 - 0.10 * max(0, y - 0.1):
        if -1.24 < y < -0.27:                               # door window
            return True
        if -0.15 < y < 0.50:                                # rear side window
            return True
    if 0.62 < y < 1.32 and z > 0.47 and ax < 0.36:          # rear window ("Omni-Vision")
        return True
    return False


def materials(principled, srgb):
    return ck.materials(principled, srgb)


# Classic steam-gauge panel: six-pack in front of the pilot, engine strip below, radio stack
# in the middle, push-pull throttle, trim wheel between the seats.
COCKPIT = {
    "floor": -0.30,
    "panel": dict(y=-1.66, z=0.22, w=0.94, h=0.40, tilt=8),
    "displays": [
        ("SIX", 0.27, 0.05, 0.36, 0.24, "none"),
        ("ENG", 0.27, -0.115, 0.32, 0.07, "plain"),
        ("RADIO", -0.04, 0.02, 0.19, 0.27, "plain"),
    ],
    "gauges": [(0.27 + dx, 0.05 + db, 0.052) for db in (0.06, -0.06) for dx in (0.12, 0.0, -0.12)],
    "switches": [(0.44, -0.18, 7, 0.042, "toggle"), (-0.20, -0.17, 4, 0.05, "knob"),
                 (-0.20, 0.15, 5, 0.04, "annunciator")],
    "throttle_knob": (0.03, -0.16),
    "glare": dict(depth=0.28, h=0.06),
    "pedestal": dict(y1=-1.25, w=0.16, z_front=-0.02, z_rear=-0.18, trim_wheel=True),
    "controls": ("yoke", [(0.27, -1.36, 0.10, "L"), (-0.27, -1.36, 0.10, "R")]),
    "seats": [(0.27, -0.85, "ga"), (-0.27, -0.85, "ga")],
    "seat_mat": "ck_leather",
    "pedals": [(0.27, -1.55), (-0.27, -1.55)],
}


def build(col, m):
    parts = {}
    skin, glass = FUSE.build(col, m["airframe"], m["glass"], window)
    parts["Fuselage"], parts["Glass"] = skin, glass
    parts["Cabin"] = FUSE.interior(
        col, m["interior"], 0.20, 0.60, -0.30,
        seats=[(0.27, -0.02, 0.0), (-0.27, -0.02, 0.0)], window=window,
        deck=(-2.60, -1.60, 0.42),
    )
    parts.update(ck.build(col, m, FUSE, COCKPIT))
    parts.update(g.build_surface(col, m["airframe"], WING, "Wing",
                                 controls=[("Flap", 0.08, 0.55), ("Aileron", 0.58, 0.93)],
                                 hinge_xc=0.73, breaks=(0.42,)))
    parts.update(g.build_surface(col, m["airframe"], HSTAB, "HStab",
                                 controls=[("Elevator", 0.06, 0.97)], hinge_xc=0.60, n_chord=22))
    g.merge_into(parts, ["HStab_L", "HStab_R"], "HStab", col)
    parts.update(g.build_surface(col, m["airframe"], FIN, "Fin", controls=[("Rudder", 0.05, 0.99)],
                                 hinge_xc=0.64, mirror=False, n_chord=22))
    parts.update(g.build_surface(col, m["airframe"], DORSAL, "Dorsal", mirror=False, tip=False,
                                 n_chord=14))

    # Lift struts: streamlined bars from the lower fuselage to the wing (part of the atlas).
    struts = []
    for side in (1, -1):
        top = Vector(WING.section(STRUT_WING_B, [(0.42, -0.06)])[0])
        bot = STRUT_FUSE.copy()
        if side < 0:
            top.x, bot.x = -top.x, -bot.x
        pts = [bot + (top - bot) * t for t in (0, 0.5, 1)]
        struts.append(g.flat_bar(pts, 0.12, 0.035))
        # Fairings where the strut meets wing and fuselage.
        struts.append(g.ellipsoid(top + Vector((0, 0, 0.03)), 0.05, 0.14, 0.05, 10, 6))
        struts.append(g.ellipsoid(bot, 0.06, 0.16, 0.05, 10, 6))
    parts["Struts"] = g.make_object("Struts", *g.merge_parts(struts), col, m["airframe"],
                                    smooth_angle=40)

    parts["Spinner"] = g.spinner(col, m["airframe"], PROP_C + Vector((0, 0.06, 0)), 0.19, 0.38)
    parts["Propeller"] = g.propeller(col, m["prop"], m["prop_tip"], PROP_C, 0.95, blades=2,
                                     pitch=1.55, root_r=0.11, chord=0.16)
    parts["PropDisc"] = g.prop_disc(col, m["prop_disc"], PROP_C, 0.95)

    build_gear(col, m, parts)
    build_details(col, m, parts)
    return parts


def build_gear(col, m, parts):
    """Fixed gear: spring-steel main legs and an oleo nose leg, all with wheel fairings."""
    for side, name in ((1, "Gear_L"), (-1, "Gear_R")):
        axle = Vector((side * 1.27, 0.06, -0.98))
        leg = [Vector((side * 0.44, -0.02, -0.50)), Vector((side * 0.80, 0.02, -0.72)),
               Vector((side * 1.16, 0.06, -0.94))]
        tyre, hub = g.wheel(axle, 0.21, 0.14)
        bar = g.flat_bar(leg, 0.11, 0.035)
        pant = g.wheel_fairing(axle + Vector((0, -0.02, 0.04)), 0.92, 0.30, 0.50)
        step = g.box(side * 0.86, -0.02, -0.66, 0.10, 0.16, 0.025)
        parts[name] = g.multi_material(name, [(*tyre, m["tire"]), (*g.merge_parts([hub, bar, step]), m["gear"]),
                                              (*pant, m["gear_white"])], col)
    axle = Vector((0.0, -2.96, -0.99))
    tyre, hub = g.wheel(axle, 0.19, 0.13)
    strut = g.merge_parts([g.cylinder((0, -2.70, -0.44), (0, -2.86, -0.74), 0.045),
                           g.cylinder((0, -2.86, -0.74), (0, -2.93, -0.86), 0.035),
                           g.cylinder((0.10, -2.93, -0.86), (-0.10, -2.93, -0.86), 0.03),
                           g.cylinder((0.10, -2.93, -0.86), (0.10, -2.96, -0.99), 0.022),
                           g.cylinder((-0.10, -2.93, -0.86), (-0.10, -2.96, -0.99), 0.022), hub])
    pant = g.wheel_fairing(axle + Vector((0, -0.04, 0.05)), 0.78, 0.26, 0.44)
    parts["Gear_N"] = g.multi_material("Gear_N", [(*tyre, m["tire"]), (*strut, m["gear"]),
                                                  (*pant, m["gear_white"])], col)


def build_details(col, m, parts):
    # Exhaust stack under the cowling, carburettor air box.
    ex = g.merge_parts([g.cylinder((-0.20, -2.70, -0.46), (-0.22, -2.48, -0.60), 0.045, 10)])
    parts["Exhaust"] = g.make_object("Exhaust", *ex, col, m["metal_dark"], smooth_angle=50)
    airbox = g.box(0.0, -3.30, -0.42, 0.26, 0.24, 0.10)
    parts["AirBox"] = g.make_object("AirBox", *airbox, col, m["intake"], smooth_angle=30)
    # Antennas: two whips on the cabin roof, a VHF blade behind it; pitot under the left wing.
    tip_left = Vector(WING.section(0.62, [(0.0, -0.03)])[0])
    ant = g.merge_parts([
        g.cylinder((0.12, 0.10, 0.80), (0.10, 0.50, 1.40), 0.008, 6),
        g.cylinder((-0.12, 0.10, 0.80), (-0.10, 0.50, 1.40), 0.008, 6),
        g.box(0.0, 1.55, 0.66, 0.012, 0.22, 0.20),
        g.cylinder(tip_left, tip_left + Vector((0, -0.45, -0.02)), 0.012, 8),
    ])
    parts["Antenna"] = g.make_object("Antenna", *ant, col, m["metal_dark"], smooth_angle=30)
    # Navigation lights: red left (+X), green right, white tail, red beacon on the fin.
    tip = Vector(WING.section(1.0, [(0.32, 0.0)])[0])
    g.light(col, "NavLight_L", m["nav_red"], (tip.x + 0.02, tip.y, tip.z))
    g.light(col, "NavLight_R", m["nav_green"], (-tip.x - 0.02, tip.y, tip.z))
    g.light(col, "Strobe_Tail", m["nav_white"], (0, 4.42, 0.40), 0.03)
    fin_top = Vector(FIN.section(1.0, [(0.45, 0.0)])[0])
    g.light(col, "Beacon", m["nav_red"], (0, fin_top.y, fin_top.z + 0.03), 0.04)


ATLAS = ["Fuselage", "Wing_L", "Wing_R", "Flap_L", "Flap_R", "Aileron_L", "Aileron_R", "HStab",
         "Elevator_L", "Elevator_R", "Fin", "Rudder", "Dorsal", "Spinner", "Struts"]
SUBDIVIDE = {"Fuselage", "Spinner", "Glass"}
LOD2_SKIN = ["Fuselage", "Wing_L", "Wing_R", "Flap_L", "Flap_R", "Aileron_L", "Aileron_R", "HStab",
             "Elevator_L", "Elevator_R", "Fin", "Rudder", "Dorsal", "Spinner", "Struts", "Glass"]
LOD2_KEEP = ["Gear_L", "Gear_R", "Gear_N", "PropDisc"]

# Facts for the game's type registry (game axes: x = left wing, y = up, z = nose).
META = {
    "gearHeight": -GROUND_Z,
    "eye": [0.28, 0.58, 0.80],
    "wingCam": [2.6, 0.55, 0.3],
    "hull": {"nose": [0, -0.04, 4.02], "wingL": [5.5, 0.99, 0.75], "wingR": [-5.5, 0.99, 0.75],
             "tail": [0, 1.60, -4.30]},
    "length": 8.28, "span": 11.0,
}


def livery(m):
    c = tx.Canvas(m, WHITE, 0.30)
    x, y, z, ax, nz = m.x, m.y, m.z, m.ax, m.nz
    fuse = m.part("Fuselage")
    wing = m.part("Wing_*", "Flap_*", "Aileron_*")
    tail_h = m.part("HStab", "Elevator_*")
    fin = m.part("Fin", "Rudder", "Dorsal")

    c.put(fuse & (nz < -0.55), BELLY, 0.40)
    # Sweeping red cheatline under the windows, rising towards the tail, navy pinstripe above.
    t = (y + 3.2) / 7.4
    zc = -0.14 + 0.20 * tx.smoothstep(0.35, 1.0, t)
    w = 0.075 - 0.035 * t
    side = np.abs(m.nx) > 0.25
    c.put(fuse & side & (np.abs(z - zc) < w) & (y > -3.3) & (y < 4.25), RED, 0.28)
    c.put(fuse & side & (np.abs(z - (zc + w + 0.035)) < 0.012) & (y > -3.0) & (y < 4.2), NAVY, 0.28)
    c.put(m.part("Spinner"), RED, 0.25)
    # Cowling air inlets either side of the spinner.
    inlet = fuse & (y < -3.55) & (ax > 0.13) & (ax < 0.30) & (z > -0.02) & (z < 0.14)
    c.put(inlet, (0.02, 0.02, 0.02), 0.9)
    # Window seals: dark rim around the glazing.
    rim = fuse & ~glass_mask(m, 0.0) & glass_mask(m, 0.035)
    c.put(rim, DARK, 0.6)
    # Fin: navy top with a red band, the airline logo sits on the navy.
    c.put(fin & (z > 0.95 + 0.10 * (y - 3.4)), NAVY, 0.30)
    c.put(fin & (np.abs(z - (0.90 + 0.10 * (y - 3.4))) < 0.05), RED, 0.30)
    c.put(tail_h & (ax > 1.45), RED, 0.30)
    c.put(wing & (ax > 4.95), RED, 0.30)
    # Fuel caps on top of the wing, landing light in the left leading edge.
    for sx in (1, -1):
        cap = wing & (nz > 0.5) & ((x - sx * 1.95) ** 2 + (y + 0.95) ** 2 < 0.06 ** 2)
        c.put(cap, (0.55, 0.56, 0.58), 0.25, 0.8)
    c.put(wing & (x > 2.75) & (x < 3.05) & (y < -1.22) & (np.abs(z - 0.88) < 0.04),
          (0.85, 0.88, 0.92), 0.05, 1.0)

    # Panel lines and doors.
    lines = fuse & tx.near(y, (-3.30, -2.75, -2.18, 1.40, 2.35, 3.30), 0.0045)
    door = (y > -1.27) & (y < -0.22) & (z > -0.36) & (z < 0.79) & side
    door_edge = door & ~((y > -1.26) & (y < -0.23) & (z > -0.35) & (z < 0.78))
    lines |= fuse & door_edge
    bag = (y > 0.70) & (y < 1.18) & (z > -0.12) & (z < 0.30) & (x > 0.2)
    lines |= fuse & bag & ~((y > 0.705) & (y < 1.175) & (z > -0.115) & (z < 0.295))
    lines |= wing & tx.near(ax, (1.3, 2.2, 3.1, 4.0, 4.9), 0.004)
    lines |= tail_h & tx.near(ax, (0.6, 1.2), 0.004)
    tx.paint_logo(c, fin, y, z, 3.86, 1.22, 0.36)
    c.shade(lines, 0.62)
    # Exhaust soot along the lower right cowling.
    soot = fuse & (x < 0) & (y > -2.6) & (y < 0.3) & (z < -0.2)
    s = np.exp(-np.clip(y + 2.5, 0, None) / 1.0) * tx.smoothstep(0.35, 0.0, np.abs(z + 0.45))
    c.col *= (1 - 0.45 * np.where(soot, s, 0))[..., None]
    return c


def glass_mask(m, grow):
    """Texel mask of the window regions, grown by `grow` metres (for seals)."""
    y, z, ax = m.y, m.z, m.ax
    ws = (y > -2.05 - grow) & (y < -1.33 + grow) & (z > 0.47 - grow)
    side_top = 0.74 - 0.10 * np.clip(y - 0.1, 0, None) + grow
    sw = (ax > 0.30) & (z > 0.24 - grow) & (z < side_top) & (
        ((y > -1.24 - grow) & (y < -0.27 + grow)) | ((y > -0.15 - grow) & (y < 0.50 + grow)))
    rw = (y > 0.62 - grow) & (y < 1.32 + grow) & (z > 0.47 - grow) & (ax < 0.36 + grow)
    return ws | sw | rw


def decals(col, parts):
    out = {"Fuselage": [], "Fin": [], "Wing_L": []}
    for side in (1, -1):
        ax_ = tx.side_axes(side)
        out["Fuselage"].append(tx.text_mesh(col, f"D_name_{side}", "TRAPANOTTO", 0.20,
                                            (side * 0.45, 1.85, 0.37), *ax_, NAVY))
        out["Fuselage"].append(tx.text_mesh(col, f"D_air_{side}", "AIRLINES", 0.085,
                                            (side * 0.45, 1.85, 0.215), *ax_, RED, spacing=1.9))
        out["Fuselage"].append(tx.text_mesh(col, f"D_model_{side}", "SKYHAWK", 0.075,
                                            (side * 0.55, -2.55, 0.18), *ax_, NAVY, spacing=1.3))
        out["Fin"].append(tx.text_mesh(col, f"D_reg_{side}", REG, 0.15,
                                       (side * 0.15, 3.55, 0.66), *ax_, NAVY))
        out["Fuselage"].extend(tx.swiss_flag(col, f"D_flag_{side}", 0.09,
                                             (side * 0.30, 3.10, 0.22), *ax_))
    out["Wing_L"].append(tx.text_mesh(col, "D_reg_wing", REG, 0.58, (3.0, -0.62, 0.70),
                                      (1, 0, 0), (0, -1, 0), NAVY))
    return out

