"""
Aircraft texturing (shared): one UV atlas over the painted skin parts, Cycles bakes (AO,
decals) and a livery computed per texel with numpy by the aircraft type.
Produces the base colour and a packed occlusion/roughness/metallic map.
"""

import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

# Trapanotto Airlines house colours (sRGB)
WHITE = (0.93, 0.93, 0.91)
RED = (0.76, 0.05, 0.07)
NAVY = (0.07, 0.10, 0.20)
BELLY = (0.80, 0.81, 0.83)
GREY = (0.62, 0.64, 0.66)
DARK = (0.13, 0.14, 0.15)
WALK = (0.30, 0.31, 0.32)
WINDOW = (0.05, 0.07, 0.10)
METAL = (0.74, 0.75, 0.77)


# ---------------------------------------------------------------------------
# UV atlas
# ---------------------------------------------------------------------------

def unwrap_atlas(objs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.0015,
                             area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(rotate=True, margin=0.0025)
    bpy.ops.object.mode_set(mode="OBJECT")


# ---------------------------------------------------------------------------
# Bake helpers
# ---------------------------------------------------------------------------

def new_image(name, size, float_buffer=False, color=(0, 0, 0, 0), non_color=False):
    img = bpy.data.images.get(name)
    if img:
        bpy.data.images.remove(img)
    img = bpy.data.images.new(name, size, size, alpha=True, float_buffer=float_buffer)
    img.generated_color = color
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    return img


def bake_target_node(mat):
    nt = mat.node_tree
    node = nt.nodes.get("BakeTarget") or nt.nodes.new("ShaderNodeTexImage")
    node.name = "BakeTarget"
    nt.nodes.active = node
    return node


def bake(objs, bake_type, image, mat, samples=16, selected_to_active=None, margin=12, clear=True,
         cage_extrusion=0.03, max_ray_distance=0.06):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    node = bake_target_node(mat)
    node.image = image
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    active = selected_to_active or objs[0]
    active.select_set(True)
    bpy.context.view_layer.objects.active = active
    bk = scene.render.bake
    bk.margin = margin
    bk.use_clear = clear
    bk.use_selected_to_active = selected_to_active is not None
    if selected_to_active is not None:
        bk.cage_extrusion = cage_extrusion
        bk.max_ray_distance = max_ray_distance
    bpy.ops.object.bake(type=bake_type)


def pixels(img):
    a = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4)


def set_pixels(img, arr):
    img.pixels.foreach_set(arr.astype(np.float32).ravel())
    img.update()


# ---------------------------------------------------------------------------
# UV-space rasteriser: world position, normal and part id per texel
# ---------------------------------------------------------------------------

