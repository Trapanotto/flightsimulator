"""
Pilatus PC-12 NG dimensions in the design frame (BL left+, FS aft+ from the spinner tip, WL
above the ground standing on the gear), metres.

Published figures (Pilatus PC-12 NG information manual and type certificate data sheet
EASA.A.089): length 14.40 m, span 16.28 m (with winglets), height 4.26 m, wing area
25.81 m^2, PT6A-67P with a Hartzell five-blade propeller of 2.67 m diameter, cabin 5.16 m
long, 1.52 m wide and 1.47 m high, cargo door 1.32 m x 1.35 m, main gear track 4.5 m,
wheelbase about 3.6 m. Fuselage lines, wing planform and the tail are read off three-view
drawings and photographs and are approximate.
"""

import math

# Reference point = centre of gravity at a typical loading (about 25 % MAC), on the thrust
# line height. The model's origin.
REF_FS = 5.95
REF_WL = 1.78
REF_BL = 0.0

LENGTH = 14.40
SPAN = 16.28
HEIGHT = 4.26

# Propeller and spinner (Hartzell HC-E5A-3A, 105 in)
PROP_AXIS_WL = 1.78
PROP_RADIUS = 2.67 / 2
PROP_FS = 0.50
SPINNER_TIP_FS = 0.0
SPINNER_BASE_FS = 0.64
SPINNER_R = 0.255
BLADES = 5
# Blade angle at 0.75 R in which the blade is modelled; the loader turns it from there.
BLADE_BUILD_DEG = 20.0

FIREWALL_FS = 2.78
TAIL_END_FS = LENGTH              # rudder trailing edge, bottom

# Wing: low wing, straight taper, dihedral from the fuselage side.
WING_ROOT_BL = 0.80
WING_ROOT_LE_FS = 5.12
ROOT_CHORD = 2.12
TIP_CHORD = 1.06
TIP_BL = 7.92                     # end of the lofted panel; the winglet stands on it
WING_TE_ROOT_FS = WING_ROOT_LE_FS + ROOT_CHORD
LE_SWEEP_FS = 0.80                # leading edge moves aft this much from root to tip
WING_WL = 1.03                    # chord line at the root
DIHEDRAL = math.radians(6.0)
INCIDENCE_ROOT = math.radians(2.0)
INCIDENCE_TIP = math.radians(-1.0)
ROOT_TC = 0.17
TIP_TC = 0.13
CAMBER = 0.02
FLAP_BL = (0.86, 4.92)
AILERON_BL = (5.02, 7.62)
WING_BOX_UPPER = 0.735
WING_BOX_LOWER = 0.70
WING_SURFACE_NOSE = 0.705
FLAP_DEG = 40.0
FLAP_SLIDE = 0.30                 # metres aft along the tracks at full flap
WINGLET_H = 0.44
WINGLET_CANT = math.radians(18)   # outward lean from vertical

# T-tail
HSTAB_HALF = 2.60
HSTAB_WL = 4.06
HSTAB_ROOT_LE = 12.78
HSTAB_ROOT_CHORD = 1.42
HSTAB_TIP_LE = 13.30
HSTAB_TIP_CHORD = 0.82
ELEV_NOSE = 0.64
ELEV_HORN_BL = 2.30
# The whole stabiliser trims (PC-12: trimmable horizontal stabiliser), about its hinge.
HSTAB_TRIM_FS = 13.30
STAB_TRIM_UP_DEG = 2.0
STAB_TRIM_DN_DEG = 6.0

# Fin and rudder
FIN_ROOT_WL = 2.30
FIN_TOP_WL = 4.02
FIN_ROOT_LE = 11.10
FIN_TOP_LE = 12.72
FIN_ROOT_CHORD = 3.28             # to the rudder trailing edge
FIN_TOP_CHORD = 1.55
RUDDER_NOSE = 0.66
RUDDER_BOTTOM_WL = 1.92

# Landing gear (trailing link, main legs retract inwards into the wing root, nose leg aft into
# a well under the pedestal). Positions with the aircraft standing on its gear (struts
# compressed).
MAIN_TRACK = 4.48
MAIN_AXLE_FS = 6.32
MAIN_TYRE_R = 0.325
MAIN_TYRE_W = 0.20
MAIN_WHEEL_OFFSET = 0.18          # wheel centre outboard of the leg
MAIN_PIVOT_FS = 6.12
MAIN_PIVOT_WL = 1.24
MAIN_KNEE_WL = 0.62
MAIN_RETRACT_DEG = 90.0
NOSE_AXLE_FS = 2.45
NOSE_TYRE_R = 0.225
NOSE_TYRE_W = 0.15
NOSE_PIVOT_FS = 2.25
NOSE_PIVOT_WL = 1.18
NOSE_RETRACT_DEG = 92.0
# Strut travel from standing on the ground to hanging free (m at the axle).
MAIN_STROKE = 0.07
NOSE_STROKE = 0.06

# Cabin and cockpit
PANEL_FS = 3.42
EYE = (0.36, 4.06, 2.27)          # BL, FS, WL of the pilot's eye (left seat)
SEAT_BL = 0.36
COCKPIT_FLOOR_WL = 1.10
