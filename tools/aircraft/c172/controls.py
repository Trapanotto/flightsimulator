"""
Operable controls of the Cessna 172S panel: switch row, ignition key, push-pull knobs, flap
lever, trim wheel and indicator, fuel selector and shutoff, the radio stack (audio panel, GPS,
two NAV/COMs, ADF, DME, transponder, autopilot), the annunciator panel and the knobs on the
gauges.

Naming (the loader and tests/aircraft read these; see src/aircraft/c172Parts.ts):
  Ctl_<id>         one node per control of C172_CONTROLS (src/sim/cockpit.ts). Pivots carry
                   extras.axis (rotation, model frame) and/or extras.slide (model-frame metres
                   at the end of the travel named in c172Parts.ts). Rest rotation is identity.
  Ctl_<id>_outer   the outer ring of a dual concentric knob (coarse step).
  XpdrDigit_<n>    the transponder's four code knobs, children of Ctl_xpdrCode.
  Hit_<id>[__...]  invisible hit boxes: extras.control, extras.half (model-frame half
                   extents of an axis-aligned box), extras.side (model-frame axis that splits
                   the box into a lower and an upper half, [0,0,0] without sides), optional
                   extras.step (what one click changes instead of the control's own step).
  Disp_<ID>        display windows the loader paints (UV 0..1, extras.size = [w, h] metres).
  Labels           every placard text as one mesh; extras.labels lists the texts in atlas cell
                   order, extras.cols/rows the atlas grid (cells are 4:1).

Shapes that repeat (rockers, knobs, buttons, shafts, flags) share one mesh datablock, so the
glTF has one mesh referenced by many nodes and the loader can draw each set instanced (the
shapes and the Placer live in lib/cockpit_kit.py).
"""

import math

import numpy as np

from lib import cockpit_kit as K
from lib import mesh as M
from lib.cockpit_kit import (box, button_shape, chicken_head, frame_plate, key_shape, knob,  # noqa: F401
                             mesh_data, model_vec, quad, revolve, ribbed_knob, rocker_shape, shaft_shape,
                             shared, smooth_knob, t_handle, to_design, toggle_bat, flag_shape,
                             selector_handle)
from . import cockpit as C

VX, VV, VN = C.VX, C.VV, C.VN
PANEL_R = np.column_stack([-VX, VV, VN])          # panel frame: x pilot's right, y up, z out
FLOOR_R = np.column_stack([(-1.0, 0, 0), (0, -1.0, 0), (0, 0, 1.0)])   # x right, y fwd, z up
AFT_R = np.column_stack([(-1.0, 0, 0), (0, 0, 1.0), (0, 1.0, 0)])      # pedestal aft face
LEFT_R = np.column_stack([(0, 1.0, 0), (0, 0, 1.0), (1.0, 0, 0)])      # pedestal left face

STACK_L, STACK_R = -0.030, -0.190     # BL of the radio stack's edges
STACK_FACE = 0.012                    # front of the avionics face plates (out of the panel)

LABEL_COLS, LABEL_ROWS = 8, 20


def attach(b, name, me, pivot, frame=PANEL_R, offset=(0.0, 0.0, 0.0)):
    return K.attach(b, name, me, pivot, frame, offset)


def static(b, key, vf, origin, frame=PANEL_R):
    return K.static(b, key, vf, origin, frame)


def pp(bl, v, s=0.0):
    return C.pp(bl, v, s)


def stack(u, y_from_top, top, s=STACK_FACE):
    """Point on the radio stack: u metres right of its left edge, y below a unit's top."""
    return pp(STACK_L - u, top - y_from_top, s)


# ---------------------------------------------------------------------------
# The controls
# ---------------------------------------------------------------------------