def rasterize_parts(objs, size):
    """Rasterises every triangle of every atlas part into UV space (numpy, no Cycles)."""
    pos = np.zeros((size, size, 3), np.float32)
    nrm = np.zeros((size, size, 3), np.float32)
    pid = np.full((size, size), -1, np.int16)
    for part_index, obj in enumerate(objs):
        me = obj.data
        me.calc_loop_triangles()
        uv = np.empty(len(me.loops) * 2, np.float32)
        me.uv_layers.active.data.foreach_get("uv", uv)
        uv = uv.reshape(-1, 2) * size - 0.5
        co = np.empty(len(me.vertices) * 3, np.float32)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        cn = np.empty(len(me.loops) * 3, np.float32)
        me.corner_normals.foreach_get("vector", cn)
        cn = cn.reshape(-1, 3)
        lv = np.empty(len(me.loops), np.int32)
        me.loops.foreach_get("vertex_index", lv)
        tris = np.empty(len(me.loop_triangles) * 3, np.int32)
        me.loop_triangles.foreach_get("loops", tris)
        tris = tris.reshape(-1, 3)
        mw = np.array(obj.matrix_world, np.float32)
        co = co @ mw[:3, :3].T + mw[:3, 3]
        cn = cn @ mw[:3, :3].T
        for t in tris:
            a, b, c = uv[t[0]], uv[t[1]], uv[t[2]]
            x0 = max(int(np.floor(min(a[0], b[0], c[0]))), 0)
            x1 = min(int(np.ceil(max(a[0], b[0], c[0]))), size - 1)
            y0 = max(int(np.floor(min(a[1], b[1], c[1]))), 0)
            y1 = min(int(np.ceil(max(a[1], b[1], c[1]))), size - 1)
            if x1 < x0 or y1 < y0:
                continue
            det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
            if abs(det) < 1e-12:
                continue
            gx, gy = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
            l1 = ((b[1] - c[1]) * (gx - c[0]) + (c[0] - b[0]) * (gy - c[1])) / det
            l2 = ((c[1] - a[1]) * (gx - c[0]) + (a[0] - c[0]) * (gy - c[1])) / det
            l3 = 1 - l1 - l2
            inside = (l1 >= -0.02) & (l2 >= -0.02) & (l3 >= -0.02)
            if not inside.any():
                continue
            w = np.stack([l1[inside], l2[inside], l3[inside]], -1)
            px, py = gx[inside], gy[inside]
            pos[py, px] = w @ co[lv[t]]
            n = w @ cn[t]
            nrm[py, px] = n / np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-9)
            pid[py, px] = part_index
    # Bleed values a few texels past island borders so mipmaps and filtering stay clean.
    covered = pid >= 0
    for _ in range(10):
        missing = ~covered
        if not missing.any():
            break
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            src = np.roll(covered, (dy, dx), (0, 1))
            fill = missing & src
            pos[fill] = np.roll(pos, (dy, dx), (0, 1))[fill]
            nrm[fill] = np.roll(nrm, (dy, dx), (0, 1))[fill]
            pid[fill] = np.roll(pid, (dy, dx), (0, 1))[fill]
            covered = covered | fill
            missing = ~covered
    return pos, nrm, pid


# ---------------------------------------------------------------------------
# Decals (lettering, logos)
# ---------------------------------------------------------------------------

def font_paths():
    """Inter (SIL OFL, shipped with Blender), then common system fonts."""
    v = f"{bpy.app.version[0]}.{bpy.app.version[1]}"
    base = os.path.dirname(bpy.app.binary_path)
    return [os.path.join(base, v, "datafiles", "fonts", "Inter.woff2"),
            "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]


_FONT = []


def load_font():
    if _FONT:
        return _FONT[0]
    for path in font_paths():
        if os.path.exists(path):
            try:
                _FONT.append(bpy.data.fonts.load(path))
                return _FONT[0]
            except RuntimeError:
                continue
    _FONT.append(None)
    return None


def basis(x_axis, y_axis):
    x, y = Vector(x_axis), Vector(y_axis)
    z = x.cross(y)
    m = Matrix((x, y, z)).transposed()
    return m.to_4x4()


def side_axes(side):
    """
    (reading direction, up) for lettering on the +X (side=1) or -X (side=-1) side.
    A viewer standing at +X has the tail (+Y) on the right, at -X the nose: text reads left to
    right for the viewer on both sides.
    """
    return ((0, 1, 0), (0, 0, 1)) if side > 0 else ((0, -1, 0), (0, 0, 1))


def text_mesh(col, name, body, size, center, x_axis, y_axis, color, font=None, bold=0.02,
              spacing=1.05):
    """Flat lettering in the plane spanned by x_axis (reading direction) and y_axis (up)."""
    font = font or load_font()
    curve = bpy.data.curves.new(name, "FONT")
    curve.body = body
    curve.size = size
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.space_character = spacing
    curve.offset = bold * size
    if font:
        curve.font = font
    tmp = bpy.data.objects.new(name + "_tmp", curve)
    col.objects.link(tmp)
    deps = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(tmp.evaluated_get(deps))
    bpy.data.objects.remove(tmp)
    obj = bpy.data.objects.new(name, mesh)
    col.objects.link(obj)
    m = Matrix.Translation(Vector(center)) @ basis(x_axis, y_axis)
    mesh.transform(m)
    finish_decal(obj, color)
    return obj


def polygon_decal(col, name, outline, center, x_axis, y_axis, color, layer=0):
    """Flat polygon decal (logos); outline in 2D decal coordinates."""
    verts = [(x, y, 0) for x, y in outline]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], [tuple(range(len(verts)))])
    obj = bpy.data.objects.new(name, mesh)
    col.objects.link(obj)
    mesh.transform(Matrix.Translation(Vector(center)) @ basis(x_axis, y_axis))
    finish_decal(obj, color)
    obj["layer"] = layer
    return obj


