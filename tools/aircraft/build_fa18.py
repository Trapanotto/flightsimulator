"""
McDonnell Douglas F/A-18C Hornet (Swiss Air Force, J-5099) for the game, built by script.

Rebuild (from the repository root, Git Bash):
  "/c/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup -P tools/aircraft/build_fa18.py

That writes build/aircraft/fa18_raw.glb and then runs `node tools/aircraft/optimize.mjs`, which
writes public/assets/aircraft/fa18.glb (meshopt-compressed, at most 3.5 MB). Options after `--`:
  --preview[=front34,side,...]  also render Cycles stills into .scratch/preview/
  --fast                        small bake (for iterating), no optimisation run
  --no-bake                     plain materials, no textures
  --no-cockpit                  only the eye point in the cockpit
  --no-export                   stop after building (with --preview)

Model frame (glTF): x left, y up, z forward, metres. Origin = reference point = centre of
gravity at FS 8.70 m behind the radome tip, on the centre line, 2.00 m above the ground with
the aircraft on its gear (see fa18/dims.py).

Naming convention (src/aircraft/fa18Parts.ts lists the names and a test checks the .glb):
  LOD0, LOD1, LOD2    levels of detail; LOD1 nodes carry _lod1; the gear legs, the canopy and
                      the hook also exist in LOD2 (_lod2)
  Exterior pivots (identity rest rotation, extras.axis in the model frame): LEF_L/R, TEF_L/R,
    Aileron_L/R (wing.py), Rudder_L/R, Stabilator_L/R, Speedbrake (tail.py), Canopy, the gear
    pivots, Hook, LaunchBar (gear.py), Flame_L/R (engines.py), Wheel_L/R/N
  Meshes the loader treats specially: Nozzles (petals opened by a vertex displacement),
    Flame_L/R_mesh (afterburner), VapourLex, VapourTip, Pilot, Glass, CanopyGlass, Lamp_*
    (emissive), Glow_<kind> empties, Eye, Disp_<ID> (displays, Disp_HUD the head-up display's
    symbol plane), Labels, and every mesh under the group Cockpit (hidden detail at distance).
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
for mod in [m for m in list(sys.modules) if m.startswith(("lib", "fa18"))]:
    del sys.modules[mod]

from lib import materials as MAT  # noqa: E402
from lib import mesh as M  # noqa: E402
from lib import bake as B  # noqa: E402
from lib import export as EX  # noqa: E402
from lib import preview as PV  # noqa: E402
from fa18 import dims as D  # noqa: E402
from fa18 import cockpit, details, engines, fuselage, gear, livery, tail, wing  # noqa: E402

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
BUILD = os.path.join(ROOT, "build", "aircraft")
SCRATCH = os.path.join(ROOT, ".scratch", "preview")
# Static painted parts of one material are joined (one draw call).
STATIC_JOIN = ["Fuselage", "Wing", "Rails", "Fins", "Intakes", "Splitters", "Nacelles", "WindscreenArch"]


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
    # The skin is light grey; the baked atlas carries the two-tone scheme.
    m["paint"] = P("Paint", (0.60, 0.62, 0.64), 0.55)
    m["intake"] = P("Intake", (0.05, 0.05, 0.055), 0.8, double_sided=True)
    m["well"] = P("Well", (0.55, 0.56, 0.57), 0.7, double_sided=True)
    m["gear_paint"] = P("GearPaint", (0.82, 0.83, 0.84), 0.45, 0.2)
    m["hook"] = P("Hook", (0.62, 0.63, 0.64), 0.5, 0.3)
    m["nozzle"] = P("Nozzle", (0.33, 0.31, 0.29), 0.5, 0.85, double_sided=True)
    m["exhaust_in"] = P("ExhaustInner", (0.12, 0.10, 0.09), 0.7, 0.6, double_sided=True)
    m["flame"] = P("Flame", (1.0, 0.6, 0.3), 0.5, alpha=0.5, emission=(1.0, 0.55, 0.2), strength=2,
                   double_sided=True)
    m["formation"] = P("Lamp_Formation", (0.62, 0.66, 0.56), 0.6, emission=(0.75, 1.0, 0.55), strength=1)
    m["vapour_lex"] = P("VapourLex", (1, 1, 1), 0.9, alpha=0.2, double_sided=True)
    m["vapour_tip"] = P("VapourTip", (1, 1, 1), 0.9, alpha=0.2, double_sided=True)
    m["flight_suit"] = P("FlightSuit", (0.30, 0.31, 0.26), 0.85)
    m["helmet"] = P("Helmet", (0.36, 0.37, 0.36), 0.4)
    m["visor"] = P("Visor", (0.05, 0.05, 0.06), 0.08, 0.6)
    m["antenna"] = P("Antenna", (0.40, 0.42, 0.44), 0.5)
    # Cockpit: the Hornet's is a dark grey office with black consoles.
    m["interior"] = P("Interior", (0.13, 0.135, 0.14), 0.75)
    m["interior_dark"] = P("InteriorDark", (0.06, 0.062, 0.065), 0.7)
    m["panel"] = P("Panel", (0.075, 0.078, 0.082), 0.6)
    m["seat_cushion"] = P("Fabric", (0.12, 0.13, 0.10), 0.95)
    m["seat_frame"] = P("SeatFrame", (0.20, 0.21, 0.22), 0.6, 0.3)
    m["eject"] = P("EjectHandle", (0.9, 0.72, 0.05), 0.5)
    m["hud_glass"] = P("GaugeGlass", (0.1, 0.12, 0.1), 0.03, alpha=0.08)
    return m


def build_geometry(with_cockpit=True):
    M.set_reference(D.REF_BL, D.REF_FS, D.REF_WL)
    mats = materials()
    col = M.collection("LOD0")
    parts = {}
    t = time.time()
    skin, glass, canopy_glass, lining = fuselage.build(col, mats)
    parts.update(Fuselage=skin, Glass=glass, CabinLining=lining)
    frame, arch = fuselage.canopy_frame(col, mats)
    parts["WindscreenArch"] = arch
    # The canopy: glass and frame on the aft hinge.
    hinge = np.array([0.0, *D.CANOPY_HINGE])
    can = M.empty("Canopy", col, M.P(*hinge), props={"axis": M.model_axis(1.0, 0, 0), "openDeg": D.CANOPY_OPEN_DEG})
    probe = np.array([0.0, 4.2, 3.0])
    if np.dot(M.rot_axis((1.0, 0, 0), 0.05) @ (probe - hinge) + hinge - probe, np.array([0, 0, 1.0])) < 0:
        can["axis"] = M.model_axis(-1.0, 0, 0)
    for o in (canopy_glass, frame):
        M.parent_keep(o, can)
    print(f"fuselage {time.time() - t:.1f}s")
    wing.build(col, mats, parts)
    tail.build(col, mats, parts)
    engines.build(col, mats, parts)
    gear.build(col, mats, parts)
    details.build(col, mats, parts)
    pilot = details.pilot(col, mats)
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
    del pilot
    return col, mats, parts


def join_statics():
    return M.join([bpy.data.objects[n] for n in STATIC_JOIN], "Airframe")


PAINTED_EXTRA = ("Speedbrake_mesh",)


def texture(mats, size, ao_samples):
    t = time.time()
    objs = [o for o in bpy.data.objects if o.type == "MESH" and any(
        s.material and s.material.name == "Paint" for s in o.material_slots)]
    objs.sort(key=lambda o: o.name)
    names = [o.name.replace("_mesh", "") for o in objs]
    # The Hornet is 17 m long: the position bake has to cover +-9 m round the CG.
    B.POS_RANGE[0] = 10.0
    B.unwrap(objs)
    hide = [o for o in bpy.data.objects if o.type == "MESH" and (
        o.name in ("Glass", "CanopyGlass", "Pilot") or o.name.startswith(("Lens_", "Lamp_", "Vapour", "Flame_")))]
    pos, nrm, pid, cov, ao = B.bake_maps(objs, size, ao_samples, hide)
    print(f"bakes {time.time() - t:.1f}s, coverage {cov.mean() * 100:.0f} %")
    base, orm, nmap = livery.compute(pos, nrm, pid, cov, ao, names)
    tex_dir = os.path.join(BUILD, "textures")
    os.makedirs(tex_dir, exist_ok=True)
    paths = {}
    small = max(size // 2, 512)
    for name, arr, srgb in (("fa18_base", base, True), ("fa18_orm", orm, False), ("fa18_normal", nmap, False)):
        paths[name] = os.path.join(tex_dir, name + ".png")
        if srgb:
            arr = np.where(arr > 0.0031308, 1.055 * np.power(np.clip(arr, 0, 1), 1 / 2.4) - 0.055, arr * 12.92)
        else:
            arr = arr.reshape(small, size // small, small, size // small, arr.shape[-1]).mean((1, 3))
        B.save_png(name + "_tmp", arr, paths[name], srgb=srgb)
    imgs = {n: B.load_image(pth, non_color=(n != "fa18_base")) for n, pth in paths.items()}
    for img in imgs.values():
        img.name = os.path.basename(img.filepath)
    B.wire_paint_material(mats["paint"], imgs["fa18_base"], imgs["fa18_orm"], imgs["fa18_normal"])
    print(f"texture {time.time() - t:.1f}s")


def lod1_ratio(o):
    n = M.tri_count(o)
    if o.name.startswith(("Lamp_", "Glow_", "Flame_", "Vapour", "Nozzles")):
        return 1.0
    if n > 20000:
        return 0.18
    if n > 4000:
        return 0.25
    if n > 1000:
        return 0.35
    return 0.5


def main():
    os.makedirs(BUILD, exist_ok=True)
    reset()
    col, mats, parts = build_geometry(with_cockpit=arg("--no-cockpit") is None)
    if arg("--no-bake") is None:
        fast = arg("--fast") is not None
        texture(mats, 1024 if fast else 2048, 16 if fast else 64)
    join_statics()
    pv = arg("--preview")
    if pv is not None:
        os.makedirs(SCRATCH, exist_ok=True)
        PV.setup(samples=int(arg("--samples") or 24), ground_z=-D.REF_WL)
        all_views = PV.views(tuple(M.P(*D.EYE)))
        names = pv.split(",") if pv else ["front34", "side", "front", "top", "rear34"]
        for n in names:
            loc, tgt, lens = all_views[n]
            PV.render(os.path.join(SCRATCH, f"fa18_{n}.png"), loc, tgt, lens)
    if arg("--no-export") is None:
        report = EX.build_lods(
            bpy.data.objects["LOD0"], col,
            cabin_keep=("Cockpit", "CabinLining", "Cabin_interior_dark", "Cabin_panel", "Cabin_seat_frame",
                        "Cabin_glareshield", "Cabin_seat_cushion", "Displays_static"),
            drop1=("Antennas", "Lens_", "Eye", "NoseWell", "MainWell_", "Ports", "SpeedbrakeWell",
                   "NozzleInner", "Ducts"),
            ratio1=lod1_ratio, ratio2=0.16,
            lod2_movable=("MainGear_L", "MainGear_R", "NoseGear", "Canopy", "Hook"), lod2_ratio=0.25)
        print("triangles per LOD:", report)
        raw = os.path.join(BUILD, "fa18_raw.glb")
        EX.export_glb(raw, image_quality=88)
        print("exported", raw, os.path.getsize(raw) // 1024, "KB")
        if arg("--fast") is None or arg("--optimize") is not None:
            subprocess.run(["node", os.path.join(ROOT, "tools", "aircraft", "optimize.mjs"), raw,
                            os.path.join(ROOT, "public", "assets", "aircraft", "fa18.glb"), "3.5"],
                           cwd=ROOT, check=True, shell=os.name == "nt")
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BUILD, "fa18.blend"))


if __name__ == "__main__":
    main()
