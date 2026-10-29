"""
Detailed cockpits: shaped instrument panel with live display surfaces, glareshield with the
autopilot panel, pedestal with throttle levers, overhead panel, side consoles, pilot seats,
rudder pedals and moving yokes / side sticks.

Naming contract with the game (src/aircraft/Cockpit.ts):
  Display_<KIND>_<n>     flat quad with UV 0..1 (u = left -> right, v = bottom -> top as the
                         pilot sees it); the game draws <KIND> on it (PFD, ND, MFD, EICAS, ...)
  Yoke_L / Yoke_R        wheel on a shaft through the panel: rolls about local Z (nose axis),
                         slides along local Z for pitch
  Column_L/R, Wheel_L/R  floor column (747): the column pitches about local X at the floor,
                         the wheel sits on top of it and rolls about local Z
  Stick_L / Stick_R      side stick: pitch about local X, roll about local Z at its base
  Throttle_<n>           lever: rotates about local X at its hinge (forward = more thrust)
  Knob_Throttle          push-pull knob (C172): slides along local Z
All pivots are axis-aligned with the aircraft (no rotation), so local axes = aircraft axes.

Blender frame as elsewhere: +X = pilot's left, -Y = forward, +Z = up.
"""

import math

from mathutils import Vector

from . import geometry as g


def materials(principled, srgb):
    """Cockpit materials (not part of the livery atlas)."""
    return dict(
        ck_panel=principled("CkPanel", srgb(0.17, 0.18, 0.19), 0.72),
        ck_shield=principled("CkGlareshield", srgb(0.07, 0.07, 0.075), 0.9),
        ck_bezel=principled("CkBezel", srgb(0.045, 0.045, 0.05), 0.45),
        ck_display=principled("Display", srgb(0.01, 0.012, 0.015), 0.15),
        ck_knob=principled("CkKnob", srgb(0.03, 0.03, 0.03), 0.5),
        ck_switch=principled("CkSwitch", srgb(0.75, 0.76, 0.78), 0.3, 0.9),
        ck_light=principled("CkAnnunciator", srgb(0.9, 0.62, 0.12), 0.4,
                            emission=(1.0, 0.6, 0.1), strength=1.2),
        ck_green=principled("CkGreenLight", srgb(0.2, 0.9, 0.3), 0.4,
                            emission=(0.2, 1.0, 0.3), strength=0.8),
        ck_seat=principled("CkSeat", srgb(0.12, 0.13, 0.16), 0.85),
        ck_leather=principled("CkLeather", srgb(0.30, 0.22, 0.16), 0.6),
        ck_lever=principled("CkLever", srgb(0.62, 0.63, 0.65), 0.3, 1.0),
        ck_handle=principled("CkHandle", srgb(0.06, 0.06, 0.06), 0.55),
        ck_white=principled("CkWhiteKnob", srgb(0.85, 0.85, 0.83), 0.4),
        ck_red=principled("CkRedKnob", srgb(0.7, 0.06, 0.05), 0.4),
        ck_yellow=principled("CkYellow", srgb(0.95, 0.75, 0.05), 0.5),
        ck_carpet=principled("CkCarpet", srgb(0.10, 0.10, 0.11), 0.95),
    )


# ---------------------------------------------------------------------------
# Frames: tilted planes (panel face, glareshield face, pedestal top, overhead)
# ---------------------------------------------------------------------------

