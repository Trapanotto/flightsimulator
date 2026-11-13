"""
Fuselage: one lofted skin from the nose bowl to the stern post, window openings cut with
exact booleans (so glass and frame share the same edge), a cabin lining behind the skin and
cowling inlets as blind ducts.
"""

import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector

from lib import mesh as M
from . import dims as D

# Keys along the fuselage station (FS).
TOP = [(-0.80, 1.44), (-0.795, 1.452), (-0.775, 1.468), (-0.70, 1.48), (-0.60, 1.49), (-0.30, 1.515),
       (0.00, 1.535), (0.12, 1.565), (0.40, 1.785), (0.64, 1.955), (0.80, 1.975), (2.20, 1.975),
       (2.30, 1.955), (2.70, 1.75), (3.10, 1.55), (3.60, 1.475), (5.00, 1.43), (6.30, 1.405),
       (6.70, 1.40)]
BOT = [(-0.80, 1.04), (-0.795, 0.99), (-0.775, 0.955), (-0.70, 0.93), (-0.60, 0.905), (-0.30, 0.845),
       (0.00, 0.795), (0.30, 0.755), (0.60, 0.735), (1.80, 0.735), (2.40, 0.77), (3.00, 0.84),
       (4.00, 0.95), (5.00, 1.035), (6.00, 1.095), (6.70, 1.13)]
HALF = [(-0.80, 0.205), (-0.795, 0.33), (-0.775, 0.39), (-0.70, 0.415), (-0.60, 0.43), (-0.30, 0.47),
        (0.00, 0.50), (0.40, 0.535), (0.80, 0.555), (1.60, 0.555), (2.20, 0.53), (2.80, 0.45),
        (3.50, 0.35), (4.50, 0.24), (5.50, 0.15), (6.20, 0.085), (6.70, 0.045)]
MID = [(-0.80, 1.24), (-0.60, 1.20), (0.00, 1.18), (0.60, 1.30), (1.80, 1.30), (3.00, 1.20),
       (5.00, 1.21), (6.70, 1.26)]
N_TOP = [(-0.80, 2.0), (-0.775, 2.7), (-0.30, 2.9), (0.20, 2.7), (0.70, 4.0), (2.20, 4.0),
         (3.00, 2.8), (6.70, 2.6)]
N_BOT = [(-0.80, 2.0), (-0.775, 2.8), (-0.30, 3.0), (0.40, 3.6), (2.00, 3.6), (3.50, 2.8),
         (6.70, 2.5)]
TUMBLE = [(-0.80, 1.0), (-0.775, 0.84), (0.00, 0.82), (0.60, 0.86), (2.20, 0.86), (3.20, 0.7),
          (6.70, 0.55)]

N_RING = 80


def key(table, fs):
    xs, ys = zip(*table)
    return M.pchip(xs, ys, fs)


def section(fs, n=N_RING):
    """(n, 2) ring of (BL, WL), starting at the top centre, going round to the left first."""
    top, bot, half, mid = key(TOP, fs), key(BOT, fs), key(HALF, fs), key(MID, fs)
    nt, nb, tum = key(N_TOP, fs), key(N_BOT, fs), key(TUMBLE, fs)
    mid = min(max(mid, bot + 0.05), top - 0.05)
    # Dense angular sampling, then resample evenly by arc length.
    a = np.linspace(0, 2 * math.pi, 721)[:-1]
    s, c = np.sin(a), np.cos(a)
    upper = c >= 0
    ex = np.where(upper, nt, nb)
    hy = np.where(upper, top - mid, mid - bot)
    yy = np.sign(c) * np.abs(c) ** (2 / ex)
    xx = np.sign(s) * np.abs(s) ** (2 / ex)
    wl = mid + hy * yy
    frac = np.clip((wl - mid) / max(top - mid, 1e-6), 0, 1)
    width = half * np.where(upper, 1 - (1 - tum) * frac ** 1.5, 1.0)
    bl = width * xx
    pts = np.stack([bl, wl], -1)
    seg = np.linalg.norm(np.diff(np.vstack([pts, pts[:1]]), axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)])
    t = np.linspace(0, cum[-1], n + 1)[:-1]
    closed = np.vstack([pts, pts[:1]])
    return np.stack([np.interp(t, cum, closed[:, 0]), np.interp(t, cum, closed[:, 1])], -1)


