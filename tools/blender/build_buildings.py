"""
Regional Swiss building set: bodies (walls) and roofs per type, plus churches.

Run:  blender -b --factory-startup -P tools/blender/build_buildings.py
Out:  build/buildings_raw.glb, build/buildings_preview.png

Contract with the game (src/buildings):
  Body_<type>  unit footprint x,y in [-0.5, 0.5] (Blender), walls z in [-0.3, 1]; the game scales
               it to (length, width, wall height). z < 0 is foundation for sloped ground.
  Roof_<type>  sits on z = 0 at the eaves, built for width 1: scale (length, width, width) keeps
               the pitch. Contains gable walls and chimneys.
  Church_<v>   whole church, scaled uniformly (nave length 1).
  UVMap  (u, v) = atlas cell below / above the split height; UV1.x = split height in metres.
"""

import math
import os
import sys

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
BUILD = os.path.join(ROOT, "build")
os.makedirs(BUILD, exist_ok=True)

import bld_textures as tex  # noqa: E402

C = tex.CELLS


class MeshBuilder:
    """Collects faces with per-face atlas cells (below/above split) and a split height."""

    def __init__(self):
        self.verts = []
        self.faces = []
        self.cells = []  # (cell_low, cell_high, split_m) per face

    def face(self, pts, low, high=None, split=0.0):
        i0 = len(self.verts)
        self.verts.extend(pts)
        self.faces.append(tuple(range(i0, i0 + len(pts))))
        self.cells.append((low, low if high is None else high, split))

    def box(self, x0, x1, y0, y1, z0, z1, low, high=None, split=0.0, skip_bottom=True):
        p = lambda x, y, z: (x, y, z)  # noqa: E731
        self.face([p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)], low, high, split)  # -y
        self.face([p(x1, y1, z0), p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1)], low, high, split)  # +y
        self.face([p(x0, y1, z0), p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1)], low, high, split)  # -x
        self.face([p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)], low, high, split)  # +x
        self.face([p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)], low, high, split)  # top
        if not skip_bottom:
            self.face([p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0), p(x0, y0, z0)], low, high, split)

    def slab(self, pts, thickness, cell):
        """Planar quad/polygon with thickness downwards (roof plane visible from below too)."""
        top = list(pts)
        bot = [(x, y, z - thickness) for x, y, z in pts]
        self.face(top, cell)
        self.face(list(reversed(bot)), cell)
        n = len(pts)
        for i in range(n):
            j = (i + 1) % n
            self.face([bot[i], bot[j], top[j], top[i]], cell)

    def build(self, name, col, mat):
        me = bpy.data.meshes.new(name)
        me.from_pydata(self.verts, [], self.faces)
        me.validate()
        uv0 = me.uv_layers.new(name="UVMap")
        uv1 = me.uv_layers.new(name="UV1")
        for poly, (lo, hi, split) in zip(me.polygons, self.cells):
            for li in poly.loop_indices:
                uv0.data[li].uv = (lo, hi)
                uv1.data[li].uv = (split, 0)
        for p in me.polygons:
            p.use_smooth = False
        me.materials.append(mat)
        obj = bpy.data.objects.new(name, me)
        col.objects.link(obj)
        return obj


# ---------------------------------------------------------------------------
# Bodies
# ---------------------------------------------------------------------------

def body(name, low, high, split, col, mat, balcony=None):
    m = MeshBuilder()
    m.box(-0.5, 0.5, -0.5, 0.5, -0.3, 1.0, low, high, split)
    if balcony:
        # Balcony along the front (+y) side at upper floor level: slab + railing boards.
        z = balcony
        m.box(-0.42, 0.42, 0.5, 0.62, z - 0.02, z + 0.015, C["chalet_wood"])
        m.box(-0.42, 0.42, 0.6, 0.62, z + 0.015, z + 0.13, C["chalet_wood"])
        for x in (-0.42, 0.4):
            m.box(x, x + 0.02, 0.5, 0.62, z + 0.015, z + 0.13, C["chalet_wood"])
    return m.build(f"Body_{name}", col, mat)


# ---------------------------------------------------------------------------
# Roofs (width 1 across y, length 1 along x; eaves at z = 0)
# ---------------------------------------------------------------------------

