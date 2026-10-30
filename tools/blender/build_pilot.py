"""
The pilot (on foot, in free fall, under the canopy): a skinned figure with its animations.

Run:  blender -b --factory-startup -P tools/blender/build_pilot.py [-- --preview]
Out:  build/pilot_raw.glb (+ build/pilot_preview_<action>.png)
Then: node tools/optimize-aircraft.mjs build/pilot_raw.glb public/assets/pilot/pilot.glb
      (or: npm run assets:pilot)

Contract with the game (src/game/Pilot.ts):
  1.80 m tall, feet at the origin, facing -Y in Blender (+Z in glTF), A-pose at rest.
  Animations (loops): Idle, Walk (1.6 m/s), Run (5.5 m/s), FreeFall (limbs in the box
  position; the game lays the body flat), Canopy (hanging in the harness, hands on the toggles).

The body is a Skin-modifier mesh grown along the skeleton (smooth, low poly), weighted to the
bones by distance; helmet, visor, gloves, boots and the parachute container are separate
pieces parented to their bones.
"""

import math
import os
import sys

import bpy
import bmesh
from mathutils import Matrix, Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
BUILD = os.path.join(ROOT, "build")
os.makedirs(BUILD, exist_ok=True)
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
FPS = 24

# ---------------------------------------------------------------------------
# Skeleton (Blender: X = the figure's left, -Y = forward, Z = up)
# ---------------------------------------------------------------------------

# name: (head, tail, parent)
BONES = {
    "Hips": ((0, 0, 0.94), (0, 0, 1.08), None),
    "Spine": ((0, 0, 1.08), (0, 0.01, 1.27), "Hips"),
    "Chest": ((0, 0.01, 1.27), (0, 0.0, 1.47), "Spine"),
    "Neck": ((0, 0.0, 1.47), (0, -0.01, 1.57), "Chest"),
    "Head": ((0, -0.01, 1.57), (0, -0.01, 1.80), "Neck"),
}
for s, side in ((1, "L"), (-1, "R")):
    BONES.update({
        f"Thigh.{side}": ((s * 0.095, 0, 0.94), (s * 0.10, -0.01, 0.52), "Hips"),
        f"Shin.{side}": ((s * 0.10, -0.01, 0.52), (s * 0.10, 0.02, 0.09), f"Thigh.{side}"),
        f"Foot.{side}": ((s * 0.10, 0.02, 0.09), (s * 0.10, -0.13, 0.03), f"Shin.{side}"),
        f"Shoulder.{side}": ((s * 0.04, 0.0, 1.43), (s * 0.18, 0.01, 1.44), "Chest"),
        # A-pose: arms 50 degrees out from the body.
        f"UpperArm.{side}": ((s * 0.19, 0.01, 1.44), (s * 0.42, 0.01, 1.25), f"Shoulder.{side}"),
        f"Forearm.{side}": ((s * 0.42, 0.01, 1.25), (s * 0.62, -0.01, 1.08), f"UpperArm.{side}"),
        f"Hand.{side}": ((s * 0.62, -0.01, 1.08), (s * 0.69, -0.02, 1.02), f"Forearm.{side}"),
    })

# Skin-modifier body: joints with radii (x, y) and the edges between them.
JOINTS = {
    "pelvis": ((0, 0.0, 0.95), (0.15, 0.11)),
    "waist": ((0, 0.0, 1.10), (0.135, 0.10)),
    "chest": ((0, 0.005, 1.30), (0.165, 0.115)),
    "upper": ((0, 0.0, 1.42), (0.16, 0.10)),
    "neck": ((0, 0.0, 1.50), (0.055, 0.055)),
    "neckTop": ((0, -0.005, 1.58), (0.05, 0.05)),
}
for s, side in ((1, "L"), (-1, "R")):
    JOINTS.update({
        f"hip.{side}": ((s * 0.095, 0, 0.90), (0.085, 0.09)),
        f"knee.{side}": ((s * 0.10, -0.01, 0.52), (0.058, 0.06)),
        f"ankle.{side}": ((s * 0.10, 0.02, 0.10), (0.046, 0.046)),
        f"shoulder.{side}": ((s * 0.19, 0.01, 1.43), (0.06, 0.06)),
        f"elbow.{side}": ((s * 0.42, 0.01, 1.25), (0.045, 0.045)),
        f"wrist.{side}": ((s * 0.63, -0.012, 1.07), (0.036, 0.032)),
    })
