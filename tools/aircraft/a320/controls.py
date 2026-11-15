"""
Operable controls of the A320 flight deck: one Ctl_<id> node and at least one Hit_<id> box for
every control of A320_CONTROLS (src/sim/cockpitA320.ts), placed where an Airbus pilot looks
for it. Naming and extras: see lib/cockpit_kit.py.

Display windows (Disp_<ID>) the loader paints: PFD1, ND1, EWD, SD, ND2, PFD2 (the six display
units), ISIS (standby), MCDU1, MCDU2, and the windows of the panel atlas: FCU_SPD, FCU_HDG,
FCU_ALT, FCU_VS, BARO1, RMP1_COM, RMP1_NAV, RMP2_COM, RMP2_NAV, ADF, ATC, RUDTRIM, GEARIND,
ECP and the legends of the lit push buttons, KY_<id> (OFF, ON, FAULT, AVAIL... drawn by
state).

Push-pull knobs of the FCU and the baro knob: the knob turns (Ctl_<knob>) inside a pivot that
slides in or out (Ctl_<...Managed>, Ctl_baroStd, Ctl_fcuVsPull / Ctl_fcuVsPush). The ring's
hit box turns it (left half down, right half up); a smaller box standing out in front of the
knob's centre pushes or pulls it.
"""

import math

import numpy as np

from lib import cockpit_kit as K
from lib import mesh as M
from . import cockpit as C
from . import wing as W

PANEL_R, OVH_R, MCDU_R, TOP_R, GLARE_R = C.PANEL_R, C.OVH_R, C.MCDU_R, C.TOP_R, C.GLARE_R
pp, oo, mm, tt, gg = C.pp, C.oo, C.mm, C.tt, C.gg
OVH_S = 0.02
GLARE_S = 0.024
EFIS_S = 0.020
TOP_S = 0.004
WHITE = "#ecece6"
BLUE = "#6fd0ff"
AMBER = "#ffb54a"

# Display windows: id -> (w, h) metres; the loader's atlas regions have the same shapes.
WINDOWS = {
    "FCU_SPD": (0.040, 0.020), "FCU_HDG": (0.040, 0.020), "FCU_ALT": (0.058, 0.020), "FCU_VS": (0.048, 0.020),
    "BARO1": (0.036, 0.012), "RMP1_COM": (0.090, 0.014), "RMP1_NAV": (0.090, 0.014), "RMP2_COM": (0.090, 0.014),
    "RMP2_NAV": (0.090, 0.014), "ADF": (0.044, 0.012), "ATC": (0.044, 0.012), "RUDTRIM": (0.032, 0.012),
    "GEARIND": (0.060, 0.030), "ECP": (0.200, 0.012),
}
KY = (0.0176, 0.0132)
KEYS = []          # every KY_<id> legend, in the order they were placed


def axes(frame):
    return frame[:, 0], frame[:, 1], frame[:, 2]


def label(P, text, at, h, frame, color=WHITE):
    P.label(text, at, h, frame=frame, color=color)


# ---------------------------------------------------------------------------
# Generic pieces
# ---------------------------------------------------------------------------

def toggle(P, cid, at, frame, detents=(22.0, -22.0), big=False):
    """Bat toggle turning about the frame's x axis to its detents (one per position)."""
    b = P.b
    x, y, z = axes(frame)
    K.static(b, "steel", K.revolve([(0, 0.0065, False), (0.0025, 0.0065, False), (0.0032, 0.0045, False)], 12),
             at, frame)
    piv = P.pivot(f"Ctl_{cid}", at + z * 0.002, axis=x, props={"detents": list(detents)})
    shape = "toggle_big" if big else "toggle"
    K.attach(b, f"Ctl_{cid}_mesh", K.shared(shape, lambda: toggle_shape(1.6 if big else 1.0), b.mats["chrome"]), piv,
             frame)
    s = 1.6 if big else 1.0
    P.hit(cid, at + z * 0.009 * s, (0.009 * s, 0.014 * s, 0.010 * s), frame=frame,
          side=1 if len(detents) > 2 else None)
    return piv


def toggle_shape(s=1.0):
    return M.merge([K.revolve([(0, 0.0024 * s, False), (0.003 * s, 0.0024 * s, False), (0.0035 * s, 0.0015 * s, False)], 10),
                    M.cylinder((0, 0, 0.002 * s), (0, 0, 0.014 * s), 0.0014 * s, 8),
                    K.revolve([(0.0125 * s, 0.0024 * s, False), (0.0165 * s, 0.0024 * s, False),
                               (0.0175 * s, 0.0012 * s, False)], 10)])


def rotary(P, cid, at, frame, detents, names, r=0.0075, lh=0.0028):
    b = P.b
    x, y, z = axes(frame)
    piv = P.pivot(f"Ctl_{cid}", at, axis=z, props={"detents": list(detents)})
    K.attach(b, f"Ctl_{cid}_mesh", K.shared(f"rotary_{r}", lambda: K.chicken_head(r, 0.009), b.mats["plastic_black"]),
             piv, frame)
    P.hit(cid, at + z * 0.007, (r + 0.004, r + 0.004, 0.008), frame=frame, side=0)
    for name, ang in zip(names, detents):
        a = math.radians(ang)
        if name:
            label(P, name, at + (r + 0.009) * (-math.sin(a) * x + math.cos(a) * y), lh, frame)
    return piv


def knob(P, cid, at, frame, r=0.007, length=0.011, shape="knob", parent=None):
    b = P.b
    x, y, z = axes(frame)
    piv = P.pivot(f"Ctl_{cid}", at, axis=z)
    if parent is not None:
        M.parent_keep(piv, parent)
    K.attach(b, f"Ctl_{cid}_mesh", K.shared(f"{shape}_{r}_{length}", lambda: K.knob(r, length), b.mats["plastic_black"]),
             piv, frame)
    return piv


def knob_hit(P, cid, at, frame, r, length):
    z = frame[:, 2]
    P.hit(cid, at + z * (length / 2), (r + 0.004, r + 0.004, length / 2 + 0.003), frame=frame, side=0)


