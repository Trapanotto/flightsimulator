"""
Operable controls of the PC-12 flight deck: one Ctl_<id> node and at least one Hit_<id> box
for every control of PC12_CONTROLS (src/sim/cockpitPc12.ts), placed where a pilot looks for
it. Naming and extras: see lib/cockpit_kit.py. Display windows (Disp_<ID>) the loader paints:
PFD1, MFD1, MFD2, PFD2 (the Apex displays), COM1, NAV1, COM2, NAV2, ADF, DME, XPDR (the radio
panel on the pedestal), STBY (standby instrument), GEAR (gear position lights), FGP (the flight
guidance panel's legends and mode lamps) and TRIM (trim positions).
"""

import math

import numpy as np

from lib import cockpit_kit as K
from lib import mesh as M
from . import cockpit as C

PANEL_R, OVH_R, FACE_R, TOP_R, GLARE_R = C.PANEL_R, C.OVH_R, C.FACE_R, C.TOP_R, C.GLARE_R
pp, oo, ff, tt, gg = C.pp, C.oo, C.ff, C.tt, C.gg
FACE_S = 0.012          # front of the radio face plate
TOP_S = 0.008           # top of the pedestal's lever plate
OVH_S = 0.018           # face of the overhead panel
GLARE_S = 0.014         # face of the flight guidance panel
AMBER = "#ffb54a"
CYAN = "#7fd8ff"

# Display windows: id -> (w, h) metres; the loader's atlas regions have the same shapes.
WINDOWS = {
    "COM1": (0.064, 0.0166), "NAV1": (0.064, 0.0166), "COM2": (0.064, 0.0166), "NAV2": (0.064, 0.0166),
    "ADF": (0.080, 0.015), "DME": (0.080, 0.0137), "XPDR": (0.064, 0.0117),
    "STBY": (0.080, 0.080), "GEAR": (0.040, 0.060), "FGP": (0.620, 0.058), "TRIM": (0.120, 0.045),
}


def frame_axes(frame):
    return frame[:, 0], frame[:, 1], frame[:, 2]


def label(P, text, at, h, frame, color="#e8e8e2"):
    P.label(text, at, h, frame=frame, color=color)


# ---------------------------------------------------------------------------
# Generic pieces
# ---------------------------------------------------------------------------

def toggle(P, cid, at, frame, detents=(22.0, -22.0), side=None):
    """Bat-handle toggle: turns about the frame's x axis; detents[1] = on (bat towards +y)."""
    b = P.b
    x, y, z = frame_axes(frame)
    K.static(b, "steel", K.revolve([(0, 0.0055, False), (0.0025, 0.0055, False), (0.0032, 0.004, False)], 14), at,
             frame)
    piv = P.pivot(f"Ctl_{cid}", at + z * 0.002, axis=x, props={"detents": list(detents)})
    K.attach(b, f"Ctl_{cid}_mesh", K.shared("toggle", toggle_shape, b.mats["chrome"]), piv, frame)
    P.hit(cid, at + z * 0.008, (0.0085, 0.013, 0.009), frame=frame, side=side)
    return piv


def toggle_shape():
    return M.merge([K.revolve([(0, 0.0022, False), (0.003, 0.0022, False), (0.0035, 0.0014, False)], 12),
                    M.cylinder((0, 0, 0.002), (0, 0, 0.013), 0.0013, 8),
                    K.revolve([(0.012, 0.0022, False), (0.0155, 0.0022, False), (0.0165, 0.0012, False)], 12)])


def rotary(P, cid, at, frame, detents, names, r=0.0065):
    """Selector knob with a pointer, turning about the frame's z axis to its detents."""
    b = P.b
    x, y, z = frame_axes(frame)
    piv = P.pivot(f"Ctl_{cid}", at, axis=z, props={"detents": list(detents)})
    K.attach(b, f"Ctl_{cid}_mesh", K.shared("rotary", lambda: K.chicken_head(r, 0.008), b.mats["plastic_black"]),
             piv, frame)
    P.hit(cid, at + z * 0.006, (0.011, 0.011, 0.007), frame=frame, side=0)
    for name, ang in zip(names, detents):
        a = math.radians(ang)
        # Positive detent angles are counter-clockwise as the pilot looks at the knob.
        label(P, name, at + 0.015 * (-math.sin(a) * x + math.cos(a) * y), 0.0026, frame)
    return piv