EDGES = [("pelvis", "waist"), ("waist", "chest"), ("chest", "upper"), ("upper", "neck"),
         ("neck", "neckTop")]
for side in ("L", "R"):
    EDGES += [("pelvis", f"hip.{side}"), (f"hip.{side}", f"knee.{side}"),
              (f"knee.{side}", f"ankle.{side}"), ("upper", f"shoulder.{side}"),
              (f"shoulder.{side}", f"elbow.{side}"), (f"elbow.{side}", f"wrist.{side}")]


def srgb(*c):
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


def material(name, color, rough=0.6, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*srgb(*color), 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    return m


MATS = {}


def make_materials():
    MATS.update(
        suit=material("PilotSuit", (0.24, 0.39, 0.66), 0.8),
        dark=material("PilotDark", (0.07, 0.07, 0.08), 0.55),
        skin=material("PilotSkin", (0.85, 0.66, 0.53), 0.65),
        helmet=material("PilotHelmet", (0.95, 0.95, 0.94), 0.3),
        visor=material("PilotVisor", (0.05, 0.07, 0.1), 0.05, 0.6),
        red=material("PilotRed", (0.84, 0.17, 0.12), 0.6),
        container=material("PilotContainer", (0.12, 0.13, 0.15), 0.7),
        webbing=material("PilotWebbing", (0.16, 0.16, 0.17), 0.8),
    )


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------

def build_armature():
    data = bpy.data.armatures.new("PilotRig")
    arm = bpy.data.objects.new("Pilot", data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    for name, (h, t, parent) in BONES.items():
        b = data.edit_bones.new(name)
        b.head, b.tail = Vector(h), Vector(t)
        # Roll so the bone's X axis points to the figure's left (consistent local axes).
        b.align_roll(Vector((1, 0, 0)) if abs(Vector(t).x - Vector(h).x) < 0.1 else Vector((0, -1, 0)))
        if parent:
            b.parent = data.edit_bones[parent]
            b.use_connect = (Vector(h) - data.edit_bones[parent].tail).length < 1e-4
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


def build_body():
    names = list(JOINTS)
    me = bpy.data.meshes.new("PilotBody")
    me.from_pydata([JOINTS[n][0] for n in names], [(names.index(a), names.index(b)) for a, b in EDGES], [])
    obj = bpy.data.objects.new("PilotBody", me)
    bpy.context.scene.collection.objects.link(obj)
    skin = obj.modifiers.new("skin", "SKIN")
    skin.use_smooth_shade = True
    sv = me.skin_vertices[0].data
    for i, n in enumerate(names):
        sv[i].radius = JOINTS[n][1]
    sv[names.index("pelvis")].use_root = True
    sub = obj.modifiers.new("subd", "SUBSURF")
    sub.levels = 2
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)
    obj.select_set(False)
    return obj


def ellipsoid(name, center, r, mat, seg=20, rings=12, cut=None):
    """UV sphere scaled to radii r; `cut` keeps only z > cut (relative), e.g. a helmet shell."""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1.0)
    if cut is not None:
        geom = [v for v in bm.verts if v.co.z < cut]
        bmesh.ops.delete(bm, geom=geom, context="VERTS")
    for v in bm.verts:
        v.co = Vector((v.co.x * r[0], v.co.y * r[1], v.co.z * r[2])) + Vector(center)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    obj = bpy.data.objects.new(name, me)
    obj.data.materials.append(mat)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def box(name, center, size, mat, bevel=0.0):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2])) + Vector(center)
    if bevel:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=2, affect="EDGES")
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    obj.data.materials.append(mat)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-9)))
    return (a + ab * t - p).length


