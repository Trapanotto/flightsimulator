"""
Aircraft export: hinge/spin pivots, LOD0/1/2 hierarchies and GLB export.

Node naming contract with the game (src/aircraft/Aircraft.ts):
  AC_LOD0 / AC_LOD1 / AC_LOD2      root of each level of detail
  <Part>_LOD<n>                    e.g. Aileron_L_LOD0
  Aileron_L/R, Elevator_*, Rudder*, Flap_*, Gear_N, Gear_* (main), Propeller*, Fan*, PropDisc*
  Control surfaces and retractable gear rotate about their LOCAL X axis (hinge line);
  propellers and fans spin about their local Z axis (flight axis in glTF).
"""

import bmesh
import bpy
from mathutils import Matrix, Vector

LOD2_TARGET_TRIS = 2000


def set_pivot(obj, matrix):
    """Moves the object's origin/orientation to `matrix` without moving the geometry."""
    obj.data.transform(matrix.inverted() @ obj.matrix_world)
    obj.matrix_world = matrix


def hinge_matrix(p0, p1, up_hint=Vector((0, 0, 1))):
    x = (p1 - p0).normalized()
    if abs(x.dot(up_hint)) > 0.9:
        up_hint = Vector((0, 1, 0))
    z = (up_hint - x * up_hint.dot(x)).normalized()
    y = z.cross(x)
    m = Matrix((x, y, z)).transposed().to_4x4()
    m.translation = (p0 + p1) / 2
    return m


def apply_pivots(objs):
    for o in objs:
        if "hinge" in o:
            p0, p1 = (Vector(v) for v in o["hinge"])
            set_pivot(o, hinge_matrix(p0, p1))
            del o["hinge"]
        elif "spin_center" in o:
            set_pivot(o, Matrix.Translation(Vector(o["spin_center"])))
            del o["spin_center"]


def tri_count(obj):
    deps = bpy.context.evaluated_depsgraph_get()
    me = obj.evaluated_get(deps).to_mesh()
    n = sum(len(p.vertices) - 2 for p in me.polygons)
    obj.evaluated_get(deps).to_mesh_clear()
    return n


def build_lods(lod1_col, subdivide=(), lod2_skin=(), lod2_keep=(), lod2_target=LOD2_TARGET_TRIS):
    """
    LOD1 = the built model; LOD0 = LOD1 with one subdivision on curved skins (`subdivide`);
    LOD2 = `lod2_skin` merged and decimated + `lod2_keep` parts (moving or see-through).
    """
    scene = bpy.context.scene
    objs = list(lod1_col.objects)
    apply_pivots(objs)
    roots = {}
    for level in (0, 1, 2):
        empty = bpy.data.objects.new(f"AC_LOD{level}", None)
        scene.collection.objects.link(empty)
        roots[level] = empty

    lod0_col = bpy.data.collections.new("LOD0")
    scene.collection.children.link(lod0_col)
    base = {o.name: o.name for o in objs}
    for o in objs:
        c = o.copy()
        c.data = o.data.copy()
        lod0_col.objects.link(c)
        c.name = f"{base[o.name]}_LOD0"
        if base[o.name] in subdivide:
            m = c.modifiers.new("subd", "SUBSURF")
            m.levels = m.render_levels = 1
            m.uv_smooth = "PRESERVE_BOUNDARIES"
        c.parent = roots[0]

    lod2_col = bpy.data.collections.new("LOD2")
    scene.collection.children.link(lod2_col)
    skin_objs = [o for o in objs if o.name in lod2_skin]
    if skin_objs:
        skin = merge_objects(skin_objs, "Skin_LOD2", lod2_col)
        dec = skin.modifiers.new("dec", "DECIMATE")
        dec.ratio = min(1.0, lod2_target / max(1, tri_count(skin)))
        skin.parent = roots[2]
    for o in objs:
        if o.name in lod2_keep:
            c = o.copy()
            c.data = o.data.copy()
            lod2_col.objects.link(c)
            c.name = f"{o.name}_LOD2"
            if o.name.startswith("Gear") or o.name.startswith("Fan"):
                d = c.modifiers.new("dec", "DECIMATE")
                d.ratio = 0.25
            c.parent = roots[2]

    for o in objs:
        o.name = f"{base[o.name]}_LOD1"
        o.parent = roots[1]

    report = {}
    for level, col in ((0, lod0_col), (1, lod1_col), (2, lod2_col)):
        report[level] = sum(tri_count(o) for o in col.objects if o.type == "MESH")
    return roots, report


def merge_objects(objs, name, col):
    """Joins meshes (world space) into a new object, keeping materials and UVs."""
    bm = bmesh.new()
    mats = []
    for o in objs:
        tmp = o.data.copy()
        tmp.transform(o.matrix_world)
        for m in o.data.materials:
            if m not in mats:
                mats.append(m)
        remap = [mats.index(m) for m in o.data.materials]
        for p in tmp.polygons:
            p.material_index = remap[p.material_index] if remap else 0
        bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    obj = bpy.data.objects.new(name, me)
    col.objects.link(obj)
    return obj


def export_glb(path):
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_image_format="WEBP",
        export_image_quality=88,
        export_apply=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_extras=False,
    )