def gable_roof(name, pitch_deg, over_side, over_gable, roof_cell, wall_cell, col, mat, chimney=True):
    m = MeshBuilder()
    r = 0.5 * math.tan(math.radians(pitch_deg))
    t = 0.022
    xs, xe = -0.5 - over_gable, 0.5 + over_gable
    ye = 0.5 + over_side
    drop = over_side * math.tan(math.radians(pitch_deg))
    # Two roof planes from the eaves (with overhang, dropping a little) to the ridge.
    m.slab([(xs, -ye, -drop), (xe, -ye, -drop), (xe, 0, r), (xs, 0, r)], t, roof_cell)
    m.slab([(xe, ye, -drop), (xs, ye, -drop), (xs, 0, r), (xe, 0, r)], t, roof_cell)
    # Gable walls (triangles above the eaves on both ends).
    for x, order in ((-0.5, 1), (0.5, -1)):
        tri = [(x, -0.5, 0), (x, 0.5, 0), (x, 0, r)]
        m.face(tri if order < 0 else list(reversed(tri)), wall_cell)
    if chimney:
        m.box(0.18, 0.26, 0.08, 0.16, r * 0.4, r + 0.12, C["stone_plain"])
    return m.build(f"Roof_{name}", col, mat)


def hip_roof(name, pitch_deg, over, roof_cell, col, mat, ridge_frac=0.45, chimney=True):
    """Hip roof: ridge shorter than the house; for wide-overhang farmhouses and Ticino houses."""
    m = MeshBuilder()
    r = 0.5 * math.tan(math.radians(pitch_deg))
    t = 0.022
    e = 0.5 + over
    drop = over * math.tan(math.radians(pitch_deg))
    hx = ridge_frac / 2
    a, b, c, d = (-e, -e, -drop), (e, -e, -drop), (e, e, -drop), (-e, e, -drop)
    r0, r1 = (-hx, 0, r), (hx, 0, r)
    m.slab([a, b, r1, r0], t, roof_cell)  # front
    m.slab([c, d, r0, r1], t, roof_cell)  # back
    m.slab([b, c, r1], t, roof_cell)      # right hip
    m.slab([d, a, r0], t, roof_cell)      # left hip
    if chimney:
        m.box(0.05, 0.13, -0.15, -0.07, r * 0.3, r + 0.1, C["stone_plain"])
    return m.build(f"Roof_{name}", col, mat)


def flat_roof(name, roof_cell, wall_cell, col, mat, parapet=0.03):
    m = MeshBuilder()
    m.face([(-0.5, -0.5, 0.002), (0.5, -0.5, 0.002), (0.5, 0.5, 0.002), (-0.5, 0.5, 0.002)], roof_cell)
    # Parapet ring.
    w = 0.012
    for x0, x1, y0, y1 in ((-0.5, 0.5, -0.5, -0.5 + w), (-0.5, 0.5, 0.5 - w, 0.5),
                           (-0.5, -0.5 + w, -0.5, 0.5), (0.5 - w, 0.5, -0.5, 0.5)):
        m.box(x0, x1, y0, y1, 0, parapet, wall_cell)
    # Roof structure (stair/lift housing).
    m.box(-0.1, 0.08, -0.12, 0.1, 0, 0.09, wall_cell)
    return m.build(f"Roof_{name}", col, mat)


def mono_roof(name, pitch_deg, roof_cell, wall_cell, col, mat):
    m = MeshBuilder()
    h = math.tan(math.radians(pitch_deg))
    m.slab([(-0.55, -0.56, 0), (0.55, -0.56, 0), (0.55, 0.56, h * 1.12), (-0.55, 0.56, h * 1.12)], 0.02, roof_cell)
    for x, order in ((-0.5, 1), (0.5, -1)):
        tri = [(x, -0.5, 0), (x, 0.5, 0), (x, 0.5, h)]
        m.face(tri if order < 0 else list(reversed(tri)), wall_cell)
    m.face([(0.5, 0.5, 0), (-0.5, 0.5, 0), (-0.5, 0.5, h), (0.5, 0.5, h)], wall_cell)
    return m.build(f"Roof_{name}", col, mat)


# ---------------------------------------------------------------------------
# Churches (uniform scale, nave length 1)
# ---------------------------------------------------------------------------