def circle_outline(r, n=40, cx=0.0, cy=0.0):
    return [(cx + r * math.cos(2 * math.pi * k / n), cy + r * math.sin(2 * math.pi * k / n))
            for k in range(n)]


def swiss_flag(col, name, size, center, x_axis, y_axis):
    """Small square Swiss flag (registration marking): red square + white cross."""
    h = size / 2
    sq = polygon_decal(col, name + "_bg", [(-h, -h), (h, -h), (h, h), (-h, h)], center, x_axis,
                       y_axis, RED)
    u = size * 0.6 / 20.0
    a, b = 3 * u, 10 * u
    vert = [(-a, -b), (a, -b), (a, b), (-a, b)]
    horiz = [(-b, -a), (b, -a), (b, a), (-b, a)]
    v = polygon_decal(col, name + "_xv", vert, center, x_axis, y_axis, WHITE, layer=1)
    h = polygon_decal(col, name + "_xh", horiz, center, x_axis, y_axis, WHITE, layer=1)
    return [sq, v, h]


def trapanotto_logo(col, name, size, center, x_axis, y_axis, ring=WHITE, letter=NAVY):
    """Airline logo: a white disc with a bold navy 'T' and a red wing stroke."""
    objs = [polygon_decal(col, name + "_disc", circle_outline(size / 2), center, x_axis, y_axis,
                          ring)]
    t = size
    # The T from two convex rectangles (concave outlines triangulate badly).
    bar = [(-0.30 * t, 0.12 * t), (0.30 * t, 0.12 * t), (0.30 * t, 0.26 * t), (-0.30 * t, 0.26 * t)]
    stem = [(-0.07 * t, -0.32 * t), (0.07 * t, -0.32 * t), (0.07 * t, 0.125 * t), (-0.07 * t, 0.125 * t)]
    objs.append(polygon_decal(col, name + "_t", bar, center, x_axis, y_axis, letter, layer=1))
    objs.append(polygon_decal(col, name + "_s", stem, center, x_axis, y_axis, letter, layer=1))
    wing = [(-0.40 * t, 0.02 * t), (0.42 * t, 0.20 * t), (0.40 * t, 0.10 * t), (-0.38 * t, -0.06 * t)]
    objs.append(polygon_decal(col, name + "_w", wing, center, x_axis, y_axis, RED, layer=2))
    return objs