def dual_knob(P, cid, at, frame, coarse):
    b = P.b
    z = frame[:, 2]
    outer = P.pivot(f"Ctl_{cid}_outer", at, axis=z)
    K.attach(b, f"Ctl_{cid}_outer_mesh", K.shared("dual_outer", lambda: K.knob(0.0095, 0.006, skirt=False),
                                                  b.mats["plastic_black"]), outer, frame)
    inner = P.pivot(f"Ctl_{cid}", at, axis=z)
    K.attach(b, f"Ctl_{cid}_mesh", K.shared("dual_inner", lambda: K.knob(0.006, 0.007, z0=0.006, skirt=False),
                                            b.mats["plastic_black"]), inner, frame)
    P.hit(cid, at + z * 0.0095, (0.0068, 0.0068, 0.0035), frame=frame, side=0)
    P.hit(cid, at + z * 0.003, (0.012, 0.012, 0.004), frame=frame, side=0, step=coarse, suffix="__coarse")


def button(P, cid, at, frame, w=0.014, h=0.010, mat="plastic_black", travel=0.0018, depth=0.006, parent=None):
    b = P.b
    z = frame[:, 2]
    piv = P.pivot(f"Ctl_{cid}", at, slide=-z * travel)
    if parent is not None:
        M.parent_keep(piv, parent)
    K.attach(b, f"Ctl_{cid}_mesh", K.shared(f"btn_{w}_{h}_{depth}_{mat}",
                                            lambda: K.box(0, 0, depth / 2, w, h, depth, 0.0012, 1), b.mats[mat]),
             piv, frame)
    P.hit(cid, at + z * (depth - 0.001), (max(w / 2, 0.0055) + 0.0015, max(h / 2, 0.0055) + 0.0015, 0.005),
          frame=frame)
    return piv


def korry(P, cid, at, frame, text=None, w=0.020, h=0.016, face=KY, lh=0.0034, travel=0.0015):
    """Airbus push button with its legend window: in when on (latched), lit legends by state."""
    b = P.b
    x, y, z = axes(frame)
    depth = 0.008
    K.static(b, "steel", K.frame_plate(w + 0.004, h + 0.004, 0.003, 0.0015), at, frame)
    piv = P.pivot(f"Ctl_{cid}", at, slide=-z * travel)
    K.attach(b, f"Ctl_{cid}_mesh", K.shared(f"korry_{w}_{h}", lambda: K.box(0, 0, depth / 2, w, h, depth, 0.001, 1),
                                            b.mats["korry"]), piv, frame)
    disp_key(P, cid, at + z * (depth + 0.0003), frame, face)
    P.hit(cid, at + z * (depth - 0.002), (w / 2 + 0.002, h / 2 + 0.002, 0.006), frame=frame)
    if text:
        label(P, text, at + y * (h / 2 + 0.0055), lh, frame)
    return piv


def disp_key(P, key, at, frame, face=KY):
    KEYS.append(key)
    return P.display(f"KY_{key}", at, face[0], face[1], frame=frame, lift=0.0)


def dummy_korry(P, at, frame, w=0.020, h=0.016):
    K.static(P.b, "steel", K.frame_plate(w + 0.004, h + 0.004, 0.003, 0.0015), at, frame)
    K.static(P.b, "korry", K.box(0, 0, 0.004, w, h, 0.008, 0.001, 1), at, frame)


def dummy_knob(P, at, frame, r=0.006):
    K.static(P.b, "plastic_black", K.knob(r, 0.009, skirt=False), at, frame)


def dummy_toggle(P, at, frame):
    K.static(P.b, "chrome", toggle_shape(), at, frame)


def pushpull(P, knob_id, at, frame, outer_ids, r=0.0095, length=0.016, split=None):
    """FCU knob: turns (`knob_id`) in pivots that slide; `outer_ids` = [(id, +1 out / -1 in)].
    The centre box (or two halves with `split`) pushes or pulls."""
    z = frame[:, 2]
    y = frame[:, 1]
    parent = None
    for oid, sign in outer_ids:
        piv = P.pivot(f"Ctl_{oid}", at, slide=z * 0.004 * sign)
        if parent is not None:
            M.parent_keep(piv, parent)
        parent = piv
    knob(P, knob_id, at, frame, r=r, length=length, shape="fcu_knob", parent=parent)
    P.hit(knob_id, at + z * (length / 2), (r + 0.006, r + 0.004, length / 2 + 0.002), frame=frame, side=0)
    front = at + z * (length + 0.009)
    if split is None:
        P.hit(outer_ids[0][0], front, (0.0055, 0.0055, 0.0085), frame=frame)
    else:
        up, down = split
        P.hit(up, front + y * 0.0032, (0.0055, 0.0030, 0.0085), frame=frame)
        P.hit(down, front - y * 0.0032, (0.0055, 0.0030, 0.0085), frame=frame)


# ---------------------------------------------------------------------------
# Overhead panel
# ---------------------------------------------------------------------------