def knob(P, cid, at, frame, r=0.007, length=0.011, shape="knob", side=0, hit_r=None):
    b = P.b
    x, y, z = frame_axes(frame)
    piv = P.pivot(f"Ctl_{cid}", at, axis=z)
    K.attach(b, f"Ctl_{cid}_mesh", K.shared(f"{shape}_{r}", lambda: K.knob(r, length), b.mats["plastic_black"]),
             piv, frame)
    hr = hit_r or (r + 0.0035)
    P.hit(cid, at + z * (length / 2), (hr, hr, length / 2 + 0.003), frame=frame, side=side)
    return piv


def dual_knob(P, cid, at, frame, coarse):
    b = P.b
    x, y, z = frame_axes(frame)
    outer = P.pivot(f"Ctl_{cid}_outer", at, axis=z)
    K.attach(b, f"Ctl_{cid}_outer_mesh", K.shared("dual_outer", lambda: K.knob(0.0092, 0.005, skirt=False),
                                                  b.mats["plastic_black"]), outer, frame)
    inner = P.pivot(f"Ctl_{cid}", at, axis=z)
    K.attach(b, f"Ctl_{cid}_mesh", K.shared("dual_inner", lambda: K.knob(0.0055, 0.0068, z0=0.005, skirt=False),
                                            b.mats["plastic_black"]), inner, frame)
    P.hit(cid, at + z * 0.0085, (0.0064, 0.0064, 0.0035), frame=frame, side=0)
    P.hit(cid, at + z * 0.003, (0.0115, 0.0115, 0.004), frame=frame, side=0, step=coarse, suffix="__coarse")


def button(P, cid, at, frame, w=0.013, h=0.0075, shape="key", mat="plastic_black", travel=0.0018):
    b = P.b
    x, y, z = frame_axes(frame)
    piv = P.pivot(f"Ctl_{cid}", at, slide=-z * travel)
    K.attach(b, f"Ctl_{cid}_mesh", K.shared(f"{shape}_{w}_{h}_{mat}", lambda: K.box(0, 0, 0.003, w, h, 0.006, 0.0012, 1),
                                            b.mats[mat]), piv, frame)
    P.hit(cid, at + z * 0.004, (max(w / 2, 0.0055) + 0.001, max(h / 2, 0.0055) + 0.001, 0.005), frame=frame)
    return piv


def dummy_key(P, at, frame, w=0.011, h=0.007):
    K.static(P.b, "plastic_black", K.box(0, 0, 0.0025, w, h, 0.005, 0.0012, 1), at, frame)


def dummy_knob(P, at, frame, r=0.0055):
    K.static(P.b, "plastic_black", K.knob(r, 0.008, skirt=False), at, frame)


def pull_handle(P, cid, at, frame, mat, text, travel=0.04):
    """T-handle pulled out of the panel (extras.slide = full travel out)."""
    b = P.b
    x, y, z = frame_axes(frame)
    piv = P.pivot(f"Ctl_{cid}", at, slide=z * travel)
    K.attach(b, f"Ctl_{cid}_mesh", K.shared(f"t_handle_{mat}", lambda: K.t_handle(0.042, 0.014), b.mats[mat]), piv, frame)
    P.hit(cid, at + z * 0.02, (0.026, 0.012, 0.024), frame=frame)
    label(P, text, at + y * 0.017, 0.0034, frame)


# ---------------------------------------------------------------------------
# Overhead panel
# ---------------------------------------------------------------------------