def finish_decal(obj, color):
    """Triangulate + subdivide so the shrinkwrap can bend the decal onto curved skin."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges, cuts=2, use_grid_fill=True)
    bm.to_mesh(obj.data)
    bm.free()
    mat = bpy.data.materials.new(obj.name + "_mat")
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        if n.type != "OUTPUT_MATERIAL":
            nt.nodes.remove(n)
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (*srgb_to_linear(color), 1)
    nt.links.new(em.outputs[0], nt.nodes["Material Output"].inputs["Surface"])
    obj.data.materials.append(mat)
    obj["decal_color"] = list(color)


def shrinkwrap_onto(obj, target, offset=0.004):
    mod = obj.modifiers.new("wrap", "SHRINKWRAP")
    mod.target = target
    mod.wrap_method = "NEAREST_SURFACEPOINT"
    mod.wrap_mode = "OUTSIDE_SURFACE"
    mod.offset = offset
    deps = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(obj.evaluated_get(deps))
    obj.modifiers.clear()
    old = obj.data
    obj.data = me
    me.materials.clear()
    for m in old.materials:
        me.materials.append(m)
    bpy.data.meshes.remove(old)


# ---------------------------------------------------------------------------
# Livery painting
# ---------------------------------------------------------------------------

def srgb_to_linear(c):
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


def linear_to_srgb(a):
    a = np.clip(a, 0, 1)
    return np.where(a <= 0.0031308, a * 12.92, 1.055 * np.power(a, 1 / 2.4) - 0.055)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def value_noise(p, scale):
    """Cheap smooth 3D value noise from sines; good enough for subtle grime."""
    q = p * scale
    n = (np.sin(q[..., 0] * 1.7 + np.sin(q[..., 1] * 2.3)) + np.sin(q[..., 1] * 1.3 + np.sin(q[..., 2] * 2.9))
         + np.sin(q[..., 2] * 1.9 + np.sin(q[..., 0] * 3.1)))
    return n / 3


class Masks:
    """Per-texel data handed to a livery: world position, normal and part masks."""

    def __init__(self, pos, nrm, pid, names):
        self.pos, self.nrm, self.pid, self.names = pos, nrm, pid, names
        self.x, self.y, self.z = pos[..., 0], pos[..., 1], pos[..., 2]
        self.ax = np.abs(self.x)
        self.nx, self.ny, self.nz = nrm[..., 0], nrm[..., 1], nrm[..., 2]
        self.shape = pos.shape[:2]

    def part(self, *names):
        """Mask of parts; a name ending in '*' matches as a prefix."""
        m = np.zeros(self.shape, bool)
        for i, n in enumerate(self.names):
            for p in names:
                if (p.endswith("*") and n.startswith(p[:-1])) or n == p:
                    m |= self.pid == i
        return m


class Canvas:
    """Colour, roughness and metalness being painted."""

    def __init__(self, masks, base, rough=0.32):
        self.m = masks
        self.col = np.empty(masks.shape + (3,), np.float32)
        self.col[:] = base
        self.rough = np.full(masks.shape, rough, np.float32)
        self.metal = np.zeros(masks.shape, np.float32)

    def put(self, mask, color, rough=None, metal=None):
        self.col[mask] = color
        if rough is not None:
            self.rough[mask] = rough
        if metal is not None:
            self.metal[mask] = metal

    def shade(self, mask, k):
        """Multiplies colour (panel lines, soot)."""
        self.col[mask] *= k

    def finish(self, ao, grime=0.035):
        g = value_noise(self.m.pos, 3.0) * 0.5 + value_noise(self.m.pos, 11.0) * 0.5
        self.col *= (1 + grime * g)[..., None]
        self.rough = np.clip(self.rough + 0.05 * g, 0.05, 1)
        self.col *= (0.55 + 0.45 * ao)[..., None]
        return np.clip(self.col, 0, 1), self.rough, self.metal


def paint_logo(c, mask, u, v, cu, cv, size):
    """
    Airline logo painted into the livery (white disc, navy T, red wing stroke), in the 2D
    coordinates (u, v) of a surface (fins: u = y, v = z). Reliable at any aircraft size.
    """
    du, dv = (u - cu) / size, (v - cv) / size
    c.put(mask & (du * du + dv * dv <= 0.25), WHITE, 0.30)
    bar = (np.abs(du) <= 0.30) & (dv >= 0.12) & (dv <= 0.26)
    stem = (np.abs(du) <= 0.07) & (dv >= -0.32) & (dv <= 0.26)
    c.put(mask & (bar | stem), NAVY, 0.30)
    # Wing stroke: a band along the segment (-0.39, -0.02) -> (0.41, 0.15), 0.08 thick.
    ax, ay, bx, by = -0.39, -0.02, 0.41, 0.15
    t = np.clip(((du - ax) * (bx - ax) + (dv - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2), 0, 1)
    d = np.hypot(du - (ax + t * (bx - ax)), dv - (ay + t * (by - ay)))
    c.put(mask & (d <= 0.045), RED, 0.30)


def near(values, targets, width):
    """True where `values` is within width of any target (panel lines)."""
    m = np.zeros(values.shape, bool)
    for t in targets:
        m |= np.abs(values - t) < width
    return m


def rounded_rect(u, v, cu, cv, hu, hv, r):
    """Mask of a rounded rectangle in (u, v) coordinates (windows, doors)."""
    du = np.maximum(np.abs(u - cu) - (hu - r), 0)
    dv = np.maximum(np.abs(v - cv) - (hv - r), 0)
    return du * du + dv * dv <= r * r


# ---------------------------------------------------------------------------
# Atlas
# ---------------------------------------------------------------------------

def dimension(objs):
    """Largest extent of the parts in metres (scales bake distances for big aircraft)."""
    lo = [1e9, 1e9, 1e9]
    hi = [-1e9, -1e9, -1e9]
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = [min(a, b) for a, b in zip(lo, w)]
            hi = [max(a, b) for a, b in zip(hi, w)]
    return max(b - a for a, b in zip(lo, hi))


def texture_atlas(parts, names, livery, decals_fn, size=2048, ao_samples=64, base_name="AC",
                  material="Airframe"):
    """
    parts: {name: object}; names: the painted skin parts (atlas order).
    livery(masks) -> Canvas; decals_fn(col, parts) -> {target part: [decal objects]}.
    """
    objs = [parts[n] for n in names]
    unwrap_atlas(objs)
    mat = bpy.data.materials[material]
    dim = dimension(objs)
    k = max(1.0, dim / 12)

    img_ao = new_image("bake_ao", size, non_color=True)
    scene = bpy.context.scene
    if scene.world is None:
        scene.world = bpy.data.worlds.new("BakeWorld")
    # AO reach ~1 m on a light aircraft, more on big ones: dark only in real creases.
    scene.world.light_settings.distance = 0.9 * k
    bake(objs, "AO", img_ao, mat, samples=ao_samples)
    pos, n, pid = rasterize_parts(objs, size)
    covered = pid >= 0

    col = bpy.data.collections.new("Decals")
    bpy.context.scene.collection.children.link(col)
    decals = decals_fn(col, parts)
    for target, ds in decals.items():
        for o in ds:
            # Stacked decals (logo layers) keep their order: the outer one is hit first.
            shrinkwrap_onto(o, parts[target], 0.004 * k + 0.003 * k * o.get("layer", 0))
    img_dc = new_image("bake_decal_color", size, float_buffer=True)
    img_dm = new_image("bake_decal_mask", size, float_buffer=True, non_color=True)
    baked = False
    for img, white in ((img_dc, False), (img_dm, True)):
        first = True
        for target, ds in decals.items():
            if not ds:
                continue
            if white:
                for d in ds:
                    em = d.data.materials[0].node_tree.nodes["Emission"]
                    em.inputs["Color"].default_value = (1, 1, 1, 1)
            # margin=0: rays that miss a letter must not be smeared into the gaps.
            bake(ds, "EMIT", img, mat, samples=16, selected_to_active=parts[target], clear=first,
                 margin=0, cage_extrusion=0.03 * k, max_ray_distance=0.06 * k)
            first = False
            baked = True

    ao = pixels(img_ao)[..., 0]
    canvas = livery(Masks(pos, n, pid, names))
    color, rough, metal = canvas.finish(np.where(covered, ao, 1.0))
    if baked:
        dmask = np.clip(pixels(img_dm)[..., 0], 0, 1)
        dcol = linear_to_srgb(pixels(img_dc)[..., :3])
        color = color * (1 - dmask[..., None]) + dcol * dmask[..., None]
        rough = rough * (1 - dmask) + 0.3 * dmask
        metal = metal * (1 - dmask)
    color[~covered] = (0.9, 0.9, 0.9)

    base = new_image(f"{base_name}_BaseColor", size)
    rgba = np.concatenate([color, np.ones(color.shape[:2] + (1,), np.float32)], axis=-1)
    set_pixels(base, rgba)
    orm_arr = np.stack([np.ones_like(rough), rough, metal, np.ones_like(rough)], -1)
    orm = new_image(f"{base_name}_ORM", size, non_color=True)
    set_pixels(orm, orm_arr)
    orm.scale(size // 2, size // 2)

    bpy.data.collections.remove(col)
    for d in [d for ds in decals.values() for d in ds]:
        if d.name in bpy.data.objects:
            bpy.data.objects.remove(d)
    wire_airframe_material(mat, base, orm)
    return base, orm


def wire_airframe_material(mat, base, orm):
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    for n in list(nt.nodes):
        if n.name == "BakeTarget":
            nt.nodes.remove(n)
    tb = nt.nodes.new("ShaderNodeTexImage")
    tb.image = base
    to = nt.nodes.new("ShaderNodeTexImage")
    to.image = orm
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(tb.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(to.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])


def save_images(images, folder):
    os.makedirs(folder, exist_ok=True)
    for img in images:
        img.filepath_raw = os.path.join(folder, img.name + ".png")
        img.file_format = "PNG"
        img.save()
