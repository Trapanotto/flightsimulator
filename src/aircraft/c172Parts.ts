/**
 * Naming convention of the Cessna 172 model (written by tools/aircraft/build_c172.py, which
 * documents the same list). The loader finds every moving part by these names; a test checks
 * that the .glb contains all of them.
 *
 * Pivots have an identity rest rotation and carry their hinge axis in the model frame as
 * extras (`userData.axis`); a positive angle about it is the positive direction named here.
 */

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

/** Cockpit controls (LOD0 only). */
export const COCKPIT_PIVOTS = [
  'Yoke_L', // slides towards the pilot (extras.slide at full back pressure)
  'Yoke_R',
  'YokeRoll_L', // turns clockwise as seen from the seat
  'YokeRoll_R',
  'Pedals_L', // slide forward (extras.slide at full pedal)
  'Pedals_R',
  'Throttle', // slide out of the panel (extras.slide at lever 0)
  'Mixture',
  'FlapLever', // slides down its slot (extras.slide at flaps 1)
  'TrimWheel', // nose up
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
  'Needle_FLAPS',
  'AI_Roll',
  'HI_Card',
  'TC_Plane',
  'TC_Ball',
  'Compass_Card',
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
  'FUELL',
  'FUELR',
  'OILT',
  'OILP',
  'EGT',
  'VAC',
  'CLOCK',
  'FLAPS',
] as const;
export type FaceId = (typeof FACES)[number];

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
] as const;

export function allExpectedNodes(): string[] {
  return [
    ...EXTERIOR_PIVOTS,
    ...EXTERIOR_PIVOTS.map((n) => `${n}_lod1`),
    ...COCKPIT_PIVOTS,
    ...GAUGE_PIVOTS,
    ...FACES.map((f) => `Face_${f}`),
    ...SPECIAL_NODES,
  ];
}