def overhead(P):
    s = OVH_S
    rows = [
        (0.10, "ADIRS", [("adirs", 0.0, "IR 1", "r2:OFF,NAV")]),
        (0.23, "FUEL", [("fuelPumpsLeft", 0.30, "L TK PUMPS", "k"), ("fuelPumpsCenter", 0.235, "CTR TK", "k"),
                        ("fuelPumpsRight", 0.17, "R TK PUMPS", "k"), ("fuelCrossfeed", 0.09, "X FEED", "k")]),
        (0.23, "HYD", [("hydGreen", -0.06, "ENG 1 PUMP", "k"), ("hydBlue", -0.13, "ELEC PUMP", "k"),
                       ("hydYellow", -0.20, "ENG 2 PUMP", "k"), ("hydYellowElectric", -0.28, "Y ELEC", "k")]),
        (0.37, "ELEC", [("battery", 0.28, "BAT 1", "k"), ("battery2", 0.21, "BAT 2", "k"),
                        ("externalPower", 0.11, "EXT PWR", "k"), ("generator1", 0.02, "GEN 1", "k"),
                        ("apuGenerator", -0.07, "APU GEN", "k"), ("generator2", -0.16, "GEN 2", "k")]),
        (0.50, "AIR COND", [("pack1", 0.28, "PACK 1", "k"), ("bleed1", 0.19, "ENG 1 BLEED", "k"),
                            ("apuBleed", 0.09, "APU BLEED", "k"), ("crossbleed", -0.01, "X BLEED", "k"),
                            ("bleed2", -0.11, "ENG 2 BLEED", "k"), ("pack2", -0.21, "PACK 2", "k")]),
        (0.63, "ANTI ICE", [("wingAntiIce", 0.28, "WING", "k"), ("engineAntiIce1", 0.20, "ENG 1", "k"),
                            ("engineAntiIce2", 0.12, "ENG 2", "k"), ("probeHeat", 0.03, "PROBE/WINDOW", "k")]),
        (0.63, "APU", [("apuMaster", -0.13, "MASTER SW", "k"), ("apuStart", -0.21, "START", "k")]),
        (0.77, "EXT LT", [("lightStrobe", 0.31, "STROBE", "t3:OFF,AUTO,ON"), ("lightBeacon", 0.255, "BEACON", "t"),
                          ("lightWing", 0.20, "WING", "t"), ("lightNav", 0.145, "NAV & LOGO", "t"),
                          ("lightRunwayTurnoff", 0.085, "RWY TURN OFF", "t"),
                          ("lightLanding", 0.025, "LAND", "t"), ("lightNose", -0.04, "NOSE", "t3:OFF,TAXI,T.O.")]),
        (0.77, "SIGNS", [("seatBelts", -0.13, "SEAT BELTS", "t3:OFF,AUTO,ON")]),
        (0.77, "INT LT", [("lightDome", -0.21, "DOME", "t3:OFF,DIM,BRT"), ("lightPanel", -0.29, "INTEG LT", "n")]),
    ]
    titles = {}
    for d, title, items in rows:
        xs = [bl for _, bl, _, _ in items]
        titles[title] = (d, sum(xs) / len(xs))
        for cid, bl, text, kind in items:
            at = oo(bl, d, s)
            if kind == "k":
                korry(P, cid, at, OVH_R, text, lh=0.0030)
            elif kind == "t":
                toggle(P, cid, at, OVH_R, detents=(25.0, -25.0))
                label(P, text, oo(bl, d - 0.026, s), 0.0030, OVH_R)
                label(P, "ON", oo(bl, d - 0.016, s), 0.0026, OVH_R)
                label(P, "OFF", oo(bl, d + 0.017, s), 0.0026, OVH_R)
            elif kind.startswith("t3"):
                names = kind.split(":")[1].split(",")
                toggle(P, cid, at, OVH_R, detents=(25.0, 0.0, -25.0))
                label(P, text, oo(bl, d - 0.028, s), 0.0030, OVH_R)
                label(P, names[2], oo(bl, d - 0.017, s), 0.0024, OVH_R)
                label(P, names[1], oo(bl - 0.016, d, s), 0.0024, OVH_R)
                label(P, names[0], oo(bl, d + 0.018, s), 0.0024, OVH_R)
            elif kind.startswith("r2"):
                rotary(P, cid, at, OVH_R, (30.0, -30.0), kind.split(":")[1].split(","))
                label(P, text, oo(bl, d - 0.024, s), 0.0032, OVH_R)
            elif kind == "n":
                knob(P, cid, at, OVH_R, r=0.0065, length=0.010, shape="ovh_knob")
                knob_hit(P, cid, at, OVH_R, 0.0065, 0.010)
                label(P, text, oo(bl, d - 0.022, s), 0.0030, OVH_R)
    for title, (d, bl) in titles.items():
        label(P, title, oo(bl, d - 0.040, s), 0.0042, OVH_R)
    # The rest of the overhead: rows of push buttons and selectors the simulation leaves out.
    for d in (0.10, 0.23, 0.37, 0.50):
        for bl in (0.33, -0.33):
            dummy_korry(P, oo(bl, d, s), OVH_R)
    for bl in (0.21, 0.15, -0.09, -0.15, -0.24):
        dummy_korry(P, oo(bl, 0.10, s), OVH_R)
    for bl in (0.07, -0.07):
        dummy_knob(P, oo(bl, 0.10, s), OVH_R, 0.007)
    for d in (0.30, 0.44, 0.57):
        for bl in (0.25, 0.14, 0.03, -0.08, -0.19, -0.30):
            dummy_korry(P, oo(bl, d, s), OVH_R, w=0.016, h=0.012)
    label(P, "CABIN PRESS", oo(-0.06, 0.664, s), 0.0034, OVH_R)
    for bl in (-0.03, 0.04):
        dummy_knob(P, oo(bl, 0.70, s), OVH_R, 0.008)


# ---------------------------------------------------------------------------
# Glareshield: FCU, EFIS control panels, master warning and caution
# ---------------------------------------------------------------------------

def fcu_button(P, cid, bl, dz, text, lit=True):
    at = gg(bl, dz, GLARE_S)
    w, h = 0.024, 0.017
    piv = P.pivot(f"Ctl_{cid}", at, slide=-GLARE_R[:, 2] * 0.0018)
    K.attach(P.b, f"Ctl_{cid}_mesh", K.shared("fcu_btn", lambda: K.box(0, 0, 0.004, w, h, 0.008, 0.0015, 1),
                                              P.b.mats["korry"]), piv, GLARE_R)
    if lit:
        disp_key(P, cid, at + GLARE_R[:, 2] * 0.0083, GLARE_R, (0.0200, 0.0150))
    P.hit(cid, at + GLARE_R[:, 2] * 0.006, (w / 2 + 0.002, h / 2 + 0.002, 0.006), frame=GLARE_R)
    label(P, text, gg(bl, dz - h / 2 - 0.0045, GLARE_S), 0.0032, GLARE_R)
    return piv


