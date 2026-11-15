"""
Fuselages lofted from key tables along the fuselage station: top and bottom line, half
width, the height of the widest point, superellipse exponents above and below it, and the
tumblehome (how much narrower the top is). The Cessna's fuselage.py works the same way with
its own copy; new types use this one.

Windows are cut with exact booleans so glass and frame share the same edge; the cabin
lining is the skin moved inwards with reveals round the windows.
"""

import math

import bmesh
import bpy
import numpy as np

from . import mesh as M


class Tables:
    """Key tables (lists of (FS, value)) of one fuselage; see the module docstring."""

    def __init__(self, top, bot, half, mid, n_top, n_bot, tumble, n_ring=80):
        self.top, self.bot, self.half, self.mid = top, bot, half, mid
        self.n_top, self.n_bot, self.tumble = n_top, n_bot, tumble
        self.n_ring = n_ring

    @staticmethod
    def key(table, fs):
        xs, ys = zip(*table)
        return M.pchip(xs, ys, fs)

    def section(self, fs, n=None):
        """(n, 2) ring of (BL, WL), starting at the top centre, going round to the left first."""
        n = n or self.n_ring
        k = self.key
        top, bot, half, mid = k(self.top, fs), k(self.bot, fs), k(self.half, fs), k(self.mid, fs)
        nt, nb, tum = k(self.n_top, fs), k(self.n_bot, fs), k(self.tumble, fs)
        mid = min(max(mid, bot + 0.05), top - 0.05)
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

    def half_width_at(self, fs, wl, inset=0.0):
        """Half width of the skin at a station and height (for parts that must fit inside)."""
        ring = self.section(fs, 400)
        left = ring[ring[:, 0] >= 0]
        best = 0.0
        for a, b in zip(left[:-1], left[1:]):
            if (a[1] - wl) * (b[1] - wl) <= 0 and a[1] != b[1]:
                t = (wl - a[1]) / (b[1] - a[1])
                best = max(best, a[0] + t * (b[0] - a[0]))
        return max(best - inset, 0.0)

    def wl_at(self, fs, bl, upper=True):
        """Height of the skin at a station and butt line, on the upper or lower side."""
        ring = self.section(fs, 400)
        side = ring[(ring[:, 1] >= self.key(self.mid, fs)) == upper]
        best = None
        for a, b in zip(side[:-1], side[1:]):
            if (a[0] - bl) * (b[0] - bl) <= 0 and a[0] != b[0]:
                t = (bl - a[0]) / (b[0] - a[0])
                w = a[1] + t * (b[1] - a[1])
                best = w if best is None else (max(best, w) if upper else min(best, w))
        return best if best is not None else float(self.key(self.top if upper else self.bot, fs))

    def inner_section(self, fs, inset, wl_min=-1.0, wl_max=9.0, n=64):
        """Ring of the cabin inside a station, clipped to a WL band: (k, 2) of (BL, WL)."""
        ring = self.section(fs, n)
        c = np.array([0.0, ring[:, 1].mean()])
        d = ring - c
        ring = c + d * (1 - inset / np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-6))
        ring[:, 1] = np.clip(ring[:, 1], wl_min, wl_max)
        return ring

    def skin(self, stations):
        """Quad grid over the stations, closed at both ends. Returns verts, faces."""
        rows = []
        n = self.n_ring
        for fs in stations:
            ring = self.section(fs)
            rows.append(np.column_stack([ring[:, 0], np.full(len(ring), fs), ring[:, 1]]))
        verts = np.vstack(rows)
        faces = M.grid_faces(len(stations), n, wrap_cols=True)
        c0 = len(verts)
        verts = np.vstack([verts, [[0, stations[0] - 0.005, rows[0][:, 2].mean()]]])
        faces += M.fan_cap(list(range(n)), c0, reverse=True)
        c1 = len(verts)
        last = (len(stations) - 1) * n
        verts = np.vstack([verts, [[0, stations[-1] + 0.004, rows[-1][:, 2].mean()]]])
        faces += M.fan_cap(list(range(last, last + n)), c1)
        return verts, faces


def delete_faces_with_material(obj, mat_name):
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
    me.materials.pop(index=idx)


def inset(obj, d):
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.normal_update()
    for v in bm.verts:
        v.co -= v.normal * d
    bm.to_mesh(me)
    bm.free()


