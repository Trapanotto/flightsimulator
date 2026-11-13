"""
Cessna 172S Skyhawk SP dimensions in the design frame (BL left+, FS aft+ from the front face
of the firewall, WL above the ground standing on the gear), metres.

Published figures (172S POH / Type Certificate 3A12): span 36 ft 1 in (11.00 m), length
27 ft 2 in (8.28 m), height 8 ft 11 in (2.72 m), wing NACA 2412 with 1.5 deg incidence at the
root and -1.5 deg at the tip, dihedral 1 deg 44 min, root chord 64.4 in, tip chord 44 in,
main gear track 8 ft 4 in, wheelbase 65 in, propeller McCauley 76 in, 6.00-6 main tyres,
5.00-5 nose tyre, CG range 35-47.3 in aft of datum (datum = firewall front face).
The rest (fuselage lines, tail) is read off three-view drawings and is approximate.
"""

import math

INCH = 0.0254

# Reference point = centre of gravity at a typical loading (FS 41 in), on the thrust line.
REF_FS = 41.0 * INCH          # 1.041
REF_WL = 1.22
REF_BL = 0.0

SPAN = 11.00
LENGTH = 8.28
HEIGHT = 2.72

# Propeller and spinner
PROP_AXIS_WL = 1.24
PROP_RADIUS = 76 * INCH / 2   # 0.965
PROP_FS = -0.86
SPINNER_TIP_FS = -1.05        # front end of the aircraft
SPINNER_BASE_FS = -0.79
SPINNER_R = 0.20

TAIL_END_FS = SPINNER_TIP_FS + LENGTH   # rudder trailing edge, 7.23

# Wing
WING_ROOT_LE_FS = 0.62
ROOT_CHORD = 64.4 * INCH      # 1.636
TIP_CHORD = 44.0 * INCH       # 1.118
WING_TE_FS = WING_ROOT_LE_FS + ROOT_CHORD
PANEL_BREAK_BL = 2.54         # outboard of here the leading edge tapers back
WING_ROOT_BL = 0.56           # side of the cabin roof, dihedral starts here
TIP_BL = 5.30                 # end of the lofted panel; the tip fairing reaches SPAN/2
WING_WL = 1.985               # chord line at the quarter chord, root
DIHEDRAL = math.radians(1 + 44 / 60)
INCIDENCE_ROOT = math.radians(1.5)
INCIDENCE_TIP = math.radians(-1.5)
FLAP_BL = (0.585, 2.74)
AILERON_BL = (2.78, 5.10)
WING_FOIL = (0.02, 0.4, 0.12)     # NACA 2412

# Rear spar / cove: the upper skin overhangs as the flap shroud.
WING_BOX_UPPER = 0.745
WING_BOX_LOWER = 0.70
WING_SURFACE_NOSE = 0.712

# Horizontal tail (span 11 ft 4 in)
HSTAB_HALF = 3.45 / 2
HSTAB_WL = 1.175
HSTAB_ROOT_LE = 5.98
HSTAB_ROOT_CHORD = 1.20
HSTAB_TIP_LE = 6.172      # keeps the elevator hinge line straight
HSTAB_TIP_CHORD = 0.86
HSTAB_HORN_BL = 1.47          # outboard of here the elevator reaches the leading edge
HSTAB_FOIL = (0.0, 0.3, 0.10)
ELEV_NOSE = 0.565
ELEV_INNER_BL = 0.075

# Fin and rudder
FIN_ROOT_WL = 1.38
FIN_TOP_WL = 2.60
FIN_ROOT_LE = 5.70
FIN_TOP_LE = 6.55
FIN_ROOT_CHORD = 1.53         # to the rudder trailing edge
FIN_TOP_CHORD = 0.68
FIN_FOIL = (0.0, 0.3, 0.09)
RUDDER_NOSE = 0.66
RUDDER_HORN_WL = 2.36         # above here the rudder reaches the fin's leading edge
RUDDER_BOTTOM_WL = 1.24
STERN_POST_FS = 6.70

# Landing gear
MAIN_TRACK = 100 * INCH       # 2.54
MAIN_AXLE_FS = 58 * INCH      # 1.473
MAIN_TYRE_R = 0.215
MAIN_TYRE_W = 0.15
NOSE_AXLE_FS = -7 * INCH      # -0.178
NOSE_TYRE_R = 0.180
NOSE_TYRE_W = 0.125

# Cabin
PANEL_FS = 0.40
EYE = (0.27, 1.06, 1.72)      # BL, FS, WL of the pilot's eye (left seat)