def fcu(P):
    s = GLARE_S
    for wid, bl in (("FCU_SPD", 0.205), ("FCU_HDG", 0.085), ("FCU_ALT", -0.072), ("FCU_VS", -0.150)):
        P.display(wid, gg(bl, 0.030, s + 0.0004), *WINDOWS[wid], frame=GLARE_R)
    pushpull(P, "fcuSpeed", gg(0.205, -0.016, s), GLARE_R, [("fcuSpeedManaged", -1)])
    pushpull(P, "fcuHeading", gg(0.085, -0.016, s), GLARE_R, [("fcuHeadingManaged", -1)])
    pushpull(P, "fcuAltitude", gg(-0.072, -0.016, s), GLARE_R, [("fcuAltitudeManaged", -1)])
    pushpull(P, "fcuVerticalSpeed", gg(-0.165, -0.016, s), GLARE_R, [("fcuVsPull", 1), ("fcuVsPush", -1)],
             split=("fcuVsPull", "fcuVsPush"))
    fcu_button(P, "fcuMach", 0.255, -0.026, "SPD MACH", lit=False)
    fcu_button(P, "fcuLoc", 0.145, -0.026, "LOC")
    fcu_button(P, "ap1", 0.026, 0.025, "AP1")
    fcu_button(P, "ap2", -0.010, 0.025, "AP2")
    fcu_button(P, "athr", 0.008, -0.018, "A/THR")
    fcu_button(P, "fcuExped", -0.118, -0.034, "EXPED")
    fcu_button(P, "fcuAppr", -0.245, -0.026, "APPR")
    # HDG-V/S / TRK-FPA and METRIC ALT, not simulated.
    for bl, dz, text in ((0.040, -0.046, "HDG V/S TRK FPA"), (-0.118, 0.002, "METRIC ALT")):
        K.static(P.b, "korry", K.box(0, 0, 0.004, 0.020, 0.012, 0.008, 0.0015, 1), gg(bl, dz, s), GLARE_R)
        label(P, text, gg(bl, dz - 0.0105, s), 0.0026, GLARE_R)
    for text, bl in (("SPD", 0.205), ("HDG", 0.085), ("ALT", -0.072), ("V/S", -0.150)):
        label(P, text, gg(bl, 0.047, s), 0.0034, GLARE_R)
    label(P, "LVL/CH", gg(-0.111, 0.047, s), 0.0028, GLARE_R)


def efis(P):
    s = EFIS_S
    frame = GLARE_R
    # Captain's EFIS control panel.
    P.display("BARO1", gg(0.615, 0.030, s + 0.0004), *WINDOWS["BARO1"], frame=frame)
    pushpull(P, "altimeterSetting", gg(0.615, -0.014, s), frame, [("baroStd", 1)], r=0.0105, length=0.014)
    label(P, "PULL STD", gg(0.615, -0.040, s), 0.0028, frame)
    label(P, "inHg  hPa", gg(0.615, 0.044, s), 0.0026, frame)
    fcu_button(P, "flightDirector", 0.548, 0.028, "FD")
    fcu_button(P, "ls", 0.548, -0.012, "LS")
    for i, text in enumerate(("CSTR", "WPT", "VOR.D", "NDB", "ARPT")):
        bl = 0.488 - i * 0.030
        K.static(P.b, "korry", K.box(0, 0, 0.004, 0.020, 0.014, 0.008, 0.0015, 1), gg(bl, 0.030, s), frame)
        label(P, text, gg(bl, 0.044, s), 0.0026, frame)
    rotary(P, "ndMode", gg(0.455, -0.018, s), frame, (60.0, 30.0, 0.0, -30.0, -60.0), ["LS", "VOR", "NAV", "ARC", "PLAN"],
           r=0.0085, lh=0.0024)
    rotary(P, "ndRange", gg(0.375, -0.018, s), frame, (75.0, 45.0, 15.0, -15.0, -45.0, -75.0),
           ["10", "20", "40", "80", "160", "320"], r=0.0085, lh=0.0024)
    for bl in (0.425, 0.405):
        dummy_toggle(P, gg(bl, -0.045, s), frame)
    label(P, "ADF  VOR 1", gg(0.415, -0.054, s), 0.0024, frame)
    # The first officer's panel, not simulated (the captain's settings are shown on both sides).
    dummy_knob(P, gg(-0.615, -0.014, s), frame, 0.0105)
    for i in range(5):
        K.static(P.b, "korry", K.box(0, 0, 0.004, 0.020, 0.014, 0.008, 0.0015, 1), gg(-0.488 + i * 0.030, 0.030, s),
                 frame)
    for bl, dz in ((-0.548, 0.028), (-0.548, -0.012)):
        K.static(P.b, "korry", K.box(0, 0, 0.004, 0.024, 0.017, 0.008, 0.0015, 1), gg(bl, dz, s), frame)
    for bl in (-0.455, -0.375):
        dummy_knob(P, gg(bl, -0.018, s), frame, 0.0085)
    label(P, "FD", gg(-0.548, 0.0145, s), 0.0032, frame)
    label(P, "LS", gg(-0.548, -0.0255, s), 0.0032, frame)
    # Master warning and caution.
    for cid, dz, text in (("masterWarning", 0.020, "MASTER WARN"), ("masterCaution", -0.022, "MASTER CAUT")):
        at = gg(0.745, dz, 0.018)
        piv = P.pivot(f"Ctl_{cid}", at, slide=-frame[:, 2] * 0.002)
        K.attach(P.b, f"Ctl_{cid}_mesh", K.shared("master", lambda: K.box(0, 0, 0.005, 0.034, 0.026, 0.010, 0.002, 1),
                                                  P.b.mats["korry"]), piv, frame)
        disp_key(P, cid, at + frame[:, 2] * 0.0103, frame, (0.030, 0.0225))
        P.hit(cid, at + frame[:, 2] * 0.008, (0.019, 0.015, 0.007), frame=frame)
        K.static(P.b, "korry", K.box(0, 0, 0.005, 0.034, 0.026, 0.010, 0.002, 1), gg(-0.745, dz, 0.018), frame)
        label(P, text, gg(0.745, dz - 0.017, 0.018), 0.0026, frame)