def cut_windows(skin, cutter, glass_mat):
    """Cuts the cutter's shapes out of the skin; returns the glass that filled them."""
    source = M.duplicate(skin, skin.name + "Source")
    glass = M.duplicate(skin, "Glass")
    M.boolean(glass, cutter, "INTERSECT")
    delete_faces_with_material(glass, "CUT")
    M.boolean(skin, cutter, "DIFFERENCE")
    delete_faces_with_material(skin, "CUT")
    M.transfer_normals(skin, source)
    M.transfer_normals(glass, source)
    M.delete_object(source)
    glass.data.materials.clear()
    glass.data.materials.append(glass_mat)
    inset(glass, 0.004)
    return glass


def cabin_lining(skin, col, mats, fs_lo, fs_hi, thickness=0.022, name="CabinLining"):
    """
    Inner surface of the cabin (the skin's duplicate moved inwards and flipped) plus the
    window reveals that join both, between two stations.
    """
    bm = bmesh.new()
    bm.from_mesh(skin.data)
    bm.normal_update()
    lo, hi = fs_lo - M.REF[1], fs_hi - M.REF[1]
    kill = [f for f in bm.faces if f.material_index != 0 or not all(lo < v.co.y < hi for v in f.verts)]
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.verts.index_update()
    bm.edges.index_update()
    bm.faces.index_update()
    bm.normal_update()
    boundary = [(e.verts[0].index, e.verts[1].index) for e in bm.edges if e.is_boundary]
    n = len(bm.verts)
    co = [v.co.copy() for v in bm.verts]
    normals = [v.normal.copy() for v in bm.verts]
    faces = [[v.index for v in f.verts] for f in bm.faces]
    bm.free()
    margin = 0.03

    def is_window_edge(a, b):
        ya, yb = co[a].y, co[b].y
        return lo + margin < ya < hi - margin and lo + margin < yb < hi - margin

    verts = co + [co[i] - normals[i] * thickness for i in range(n)]
    new_faces = [tuple(i + n for i in reversed(f)) for f in faces]
    rims = [(a, b, b + n, a + n) for a, b in boundary if is_window_edge(a, b)]
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], new_faces + rims)
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
    obj = bpy.data.objects.new(name, me)
    col.objects.link(obj)
    return obj


def bulkhead(tables, fs, thick, wl_min, wl_max, inset_m=0.024):
    """A wall across the cabin at a station, cut to the inside of the skin."""
    ring = tables.inner_section(fs, inset_m, wl_min, wl_max)
    v, f = [], []
    n = len(ring)
    for d in (0.0, thick):
        for bl, wl in ring:
            v.append((bl, fs + d, wl))
    c0, c1 = len(v), len(v) + 1
    v += [(0.0, fs, ring[:, 1].mean()), (0.0, fs + thick, ring[:, 1].mean())]
    f += M.fan_cap(list(range(n)), c0)
    f += M.fan_cap(list(range(n, 2 * n)), c1, reverse=True)
    for i in range(n):
        j = (i + 1) % n
        f.append((i, j, n + j, n + i))
    return np.array(v), f


def surface_patch(fn, u_range, v_range, nu, nv, offset=0.0):
    """
    A grid over a parametric surface fn(u, v) -> (point, normal) (design frame): doors that
    follow the skin they close. `offset` moves it along the normal.
    """
    us = np.linspace(*u_range, nu)
    vs = np.linspace(*v_range, nv)
    verts = []
    for u in us:
        for v in vs:
            p, nrm = fn(u, v)
            verts.append(np.asarray(p) + offset * np.asarray(nrm))
    faces = M.grid_faces(nu, nv)
    return np.array(verts), faces


def solid_patch(fn, u_range, v_range, nu, nv, thickness):
    """A surface patch with a thickness (outer face, inner face, rims): a door panel."""
    vo, fo = surface_patch(fn, u_range, v_range, nu, nv, 0.0)
    vi, _ = surface_patch(fn, u_range, v_range, nu, nv, -thickness)
    n = len(vo)
    verts = np.vstack([vo, vi])
    faces = list(fo) + [tuple(i + n for i in reversed(f)) for f in fo]
    # Rims along the four edges.
    idx = lambda i, j: i * nv + j  # noqa: E731
    edges = [(idx(0, j), idx(0, j + 1)) for j in range(nv - 1)]
    edges += [(idx(i, nv - 1), idx(i + 1, nv - 1)) for i in range(nu - 1)]
    edges += [(idx(nu - 1, j + 1), idx(nu - 1, j)) for j in range(nv - 1)]
    edges += [(idx(i + 1, 0), idx(i, 0)) for i in range(nu - 1)]
    for a, b in edges:
        faces.append((b, a, a + n, b + n))
    return verts, faces
