"""
Operable controls of the F/A-18C front office: one Ctl_<id> node and at least one Hit_<id> box
for every control of FA18_CONTROLS (src/sim/cockpitFa18.ts), placed where a Hornet pilot looks
for it. Naming and extras: see lib/cockpit_kit.py.

Display windows (Disp_<ID>) the loader paints: DDI_L, DDI_R, MPCD (the three displays), HUD
(the head-up display's symbol plane) and the small windows of the panel atlas: UFC_SP
(scratchpad), UFC_OPT (the five option windows), UFC_C1, UFC_C2 (COMM channels), IFEI, STBY_ASI,
STBY_ALT, STBY_ADI, STBY_VSI, RADALT, CAUTION, AOA (indexer), MC (master caution), GEAR, HOOK,
NAV, IFF.
"""

import math

import numpy as np

from lib import cockpit_kit as K
from lib import mesh as M
from . import cockpit as C
from . import dims as D

PANEL_R, CON_R = C.PANEL_R, C.CON_R
pp, cl = C.pp, C.cl
GREEN = "#7dffa0"
YELLOW = "#ffd84a"

# Window sizes (w, h) in metres; the loader's atlas regions have the same shapes.
WINDOWS = {
    "UFC_SP": (0.12, 0.02), "UFC_OPT": (0.05, 0.08), "UFC_C1": (0.03, 0.014), "UFC_C2": (0.03, 0.014),
    "IFEI": (0.112, 0.08), "STBY_ASI": (0.06, 0.06), "STBY_ALT": (0.06, 0.06), "STBY_ADI": (0.06, 0.06),
    "STBY_VSI": (0.06, 0.06), "RADALT": (0.06, 0.06), "CAUTION": (0.08, 0.10), "AOA": (0.025, 0.05),
    "MC": (0.034, 0.02), "GEAR": (0.05, 0.05), "HOOK": (0.03, 0.015), "NAV": (0.06, 0.014), "IFF": (0.06, 0.014),
}


def label(P, text, at, h, frame, color="#e8e8e2"):
    P.label(text, at, h, frame=frame, color=color)


def axes(frame):
    return frame[:, 0], frame[:, 1], frame[:, 2]


# ---------------------------------------------------------------------------
# Generic pieces (the same kinds as on the other types)
# ---------------------------------------------------------------------------

def toggle_shape():
    return M.merge([K.revolve([(0, 0.0022, False), (0.003, 0.0022, False), (0.0035, 0.0014, False)], 12),
                    M.cylinder((0, 0, 0.002), (0, 0, 0.013), 0.0013, 8),
                    K.revolve([(0.012, 0.0022, False), (0.0155, 0.0022, False), (0.0165, 0.0012, False)], 12)])


def toggle(P, cid, at, frame, detents=(22.0, -22.0), side=None, axis=0, guard=False):
    """Bat toggle turning about the frame's x axis (axis=0) or y axis (axis=1) to its detents."""
    b = P.b
    x, y, z = axes(frame)
    K.static(b, "steel", K.revolve([(0, 0.0055, False), (0.0025, 0.0055, False), (0.0032, 0.004, False)], 14), at,
             frame)
    piv = P.pivot(f"Ctl_{cid}", at + z * 0.002, axis=frame[:, axis], props={"detents": list(detents)})
    K.attach(b, f"Ctl_{cid}_mesh", K.shared("toggle", toggle_shape, b.mats["chrome"]), piv, frame)
    P.hit(cid, at + z * 0.008, (0.0085, 0.013, 0.009), frame=frame, side=side)
    if guard:
        K.static(b, "knob_red", K.box(0, 0.0, 0.009, 0.018, 0.004, 0.018, 0.001, 1), at - y * 0.012, frame)
    return piv


def rotary(P, cid, at, frame, detents, names, r=0.0062, lab_r=0.014):
    b = P.b
    x, y, z = axes(frame)
    piv = P.pivot(f"Ctl_{cid}", at, axis=z, props={"detents": list(detents)})
    K.attach(b, f"Ctl_{cid}_mesh", K.shared(f"rotary_{r}", lambda: K.chicken_head(r, 0.008), b.mats["plastic_black"]),
             piv, frame)
    P.hit(cid, at + z * 0.006, (r + 0.004, r + 0.004, 0.007), frame=frame, side=0)
    for name, ang in zip(names, detents):
        a = math.radians(ang)
        label(P, name, at + lab_r * (-math.sin(a) * x + math.cos(a) * y), 0.0022, frame)
    return piv