# ---------------------------------------------------------------------------
# Main panel: displays, standby, gear, autobrake
# ---------------------------------------------------------------------------

def main_panel(P):
    for did, bl in C.DISPLAYS.items():
        P.display(did, pp(bl, C.DU_V, 0.0145), C.SCREEN, C.SCREEN)
    P.display("SD", pp(0.0, C.SD_V, 0.0145), C.SCREEN, C.SCREEN)
    P.display("ISIS", pp(0.245, 0.44, 0.0125), 0.080, 0.080)
    dummy_knob(P, pp(0.205, 0.40, 0.012), PANEL_R, 0.004)
    label(P, "CHRONO", pp(0.245, 0.357, 0.010), 0.0028, PANEL_R)
    # Landing gear lever: a wheel-shaped knob on a lever sliding down its gate with the gear down.
    s = 0.008
    top_v, travel = 0.255, 0.10
    K.static(P.b, "plastic_black", K.box(0, 0, 0.001, 0.010, travel + 0.03, 0.002), pp(-0.235, top_v - travel / 2, s),
             PANEL_R)
    piv = P.pivot("Ctl_gear", pp(-0.235, top_v, s), slide=-C.VV * travel)
    handle = M.merge([M.cylinder((0, 0, -0.005), (0, 0, 0.055), 0.005, 10),
                      M.lathe([(0.045, 0.0), (0.045, 0.018), (0.058, 0.020), (0.060, 0.014), (0.060, 0.0)], (0, 0, 0),
                              (0, 0, 1.0), n=18, close_start=True, close_end=True)])
    K.attach(P.b, "Ctl_gear_mesh", K.mesh_data("gear_handle", handle, P.b.mats["placard"]), piv, PANEL_R)
    P.hit("gear", pp(-0.235, top_v - travel / 2, s + 0.05), (0.022, travel / 2 + 0.014, 0.016))
    label(P, "UP", pp(-0.265, top_v, s), 0.0036, PANEL_R)
    label(P, "DOWN", pp(-0.265, top_v - travel, s), 0.0036, PANEL_R)
    label(P, "L/G", pp(-0.235, top_v + 0.024, s), 0.0040, PANEL_R)
    P.display("GEARIND", pp(0.205, 0.215, 0.0085), *WINDOWS["GEARIND"])
    label(P, "LDG GEAR", pp(0.205, 0.238, 0.008), 0.0030, PANEL_R)
    # Autobrake: LO, MED, MAX push buttons; one control (left half less, right half more).
    grp = P.pivot("Ctl_autobrake", pp(0.205, 0.145, 0.008))
    _ = grp
    for i, (key, text) in enumerate((("abLo", "LO"), ("abMed", "MED"), ("abMax", "MAX"))):
        bl = 0.233 - i * 0.028
        at = pp(bl, 0.145, 0.008)
        K.static(P.b, "korry", K.box(0, 0, 0.004, 0.020, 0.016, 0.008, 0.001, 1), at, PANEL_R)
        disp_key(P, key, at + PANEL_R[:, 2] * 0.0083, PANEL_R)
        label(P, text, pp(bl, 0.162, 0.008), 0.0030, PANEL_R)
    P.hit("autobrake", pp(0.205, 0.145, 0.014), (0.045, 0.011, 0.007), side=0)
    label(P, "AUTO/BRK", pp(0.205, 0.124, 0.008), 0.0030, PANEL_R)
    # Brake pressure triple indicator (a dummy dial).
    K.static(P.b, "gauge_face", M.cylinder((0, 0, 0), (0, 0, 0.003), 0.020, 20), pp(0.205, 0.08, 0.008), PANEL_R)


# ---------------------------------------------------------------------------
# Pedestal
# ---------------------------------------------------------------------------

def mcdu(P):
    for n, bl in ((1, 0.125), (2, -0.125)):
        P.display(f"MCDU{n}", mm(bl, 0.245, 0.0046), 0.0864, 0.0675, frame=MCDU_R)
        keys = []
        for side in (-1, 1):
            for i in range(6):
                keys.append((bl - side * 0.055, 0.274 - i * 0.0115, 0.010, 0.006))
        for r in range(3):
            for c in range(6):
                keys.append((bl + 0.05 - c * 0.02, 0.185 - r * 0.014, 0.016, 0.009))
        for r in range(5):
            for c in range(6):
                keys.append((bl + 0.05 - c * 0.02, 0.135 - r * 0.0155, 0.014, 0.011))
        for x, d, w, h in keys:
            K.static(P.b, "plastic_black", K.box(0, 0, 0.002, w, h, 0.004), mm(x, d, 0.004), MCDU_R)
        label(P, f"MCDU {n}", mm(bl, 0.305, 0.004), 0.0034, MCDU_R)


def lever_slot(P, bl, fs0, fs1, w=0.012):
    K.static(P.b, "plastic_black", K.box(0, 0, 0.0005, w, abs(fs1 - fs0) + 0.02, 0.001), tt(bl, 0.5 * (fs0 + fs1), TOP_S),
             TOP_R)