class Frame:
    """
    A plane in the cockpit. R = pilot's right (-X), U = up as the pilot reads it, N = R x U
    (towards the pilot). p(x, b, c): Blender x, b along U, c along N.
    """

    def __init__(self, y, z, up):
        self.o = Vector((0.0, y, z))
        self.R = Vector((-1.0, 0.0, 0.0))
        self.U = Vector(up).normalized()
        self.N = self.R.cross(self.U).normalized()

    @staticmethod
    def panel(y, z, tilt_deg):
        """Instrument panel, the top leaning forward by tilt_deg."""
        t = math.radians(tilt_deg)
        return Frame(y, z, (0, -math.sin(t), math.cos(t)))

    def p(self, x, b=0.0, c=0.0):
        return Vector((x, self.o.y, self.o.z)) + self.U * b + self.N * c

    def box(self, x, b, c, sx, sb, sc):
        """Box with its faces on this frame (axes R, U, N), centred at p(x, b, c)."""
        ctr = self.p(x, b, c)
        h = (sx / 2, sb / 2, sc / 2)
        axes = (self.R, self.U, self.N)
        v = [tuple(ctr + axes[0] * (i * h[0]) + axes[1] * (j * h[1]) + axes[2] * (k * h[2]))
             for i in (-1, 1) for j in (-1, 1) for k in (-1, 1)]
        f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
        return v, f

    def knob(self, x, b, r, depth=0.018, c=0.0, seg=12):
        p0 = self.p(x, b, c)
        return g.cylinder(p0, p0 + self.N * depth, r, seg)

    def ring(self, x, b, r_in, r_out, depth, seg=32):
        """Round instrument bezel: annulus standing `depth` proud of the face."""
        rings = []
        for c, r in ((0.0, r_out), (depth, r_out), (depth, r_in), (0.0, r_in)):
            ctr = self.p(x, b, c)
            rings.append([tuple(ctr + r * (math.cos(2 * math.pi * k / seg) * self.R
                                           + math.sin(2 * math.pi * k / seg) * self.U))
                          for k in range(seg)])
        v, f = g.loft(rings + [rings[0]])
        return v, f


def display(col, name, frame, x, b, w, h, mat, c=0.008):
    """Flat display quad with UV 0..1 as the pilot sees it."""
    bl = frame.p(x, b - h / 2, c) - frame.R * (w / 2)
    br = frame.p(x, b - h / 2, c) + frame.R * (w / 2)
    tr = frame.p(x, b + h / 2, c) + frame.R * (w / 2)
    tl = frame.p(x, b + h / 2, c) - frame.R * (w / 2)
    obj = g.make_object(name, [tuple(bl), tuple(br), tuple(tr), tuple(tl)], [(0, 1, 2, 3)],
                        col, mat)
    me = obj.data
    uv = me.uv_layers.new(name="UVMap")
    for loop, coord in zip(me.polygons[0].loop_indices, ((0, 0), (1, 0), (1, 1), (0, 1))):
        uv.data[loop].uv = coord
    for p in me.polygons:
        p.use_smooth = False
    return obj


def bezel(frame, x, b, w, h, keys=False, knobs=False, margin=0.018):
    """Dark frame around a display, optionally with soft keys (G1000 style) and corner knobs."""
    parts = [frame.box(x, b, 0.0, w + 2 * margin, h + 2 * margin, 0.012)]
    small = []
    if keys:
        n = 12
        for i in range(n):
            kx = x + w / 2 - (i + 0.5) * w / n
            small.append(frame.box(kx, b - h / 2 - margin * 0.55, 0.008, w / n * 0.62, 0.008, 0.008))
        for side in (1, -1):
            for j in range(4):
                small.append(frame.box(x + side * (w / 2 + margin * 0.5), b + h / 2 - 0.02 - j * h / 4.5,
                                       0.008, 0.007, 0.012, 0.008))
    if knobs:
        for side in (1, -1):
            for j in (0, 1):
                small.append(frame.knob(x + side * (w / 2 + margin * 0.55), b + (0.35 - 0.7 * j) * h,
                                        0.008, 0.014, 0.006, 10))
    return parts, small


# ---------------------------------------------------------------------------
# Controls (each its own object with a pivot)
# ---------------------------------------------------------------------------