def weight_by_distance(obj, arm, bones=None, falloff=6.0, keep=2):
    """Vertex groups from the distance to the bone segments (nearest few, smooth blend)."""
    bones = bones or [b for b in BONES if not b.startswith("Shoulder")] + ["Shoulder.L", "Shoulder.R"]
    segs = {b: (Vector(BONES[b][0]), Vector(BONES[b][1])) for b in bones}
    groups = {b: obj.vertex_groups.new(name=b) for b in bones}
    for v in obj.data.vertices:
        p = obj.matrix_world @ v.co
        d = sorted(((seg_dist(p, *segs[b]), b) for b in bones))[:keep]
        # Only bones of the same limb blend: a hand near the hip stays with the arm.
        w = [(1.0 / max(dd, 0.004) ** falloff, b) for dd, b in d if dd < d[0][0] * 1.35 + 0.012]
        tot = sum(x for x, _ in w)
        for x, b in w:
            groups[b].add([v.index], x / tot, "REPLACE")


def attach(obj, arm, bone):
    """Rigid piece that moves with one bone (single vertex group, armature modifier)."""
    g = obj.vertex_groups.new(name=bone)
    g.add([v.index for v in obj.data.vertices], 1.0, "REPLACE")
    obj.parent = arm
    mod = obj.modifiers.new("arm", "ARMATURE")
    mod.object = arm


def colour_body(obj):
    """Suit everywhere; dark boots below the ankles, gloves past the wrists, a belt."""
    me = obj.data
    for key in ("suit", "dark", "skin", "red"):
        me.materials.append(MATS[key])
    idx = {k: i for i, k in enumerate(("suit", "dark", "skin", "red"))}
    for p in me.polygons:
        c = obj.matrix_world @ p.center
        ax = abs(c.x)
        if c.z < 0.15:
            p.material_index = idx["dark"]  # boots
        elif ax > 0.58 and c.z < 1.12:
            p.material_index = idx["dark"]  # gloves
        elif c.z > 1.49 and ax < 0.07:
            p.material_index = idx["skin"]  # neck
        elif 1.34 < c.z < 1.40 and 0.04 < c.x < 0.12 and c.y < -0.08:
            p.material_index = idx["red"]  # chest patch (left)
        else:
            p.material_index = idx["suit"]


def build_figure():
    arm = build_armature()
    body = build_body()
    colour_body(body)
    weight_by_distance(body, arm)
    body.parent = arm
    mod = body.modifiers.new("arm", "ARMATURE")
    mod.object = arm

    pieces = [
        (ellipsoid("Head", (0, -0.015, 1.665), (0.088, 0.1, 0.112), MATS["skin"]), "Head"),
        (ellipsoid("Helmet", (0, 0.0, 1.675), (0.112, 0.125, 0.122), MATS["helmet"], cut=-0.15), "Head"),
        # Visor: the front of a slightly larger shell.
        (ellipsoid("Visor", (0, -0.012, 1.66), (0.106, 0.118, 0.07), MATS["visor"], seg=20, rings=10), "Head"),
        (box("Container", (0, 0.135, 1.22), (0.32, 0.12, 0.44), MATS["container"], bevel=0.025), "Chest"),
        (box("Reserve", (0, 0.135, 1.47), (0.3, 0.1, 0.09), MATS["container"], bevel=0.02), "Chest"),
    ]
    # Visor only in front of the face.
    visor = pieces[2][0]
    bm = bmesh.new()
    bm.from_mesh(visor.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.y > -0.05 or v.co.z < 1.62], context="VERTS")
    bm.to_mesh(visor.data)
    bm.free()
    # Harness: belt, shoulder straps, chest strap.
    pieces.append((box("Belt", (0, -0.002, 0.995), (0.29, 0.215, 0.045), MATS["webbing"], bevel=0.015), "Hips"))
    for s in (1, -1):
        pieces.append((box(f"Riser{s}", (s * 0.1, -0.075, 1.3), (0.035, 0.03, 0.30), MATS["webbing"]), "Chest"))
    pieces.append((box("ChestStrap", (0, -0.12, 1.3), (0.24, 0.02, 0.03), MATS["webbing"]), "Chest"))
    # Boots: a toe cap over the skin-modifier ankle.
    for s, side in ((1, "L"), (-1, "R")):
        pieces.append((box(f"Boot.{side}", (s * 0.1, -0.03, 0.06), (0.11, 0.27, 0.12), MATS["dark"],
                           bevel=0.035), f"Foot.{side}"))
        pieces.append((box(f"BootShaft.{side}", (s * 0.1, 0.02, 0.15), (0.1, 0.11, 0.12), MATS["dark"],
                           bevel=0.03), f"Shin.{side}"))
        pieces.append((ellipsoid(f"Glove.{side}", (s * 0.648, -0.016, 1.052), (0.042, 0.032, 0.062), MATS["dark"],
                                 seg=12, rings=8), f"Hand.{side}"))
    for obj, bone in pieces:
        attach(obj, arm, bone)
    # One mesh for the whole figure (one draw call, one skin).
    bpy.ops.object.select_all(action="DESELECT")
    for obj, _ in pieces:
        for m in list(obj.modifiers):
            obj.modifiers.remove(m)
        obj.select_set(True)
    body.select_set(True)
    for m in list(body.modifiers):
        body.modifiers.remove(m)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    mod = body.modifiers.new("arm", "ARMATURE")
    mod.object = arm
    return arm, body