def thrust_quadrant(P):
    s = TOP_S + 0.06
    pivot_fs = 3.66
    for n, bl in ((1, 0.045), (2, -0.045)):
        at = tt(bl, pivot_fs, s - 0.10)
        top = at + np.array([0, 0, 0.20])
        ax, _ = W.oriented_axis(at - np.array([1.0, 0, 0]), at + np.array([1.0, 0, 0]), top, np.array([0, -1.0, 0]))
        piv = P.pivot(f"Ctl_throttle{n}", at, axis=np.array([1.0 if ax[0] > 0 else -1.0, 0, 0]),
                      props={"idleDeg": -18.0, "togaDeg": 30.0, "revDeg": -36.0})
        lever = M.merge([M.rounded_box((0, 0, 0.13), (0.012, 0.022, 0.15), 0.004, 1),
                         M.rounded_box((0, -0.004, 0.215), (0.040, 0.050, 0.036), 0.012, 2)])
        K.attach(P.b, f"Ctl_throttle{n}_mesh", K.shared("tl", lambda: lever, P.b.mats["plastic_black"]), piv, TOP_R)
        # Reverse latch on the front of the handle; it rides with the lever.
        name = "Ctl_reverse" if n == 1 else "RevLatch_2"
        lat = at + np.array([0, -0.035, 0.20])
        rev = P.pivot(name, lat, axis=np.array([1.0, 0, 0]), props={"detents": [0.0, -28.0]})
        M.parent_keep(rev, piv)
        K.attach(P.b, f"{name}_mesh", K.shared("rev_latch", lambda: M.merge([
            M.rounded_box((0, -0.012, -0.012), (0.026, 0.006, 0.030), 0.002, 1)]), P.b.mats["plastic_black"]), rev, TOP_R)
        if n == 1:
            # The instinctive disconnect: a red button on the outboard side of the handle.
            dc = at + np.array([0.021, -0.004, 0.215])
            dpiv = P.pivot("Ctl_athrDisconnect", dc, slide=np.array([-0.002, 0, 0]))
            M.parent_keep(dpiv, piv)
            side_frame = np.column_stack([(0, -1.0, 0), (0, 0, 1.0), (1.0, 0, 0)])
            K.attach(P.b, "Ctl_athrDisconnect_mesh", K.mesh_data("athr_disc", K.revolve(
                [(0, 0.006, False), (0.004, 0.006, False), (0.005, 0.005, False)], 14), P.b.mats["knob_red"]), dpiv,
                side_frame)
    # Hit boxes over the arc each lever sweeps (the lever's angle tells the side).
    for n, bl in ((1, 0.045), (2, -0.045)):
        P.hit(f"throttle{n}", tt(bl, pivot_fs - 0.01, TOP_S + 0.17), (0.020, 0.11, 0.04), frame=np.eye(3),
              side=np.array([0, -1.0, 0]))
    # Ahead of the handles, where the latches are (the levers' own boxes end behind them).
    P.hit("reverse", tt(0.0, pivot_fs - 0.135, TOP_S + 0.20), (0.034, 0.012, 0.02), frame=np.eye(3))
    P.hit("athrDisconnect", tt(0.072, pivot_fs - 0.01, TOP_S + 0.175), (0.006, 0.09, 0.03), frame=np.eye(3))
    for text, fs in (("TOGA", pivot_fs - 0.105), ("FLX MCT", pivot_fs - 0.075), ("CL", pivot_fs - 0.035),
                     ("IDLE", pivot_fs + 0.045), ("REV", pivot_fs + 0.08)):
        label(P, text, tt(0.0, fs, TOP_S + 0.061), 0.0040, TOP_R, AMBER if text == "REV" else WHITE)
    # Speed brake lever (left): pulled aft to extend, lifted to arm the ground spoilers.
    bl, f0, travel = 0.165, 3.50, 0.11
    lever_slot(P, bl, f0, f0 + travel)
    piv = P.pivot("Ctl_speedbrake", tt(bl, f0, TOP_S), slide=np.array([0, travel, 0]))
    arm = P.pivot("Ctl_spoilersArmed", tt(bl, f0, TOP_S), slide=np.array([0, 0, 0.022]))
    M.parent_keep(arm, piv)
    sb = M.merge([M.cylinder((0, 0, -0.01), (0, 0, 0.075), 0.005, 8),
                  M.rounded_box((0, 0, 0.085), (0.020, 0.040, 0.018), 0.006, 2)])
    K.attach(P.b, "Ctl_speedbrake_mesh", K.mesh_data("sb_handle", sb, P.b.mats["plastic_black"]), arm, TOP_R)
    P.hit("speedbrake", tt(bl, f0 + travel / 2, TOP_S + 0.07), (0.018, travel / 2 + 0.015, 0.03), frame=TOP_R,
          side=np.array([0, 1.0, 0]), extra={"lever": 1})
    P.hit("spoilersArmed", tt(bl, f0, TOP_S + 0.10), (0.016, 0.024, 0.008), frame=TOP_R)
    for text, fs in (("RET", f0), ("1/2", f0 + travel / 2), ("FULL", f0 + travel)):
        label(P, text, tt(bl + 0.028, fs, TOP_S), 0.0034, TOP_R)
    label(P, "SPEED BRAKE", tt(bl, f0 - 0.028, TOP_S), 0.0036, TOP_R)
    label(P, "ARM", tt(bl - 0.028, f0 - 0.012, TOP_S), 0.0030, TOP_R)
    # Flap lever (right): five gates, 0 forward to FULL aft.
    bl, f0, travel = -0.180, 3.48, 0.13
    lever_slot(P, bl, f0, f0 + travel)
    for i in range(5):
        K.static(P.b, "steel", K.box(0, 0, 0.001, 0.022, 0.003, 0.002), tt(bl, f0 + travel * i / 4, TOP_S), TOP_R)
    piv = P.pivot("Ctl_flaps", tt(bl, f0, TOP_S), slide=np.array([0, travel, 0]))
    fl = M.merge([M.cylinder((0, 0, -0.01), (0, 0, 0.075), 0.0055, 8),
                  M.rounded_box((0, 0, 0.085), (0.050, 0.024, 0.016), 0.007, 2)])
    K.attach(P.b, "Ctl_flaps_mesh", K.mesh_data("flap_handle", fl, P.b.mats["placard"]), piv, TOP_R)
    P.hit("flaps", tt(bl, f0 + travel / 2, TOP_S + 0.09), (0.030, travel / 2 + 0.014, 0.018), frame=TOP_R,
          side=np.array([0, 1.0, 0]), extra={"lever": 1})
    for i, text in enumerate(("0", "1", "2", "3", "FULL")):
        label(P, text, tt(bl - 0.032, f0 + travel * i / 4, TOP_S), 0.0040, TOP_R)
    label(P, "FLAPS", tt(bl, f0 - 0.026, TOP_S), 0.0040, TOP_R)
    # Pitch trim wheels on both sides of the pedestal, turning together.
    for side, name in ((1, "Ctl_trim"), (-1, "TrimWheel_R")):
        c = np.array([side * (C.PED_HALF + 0.012), 3.66, C.PED_TOP_WL - 0.05])
        wheel = P.pivot(name, c, axis=np.array([1.0, 0, 0]))
        ribs = [M.rounded_box((0, 0.088 * math.sin(a), 0.088 * math.cos(a)), (0.022, 0.010, 0.008), 0.0, 1)
                for a in np.linspace(0, 2 * math.pi, 28, endpoint=False)]
        stripe = [M.rounded_box((0, 0.0, 0.089), (0.023, 0.03, 0.004), 0.0, 1)]
        w = M.merge([M.lathe([(-0.011, 0.0), (-0.011, 0.087), (0.011, 0.087), (0.011, 0.0)], (0, 0, 0), (1, 0, 0),
                             n=32, close_start=False, close_end=False)] + ribs)
        K.attach(P.b, f"{name}_mesh", K.shared("trim_wheel", lambda: w, P.b.mats["plastic_black"]), wheel, np.eye(3))
        K.attach(P.b, f"{name}_stripe", K.shared("trim_stripe", lambda: M.merge(stripe), P.b.mats["placard"]), wheel,
                 np.eye(3))
        P.hit("trim", c + np.array([side * 0.012, 0, 0.02]), (0.016, 0.07, 0.07), frame=np.eye(3),
              side=np.array([0, 0, 1.0]), suffix="" if side > 0 else "__fo")
    label(P, "PITCH TRIM", tt(0.20, 3.75, TOP_S), 0.0034, TOP_R)
    label(P, "NOSE DN", tt(0.215, 3.58, TOP_S), 0.0030, TOP_R)


