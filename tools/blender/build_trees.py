"""
Low-poly Swiss trees with vertex colours (no textures, no alpha): spruce, fir, larch, arolla
pine, Scots pine, beech, chestnut, sycamore maple, birch - three shapes each (Tree_<species>_<0..2>).
Height 1 (the game scales them), base at z = 0.

Run: blender -b --factory-startup -P tools/blender/build_trees.py
Out: build/trees_raw.glb, build/trees_preview.png (with --preview)
"""

import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Vector, noise

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
BUILD = os.path.join(ROOT, "build")
os.makedirs(BUILD, exist_ok=True)
random.seed(7)


def srgb(*c):
    # Plain sRGB 0..1: the glTF exporter converts colour attributes to linear itself.
    return tuple(x / 255 for x in c)


class Tree:
    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.col = self.bm.loops.layers.color.new("Col")

    def _paint(self, faces, color, ao_bottom=0.55, jitter=0.08, zmin=0.0, zmax=1.0):
        for f in faces:
            for loop in f.loops:
                z = loop.vert.co.z
                t = min(1, max(0, (z - zmin) / max(zmax - zmin, 1e-6)))
                shade = ao_bottom + (1 - ao_bottom) * t
                j = 1 + random.uniform(-jitter, jitter)
                loop[self.col] = (color[0] * shade * j, color[1] * shade * j, color[2] * shade * j, 1)

    def trunk(self, height, radius, color, sides=5):
        geom = bmesh.ops.create_cone(self.bm, cap_ends=False, segments=sides, radius1=radius,
                                     radius2=radius * 0.6, depth=height)
        bmesh.ops.translate(self.bm, verts=geom["verts"], vec=(0, 0, height / 2))
        faces = list({f for v in geom["verts"] for f in v.link_faces})
        self._paint(faces, color, 0.7, 0.05, 0, height)

    def cone(self, z0, z1, radius, color, sides=7, droop=0.0):
        geom = bmesh.ops.create_cone(self.bm, cap_ends=True, segments=sides, radius1=radius, radius2=0.0,
                                     depth=z1 - z0)
        verts = geom["verts"]
        bmesh.ops.translate(self.bm, verts=verts, vec=(0, 0, (z0 + z1) / 2))
        # Irregular rim so the tiers do not look machined.
        for v in verts:
            if abs(v.co.z - z0) < 1e-4 and (v.co.x or v.co.y):
                k = 1 + random.uniform(-0.18, 0.12)
                v.co.x *= k
                v.co.y *= k
                v.co.z -= droop * random.uniform(0.3, 1.0)
        faces = list({f for v in verts for f in v.link_faces})
        self._paint(faces, color, 0.6, 0.1, z0 - droop, z1)

    def blob(self, center, radius, color, squash=1.0, subdiv=1, lumpy=0.22):
        geom = bmesh.ops.create_icosphere(self.bm, subdivisions=subdiv, radius=radius)
        for v in geom["verts"]:
            n = noise.noise(v.co * 3.1 + Vector((len(self.name), 0, 0)))
            v.co *= 1 + lumpy * n
            v.co.z *= squash
            v.co += Vector(center)
        faces = list({f for v in geom["verts"] for f in v.link_faces})
        self._paint(faces, color, 0.55, 0.1, center[2] - radius * squash, center[2] + radius * squash)

    def build(self, col):
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        # Make the painted colours the only, active colour attribute (exported as COLOR_0).
        for a in list(me.color_attributes):
            if a.name != "Col":
                me.color_attributes.remove(a)
        me.color_attributes.active_color = me.color_attributes["Col"]
        me.color_attributes.render_color_index = me.color_attributes.find("Col")
        for p in me.polygons:
            p.use_smooth = False
        mat = bpy.data.materials.get("Trees") or bpy.data.materials.new("Trees")
        me.materials.append(mat)
        obj = bpy.data.objects.new(self.name, me)
        col.objects.link(obj)
        return obj


BARK = srgb(92, 70, 52)
BARK_LIGHT = srgb(130, 120, 108)
BARK_PINE = srgb(170, 96, 58)
BARK_BIRCH = srgb(228, 226, 218)

# Three shapes per species (index 0..2): slim / standard / broad or old.
VARIANTS = 3


def conifer(col, name, green, tiers, slim, trunk=0.35, droop=0.03, top=1.0, flat_top=False):
    t = Tree(name)
    t.trunk(trunk, 0.018, BARK)
    for i in range(tiers):
        z0 = 0.12 + i * (0.8 / tiers) * 0.95
        z1 = z0 + 0.42 - i * 0.04
        if flat_top and i == tiers - 1:
            z1 = z0 + 0.16
        r = slim * (1 - i / (tiers + 0.6))
        g = tuple(c * (0.9 + 0.08 * i) * random.uniform(0.95, 1.05) for c in green)
        t.cone(z0, min(z1, top), r, g, sides=7, droop=droop)
    return t.build(col)


def spruce(col, v):
    return conifer(col, f"Tree_spruce_{v}", srgb(38, 74, 44), tiers=[5, 4, 4][v],
                   slim=[0.15, 0.2, 0.25][v], droop=[0.02, 0.03, 0.06][v])


def fir(col, v):
    # Old silver firs get a flat "stork's nest" top.
    return conifer(col, f"Tree_fir_{v}", srgb(30, 58, 42), tiers=[4, 4, 5][v],
                   slim=[0.2, 0.24, 0.27][v], flat_top=v == 2)


def larch(col, v):
    # Lighter, airier: more, thinner tiers in soft green.
    return conifer(col, f"Tree_larch_{v}", srgb(106, 132, 66), tiers=[6, 5, 4][v],
                   slim=[0.13, 0.16, 0.2][v], droop=0.05)