def overhead(P):
    s = OVH_S
    rows = [
        ("POWER", 0.262, [("battery", "BAT 1", "t"), ("battery2", "BAT 2", "t"), ("generator1", "GEN 1", "t"),
                          ("generator2", "GEN 2", "t"), ("avionics", "AVIONICS", "t"),
                          ("eps", "EPS", "r3:OFF,ARM,TEST"), ("starter", "START", "b"),
                          ("ignition", "IGN", "s2:AUTO,ON"), ("inertialSeparator", "INERT SEP", "t")]),
        ("FUEL  ICE  CABIN", 0.172, [("fuelPumpLeft", "PUMP L", "s2:AUTO,ON"), ("fuelPumpRight", "PUMP R", "s2:AUTO,ON"),
                                     ("pitotHeat", "PROBES", "t"), ("propDeice", "PROP", "t"),
                                     ("windshieldHeat", "WSHLD", "t"), ("bootsDeice", "BOOTS", "r3:OFF,3,1"),
                                     ("ecs", "ECS", "t"), ("pressurisation", "PRESS", "s2:AUTO,DUMP"),
                                     ("oxygen", "OXYGEN", "t")]),
        ("LIGHTS", 0.082, [("lightBeacon", "BCN", "t"), ("lightStrobe", "STROBE", "t"), ("lightNav", "NAV", "t"),
                           ("lightLanding", "LDG", "t"), ("lightTaxi", "TAXI", "t"), ("lightRecognition", "RECOG", "t"),
                           ("lightIce", "ICE", "t"), ("lightPanel", "PANEL", "k"), ("lightCabin", "CABIN", "k")]),
    ]
    xs = [0.205, 0.155, 0.105, 0.055, 0.005, -0.050, -0.105, -0.155, -0.205]
    for title, d, items in rows:
        label(P, title, oo(0.0, d + 0.036, s), 0.0055, OVH_R, CYAN)
        for (cid, text, kind), bl in zip(items, xs):
            at = oo(bl, d, s)
            label(P, text, oo(bl, d + 0.024, s), 0.0046, OVH_R)
            if kind == "t":
                toggle(P, cid, at, OVH_R)
                label(P, "ON", oo(bl + 0.013, d + 0.011, s), 0.0030, OVH_R)
            elif kind.startswith("s2"):
                names = kind.split(":")[1].split(",")
                toggle(P, cid, at, OVH_R, side=1)
                label(P, names[1], oo(bl + 0.014, d + 0.011, s), 0.0030, OVH_R)
                label(P, names[0], oo(bl + 0.014, d - 0.011, s), 0.0030, OVH_R)
            elif kind.startswith("r3"):
                rotary(P, cid, at, OVH_R, (40.0, 0.0, -40.0), kind.split(":")[1].split(","))
            elif kind == "b":
                K.static(P.b, "steel", K.frame_plate(0.017, 0.017, 0.004, 0.002), at, OVH_R)
                button(P, cid, at, OVH_R, w=0.012, h=0.012, mat="knob_red", travel=0.0025)
            elif kind == "k":
                knob(P, cid, at, OVH_R, r=0.0065, length=0.010)
                label(P, "DIM", oo(bl + 0.013, d - 0.012, s), 0.0030, OVH_R)
                label(P, "BRT", oo(bl - 0.013, d - 0.012, s), 0.0030, OVH_R)
    # Cabin altitude selector at the front right, below the cabin group as the pilot sees it.
    knob(P, "cabinAltitude", oo(-0.205, 0.026, s), OVH_R, r=0.0075, length=0.012)
    label(P, "CABIN ALT", oo(-0.205, 0.046, s), 0.0044, OVH_R)
    label(P, "x1000 FT", oo(-0.150, 0.026, s), 0.0026, OVH_R)


# ---------------------------------------------------------------------------
# Flight guidance panel, display controllers, centre panel
# ---------------------------------------------------------------------------