def church(variant, col, mat):
    m = MeshBuilder()
    W, H = 0.42, 0.42
    m.box(-0.5, 0.5, -W / 2, W / 2, -0.1, H, C["church"])
    # Nave roof.
    r = W / 2 * math.tan(math.radians(45))
    m.slab([(-0.52, -W / 2 - 0.03, H - 0.03), (0.52, -W / 2 - 0.03, H - 0.03), (0.52, 0, H + r), (-0.52, 0, H + r)], 0.015,
           C["roof_gneiss"] if variant == "campanile" else C["roof_clay"])
    m.slab([(0.52, W / 2 + 0.03, H - 0.03), (-0.52, W / 2 + 0.03, H - 0.03), (-0.52, 0, H + r), (0.52, 0, H + r)], 0.015,
           C["roof_gneiss"] if variant == "campanile" else C["roof_clay"])
    for x, order in ((-0.5, 1), (0.5, -1)):
        tri = [(x, -W / 2, H), (x, W / 2, H), (x, 0, H + r)]
        m.face(tri if order < 0 else list(reversed(tri)), C["church"])
    # Apse at the east end.
    m.box(0.5, 0.62, -W * 0.35, W * 0.35, -0.1, H * 0.8, C["church"])
    if variant == "spire":
        s = 0.17
        top = 1.05
        m.box(-0.62, -0.62 + s, -s / 2, s / 2, -0.1, top, C["church"])
        cx, cy = -0.62 + s / 2, 0
        tip = (cx, cy, top + 0.55)
        corners = [(-0.62, -s / 2, top), (-0.62 + s, -s / 2, top), (-0.62 + s, s / 2, top), (-0.62, s / 2, top)]
        for i in range(4):
            m.face([corners[i], corners[(i + 1) % 4], tip], C["roof_metal"])
    else:  # Ticino campanile: free-standing square tower, belfry, low pyramid roof
        s = 0.14
        x0, y0 = -0.75, W / 2 + 0.05
        top = 1.15
        m.box(x0, x0 + s, y0, y0 + s, -0.1, top, C["stone_rubble"])
        tip = (x0 + s / 2, y0 + s / 2, top + 0.12)
        corners = [(x0 - 0.01, y0 - 0.01, top), (x0 + s + 0.01, y0 - 0.01, top), (x0 + s + 0.01, y0 + s + 0.01, top), (x0 - 0.01, y0 + s + 0.01, top)]
        for i in range(4):
            m.face([corners[i], corners[(i + 1) % 4], tip], C["roof_gneiss"])
    return m.build(f"Church_{variant}", col, mat)


# ---------------------------------------------------------------------------

TYPES = {
    # name: (body args, roof builder)
    "farmhouse": (dict(low=C["plaster_window"], high=C["farm_wood"], split=3.2),
                  lambda col, mat: hip_roof("farmhouse", 42, 0.14, C["roof_clay"], col, mat, ridge_frac=0.55)),
    "chalet": (dict(low=C["stone_plain"], high=C["chalet_wood"], split=1.4, balcony=0.62),
               lambda col, mat: gable_roof("chalet", 24, 0.14, 0.1, C["roof_shingle"], C["chalet_wood"], col, mat)),
    "valais": (dict(low=C["stone_rubble"], high=C["larch_dark"], split=1.8),
               lambda col, mat: gable_roof("valais", 28, 0.07, 0.05, C["roof_gneiss"], C["larch_dark"], col, mat, chimney=False)),
    "engadin": (dict(low=C["engadin"], high=C["engadin"], split=0),
                lambda col, mat: gable_roof("engadin", 20, 0.04, 0.03, C["roof_metal"], C["engadin"], col, mat)),
    "rustico": (dict(low=C["stone_rubble"], high=C["stone_rubble"], split=0),
                lambda col, mat: gable_roof("rustico", 28, 0.03, 0.02, C["roof_gneiss"], C["stone_rubble"], col, mat, chimney=False)),
    "ticino": (dict(low=C["pastel_window"], high=C["pastel_window"], split=0),
               lambda col, mat: hip_roof("ticino", 18, 0.07, C["roof_clay"], col, mat, ridge_frac=0.3)),
    "urban": (dict(low=C["urban"], high=C["urban"], split=0),
              lambda col, mat: gable_roof("urban", 35, 0.05, 0.03, C["roof_clay"], C["urban"], col, mat)),
    "block": (dict(low=C["urban"], high=C["urban"], split=0),
              lambda col, mat: flat_roof("block", C["roof_gravel"], C["urban"], col, mat)),
    "hall": (dict(low=C["metal_hall"], high=C["metal_hall"], split=0),
             lambda col, mat: flat_roof("hall", C["roof_metal"], C["metal_hall"], col, mat, parapet=0.01)),
    "shed": (dict(low=C["farm_wood"], high=C["farm_wood"], split=0),
             lambda col, mat: mono_roof("shed", 12, C["roof_metal"], C["farm_wood"], col, mat)),
}