def rocker(P, cid, bl, v, mat_key):
    b = P.b
    at = pp(bl, v, 0.001)
    static(b, "plastic_black", frame_plate(0.0125, 0.0225, 0.0025), pp(bl, v))
    piv = P.pivot(f"Ctl_{cid}", at, axis=VX)
    attach(b, f"Ctl_{cid}_mesh", shared(f"rocker_{mat_key}", rocker_shape, b.mats[mat_key]), piv)
    P.hit(cid, pp(bl, v, 0.005), (0.0072, 0.0125, 0.006))


def switch_row(P):
    b = P.b
    v = 0.040
    # Split master: ALT on the left half, BAT on the right.
    rocker(P, "alternator", 0.4265, v, "knob_red")
    rocker(P, "battery", 0.4145, v, "knob_red")
    P.label("ALT", pp(0.4265, v - 0.017), 0.0035)
    P.label("BAT", pp(0.4145, v - 0.017), 0.0035)
    P.label("MASTER", pp(0.4205, v + 0.0178), 0.0044)
    row = [("fuelPump", "FUEL PUMP"), ("lightBeacon", "BCN"), ("lightLanding", "LAND"), ("lightTaxi", "TAXI"),
           ("lightNav", "NAV"), ("lightStrobe", "STROBE"), ("pitotHeat", "PITOT HT")]
    for i, (cid, text) in enumerate(row):
        bl = 0.385 - i * 0.0215
        rocker(P, cid, bl, v, "plastic_black")
        P.label(text, pp(bl, v + 0.0178), 0.0044)
    P.label("OFF", pp(0.32, v - 0.0175), 0.003)
    rocker(P, "avionics", 0.175, v, "plastic_black")
    P.label("AVIONICS", pp(0.175, v + 0.0178), 0.0044)
    P.label("MASTER", pp(0.175, v - 0.017), 0.003)


def ignition(P):
    b = P.b
    bl, v = 0.470, 0.031
    c = pp(bl, v)
    static(b, "steel", revolve([(0, 0.0125, False), (0.003, 0.0125, False), (0.0045, 0.0105, False),
                                (0.0055, 0.004, False)], 28), c)
    piv = P.pivot("Ctl_magnetos", pp(bl, v, 0.0045), axis=VN)
    attach(b, "Ctl_magnetos_mesh", mesh_data("key", key_shape(), b.mats["plastic_black"]), piv)
    P.hit("magnetos", pp(bl, v, 0.008), (0.014, 0.014, 0.009), side=0)
    # Position names around the lock, clockwise from OFF.
    for text, ang in (("OFF", -75), ("R", -45), ("L", -15), ("BOTH", 15), ("START", 50)):
        a = math.radians(ang)
        r = 0.0185
        P.label(text, pp(bl - r * math.sin(a), v + r * math.cos(a)), 0.0026 if len(text) > 1 else 0.0028)


def push_pull(P, cid, bl, v, shape, mat_key, travel, hit_r, reach, label=None, label_dv=0.0):
    """A knob on a shaft that slides out of the panel (extras.slide = full travel out)."""
    b = P.b
    at = pp(bl, v)
    static(b, "steel", revolve([(0, 0.0065, False), (0.002, 0.0065, False), (0.0025, 0.0045, False)], 16), at)
    piv = P.pivot(f"Ctl_{cid}", at, slide=VN * travel)
    attach(b, f"Ctl_{cid}_shaft", shared("shaft", shaft_shape, b.mats["chrome"]), piv)
    attach(b, f"Ctl_{cid}_mesh", mesh_data(f"knob_{cid}", shape, b.mats[mat_key]), piv, offset=(0, 0, 0.004))
    P.hit(cid, pp(bl, v, (reach + travel) / 2), (hit_r, hit_r, (reach + travel) / 2 + 0.004), side=1)
    if label:
        P.label(label, pp(bl, v + label_dv), 0.0034)


