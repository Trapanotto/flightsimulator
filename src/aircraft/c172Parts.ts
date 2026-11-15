/**
 * Naming convention of the Cessna 172 model (written by tools/aircraft/build_c172.py and
 * tools/aircraft/c172/controls.py, which document the same lists). The loader finds every
 * moving part by these names; a test checks that the .glb contains all of them.
 *
 * Pivots have an identity rest rotation and carry their hinge axis in the model frame as
 * extras (`userData.axis`); a positive angle about it is the positive direction named here.
 */
import { C172_CONTROLS } from '@sim';
import { type V3, designBox } from './picking';

/** Movable parts in LOD0 (LOD1 has the same ones with the suffix `_lod1`). */
export const EXTERIOR_PIVOTS = [
  'Prop', // engine rotation
  'Aileron_L', // trailing edge down
  'Aileron_R',
  'Flap_L', // trailing edge down, slides aft (extras.slide)
  'Flap_R',
  'Elevator', // trailing edge up
  'TrimTab', // trailing edge up
  'Rudder', // trailing edge right
  'NoseSteer', // nose wheel turns right
  'Wheel_N', // rolling forward
  'Wheel_L',
  'Wheel_R',
] as const;

/** Yoke and pedals (LOD0 only). */
export const COCKPIT_PIVOTS = [
  'Yoke_L', // slides towards the pilot (extras.slide at full back pressure)
  'Yoke_R',
  'YokeRoll_L', // turns clockwise as seen from the seat
  'YokeRoll_R',
  'Pedals_L', // slide forward (extras.slide at full pedal)
  'Pedals_R',
] as const;

/** Instrument pivots: extras.axis points out of the dial towards the pilot. */
export const GAUGE_PIVOTS = [
  'Needle_ASI',
  'Needle_ALT100',
  'Needle_ALT1000',
  'Needle_ALT10000',
  'Needle_VSI',
  'Needle_TACH',
  'Needle_FUELL',
  'Needle_FUELR',
  'Needle_OILT',
  'Needle_OILP',
  'Needle_EGT',
  'Needle_VAC',
  'Needle_AMP',
  'Needle_FF',
  'Needle_FLAPS',
  'Needle_ADF',
  'AI_Roll',
  'HI_Card',
  'HI_Bug',
  'TC_Plane',
  'TC_Ball',
  'Compass_Card',
  'CDI1_Card',
  'CDI1_Needle',
  'CDI1_GS',
  'CDI1_ToFrom', // also slides away (extras.slide) without a signal
  'CDI2_Card',
  'CDI2_Needle',
  'CDI2_ToFrom',
] as const;

/** Warning flags: extras.slide moves them out of sight behind the bezel. */
export const FLAGS = [
  'AI_Flag',
  'HI_Flag',
  'TC_Flag',
  'CDI1_NavFlag',
  'CDI1_GsFlag',
  'CDI2_NavFlag',
] as const;

/** Dial faces with square UVs that the loader paints (see dials.ts). */
export const FACES = [
  'ASI',
  'AI',
  'ALT',
  'TC',
  'HI',
  'VSI',
  'TACH',
  'CDI1',
  'CDI2',
  'ADF',
  'FUELL',
  'FUELR',
  'OILT',
  'OILP',
  'EGT',
  'VAC',
  'AMP',
  'FF',
  'FLAPS',
] as const;
export type FaceId = (typeof FACES)[number];
/** Faces that turn with a pivot; the others are merged into one mesh at load. */
export const TURNING_FACES: readonly FaceId[] = ['AI', 'HI', 'CDI1', 'CDI2'];

/** Display windows (`Disp_<id>`): painted at runtime into one canvas atlas (displays.ts). */
export const DISPLAYS = [
  'GPS',
  'COM1',
  'NAV1',
  'COM2',
  'NAV2',
  'ADF',
  'DME',
  'XPDR',
  'MKR',
  'AP',
  'ANN',
  'KOLL',
] as const;
export type DisplayId = (typeof DISPLAYS)[number];

/** Other nodes the loader needs. */
export const SPECIAL_NODES = [
  'LOD0',
  'LOD1',
  'LOD2',
  'Cockpit',
  'Eye',
  'PropBlades',
  'PropDisc',
  'PropDisc_lod2',
  'Prop_lod2',
  'Glass',
  'AI_Pitch',
  'Face_COMPASS',
  'Glow_Nav_L',
  'Glow_Nav_R',
  'Glow_Tail',
  'Glow_Beacon',
  'Glow_Strobe_L',
  'Glow_Strobe_R',
  'Glow_Landing',
  'Glow_Taxi',
  'Labels',
  'TrimInd',
  'XpdrDigit_0',
  'XpdrDigit_1',
  'XpdrDigit_2',
  'XpdrDigit_3',
] as const;

/** The node of a cockpit control. */
export const controlNode = (id: string) => `Ctl_${id}`;
/** Dual concentric knobs: the outer ring (coarse) has its own node. */
export const DUAL_KNOBS = [
  'com1Standby',
  'com2Standby',
  'nav1Standby',
  'nav2Standby',
  'adfFrequency',
  'apAltitude',
] as const;

export function allExpectedNodes(): string[] {
  return [
    ...EXTERIOR_PIVOTS,
    ...EXTERIOR_PIVOTS.map((n) => `${n}_lod1`),
    ...COCKPIT_PIVOTS,
    ...GAUGE_PIVOTS,
    ...FLAGS,
    ...FACES.map((f) => `Face_${f}`),
    ...DISPLAYS.map((d) => `Disp_${d}`),
    ...SPECIAL_NODES,
    ...C172_CONTROLS.map((c) => controlNode(c.id)),
    ...DUAL_KNOBS.map((id) => `${controlNode(id)}_outer`),
    ...C172_CONTROLS.map((c) => `Hit_${c.id}`),
  ];
}

/**
 * Reference point of the design frame in the model frame: model = (BL, WL - 1.22, 1.041 - FS)
 * (tools/aircraft/c172/dims.py).
 */
const boxFromDesign = (lo: [number, number, number], hi: [number, number, number]) =>
  designBox(lo, hi, { fs: 1.041, wl: 1.22 });

/** Where a camera counts as sitting in the cabin (front and rear seats), model frame. */
export const CABIN = boxFromDesign([-0.62, 0.3, 0.82], [0.62, 2.6, 1.98]);

/** Seats (cushions and backs) and the glareshield: nothing is reached through them. */
export const OCCLUDERS: readonly { center: V3; half: V3 }[] = [
  ...[0.27, -0.27].flatMap((bl) => [
    // Inset by the cushions' rounded edges.
    boxFromDesign([bl - 0.2, 0.89, 0.97], [bl + 0.2, 1.34, 1.08]),
    boxFromDesign([bl - 0.23, 1.34, 1.1], [bl + 0.23, 1.52, 1.76]),
  ]),
  boxFromDesign([-0.6, 0.0, 1.508], [0.6, 0.39, 1.6]),
];
