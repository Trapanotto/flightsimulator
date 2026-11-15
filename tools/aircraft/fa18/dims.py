"""
McDonnell Douglas F/A-18C Hornet (Swiss Air Force) dimensions in the design frame (BL left+, FS
aft+ from the radome tip, WL above the ground standing on the gear), metres.

Published figures (NATOPS flight manual A1-F18AC-NFM-000, Boeing fact sheet): length 17.07 m,
span 11.43 m over the wing-tip launch rails (12.31 m with tip missiles), height 4.66 m over the
fins, wing area 37.16 m^2 (aspect ratio 3.5, taper 0.35, 26.7 degrees leading-edge sweep, 3
degrees anhedral, 5 % thick at the root and 3.5 % at the tip), main gear track 3.11 m,
wheelbase 5.42 m, fins canted outward 20 degrees, two F404-GE-402. Fuselage lines, the LEX
outline, intakes, the canopy and the tail are read off three-view drawings and photographs
and are approximate.
"""

import math

# Reference point = centre of gravity (about 22 % of the mean aerodynamic chord), the model's
# origin.
REF_FS = 8.70
REF_WL = 2.00
REF_BL = 0.0

LENGTH = 17.07
SPAN = 11.43
HEIGHT = 4.66

# Wing: trapezoid over the theoretical root at the centre line.
WING_ROOT_LE_FS = 6.60
WING_ROOT_CHORD = 4.82
WING_TIP_CHORD = 1.69
WING_TIP_BL = 5.45                 # end of the wing; the launch rail sits outside it
LE_SWEEP = math.radians(26.7)
ANHEDRAL = math.radians(3.0)
WING_WL = 2.245                    # chord plane at the centre line
ROOT_TC = 0.05
TIP_TC = 0.035
LEF_X = 0.17                       # leading-edge flap hinge, share of the chord
TEF_X = 0.76                       # trailing-edge flap and aileron hinge (nose of the surface)
TEF_BL = (1.30, 3.22)
FOLD_BL = 3.28                     # wing fold line
AIL_BL = (3.34, 5.20)
LEF_BL = (1.95, WING_TIP_BL - 0.02)
RAIL_BL = (5.45, 5.715)            # wing-tip launch rail (LAU-7 type), no missile

# LEX (leading-edge extension) and fuselage key stations
WINDSCREEN_FS = 3.38
CANOPY_BOW_FS = 4.15
CANOPY_END_FS = 6.28
CANOPY_HINGE = (6.32, 2.86)        # FS, WL of the aft hinge
CANOPY_OPEN_DEG = 48.0
INTAKE_LIP_FS = 6.45

# Engines: two F404 side by side; the nozzle hinge ring and the exit.
ENGINE_BL = 0.56
ENGINE_WL = 1.93
NOZZLE_HINGE_FS = 16.12
NOZZLE_LEN = 0.62
NOZZLE_HINGE_R = 0.425
NOZZLE_EXIT_MIN = 0.32             # closed down at military power
NOZZLE_EXIT_MAX = 0.47             # wide open in afterburner
NOZZLE_EXIT_BUILD = 0.40           # modelled opening (about idle)

# Vertical tails: canted outward 20 degrees, rudders on the lower trailing edge.
FIN_CANT = math.radians(20.0)
FIN_ROOT_BL = 1.04
FIN_ROOT_WL = 2.40
FIN_ROOT_LE = 11.30
FIN_ROOT_CHORD = 3.05
FIN_SPAN = 2.38                    # along the canted fin
FIN_LE_SWEEP = math.radians(36.0)
FIN_TIP_CHORD = 1.10
RUDDER_SPAN = (0.10, 1.25)         # along the fin from its root
RUDDER_X = 0.70

# Stabilators: all-moving, a little anhedral, the pivot near their root.
STAB_ROOT_BL = 1.05
STAB_TIP_BL = 3.30
STAB_ROOT_LE = 14.05
STAB_ROOT_CHORD = 2.62
STAB_TIP_CHORD = 0.98
STAB_LE_SWEEP = math.radians(42.8)
STAB_WL = 1.90
STAB_ANHEDRAL = math.radians(2.0)
STAB_PIVOT_FS = 15.30

# Speed brake on the spine between the fins.
SPEEDBRAKE_FS = (12.25, 13.55)
SPEEDBRAKE_HALF = 0.36
SPEEDBRAKE_DEG = 60.0

# Landing gear (standing on it, struts compressed).
MAIN_TRACK = 3.11
MAIN_AXLE_FS = 9.62
MAIN_TYRE_R = 0.385                # 30 x 11.5-14.5
MAIN_TYRE_W = 0.29
MAIN_PIVOT = (1.26, 9.22, 1.52)    # BL, FS, WL of the retraction pivot
MAIN_RETRACT_DEG = 88.0
MAIN_TWIST_DEG = 90.0
NOSE_AXLE_FS = 4.20
NOSE_TYRE_R = 0.28                 # 22 x 6.6-10
NOSE_TYRE_W = 0.165
NOSE_WHEEL_GAP = 0.125             # wheel centre either side of the strut
NOSE_PIVOT = (0.0, 4.44, 1.44)
NOSE_RETRACT_DEG = 92.0
MAIN_STROKE = 0.12
NOSE_STROKE = 0.10

# Arresting hook and launch bar.
HOOK_PIVOT = (0.0, 13.35, 1.40)
HOOK_LEN = 1.75
HOOK_DOWN_DEG = 62.0

# Cockpit
EYE = (0.0, 4.56, 2.84)            # BL, FS, WL of the pilot's eye
PANEL_FS = 3.72
SEAT_FS = 4.82
COCKPIT_FLOOR_WL = 2.02
