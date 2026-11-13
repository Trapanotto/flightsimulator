"""
Texture atlas for the painted skin: one UV atlas over every part that wears the livery.

Cycles bakes, per texel, the design-frame position, the smooth normal, the part id and the
ambient occlusion. The livery (paint scheme, lettering, panel lines, rivets, dirt and wear)
is then computed per texel with numpy from those maps, so it lines up across UV seams and
parts, and nothing is painted by hand.
"""

import math
import os

import bpy
import numpy as np

from . import mesh as M


def unwrap(objs, margin=0.0035):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    for o in objs:
        if not o.data.uv_layers:
            o.data.uv_layers.new(name="UVMap")
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(62), island_margin=margin, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(rotate=True, margin=margin, shape_method="CONCAVE")
    bpy.ops.object.mode_set(mode="OBJECT")


def new_image(name, size, float_buffer=True, non_color=True):
    img = bpy.data.images.get(name)
    if img:
        bpy.data.images.remove(img)
    img = bpy.data.images.new(name, size, size, alpha=True, float_buffer=float_buffer)
    img.generated_color = (0, 0, 0, 0)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    return img


def pixels(img):
    a = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4)


def set_pixels(img, arr):
    img.pixels.foreach_set(np.ascontiguousarray(arr, dtype=np.float32).ravel())
    img.update()


def _bake_material(kind, image):
    mat = bpy.data.materials.get("BakeMat") or bpy.data.materials.new("BakeMat")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    emit = nt.nodes.new("ShaderNodeEmission")
    emit.inputs["Strength"].default_value = 1.0
    nt.links.new(emit.outputs[0], out.inputs["Surface"])
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    if kind == "position":
        # Positions span about +-8 m; store (p + 8) / 16 so the emission stays positive.
        add = nt.nodes.new("ShaderNodeVectorMath")
        add.operation = "MULTIPLY_ADD"
        add.inputs[1].default_value = (1 / 16, 1 / 16, 1 / 16)
        add.inputs[2].default_value = (0.5, 0.5, 0.5)
        nt.links.new(geo.outputs["Position"], add.inputs[0])
        nt.links.new(add.outputs[0], emit.inputs["Color"])
    elif kind == "normal":
        add = nt.nodes.new("ShaderNodeVectorMath")
        add.operation = "MULTIPLY_ADD"
        add.inputs[1].default_value = (0.5, 0.5, 0.5)
        add.inputs[2].default_value = (0.5, 0.5, 0.5)
        nt.links.new(geo.outputs["Normal"], add.inputs[0])
        nt.links.new(add.outputs[0], emit.inputs["Color"])
    elif kind == "id":
        info = nt.nodes.new("ShaderNodeObjectInfo")
        div = nt.nodes.new("ShaderNodeMath")
        div.operation = "DIVIDE"
        div.inputs[1].default_value = 64.0
        nt.links.new(info.outputs["Object Index"], div.inputs[0])
        nt.links.new(div.outputs[0], emit.inputs["Color"])
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = image
    nt.nodes.active = tex
    return mat


def _swap_materials(objs, mat):
    saved = {}
    for o in objs:
        saved[o.name] = [s.material for s in o.material_slots]
        for s in o.material_slots:
            s.material = mat
    return saved


def _restore_materials(objs, saved):
    for o in objs:
        for s, m in zip(o.material_slots, saved[o.name]):
            s.material = m


def _run_bake(objs, bake_type, samples, margin=6):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    bk = scene.render.bake
    bk.margin = margin
    bk.margin_type = "EXTEND"
    bk.use_clear = True
    bk.use_selected_to_active = False
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.bake(type=bake_type)


def bake_maps(objs, size, ao_samples=64, hide=()):
    """Returns pos (design frame), normal, part id (index into objs), coverage, ao."""
    for i, o in enumerate(objs):
        o.pass_index = i + 1
    hidden = []
    for o in hide:
        if not o.hide_render:
            o.hide_render = True
            hidden.append(o)
    out = {}
    for kind in ("position", "normal", "id"):
        img = new_image(f"bake_{kind}", size)
        mat = _bake_material(kind, img)
        saved = _swap_materials(objs, mat)
        _run_bake(objs, "EMIT", 1)
        _restore_materials(objs, saved)
        out[kind] = pixels(img)
    img = new_image("bake_ao", size)
    mat = _bake_material("ao", img)
    saved = _swap_materials(objs, mat)
    world = bpy.context.scene.world or bpy.data.worlds.new("BakeWorld")
    bpy.context.scene.world = world
    world.light_settings.distance = 0.7
    _run_bake(objs, "AO", ao_samples)
    _restore_materials(objs, saved)
    ao = pixels(img)
    for o in hidden:
        o.hide_render = False
    cov = out["id"][..., 3] > 0.5
    pos = (out["position"][..., :3] - 0.5) * 16 + M.REF
    nrm = out["normal"][..., :3] * 2 - 1
    nrm /= np.maximum(np.linalg.norm(nrm, axis=-1, keepdims=True), 1e-6)
    pid = np.rint(out["id"][..., 0] * 64).astype(int) - 1
    pid[~cov] = -1
    return pos, nrm, pid, cov, ao[..., 0]


