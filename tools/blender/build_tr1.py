"""
Builds the TR-1 aircraft: geometry -> UV/bake/livery -> LODs -> GLB.

Run:  blender -b --factory-startup -P tools/blender/build_tr1.py -- [--preview] [--no-bake]
Output: build/tr1.blend, build/tr1_raw.glb, build/preview_*.png
"""

import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
BUILD = os.path.join(ROOT, "build")
os.makedirs(BUILD, exist_ok=True)

import tr1_geometry as geo  # noqa: E402
import tr1_export as exp  # noqa: E402
import tr1_textures as tex  # noqa: E402

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


def make_materials():
    return dict(
        airframe=principled("Airframe", srgb(0.92, 0.92, 0.9), 0.38),
        glass=principled("Glass", srgb(0.55, 0.62, 0.7), 0.04, 0.0, alpha=0.22),
        frame=principled("CanopyFrame", srgb(0.12, 0.13, 0.14), 0.6),
        interior=principled("Interior", srgb(0.16, 0.17, 0.18), 0.8),
        prop=principled("PropBlade", srgb(0.06, 0.06, 0.07), 0.55),
        prop_tip=principled("PropTip", srgb(0.98, 0.78, 0.05), 0.45),
        prop_disc=principled("PropDisc", srgb(0.1, 0.1, 0.1), 0.6, alpha=0.15),
        tire=principled("Tire", srgb(0.05, 0.05, 0.05), 0.85),
        gear=principled("GearMetal", srgb(0.62, 0.64, 0.66), 0.35, 0.9),
        metal_dark=principled("MetalDark", srgb(0.22, 0.2, 0.19), 0.4, 0.9),
        intake=principled("Intake", srgb(0.02, 0.02, 0.02), 0.9),
        nav_red=principled("NavRed", srgb(1, 0.05, 0.05), 0.3, emission=(1, 0.02, 0.02), strength=4),
        nav_green=principled("NavGreen", srgb(0.05, 1, 0.2), 0.3, emission=(0.02, 1, 0.1), strength=4),
        nav_white=principled("NavWhite", srgb(1, 1, 1), 0.3, emission=(1, 1, 1), strength=4),
    )


def build_lod1(m):
    """Base resolution model; LOD0 and LOD2 are derived from it."""
    col = bpy.data.collections.new("LOD1")
    bpy.context.scene.collection.children.link(col)
    parts = {}
    parts["Fuselage"] = geo.build_fuselage(col, m["airframe"])
    glass, frame = geo.build_canopy(col, m["glass"], m["frame"])
    parts["Canopy"], parts["CanopyFrame"] = glass, frame
    parts.update(geo.build_wing(col, m["airframe"]))
    parts.update(geo.build_tail(col, m["airframe"]))
    parts["Spinner"] = geo.build_spinner(col, m["airframe"])
    parts["Propeller"] = geo.build_propeller(col, m["prop"], m["prop_tip"])
    parts["PropDisc"] = geo.build_prop_disc(col, m["prop_disc"])
    parts.update(geo.build_gear(col, m["tire"], m["gear"]))
    for o in geo.build_details(col, m["metal_dark"], m["intake"]):
        parts[o.name] = o
    for o in geo.build_lights(col, m["nav_red"], m["nav_green"], m["nav_white"]):
        parts[o.name] = o
    parts["Cockpit"] = geo.build_cockpit(col, m["interior"])
    return col, parts


# ---------------------------------------------------------------------------
# Preview renders (Cycles, CPU) for design review
# ---------------------------------------------------------------------------

def setup_preview_render(scene, hdri="sunset.exr", samples=48, res=(1280, 720)):
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
    # Sun for crisp shadows.
    sun = bpy.data.lights.new("Sun", "SUN")
    sun.energy = 4.0
    sun.angle = math.radians(2)
    so = bpy.data.objects.new("Sun", sun)
    so.rotation_euler = (math.radians(50), math.radians(10), math.radians(140))
    scene.collection.objects.link(so)
    # Shadow-catcher ground.
    bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, geo.GROUND_Z))
    ground = bpy.context.active_object
    ground.name = "PreviewGround"
    ground.is_shadow_catcher = True


def render_view(scene, name, loc, target, lens=50):
    cam_data = bpy.data.cameras.get("PreviewCam") or bpy.data.cameras.new("PreviewCam")
    cam_data.lens = lens
    cam = bpy.data.objects.get("PreviewCam") or bpy.data.objects.new("PreviewCam", cam_data)
    if cam.name not in scene.collection.objects:
        scene.collection.objects.link(cam)
    cam.location = loc
    direction = Vector(target) - Vector(loc)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    scene.render.filepath = os.path.join(BUILD, f"preview_{name}.png")
    bpy.ops.render.render(write_still=True)
    print("rendered", scene.render.filepath)


def preview(scene, views=("front34", "side", "top")):
    setup_preview_render(scene)
    for o in bpy.data.objects:
        if o.name.startswith("PropDisc"):
            o.hide_render = True  # only shown in game at high rpm
    all_views = {
        "front34": ((-9.5, -11.0, 2.6), (0.3, -0.6, -0.2), 50),
        "side": ((-17.0, 0.0, 0.0), (0, 0, -0.1), 50),
        "top": ((0.0, 0.0, 20.0), (0, 0.001, 0), 50),
        "rear34": ((8.0, 10.5, 3.5), (0, 0.5, 0), 50),
        "cockpit": ((-2.4, -3.2, 1.9), (0, -0.6, 0.6), 35),
    }
    for v in views:
        loc, tgt, lens = all_views[v]
        render_view(scene, v, loc, tgt, lens)


def main():
    scene = reset_scene()
    mats = make_materials()
    col, parts = build_lod1(mats)
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in col.objects if o.type == "MESH")
    print(f"LOD1 triangles: {tris}")
    if "--no-bake" not in ARGS:
        size = 1024 if "--fast" in ARGS else 2048
        base, orm = tex.texture_atlas(parts, size=size, ao_samples=24 if "--fast" in ARGS else 64)
        tex.save_images([base, orm], os.path.join(BUILD, "textures"))
        print("textures baked")
    roots, report = exp.build_lods(col)
    print("triangles per LOD:", report)
    out = os.path.join(BUILD, "tr1_raw.glb")
    exp.export_glb(out)
    print("exported", out, os.path.getsize(out) // 1024, "KB")
    if "--preview" in ARGS:
        # Render the most detailed level only.
        for name in ("LOD1", "LOD2"):
            for o in bpy.data.collections[name].objects:
                o.hide_render = True
        views = [a.split("=", 1)[1].split(",") for a in ARGS if a.startswith("--views=")]
        preview(scene, *(views[0:1] or [("front34", "side", "top")]))
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BUILD, "tr1.blend"))


if __name__ == "__main__":
    main()