def lower_panel(P):
    b = P.b
    v = 0.035
    push_pull(P, "throttle", -0.065, v, smooth_knob(0.019, 0.024), "plastic_black", 0.065, 0.022, 0.03,
              "THROTTLE", -0.028)
    push_pull(P, "mixture", -0.150, v, ribbed_knob(0.017, 0.022), "knob_red", 0.065, 0.02, 0.028,
              "MIXTURE", -0.028)
    push_pull(P, "carbHeat", 0.035, v, smooth_knob(0.011, 0.016), "plastic_black", 0.03, 0.014, 0.022,
              "ALT AIR", -0.021)
    # Parking brake: a T-handle under the lower edge of the panel, pulled out when set.
    at = pp(0.100, 0.012)
    piv = P.pivot("Ctl_parkingBrake", at, slide=VN * 0.035)
    attach(b, "Ctl_parkingBrake_mesh", mesh_data("park_brake", t_handle(0.038, 0.012), b.mats["plastic_black"]), piv)
    P.hit("parkingBrake", pp(0.100, 0.012, 0.03), (0.024, 0.009, 0.032))
    P.label("PARK BRAKE", pp(0.100, 0.026), 0.0034)
    # Panel light dimmer.
    at = pp(0.130, 0.056)
    piv = P.pivot("Ctl_lightPanel", at, axis=VN)
    attach(b, "Ctl_lightPanel_mesh", shared("gauge_knob", lambda: knob(0.0062, 0.011), b.mats["plastic_black"]), piv)
    P.hit("lightPanel", pp(0.130, 0.056, 0.006), (0.0095, 0.0095, 0.008), side=0)
    P.label("PANEL LT", pp(0.130, 0.072), 0.0032)
    P.label("DIM", pp(0.142, 0.046), 0.0024)
    P.label("BRT", pp(0.118, 0.046), 0.0024)


def flap_lever(P):
    b = P.b
    bl = -0.215
    slot_top, travel = 0.155, 0.08
    static(b, "plastic_black", box(0, 0, 0.001, 0.008, travel + 0.022, 0.002), pp(bl, slot_top - travel / 2))
    piv = P.pivot("Ctl_flaps", pp(bl, slot_top), slide=-VV * travel)
    handle = M.merge([M.cylinder((0, 0, -0.01), (0, 0, 0.03), 0.004, 8), box(0, 0, 0.034, 0.03, 0.012, 0.012, 0.003, 2)])
    attach(b, "Ctl_flaps_mesh", mesh_data("flap_handle", handle, b.mats["placard"]), piv)
    P.hit("flaps", pp(bl, slot_top - travel / 2, 0.034), (0.019, travel / 2 + 0.01, 0.012), side=1,
          extra={"lever": 1})
    for i, text in enumerate(("0", "10", "20", "FULL")):
        P.label(text, pp(bl - 0.026, slot_top - travel * i / 3), 0.0036)
    P.label("FLAPS", pp(bl, slot_top + 0.013), 0.0036)


def trim(P):
    b = P.b
    tc = np.array([-0.025, 0.66, 0.92])
    piv = P.pivot("Ctl_trim", tc, axis=(-1, 0, 0))
    wheel = M.lathe([(-0.008, 0.0), (-0.008, 0.07), (0.0, 0.075), (0.008, 0.07), (0.008, 0.0)], (0, 0, 0), (1, 0, 0),
                    n=32, close_start=False, close_end=False)
    marks = [M.rounded_box((0, 0.076 * math.sin(a), 0.076 * math.cos(a)), (0.018, 0.006, 0.006), 0.0, 1)
             for a in np.linspace(0, 2 * math.pi, 16, endpoint=False)]
    attach(b, "Ctl_trim_mesh", mesh_data("trim_wheel", M.merge([wheel] + marks), b.mats["plastic_black"], sharp=50),
           piv, frame=np.eye(3))
    P.hit("trim", tc, (0.016, 0.08, 0.08), frame=np.eye(3), side=np.array([0, 0, 1.0]))
    # Position indicator on the pedestal's left face, just ahead of the wheel.
    ic = np.array([-0.024, 0.545, 0.935])
    static(b, "plastic_black", box(0, 0, 0.001, 0.014, 0.075, 0.002), ic, frame=LEFT_R)
    piv = P.pivot("TrimInd", ic + np.array([0.002, 0, 0]), slide=np.array([0, 0, -0.03]))
    attach(b, "TrimInd_mesh", mesh_data("trim_ind", box(0, 0, 0.001, 0.013, 0.003, 0.002), b.mats["needle_orange"]),
           piv, frame=LEFT_R)
    P.label("NOSE DN", ic + np.array([0, -0.0, 0.045]), 0.0034, frame=LEFT_R)
    P.label("NOSE UP", ic + np.array([0, 0.0, -0.045]), 0.0034, frame=LEFT_R)
    P.label("TAKE OFF", ic + np.array([0, -0.026, 0.0]), 0.0028, frame=LEFT_R)