# ---------------------------------------------------------------------------
# Animation: rotations given in armature axes (as if the parent were at rest)
# ---------------------------------------------------------------------------

def rot(axis, deg):
    return Quaternion(Vector(axis), math.radians(deg))


def fwd(deg):
    """Swing a limb forward (towards -Y) by deg."""
    return rot((1, 0, 0), -deg)


def side_in(side, deg):
    """Bring an arm (or leg) towards the body: positive = inward/down for that side."""
    return rot((0, 1, 0), deg if side == "L" else -deg)


def pose(arm, frame, rots, loc=None):
    """rots: bone -> armature-space quaternion (relative to the rest pose)."""
    for name, q in rots.items():
        pb = arm.pose.bones[name]
        rest = pb.bone.matrix_local.to_quaternion()
        pb.rotation_mode = "QUATERNION"
        pb.rotation_quaternion = rest.inverted() @ q @ rest
        pb.keyframe_insert("rotation_quaternion", frame=frame)
    if loc is not None:
        pb = arm.pose.bones["Hips"]
        rest = pb.bone.matrix_local.to_quaternion()
        pb.location = rest.inverted() @ Vector(loc)
        pb.keyframe_insert("location", frame=frame)


def all_bones_rest():
    return {b: Quaternion() for b in BONES}


def action(arm, name, frames, fn):
    """fn(t 0..1) -> (rots, hip offset); keyed on every 2nd frame, looping."""
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data_create()
    arm.animation_data.action = act
    for f in range(0, frames + 1, 2):
        rots, loc = fn(f / frames)
        full = all_bones_rest()
        full.update(rots)
        pose(arm, f, full, loc)
    # Cyclic: the last key equals the first, linear between keys for even motion.
    for fc in getattr(act, "fcurves", []):
        for k in fc.keyframe_points:
            k.interpolation = "BEZIER"
    return act


def arms_down(side, extra=0.0):
    return side_in(side, 40 + extra)