def fgp(P):
    s = GLARE_S
    P.display("FGP", gg(0.0, 0.0, s + 0.0004), *WINDOWS["FGP"], frame=GLARE_R)
    keys = [("apHdg", 0.205), ("apNav", 0.165), ("apApr", 0.125), ("apEngage", 0.055), ("yawDamper", 0.015),
            ("flightDirector", -0.025), ("apAlt", -0.095), ("apVs", -0.135), ("apFlc", -0.175)]
    for cid, bl in keys:
        button(P, cid, gg(bl, -0.011, s), GLARE_R, w=0.03, h=0.012, shape="fgp_key")
    # Heading knob with the sync button in its centre.
    at = gg(0.268, -0.002, s)
    knob(P, "headingBug", at, GLARE_R, r=0.0105, length=0.012, shape="fgp_knob")
    sync = P.pivot("Ctl_headingSync", at + GLARE_R[:, 2] * 0.012, slide=-GLARE_R[:, 2] * 0.0015)
    K.attach(P.b, "Ctl_headingSync_mesh", K.shared("sync_cap", lambda: K.revolve(
        [(0, 0.0048, False), (0.0025, 0.0048, False), (0.003, 0.0035, False)], 16), P.b.mats["chrome"]), sync, GLARE_R)
    P.hit("headingSync", at + GLARE_R[:, 2] * 0.0155, (0.0052, 0.0052, 0.0028), frame=GLARE_R)
    # Pitch wheel: a thumbwheel turning about the lateral axis; upper half VS up, lower half down.
    at = gg(-0.225, -0.002, s)
    wheel = P.pivot("Ctl_apVsUp", at + GLARE_R[:, 2] * 0.004, axis=GLARE_R[:, 0])
    ribs = [M.rounded_box((0, 0.016 * math.sin(a), 0.016 * math.cos(a)), (0.012, 0.004, 0.003), 0.0, 1)
            for a in np.linspace(0, 2 * math.pi, 20, endpoint=False)]
    w = M.merge([M.lathe([(-0.006, 0.0), (-0.006, 0.0155), (0.006, 0.0155), (0.006, 0.0)], (0, 0, 0), (1, 0, 0),
                         n=24, close_start=False, close_end=False)] + ribs)
    K.attach(P.b, "Ctl_apVsUp_mesh", K.mesh_data("pitch_wheel", w, P.b.mats["plastic_black"]), wheel, np.eye(3))
    P.pivot("Ctl_apVsDown", at + GLARE_R[:, 2] * 0.004)
    P.hit("apVsUp", at + GLARE_R[:, 1] * 0.009 + GLARE_R[:, 2] * 0.012, (0.0085, 0.0085, 0.008), frame=GLARE_R)
    P.hit("apVsDown", at - GLARE_R[:, 1] * 0.009 + GLARE_R[:, 2] * 0.012, (0.0085, 0.0085, 0.008), frame=GLARE_R)
    # Altitude select: inner 100 ft, outer 1000 ft.
    dual_knob(P, "apAltitude", gg(-0.278, -0.002, s), GLARE_R, 1000)


def display_controllers(P):
    v = 0.205
    s = 0.012
    # Pilot's DC: baro (push STD), minimums, nav source, course, map range.
    at = pp(0.548, v, s)
    knob(P, "altimeterSetting", at, PANEL_R, r=0.0095, length=0.011, shape="dc_knob")
    std = P.pivot("Ctl_baroStd", at + PANEL_R[:, 2] * 0.011, slide=-PANEL_R[:, 2] * 0.0015)
    K.attach(P.b, "Ctl_baroStd_mesh", K.shared("sync_cap", lambda: K.revolve(
        [(0, 0.0048, False), (0.0025, 0.0048, False), (0.003, 0.0035, False)], 16), P.b.mats["chrome"]), std, PANEL_R)
    P.hit("baroStd", at + PANEL_R[:, 2] * 0.0145, (0.0052, 0.0052, 0.0028))
    label(P, "BARO", pp(0.548, v + 0.025, s), 0.0034, PANEL_R)
    label(P, "PUSH STD", pp(0.548, v - 0.022, s), 0.0026, PANEL_R)
    knob(P, "minimums", pp(0.492, v, s), PANEL_R, r=0.0085, length=0.011, shape="dc_knob2")
    label(P, "MINS", pp(0.492, v + 0.025, s), 0.0034, PANEL_R)
    button(P, "navSource", pp(0.440, v + 0.012, s), PANEL_R, w=0.024, h=0.009, shape="dc_key")
    label(P, "NAV SRC", pp(0.440, v + 0.026, s), 0.003, PANEL_R)
    for dv in (-0.004, -0.019):
        dummy_key(P, pp(0.440, v + dv, s), PANEL_R, w=0.024, h=0.009)
    label(P, "FMS  NAV1  NAV2", pp(0.440, v - 0.031, s), 0.0024, PANEL_R)
    knob(P, "obs1", pp(0.388, v, s), PANEL_R, r=0.0085, length=0.011, shape="dc_knob2")
    label(P, "CRS 1", pp(0.388, v + 0.025, s), 0.0034, PANEL_R)
    knob(P, "mapRange", pp(0.345, v, s), PANEL_R, r=0.0075, length=0.010, shape="dc_knob3")
    label(P, "RANGE", pp(0.345, v + 0.025, s), 0.0034, PANEL_R)
    # Copilot's DC: its own course knob; baro and minimums follow the pilot's side here.
    at2 = pp(-0.388, v, s)
    knob(P, "obs2", at2, PANEL_R, r=0.0085, length=0.011, shape="dc_knob2")
    label(P, "CRS 2", pp(-0.388, v + 0.025, s), 0.0034, PANEL_R)
    for bl in (-0.548, -0.492):
        dummy_knob(P, pp(bl, v, s), PANEL_R, 0.0085)
    label(P, "BARO", pp(-0.548, v + 0.025, s), 0.0034, PANEL_R)
    label(P, "MINS", pp(-0.492, v + 0.025, s), 0.0034, PANEL_R)
    for dv in (0.012, -0.004, -0.019):
        dummy_key(P, pp(-0.440, v + dv, s), PANEL_R, w=0.024, h=0.009)