def fuel(P):
    b = P.b
    c = np.array([-0.110, 0.800, 0.803])
    static(b, "steel", M.cylinder((0, 0, 0), (0, 0, 0.006), 0.058, 32), c, frame=FLOOR_R)
    piv = P.pivot("Ctl_fuelSelector", c + np.array([0, 0, 0.006]), axis=(0, 0, 1.0))
    attach(b, "Ctl_fuelSelector_mesh", mesh_data("fuel_handle", selector_handle(), b.mats["knob_red"]), piv,
           frame=FLOOR_R)
    P.hit("fuelSelector", c + np.array([0, 0, 0.015]), (0.06, 0.06, 0.016), frame=FLOOR_R, side=0)
    for text, ang in (("LEFT", 75), ("BOTH", 0), ("RIGHT", -75)):
        a = math.radians(ang)
        # Floor frame offsets: x to the pilot's right, y forward.
        off = FLOOR_R @ np.array([-0.046 * math.sin(a), 0.046 * math.cos(a), 0.0065])
        P.label(text, c + off, 0.0055, frame=FLOOR_R)
    P.label("FUEL SELECTOR", c + FLOOR_R @ np.array([0, -0.068, -0.0025]), 0.006, frame=FLOOR_R)
    # Shutoff valve: a red push-pull knob on the pedestal's aft face, pulled out = closed.
    at = np.array([-0.110, 0.640, 0.885])
    static(b, "steel", revolve([(0, 0.007, False), (0.002, 0.007, False), (0.0025, 0.005, False)], 16), at,
           frame=AFT_R)
    piv = P.pivot("Ctl_fuelShutoff", at, slide=np.array([0, 0.03, 0]))
    attach(b, "Ctl_fuelShutoff_shaft", shared("shaft", shaft_shape, b.mats["chrome"]), piv, frame=AFT_R)
    attach(b, "Ctl_fuelShutoff_mesh", mesh_data("knob_shutoff", ribbed_knob(0.012, 0.02), b.mats["knob_red"]), piv,
           frame=AFT_R, offset=(0, 0, 0.004))
    P.hit("fuelShutoff", at + np.array([0, 0.026, 0]), (0.016, 0.016, 0.028), frame=AFT_R)
    P.label("FUEL SHUTOFF", at + np.array([0, 0.0005, 0.022]), 0.0045, frame=AFT_R)
    P.label("PULL OFF", at + np.array([0, 0.0005, -0.019]), 0.0035, frame=AFT_R)


def gauge_knobs(P):
    b = P.b
    for cid, gid, du in (("obs1", "CDI1", 1), ("obs2", "CDI2", 1), ("altimeterSetting", "ALT", 1),
                         ("gyroAdjust", "HI", 1), ("headingBug", "HI", -1)):
        bl, v, r = C.GAUGES[gid]
        kb, kv = bl + du * 0.036, v - 0.036
        at = pp(kb, kv)
        static(b, "plastic_black", revolve([(0, 0.0085, False), (0.0015, 0.0085, False), (0.0022, 0.007, False)], 20), at)
        piv = P.pivot(f"Ctl_{cid}", pp(kb, kv, 0.001), axis=VN)
        attach(b, f"Ctl_{cid}_mesh", shared("gauge_knob", lambda: knob(0.0062, 0.011), b.mats["plastic_black"]), piv)
        P.hit(cid, pp(kb, kv, 0.007), (0.0105, 0.0105, 0.008), side=0)
    bl, v, _ = C.GAUGES["HI"]
    P.label("HDG", pp(bl - 0.036, v - 0.050), 0.0028)


