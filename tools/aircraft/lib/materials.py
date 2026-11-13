"""
Materials (Principled BSDF -> glTF metallic-roughness). The game's loader recognises some of
them by name (see the naming convention in build_c172.py); the rest load as they are.
"""

import bpy


def srgb(*c):
    """Colour as on a colour picker (sRGB) -> linear, which Blender and glTF store."""
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


def principled(name, color, rough=0.5, metal=0.0, alpha=1.0, emission=None, strength=0.0,
               coat=0.0, coat_rough=0.05, double_sided=False):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*srgb(*color), 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        mat.surface_render_method = "BLENDED"
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*srgb(*emission), 1.0)
        bsdf.inputs["Emission Strength"].default_value = strength
    if coat > 0:
        bsdf.inputs["Coat Weight"].default_value = coat
        bsdf.inputs["Coat Roughness"].default_value = coat_rough
    mat.use_backface_culling = not double_sided
    mat.diffuse_color = (*srgb(*color), alpha)
    return mat


def make_all():
    m = {}
    # Exterior paint: base colour, normal and ORM come from the baked atlas (bake.py).
    m["paint"] = principled("Paint", (0.93, 0.93, 0.91), 0.3, coat=1.0, coat_rough=0.06)
    m["glass"] = principled("Glass", (0.42, 0.47, 0.5), 0.03, alpha=0.25, double_sided=True)
    m["seal"] = principled("Seal", (0.05, 0.05, 0.055), 0.7, double_sided=True)
    m["intake"] = principled("Intake", (0.02, 0.02, 0.022), 0.85)
    m["metal"] = principled("BareMetal", (0.8, 0.81, 0.82), 0.22, 1.0)
    m["chrome"] = principled("Chrome", (0.9, 0.9, 0.92), 0.08, 1.0)
    m["steel"] = principled("Steel", (0.45, 0.46, 0.47), 0.4, 1.0)
    m["exhaust"] = principled("Exhaust", (0.25, 0.2, 0.17), 0.55, 0.8)
    m["gear_paint"] = principled("GearPaint", (0.9, 0.9, 0.88), 0.35, coat=0.6)
    m["tire"] = principled("Tire", (0.035, 0.035, 0.037), 0.82)
    m["prop_front"] = principled("PropFront", (0.55, 0.56, 0.57), 0.35, 0.9)
    m["prop_back"] = principled("PropBack", (0.03, 0.03, 0.035), 0.75)
    m["prop_tip"] = principled("PropTip", (0.95, 0.95, 0.93), 0.4)
    m["prop_disc"] = principled("PropDisc", (0.1, 0.1, 0.1), 0.6, alpha=0.2, double_sided=True)
    m["antenna"] = principled("Antenna", (0.1, 0.1, 0.11), 0.5)
    m["lens"] = principled("LightLens", (0.85, 0.88, 0.9), 0.05, alpha=0.35, double_sided=True)
    # Lamps: emissive, the loader drives their brightness from the light state.
    m["nav_red"] = principled("Lamp_NavRed", (0.9, 0.05, 0.05), 0.3, emission=(1, 0.04, 0.03), strength=2)
    m["nav_green"] = principled("Lamp_NavGreen", (0.05, 0.85, 0.3), 0.3, emission=(0.1, 1, 0.45), strength=2)
    m["nav_white"] = principled("Lamp_NavWhite", (0.9, 0.9, 0.9), 0.3, emission=(1, 1, 0.95), strength=2)
    m["beacon"] = principled("Lamp_Beacon", (0.85, 0.05, 0.04), 0.3, emission=(1, 0.05, 0.02), strength=2)
    m["strobe"] = principled("Lamp_Strobe", (0.85, 0.87, 0.9), 0.2, emission=(0.9, 0.95, 1), strength=2)
    m["landing"] = principled("Lamp_Landing", (0.9, 0.9, 0.85), 0.1, emission=(1, 0.95, 0.85), strength=2)
    # Cabin
    m["interior"] = principled("Interior", (0.58, 0.56, 0.52), 0.7)
    m["interior_dark"] = principled("InteriorDark", (0.17, 0.17, 0.18), 0.65)
    m["panel"] = principled("Panel", (0.13, 0.135, 0.14), 0.55)
    m["glareshield"] = principled("Glareshield", (0.03, 0.03, 0.032), 0.95, double_sided=True)
    m["fabric"] = principled("Fabric", (0.24, 0.22, 0.2), 0.95)
    m["leather"] = principled("Leather", (0.42, 0.33, 0.25), 0.55)
    m["carpet"] = principled("Carpet", (0.16, 0.15, 0.15), 1.0, double_sided=True)
    m["plastic_black"] = principled("PlasticBlack", (0.04, 0.04, 0.045), 0.45)
    m["knob_red"] = principled("KnobRed", (0.6, 0.04, 0.03), 0.4)
    m["placard"] = principled("Placard", (0.75, 0.75, 0.72), 0.5)
    m["screen"] = principled("Screen", (0.02, 0.03, 0.035), 0.15)
    # Instruments: faces are drawn by the game (canvas atlas), needles are geometry.
    m["gauge_face"] = principled("GaugeFace", (0.05, 0.05, 0.05), 0.6)
    m["gauge_bezel"] = principled("GaugeBezel", (0.03, 0.03, 0.032), 0.5)
    m["needle"] = principled("Needle", (0.95, 0.95, 0.93), 0.5)
    m["needle_orange"] = principled("NeedleOrange", (1.0, 0.45, 0.05), 0.5)
    m["gauge_glass"] = principled("GaugeGlass", (0.1, 0.1, 0.1), 0.03, alpha=0.08)
    m["ai_card"] = principled("AICard", (0.2, 0.4, 0.7), 0.6)
    return m