def make_material(atlas_img):
    mat = bpy.data.materials.new("Buildings")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = atlas_img
    nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.85
    return mat


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    atlas = tex.build_atlas()
    size = atlas.shape[0]
    img = bpy.data.images.new("BuildingAtlas", size, size, alpha=True)
    img.pixels.foreach_set(atlas.astype(np.float32).ravel())
    img.filepath_raw = os.path.join(BUILD, "building_atlas.png")
    img.file_format = "PNG"
    img.save()
    mat = make_material(img)

    col = bpy.context.scene.collection
    root = bpy.data.objects.new("Buildings", None)
    col.objects.link(root)
    tris = {}
    for name, (bargs, roof_fn) in TYPES.items():
        b = body(name, bargs["low"], bargs["high"], bargs["split"], col, mat, bargs.get("balcony"))
        r = roof_fn(col, mat)
        for o in (b, r):
            o.parent = root
        tris[name] = sum(len(p.vertices) - 2 for o in (b, r) for p in o.data.polygons)
    for v in ("spire", "campanile"):
        o = church(v, col, mat)
        o.parent = root
        tris[f"church_{v}"] = sum(len(p.vertices) - 2 for p in o.data.polygons)
    print("triangles per type:", tris)

    out = os.path.join(BUILD, "buildings_raw.glb")
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_image_format="WEBP",
                              export_image_quality=88, export_texcoords=True, export_normals=True,
                              export_materials="EXPORT", export_yup=True, export_apply=True)
    print("exported", out, os.path.getsize(out) // 1024, "KB")
    if "--preview" in sys.argv:
        preview(col)


def preview(col):
    """Lines up all types at a typical size and renders them (design review)."""
    import mathutils
    scene = bpy.context.scene
    sizes = {"farmhouse": (22, 16, 4.5), "chalet": (12, 10, 6), "valais": (8, 7, 6), "engadin": (14, 12, 7),
             "rustico": (8, 6, 5), "ticino": (12, 10, 7), "urban": (16, 11, 12), "block": (24, 14, 18),
             "hall": (40, 25, 8), "shed": (6, 4, 3)}
    x = 0
    for name, (L, W, H) in sizes.items():
        b = bpy.data.objects[f"Body_{name}"].copy()
        r = bpy.data.objects[f"Roof_{name}"].copy()
        col.objects.link(b)
        col.objects.link(r)
        b.parent = r.parent = None
        b.location = (x + L / 2, 0, 0)
        b.scale = (L, W, H)
        r.location = (x + L / 2, 0, H)
        r.scale = (L, W, W)
        x += L + 6
    for v, off in (("spire", 0), ("campanile", 40)):
        c = bpy.data.objects[f"Church_{v}"].copy()
        col.objects.link(c)
        c.parent = None
        c.location = (x + 15 + off, 0, 0)
        c.scale = (28, 28, 28)
    for o in list(bpy.data.objects):
        if o.parent and o.parent.name == "Buildings":
            o.hide_render = True
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 32
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = 1800, 700
    world = bpy.data.worlds.new("W")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.68, 0.85, 1)
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 4
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    col.objects.link(sun)
    bpy.ops.mesh.primitive_plane_add(size=2000, location=(x / 2, 0, -0.05))
    g = bpy.context.active_object
    gm = bpy.data.materials.new("Ground")
    gm.use_nodes = True
    gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.25, 0.35, 0.18, 1)
    g.data.materials.append(gm)
    cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
    col.objects.link(cam)
    cam.data.lens = 28
    cam.location = (x / 2, -95, 45)
    cam.rotation_euler = (mathutils.Vector((x / 2, 10, 2)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    scene.render.filepath = os.path.join(BUILD, "buildings_preview.png")
    bpy.ops.render.render(write_still=True)
    print("rendered", scene.render.filepath)


if __name__ == "__main__":
    main()