# ---------------------------------------------------------------------------
# Radio stack
# ---------------------------------------------------------------------------

UNITS = (  # name, top (panel v), height
    ("AUDIO", 0.380, 0.028),
    ("GPS", 0.350, 0.054),
    ("NAVCOM1", 0.294, 0.046),
    ("NAVCOM2", 0.246, 0.046),
    ("ADF", 0.198, 0.032),
    ("DME", 0.164, 0.028),
    ("XPDR", 0.134, 0.032),
    ("AP", 0.100, 0.032),
)
STACK_W = STACK_L - STACK_R


def face_plates(b):
    xc = 0.5 * (STACK_L + STACK_R)
    for _, top, h in UNITS:
        static(b, "avionics_face", box(0, 0, STACK_FACE / 2, STACK_W * 0.99, h * 0.96, STACK_FACE, 0.0015, 1),
               pp(xc, top - h / 2))


def dual_knob(P, cid, at_u, at_y, top, coarse_step):
    b = P.b
    at = stack(at_u, at_y, top)
    outer = P.pivot(f"Ctl_{cid}_outer", at, axis=VN)
    attach(b, f"Ctl_{cid}_outer_mesh", shared("radio_outer", lambda: knob(0.0088, 0.005, skirt=False),
                                              b.mats["plastic_black"]), outer)
    inner = P.pivot(f"Ctl_{cid}", at, axis=VN)
    attach(b, f"Ctl_{cid}_mesh", shared("radio_inner", lambda: knob(0.0052, 0.0065, z0=0.005, skirt=False),
                                        b.mats["plastic_black"]), inner)
    P.hit(cid, stack(at_u, at_y, top, STACK_FACE + 0.0085), (0.0062, 0.0062, 0.0035), side=0)
    P.hit(cid, stack(at_u, at_y, top, STACK_FACE + 0.003), (0.011, 0.011, 0.004), side=0, step=coarse_step,
          suffix="__coarse")


def button(P, cid, at_u, at_y, top, label=None, label_dy=-0.0062):
    b = P.b
    at = stack(at_u, at_y, top)
    piv = P.pivot(f"Ctl_{cid}", at, slide=-VN * 0.0016)
    attach(b, f"Ctl_{cid}_mesh", shared("button", button_shape, b.mats["plastic_black"]), piv)
    P.hit(cid, stack(at_u, at_y, top, STACK_FACE + 0.003), (0.0062, 0.0042, 0.004))
    if label:
        P.label(label, stack(at_u, at_y + label_dy, top), 0.0026)


def dummy_button(P, at_u, at_y, top, label=None, label_dy=-0.0062):
    static(P.b, "plastic_black", button_shape(), stack(at_u, at_y, top))
    if label:
        P.label(label, stack(at_u, at_y + label_dy, top), 0.0026)


def dummy_knob(P, at_u, at_y, top, r=0.0055):
    static(P.b, "plastic_black", knob(r, 0.008, skirt=False), stack(at_u, at_y, top))


def active_hit(P, cid, did_center_u, y, top, w, h):
    """The active-frequency half of a display: a click tunes it directly."""
    at = stack(did_center_u, y, top, STACK_FACE + 0.001)
    P.pivot(f"Ctl_{cid}", at)
    P.hit(cid, at, (w / 2, h / 2 + 0.001, 0.003), side=0)


