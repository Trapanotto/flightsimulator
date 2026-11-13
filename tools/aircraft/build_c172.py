"""
Cessna 172S Skyhawk SP for the game, built from scratch by script.

Rebuild (from the repository root, Git Bash):
  "/c/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup -P tools/aircraft/build_c172.py

That writes build/aircraft/c172_raw.glb and then runs `node tools/aircraft/optimize.mjs`, which
writes public/assets/aircraft/c172.glb (meshopt-compressed). Options after `--`:
  --preview[=front34,side,...]  also render Cycles stills into .scratch/preview/
  --fast                        small bake (for iterating), no optimisation run
  --no-bake                     plain materials, no textures
  --no-export                   stop after building (with --preview)

Model frame (glTF): x left, y up, z forward, metres. Origin = reference point = centre of
gravity at FS 41 in (1.041 m aft of the firewall face), on the centre line, 1.22 m above the
ground with the aircraft on its gear (see c172/dims.py).

Naming convention (the loader in src/aircraft finds parts by these names):
  LOD0, LOD1, LOD2            groups for the levels of detail (LOD1/LOD2 nodes carry the suffix
                              _lod1/_lod2; moving parts exist in LOD0 and LOD1)
  Pivots (empties, identity rest rotation, extras.axis = rotation axis in the model frame,
  positive angle = the positive direction named here):
    Prop          engine rotation (clockwise seen from the cockpit)
    Aileron_L/R   trailing edge down        extras upDeg/downDeg
    Flap_L/R      trailing edge down        extras maxDeg, slide (m at full flap)
    Elevator      trailing edge up          extras upDeg/downDeg
    TrimTab       trailing edge up (child of Elevator)
    Rudder        trailing edge right       extras leftDeg/rightDeg
    NoseSteer     wheel turns right         extras maxDeg
    Wheel_L/R/N   rolling forward           extras radius
    Yoke_L/R      slide: extras slide = metres towards the pilot at full back pressure
    YokeRoll_L/R  child of Yoke_*, positive = turned right (clockwise from the seat)
    Pedals_L/R    slide: extras slide = metres forward at full pedal (left and right pedals)
    Throttle, Mixture   slide: extras slide = metres pulled out at lever 0
    FlapLever     slide: extras slide = metres moved at flaps 1
    TrimWheel     positive = nose up
    Gauge pivots  Needle_<ID>, AI_Roll, HI_Card, TC_Plane, TC_Ball, Compass_Card:
                  extras axis points out of the instrument towards the pilot; the loader turns
                  clockwise (as seen by the pilot) with negative angles.
  Meshes the loader treats specially: PropBlades, PropDisc, Glass (windows), Face_<ID> (dial
  faces: square UVs 0..1, the loader draws them), AI_Pitch (attitude card), Lamp_* (emissive),
  Glow_<kind> empties (glow sprite anchors), Eye (pilot eye point), and every mesh under the
  group Cockpit (hidden at distance).
"""

import os
import subprocess
import sys
import time

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)
for mod in [m for m in list(sys.modules) if m.startswith(("lib", "c172"))]:
    del sys.modules[mod]

from lib import materials as MAT  # noqa: E402
from lib import mesh as M  # noqa: E402
from lib import bake as B  # noqa: E402
from lib import export as EX  # noqa: E402
from lib import preview as PV  # noqa: E402
from c172 import dims as D  # noqa: E402
from c172 import cockpit, details, fuselage, gear, livery, prop, wing  # noqa: E402

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
BUILD = os.path.join(ROOT, "build", "aircraft")
SCRATCH = os.path.join(ROOT, ".scratch", "preview")


def arg(name):
    for a in ARGS:
        if a == name:
            return ""
        if a.startswith(name + "="):
            return a.split("=", 1)[1]
    return None


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = "METRIC"


