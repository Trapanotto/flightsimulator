"""
Builds one aircraft type: geometry -> UV/bake/livery -> LODs -> GLB (+ preview renders).

Run:  blender -b --factory-startup -P tools/blender/build_aircraft.py -- <type> [--preview]
      [--fast] [--no-bake] [--views=front34,side,top]
Types live in tools/blender/types/<type>.py (c172, pc12, phenom100, f35, a320, b747).
Output: build/<type>.blend, build/<type>_raw.glb, build/<type>_preview_*.png, build/<type>.json
Then:   node tools/optimize-aircraft.mjs build/<type>_raw.glb public/assets/aircraft/<type>.glb
"""

import importlib
import json
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "types"))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
BUILD = os.path.join(ROOT, "build")
os.makedirs(BUILD, exist_ok=True)

from ac import export as exp  # noqa: E402
from ac import texturing as tex  # noqa: E402

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    return scene


def principled(name, color, rough=0.5, metal=0.0, alpha=1.0, emission=None, strength=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        mat.surface_render_method = "BLENDED"
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = strength
    return mat


def srgb(*c):
    """sRGB 0..1 -> linear, so colours can be written as on a colour picker."""
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


def base_materials():
    """Materials shared by all types; the game recognises Glass and PropDisc by name."""
    return dict(
        airframe=principled("Airframe", srgb(0.92, 0.92, 0.9), 0.38),
        glass=principled("Glass", srgb(0.55, 0.62, 0.7), 0.04, 0.0, alpha=0.22),
        frame=principled("CanopyFrame", srgb(0.12, 0.13, 0.14), 0.6),
        interior=principled("Interior", srgb(0.20, 0.20, 0.21), 0.8),
        prop=principled("PropBlade", srgb(0.06, 0.06, 0.07), 0.55),
        prop_tip=principled("PropTip", srgb(0.98, 0.78, 0.05), 0.45),
        prop_disc=principled("PropDisc", srgb(0.1, 0.1, 0.1), 0.6, alpha=0.15),
        tire=principled("Tire", srgb(0.05, 0.05, 0.05), 0.85),
        gear=principled("GearMetal", srgb(0.62, 0.64, 0.66), 0.35, 0.9),
        gear_white=principled("GearWhite", srgb(0.88, 0.88, 0.86), 0.4),
        metal_dark=principled("MetalDark", srgb(0.22, 0.2, 0.19), 0.4, 0.9),
        metal=principled("Metal", srgb(0.72, 0.73, 0.75), 0.3, 1.0),
        intake=principled("Intake", srgb(0.02, 0.02, 0.02), 0.9),
        nav_red=principled("NavRed", srgb(1, 0.05, 0.05), 0.3, emission=(1, 0.02, 0.02), strength=4),
        nav_green=principled("NavGreen", srgb(0.05, 1, 0.2), 0.3, emission=(0.02, 1, 0.1), strength=4),
        nav_white=principled("NavWhite", srgb(1, 1, 1), 0.3, emission=(1, 1, 1), strength=4),
    )


# ---------------------------------------------------------------------------
# Preview renders (Cycles, CPU) for design review
# ---------------------------------------------------------------------------

def setup_preview_render(scene, ground_z, size, hdri="sunset.exr", samples=48, res=(1280, 720)):
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    path = os.path.join(os.path.dirname(bpy.app.binary_path), f"{bpy.app.version[0]}.{bpy.app.version[1]}",
                        "datafiles", "studiolights", "world", hdri)
    env.image = bpy.data.images.load(path)
    nt.links.new(env.outputs["Color"], nt.nodes["Background"].inputs["Color"])
    nt.nodes["Background"].inputs["Strength"].default_value = 1.2
    sun = bpy.data.lights.new("Sun", "SUN")
    sun.energy = 4.0
    sun.angle = math.radians(2)
    so = bpy.data.objects.new("Sun", sun)
    so.rotation_euler = (math.radians(50), math.radians(10), math.radians(140))
    scene.collection.objects.link(so)
    bpy.ops.mesh.primitive_plane_add(size=size * 8, location=(0, 0, ground_z))
    ground = bpy.context.active_object
    ground.name = "PreviewGround"
    ground.is_shadow_catcher = True


def render_view(scene, tag, name, loc, target, lens=50):
    cam_data = bpy.data.cameras.get("PreviewCam") or bpy.data.cameras.new("PreviewCam")
    cam_data.lens = lens
    cam_data.clip_end = 2000
    cam = bpy.data.objects.get("PreviewCam") or bpy.data.objects.new("PreviewCam", cam_data)
    if cam.name not in scene.collection.objects:
        scene.collection.objects.link(cam)
    cam.location = loc
    direction = Vector(target) - Vector(loc)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    scene.render.filepath = os.path.join(BUILD, f"{tag}_preview_{name}.png")
    bpy.ops.render.render(write_still=True)
    print("rendered", scene.render.filepath)


def preview(scene, t, views):
    s = t.SIZE  # characteristic length in metres (scales the camera positions)
    setup_preview_render(scene, t.GROUND_Z, s, samples=32 if "--fast" in ARGS else 48)
    for o in bpy.data.objects:
        if o.name.startswith("PropDisc"):
            o.hide_render = True
    k = s / 11.0
    all_views = {
        "front34": ((-9.5 * k, -11.0 * k, 2.6 * k), (0.3 * k, -0.6 * k, -0.2 * k), 50),
        "side": ((-17.0 * k, 0.0, 0.0), (0, 0, -0.1 * k), 50),
        "top": ((0.0, 0.0, 20.0 * k), (0, 0.001, 0), 50),
        "rear34": ((8.0 * k, 10.5 * k, 3.5 * k), (0, 0.5 * k, 0), 50),
        "front": ((0.0, -16.0 * k, 0.6 * k), (0, 0, 0), 50),
        "low": ((-6.0 * k, -7.0 * k, t.GROUND_Z + 0.5 * k), (0, -0.5 * k, 0), 35),
    }
    all_views.update(getattr(t, "PREVIEW_VIEWS", {}))
    for v in views:
        loc, tgt, lens = all_views[v]
        render_view(scene, t.ID, v, loc, tgt, lens)


def main():
    if not ARGS or ARGS[0].startswith("--"):
        raise SystemExit("usage: build_aircraft.py -- <type> [--preview] [--fast]")
    t = importlib.import_module(ARGS[0])
    scene = reset_scene()
    mats = base_materials()
    mats.update(t.materials(principled, srgb) if hasattr(t, "materials") else {})
    col = bpy.data.collections.new("LOD1")
    bpy.context.scene.collection.children.link(col)
    parts = t.build(col, mats)
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in col.objects if o.type == "MESH")
    print(f"{t.ID}: LOD1 triangles: {tris}")
    if "--no-bake" not in ARGS:
        size = 1024 if "--fast" in ARGS else t.TEXTURE_SIZE
        base, orm = tex.texture_atlas(parts, t.ATLAS, t.livery, t.decals, size=size,
                                      ao_samples=16 if "--fast" in ARGS else 64,
                                      base_name=t.ID.upper())
        tex.save_images([base, orm], os.path.join(BUILD, "textures", t.ID))
        print("textures baked")
    roots, report = exp.build_lods(col, t.SUBDIVIDE, t.LOD2_SKIN, t.LOD2_KEEP,
                                   getattr(t, "LOD2_TARGET", exp.LOD2_TARGET_TRIS))
    print("triangles per LOD:", report)
    out = os.path.join(BUILD, f"{t.ID}_raw.glb")
    exp.export_glb(out)
    print("exported", out, os.path.getsize(out) // 1024, "KB")
    with open(os.path.join(BUILD, f"{t.ID}.json"), "w") as f:
        json.dump({"id": t.ID, "triangles": report, **getattr(t, "META", {})}, f, indent=2)
    if "--preview" in ARGS:
        for name in ("LOD1", "LOD2"):
            for o in bpy.data.collections[name].objects:
                o.hide_render = True
        views = [a.split("=", 1)[1].split(",") for a in ARGS if a.startswith("--views=")]
        preview(scene, t, views[0] if views else ("front34", "side", "top", "rear34"))
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BUILD, f"{t.ID}.blend"))


if __name__ == "__main__":
    main()