def half_width_at(fs, wl, inset=0.0):
    """Half width of the skin at a station and height (for parts that must fit inside)."""
    ring = section(fs, 400)
    left = ring[ring[:, 0] >= 0]
    best = 0.0
    for a, b in zip(left[:-1], left[1:]):
        if (a[1] - wl) * (b[1] - wl) <= 0 and a[1] != b[1]:
            t = (wl - a[1]) / (b[1] - a[1])
            best = max(best, a[0] + t * (b[0] - a[0]))
    return max(best - inset, 0.0)


def inner_section(fs, inset, wl_min=-1.0, wl_max=9.0, n=64):
    """Ring of the cabin inside a station, clipped to a WL band: (k, 2) of (BL, WL)."""
    ring = section(fs, n)
    c = np.array([0.0, ring[:, 1].mean()])
    d = ring - c
    ring = c + d * (1 - inset / np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-6))
    ring[:, 1] = np.clip(ring[:, 1], wl_min, wl_max)
    return ring


def stations():
    return np.unique(np.round(np.concatenate([
        np.linspace(-0.80, -0.77, 7), np.linspace(-0.75, 0.0, 14), np.linspace(0.05, 0.75, 16),
        np.linspace(0.80, 2.30, 22), np.linspace(2.36, 6.70, 46)]), 4))


def skin_mesh():
    fs_list = stations()
    rows = []
    for fs in fs_list:
        ring = section(fs)
        rows.append(np.column_stack([ring[:, 0], np.full(len(ring), fs), ring[:, 1]]))
    verts = np.vstack(rows)
    faces = M.grid_faces(len(fs_list), N_RING, wrap_cols=True)
    # Nose: closed by the spinner backplate; tail: a short stern post cap.
    c0 = len(verts)
    verts = np.vstack([verts, [[0, fs_list[0] - 0.005, rows[0][:, 2].mean()]]])
    faces += M.fan_cap(list(range(N_RING)), c0, reverse=True)
    c1 = len(verts)
    last = (len(fs_list) - 1) * N_RING
    verts = np.vstack([verts, [[0, fs_list[-1] + 0.004, rows[-1][:, 2].mean()]]])
    faces += M.fan_cap(list(range(last, last + N_RING)), c1)
    return verts, faces


# Window outlines. Side windows in (FS, WL), the rear window in (BL, FS).
WINDSHIELD = [(-0.05, 1.60), (0.345, 1.60), (0.625, 1.925), (0.625, 2.2), (-0.05, 2.2)]
DOOR_WINDOW = [(0.35, 1.445), (1.37, 1.445), (1.37, 1.885), (0.675, 1.89)]
REAR_SIDE = [(1.50, 1.455), (2.46, 1.475), (2.26, 1.875), (1.50, 1.885)]
REAR_WINDOW = [(-0.32, 2.33), (0.32, 2.33), (0.20, 2.98), (-0.20, 2.98)]


def window_cutter(col, cut_mat):
    parts = []
    ws = M.rounded_polygon(WINDSHIELD, [0.0, 0.03, 0.04, 0.0, 0.0], 6)
    parts.append(M.prism(ws, 0, -1.0, 1.0, (1, 2)))
    for side in (1, -1):
        lo, hi = (0.12, 1.0) if side > 0 else (-1.0, -0.12)
        for poly in (DOOR_WINDOW, REAR_SIDE):
            pr = M.rounded_polygon(poly, 0.06, 6)
            parts.append(M.prism(pr, 0, lo, hi, (1, 2)))
    rw = M.rounded_polygon(REAR_WINDOW, 0.08, 6)
    parts.append(M.prism(rw, 2, 1.55, 2.4, (0, 1)))
    v, f = M.merge(parts)
    return M.make_object("WindowCutter", v, f, col, cut_mat, smooth=False)


def inlet_cutter(col, mat):
    parts = []
    for side in (1, -1):
        # Oval inlet beside the spinner; the duct turns into the cowling.
        ring = []
        n = 24
        for k in range(n):
            a = 2 * math.pi * k / n
            ring.append((side * 0.275 + 0.088 * math.cos(a), 1.30 + 0.072 * math.sin(a)))
        parts.append(M.prism(ring, 1, -0.95, -0.66, (0, 2)))
    # Air-filter inlet under the spinner (fuel-injected IO-360 of the 172S).
    box = M.rounded_polygon([(-0.07, 1.035), (0.07, 1.035), (0.07, 1.085), (-0.07, 1.085)], 0.02, 3)
    parts.append(M.prism(box, 1, -0.95, -0.70, (0, 2)))
    v, f = M.merge(parts)
    return M.make_object("InletCutter", v, f, col, mat, smooth=False)


