"""
TR-1 texturing: shared UV atlas, Cycles bakes (position, normal, AO, decals) and a livery
computed per texel with numpy. Produces the base colour and a packed roughness/metallic map.
"""

import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

import tr1_geometry as geo

ATLAS_PARTS = ["Fuselage", "Wing_R", "Wing_L", "Flap_R", "Flap_L", "Aileron_R", "Aileron_L",
               "HStab", "Elevator_R", "Elevator_L", "Fin", "Rudder", "Spinner"]

FONT_CANDIDATES = ["/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
                   "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]

# Colours (sRGB)
WHITE = (0.93, 0.93, 0.91)
RED = (0.76, 0.05, 0.07)
BELLY = (0.80, 0.81, 0.83)
DARK = (0.13, 0.14, 0.15)
WALK = (0.30, 0.31, 0.32)
NAVY = (0.07, 0.10, 0.20)


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
         **kw):
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
        bk.cage_extrusion = kw.pop("cage_extrusion", 0.03)
        bk.max_ray_distance = kw.pop("max_ray_distance", 0.06)
    bpy.ops.object.bake(type=bake_type, **kw)


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
# Decals (lettering, Swiss cross)
# ---------------------------------------------------------------------------

def load_font():
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return bpy.data.fonts.load(path)
    return None


def basis(x_axis, y_axis):
    x, y = Vector(x_axis), Vector(y_axis)
    z = x.cross(y)
    m = Matrix((x, y, z)).transposed()
    return m.to_4x4()


def text_mesh(col, name, body, size, center, x_axis, y_axis, color, font):
    curve = bpy.data.curves.new(name, "FONT")
    curve.body = body
    curve.size = size
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.space_character = 1.05
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


def swiss_cross(col, name, size, center, x_axis, y_axis, color):
    """Swiss cross: arms 1/6 longer than wide (arm width 6, arm length 7 of 20 units)."""
    u = size / 20.0
    a, b = 3 * u, 10 * u  # half arm width, half total length
    outline = [(-a, b), (a, b), (a, a), (b, a), (b, -a), (a, -a), (a, -b), (-a, -b),
               (-a, -a), (-b, -a), (-b, a), (-a, a)]
    verts = [(x, y, 0) for x, y in outline]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], [tuple(range(len(verts)))])
    obj = bpy.data.objects.new(name, mesh)
    col.objects.link(obj)
    mesh.transform(Matrix.Translation(Vector(center)) @ basis(x_axis, y_axis))
    finish_decal(obj, color)
    return obj


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


def build_decals(col, parts):
    font = load_font()
    fus, fin, wing_l = parts["Fuselage"], parts["Fin"], parts["Wing_L"]
    decals = {"Fuselage": [], "Fin": [], "Wing_L": []}
    R, L = ((0, 1, 0), (0, 0, 1)), ((0, -1, 0), (0, 0, 1))
    for side, axes in ((1, R), (-1, L)):
        decals["Fuselage"].append(text_mesh(col, f"D_name_{side}", "TRAPANOTTO", 0.30,
                                            (side * 0.6, 2.05, 0.17), *axes, NAVY, font))
        decals["Fuselage"].append(text_mesh(col, f"D_model_{side}", "TR-1 ALPENFALKE", 0.10,
                                            (side * 0.6, -4.55, 0.10), *axes, WHITE, font))
        decals["Fin"].append(text_mesh(col, f"D_reg_{side}", "HB-TRP", 0.19,
                                       (side * 0.2, 4.30, 0.56), *axes, NAVY, font))
        decals["Fin"].append(swiss_cross(col, f"D_cross_{side}", 0.42,
                                         (side * 0.2, 4.78, 1.36), *axes, WHITE))
    decals["Wing_L"].append(text_mesh(col, "D_reg_wing", "HB-TRP", 0.52, (2.75, -0.55, -0.6),
                                      (1, 0, 0), (0, -1, 0), NAVY, font))
    for target_name, objs in decals.items():
        for o in objs:
            shrinkwrap_onto(o, parts[target_name])
    return decals


# ---------------------------------------------------------------------------
# Livery
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


