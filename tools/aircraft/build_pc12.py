"""
Pilatus PC-12 NG for the game, built from scratch by script.

Rebuild (from the repository root, Git Bash):
  "/c/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup -P tools/aircraft/build_pc12.py

That writes build/aircraft/pc12_raw.glb and then runs `node tools/aircraft/optimize.mjs`, which
writes public/assets/aircraft/pc12.glb (meshopt-compressed, at most 3 MB). Options after `--`:
  --preview[=front34,side,...]  also render Cycles stills into .scratch/preview/
  --fast                        small bake (for iterating), no optimisation run
  --no-bake                     plain materials, no textures
  --no-export                   stop after building (with --preview)

Model frame (glTF): x left, y up, z forward, metres. Origin = reference point = centre of
gravity at FS 5.95 m behind the spinner tip, on the centre line, 1.78 m above the ground with
the aircraft on its gear (see pc12/dims.py).

Naming convention (the loader in src/aircraft finds parts by these names, src/aircraft/
pc12Parts.ts lists them and a test checks the .glb against it):
  LOD0, LOD1, LOD2    levels of detail; LOD1 nodes carry _lod1, the gear legs and the
                      propeller disc also exist in LOD2 (_lod2)
  Exterior pivots (identity rest rotation, extras.axis in the model frame):
    Prop, Blade_0..4 (pitch, extras.buildDeg), Aileron_L/R, Flap_L/R (extras.slide),
    Stabilizer (trim), Elevator, Rudder, gear pivots (see pc12/gear.py), Wheel_L/R/N
  Cockpit pivots and controls: see pc12/cockpit.py and lib/cockpit_kit.py
  Meshes the loader treats specially: PropBlades_<i>, PropDisc, Glass, Lamp_* (emissive),
  Glow_<kind> empties (glow sprite anchors), Eye (pilot eye point), Disp_<ID> (displays),
  Labels, and every mesh under the group Cockpit (hidden detail at distance).
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
for mod in [m for m in list(sys.modules) if m.startswith(("lib", "pc12"))]:
    del sys.modules[mod]

from lib import materials as MAT  # noqa: E402
from lib import mesh as M  # noqa: E402
from lib import bake as B  # noqa: E402
from lib import export as EX  # noqa: E402
from lib import preview as PV  # noqa: E402
from pc12 import dims as D  # noqa: E402
from pc12 import cockpit, details, fuselage, gear, livery, prop, tail, wing  # noqa: E402

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
BUILD = os.path.join(ROOT, "build", "aircraft")
SCRATCH = os.path.join(ROOT, ".scratch", "preview")
# Draw calls matter more than a few hundred triangles: static parts of one material are joined.
STATIC_JOIN = {
    "paint": ["Fuselage", "Wing", "WingCentreTE", "WingTipTE_L", "WingTipTE_R", "Winglet_L", "Winglet_R",
              "FlapTracks", "Fin", "TailFairings"],
}


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


def materials():
    P = MAT.principled
    m = MAT.make_all()
    m["well"] = P("Well", (0.30, 0.31, 0.32), 0.7, double_sided=True)
    m["spinner"] = P("Spinner", (0.92, 0.92, 0.9), 0.25, coat=1.0, coat_rough=0.05)
    m["prop_blade"] = P("PropBlade", (0.035, 0.035, 0.038), 0.5)
    m["gear_paint"] = P("GearPaint", (0.78, 0.79, 0.8), 0.4, 0.3)
    m["recognition"] = P("Lamp_Recog", (0.9, 0.9, 0.88), 0.1, emission=(1, 1, 0.95), strength=2)
    m["ice"] = P("Lamp_Ice", (0.9, 0.9, 0.88), 0.1, emission=(1, 1, 0.95), strength=2)
    m["taxi"] = P("Lamp_Taxi", (0.9, 0.9, 0.85), 0.1, emission=(1, 0.95, 0.85), strength=2)
    m["exhaust"] = P("Exhaust", (0.42, 0.36, 0.32), 0.45, 0.9)
    # The PC-12's panel is a medium-dark grey; the display bezels are darker.
    m["panel"] = P("Panel", (0.20, 0.205, 0.21), 0.6)
    m["interior"] = P("Interior", (0.47, 0.475, 0.47), 0.75)
    return m


def build_geometry(with_cockpit=True):
    M.set_reference(D.REF_BL, D.REF_FS, D.REF_WL)
    mats = materials()
    col = M.collection("LOD0")
    parts = {}
    t = time.time()
    skin, glass, lining = fuselage.build(col, mats)
    parts.update(Fuselage=skin, Glass=glass, CabinLining=lining)
    parts["NoseWell"] = fuselage.nose_well(col, mats)
    print(f"fuselage {time.time() - t:.1f}s")
    wing.build(col, mats, parts)
    tail.build(col, mats, parts)
    prop.build(col, mats, parts)
    gear.build(col, mats, parts)
    details.build(col, mats, parts)
    print(f"exterior {time.time() - t:.1f}s")
    root = M.empty("LOD0", col, (0, 0, 0), size=0.5)
    cab = M.empty("Cockpit", col, (0, 0, 0), parent=root, size=0.3)
    if with_cockpit:
        cockpit.build(col, mats, cab)
    else:
        eye = M.empty("Eye", col, M.P(*D.EYE), size=0.03)
        M.parent_keep(eye, cab)
    M.parent_keep(lining, cab)
    for o in col.objects:
        if o.parent is None and o is not root:
            M.parent_keep(o, root)
    tris = sum(M.tri_count(o) for o in col.all_objects if o.type == "MESH")
    cab_tris = sum(M.tri_count(o) for o in cab.children_recursive if o.type == "MESH")
    print(f"geometry {time.time() - t:.1f}s; LOD0 triangles {tris}, cockpit {cab_tris}, exterior {tris - cab_tris}")
    return col, mats, parts


def join_statics():
    """Joins the static painted parts into one object (one draw call)."""
    objs = [bpy.data.objects[n] for n in STATIC_JOIN["paint"]]
    return M.join(objs, "Airframe")


def texture(mats, size, ao_samples):
    t = time.time()
    objs = [o for o in bpy.data.objects if o.type == "MESH" and any(
        s.material and s.material.name == "Paint" for s in o.material_slots)]
    objs.sort(key=lambda o: o.name)
    names = [o.name.replace("_mesh", "") for o in objs]
    B.POS_RANGE[0] = 10.0
    B.unwrap(objs)
    hide = [o for o in bpy.data.objects if o.type == "MESH" and (
        o.name in ("Glass", "PropDisc") or o.name.startswith(("Lens_", "Lamp_", "PropBlades")))]
    pos, nrm, pid, cov, ao = B.bake_maps(objs, size, ao_samples, hide)
    print(f"bakes {time.time() - t:.1f}s, coverage {cov.mean() * 100:.0f} %")
    base, orm, nmap = livery.compute(pos, nrm, pid, cov, ao, names)
    tex_dir = os.path.join(BUILD, "textures")
    os.makedirs(tex_dir, exist_ok=True)
    paths = {}
    # The base colour carries the lettering at full size; roughness, AO and the panel-line
    # relief are soft and keep half the resolution (texture memory budget).
    small = max(size // 2, 512)
    for name, arr, srgb in (("pc12_base", base, True), ("pc12_orm", orm, False), ("pc12_normal", nmap, False)):
        paths[name] = os.path.join(tex_dir, name + ".png")
        if srgb:
            arr = np.where(arr > 0.0031308, 1.055 * np.power(np.clip(arr, 0, 1), 1 / 2.4) - 0.055, arr * 12.92)
        else:
            arr = arr.reshape(small, size // small, small, size // small, arr.shape[-1]).mean((1, 3))
        B.save_png(name + "_tmp", arr, paths[name], srgb=srgb)
    imgs = {n: B.load_image(pth, non_color=(n != "pc12_base")) for n, pth in paths.items()}
    for img in imgs.values():
        img.name = os.path.basename(img.filepath)
    B.wire_paint_material(mats["paint"], imgs["pc12_base"], imgs["pc12_orm"], imgs["pc12_normal"])
    print(f"texture {time.time() - t:.1f}s")


def main():
    os.makedirs(BUILD, exist_ok=True)
    reset()
    col, mats, parts = build_geometry(with_cockpit=arg("--no-cockpit") is None)
    if arg("--no-bake") is None:
        fast = arg("--fast") is not None
        texture(mats, 1024 if fast else 2048, 16 if fast else 64)
    # After the bake: the livery tells the parts apart by object.
    join_statics()
    pv = arg("--preview")
    if pv is not None:
        os.makedirs(SCRATCH, exist_ok=True)
        PV.setup(samples=int(arg("--samples") or 24), ground_z=-D.REF_WL)
        all_views = PV.views(tuple(M.P(*D.EYE)))
        names = pv.split(",") if pv else ["front34", "side", "front", "top", "rear34"]
        for n in names:
            loc, tgt, lens = all_views[n]
            PV.render(os.path.join(SCRATCH, f"pc12_{n}.png"), loc, tgt, lens)
    if arg("--no-export") is None:
        report = EX.build_lods(
            bpy.data.objects["LOD0"], col,
            cabin_keep=("Cockpit", "CabinLining", "Cabin_interior_dark", "Cabin_panel", "Cabin_glareshield",
                        "Cabin_fabric", "Cabin_leather", "Displays_static"),
            drop1=("Fittings", "Antennas", "Lens_", "Eye", "Wicks_", "LegFittings_", "NoseWell", "MainWells"),
            ratio1=lod1_ratio, ratio2=0.18,
            lod2_movable=("MainGear_L", "MainGear_R", "NoseGear"), lod2_ratio=0.25)
        print("triangles per LOD:", report)
        raw = os.path.join(BUILD, "pc12_raw.glb")
        EX.export_glb(raw, image_quality=88)
        print("exported", raw, os.path.getsize(raw) // 1024, "KB")
        if arg("--fast") is None or arg("--optimize") is not None:
            subprocess.run(["node", os.path.join(ROOT, "tools", "aircraft", "optimize.mjs"), raw,
                            os.path.join(ROOT, "public", "assets", "aircraft", "pc12.glb"), "3"],
                           cwd=ROOT, check=True, shell=os.name == "nt")
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BUILD, "pc12.blend"))


def lod1_ratio(o):
    n = M.tri_count(o)
    if o.name == "PropDisc" or o.name.startswith(("Lamp_", "Glow_")):
        return 1.0
    if n > 20000:
        return 0.16
    if n > 4000:
        return 0.24
    if n > 1000:
        return 0.33
    return 0.5


if __name__ == "__main__":
    main()