def arve(col, v):
    t = Tree(f"Tree_arve_{v}")
    t.trunk(0.5, 0.025, BARK)
    layouts = [
        (((0, 0, 0.45), 0.17), ((0.04, 0.02, 0.66), 0.14), ((-0.03, -0.02, 0.84), 0.1)),
        (((0, 0, 0.45), 0.2), ((0.06, 0.03, 0.68), 0.16), ((-0.05, -0.02, 0.85), 0.11)),
        (((0.05, 0, 0.42), 0.22), ((-0.1, 0.04, 0.6), 0.16), ((0.06, -0.03, 0.78), 0.14)),
    ]
    for c, r in layouts[v]:
        t.blob(c, r, srgb(44, 78, 46), squash=1.1, lumpy=0.3)
    return t.build(col)


def pine(col, v):
    """Scots pine (Waldföhre): long bare orange upper trunk, flat irregular crown."""
    t = Tree(f"Tree_pine_{v}")
    h = [0.62, 0.55, 0.48][v]
    t.trunk(h + 0.1, 0.022, BARK_PINE)
    green = srgb(58, 84, 52)
    n = [3, 4, 5][v]
    for k in range(n):
        a = k / n * math.tau + random.uniform(0, 1)
        d = random.uniform(0.05, 0.14) * (1 + v * 0.3)
        c = (math.cos(a) * d, math.sin(a) * d, h + random.uniform(0.05, 0.22))
        t.blob(c, random.uniform(0.1, 0.15) * (1 + v * 0.15), green, squash=0.55, lumpy=0.35)
    return t.build(col)


def broadleaf(col, name, green, bark, wide, height=0.45, squash=0.9, lobes=2):
    t = Tree(name)
    t.trunk(height, 0.03, bark)
    t.blob((0, 0, height + 0.17), 0.3 * wide, green, squash=squash, subdiv=2, lumpy=0.25)
    for k in range(lobes):
        a = k / lobes * math.tau + random.uniform(0, 1)
        c = (math.cos(a) * 0.12 * wide, math.sin(a) * 0.1 * wide, height + random.uniform(0.0, 0.12))
        shade = random.uniform(0.88, 1.06)
        t.blob(c, random.uniform(0.15, 0.18) * wide, tuple(x * shade for x in green), squash=squash, lumpy=0.3)
    return t.build(col)


def beech(col, v):
    return broadleaf(col, f"Tree_beech_{v}", srgb(70, 112, 46), BARK_LIGHT, [0.8, 1.0, 1.2][v],
                     lobes=[2, 2, 3][v])


def chestnut(col, v):
    return broadleaf(col, f"Tree_chestnut_{v}", srgb(84, 110, 42), BARK, [1.0, 1.2, 1.35][v],
                     height=0.4, lobes=[2, 3, 3][v])


def maple(col, v):
    """Sycamore maple (Bergahorn): rounder, denser crown on a stout trunk."""
    return broadleaf(col, f"Tree_maple_{v}", srgb(78, 118, 50), BARK_LIGHT, [0.9, 1.05, 1.25][v],
                     height=0.38, squash=1.0, lobes=[3, 3, 4][v])


def birch(col, v):
    """Birch: white trunk, small airy oval crown."""
    t = Tree(f"Tree_birch_{v}")
    t.trunk(0.55, 0.018, BARK_BIRCH)
    green = srgb(104, 140, 60)
    t.blob((0, 0, 0.68), [0.15, 0.18, 0.21][v], green, squash=1.5, subdiv=2, lumpy=0.3)
    t.blob((0.05, 0.03, 0.5), 0.11, tuple(x * 0.92 for x in green), squash=1.3, lumpy=0.35)
    return t.build(col)


SPECIES = {
    "spruce": spruce,
    "fir": fir,
    "larch": larch,
    "arve": arve,
    "pine": pine,
    "beech": beech,
    "chestnut": chestnut,
    "maple": maple,
    "birch": birch,
}


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    col = bpy.context.scene.collection
    mat = bpy.data.materials.new("Trees")
    mat.use_nodes = True
    nt = mat.node_tree
    attr = nt.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    nt.links.new(attr.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])
    nt.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9
    objs = []
    for fn in SPECIES.values():
        for v in range(VARIANTS):
            objs.append(fn(col, v))
    total = 0
    for o in objs:
        tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
        total += tris
        print(f"{o.name}: {tris} triangles")
    print("models:", len(objs), "triangles:", total)
    out = os.path.join(BUILD, "trees_raw.glb")
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_yup=True, export_apply=True,
                              export_vertex_color="ACTIVE", export_materials="EXPORT")
    print("exported", out, os.path.getsize(out) // 1024, "KB")
    if "--preview" in sys.argv:
        preview(objs)


def preview(objs):
    scene = bpy.context.scene
    for i, o in enumerate(objs):
        o.location = ((i % 9) * 12 - 48, (i // 9) * 14, 0)
        o.scale = (20, 20, 20)
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 24
    scene.render.resolution_x, scene.render.resolution_y = 1600, 700
    world = bpy.data.worlds.new("W")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.6, 0.72, 0.88, 1)
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 4
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    scene.collection.objects.link(sun)
    cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
    scene.collection.objects.link(cam)
    cam.location = (0, -95, 40)
    cam.rotation_euler = (math.radians(72), 0, 0)
    cam.data.lens = 40
    scene.camera = cam
    scene.render.filepath = os.path.join(BUILD, "trees_preview.png")
    bpy.ops.render.render(write_still=True)
    print("rendered")


if __name__ == "__main__":
    main()