def build_actions(arm):
    tau = 2 * math.pi

    def idle(t):
        b = math.sin(t * tau)
        r = {"Chest": rot((1, 0, 0), 1.2 * b), "Head": rot((0, 0, 1), 4 * math.sin(t * tau + 1))}
        for s in ("L", "R"):
            r[f"UpperArm.{s}"] = arms_down(s, 2 * b) @ fwd(3)
            r[f"Forearm.{s}"] = fwd(12)
        return r, (0, 0, 0.004 * b)

    def walk(t, run=False):
        a = math.sin(t * tau)
        c = math.cos(t * tau)
        thigh = 42 if run else 24
        knee = 95 if run else 35
        armsw = 38 if run else 18
        r = {"Spine": fwd(10 if run else 2), "Chest": rot((0, 0, 1), (6 if run else 4) * a),
             "Hips": rot((0, 0, 1), -(5 if run else 4) * a)}
        for s, ph in (("L", 1), ("R", -1)):
            sw = a * ph
            # Knee bends while the leg swings forward (and just after push-off).
            bend = max(0.0, -c * ph) * knee + (8 if run else 4)
            r[f"Thigh.{s}"] = fwd(thigh * sw + (12 if run else 0))
            r[f"Shin.{s}"] = fwd(-bend)
            r[f"Foot.{s}"] = fwd(-10 * sw)
            r[f"UpperArm.{s}"] = arms_down(s, -2 if run else 2) @ fwd(-armsw * sw)
            r[f"Forearm.{s}"] = fwd(80 if run else 18)
        bob = abs(math.cos(t * tau)) * (0.05 if run else 0.025)
        return r, (0, 0, bob - (0.04 if run else 0.015))

    def freefall(t):
        w = math.sin(t * tau)
        r = {"Chest": rot((1, 0, 0), -12), "Head": rot((1, 0, 0), -25)}
        for s in ("L", "R"):
            # Box position: upper arms out level, forearms towards the head; knees bent.
            r[f"UpperArm.{s}"] = side_in(s, -38 + 2 * w)
            r[f"Forearm.{s}"] = side_in(s, -85)
            r[f"Thigh.{s}"] = side_in(s, -16) @ fwd(-12)
            r[f"Shin.{s}"] = fwd(-85 + 4 * w)
        return r, None

    def canopy(t):
        w = math.sin(t * tau)
        r = {"Head": rot((1, 0, 0), -6)}
        for s, ph in (("L", 1), ("R", -1)):
            # Hands up on the toggles, legs together and slightly forward.
            r[f"UpperArm.{s}"] = side_in(s, -125)
            r[f"Forearm.{s}"] = side_in(s, -20) @ fwd(25)
            r[f"Thigh.{s}"] = fwd(12 + 3 * w * ph)
            r[f"Shin.{s}"] = fwd(-14)
        return r, None

    acts = [
        action(arm, "Idle", 48, idle),
        action(arm, "Walk", 26, walk),
        action(arm, "Run", 16, lambda t: walk(t, True)),
        action(arm, "FreeFall", 48, freefall),
        action(arm, "Canopy", 48, canopy),
    ]
    arm.animation_data.action = acts[0]
    return acts


def preview(arm, acts):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 640, 720
    world = bpy.data.worlds.new("W")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.65, 0.8, 1)
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 4
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    scene.collection.objects.link(sun)
    cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
    scene.collection.objects.link(cam)
    cam.location = (1.7, -2.6, 1.3)
    cam.rotation_euler = (Vector((0, 0, 0.95)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    for act, frame in zip(acts, (0, 6, 4, 12, 12)):
        arm.animation_data.action = act
        scene.frame_set(frame)
        scene.render.filepath = os.path.join(BUILD, f"pilot_preview_{act.name}.png")
        bpy.ops.render.render(write_still=True)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS
    make_materials()
    arm, body = build_figure()
    acts = build_actions(arm)
    print("pilot: triangles", sum(len(p.vertices) - 2 for p in body.data.polygons), "actions",
          [a.name for a in acts])
    if "--preview" in ARGS:
        preview(arm, acts)
        arm.animation_data.action = acts[0]
    out = os.path.join(BUILD, "pilot_raw.glb")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=out, export_format="GLB", export_yup=True, export_apply=False,
        export_skins=True, export_animations=True, export_animation_mode="ACTIONS",
        export_force_sampling=True, export_materials="EXPORT", export_normals=True,
        export_texcoords=False, export_cameras=False, export_lights=False,
    )
    print("exported", out, os.path.getsize(out) // 1024, "KB")


if __name__ == "__main__":
    main()