def yoke(col, m, name, x, y_panel, y_wheel, z, span=0.30, style="ga"):
    """Control wheel on a shaft coming out of the panel; pivot = wheel centre."""
    c = Vector((x, y_wheel, z))
    shaft = g.cylinder((x, y_panel, z), (x, y_wheel - 0.03, z), 0.018 if style == "ga" else 0.025, 12)
    hs = span / 2
    if style == "ga":
        # Ram's-horn: grips rising from a low cross bar.
        pts = [Vector((hs * k, 0, dz)) for k, dz in
               ((-0.92, 0.075), (-1.0, 0.0), (-0.85, -0.045), (-0.4, -0.06), (0.4, -0.06),
                (0.85, -0.045), (1.0, 0.0), (0.92, 0.075))]
    else:
        # Airliner wheel: open at the top so the PFD stays visible.
        pts = [Vector((hs * math.sin(a), 0, 0.6 * hs * math.cos(a))) for a in
               [math.radians(d) for d in range(55, 306, 25)]]
    grip = g.tube([c + p for p in pts], 0.016 if style == "ga" else 0.019, 10)
    hub = g.box(x, y_wheel, z - 0.01, 0.12 if style == "ga" else 0.16, 0.035, 0.06)
    groups = [(*g.merge_parts([shaft]), m["ck_lever"]), (*grip, m["ck_handle"]), (*hub, m["ck_bezel"])]
    if style == "ga":
        # PTT / trim switches on the left grip, a clip board strip on the hub.
        groups.append((*g.box(x + hs * 0.95, y_wheel + 0.01, z + 0.07, 0.012, 0.012, 0.01),
                       m["ck_red"]))
        groups.append((*g.box(x, y_wheel + 0.02, z - 0.005, 0.08, 0.004, 0.025), m["ck_switch"]))
    obj = g.multi_material(name, groups, col, smooth_angle=50)
    obj["spin_center"] = tuple(c)
    return obj


def column(col, m, side, x, y, floor_z, z_wheel, span=0.34):
    """747 control column from the floor; separate wheel on top (Column_*, Wheel_*)."""
    base = Vector((x, y, floor_z + 0.05))
    top = Vector((x, y - 0.06, z_wheel - 0.05))
    col_parts = [g.tube([base, base + Vector((0, -0.02, 0.25)), top], 0.035, 12),
                 g.box(x, y, floor_z + 0.04, 0.14, 0.22, 0.08)]
    co = g.make_object(f"Column_{side}", *g.merge_parts(col_parts), col, m["ck_panel"], smooth_angle=50)
    co["spin_center"] = tuple(base)
    hs = span / 2
    c = Vector((x, y - 0.06, z_wheel))
    pts = [Vector((hs * math.sin(a), 0, 0.62 * hs * math.cos(a))) for a in
           [math.radians(d) for d in range(50, 311, 20)]]
    grip = g.tube([c + p for p in pts], 0.02, 10)
    hub = g.box(c.x, c.y, c.z - 0.02, 0.18, 0.05, 0.09)
    wh = g.multi_material(f"Wheel_{side}", [(*grip, m["ck_handle"]), (*hub, m["ck_bezel"])], col,
                          smooth_angle=50)
    wh["spin_center"] = tuple(c)
    return co, wh


def side_stick(col, m, name, x, y, z):
    """Side stick on a console; pivot at the base of the grip."""
    base = Vector((x, y, z))
    boot = g.lathe([(0.0, 0.045), (0.02, 0.04), (0.045, 0.022)], base, (0, 0, 1), 16, cap_start=True)
    grip_pts = [base + Vector((0, 0, 0.03)), base + Vector((0, -0.01, 0.09)),
                base + Vector((0, -0.005, 0.15))]
    grip = g.tube(grip_pts, 0.022, 14, radii=[0.018, 0.024, 0.021])
    top = g.ellipsoid(base + Vector((0, -0.008, 0.16)), 0.024, 0.03, 0.02, 12, 6)
    trigger = g.box(x, y - 0.03, z + 0.115, 0.012, 0.015, 0.03)
    button = g.cylinder(base + Vector((0.01, -0.005, 0.175)), base + Vector((0.01, -0.005, 0.183)),
                        0.007, 8)
    obj = g.multi_material(name, [(*boot, m["ck_bezel"]), (*g.merge_parts([grip, top]), m["ck_handle"]),
                                  (*trigger, m["ck_lever"]), (*button, m["ck_red"])], col, smooth_angle=50)
    obj["spin_center"] = tuple(base)
    return obj


