"""
Hero image: the TR-1 (Cycles) composited over a screenshot of our own streamed terrain.

Run after build_tr1.py:
  node tools/screenshot.mjs ... build/hero_bg.png   (see README)
  blender -b build/tr1.blend -P tools/blender/render_hero.py
Output: public/assets/ui/hero.jpg (1600x900) and public/assets/ui/og.jpg (1200x630)
"""

import math
import os

import bpy
import numpy as np
from mathutils import Euler, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
BUILD = os.path.join(ROOT, "build")
OUT = os.path.join(ROOT, "public", "assets", "ui")
os.makedirs(OUT, exist_ok=True)
W, H = 1600, 900

scene = bpy.context.scene

# Only the most detailed level; flying configuration (no gear, blurred propeller).
for o in bpy.data.objects:
    if o.name.endswith(("_LOD1", "_LOD2")) or o.name.startswith("Preview"):
        o.hide_render = True
    if o.name.startswith(("Gear_", "Propeller")) and o.name.endswith("_LOD0"):
        o.hide_render = True
    if o.name == "PropDisc_LOD0":
        o.hide_render = False
disc_mat = bpy.data.materials.get("PropDisc")
if disc_mat:
    bsdf = disc_mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Alpha"].default_value = 0.32
    bsdf.inputs["Base Color"].default_value = (0.35, 0.35, 0.36, 1)

# Pose: banking right (right wing down) towards the camera.
root = bpy.data.objects["TR1_LOD0"]
root.rotation_mode = "XYZ"
root.rotation_euler = Euler((math.radians(-3), math.radians(-24), 0), "XYZ")

# Camera: same vertical FOV as the game (60 deg), above and ahead of the right wing,
# looking down ~15 deg like the background shot.
cam_data = bpy.data.cameras.new("HeroCam")
cam_data.sensor_fit = "VERTICAL"
cam_data.angle_y = math.radians(60)
cam = bpy.data.objects.new("HeroCam", cam_data)
scene.collection.objects.link(cam)
cam.location = (-10.5, -12.5, 4.6)
cam.rotation_euler = (Vector((0.0, 0.3, -0.2)) - Vector(cam.location)).to_track_quat("-Z", "Y").to_euler()
# Put the aircraft into the right third, slightly above the middle.
cam_data.shift_x = -0.17
cam_data.shift_y = -0.06
scene.camera = cam
bpy.context.view_layer.update()
cam_right = Vector(cam.matrix_world.col[0][:3])
cam_up = Vector(cam.matrix_world.col[1][:3])
cam_fwd = -Vector(cam.matrix_world.col[2][:3])

# Light: matches the game sun (low, from the right and slightly ahead), plus sky fill.
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = int(os.environ.get("HERO_SAMPLES", "128"))
scene.cycles.use_denoising = True
scene.render.resolution_x, scene.render.resolution_y = W, H
scene.render.film_transparent = True
scene.view_settings.view_transform = "AgX"
scene.view_settings.look = "AgX - Medium High Contrast"
world = bpy.data.worlds.new("HeroWorld")
scene.world = world
world.use_nodes = True
nt = world.node_tree
env = nt.nodes.new("ShaderNodeTexEnvironment")
env.image = bpy.data.images.load(os.path.join(
    os.path.dirname(bpy.app.binary_path), f"{bpy.app.version[0]}.{bpy.app.version[1]}",
    "datafiles", "studiolights", "world", "sunset.exr"))
nt.links.new(env.outputs["Color"], nt.nodes["Background"].inputs["Color"])
nt.nodes["Background"].inputs["Strength"].default_value = 0.9
for o in list(bpy.data.objects):
    if o.type == "LIGHT":
        bpy.data.objects.remove(o)
sun = bpy.data.lights.new("HeroSun", "SUN")
sun.energy = 4.5
sun.angle = math.radians(1.5)
sun.color = (1.0, 0.92, 0.82)
so = bpy.data.objects.new("HeroSun", sun)
# Background sun is low on the right; keep it a little behind the camera so the lit side shows.
to_sun = (cam_right * 0.8 - cam_fwd * 0.25 + Vector((0, 0, 0.45))).normalized()
so.rotation_euler = (-to_sun).to_track_quat("-Z", "Y").to_euler()
scene.collection.objects.link(so)

fg_path = os.path.join(BUILD, "hero_fg.png")
scene.render.filepath = fg_path
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
bpy.ops.render.render(write_still=True)


def load(path):
    img = bpy.data.images.load(path)
    a = np.empty(img.size[0] * img.size[1] * 4, np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4), img


fg, _ = load(fg_path)
bg, bg_img = load(os.path.join(BUILD, "hero_bg.png"))
if bg.shape != fg.shape:
    bg_img.scale(W, H)
    bg, _ = load(os.path.join(BUILD, "hero_bg.png"))
alpha = fg[..., 3:4]
out = fg[..., :3] * alpha + bg[..., :3] * (1 - alpha)
# Gentle vignette so the title text on the start screen stays readable.
yy, xx = np.mgrid[0:H, 0:W]
v = 1 - 0.35 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2) / 2
out *= v[..., None]


def save_jpeg(arr, name, w, h):
    img = bpy.data.images.new(name, arr.shape[1], arr.shape[0])
    rgba = np.concatenate([arr, np.ones(arr.shape[:2] + (1,), np.float32)], -1)
    img.pixels.foreach_set(np.clip(rgba, 0, 1).ravel())
    if (w, h) != (arr.shape[1], arr.shape[0]):
        img.scale(w, h)
    img.filepath_raw = os.path.join(OUT, name)
    img.file_format = "JPEG"
    scene.render.image_settings.quality = 82
    img.save()
    print("saved", img.filepath_raw)


save_jpeg(out, "hero.jpg", W, H)
# Open Graph: 1200x630 crop (rows are stored bottom-up), centred on the aircraft.
crop_h = int(W * 630 / 1200)
y0 = (H - crop_h) // 2
save_jpeg(out[y0:y0 + crop_h], "og.jpg", 1200, 630)