def centre_panel(P):
    s = 0.010
    # Standby instrument (attitude, airspeed, altitude on one small display).
    P.display("STBY", pp(0.0, 0.140, s + 0.0006), *WINDOWS["STBY"])
    K.static(P.b, "plastic_black", K.frame_plate(0.088, 0.088, 0.004, 0.004), pp(0.0, 0.140, s), PANEL_R)
    dummy_knob(P, pp(0.036, 0.087, s), PANEL_R, 0.0045)
    label(P, "STBY", pp(-0.03, 0.087, s), 0.003, PANEL_R)
    # Gear handle: a wheel-shaped knob on a lever sliding down the slot with the gear down.
    s2 = 0.008
    top_v, travel = 0.225, 0.075
    K.static(P.b, "plastic_black", K.box(0, 0, 0.001, 0.009, travel + 0.024, 0.002), pp(0.215, top_v - travel / 2, s2),
             PANEL_R)
    piv = P.pivot("Ctl_gear", pp(0.215, top_v, s2), slide=-C.VV * travel)
    handle = M.merge([M.cylinder((0, 0, -0.005), (0, 0, 0.045), 0.0045, 10),
                      M.lathe([(0.040, 0.0), (0.040, 0.016), (0.052, 0.017), (0.054, 0.012), (0.054, 0.0)], (0, 0, 0),
                              (0, 0, 1.0), n=20, close_start=True, close_end=True)])
    K.attach(P.b, "Ctl_gear_mesh", K.mesh_data("gear_handle", handle, P.b.mats["placard"]), piv, PANEL_R)
    P.hit("gear", pp(0.215, top_v - travel / 2, s2 + 0.045), (0.02, travel / 2 + 0.012, 0.014), side=1)
    label(P, "UP", pp(0.248, top_v, s2), 0.0034, PANEL_R)
    label(P, "DN", pp(0.248, top_v - travel, s2), 0.0034, PANEL_R)
    label(P, "LDG GEAR", pp(0.215, top_v + 0.022, s2), 0.0036, PANEL_R)
    P.display("GEAR", pp(0.153, 0.19, s2 + 0.0006), *WINDOWS["GEAR"])
    # Parking brake and the fuel firewall shutoff under the pilot's side of the panel.
    pull_handle(P, "parkingBrake", pp(0.585, 0.045, 0.0), PANEL_R, "plastic_black", "PARK BRAKE")
    pull_handle(P, "fuelShutoff", pp(0.505, 0.045, 0.0), PANEL_R, "knob_red", "FUEL SHUTOFF")


# ---------------------------------------------------------------------------
# Pedestal: radio panel and levers
# ---------------------------------------------------------------------------

def active_hit(P, cid, at):
    P.pivot(f"Ctl_{cid}", at)
    P.hit(cid, at, (0.0165, 0.0095, 0.003), frame=FACE_R, side=0)