def engine_panel(P):
    s = TOP_S
    for n, bl in ((1, 0.105), (2, 0.035)):
        toggle(P, f"engineMaster{n}", tt(bl, 3.91, s), TOP_R, detents=(-30.0, 30.0), big=True)
        label(P, f"ENG {n}", tt(bl, 3.945, s), 0.0040, TOP_R)
        P.label("FIRE FAULT", tt(bl, 3.875, s), 0.0030, frame=TOP_R, color=AMBER)
    label(P, "MASTER", tt(0.07, 3.96, s), 0.0034, TOP_R)
    rotary(P, "engineMode", tt(-0.09, 3.91, s), TOP_R, (45.0, 0.0, -45.0), ["CRANK", "NORM", "IGN START"],
           r=0.012, lh=0.0030)
    label(P, "MODE", tt(-0.09, 3.948, s), 0.0034, TOP_R)


def ecam_panel(P):
    s = TOP_S
    fs = 4.035
    for i in range(10):
        K.static(P.b, "korry", K.box(0, 0, 0.003, 0.017, 0.016, 0.006, 0.001, 1), tt(0.09 - i * 0.02, fs, s), TOP_R)
    P.display("ECP", tt(0.0, fs, s + 0.0064), *WINDOWS["ECP"], frame=TOP_R)
    P.pivot("Ctl_ecamPage", tt(0.0, fs, s + 0.003))
    P.hit("ecamPage", tt(0.0, fs, s + 0.006), (0.102, 0.010, 0.006), frame=TOP_R, side=0)
    label(P, "ECAM CONTROL", tt(0.0, fs + 0.018, s), 0.0034, TOP_R)
    for bl, text in ((0.19, "TO CONF"), (-0.19, "EMER CANC")):
        K.static(P.b, "korry", K.box(0, 0, 0.003, 0.020, 0.016, 0.006, 0.001, 1), tt(bl, fs, s), TOP_R)
        label(P, text, tt(bl, fs - 0.013, s), 0.0026, TOP_R)


def active_hit(P, cid, at):
    P.pivot(f"Ctl_{cid}", at)
    P.hit(cid, at, (0.022, 0.008, 0.004), frame=TOP_R, side=0)


def rmp(P):
    s = TOP_S
    for n, x0 in ((1, 0.250), (2, -0.010)):
        u = lambda d, x0=x0: x0 - d  # noqa: E731
        for row, fs, kind in ((0, 4.118, "COM"), (1, 4.165, "NAV")):
            P.display(f"RMP{n}_{kind}", tt(u(0.058), fs, s + 0.0004), *WINDOWS[f"RMP{n}_{kind}"], frame=TOP_R)
            low = kind.lower()
            active_hit(P, f"{low}{n}Active", tt(u(0.036), fs, s + 0.002))
            button(P, f"{low}{n}Swap", tt(u(0.122), fs, s), TOP_R, w=0.016, h=0.010)
            dual_knob(P, f"{low}{n}Standby", tt(u(0.165), fs, s), TOP_R, 1000)
            label(P, "ACTIVE", tt(u(0.036), fs + 0.0115, s), 0.0024, TOP_R)
            label(P, "STBY/CRS", tt(u(0.082), fs + 0.0115, s), 0.0024, TOP_R)
            label(P, f"VHF {n}" if kind == "COM" else f"NAV {n}", tt(u(0.205), fs, s), 0.0028, TOP_R, BLUE)
        fs = 4.215
        knob(P, f"obs{n}", tt(u(0.165), fs, s), TOP_R, r=0.0085, length=0.011, shape="crs")
        knob_hit(P, f"obs{n}", tt(u(0.165), fs, s), TOP_R, 0.0085, 0.011)
        label(P, f"CRS {n}", tt(u(0.165), fs + 0.0155, s), 0.0026, TOP_R)
        if n == 1:
            for i in range(4):
                dummy_korry(P, tt(u(0.025 + i * 0.03), fs, s), TOP_R, w=0.018, h=0.012)
        label(P, f"RMP {n}", tt(u(0.12), 4.245, s), 0.0028, TOP_R)
    # ADF on the second panel.
    P.display("ADF", tt(-0.050, 4.215, s + 0.0004), *WINDOWS["ADF"], frame=TOP_R)
    dual_knob(P, "adfFrequency", tt(-0.110, 4.215, s), TOP_R, 100)
    label(P, "ADF", tt(-0.050, 4.229, s), 0.0026, TOP_R, BLUE)