def knob(P, cid, at, frame, r=0.0065, length=0.010, shape="knob"):
    b = P.b
    x, y, z = axes(frame)
    piv = P.pivot(f"Ctl_{cid}", at, axis=z)
    K.attach(b, f"Ctl_{cid}_mesh", K.shared(f"{shape}_{r}", lambda: K.knob(r, length), b.mats["plastic_black"]),
             piv, frame)
    hr = r + 0.0035
    P.hit(cid, at + z * (length / 2), (hr, hr, length / 2 + 0.003), frame=frame, side=0)
    return piv


def button(P, cid, at, frame, w=0.013, h=0.0075, mat="plastic_black", travel=0.0018, depth=0.006):
    b = P.b
    x, y, z = axes(frame)
    piv = P.pivot(f"Ctl_{cid}", at, slide=-z * travel)
    K.attach(b, f"Ctl_{cid}_mesh", K.shared(f"key_{w}_{h}_{mat}_{depth}",
                                            lambda: K.box(0, 0, depth / 2, w, h, depth, 0.0012, 1), b.mats[mat]),
             piv, frame)
    P.hit(cid, at + z * 0.004, (max(w / 2, 0.0055) + 0.001, max(h / 2, 0.0055) + 0.001, 0.005), frame=frame)
    return piv


def dummy_key(P, at, frame, w=0.016, h=0.014, mat="plastic_black"):
    K.static(P.b, mat, K.box(0, 0, 0.003, w, h, 0.006, 0.0015, 1), at, frame)


def window(P, did, at, frame, lift=0.0004):
    P.display(did, at + frame[:, 2] * lift, *WINDOWS[did], frame=frame)


# ---------------------------------------------------------------------------
# Main panel: UFC, displays with their push buttons and knobs, standby group
# ---------------------------------------------------------------------------