def save_png(name, arr, path, srgb=False):
    """arr: (H, W, 3|4) 0..1. Writes an 8-bit PNG via a Blender image."""
    h, w = arr.shape[:2]
    if arr.shape[2] == 3:
        arr = np.concatenate([arr, np.ones((h, w, 1), np.float32)], -1)
    img = bpy.data.images.get(name)
    if img:
        bpy.data.images.remove(img)
    img = bpy.data.images.new(name, w, h, alpha=False, float_buffer=False)
    img.colorspace_settings.name = "sRGB" if srgb else "Non-Color"
    set_pixels(img, np.clip(arr, 0, 1))
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    return img


def gltf_output_group():
    """The node group the glTF exporter reads ambient occlusion from."""
    name = "glTF Material Output"
    g = bpy.data.node_groups.get(name)
    if g:
        return g
    g = bpy.data.node_groups.new(name, "ShaderNodeTree")
    g.interface.new_socket("Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    g.interface.new_socket("Thickness", in_out="INPUT", socket_type="NodeSocketFloat")
    g.nodes.new("NodeGroupInput")
    return g


def wire_paint_material(mat, base_img, orm_img, normal_img):
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    base = nt.nodes.new("ShaderNodeTexImage")
    base.image = base_img
    nt.links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
    orm = nt.nodes.new("ShaderNodeTexImage")
    orm.image = orm_img
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(orm.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    grp = nt.nodes.new("ShaderNodeGroup")
    grp.node_tree = gltf_output_group()
    nt.links.new(sep.outputs["Red"], grp.inputs["Occlusion"])
    nrm = nt.nodes.new("ShaderNodeTexImage")
    nrm.image = normal_img
    nmap = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(nrm.outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])


def load_image(path, non_color):
    img = bpy.data.images.load(path, check_existing=False)
    img.colorspace_settings.name = "Non-Color" if non_color else "sRGB"
    return img


# ---------------------------------------------------------------------------
# Helpers for the per-texel livery
# ---------------------------------------------------------------------------

class ValueNoise:
    """Seeded 3D value noise (deterministic, numpy)."""

    def __init__(self, seed, n=64):
        self.n = n
        self.lat = np.random.default_rng(seed).random((n, n, n)).astype(np.float32)

    def __call__(self, p, freq):
        q = np.asarray(p, np.float32) * freq
        i = np.floor(q).astype(np.int64)
        f = q - i
        f = f * f * (3 - 2 * f)
        n = self.n
        out = 0
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    w = (f[..., 0] if dx else 1 - f[..., 0]) * (f[..., 1] if dy else 1 - f[..., 1]) * \
                        (f[..., 2] if dz else 1 - f[..., 2])
                    out = out + w * self.lat[(i[..., 0] + dx) % n, (i[..., 1] + dy) % n, (i[..., 2] + dz) % n]
        return out

    def fbm(self, p, freq, octaves=4):
        total, amp, norm = 0, 1.0, 0
        for k in range(octaves):
            total = total + amp * self(p + 17.3 * k, freq * 2 ** k)
            norm += amp
            amp *= 0.5
        return total / norm


def seg_distance(px, py, segs):
    """Distance from points to a polyline/polygon given as list of (x0, y0, x1, y1)."""
    d = np.full(px.shape, np.inf, np.float32)
    for x0, y0, x1, y1 in segs:
        vx, vy = x1 - x0, y1 - y0
        ll = vx * vx + vy * vy
        t = np.clip(((px - x0) * vx + (py - y0) * vy) / max(ll, 1e-12), 0, 1)
        dx = px - (x0 + t * vx)
        dy = py - (y0 + t * vy)
        d = np.minimum(d, np.sqrt(dx * dx + dy * dy))
    return d


def poly_segments(poly):
    poly = np.asarray(poly, float)
    return [(poly[i][0], poly[i][1], poly[(i + 1) % len(poly)][0], poly[(i + 1) % len(poly)][1])
            for i in range(len(poly))]


def text_bitmap(text, font_path=None, px_per_unit=220, bold=0.0):
    """
    Renders text to a float bitmap (anti-aliased) through a Blender text object turned into
    triangles. Returns (bitmap HxW, cap height in bitmap pixels, origin offset).
    The bitmap's x runs along the text, y up; y = 0 is the baseline.
    """
    curve = bpy.data.curves.new("txt", "FONT")
    curve.body = text
    if font_path and os.path.exists(font_path):
        curve.font = bpy.data.fonts.load(font_path, check_existing=True)
    curve.offset = bold
    curve.resolution_u = 6
    obj = bpy.data.objects.new("txt", curve)
    bpy.context.scene.collection.objects.link(obj)
    dg = bpy.context.evaluated_depsgraph_get()
    me = obj.evaluated_get(dg).to_mesh()
    me.calc_loop_triangles()
    co = np.array([v.co[:2] for v in me.vertices], np.float32)
    tris = np.array([t.vertices[:] for t in me.loop_triangles], np.int64)
    obj.evaluated_get(dg).to_mesh_clear()
    bpy.data.objects.remove(obj)
    bpy.data.curves.remove(curve)
    lo = co.min(0)
    hi = co.max(0)
    ss = 3  # supersampling
    scale = px_per_unit * ss
    pad = 4 * ss
    w = int((hi[0] - lo[0]) * scale) + 2 * pad
    h = int((hi[1] - lo[1]) * scale) + 2 * pad
    bmp = np.zeros((h, w), np.float32)
    pts = (co - lo) * scale + pad
    for t in tris:
        a, b, c = pts[t[0]], pts[t[1]], pts[t[2]]
        x0, x1 = int(max(min(a[0], b[0], c[0]), 0)), int(min(max(a[0], b[0], c[0]) + 1, w - 1))
        y0, y1 = int(max(min(a[1], b[1], c[1]), 0)), int(min(max(a[1], b[1], c[1]) + 1, h - 1))
        if x1 < x0 or y1 < y0:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(det) < 1e-9:
            continue
        l1 = ((b[1] - c[1]) * (gx - c[0]) + (c[0] - b[0]) * (gy - c[1])) / det
        l2 = ((c[1] - a[1]) * (gx - c[0]) + (a[0] - c[0]) * (gy - c[1])) / det
        inside = (l1 >= 0) & (l2 >= 0) & (1 - l1 - l2 >= 0)
        bmp[y0:y1 + 1, x0:x1 + 1][inside] = 1.0
    hh, ww = h // ss, w // ss
    bmp = bmp[:hh * ss, :ww * ss].reshape(hh, ss, ww, ss).mean((1, 3))
    # Height of the glyph box in bitmap pixels; the caller scales letters by it.
    return bmp, (hi[1] - lo[1]) * px_per_unit, pad // ss


def sample_bitmap(bmp, u, v, height_m, glyph_px, pad):
    """
    Samples a text bitmap placed with its lower-left glyph corner at u = v = 0 (metres) and a
    glyph height of height_m. Returns coverage 0..1 (bilinear).
    """
    s = glyph_px / height_m
    x = u * s + pad - 0.5
    y = v * s + pad - 0.5
    h, w = bmp.shape
    inside = (x >= 0) & (x < w - 1) & (y >= 0) & (y < h - 1)
    out = np.zeros(u.shape, np.float32)
    xi = np.clip(np.floor(x).astype(int), 0, w - 2)
    yi = np.clip(np.floor(y).astype(int), 0, h - 2)
    fx = np.clip(x - xi, 0, 1)
    fy = np.clip(y - yi, 0, 1)
    val = (bmp[yi, xi] * (1 - fx) * (1 - fy) + bmp[yi, xi + 1] * fx * (1 - fy) +
           bmp[yi + 1, xi] * (1 - fx) * fy + bmp[yi + 1, xi + 1] * fx * fy)
    out[inside] = val[inside]
    return out


def height_to_normal(h, pos, cov, pid, strength=1.0):
    """Tangent-space normal map from a height field (metres) rasterised in UV space."""
    tex = np.zeros(h.shape + (3,), np.float32)
    # World size of a texel, from the position map (robust median over the atlas).
    dpx = np.linalg.norm(np.diff(pos, axis=1), axis=-1)
    dpy = np.linalg.norm(np.diff(pos, axis=0), axis=-1)
    gx = np.zeros_like(h)
    gy = np.zeros_like(h)
    okx = cov[:, 1:] & cov[:, :-1] & (pid[:, 1:] == pid[:, :-1]) & (dpx < 0.03)
    oky = cov[1:, :] & cov[:-1, :] & (pid[1:, :] == pid[:-1, :]) & (dpy < 0.03)
    dhx = np.where(okx, np.diff(h, axis=1) / np.maximum(dpx, 1e-5), 0)
    dhy = np.where(oky, np.diff(h, axis=0) / np.maximum(dpy, 1e-5), 0)
    gx[:, :-1] += dhx
    gx[:, 1:] += dhx
    gy[:-1, :] += dhy
    gy[1:, :] += dhy
    gx *= 0.5 * strength
    gy *= 0.5 * strength
    n = np.stack([-gx, -gy, np.ones_like(h)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    tex[...] = n * 0.5 + 0.5
    return tex