def lever(col, m, name, x, y, z, length=0.16, handle="airliner", knob_mat=None):
    """Throttle (or other) lever standing up from its hinge; pivot = hinge."""
    base = Vector((x, y, z))
    tip = base + Vector((0, 0.03, length))
    arm = g.cylinder(base, tip, 0.008, 8)
    if handle == "airliner":
        grip = g.box(x, tip.y + 0.01, tip.z + 0.012, 0.045, 0.05, 0.03)
    elif handle == "hotas":
        grip = g.ellipsoid(tip + Vector((0.01, 0.0, 0.03)), 0.035, 0.06, 0.045, 12, 8)
    else:  # small round knob (PC-12 power lever, Phenom)
        grip = g.ellipsoid(tip + Vector((0, 0, 0.01)), 0.022, 0.03, 0.02, 10, 6)
    obj = g.multi_material(name, [(*arm, m["ck_lever"]), (*grip, knob_mat or m["ck_handle"])], col,
                           smooth_angle=50)
    obj["spin_center"] = tuple(base)
    return obj


# ---------------------------------------------------------------------------
# Seats, pedals, structure
# ---------------------------------------------------------------------------

def seat(x, y, floor_z, style="ga"):
    """Pilot seat (behind the eye): cushion, reclined back, headrest, armrests."""
    w = {"ga": 0.46, "airliner": 0.52, "ejection": 0.50}[style]
    h0 = floor_z + (0.30 if style != "airliner" else 0.42)
    parts = [g.box(x, y + 0.20, h0, w, 0.48, 0.11)]
    back = Frame(y + 0.47, h0 + 0.36, (0, 0.25, 1))
    parts.append(back.box(x, 0, 0, w, 0.66, 0.12))
    parts.append(back.box(x, 0.42, 0.01, w * (0.55 if style != "ejection" else 0.9), 0.22, 0.13))
    parts.append(g.box(x, y + 0.20, (floor_z + h0) / 2 - 0.03, 0.30, 0.36, h0 - floor_z - 0.06))
    if style == "airliner":
        for s in (1, -1):
            parts.append(g.box(x + s * (w / 2 + 0.035), y + 0.22, h0 + 0.17, 0.06, 0.40, 0.05))
    trim = []
    if style == "ejection":
        # Seat bucket sides and the yellow-black firing handle between the knees.
        for s in (1, -1):
            parts.append(g.box(x + s * (w / 2 + 0.02), y + 0.25, h0 + 0.12, 0.04, 0.6, 0.32))
        trim.append(g.box(x, y - 0.06, h0 + 0.04, 0.18, 0.03, 0.03))
    return parts, trim


def pedals(x, y, floor_z):
    """Pair of rudder pedals (static)."""
    parts = []
    for s in (1, -1):
        f = Frame(y, floor_z + 0.18, (0, -0.45, 1))
        parts.append(f.box(x + s * 0.11, 0, 0, 0.09, 0.20, 0.02))
        parts.append(g.cylinder((x + s * 0.11, y - 0.06, floor_z + 0.02),
                                (x + s * 0.11, y - 0.02, floor_z + 0.12), 0.012, 8))
    return parts


def sloped_box(x, y0, y1, w, floor_z, z_front, z_rear):
    """Box with a top sloping from z_front (at y0, forward) to z_rear (at y1)."""
    v = []
    for i in (-1, 1):
        for yy, zt in ((y0, z_front), (y1, z_rear)):
            for zz in (floor_z, zt):
                v.append((x + i * w / 2, yy, zz))
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    # The box() winding assumes y0 < y1.
    if y0 > y1:
        f = [tuple(reversed(face)) for face in f]
    return v, f


