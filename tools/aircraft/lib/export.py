"""Levels of detail and the glTF export."""

import math

import bpy
from mathutils import Matrix

from . import mesh as M


def _decimate(obj, ratio):
    if ratio >= 0.999 or M.tri_count(obj) < 60:
        return
    m = obj.modifiers.new("Decimate", "DECIMATE")
    m.decimate_type = "COLLAPSE"
    m.ratio = ratio
    m.use_collapse_triangulate = True
    M.apply_modifiers(obj)


def copy_tree(src, parent, suffix, col, keep, ratio_of):
    """
    Copies a hierarchy for a lower level of detail. `keep(obj)` decides whether an object (and
    its subtree) is copied, `ratio_of(obj)` gives the decimation ratio of a mesh.
    """
    if not keep(src):
        return None
    dst = src.copy()
    if src.data is not None:
        dst.data = src.data.copy()
    dst.name = src.name + suffix
    if dst.data is not None:
        dst.data.name = dst.name
    col.objects.link(dst)
    dst.parent = parent
    dst.matrix_parent_inverse = Matrix.Identity(4)
    dst.matrix_basis = src.matrix_basis.copy()
    if dst.type == "MESH":
        _decimate(dst, ratio_of(src))
    for ch in src.children:
        copy_tree(ch, dst, suffix, col, keep, ratio_of)
    return dst


def build_lods(lod0_root, col):
    """LOD1: exterior and a token cabin, decimated. LOD2: one static mesh per material."""
    report = {}
    cockpit = bpy.data.objects["Cockpit"]
    cabin_keep = {"Cockpit", "CabinLining", "Cabin_fabric", "Cabin_panel", "Cabin_glareshield"}
    drop1 = ("Fittings", "Antennas", "Lens_", "Glow_", "Eye", "Exhaust")

    def under_cockpit(o):
        p = o
        while p is not None:
            if p is cockpit:
                return True
            p = p.parent
        return False

    def keep1(o):
        if o.name.startswith(drop1):
            return False
        if under_cockpit(o):
            return o.name in cabin_keep
        return True

    def ratio1(o):
        n = M.tri_count(o)
        if o.name in ("PropDisc",) or o.name.startswith("Lamp_"):
            return 1.0
        if n > 4000:
            return 0.22
        if n > 1000:
            return 0.35
        return 0.5

    lod1 = copy_tree(lod0_root, None, "_lod1", col, keep1, ratio1)
    lod1.name = "LOD1"
    # LOD2: merge the static exterior (surfaces frozen), keep the propeller disc as its own
    # node so it can still turn.
    statics = []
    for o in lod1.children_recursive:
        if o.type != "MESH" or o.name.startswith(("PropDisc", "PropBlades", "Lamp_")) or under_cockpit(o):
            continue
        if o.name.startswith(("Cabin", "Glass")):
            continue
        c = o.copy()
        c.data = o.data.copy()
        col.objects.link(c)
        c.parent = None
        c.matrix_world = o.matrix_world.copy()
        statics.append(c)
    lod2 = M.empty("LOD2", col, (0, 0, 0), size=0.5)
    body = M.join(statics, "Body_lod2")
    with bpy.context.temp_override(object=body, active_object=body, selected_objects=[body],
                                   selected_editable_objects=[body]):
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    body.data.validate()
    _decimate(body, 0.20)
    body.data.validate()
    body.parent = lod2
    glass = bpy.data.objects["Glass_lod1"].copy()
    glass.data = bpy.data.objects["Glass_lod1"].data.copy()
    col.objects.link(glass)
    glass.name = "Glass_lod2"
    glass.matrix_world = bpy.data.objects["Glass_lod1"].matrix_world.copy()
    glass.parent = lod2
    _decimate(glass, 0.4)
    prop = M.empty("Prop_lod2", col, bpy.data.objects["Prop"].matrix_world.translation, parent=lod2,
                   props={"axis": [0.0, 0.0, 1.0]})
    disc = bpy.data.objects["PropDisc"].copy()
    disc.data = bpy.data.objects["PropDisc"].data.copy()
    col.objects.link(disc)
    disc.name = "PropDisc_lod2"
    disc.parent = prop
    disc.matrix_parent_inverse = Matrix.Identity(4)
    disc.matrix_basis = bpy.data.objects["PropDisc"].matrix_basis.copy()
    for name, root in (("LOD0", lod0_root), ("LOD1", lod1), ("LOD2", lod2)):
        report[name] = sum(M.tri_count(o) for o in [root] + list(root.children_recursive) if o.type == "MESH")
    return report


def export_glb(path, image_quality=90):
    for name in ("PreviewGround", "PreviewCam"):
        o = bpy.data.objects.get(name)
        if o:
            bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_extras=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="WEBP",
        export_image_quality=image_quality,
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        use_visible=False,
        use_renderable=False,
    )
