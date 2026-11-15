"""
Airbus A320-214 (CFM56-5B4) dimensions in the design frame (BL left+, FS aft+ from the nose
tip, WL above the ground standing on the gear), metres.

Published figures (Airbus A320 Aircraft Characteristics - Airport and Maintenance Planning):
length 37.57 m, span 34.10 m over the wing-tip fences, height 11.76 m, fuselage width 3.95 m
and height 4.14 m, wing area 122.6 m^2 with 25 degrees of sweep at the quarter chord, MAC
4.19 m, wheelbase 12.64 m, main gear track 7.59 m, horizontal stabiliser span 12.45 m, main
tyres 46 x 17 R20, nose tyres 30 x 8.8 R15, CFM56-5B fan diameter 1.735 m. Fuselage lines,
the nose, the planform kink and the nacelle shape are read off three-view drawings and
photographs and are approximate.
"""

import math

# Reference point = centre of gravity at 25 % MAC (LEMAC at FS 15.12), the model's origin.
REF_FS = 16.17
REF_WL = 3.20
REF_BL = 0.0

LENGTH = 37.57
SPAN = 34.10
HEIGHT = 11.76

# Fuselage: keel and crown of the constant section; 3.95 m wide, 4.14 m high.
KEEL_WL = 1.80
CROWN_WL = KEEL_WL + 4.14
HALF_WIDTH = 1.975
MID_WL = 3.97                      # widest point of the section
CYL_FS = (6.6, 27.4)               # constant section
TAIL_END_FS = 37.20                # end of the tail cone; the APU exhaust reaches 37.57

# Wing: straight leading edge, a trailing-edge kink at BL 6.4 (the inboard trailing edge runs
# almost straight across), 5.1 degrees of dihedral.
WING_ROOT_BL = 1.95
WING_ROOT_LE = 12.75
LE_SWEEP = math.radians(27.0)
KINK_BL = 6.40
TIP_BL = 16.90
ROOT_CHORD = 6.00
KINK_CHORD = 3.74
TIP_CHORD = 1.60
WING_WL = 2.62                     # chord line at the root
DIHEDRAL = math.radians(5.1)
INCIDENCE_ROOT = math.radians(2.5)
INCIDENCE_TIP = math.radians(-1.0)
ROOT_TC = 0.150
KINK_TC = 0.118
TIP_TC = 0.108
CAMBER = 0.015
# Spanwise breaks of the movables (|BL|).
SLATS = [(2.30, 5.10), (6.30, 8.90), (8.95, 11.55), (11.60, 14.20), (14.25, 16.70)]
SLAT_CHORD = 0.135                 # share of the local chord
SLAT_DEG = 27.0                    # at CONF FULL
SLAT_TRAVEL = 0.10                 # share of the local chord, forward and down
FLAP_IN = (2.00, 6.40)
FLAP_OUT = (6.40, 12.45)
AILERON = (12.55, 15.80)
FLAP_NOSE = 0.735                  # share of the chord where the flap's nose sits
AILERON_NOSE = 0.75
WING_BOX_UPPER = 0.80              # upper skin shroud over the flap nose
WING_BOX_LOWER = 0.72
FLAP_DEG = 40.0
FLAP_SLIDE = 0.22                  # share of the local chord aft along the tracks
SPOILERS = [(4.45, 6.20), (6.55, 7.95), (7.95, 9.35), (9.35, 10.75), (10.75, 12.20)]
SPOILER_X = (0.60, 0.78)
FLAP_TRACKS = [4.70, 8.35, 11.25]
FENCE_UP = 0.90
FENCE_DOWN = 0.55

# Engines (CFM56-5B): centre line under the wing, the fan 1.735 m across.
ENGINE_BL = 5.75
ENGINE_WL = 1.66
INLET_FS = 11.25
FAN_FS = 12.05
FAN_R = 0.865
FAN_EXIT_FS = 14.85
CORE_EXIT_FS = 15.95
PLUG_FS = 16.55
NACELLE_R = 1.08
REVERSER_FS = (13.55, 14.55)       # the four pivoting doors

# Horizontal stabiliser (trims) and fin.
HSTAB_ROOT_BL = 0.0
HSTAB_HALF = 6.225
HSTAB_WL = 4.70
HSTAB_ROOT_LE = 31.30
HSTAB_ROOT_CHORD = 3.90
HSTAB_TIP_CHORD = 1.35
HSTAB_SWEEP = math.radians(32.0)
HSTAB_DIHEDRAL = math.radians(6.0)
ELEV_NOSE = 0.70
THS_PIVOT_FS = 34.15
FIN_ROOT_WL = 5.60
FIN_TOP_WL = 11.62
FIN_ROOT_LE = 28.95
FIN_ROOT_CHORD = 6.30
FIN_TOP_CHORD = 2.05
FIN_SWEEP = math.radians(35.0)
RUDDER_NOSE = 0.68
RUDDER_BOTTOM_WL = 6.05

# Landing gear (standing on the gear, struts compressed). The mains retract inwards into the
# belly; the nose leg forward into its well under the cockpit.
MAIN_BL = 3.795                    # half the track
MAIN_AXLE_FS = 17.69
MAIN_PIVOT = (3.80, 17.45, 2.42)   # BL, FS, WL of the leg's pivot
MAIN_TYRE_R = 0.585
MAIN_TYRE_W = 0.43
MAIN_WHEEL_OFF = 0.465             # wheel centres either side of the leg
MAIN_STROKE = 0.22                 # axle travel from standing to hanging free
NOSE_AXLE_FS = 5.05
NOSE_PIVOT = (0.0, 5.32, 2.28)
NOSE_TYRE_R = 0.38
NOSE_TYRE_W = 0.225
NOSE_WHEEL_OFF = 0.19
NOSE_STROKE = 0.14

# Cockpit (captain's design eye position).
FLOOR_WL = 3.62
EYE = (0.53, 3.72, 4.83)
SEAT_BL = 0.53