# ---------------------------------------------------------------------------
# The whole cockpit
# ---------------------------------------------------------------------------

def build(col, m, fuse, spec):
    """
    spec keys (see the type files):
      floor            floor height (z)
      panel            dict(y, z, w, h, tilt): main instrument panel
      displays         [(kind, x, b, w, h, style)] on the panel; style "g1000" (soft keys), "plain", "none"
      gauges           [(x, b, r)] round bezels on the panel (C172 six-pack, standby)
      switches         [(x, b, n, dx, kind)] rows of toggles / knobs on the panel
      glare            dict(depth, h, fcu=(w, h) or None): glareshield with autopilot panel
      pedestal         dict(y1, w, z_front, z_rear, levers=[(x, handle, mat)], display=(w, h))
      overhead         dict(y0, y1, w, drop): overhead panel under the roof
      consoles         dict(x, y0, y1, w, z): side consoles (fighter)
      controls         ("yoke"|"airliner_yoke"|"column"|"stick", [(x, y, z, side)])
      throttle_knob    (x, b): C172 push-pull throttle on the panel
      levers           [(name, x, y, z, handle, mat, length)] free-standing levers (HOTAS)
      seats            [(x, y, style)]
      pedals           [(x, y)]
    Returns the created objects by name.
    """
    out = {}
    floor = spec["floor"]
    pn = spec["panel"]
    P = Frame.panel(pn["y"], pn["z"], pn.get("tilt", 10))
    w, h = pn["w"], pn["h"]

    panel_parts = [P.box(0, 0, -0.04, w, h, 0.08)]
    bezels, small, gauges, lights = [], [], [], []
    # Lower panel down to the floor (knee panel), set back a little, and the firewall behind.
    low = P.p(0, -h / 2, -0.04)
    panel_parts.append(g.box(0, low.y - 0.08, (floor + low.z) / 2, w * 0.96, 0.05, low.z - floor))
    for (kind, x, b, dw, dh, style) in spec.get("displays", []):
        n = sum(1 for k in out if k.startswith(f"Display_{kind}_"))
        out[f"Display_{kind}_{n}"] = display(col, f"Display_{kind}_{n}", P, x, b, dw, dh,
                                             m["ck_display"])
        if style != "none":
            bz, sm = bezel(P, x, b, dw, dh, keys=style == "g1000", knobs=style == "g1000")
            bezels += bz
            small += sm
    for (x, b, r) in spec.get("gauges", []):
        gauges.append(P.ring(x, b, r, r + 0.007, 0.012))
        small.append(P.knob(x - r * 0.8, b - r * 0.8, 0.006, 0.012, 0.0, 8))
    for (x, b, n, dx, kind) in spec.get("switches", []):
        for i in range(n):
            sx = x - i * dx
            if kind == "toggle":
                small.append(P.box(sx, b, 0.006, 0.012, 0.022, 0.012))
                small.append(g.cylinder(P.p(sx, b, 0.012), P.p(sx, b + 0.01, 0.03), 0.003, 6))
            elif kind == "knob":
                small.append(P.knob(sx, b, 0.011, 0.016))
            elif kind == "annunciator":
                lights.append(P.box(sx, b, 0.004, dx * 0.8, 0.014, 0.006))
    knobs = []
    if "throttle_knob" in spec:
        x, b = spec["throttle_knob"]
        p0 = P.p(x, b, 0.0)
        tk = g.multi_material("Knob_Throttle", [
            (*g.cylinder(p0, p0 + P.N * 0.09, 0.005, 8), m["ck_lever"]),
            (*g.lathe([(0.0, 0.014), (0.012, 0.016), (0.024, 0.0)], p0 + P.N * 0.085, P.N, 14,
                      cap_start=True), m["ck_handle"]),
        ], col, smooth_angle=50)
        tk["spin_center"] = tuple(p0)
        out["Knob_Throttle"] = tk
        # Mixture (red) and carb heat (black) next to it, static.
        for dx, mat in ((-0.09, m["ck_red"]), (0.07, m["ck_handle"])):
            q = P.p(x + dx, b, 0.0)
            knobs.append((g.cylinder(q, q + P.N * 0.03, 0.005, 8), m["ck_lever"]))
            knobs.append((g.ellipsoid(q + P.N * 0.035, 0.012, 0.012, 0.012, 10, 6), mat))

    gl = spec.get("glare")
    shield = []
    if gl:
        top = P.p(0, h / 2, 0)
        depth, gh = gl["depth"], gl.get("h", 0.08)
        shield.append(g.box(0, top.y - depth / 2 + 0.06, top.z + gh / 2 - 0.01, w * 1.03, depth, gh))
        # Rounded lip over the panel face.
        lip_y = top.y + 0.06
        shield.append(g.cylinder((w * 0.515, lip_y, top.z + gh - 0.025),
                                 (-w * 0.515, lip_y, top.z + gh - 0.025), 0.025, 10))
        if gl.get("fcu"):
            fw, fh = gl["fcu"]
            F = Frame(lip_y + 0.026, top.z + gh / 2 - 0.012, (0, -0.15, 1))
            out["Display_FCU_0"] = display(col, "Display_FCU_0", F, 0, 0, fw, fh, m["ck_display"])
            bezels.append(F.box(0, 0, -0.004, fw + 0.02, fh + 0.014, 0.01))
            for i in range(4):
                small.append(F.knob(fw / 2 - fw * (0.12 + 0.25 * i), -fh / 2 - 0.006, 0.01, 0.014,
                                    0.0, 12))

    ped = spec.get("pedestal")
    struct = []
    if ped:
        y0 = low.y - 0.05
        y1 = ped["y1"]
        pw = ped["w"]
        struct.append(sloped_box(0, y0, y1, pw, floor, ped["z_front"], ped["z_rear"]))
        # The top surface frame (sloping, up = forward for the pilot looking down).
        dy, dz = y1 - y0, ped["z_rear"] - ped["z_front"]
        L = math.hypot(dy, dz)
        T = Frame((y0 + y1) / 2, (ped["z_front"] + ped["z_rear"]) / 2, (0, -dy / L, -dz / L))
        if ped.get("display"):
            dw, dh = ped["display"]
            out["Display_MCDU_0"] = display(col, "Display_MCDU_0", T, 0, L * 0.25, dw, dh, m["ck_display"],
                                            c=0.009)
            bezels.append(T.box(0, L * 0.25, 0.002, dw + 0.03, dh + 0.1, 0.008))
            for r in range(5):
                for c_ in range(6):
                    small.append(T.box(dw / 2 - (c_ + 0.5) * dw / 6, L * 0.25 - dh / 2 - 0.012 - r * 0.016,
                                       0.006, dw / 6 * 0.7, 0.011, 0.006))
        for i, (x, handle, mat) in enumerate(ped.get("levers", [])):
            b = -L * 0.15
            base = T.p(x, b, 0.0)
            name = f"Throttle_{i + 1}"
            out[name] = lever(col, m, name, x, base.y, base.z, ped.get("lever_len", 0.15), handle,
                              m.get(mat) if mat else None)
        # Lever quadrant slots and side plates.
        struct.append(T.box(0, -L * 0.15, 0.004, min(pw * 0.8, 0.05 + 0.06 * len(ped.get("levers", []))),
                            0.18, 0.008))
        if ped.get("trim_wheel"):
            for s in (1, -1):
                q = Vector((s * (pw / 2 + 0.005), (y0 + y1) / 2, (ped["z_front"] + ped["z_rear"]) / 2 - 0.08))
                knobs.append((g.cylinder(q, q + Vector((s * 0.025, 0, 0)), 0.09, 24), m["ck_handle"]))

    ov = spec.get("overhead")
    if ov:
        y0, y1, ow = ov["y0"], ov["y1"], ov["w"]
        zt0 = fuse.profile(fuse.s(y0))[1] * 0.96 - ov.get("drop", 0.1)
        zt1 = fuse.profile(fuse.s(y1))[1] * 0.96 - ov.get("drop", 0.1)
        dy, dz = y1 - y0, zt1 - zt0
        L = math.hypot(dy, dz)
        O = Frame((y0 + y1) / 2, (zt0 + zt1) / 2, (0, dy / L, dz / L))
        struct.append(O.box(0, 0, -0.04, ow, L, 0.08))
        out["Display_OVH_0"] = display(col, "Display_OVH_0", O, 0, 0, ow * 0.94, L * 0.94, m["ck_display"],
                                       c=0.004)
        for r in range(7):
            for c_ in range(10):
                small.append(O.box(ow * 0.42 - c_ * ow * 0.093, -L * 0.4 + r * L * 0.13, 0.006, 0.012, 0.012,
                                   0.01))

    cons = spec.get("consoles")
    if cons:
        for s in (1, -1):
            cx = s * cons["x"]
            struct.append(g.box(cx, (cons["y0"] + cons["y1"]) / 2, (floor + cons["z"]) / 2, cons["w"],
                                abs(cons["y1"] - cons["y0"]), cons["z"] - floor))
            for r in range(4):
                for c_ in range(3):
                    small.append(g.box(cx + (c_ - 1) * cons["w"] * 0.25,
                                       cons["y0"] + 0.1 + r * (abs(cons["y1"] - cons["y0"]) - 0.4) / 4,
                                       cons["z"] + 0.005, 0.02, 0.02, 0.012))

    for (name, x, y, z, handle, mat, length) in spec.get("levers", []):
        out[name] = lever(col, m, name, x, y, z, length, handle, m.get(mat) if mat else None)

    kind, ctrls = spec.get("controls", (None, []))
    for (x, y, z, side) in ctrls:
        if kind in ("yoke", "airliner_yoke"):
            y_panel = P.p(x, 0, 0).y - (z - pn["z"]) * math.tan(math.radians(pn.get("tilt", 10)))
            out[f"Yoke_{side}"] = yoke(col, m, f"Yoke_{side}", x, y_panel, y, z,
                                       0.30 if kind == "yoke" else 0.34,
                                       "ga" if kind == "yoke" else "airliner")
        elif kind == "column":
            co, wh = column(col, m, side, x, y, floor, z)
            out[co.name], out[wh.name] = co, wh
        elif kind == "stick":
            out[f"Stick_{side}"] = side_stick(col, m, f"Stick_{side}", x, y, z)

    seat_parts, seat_trim = [], []
    for (x, y, style) in spec.get("seats", []):
        sp, st = seat(x, y, floor, style)
        seat_parts += sp
        seat_trim += st
    pedal_parts = []
    for (x, y) in spec.get("pedals", []):
        pedal_parts += pedals(x, y, floor)

    groups = [(*g.merge_parts(panel_parts), m["ck_panel"])]
    if bezels:
        groups.append((*g.merge_parts(bezels), m["ck_bezel"]))
    if small:
        groups.append((*g.merge_parts(small), m["ck_knob"]))
    if gauges:
        groups.append((*g.merge_parts(gauges), m["ck_bezel"]))
    if lights:
        groups.append((*g.merge_parts(lights), m["ck_light"]))
    if shield:
        groups.append((*g.merge_parts(shield), m["ck_shield"]))
    if struct:
        groups.append((*g.merge_parts(struct), m["ck_panel"]))
    if seat_parts:
        groups.append((*g.merge_parts(seat_parts), m[spec.get("seat_mat", "ck_seat")]))
    if seat_trim:
        groups.append((*g.merge_parts(seat_trim), m["ck_yellow"]))
    if pedal_parts:
        groups.append((*g.merge_parts(pedal_parts), m["ck_lever"]))
    for part, mat in knobs:
        groups.append((*part, mat))
    out["Cockpit"] = g.multi_material("Cockpit", groups, col, smooth_angle=35)
    return out

