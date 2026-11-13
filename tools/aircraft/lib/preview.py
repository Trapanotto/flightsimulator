"""Preview stills (Cycles, CPU) for reviewing the model while it is built."""

import math
import os

import bpy
from mathutils import Vector


def setup(samples=24, res=(1280, 720), ground_z=0.0):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.get("PreviewWorld") or bpy.data.worlds.new("PreviewWorld")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    sky = nt.nodes.get("Sky") or nt.nodes.new("ShaderNodeTexSky")
    sky.name = "Sky"
    try:
        sky.sky_type = "MULTIPLE_SCATTERING"
    except TypeError:
        pass
    sky.sun_elevation = math.radians(38)
    sky.sun_rotation = math.radians(215)
    nt.links.new(sky.outputs["Color"], nt.nodes["Background"].inputs["Color"])
    nt.nodes["Background"].inputs["Strength"].default_value = 0.35
    if "PreviewGround" not in bpy.data.objects:
        bpy.ops.mesh.primitive_plane_add(size=80, location=(0, 0, ground_z))
        g = bpy.context.active_object
        g.name = "PreviewGround"
        mat = bpy.data.materials.new("PreviewGroundMat")
        mat.use_nodes = True
        b = mat.node_tree.nodes["Principled BSDF"]
        b.inputs["Base Color"].default_value = (0.22, 0.22, 0.21, 1)
        b.inputs["Roughness"].default_value = 0.85
        g.data.materials.append(mat)
    scene.view_settings.exposure = 0.0


def render(out_path, loc, target, lens=50, clip_start=0.02):
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.get("PreviewCam") or bpy.data.cameras.new("PreviewCam")
    cam_data.lens = lens
    cam_data.clip_start = clip_start
    cam_data.clip_end = 500
    cam = bpy.data.objects.get("PreviewCam") or bpy.data.objects.new("PreviewCam", cam_data)
    if cam.name not in scene.collection.objects:
        scene.collection.objects.link(cam)
    cam.location = loc
    d = Vector(target) - Vector(loc)
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    scene.render.filepath = out_path
    bpy.ops.render.render(write_still=True)
    print("rendered", out_path)


def views(eye):
    """Named camera positions (Blender frame, metres from the reference point)."""
    ex, ey, ez = eye
    return {
        "front34": ((-7.5, -9.0, 1.4), (0.0, 0.3, -0.2), 40),
        "side": ((-40.0, 0.6, 0.25), (0.0, 0.6, 0.25), 115),
        "front": ((0.0, -40.0, 0.25), (0, 0, 0.25), 105),
        "top": ((0.0, 0.6, 40.0), (0, 0.601, 0), 100),
        "rear34": ((6.5, 9.5, 2.5), (0, 1.2, 0), 40),
        "low": ((-3.4, -4.0, -0.8), (-0.5, -0.4, -0.5), 28),
        "nose": ((-2.2, -3.6, 0.5), (0, -1.4, 0.0), 35),
        "tail": ((-2.6, 7.6, 1.5), (0, 5.6, 0.6), 35),
        "cockpit": ((ex, ey, ez), (ex - 0.05, ey - 2.0, ez - 0.35), 18),
        "panel": ((ex - 0.12, ey - 0.15, ez - 0.17), (ex - 0.15, ey - 1.0, ez - 0.45), 24),
        "cabin": ((-0.9, -0.6, 0.65), (0.3, 0.2, 0.3), 16),
    }