def radio_panel(P):
    s = FACE_S
    for n, y in ((1, 0.030), (2, 0.074)):
        P.display(f"COM{n}", ff(0.083, y, s + 0.0004), *WINDOWS[f"COM{n}"], frame=FACE_R)
        P.display(f"NAV{n}", ff(0.207, y, s + 0.0004), *WINDOWS[f"NAV{n}"], frame=FACE_R)
        dual_knob(P, f"com{n}Standby", ff(0.024, y, s), FACE_R, 1000)
        dual_knob(P, f"nav{n}Standby", ff(0.266, y, s), FACE_R, 1000)
        button(P, f"com{n}Swap", ff(0.128, y + 0.001, s), FACE_R, w=0.011, h=0.008, shape="swap")
        button(P, f"nav{n}Swap", ff(0.162, y + 0.001, s), FACE_R, w=0.011, h=0.008, shape="swap")
        active_hit(P, f"com{n}Active", ff(0.067, y, s + 0.002))
        active_hit(P, f"nav{n}Active", ff(0.191, y, s + 0.002))
        label(P, f"COM {n}", ff(0.083, y - 0.015, s), 0.003, FACE_R, CYAN)
        label(P, f"NAV {n}", ff(0.207, y - 0.015, s), 0.003, FACE_R, CYAN)
        label(P, "<->", ff(0.128, y + 0.012, s), 0.0026, FACE_R)
        label(P, "<->", ff(0.162, y + 0.012, s), 0.0026, FACE_R)
    y = 0.118
    P.display("ADF", ff(0.068, y, s + 0.0004), *WINDOWS["ADF"], frame=FACE_R)
    dual_knob(P, "adfFrequency", ff(0.130, y, s), FACE_R, 100)
    P.display("DME", ff(0.203, y, s + 0.0004), *WINDOWS["DME"], frame=FACE_R)
    toggle(P, "dmeSource", ff(0.266, y, s), FACE_R, detents=(25.0, -25.0))
    label(P, "ADF", ff(0.068, y - 0.014, s), 0.003, FACE_R, CYAN)
    label(P, "DME", ff(0.203, y - 0.014, s), 0.003, FACE_R, CYAN)
    label(P, "N2", ff(0.266, y - 0.016, s), 0.0026, FACE_R)
    label(P, "N1", ff(0.266, y + 0.016, s), 0.0026, FACE_R)
    y = 0.165
    rotary(P, "xpdrMode", ff(0.024, y, s), FACE_R, (60.0, 20.0, -20.0, -60.0), ["OFF", "SBY", "ON", "ALT"], r=0.0058)
    P.display("XPDR", ff(0.085, y, s + 0.0004), *WINDOWS["XPDR"], frame=FACE_R)
    grp = P.pivot("Ctl_xpdrCode", ff(0.173, y, s))
    for i in range(4):
        u = 0.140 + i * 0.022
        at = ff(u, y, s)
        piv = P.pivot(f"XpdrDigit_{i}", at, axis=FACE_R[:, 2])
        M.parent_keep(piv, grp)
        K.attach(P.b, f"XpdrDigit_{i}_mesh", K.shared("digit_knob", lambda: K.knob(0.0058, 0.0085, skirt=False),
                                                     P.b.mats["plastic_black"]), piv, FACE_R)
        P.hit("xpdrCode", ff(u, y, s + 0.005), (0.0085, 0.0085, 0.0055), frame=FACE_R, side=0, step=10 ** (3 - i),
              suffix="" if i == 0 else f"__d{i}")
    button(P, "xpdrIdent", ff(0.262, y, s), FACE_R, w=0.016, h=0.010, shape="ident")
    label(P, "XPDR", ff(0.085, y - 0.013, s), 0.003, FACE_R, CYAN)
    label(P, "IDENT", ff(0.262, y - 0.013, s), 0.0028, FACE_R)
    label(P, "CODE", ff(0.173, y - 0.014, s), 0.0028, FACE_R)
    label(P, "RADIO", ff(0.145, 0.205, s), 0.0034, FACE_R, CYAN)


def lever_slot(P, bl, fs0, fs1):
    K.static(P.b, "plastic_black", K.box(0, 0, 0.0005, 0.010, abs(fs1 - fs0) + 0.02, 0.001),
             C.tt(bl, 0.5 * (fs0 + fs1), TOP_S), TOP_R)