def atc(P):
    s = TOP_S
    fs = 4.300
    P.display("ATC", tt(0.170, fs, s + 0.0004), *WINDOWS["ATC"], frame=TOP_R)
    grp = P.pivot("Ctl_xpdrCode", tt(0.03, fs, s))
    for i in range(4):
        bl = 0.105 - i * 0.026
        at = tt(bl, fs, s)
        piv = P.pivot(f"XpdrDigit_{i}", at, axis=TOP_R[:, 2])
        M.parent_keep(piv, grp)
        K.attach(P.b, f"XpdrDigit_{i}_mesh", K.shared("digit_knob", lambda: K.knob(0.0062, 0.009, skirt=False),
                                                     P.b.mats["plastic_black"]), piv, TOP_R)
        P.hit("xpdrCode", tt(bl, fs, s + 0.005), (0.009, 0.009, 0.006), frame=TOP_R, side=0, step=10 ** (3 - i),
              suffix="" if i == 0 else f"__d{i}")
    rotary(P, "xpdrMode", tt(-0.120, fs, s), TOP_R, (60.0, 20.0, -20.0, -60.0), ["OFF", "STBY", "ON", "ALT"],
           r=0.009, lh=0.0028)
    button(P, "xpdrIdent", tt(0.225, fs, s), TOP_R, w=0.016, h=0.012)
    label(P, "IDENT", tt(0.225, fs + 0.016, s), 0.0024, TOP_R)
    label(P, "ATC", tt(0.170, fs - 0.0145, s), 0.0030, TOP_R, BLUE)
    label(P, "CODE", tt(0.065, fs - 0.0155, s), 0.0026, TOP_R)
    dummy_korry(P, tt(-0.20, fs, s), TOP_R, w=0.016, h=0.012)


def aft_pedestal(P):
    s = TOP_S
    fs = 4.405
    knob(P, "rudderTrim", tt(0.140, fs, s), TOP_R, r=0.011, length=0.014, shape="rud_trim")
    knob_hit(P, "rudderTrim", tt(0.140, fs, s), TOP_R, 0.011, 0.014)
    P.display("RUDTRIM", tt(0.065, fs, s + 0.0004), *WINDOWS["RUDTRIM"], frame=TOP_R)
    dummy_korry(P, tt(0.205, fs, s), TOP_R)
    label(P, "RUD TRIM", tt(0.140, fs + 0.024, s), 0.0030, TOP_R)
    label(P, "RESET", tt(0.205, fs - 0.015, s), 0.0024, TOP_R)
    label(P, "L    R", tt(0.140, fs - 0.020, s), 0.0024, TOP_R)
    # Parking brake: a T-handle turned a quarter turn.
    at = tt(-0.140, 4.41, s)
    piv = P.pivot("Ctl_parkingBrake", at, axis=np.array([0, 0, 1.0]), props={"detents": [0.0, -90.0]})
    h = M.merge([M.cylinder((0, 0, 0), (0, 0, 0.03), 0.008, 10),
                 M.rounded_box((0, 0, 0.035), (0.075, 0.020, 0.016), 0.007, 2)])
    K.attach(P.b, "Ctl_parkingBrake_mesh", K.mesh_data("park_brake", h, P.b.mats["plastic_black"]), piv, TOP_R)
    P.hit("parkingBrake", at + np.array([0, 0, 0.032]), (0.042, 0.042, 0.016), frame=np.eye(3))
    label(P, "PARK BRK", tt(-0.140, 4.452, s), 0.0030, TOP_R)
    label(P, "ON", tt(-0.140, 4.372, s), 0.0026, TOP_R)
    label(P, "OFF", tt(-0.195, 4.41, s), 0.0026, TOP_R)
    for i in range(2):
        dummy_knob(P, tt(-0.01 - i * 0.04, 4.41, s), TOP_R, 0.006)


def sidestick_button(P):
    top = P.b.parts["SidestickTop_L"]
    roll = P.b.parts["SidestickRoll_L"]
    at = top + np.array([0.0, -0.004, 0.012])
    frame = np.column_stack([(-1.0, 0, 0), (0, -1.0, 0), (0, 0, 1.0)])
    piv = P.pivot("Ctl_apDisconnect", at, slide=np.array([0, 0, -0.002]))
    K.attach(P.b, "Ctl_apDisconnect_mesh", K.mesh_data("ap_disc", K.revolve(
        [(0, 0.008, False), (0.004, 0.008, False), (0.006, 0.0065, False)], 16), P.b.mats["knob_red"]), piv, frame)
    M.parent_keep(piv, roll)
    P.hit("apDisconnect", at + np.array([0, 0, 0.006]), (0.011, 0.011, 0.008), frame=frame)
    label(P, "SIDE STICK PRIORITY", np.array([1.00, 3.65, C.CONSOLE_WL + 0.0075]), 0.004, C.TOP_R)


def build(b):
    KEYS.clear()
    P = K.Placer(b, PANEL_R, label_cols=10, label_rows=32)
    overhead(P)
    fcu(P)
    efis(P)
    main_panel(P)
    mcdu(P)
    thrust_quadrant(P)
    engine_panel(P)
    ecam_panel(P)
    rmp(P)
    atc(P)
    aft_pedestal(P)
    sidestick_button(P)
    P.flush_labels()
    print("legend keys:", len(KEYS), "labels:", len(P.labels))
    return P