def paint(pos, nrm, ao, pid):
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    ax = np.abs(x)
    nz = nrm[..., 2]
    shape = pos.shape[:2]
    col = np.empty(shape + (3,), np.float32)
    col[:] = WHITE
    rough = np.full(shape, 0.32, np.float32)

    def put(mask, c, r=None):
        col[mask] = c
        if r is not None:
            rough[mask] = r

    def part(*names):
        m = np.zeros(shape, bool)
        for n in names:
            m |= pid == ATLAS_PARTS.index(n)
        return m

    spinner = part("Spinner")
    fin = part("Fin", "Rudder")
    tail_h = part("HStab", "Elevator_R", "Elevator_L")
    wing = part("Wing_R", "Wing_L", "Flap_R", "Flap_L", "Aileron_R", "Aileron_L")
    fuse = part("Fuselage")

    # Fuselage
    put(fuse & (nz < -0.55), BELLY, 0.4)
    nose = fuse & (y < -3.70 - 0.5 * z)
    put(nose, RED, 0.3)
    t = np.clip((y + 3.9) / 7.8, 0, 1)
    zc = -0.12 + 0.17 * t
    w = 0.075 - 0.035 * t
    stripe = fuse & (np.abs(z - zc) < w) & (y > -3.95) & (y < 3.9) & (np.abs(nz) < 0.7)
    put(stripe, RED, 0.3)
    pin = fuse & (np.abs(z - (zc + w + 0.03)) < 0.008) & (y > -3.7) & (y < 3.75) & (np.abs(nz) < 0.7)
    put(pin, NAVY, 0.3)
    glare = fuse & (y > -3.95) & (y < -1.80) & (nz > 0.78) & (ax < 0.33)
    put(glare, DARK, 0.85)
    put(spinner, RED, 0.28)

    # Fin / rudder: red top, slanted boundary
    put(fin & (z > 0.80 + 0.10 * (y - 4.3)), RED, 0.3)
    # Tail plane and wing tips
    put(tail_h & (ax > 1.48), RED, 0.3)
    put(wing & (ax > 3.86), RED, 0.3)
    walk = wing & (nz > 0.6) & (ax > 0.62) & (ax < 1.28) & (y > -1.05) & (y < 0.35)
    put(walk, WALK, 0.95)

    # Panel lines
    lines = np.zeros(shape, bool)
    for yy in (-3.72, -2.95, -1.92, 1.42, 2.62, 3.55):
        lines |= fuse & (np.abs(y - yy) < 0.0045)
    cowl = fuse & (ax > 0.25) & (y > -5.05) & (y < -4.05)
    lines |= cowl & ((np.abs(z - 0.32) < 0.0045) | (np.abs(z + 0.30) < 0.0045))
    for xx in (0.64, 1.32, 2.6, 3.86):
        lines |= wing & (np.abs(ax - xx) < 0.0045)
    for xx in (0.7, 1.48):
        lines |= tail_h & (np.abs(ax - xx) < 0.004)
    col[lines] *= 0.62

    # Exhaust soot along the sides
    soot = fuse & (ax > 0.3) & (y > -3.95)
    s = np.exp(-np.clip(y + 3.85, 0, None) / 1.3) * smoothstep(0.22, 0.0, np.abs(z - 0.0))
    s = np.where(soot, s, 0)
    col *= (1 - 0.5 * s)[..., None]
    col += (s * 0.04)[..., None] * np.array([0.6, 0.45, 0.3])
    rough = rough + 0.35 * s

    # Subtle grime + ambient occlusion
    g = value_noise(pos, 3.0) * 0.5 + value_noise(pos, 11.0) * 0.5
    col *= (1 + 0.035 * g)[..., None]
    rough = np.clip(rough + 0.05 * g, 0.05, 1)
    col *= (0.55 + 0.45 * ao)[..., None]
    return np.clip(col, 0, 1), rough


def texture_atlas(parts, size=2048, ao_samples=64):
    objs = [parts[n] for n in ATLAS_PARTS]
    unwrap_atlas(objs)
    mat = bpy.data.materials["Airframe"]

    img_ao = new_image("bake_ao", size, non_color=True)
    # AO reach ~1 m: dark only in real creases (wing root, canopy sill, tail junction).
    scene = bpy.context.scene
    if scene.world is None:
        scene.world = bpy.data.worlds.new("BakeWorld")
    scene.world.light_settings.distance = 0.9
    # AO sees the whole aircraft (gear, canopy, exhausts darken the skin around them).
    bake(objs, "AO", img_ao, mat, samples=ao_samples)
    pos, n, pid = rasterize_parts(objs, size)
    covered = pid >= 0

    # Decals: colour pass and coverage mask, baked from decal meshes onto each skin part.
    col = bpy.data.collections.new("Decals")
    bpy.context.scene.collection.children.link(col)
    decals = build_decals(col, parts)
    img_dc = new_image("bake_decal_color", size, float_buffer=True)
    img_dm = new_image("bake_decal_mask", size, float_buffer=True, non_color=True)
    first = True
    for target, ds in decals.items():
        # margin=0: rays that miss a letter must not be smeared into the gaps.
        bake(ds, "EMIT", img_dc, mat, samples=16, selected_to_active=parts[target], clear=first,
             margin=0)
        first = False
    for ds in decals.values():
        for d in ds:
            em = d.data.materials[0].node_tree.nodes["Emission"]
            em.inputs["Color"].default_value = (1, 1, 1, 1)
    first = True
    for target, ds in decals.items():
        bake(ds, "EMIT", img_dm, mat, samples=16, selected_to_active=parts[target], clear=first,
             margin=0)
        first = False

    # Blender images start at the bottom row; the rasteriser used the same convention.
    ao = pixels(img_ao)[..., 0]
    color, rough = paint(pos, n, np.where(covered, ao, 1.0), pid)
    dmask = np.clip(pixels(img_dm)[..., 0], 0, 1)
    dcol = linear_to_srgb(pixels(img_dc)[..., :3])
    color = color * (1 - dmask[..., None]) + dcol * dmask[..., None]
    rough = rough * (1 - dmask) + 0.3 * dmask
    # Unused atlas space: neutral white so mip levels do not bleed dark borders.
    color[~covered] = WHITE

    base = new_image("TR1_BaseColor", size)
    rgba = np.concatenate([color, np.ones(color.shape[:2] + (1,), np.float32)], axis=-1)
    set_pixels(base, rgba)
    orm_arr = np.stack([np.ones_like(rough), rough, np.zeros_like(rough), np.ones_like(rough)], -1)
    orm = new_image("TR1_ORM", size, non_color=True)
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