def levers(P):
    s = TOP_S
    fwd = np.array([0, -1.0, 0])
    # Power control lever: idle at the gate, forward to maximum; behind the gate beta and reverse.
    bl, idle, travel, rev = 0.072, 3.890, 0.120, 0.045
    lever_slot(P, bl, idle - travel, idle + rev)
    piv = P.pivot("Ctl_throttle", tt(bl, idle, s), slide=fwd * travel, props={"reverseShare": rev / travel})
    pcl = M.merge([M.cylinder((0, 0, -0.01), (0, 0, 0.105), 0.0075, 12),
                   M.rounded_box((0, 0.006, 0.122), (0.050, 0.046, 0.036), 0.013, 2)])
    K.attach(P.b, "Ctl_throttle_mesh", K.mesh_data("pcl", pcl, P.b.mats["plastic_black"]), piv, TOP_R)
    P.hit("throttle", tt(bl, idle - travel / 2 + rev / 2, s + 0.118), (0.026, (travel + rev) / 2 + 0.012, 0.024),
          frame=TOP_R, side=np.array([0, -1.0, 0]))
    # TOGA button on the grip's outboard side, riding with the lever.
    toga = P.pivot("Ctl_goAround", tt(bl + 0.026, idle, s + 0.122), slide=np.array([-0.0015, 0, 0]))
    K.attach(P.b, "Ctl_goAround_mesh", K.shared("toga", lambda: K.box(0, 0, 0.002, 0.012, 0.008, 0.004, 0.0015, 1),
                                                 P.b.mats["plastic_black"]), toga,
             np.column_stack([(0, -1.0, 0), (0, 0, 1.0), (1.0, 0, 0)]))
    M.parent_keep(toga, piv)
    P.hit("goAround", tt(bl + 0.034, idle - travel / 2 + rev / 2, s + 0.122), (0.0055, (travel + rev) / 2 + 0.01, 0.009),
          frame=TOP_R)
    label(P, "POWER", tt(bl, idle + rev + 0.022, s), 0.0045, TOP_R)
    label(P, "MAX", tt(bl + 0.028, idle - travel, s), 0.0034, TOP_R)
    label(P, "IDLE", tt(bl + 0.028, idle, s), 0.0034, TOP_R)
    label(P, "REV", tt(bl + 0.028, idle + rev, s), 0.0034, TOP_R, AMBER)
    # Reverse gate latch at the slot's aft end: lifted, the lever passes into beta and reverse.
    at = tt(bl, idle + rev + 0.032, s)
    gate = P.pivot("Ctl_reverse", at, axis=np.array([0, 1.0, 0]), props={"detents": [0.0, -55.0]})
    K.attach(P.b, "Ctl_reverse_mesh", K.mesh_data("rev_gate", K.box(0, 0.0, 0.006, 0.006, 0.022, 0.012, 0.002, 1),
                                                  P.b.mats["knob_red"]), gate, TOP_R)
    P.hit("reverse", at + np.array([0, 0, 0.008]), (0.0065, 0.013, 0.009), frame=TOP_R)
    label(P, "REV GATE", tt(bl, idle + rev + 0.055, s), 0.0028, TOP_R)
    # Manual override lever (not connected): red and white, guarded.
    K.static(P.b, "knob_red", M.merge([M.cylinder((0, 0, 0), (0, 0, 0.05), 0.004, 8),
                                       M.rounded_box((0, 0, 0.055), (0.012, 0.03, 0.018), 0.004, 1)]),
             tt(0.128, 3.90, s), TOP_R)
    label(P, "MOR", tt(0.128, 3.93, s), 0.0034, TOP_R)
    # Condition lever: cut-off/feather aft, ground idle, flight idle forward.
    bl, cut, travel = -0.004, 3.945, 0.140
    lever_slot(P, bl, cut - travel, cut)
    piv = P.pivot("Ctl_condition", tt(bl, cut, s), slide=fwd * travel)
    cl = M.merge([M.cylinder((0, 0, -0.01), (0, 0, 0.085), 0.006, 10),
                  K.revolve([(0.075, 0.014, True), (0.100, 0.014, True), (0.104, 0.010, False)], 18, knurl=0.06)])
    K.attach(P.b, "Ctl_condition_mesh", K.mesh_data("condition", cl, P.b.mats["steel"]), piv, TOP_R)
    P.hit("condition", tt(bl, cut - travel / 2, s + 0.09), (0.018, travel / 2 + 0.012, 0.018), frame=TOP_R,
          side=np.array([0, -1.0, 0]), extra={"lever": 1})
    for i, text in enumerate(("CUT OFF", "GND IDLE", "FLT IDLE")):
        label(P, text, tt(bl - 0.026, cut - travel * i / 2, s), 0.0028, TOP_R)
    label(P, "CONDITION", tt(bl, cut + 0.022, s), 0.0038, TOP_R)
    # Flap lever: 0 forward, 15, 30, 40 aft.
    bl, up, travel = -0.088, 3.80, 0.165
    lever_slot(P, bl, up, up + travel)
    piv = P.pivot("Ctl_flaps", tt(bl, up, s), slide=-fwd * travel)
    fl = M.merge([M.cylinder((0, 0, -0.01), (0, 0, 0.07), 0.0055, 8),
                  M.rounded_box((0, 0, 0.078), (0.046, 0.022, 0.016), 0.007, 2)])
    K.attach(P.b, "Ctl_flaps_mesh", K.mesh_data("flap_handle", fl, P.b.mats["placard"]), piv, TOP_R)
    P.hit("flaps", tt(bl, up + travel / 2, s + 0.078), (0.024, travel / 2 + 0.012, 0.014), frame=TOP_R,
          side=np.array([0, 1.0, 0]), extra={"lever": 1})
    for i, text in enumerate(("0", "15", "30", "40")):
        label(P, text, tt(bl - 0.026, up + travel * i / 3, s), 0.0036, TOP_R)
    label(P, "FLAPS", tt(bl, up - 0.022, s), 0.0038, TOP_R)
    # Trims: pitch thumbwheel, aileron and rudder knobs, and their position window.
    at = tt(0.090, 4.22, s)
    wheel = P.pivot("Ctl_trim", at + np.array([0, 0, 0.012]), axis=np.array([1.0, 0, 0]))
    ribs = [M.rounded_box((0, 0.034 * math.sin(a), 0.034 * math.cos(a)), (0.016, 0.006, 0.005), 0.0, 1)
            for a in np.linspace(0, 2 * math.pi, 24, endpoint=False)]
    w = M.merge([M.lathe([(-0.008, 0.0), (-0.008, 0.033), (0.008, 0.033), (0.008, 0.0)], (0, 0, 0), (1, 0, 0), n=28,
                         close_start=False, close_end=False)] + ribs)
    K.attach(P.b, "Ctl_trim_mesh", K.mesh_data("trim_wheel", w, P.b.mats["plastic_black"]), wheel, np.eye(3))
    P.hit("trim", at + np.array([0, 0, 0.022]), (0.012, 0.03, 0.02), frame=np.eye(3), side=np.array([0, 1.0, 0]))
    label(P, "NOSE DN", tt(0.090, 4.165, s), 0.003, TOP_R)
    label(P, "NOSE UP", tt(0.090, 4.275, s), 0.003, TOP_R)
    knob(P, "aileronTrim", tt(-0.01, 4.26, s), TOP_R, r=0.009, length=0.014, shape="trim_knob")
    knob(P, "rudderTrim", tt(-0.085, 4.26, s), TOP_R, r=0.009, length=0.014, shape="trim_knob")
    label(P, "AIL TRIM", tt(-0.01, 4.285, s), 0.003, TOP_R)
    label(P, "RUD TRIM", tt(-0.085, 4.285, s), 0.003, TOP_R)
    label(P, "L", tt(0.004, 4.26, s), 0.003, TOP_R)
    label(P, "R", tt(-0.024, 4.26, s), 0.003, TOP_R)
    P.display("TRIM", tt(-0.02, 4.175, s + 0.0006), *WINDOWS["TRIM"], frame=TOP_R)


