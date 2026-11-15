"""
Kit for operable cockpits, shared by every type: a Builder that collects static parts per
material, shapes that repeat (knobs, rockers, toggles, buttons) as shared mesh data so the
loader can instance them, and a Placer for control pivots, hit boxes, placard labels and
display windows.

Naming (the loader in src/aircraft/cockpitCore.ts and the tests read these):
  Ctl_<id>         one node per control of the type's control list (src/sim). Pivots carry
                   extras.axis (rotation, model frame) and/or extras.slide (model-frame metres
                   at the end of the travel), optionally extras.detents (degrees of a rotary
                   selector's positions or a toggle's two throws). Rest rotation is identity.
  Ctl_<id>_outer   the outer ring of a dual concentric knob (coarse step).
  Hit_<id>[__...]  invisible hit boxes: extras.control, extras.half (model-frame half
                   extents of an axis-aligned box), extras.side (model-frame axis that splits
                   the box into a lower and an upper half, [0,0,0] without sides), optional
                   extras.step (what one click changes instead of the control's own step) and
                   extras.lever (a lever with detents: the side is where the click is).
  Disp_<ID>        display windows the loader paints (UV 0..1, extras.size = [w, h] metres).
  Labels           every placard text as one mesh; extras.labels lists the texts in atlas cell
                   order, extras.cols/rows the atlas grid (cells are 4:1).

Local frames of shapes: x right, y up, z out of the mounting surface. A frame is a 3x3 matrix
whose columns are those axes in the design frame.
"""

import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix

from . import mesh as M


class Builder:
    def __init__(self, col, mats, root):
        self.col, self.mats, self.root = col, mats, root
        self.static = {}   # material key -> list of (verts, faces)
        self.parts = {}

    def add(self, key, vf):
        self.static.setdefault(key, []).append(vf)

    def obj(self, name, vf, mat, parent=None, origin=None, uvs=None, sharp=40, smooth=True):
        v, f = vf
        o = M.make_object(name, v, f, self.col, self.mats[mat], smooth=smooth, sharp_angle=sharp,
                          origin=origin, uvs=uvs, recalc=uvs is None)
        M.parent_keep(o, parent or self.root)
        return o

    def pivot(self, name, at, axis_design, props=None, parent=None):
        pr = {"axis": M.model_axis(*axis_design)}
        pr.update(props or {})
        e = M.empty(name, self.col, M.P(*at), size=0.02, props=pr)
        M.parent_keep(e, parent or self.root)
        return e

    def flush(self):
        for key, items in self.static.items():
            v, f = M.merge(items)
            o = M.make_object(f"Cabin_{key}", v, f, self.col, self.mats[key], sharp_angle=40)
            M.parent_keep(o, self.root)



# ---------------------------------------------------------------------------
# Mesh data and placing
# ---------------------------------------------------------------------------

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


def attach(b, name, me, pivot, frame, offset=(0.0, 0.0, 0.0)):
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


def static(b, key, vf, origin, frame):
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
    """Places pivots, hit boxes, labels and display windows; `frame` is the default mounting frame."""

    def __init__(self, b, frame, label_cols=8, label_rows=20):
        self.b = b
        self.frame = frame
        self.label_cols, self.label_rows = label_cols, label_rows
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

    def hit(self, control, at, half, frame=None, side=None, step=None, suffix="", extra=None):
        """Axis-aligned (model frame) box around a box of `half` extents in `frame`."""
        frame = self.frame if frame is None else frame
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

    def label(self, text, at, height, frame=None, color="#f2f2ee", lift=0.0007):
        frame = self.frame if frame is None else frame
        w = height * 4
        v, _ = quad(w, height, lift)
        self.labels.append((to_design(at, frame, v), text, color))

    def display(self, did, at, w, h, frame=None, lift=0.0004):
        frame = self.frame if frame is None else frame
        v, f = quad(w, h, lift)
        uvs = [(0, 0), (1, 0), (1, 1), (0, 1)]
        o = M.make_object(f"Disp_{did}", to_design(at, frame, v), f, self.b.col, self.b.mats["display"],
                          smooth=False, origin=M.P(*at), uvs=uvs, recalc=False)
        o["size"] = [float(w), float(h)]
        M.parent_keep(o, self.b.root)
        return o

    def flush_labels(self):
        n = len(self.labels)
        LABEL_COLS, LABEL_ROWS = self.label_cols, self.label_rows
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