def _delete_faces_with_material(obj, mat_name):
    me = obj.data
    names = [m.name if m else "" for m in me.materials]
    if mat_name not in names:
        return
    idx = names.index(mat_name)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index == idx], context="FACES")
    bm.to_mesh(me)
    bm.free()
    # Drop the now unused slot.
    me.materials.pop(index=idx)


def build(col, mats):
    cut_mat = bpy.data.materials.get("CUT") or bpy.data.materials.new("CUT")
    v, f = skin_mesh()
    skin = M.make_object("Fuselage", v, f, col, mats["paint"], smooth=True)
    source = M.duplicate(skin, "FuselageSource")

    cutter = window_cutter(col, cut_mat)
    glass = M.duplicate(skin, "Glass")
    M.boolean(glass, cutter, "INTERSECT")
    _delete_faces_with_material(glass, "CUT")
    M.boolean(skin, cutter, "DIFFERENCE")
    _delete_faces_with_material(skin, "CUT")
    M.delete_object(cutter)
    M.transfer_normals(skin, source)
    M.transfer_normals(glass, source)

    inlets = inlet_cutter(col, mats["intake"])
    M.boolean(skin, inlets, "DIFFERENCE")
    M.delete_object(inlets)
    M.delete_object(source)

    lining = cabin_lining(skin, col, mats)
    # Glass sits a few millimetres inside the skin, like plexiglass in its frame.
    glass.data.materials.clear()
    glass.data.materials.append(mats["glass"])
    _inset(glass, 0.004)
    return skin, glass, lining


def _inset(obj, d):
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.normal_update()
    for v in bm.verts:
        v.co -= v.normal * d
    bm.to_mesh(me)
    bm.free()


def cabin_lining(skin, col, mats, thickness=0.022):
    """
    Inner surface of the cabin (the skin's duplicate moved inwards and flipped) plus the
    window reveals that join both. Only the cabin part is kept; the firewall and the baggage
    bulkhead close it off.
    """
    bm = bmesh.new()
    bm.from_mesh(skin.data)
    bm.normal_update()
    paint_idx = 0
    # Keep only skin faces (drop the inlet ducts) in the cabin range.
    lo_fs, hi_fs = 0.0 - M.REF[1], 3.35 - M.REF[1]
    kill = [f for f in bm.faces
            if f.material_index != paint_idx or not all(lo_fs < v.co.y < hi_fs for v in f.verts)]
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.verts.index_update()
    bm.edges.index_update()
    bm.faces.index_update()
    bm.normal_update()
    outer_boundary = {}
    for e in bm.edges:
        if e.is_boundary:
            outer_boundary[e.index] = (e.verts[0].index, e.verts[1].index)
    n = len(bm.verts)
    co_out = [v.co.copy() for v in bm.verts]
    normals = [v.normal.copy() for v in bm.verts]
    faces = [[v.index for v in f.verts] for f in bm.faces]
    bm.free()

    # Window reveals only where the edge belongs to a window (not where we cropped the lining).
    def is_window_edge(a, b):
        ya, yb = co_out[a].y + M.REF[1], co_out[b].y + M.REF[1]
        return 0.02 < ya < 3.3 and 0.02 < yb < 3.3

    verts = co_out + [co_out[i] - normals[i] * thickness for i in range(n)]
    new_faces = [tuple(i + n for i in reversed(f)) for f in faces]
    rim_faces = []
    for a, b in outer_boundary.values():
        if is_window_edge(a, b):
            rim_faces.append((a, b, b + n, a + n))
    me = bpy.data.meshes.new("CabinLining")
    me.from_pydata([tuple(v) for v in verts], [], new_faces + rim_faces)
    me.validate()
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mats["interior"])
    me.materials.append(mats["seal"])
    nf = len(new_faces)
    for i, p in enumerate(me.polygons):
        p.material_index = 0 if i < nf else 1
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(35))
    obj = bpy.data.objects.new("CabinLining", me)
    col.objects.link(obj)
    # The rims must face out of the reveal; recalculation would flip the whole lining outwards.
    return obj