def build_geometry():
    M.set_reference(D.REF_BL, D.REF_FS, D.REF_WL)
    mats = MAT.make_all()
    col = M.collection("LOD0")
    parts = {}
    t = time.time()
    skin, glass, lining = fuselage.build(col, mats)
    parts.update(Fuselage=skin, Glass=glass, CabinLining=lining)
    print(f"fuselage {time.time() - t:.1f}s")
    wing.build_wing(col, mats, parts)
    wing.build_htail(col, mats, parts)
    wing.build_vtail(col, mats, parts)
    prop.build(col, mats, parts)
    gear.build(col, mats, parts)
    details.build(col, mats, parts)
    root = M.empty("LOD0", col, (0, 0, 0), size=0.5)
    cab = M.empty("Cockpit", col, (0, 0, 0), parent=root, size=0.3)
    cockpit.build(col, mats, cab)
    M.parent_keep(lining, cab)
    # Lamps on the rudder move with it.
    rudder = bpy.data.objects["Rudder"]
    for n in ("Lamp_Tail", "Lamp_Beacon", "Glow_Tail", "Glow_Beacon"):
        M.parent_keep(bpy.data.objects[n], rudder)
    for o in col.objects:
        if o.parent is None and o is not root:
            M.parent_keep(o, root)
    print(f"geometry {time.time() - t:.1f}s")
    tris = sum(M.tri_count(o) for o in col.all_objects if o.type == "MESH")
    print("LOD0 triangles:", tris)
    return col, mats, parts


def texture(mats, size, ao_samples):
    """Skin atlas: unwrap, bake, compute the livery, wire the Paint material."""
    t = time.time()
    objs = [o for o in bpy.data.objects if o.type == "MESH" and any(
        s.material and s.material.name == "Paint" for s in o.material_slots)]
    objs.sort(key=lambda o: o.name)
    names = [o.name.replace("_mesh", "") for o in objs]
    B.unwrap(objs)
    hide = [o for o in bpy.data.objects if o.type == "MESH" and (
        o.name in ("Glass", "PropDisc", "PropBlades") or o.name.startswith(("Lens_", "Lamp_")))]
    pos, nrm, pid, cov, ao = B.bake_maps(objs, size, ao_samples, hide)
    print(f"bakes {time.time() - t:.1f}s, coverage {cov.mean() * 100:.0f} %")
    base, orm, nmap = livery.compute(pos, nrm, pid, cov, ao, names)
    tex_dir = os.path.join(BUILD, "textures")
    os.makedirs(tex_dir, exist_ok=True)
    paths = {}
    for name, arr, srgb in (("c172_base", base, True), ("c172_orm", orm, False), ("c172_normal", nmap, False)):
        paths[name] = os.path.join(tex_dir, name + ".png")
        # Images are written in linear values; the base colour is converted back for 8 bits.
        if srgb:
            arr = np.where(arr > 0.0031308, 1.055 * np.power(np.clip(arr, 0, 1), 1 / 2.4) - 0.055, arr * 12.92)
        B.save_png(name + "_tmp", arr, paths[name], srgb=srgb)
    imgs = {n: B.load_image(pth, non_color=(n != "c172_base")) for n, pth in paths.items()}
    for img in imgs.values():
        img.name = os.path.basename(img.filepath)
    B.wire_paint_material(mats["paint"], imgs["c172_base"], imgs["c172_orm"], imgs["c172_normal"])
    print(f"texture {time.time() - t:.1f}s")


def main():
    os.makedirs(BUILD, exist_ok=True)
    reset()
    col, mats, parts = build_geometry()
    if arg("--no-bake") is None:
        fast = arg("--fast") is not None
        texture(mats, 1024 if fast else 2048, 16 if fast else 96)
    pv = arg("--preview")
    if pv is not None:
        os.makedirs(SCRATCH, exist_ok=True)
        PV.setup(samples=int(arg("--samples") or 24), ground_z=-D.REF_WL)
        eye = M.P(*D.EYE)
        all_views = PV.views(tuple(eye))
        names = pv.split(",") if pv else ["front34", "side", "front", "top", "rear34"]
        for n in names:
            loc, tgt, lens = all_views[n]
            PV.render(os.path.join(SCRATCH, f"{n}.png"), loc, tgt, lens)
    if arg("--no-export") is None:
        report = EX.build_lods(bpy.data.objects["LOD0"], col)
        print("triangles per LOD:", report)
        raw = os.path.join(BUILD, "c172_raw.glb")
        EX.export_glb(raw)
        print("exported", raw, os.path.getsize(raw) // 1024, "KB")
        if arg("--fast") is None or arg("--optimize") is not None:
            subprocess.run(["node", os.path.join(ROOT, "tools", "aircraft", "optimize.mjs"), raw,
                            os.path.join(ROOT, "public", "assets", "aircraft", "c172.glb")],
                           cwd=ROOT, check=True, shell=os.name == "nt")
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BUILD, "c172.blend"))


if __name__ == "__main__":
    main()