def radio_stack(P):
    b = P.b
    face_plates(b)
    tops = {n: (t, h) for n, t, h in UNITS}
    # Audio panel (dummy) with the marker beacon lamps.
    top, h = tops["AUDIO"]
    P.display("MKR", stack(0.020, h / 2, top), 0.024, 0.008)
    for i, text in enumerate(("COM1", "COM2", "BOTH", "NAV1", "NAV2", "DME", "ADF", "MKR")):
        dummy_button(P, 0.042 + i * 0.0145, h / 2 + 0.003, top, text, label_dy=-0.0068)
    P.label("O  M  I", stack(0.020, h / 2 - 0.007, top), 0.0024)
    # GPS: map display, the CDI key (which source the VOR/ILS indicator 1 follows), dummies.
    top, h = tops["GPS"]
    P.display("GPS", stack(0.078, h / 2, top), 0.084, 0.046)
    button(P, "navSource", 0.017, 0.040, top, "CDI")
    dummy_knob(P, 0.017, 0.013, top)
    for i, text in enumerate(("D>", "MENU", "ENT")):
        dummy_button(P, 0.145, 0.010 + i * 0.0135, top, None)
        P.label(text, stack(0.1315, 0.010 + i * 0.0135, top), 0.0024)
    dummy_knob(P, 0.145, 0.047, top, 0.0045)
    # Two NAV/COMs: COM on the left, NAV on the right, each with its flip-flop key.
    for n in (1, 2):
        top, h = tops[f"NAVCOM{n}"]
        P.display(f"COM{n}", stack(0.047, 0.013, top), 0.050, 0.013)
        P.display(f"NAV{n}", stack(0.113, 0.013, top), 0.050, 0.013)
        button(P, f"com{n}Swap", 0.047, 0.031, top)
        button(P, f"nav{n}Swap", 0.113, 0.031, top)
        P.label("<->", stack(0.047, 0.040, top), 0.0026)
        P.label("<->", stack(0.113, 0.040, top), 0.0026)
        P.label(f"COM {n}", stack(0.028, 0.031, top), 0.0026)
        P.label(f"NAV {n}", stack(0.132, 0.031, top), 0.0026)
        dual_knob(P, f"com{n}Standby", 0.011, 0.033, top, 1000)
        dual_knob(P, f"nav{n}Standby", 0.149, 0.033, top, 1000)
        dummy_knob(P, 0.011, 0.011, top, 0.0045)
        dummy_knob(P, 0.149, 0.011, top, 0.0045)
        active_hit(P, f"com{n}Active", 0.0345, 0.013, top, 0.025, 0.013)
        active_hit(P, f"nav{n}Active", 0.1005, 0.013, top, 0.025, 0.013)
    # ADF receiver.
    top, h = tops["ADF"]
    P.display("ADF", stack(0.062, 0.011, top), 0.064, 0.012)
    for i, text in enumerate(("ADF", "BFO", "FRQ", "FLT/ET")):
        dummy_button(P, 0.036 + i * 0.017, 0.026, top, None)
        P.label(text, stack(0.036 + i * 0.017, 0.0195, top), 0.0022)
    dual_knob(P, "adfFrequency", 0.146, 0.017, top, 100)
    dummy_knob(P, 0.012, 0.017, top, 0.0045)
    # DME with its NAV 1 / NAV 2 toggle.
    top, h = tops["DME"]
    P.display("DME", stack(0.070, 0.012, top), 0.070, 0.012)
    at = stack(0.135, 0.016, top)
    static(b, "steel", revolve([(0, 0.004, False), (0.0012, 0.004, False)], 14), at)
    piv = P.pivot("Ctl_dmeSource", at, axis=VV)
    attach(b, "Ctl_dmeSource_mesh", mesh_data("dme_toggle", toggle_bat(), b.mats["chrome"]), piv)
    P.hit("dmeSource", stack(0.135, 0.016, top, STACK_FACE + 0.005), (0.009, 0.008, 0.006), side=0)
    P.label("N1", stack(0.124, 0.022, top), 0.0026)
    P.label("N2", stack(0.146, 0.022, top), 0.0026)
    dummy_knob(P, 0.016, 0.014, top, 0.0045)
    # Transponder: mode selector, the four code knobs, IDENT.
    top, h = tops["XPDR"]
    P.display("XPDR", stack(0.080, 0.0085, top), 0.052, 0.0095)
    at = stack(0.016, 0.018, top)
    piv = P.pivot("Ctl_xpdrMode", at, axis=VN)
    attach(b, "Ctl_xpdrMode_mesh", mesh_data("xpdr_mode", chicken_head(0.0055, 0.006), b.mats["plastic_black"]), piv)
    P.hit("xpdrMode", stack(0.016, 0.018, top, STACK_FACE + 0.005), (0.009, 0.009, 0.006), side=0)
    for text, ang in (("OFF", -60), ("SBY", -20), ("ON", 20), ("ALT", 60)):
        a = math.radians(ang)
        P.label(text, stack(0.016 + 0.0115 * math.sin(a), 0.018 - 0.0115 * math.cos(a), top), 0.0022)
    grp = P.pivot("Ctl_xpdrCode", stack(0.080, 0.023, top))
    for i in range(4):
        u = 0.0605 + i * 0.013
        at = stack(u, 0.023, top)
        piv = P.pivot(f"XpdrDigit_{i}", at, axis=VN)
        M.parent_keep(piv, grp)
        attach(b, f"XpdrDigit_{i}_mesh", shared("digit_knob", lambda: knob(0.0044, 0.0075, skirt=False),
                                                b.mats["plastic_black"]), piv)
        P.hit("xpdrCode", stack(u, 0.023, top, STACK_FACE + 0.004), (0.0063, 0.0068, 0.005), side=0,
              step=10 ** (3 - i), suffix="" if i == 0 else f"__d{i}")
    button(P, "xpdrIdent", 0.139, 0.023, top, "IDT", label_dy=0.0065)
    # Autopilot (KAP 140 style): mode keys, display, UP/DN, altitude knob.
    top, h = tops["AP"]
    P.display("AP", stack(0.050, 0.0095, top), 0.074, 0.0115)
    for i, (cid, text) in enumerate((("apEngage", "AP"), ("apHdg", "HDG"), ("apNav", "NAV"), ("apApr", "APR"),
                                     (None, "REV"), ("apAlt", "ALT"))):
        u = 0.014 + i * 0.0145
        if cid:
            button(P, cid, u, 0.0255, top)
        else:
            dummy_button(P, u, 0.0255, top)
        P.label(text, stack(u, 0.0185, top), 0.0021)
    button(P, "apVsUp", 0.107, 0.010, top)
    button(P, "apVsDown", 0.107, 0.0235, top)
    P.label("UP", stack(0.0975, 0.010, top), 0.0021)
    P.label("DN", stack(0.0975, 0.0235, top), 0.0021)
    dual_knob(P, "apAltitude", 0.145, 0.017, top, 1000)


def annunciators(P):
    P.display("ANN", pp(0.250, 0.364, 0.0015), 0.16, 0.014)
    static(P.b, "plastic_black", frame_plate(0.166, 0.020, 0.003, 0.003), pp(0.250, 0.364))
    # The altimeter setting window on the altimeter's face (a drum behind the dial).
    bl, v, r = C.GAUGES["ALT"]
    P.display("KOLL", pp(bl - 0.49 * r, v, 0.0019), 0.38 * r, 0.2 * r)


def build(b):
    P = K.Placer(b, PANEL_R, LABEL_COLS, LABEL_ROWS)
    switch_row(P)
    ignition(P)
    lower_panel(P)
    flap_lever(P)
    trim(P)
    fuel(P)
    gauge_knobs(P)
    radio_stack(P)
    annunciators(P)
    P.flush_labels()
    return P