def yoke_buttons(P):
    hub = P.b.parts["YokeHub_L"]
    roll = P.b.parts["YokeRoll_L"]
    at = hub + np.array([0.158, 0.035, 0.108])
    frame = np.column_stack([(-1.0, 0, 0), (0, -1.0, 0), (0, 0, 1.0)])
    piv = P.pivot("Ctl_apDisconnect", at, slide=np.array([0, 0, -0.002]))
    K.attach(P.b, "Ctl_apDisconnect_mesh", K.mesh_data("ap_disc", K.revolve(
        [(0, 0.0075, False), (0.004, 0.0075, False), (0.0055, 0.006, False)], 16), P.b.mats["knob_red"]), piv, frame)
    M.parent_keep(piv, roll)
    P.hit("apDisconnect", at + np.array([0, 0, 0.006]), (0.0095, 0.0095, 0.0075), frame=frame)


def build(b):
    P = K.Placer(b, PANEL_R, label_cols=10, label_rows=24)
    overhead(P)
    fgp(P)
    display_controllers(P)
    centre_panel(P)
    radio_panel(P)
    levers(P)
    yoke_buttons(P)
    for did, bl in C.DISPLAYS.items():
        P.display(did, C.pp(bl, C.DISPLAY_V, 0.0168), *C.SCREEN)
    P.flush_labels()
    return P
