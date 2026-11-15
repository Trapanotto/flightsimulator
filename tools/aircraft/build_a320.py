"""
Airbus A320-214 for the game, built from scratch by script.

Rebuild (from the repository root, Git Bash):
  "/c/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup -P tools/aircraft/build_a320.py

That writes build/aircraft/a320_raw.glb and then runs `node tools/aircraft/optimize.mjs`, which
writes public/assets/aircraft/a320.glb (meshopt-compressed, at most 4 MB). Options after `--`:
  --preview[=front34,side,...]  also render Cycles stills into .scratch/preview/
  --fast                        small bake (for iterating), no optimisation run
  --no-bake                     plain materials, no textures
  --no-cockpit                  the flight deck left out (exterior work)
  --no-export                   stop after building (with --preview)

Model frame (glTF): x left, y up, z forward, metres. Origin = reference point = centre of
gravity at 25 % MAC, FS 16.17 m behind the nose tip, on the centre line, 3.20 m above the
ground with the aircraft on its gear (see a320/dims.py).

Naming convention (the loader in src/aircraft finds parts by these names, src/aircraft/
a320Parts.ts lists them and a test checks the .glb against it):
  LOD0, LOD1, LOD2    levels of detail; LOD1 nodes carry _lod1, the gear legs also exist in
                      LOD2 (_lod2)
  Exterior pivots (identity rest rotation, extras.axis in the model frame): see a320/wing.py,
    a320/tail.py, a320/engine.py and a320/gear.py
  Cockpit pivots and controls: see a320/cockpit.py, a320/controls.py and lib/cockpit_kit.py
  Meshes the loader treats specially: FanBlades_<s>, FanDisc_<s> (PropDisc material), Glass,
  Lamp_* (emissive), Glow_<kind> empties (glow sprite anchors), Eye (captain's eye point),
  Disp_<ID> (displays), Labels, and every mesh under the group Cockpit (hidden detail at
  distance).
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
for mod in [m for m in list(sys.modules) if m.startswith(("lib", "a320"))]:
    del sys.modules[mod]

from lib import materials as MAT  # noqa: E402
from lib import mesh as M  # noqa: E402
from lib import bake as B  # noqa: E402
from lib import export as EX  # noqa: E402
from lib import preview as PV  # noqa: E402
from a320 import dims as D  # noqa: E402
from a320 import details, engine, fuselage, gear, livery, tail, wing  # noqa: E402

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
BUILD = os.path.join(ROOT, "build", "aircraft")
SCRATCH = os.path.join(ROOT, ".scratch", "preview")
# Draw calls matter more than a few hundred triangles: static parts of one material are joined.
STATIC_JOIN = {
    "Airframe": ["Fuselage", "Wing", "WingCentreTE", "WingTipTE_L", "WingTipTE_R", "Fence_L", "Fence_R",
                 "FlapTracks", "Fin", "FinCap", "TailFairings", "BellyFairing", "Nacelle_L", "Nacelle_R",
                 "Pylon_L", "Pylon_R", "Strake_L", "Strake_R", "NoseWell", "MainWells"],
    "Antennas": ["Antennas", "Wicks", "Wipers"],
    "EngineMetal": ["EngineMetal_L", "EngineMetal_R"],
    "EngineDark": ["EngineDark_L", "EngineDark_R"],
    "EngineCore": ["EngineCore_L", "EngineCore_R"],
    "EngineHot": ["EngineHot_L", "EngineHot_R", "ApuExhaust"],
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
    m["well"] = P("Well", (0.28, 0.29, 0.30), 0.75, double_sided=True)
    m["intake"] = P("Intake", (0.025, 0.025, 0.028), 0.8, double_sided=True)
    m["intake_grey"] = P("IntakeGrey", (0.34, 0.35, 0.37), 0.55, 0.4, double_sided=True)
    m["core"] = P("CoreCowl", (0.55, 0.56, 0.58), 0.4, 0.7, double_sided=True)
    m["exhaust"] = P("Exhaust", (0.30, 0.27, 0.25), 0.5, 0.8, double_sided=True)
    m["metal_dark"] = P("MetalDark", (0.35, 0.34, 0.33), 0.45, 0.8, double_sided=True)
    m["fan"] = P("FanBlade", (0.62, 0.63, 0.65), 0.28, 1.0)
    m["spinner"] = P("Spinner", (0.06, 0.06, 0.065), 0.35)
    m["gear_paint"] = P("GearPaint", (0.80, 0.81, 0.82), 0.4, 0.2)
    m["taxi"] = P("Lamp_Taxi", (0.9, 0.9, 0.85), 0.1, emission=(1, 0.95, 0.85), strength=2)
    m["takeoff"] = P("Lamp_Takeoff", (0.9, 0.9, 0.85), 0.1, emission=(1, 0.95, 0.85), strength=2)
    m["turnoff"] = P("Lamp_Turnoff", (0.9, 0.9, 0.85), 0.1, emission=(1, 0.95, 0.85), strength=2)
    m["wing"] = P("Lamp_Wing", (0.9, 0.9, 0.88), 0.1, emission=(1, 1, 0.95), strength=2)
    m["logo"] = P("Lamp_Logo", (0.9, 0.9, 0.88), 0.1, emission=(1, 1, 0.95), strength=2)
    # The Airbus flight deck's blue-grey panels, the lighter lining.
    m["panel"] = P("Panel", (0.22, 0.25, 0.28), 0.6)
    m["panel_light"] = P("PanelLight", (0.40, 0.43, 0.46), 0.65)
    m["interior"] = P("Interior", (0.55, 0.57, 0.58), 0.75)
    m["interior_dark"] = P("InteriorDark", (0.16, 0.17, 0.18), 0.7)
    m["korry"] = P("Korry", (0.05, 0.05, 0.055), 0.4)
    m["sheepskin"] = P("Fabric", (0.30, 0.31, 0.33), 0.95)
    return m


def build_geometry(with_cockpit=True):
    M.set_reference(D.REF_BL, D.REF_FS, D.REF_WL)
    mats = materials()
    col = M.collection("LOD0")
    parts = {}
    t = time.time()
    skin, glass, lining = fuselage.build(col, mats)
    parts.update(Fuselage=skin, Glass=glass, CabinLining=lining)
    # One material for the lining and its window reveals: one draw call less.
    for p in lining.data.polygons:
        p.material_index = 0
    lining.data.materials.pop(index=1)
    parts["NoseWell"] = fuselage.nose_well(col, mats)
    parts["BellyFairing"] = fuselage.belly(col, mats)
    parts["MainWells"] = fuselage.wheel_wells(col, mats)
    print(f"fuselage {time.time() - t:.1f}s")
    wing.build(col, mats, parts)
    tail.build(col, mats, parts)
    engine.build(col, mats, parts)
    gear.build(col, mats, parts)
    details.build(col, mats, parts)
    print(f"exterior {time.time() - t:.1f}s")
    root = M.empty("LOD0", col, (0, 0, 0), size=0.5)
    cab = M.empty("Cockpit", col, (0, 0, 0), parent=root, size=0.3)
    if with_cockpit:
        from a320 import cockpit
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
    for name, members in STATIC_JOIN.items():
        M.join([bpy.data.objects[n] for n in members if n in bpy.data.objects], name)


def texture(mats, size, ao_samples):
    t = time.time()
    objs = [o for o in bpy.data.objects if o.type == "MESH" and any(
        s.material and s.material.name == "Paint" for s in o.material_slots)]
    objs.sort(key=lambda o: o.name)
    names = [o.name.replace("_mesh", "") for o in objs]
    B.POS_RANGE[0] = 20.0
    B.unwrap(objs, margin=0.002)
    hide = [o for o in bpy.data.objects if o.type == "MESH" and (
        o.name in ("Glass",) or o.name.startswith(("Lens_", "Lamp_", "FanDisc", "FanBlades")))]
    pos, nrm, pid, cov, ao = B.bake_maps(objs, size, ao_samples, hide)
    print(f"bakes {time.time() - t:.1f}s, coverage {cov.mean() * 100:.0f} %")
    base, orm, nmap = livery.compute(pos, nrm, pid, cov, ao, names)
    tex_dir = os.path.join(BUILD, "textures")
    os.makedirs(tex_dir, exist_ok=True)
    paths = {}
    small = max(size // 2, 512)
    for name, arr, srgb in (("a320_base", base, True), ("a320_orm", orm, False), ("a320_normal", nmap, False)):
        paths[name] = os.path.join(tex_dir, name + ".png")
        if srgb:
            arr = np.where(arr > 0.0031308, 1.055 * np.power(np.clip(arr, 0, 1), 1 / 2.4) - 0.055, arr * 12.92)
        else:
            arr = arr.reshape(small, size // small, small, size // small, arr.shape[-1]).mean((1, 3))
        B.save_png(name + "_tmp", arr, paths[name], srgb=srgb)
    imgs = {n: B.load_image(pth, non_color=(n != "a320_base")) for n, pth in paths.items()}
    for img in imgs.values():
        img.name = os.path.basename(img.filepath)
    B.wire_paint_material(mats["paint"], imgs["a320_base"], imgs["a320_orm"], imgs["a320_normal"])
    print(f"texture {time.time() - t:.1f}s")


def main():
    os.makedirs(BUILD, exist_ok=True)
    reset()
    col, mats, parts = build_geometry(with_cockpit=arg("--no-cockpit") is None)
    if arg("--no-bake") is None:
        fast = arg("--fast") is not None
        texture(mats, 1024 if fast else 2048, 12 if fast else 48)
    join_statics()
    pv = arg("--preview")
    if pv is not None:
        os.makedirs(SCRATCH, exist_ok=True)
        PV.setup(samples=int(arg("--samples") or 16), ground_z=-D.REF_WL)
        names = pv.split(",") if pv else ["front34"]
        for n in names:
            loc, tgt, lens = preview_views()[n]
            PV.render(os.path.join(SCRATCH, f"a320_{n}.png"), loc, tgt, lens)
    if arg("--no-export") is None:
        report = EX.build_lods(
            bpy.data.objects["LOD0"], col,
            cabin_keep=("Cockpit", "CabinLining", "Cabin_interior_dark", "Cabin_panel", "Cabin_glareshield",
                        "Cabin_sheepskin", "Cabin_interior"),
            drop1=("Antennas", "Lens_", "Eye", "Wicks", "NoseWell", "MainWells", "Wipers", "Strake",
                   "MainPiston", "NosePiston", "NoseLegDoor"),
            ratio1=lod1_ratio, ratio2=0.10,
            lod2_movable=("MainGear_L", "MainGear_R", "NoseGear"), lod2_ratio=0.2)
        print("triangles per LOD:", report)
        raw = os.path.join(BUILD, "a320_raw.glb")
        EX.export_glb(raw, image_quality=88)
        print("exported", raw, os.path.getsize(raw) // 1024, "KB")
        if arg("--fast") is None or arg("--optimize") is not None:
            subprocess.run(["node", os.path.join(ROOT, "tools", "aircraft", "optimize.mjs"), raw,
                            os.path.join(ROOT, "public", "assets", "aircraft", "a320.glb"), "4"],
                           cwd=ROOT, check=True, shell=os.name == "nt")
    if arg("--no-save") is None:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BUILD, "a320.blend"))


def preview_views():
    return {
        "front34": ((-26.0, -30.0, 6.0), (0.0, 1.0, 0.0), 40),
        "side": ((-90.0, 1.0, 1.0), (0.0, 1.0, 1.0), 85),
    }


def lod1_ratio(o):
    n = M.tri_count(o)
    if o.name.startswith(("Lamp_", "Glow_", "FanDisc")):
        return 1.0
    if n > 40000:
        return 0.20
    if n > 8000:
        return 0.28
    if n > 2000:
        return 0.35
    return 0.5


if __name__ == "__main__":
    main()