def ufc(P):
    s = C.UFC_S
    o = pp(0.0, 0.445, s)
    x, y, z = axes(PANEL_R)

    def u(cx, cy, dz=0.0):
        return o + x * cx + y * cy + z * dz

    window(P, "UFC_SP", u(-0.005, 0.065), PANEL_R)
    keys = [("apEngage", "A/P"), (None, "IFF"), (None, "TCN"), ("ilsOn", "ILS"), (None, "D/L"), (None, "BCN"),
            (None, "ON/OFF")]
    for i, (cid, text) in enumerate(keys):
        at = u(-0.075 + 0.025 * i, 0.040)
        if cid == "ilsOn":
            button(P, cid, at, PANEL_R, w=0.02, h=0.012, travel=0.0015)
        elif cid:
            button(P, cid, at, PANEL_R, w=0.02, h=0.012)
        elif text == "IFF":
            # The IFF key sends the identification pulse.
            button(P, "xpdrIdent", at, PANEL_R, w=0.02, h=0.012)
        else:
            dummy_key(P, at, PANEL_R, 0.02, 0.012)
        label(P, text, u(-0.075 + 0.025 * i, 0.0405, 0.0065), 0.0028, PANEL_R)
    pad = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "CLR", "0", "ENT"]
    for i, text in enumerate(pad):
        cx, cy = -0.07 + 0.022 * (i % 3), 0.014 - 0.020 * (i // 3)
        dummy_key(P, u(cx, cy), PANEL_R, 0.018, 0.015)
        label(P, text, u(cx, cy, 0.0065), 0.0034, PANEL_R)
    window(P, "UFC_OPT", u(0.044, -0.016), PANEL_R)
    for i, cid in enumerate(("apAttitude", "apHdg", "apAlt", "apRadarAlt", "apNav")):
        button(P, cid, u(0.007, 0.016 - 0.016 * i), PANEL_R, w=0.012, h=0.011)
    # COMM channels: window, knob, and a swap key each.
    for n, sx in ((1, -1), (2, 1)):
        window(P, f"UFC_C{n}", u(sx * 0.040, -0.068), PANEL_R)
        P.pivot(f"Ctl_com{n}Active", u(sx * 0.040, -0.068))
        P.hit(f"com{n}Active", u(sx * 0.040, -0.068, 0.002), (0.016, 0.009, 0.004), side=0)
        knob(P, f"com{n}Standby", u(sx * 0.072, -0.068), PANEL_R, r=0.009, length=0.012, shape="comm")
        button(P, f"com{n}Swap", u(sx * 0.012, -0.068), PANEL_R, w=0.012, h=0.010)
        label(P, f"COMM {n}", u(sx * 0.072, -0.052), 0.003, PANEL_R)
    label(P, "UFC", u(-0.07, 0.074), 0.003, PANEL_R)
    # HUD controls under the UFC: brightness and the altitude source.
    knob(P, "hudBrightness", pp(0.045, 0.31, 0.0), PANEL_R, r=0.0075, length=0.011, shape="hudknob")
    label(P, "HUD BRT", pp(0.045, 0.335), 0.003, PANEL_R)
    toggle(P, "hudAltitude", pp(-0.045, 0.31), PANEL_R, detents=(-22.0, 22.0))
    label(P, "ALT", pp(-0.045, 0.338), 0.003, PANEL_R)
    label(P, "BARO", pp(-0.075, 0.322), 0.0026, PANEL_R)
    label(P, "RDR", pp(-0.075, 0.298), 0.0026, PANEL_R)


def osb_ring(P, bl, v, s=0.018):
    """The twenty push buttons round a display, as dummies (the pages draw their legends)."""
    for k in range(5):
        d = (k - 2) * 0.022
        for at in (pp(bl + d, v + 0.077, s), pp(bl + d, v - 0.077, s), pp(bl + 0.077, v + d, s),
                   pp(bl - 0.077, v + d, s)):
            dummy_key(P, at, PANEL_R, 0.011, 0.009)


def displays(P):
    s = 0.0184
    for did, (bl, v) in C.DISPLAY_SPOTS.items():
        P.display(did, pp(bl, v, s), C.DISPLAY_SIZE, C.DISPLAY_SIZE)
        osb_ring(P, bl, v)
    # Mode knobs at the lower left corner of each DDI (the page), and the MPCD's corner controls.
    for cid, (bl, v), text in (("ddiLeftPage", C.DISPLAY_SPOTS["DDI_L"], "MODE"),
                               ("ddiRightPage", C.DISPLAY_SPOTS["DDI_R"], "MODE")):
        names = ["OFF", "HSI", "FCS", "ENG", "ADI", "CK", "FUEL"]
        rotary(P, cid, pp(bl + 0.074, v - 0.074, s), PANEL_R, [-75 + 25 * i for i in range(7)], names, r=0.0068)
    bl, v = C.DISPLAY_SPOTS["MPCD"]
    rotary(P, "mpcdPage", pp(bl + 0.074, v - 0.074, s), PANEL_R, [-45, -15, 15, 45], ["OFF", "HSI", "FUEL", "ENG"],
           r=0.0068)
    knob(P, "mapRange", pp(bl - 0.074, v - 0.074, s), PANEL_R, r=0.0068, shape="mpcdknob")
    label(P, "RNG", pp(bl - 0.074, v - 0.090, s), 0.0026, PANEL_R)
    knob(P, "headingBug", pp(bl + 0.074, v + 0.074, s), PANEL_R, r=0.0068, shape="mpcdknob")
    label(P, "HDG", pp(bl + 0.074, v + 0.090, s), 0.0026, PANEL_R)
    knob(P, "obs1", pp(bl - 0.074, v + 0.074, s), PANEL_R, r=0.0068, shape="mpcdknob")
    label(P, "CRS", pp(bl - 0.074, v + 0.090, s), 0.0026, PANEL_R)
    # Fuel and engine indicator under the left DDI.
    window(P, "IFEI", pp(0.165, 0.10, 0.012), PANEL_R)
    label(P, "IFEI", pp(0.165, 0.152, 0.012), 0.003, PANEL_R)
    knob(P, "bingo", pp(0.238, 0.035, 0.012), PANEL_R, r=0.0055, length=0.009, shape="bingo")
    label(P, "BINGO", pp(0.205, 0.035, 0.012), 0.0026, PANEL_R)
    # Standby instruments: airspeed, altimeter, attitude, vertical speed.
    s2 = 0.008
    for did, bl2, v2 in (("STBY_ASI", -0.125, 0.175), ("STBY_ALT", -0.205, 0.175), ("STBY_ADI", -0.125, 0.085),
                         ("STBY_VSI", -0.205, 0.085)):
        K.static(P.b, "plastic_black", K.frame_plate(0.068, 0.068, 0.004, 0.004), pp(bl2, v2, s2), PANEL_R)
        window(P, did, pp(bl2, v2, s2), PANEL_R)
    knob(P, "altimeterSetting", pp(-0.247, 0.135, s2), PANEL_R, r=0.0055, length=0.009, shape="baro")
    # Master arm panel and the master caution light above the left DDI.
    toggle(P, "masterArm", pp(0.215, 0.47), PANEL_R, detents=(22.0, -22.0), guard=True)
    label(P, "MASTER ARM", pp(0.215, 0.50), 0.003, PANEL_R)
    label(P, "ARM", pp(0.235, 0.483), 0.0024, PANEL_R)
    label(P, "SAFE", pp(0.235, 0.455), 0.0024, PANEL_R)
    button(P, "masterCaution", pp(0.145, 0.475), PANEL_R, w=0.036, h=0.022, travel=0.0015, depth=0.005)
    window(P, "MC", pp(0.145, 0.475, 0.0055), PANEL_R, lift=0.0002)
    label(P, "MASTER CAUTION", pp(0.145, 0.497), 0.0026, PANEL_R)


# ---------------------------------------------------------------------------
# Panel wings: gear and landing panel on the left, hook and radar altimeter on the right
# ---------------------------------------------------------------------------

def left_wing(P):
    R = C.WL_R
    w = lambda u, v, s=0.0: C.wing_point(1, u, v, s)  # noqa: E731
    x, y, z = axes(R)
    # Gear handle: a wheel-shaped knob on a lever sliding down its slot.
    top, travel = 0.36, 0.09
    K.static(P.b, "plastic_black", K.box(0, 0, 0.001, 0.010, travel + 0.03, 0.002), w(0.06, top - travel / 2), R)
    piv = P.pivot("Ctl_gear", w(0.06, top, 0.004), slide=-y * travel)
    handle = M.merge([M.cylinder((0, 0, -0.005), (0, 0, 0.05), 0.005, 10),
                      M.lathe([(0.045, 0.0), (0.045, 0.018), (0.058, 0.019), (0.060, 0.013), (0.060, 0.0)],
                              (0, 0, 0), (0, 0, 1.0), n=20, close_start=True, close_end=True)])
    K.attach(P.b, "Ctl_gear_mesh", K.mesh_data("gear_handle", handle, P.b.mats["placard"]), piv, R)
    P.hit("gear", w(0.06, top - travel / 2, 0.05), (0.022, travel / 2 + 0.014, 0.016), frame=R, side=1)
    label(P, "UP", w(0.025, top), 0.0034, R)
    label(P, "DN", w(0.025, top - travel), 0.0034, R)
    label(P, "LDG GEAR", w(0.06, top + 0.03), 0.0034, R)
    window(P, "GEAR", w(0.15, 0.36), R)
    # Flaps, launch bar, anti-skid, spin recovery, landing light, G-limiter override.
    toggle(P, "flaps", w(0.15, 0.26), R, detents=(-25.0, 0.0, 25.0), side=-R[:, 1])
    label(P, "FLAP", w(0.15, 0.285), 0.003, R)
    for t, dv in (("AUTO", 0.012), ("HALF", 0.0), ("FULL", -0.012)):
        label(P, t, w(0.178, 0.26 + dv), 0.0022, R)
    for cid, u, text, guard in (("launchBar", 0.05, "LAUNCH BAR", False), ("antiSkid", 0.105, "ANTI SKID", False),
                                ("spinRecovery", 0.16, "SPIN", True)):
        toggle(P, cid, w(u, 0.17), R, guard=guard)
        label(P, text, w(u, 0.195), 0.0024, R)
    toggle(P, "lightLanding", w(0.05, 0.08), R, detents=(-25.0, 0.0, 25.0), side=-R[:, 1])
    label(P, "LDG/TAXI", w(0.05, 0.105), 0.0024, R)
    for t, dv in (("OFF", 0.012), ("TAXI", 0.0), ("LDG", -0.012)):
        label(P, t, w(0.075, 0.08 + dv), 0.0022, R)
    button(P, "gLimiterOverride", w(0.11, 0.08), R, w=0.012, h=0.012, mat="knob_red")
    label(P, "G-LIM OVRD", w(0.11, 0.10), 0.0022, R)
    # Emergency and parking brake handle.
    piv = P.pivot("Ctl_parkingBrake", w(0.165, 0.07), slide=z * 0.045)
    K.attach(P.b, "Ctl_parkingBrake_mesh", K.shared("brake_handle", lambda: K.t_handle(0.05, 0.016),
                                                    P.b.mats["plastic_black"]), piv, R)
    P.hit("parkingBrake", w(0.165, 0.07, 0.022), (0.03, 0.012, 0.024), frame=R)
    label(P, "EMERG/PARK BRAKE", w(0.165, 0.095), 0.0024, R)


def right_wing(P):
    R = C.WR_R
    w = lambda u, v, s=0.0: C.wing_point(-1, u, v, s)  # noqa: E731
    x, y, z = axes(R)
    window(P, "CAUTION", w(0.10, 0.36), R)
    window(P, "RADALT", w(0.055, 0.22), R)
    knob(P, "minimums", w(0.055, 0.18), R, r=0.0055, length=0.009, shape="radalt")
    label(P, "RADAR ALT", w(0.055, 0.257), 0.0026, R)
    # Hook handle: slides down to lower the hook; its light beside it.
    top, travel = 0.24, 0.07
    K.static(P.b, "plastic_black", K.box(0, 0, 0.001, 0.010, travel + 0.03, 0.002), w(0.15, top - travel / 2), R)
    piv = P.pivot("Ctl_hook", w(0.15, top, 0.004), slide=-y * travel)
    hk = M.merge([M.cylinder((0, 0, -0.005), (0, 0, 0.04), 0.005, 10),
                  M.rounded_box((0, -0.005, 0.045), (0.034, 0.022, 0.014), 0.005, 1)])
    K.attach(P.b, "Ctl_hook_mesh", K.mesh_data("hook_handle", hk, P.b.mats["plastic_black"]), piv, R)
    P.hit("hook", w(0.15, top - travel / 2, 0.042), (0.02, travel / 2 + 0.012, 0.014), frame=R, side=1)
    window(P, "HOOK", w(0.15, top + 0.03), R)
    label(P, "HOOK", w(0.15, top + 0.05), 0.003, R)
    rotary(P, "navSource", w(0.055, 0.09), R, [-35, 0, 35], ["NAV", "GPS", "TCN"], r=0.0062)
    label(P, "NAV SRC", w(0.055, 0.115), 0.0026, R)
    knob(P, "tacanChannel", w(0.14, 0.09), R, r=0.0065, shape="tacan")
    label(P, "TACAN CH", w(0.14, 0.115), 0.0026, R)


def glareshield(P):
    """The angle-of-attack indexer left of the HUD, facing the pilot."""
    n = np.array([0.0, 1.0, 0.25])
    n /= np.linalg.norm(n)
    up = np.array([0, -0.25, 1.0])
    up /= np.linalg.norm(up)
    R = np.column_stack([np.cross(up, n), up, n])
    at = np.array([0.165, 3.82, 2.70])
    K.static(P.b, "plastic_black", K.box(0, 0, 0.006, 0.04, 0.068, 0.012, 0.004, 1), at, R)
    window(P, "AOA", at + R[:, 2] * 0.012, R)


# ---------------------------------------------------------------------------
# Consoles
# ---------------------------------------------------------------------------

def left_console(P):
    R = CON_R
    s = 0.006
    # Fuel panel (forward).
    toggle(P, "probeAir", cl(0.40, 4.11, s), R, detents=(22.0, -22.0))
    label(P, "PROBE", cl(0.40, 4.085, s), 0.0028, R)
    toggle(P, "fuelDump", cl(0.345, 4.11, s), R, guard=True)
    label(P, "DUMP", cl(0.345, 4.085, s), 0.0028, R)
    toggle(P, "oxygen", cl(0.29, 4.11, s), R)
    label(P, "OBOGS", cl(0.29, 4.085, s), 0.0028, R)
    label(P, "FUEL", cl(0.345, 4.215, s), 0.0036, R, GREEN)
    # Throttles: idle aft, military at 0.75 of the travel, afterburner beyond the detent.
    idle, travel = 4.64, 0.25
    fwd = np.array([0, -1.0, 0])
    K.static(P.b, "plastic_black", K.box(0, 0, 0.0005, 0.085, travel + 0.03, 0.001), cl(0.36, idle - travel / 2, s), R)
    K.static(P.b, "steel", K.box(0, 0, 0.004, 0.09, 0.006, 0.008), cl(0.36, idle - 0.75 * travel - 0.02, s), R)
    for cid, bl, n in (("throttle1", 0.385, 1), ("throttle2", 0.335, 2)):
        piv = P.pivot(f"Ctl_{cid}", cl(bl, idle, s), slide=fwd * travel)
        grip = M.merge([M.rounded_box((0, 0, 0.05), (0.012, 0.03, 0.10), 0.005, 1),
                        M.rounded_box((n == 1 and 0.004 or -0.004, 0.0, 0.112), (0.034, 0.075, 0.04), 0.012, 2)])
        K.attach(P.b, f"Ctl_{cid}_mesh", K.mesh_data(f"throttle_grip_{n}", grip, P.b.mats["plastic_black"]), piv, R)
        P.hit(cid, cl(bl, idle - travel / 2 - 0.01, s + 0.125), (0.012, travel / 2 + 0.03, 0.012), frame=R,
              side=np.array([0, -1.0, 0]), extra={"lever": 1})
        # Finger lift under the grip's front: lifted, the throttle passes to OFF.
        lift = P.pivot(f"Ctl_fuelCutoff{n}", cl(bl, idle - 0.04, s + 0.075), axis=R[:, 0], props={"detents": [0.0, -30.0]})
        K.attach(P.b, f"Ctl_fuelCutoff{n}_mesh", K.shared("finger_lift", lambda: K.box(0, 0.0, 0.0, 0.016, 0.006, 0.02,
                                                                                         0.002, 1),
                                                              P.b.mats["chrome"]), lift, R)
        M.parent_keep(lift, piv)
        # The OFF stop behind idle: the finger lift is clicked there (it rides on the grip).
        P.hit(f"fuelCutoff{n}", cl(bl, idle + 0.05, s + 0.03), (0.012, 0.022, 0.03), frame=R)
    # Speed brake switch on the outboard grip, the autothrottle (ATC) button on the inboard one.
    sb = P.pivot("Ctl_speedbrake", cl(0.404, idle, s + 0.115), axis=np.array([0, 1.0, 0]), props={"detents": [-18.0, 18.0]})
    K.attach(P.b, "Ctl_speedbrake_mesh", K.shared("sb_switch", lambda: K.box(0, 0, 0.003, 0.006, 0.012, 0.006, 0.002, 1),
                                                  P.b.mats["chrome"]),
             sb, np.column_stack([(0, -1.0, 0), (0, 0, 1.0), (1.0, 0, 0)]))
    M.parent_keep(sb, P.b.objects_by_name["Ctl_throttle1"])
    P.hit("speedbrake", cl(0.41, idle - travel / 2, s + 0.125), (0.007, travel / 2 + 0.03, 0.01), frame=R)
    atc = P.pivot("Ctl_athr", cl(0.335, idle - 0.02, s + 0.133), slide=np.array([0, 0, -0.0015]))
    K.attach(P.b, "Ctl_athr_mesh", K.shared("atc_btn", lambda: K.revolve([(0, 0.004, False), (0.003, 0.004, False),
                                                                           (0.0035, 0.003, False)], 12),
                                            P.b.mats["chrome"]),
             atc, R)
    M.parent_keep(atc, P.b.objects_by_name["Ctl_throttle2"])
    P.hit("athr", cl(0.335, idle - travel / 2 - 0.02, s + 0.142), (0.008, travel / 2 + 0.03, 0.008), frame=R)
    label(P, "IDLE", cl(0.425, idle, s), 0.003, R)
    label(P, "OFF", cl(0.425, idle + 0.05, s), 0.003, R)
    label(P, "MIL", cl(0.425, idle - 0.75 * travel, s), 0.003, R)
    label(P, "MAX", cl(0.425, idle - travel, s), 0.003, R)
    # APU and engine crank; FCS reset and take-off trim.
    toggle(P, "apu", cl(0.40, 4.79, s), R)
    label(P, "APU", cl(0.40, 4.765, s), 0.0028, R)
    toggle(P, "engineCrank", cl(0.335, 4.79, s), R, detents=(25.0, 0.0, -25.0), side=0, axis=1)
    label(P, "ENG CRANK", cl(0.335, 4.765, s), 0.0028, R)
    label(P, "L", cl(0.36, 4.80, s), 0.0026, R)
    label(P, "R", cl(0.31, 4.80, s), 0.0026, R)
    button(P, "fcsReset", cl(0.40, 4.90, s), R, w=0.014, h=0.010)
    label(P, "FCS RESET", cl(0.40, 4.92, s), 0.0024, R)
    button(P, "takeoffTrim", cl(0.335, 4.90, s), R, w=0.014, h=0.010)
    label(P, "T/O TRIM", cl(0.335, 4.92, s), 0.0024, R)
    # Exterior lights.
    toggle(P, "lightNav", cl(0.40, 5.07, s), R)
    label(P, "POSITION", cl(0.40, 5.045, s), 0.0026, R)
    toggle(P, "lightStrobe", cl(0.345, 5.07, s), R)
    label(P, "STROBE", cl(0.345, 5.045, s), 0.0026, R)
    knob(P, "lightFormation", cl(0.37, 5.18, s), R, r=0.0065, shape="lightknob")
    label(P, "FORMATION", cl(0.37, 5.155, s), 0.0026, R)
    label(P, "EXT LT", cl(0.29, 5.20, s), 0.0032, R, GREEN)


def right_console(P):
    R = CON_R
    s = 0.006
    toggle(P, "battery", cl(-0.30, 4.12, s), R, detents=(0.0, -25.0, 25.0))
    label(P, "BATT", cl(-0.30, 4.095, s), 0.0028, R)
    toggle(P, "generatorLeft", cl(-0.355, 4.12, s), R)
    label(P, "L GEN", cl(-0.355, 4.095, s), 0.0028, R)
    toggle(P, "generatorRight", cl(-0.41, 4.12, s), R)
    label(P, "R GEN", cl(-0.41, 4.095, s), 0.0028, R)
    label(P, "ELEC", cl(-0.355, 4.22, s), 0.0036, R, GREEN)
    rotary(P, "cabinPressure", cl(-0.31, 4.40, s), R, [-35, 0, 35], ["NORM", "DUMP", "RAM"])
    label(P, "CABIN PRESS", cl(-0.31, 4.375, s), 0.0026, R)
    toggle(P, "pitotHeat", cl(-0.385, 4.40, s), R)
    label(P, "PITOT HT", cl(-0.385, 4.375, s), 0.0026, R)
    toggle(P, "engineAntiIce", cl(-0.385, 4.48, s), R)
    label(P, "ENG ANTI-ICE", cl(-0.385, 4.455, s), 0.0026, R)
    # NAV radio: the window with the active frequency, standby knob and swap key.
    window(P, "NAV", cl(-0.35, 4.62, s), R)
    P.pivot("Ctl_nav1Active", cl(-0.35, 4.62, s))
    P.hit("nav1Active", cl(-0.35, 4.62, s + 0.002), (0.03, 0.009, 0.004), frame=R, side=0)
    knob(P, "nav1Standby", cl(-0.32, 4.66, s), R, r=0.0075, shape="navknob")
    button(P, "nav1Swap", cl(-0.39, 4.66, s), R, w=0.012, h=0.010)
    label(P, "NAV", cl(-0.35, 4.60, s), 0.0028, R)
    # IFF: mode selector, code digits.
    window(P, "IFF", cl(-0.36, 4.76, s), R)
    rotary(P, "xpdrMode", cl(-0.29, 4.82, s), R, [-60, -20, 20, 60], ["OFF", "STBY", "NORM", "ALT"], r=0.0058)
    grp = P.pivot("Ctl_xpdrCode", cl(-0.375, 4.84, s))
    for i in range(4):
        at = cl(-0.335 - i * 0.022, 4.84, s)
        piv = P.pivot(f"XpdrDigit_{i}", at, axis=R[:, 2])
        M.parent_keep(piv, grp)
        K.attach(P.b, f"XpdrDigit_{i}_mesh", K.shared("digit_knob", lambda: K.knob(0.0058, 0.0085, skirt=False),
                                                     P.b.mats["plastic_black"]), piv, R)
        P.hit("xpdrCode", at + R[:, 2] * 0.005, (0.0085, 0.0085, 0.0055), frame=R, side=0, step=10 ** (3 - i),
              suffix="" if i == 0 else f"__d{i}")
    label(P, "IFF", cl(-0.36, 4.745, s), 0.0028, R)
    # Interior lights and the canopy switch.
    for cid, bl, text in (("lightPanel", -0.30, "INST"), ("lightConsole", -0.355, "CONSOLES"),
                          ("lightFlood", -0.41, "FLOOD")):
        knob(P, cid, cl(bl, 5.07, s), R, r=0.0065, shape="lightknob")
        label(P, text, cl(bl, 5.045, s), 0.0026, R)
    label(P, "INTR LT", cl(-0.355, 5.10, s), 0.0032, R, GREEN)
    toggle(P, "canopy", cl(-0.36, 5.21, s), R, detents=(-25.0, 0.0, 25.0), side=-R[:, 1])
    label(P, "CANOPY", cl(-0.36, 5.185, s), 0.0028, R)
    for t, dv in (("OPEN", 0.012), ("HOLD", 0.0), ("CLOSE", -0.012)):
        label(P, t, cl(-0.39, 5.21 - dv, s), 0.0022, R)


def seat_and_stick(P):
    # Seat SAFE/ARMED handle on the bucket's left front: down = armed.
    R = np.column_stack([(0, -1.0, 0), (0, 0, 1.0), (1.0, 0, 0)])
    at = np.array([0.232, 4.42, 2.27])
    piv = P.pivot("Ctl_seatArmed", at, axis=R[:, 0], props={"detents": [-50.0, 0.0]})
    K.attach(P.b, "Ctl_seatArmed_mesh", K.mesh_data("seat_handle", M.merge([
        M.cylinder((0, 0, 0), (0, 0.04, 0.0), 0.004, 8), M.rounded_box((0, 0.045, 0.0), (0.02, 0.012, 0.01), 0.003, 1)]),
        P.b.mats["eject"]), piv, R)
    P.hit("seatArmed", at + np.array([0.008, 0, 0.03]), (0.012, 0.025, 0.03), frame=np.eye(3))
    # On the stick: the trim hat on top, the nosewheel steering button, the paddle.
    roll = P.b.parts["StickRoll"]
    gt = P.b.parts["GripTop"]
    top = np.column_stack([(-1.0, 0, 0), (0, -1.0, 0), (0, 0, 1.0)])
    hat = P.pivot("Ctl_trim", gt + np.array([-0.006, 0.0, 0.03]), axis=np.array([1.0, 0, 0]))
    K.attach(P.b, "Ctl_trim_mesh", K.mesh_data("trim_hat", M.merge([
        M.cylinder((0, 0, 0), (0, 0, 0.006), 0.0045, 10), M.rounded_box((0, 0, 0.007), (0.012, 0.012, 0.003), 0.002, 1)]),
        P.b.mats["plastic_black"]), hat, top)
    M.parent_keep(hat, roll)
    P.hit("trim", gt + np.array([-0.006, 0.0, 0.035]), (0.009, 0.011, 0.008), frame=np.eye(3),
          side=np.array([0, -1.0, 0]))
    fr = np.column_stack([(-1.0, 0, 0), (0, 0, 1.0), (0, 1.0, 0)])
    nws = P.pivot("Ctl_nosewheelSteering", gt + np.array([0.012, 0.028, 0.0]), slide=np.array([0, -0.0015, 0]))
    K.attach(P.b, "Ctl_nosewheelSteering_mesh", K.shared("nws_btn", lambda: K.revolve(
        [(0, 0.004, False), (0.003, 0.004, False), (0.004, 0.003, False)], 12), P.b.mats["chrome"]), nws, fr)
    M.parent_keep(nws, roll)
    P.hit("nosewheelSteering", gt + np.array([0.012, 0.032, 0.0]), (0.007, 0.006, 0.007), frame=np.eye(3))
    pad = P.pivot("Ctl_apDisconnect", gt + np.array([0.0, 0.03, -0.065]), axis=np.array([1.0, 0, 0]),
                  props={"detents": [0.0, 12.0]})
    K.attach(P.b, "Ctl_apDisconnect_mesh", K.mesh_data("paddle", M.rounded_box((0, 0, 0.012), (0.03, 0.004, 0.025),
                                                                               0.002, 1), P.b.mats["chrome"]), pad,
             np.column_stack([(-1.0, 0, 0), (0, 0, 1.0), (0, 1.0, 0)]))
    M.parent_keep(pad, roll)
    P.hit("apDisconnect", gt + np.array([0.0, 0.035, -0.055]), (0.017, 0.007, 0.015), frame=np.eye(3))


def build(b):
    # The kit's Builder knows its objects by name for parenting extras to a lever.
    import bpy
    b.objects_by_name = bpy.data.objects
    P = K.Placer(b, PANEL_R, label_cols=12, label_rows=24)
    ufc(P)
    displays(P)
    left_wing(P)
    right_wing(P)
    glareshield(P)
    left_console(P)
    right_console(P)
    seat_and_stick(P)
    # The HUD: the combiner glass and the symbol plane, normal to the boresight at the combiner.
    hud_at = np.array([0.0, C.HUD_FS - 0.004, C.HUD_CENTRE_WL])
    fr = np.column_stack([(-1.0, 0, 0), (0, 0, 1.0), (0, 1.0, 0)])
    v, f = K.quad(0.248, C.HUD_GLASS_H)
    M.make_object("HudCombiner", K.to_design(hud_at + np.array([0, 0.006, 0]), fr, v), f, b.col, b.mats["hud_glass"],
                  smooth=False).parent = None
    import bpy
    M.parent_keep(bpy.data.objects["HudCombiner"], b.root)
    P.display("HUD", hud_at, *C.HUD_PLANE, frame=fr)
    P.flush_labels()
    return P
