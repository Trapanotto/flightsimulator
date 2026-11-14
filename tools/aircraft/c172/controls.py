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
glTF has one mesh referenced by many nodes and the loader can draw each set instanced.
"""

import math

import bpy
import bmesh
import numpy as np
from mathutils import Matrix

from lib import mesh as M
from . import cockpit as C

VX, VV, VN = C.VX, C.VV, C.VN
PANEL_R = np.column_stack([-VX, VV, VN])          # panel frame: x pilot's right, y up, z out
FLOOR_R = np.column_stack([(-1.0, 0, 0), (0, -1.0, 0), (0, 0, 1.0)])   # x right, y fwd, z up
AFT_R = np.column_stack([(-1.0, 0, 0), (0, 0, 1.0), (0, 1.0, 0)])      # pedestal aft face
LEFT_R = np.column_stack([(0, 1.0, 0), (0, 0, 1.0), (1.0, 0, 0)])      # pedestal left face

STACK_L, STACK_R = -0.030, -0.190     # BL of the radio stack's edges
STACK_FACE = 0.012                    # front of the avionics face plates (out of the panel)

LABEL_COLS, LABEL_ROWS = 8, 20


def model_vec(d):
    d = np.asarray(d, float)
    return [float(d[0]), float(d[2]), float(-d[1])]


# ---------------------------------------------------------------------------
# Mesh data
# ---------------------------------------------------------------------------

_SHARED = {}


def mesh_data(name, vf, mat, sharp=40, smooth=True):
    """A Blender mesh in local coordinates (no reference shift), not linked to an object."""
    verts, faces = vf
    me = bpy.data.meshes.new(name)
    me.from_pydata(np.asarray(verts, float).reshape(-1, 3).tolist(), [],
                   [tuple(int(i) for i in f) for f in faces])
    me.validate(clean_customdata=False)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    if smooth:
        me.shade_smooth()
        me.set_sharp_from_angle(angle=math.radians(sharp))
    else:
        me.shade_flat()
    return me


def shared(key, build, mat):
    if key not in _SHARED:
        _SHARED[key] = mesh_data(f"shape_{key}", build(), mat)
    return _SHARED[key]


def attach(b, name, me, pivot, frame=PANEL_R, offset=(0.0, 0.0, 0.0)):
    """Object `name` with mesh `me` (local frame) under `pivot`, oriented by `frame`."""
    o = bpy.data.objects.new(name, me)
    b.col.objects.link(o)
    o.parent = pivot
    o.matrix_parent_inverse = Matrix.Identity(4)
    m = Matrix.Identity(4)
    for i in range(3):
        for j in range(3):
            m[i][j] = frame[i][j]
    off = frame @ np.asarray(offset, float)
    m[0][3], m[1][3], m[2][3] = off
    o.matrix_basis = m
    return o


def to_design(origin, frame, verts):
    return np.asarray(origin, float) + np.asarray(verts, float) @ frame.T


def static(b, key, vf, origin, frame=PANEL_R):
    v, f = vf
    b.add(key, (to_design(origin, frame, v), f))


# ---------------------------------------------------------------------------
# Shapes (local frame: x right, y up, z out of the mounting surface)
# ---------------------------------------------------------------------------

def revolve(profile, n=24, knurl=0.0):
    """Surface of revolution about local z; profile = [(z, r, knurled)], ends capped."""
    verts, rows = [], []
    for z, r, kn in profile:
        row = []
        for k in range(n):
            a = 2 * math.pi * k / n
            rr = r * (1 + (knurl if k % 2 else -knurl)) if kn else r
            row.append(len(verts))
            verts.append((rr * math.cos(a), rr * math.sin(a), z))
        rows.append(row)
    faces = []
    for r0, r1 in zip(rows[:-1], rows[1:]):
        for k in range(n):
            faces.append((r0[k], r0[(k + 1) % n], r1[(k + 1) % n], r1[k]))
    c0 = len(verts)
    verts.append((0, 0, profile[0][0]))
    faces += M.fan_cap(rows[0], c0, reverse=True)
    c1 = len(verts)
    verts.append((0, 0, profile[-1][0]))
    faces += M.fan_cap(rows[-1], c1)
    return np.array(verts), faces


def knob(r, length, z0=0.0, n=24, skirt=True):
    """Knurled knob: a skirt at the panel, a ridged body, a chamfered face."""
    p = []
    if skirt:
        p += [(z0, r * 1.15, False), (z0 + 0.0012, r * 1.15, False), (z0 + 0.0014, r, True)]
    else:
        p += [(z0, r, True)]
    p += [(z0 + length - 0.0012, r, True), (z0 + length - 0.0004, r * 0.93, False), (z0 + length, r * 0.8, False)]
    return revolve(p, n, knurl=0.07)


def smooth_knob(r, length, n=20):
    p = [(0.0, r * 0.75, False), (length * 0.25, r, False), (length * 0.8, r, False),
         (length * 0.95, r * 0.86, False), (length, r * 0.6, False)]
    return revolve(p, n)


def ribbed_knob(r, length, n=24):
    p = [(0.0, r * 0.75, False), (length * 0.2, r, True), (length * 0.85, r, True),
         (length, r * 0.7, False)]
    return revolve(p, n, knurl=0.06)


def box(cx, cy, cz, w, h, d, rad=0.0, seg=1):
    return M.rounded_box((cx, cy, cz), (w, h, d), rad, seg)


def rocker_shape():
    # The paddle stands 6 mm proud; a shallow ridge across its middle where the finger rests.
    return M.merge([box(0, 0, 0.003, 0.0095, 0.019, 0.006, 0.0015, 1),
                    box(0, 0, 0.0062, 0.0085, 0.003, 0.0012, 0.0005, 1)])


def button_shape():
    return box(0, 0, 0.0025, 0.0085, 0.0052, 0.005, 0.0012, 1)


def shaft_shape():
    return M.cylinder((0, 0, -0.07), (0, 0, 0.004), 0.0032, 10)


def flag_shape():
    # A small plate; the loader slides it out from behind the bezel.
    return box(0, 0, 0, 0.0075, 0.0055, 0.0006)


def key_shape():
    head = [(x, y) for x, y in ((-0.006, 0.0), (0.006, 0.0), (0.0075, 0.014), (0.0, 0.019), (-0.0075, 0.014))]
    pts, faces = [], []
    n = len(head)
    for z in (0.006, 0.0095):
        for x, y in head:
            pts.append((x, y - 0.004, z))
    faces = [tuple(range(n))[::-1], tuple(range(n, 2 * n))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    blade = box(0, -0.002, 0.003, 0.0035, 0.0022, 0.006)
    return M.merge([(np.array(pts), faces), blade, revolve([(0, 0.0075, False), (0.0035, 0.0075, False), (0.004, 0.0062, False)], 20)])


def chicken_head(r, length):
    """Selector knob with a pointer bar (transponder mode)."""
    return M.merge([revolve([(0, r * 1.1, False), (0.002, r, False), (length, r, False), (length + 0.0006, r * 0.9, False)], 20),
                    box(0, r * 0.45, length + 0.0015, 0.0022, r * 2.2, 0.003, 0.0006, 1)])


def toggle_bat():
    return M.merge([revolve([(0, 0.0028, False), (0.002, 0.0028, False), (0.0024, 0.0012, False)], 12),
                    M.cylinder((0, 0, 0.002), (0, 0, 0.009), 0.0011, 8),
                    revolve([(0.0085, 0.0016, False), (0.0105, 0.0016, False), (0.011, 0.0008, False)], 10)])


def t_handle(width, reach):
    return M.merge([M.cylinder((0, 0, -0.05), (0, 0, reach), 0.003, 10),
                    M.tube_path([(-width / 2, 0, reach), (width / 2, 0, reach)], 0.0055, 12)])


def selector_handle():
    """Fuel selector: a tapered pointer with a raised grip, pointing along local +y."""
    poly = [(-0.012, -0.028), (0.012, -0.028), (0.016, 0.0), (0.008, 0.045), (0.0, 0.058), (-0.008, 0.045), (-0.016, 0.0)]
    pts = []
    for z in (0.0, 0.007):
        for x, y in poly:
            pts.append((x, y, z))
    n = len(poly)
    faces = [tuple(range(n))[::-1], tuple(range(n, 2 * n))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    grip = box(0, 0.005, 0.017, 0.008, 0.06, 0.02, 0.003, 2)
    return M.merge([(np.array(pts), faces), grip])


def frame_plate(w, h, d=0.002, t=0.0015):
    """Rectangular bezel (a frame with a hole) around a switch or a display."""
    parts = []
    for cx, cy, ww, hh in ((0, (h - t) / 2, w, t), (0, -(h - t) / 2, w, t), ((w - t) / 2, 0, t, h - 2 * t),
                           (-(w - t) / 2, 0, t, h - 2 * t)):
        parts.append(box(cx, cy, d / 2, ww, hh, d))
    return M.merge(parts)


def quad(w, h, z=0.0):
    v = np.array([(-w / 2, -h / 2, z), (w / 2, -h / 2, z), (w / 2, h / 2, z), (-w / 2, h / 2, z)])
    return v, [(0, 1, 2, 3)]


# ---------------------------------------------------------------------------
# Placing things
# ---------------------------------------------------------------------------

class Placer:
    def __init__(self, b):
        self.b = b
        self.labels = []   # (verts design, text, color)

    def pivot(self, name, at, axis=None, slide=None, props=None):
        pr = dict(props or {})
        if axis is not None:
            pr["axis"] = model_vec(np.asarray(axis, float) / np.linalg.norm(axis))
        if slide is not None:
            pr["slide"] = model_vec(slide)
        e = M.empty(name, self.b.col, M.P(*at), size=0.01, props=pr)
        M.parent_keep(e, self.b.root)
        return e

    def hit(self, control, at, half, frame=PANEL_R, side=None, step=None, suffix="", extra=None):
        """Axis-aligned (model frame) box around a box of `half` extents in `frame`."""
        half = np.asarray(half, float)
        axes = [model_vec(frame[:, k]) for k in range(3)]
        mh = [float(sum(abs(axes[k][m]) * half[k] for k in range(3))) for m in range(3)]
        pr = {"control": control, "half": mh,
              "side": [0.0, 0.0, 0.0] if side is None else model_vec(frame[:, side] if isinstance(side, int) else side)}
        if step is not None:
            pr["step"] = float(step)
        pr.update(extra or {})
        e = M.empty(f"Hit_{control}{suffix}", self.b.col, M.P(*at), size=0.005, props=pr)
        M.parent_keep(e, self.b.root)
        return e

    def label(self, text, at, height, frame=PANEL_R, color="#f2f2ee", lift=0.0007):
        w = height * 4
        v, _ = quad(w, height, lift)
        self.labels.append((to_design(at, frame, v), text, color))

    def display(self, did, at, w, h, frame=PANEL_R, lift=0.0004):
        v, f = quad(w, h, lift)
        uvs = [(0, 0), (1, 0), (1, 1), (0, 1)]
        o = M.make_object(f"Disp_{did}", to_design(at, frame, v), f, self.b.col, self.b.mats["display"],
                          smooth=False, origin=M.P(*at), uvs=uvs, recalc=False)
        o["size"] = [float(w), float(h)]
        M.parent_keep(o, self.b.root)
        return o

    def flush_labels(self):
        n = len(self.labels)
        assert n <= LABEL_COLS * LABEL_ROWS, f"{n} labels do not fit the atlas"
        verts, faces, uvs = [], [], []
        for i, (v, _, _) in enumerate(self.labels):
            col, row = i % LABEL_COLS, i // LABEL_COLS
            u0, u1 = col / LABEL_COLS, (col + 1) / LABEL_COLS
            v1, v0 = 1 - row / LABEL_ROWS, 1 - (row + 1) / LABEL_ROWS
            base = len(verts)
            verts += list(v)
            faces.append((base, base + 1, base + 2, base + 3))
            uvs += [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
        o = M.make_object("Labels", np.array(verts), faces, self.b.col, self.b.mats["labels"], smooth=False,
                          uvs=uvs, recalc=False)
        o["labels"] = [t for _, t, _ in self.labels]
        o["labelColors"] = [c for _, _, c in self.labels]
        o["cols"] = LABEL_COLS
        o["rows"] = LABEL_ROWS
        M.parent_keep(o, self.b.root)


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
    P = Placer(b)
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
