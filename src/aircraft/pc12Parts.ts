/**
 * Naming convention of the PC-12 model (written by tools/aircraft/build_pc12.py and
 * tools/aircraft/pc12/, which document the same lists), and the plain maths of its moving
 * parts: the gear's retraction sequence and the propeller's blade angle. Tested in Node.
 */
import { type EngineTelemetry, PC12_CONTROLS } from '@sim';
import { designBox, type V3 } from './picking';

/** Movable parts in LOD0 (LOD1 has the same ones with the suffix `_lod1`). */
export const EXTERIOR_PIVOTS = [
  'Prop', // engine rotation
  'Blade_0', // blade pitch: positive = coarser (extras.buildDeg is the modelled angle)
  'Blade_1',
  'Blade_2',
  'Blade_3',
  'Blade_4',
  'Aileron_L', // trailing edge down
  'Aileron_R',
  'Flap_L', // trailing edge down, slides aft (extras.slide)
  'Flap_R',
  'Stabilizer', // leading edge down (nose-up trim)
  'Elevator', // trailing edge up
  'Rudder', // trailing edge right
  'MainGear_L', // retracts (extras.retractDeg)
  'MainGear_R',
  'MainArm_L', // axle up: the strut compresses (extras.strokeDeg to hang free)
  'MainArm_R',
  'MainDoor_L', // opens (extras.openDeg)
  'MainDoor_R',
  'NoseGear', // retracts aft (extras.retractDeg)
  'NoseSteer', // nose wheel turns right
  'NoseDoor_L', // opens (extras.openDeg)
  'NoseDoor_R',
  'Wheel_N', // rolling forward
  'Wheel_L',
  'Wheel_R',
] as const;

/** The nose leg's oleo slides (extras.slide = axle travel when hanging free). */
export const SLIDING_PIVOTS = ['NoseOleo', 'Flap_L', 'Flap_R'] as const;

/** Yokes, pedals (LOD0 only, as on the Cessna). */
export const COCKPIT_PIVOTS = [
  'Yoke_L',
  'Yoke_R',
  'YokeRoll_L',
  'YokeRoll_R',
  'Pedals_L',
  'Pedals_R',
] as const;

/**
 * The glass cockpit's windows (`Disp_<id>`): the four big displays and the small windows of
 * the radio panel, the standby instrument, the gear indicator and the flight guidance panel.
 */
export const DISPLAYS = ['PFD1', 'MFD1', 'MFD2', 'PFD2'] as const;
export type DisplayId = (typeof DISPLAYS)[number];
export const PANEL_WINDOWS = [
  'COM1',
  'NAV1',
  'COM2',
  'NAV2',
  'ADF',
  'DME',
  'XPDR',
  'STBY',
  'GEAR',
  'FGP',
  'TRIM',
] as const;
export type PanelWindow = (typeof PANEL_WINDOWS)[number];

/** Lamp glows by kind (anchors `Glow_<kind>`). */
export const GLOWS = [
  'Nav_L',
  'Nav_R',
  'Tail',
  'Beacon',
  'Strobe_L',
  'Strobe_R',
  'Recog_L',
  'Recog_R',
  'Landing_L',
  'Landing_R',
  'Taxi',
  'Ice',
] as const;

/** Other nodes the loader needs. */
export const SPECIAL_NODES = [
  'LOD0',
  'LOD1',
  'LOD2',
  'Cockpit',
  'Eye',
  'PropDisc',
  'PropDisc_lod2',
  'Prop_lod2',
  'Glass',
  'Labels',
  'MainGear_L_lod2',
  'MainGear_R_lod2',
  'NoseGear_lod2',
] as const;

export const controlNode = (id: string) => `Ctl_${id}`;

/** Dual concentric knobs: the outer ring (coarse) has its own node. */
export const DUAL_KNOBS: Readonly<Record<string, { coarse: number; radio: boolean }>> = {
  com1Standby: { coarse: 1000, radio: true },
  com2Standby: { coarse: 1000, radio: true },
  nav1Standby: { coarse: 1000, radio: true },
  nav2Standby: { coarse: 1000, radio: true },
  adfFrequency: { coarse: 100, radio: false },
  apAltitude: { coarse: 1000, radio: false },
};

export function allExpectedNodes(): string[] {
  return [
    ...EXTERIOR_PIVOTS,
    ...EXTERIOR_PIVOTS.map((n) => `${n}_lod1`),
    ...SLIDING_PIVOTS,
    ...COCKPIT_PIVOTS,
    ...DISPLAYS.map((d) => `Disp_${d}`),
    ...PANEL_WINDOWS.map((d) => `Disp_${d}`),
    ...GLOWS.map((g) => `Glow_${g}`),
    ...SPECIAL_NODES,
    ...PC12_CONTROLS.map((c) => controlNode(c.id)),
    ...Object.keys(DUAL_KNOBS).map((id) => `${controlNode(id)}_outer`),
    ...PC12_CONTROLS.map((c) => `Hit_${c.id}`),
  ];
}

// ---- cabin and occluders ------------------------------------------------------------------

/** Design frame -> model frame: the reference point (CG) at FS 5.95, WL 1.78 (pc12/dims.py). */
const box = (lo: [number, number, number], hi: [number, number, number]) =>
  designBox(lo, hi, { fs: 5.95, wl: 1.78 });

/** Where a camera counts as sitting in the cockpit or the cabin, model frame. */
export const CABIN = box([-0.8, 2.95, 1.0], [0.8, 9.4, 2.62]);

/** Seats (cushions and backs) and the glareshield: nothing is reached through them. */
export const OCCLUDERS: readonly { center: V3; half: V3 }[] = [
  ...[0.36, -0.36].flatMap((bl) => [
    box([bl - 0.2, 4.0, 1.3], [bl + 0.2, 4.45, 1.44]),
    box([bl - 0.23, 4.48, 1.46], [bl + 0.23, 4.62, 2.1]),
  ]),
];

// ---- the gear --------------------------------------------------------------------------------

export interface GearPose {
  /** Main legs: 0 retracted .. 1 down and locked. */
  main: number;
  /** Nose leg: 0 retracted .. 1 down and locked. */
  nose: number;
  /** Inboard main-wheel doors: 0 closed .. 1 open. */
  mainDoors: number;
  /** Nose doors: 0 closed .. 1 open. */
  noseDoors: number;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * Where every part of the gear is for `telemetry.gear` (0 up .. 1 down): the doors open
 * before the legs move and the main doors close again once the legs are locked (up or down);
 * the nose doors are linked to the leg and stay open while it is down. The legs move in the
 * middle of the travel, the nose leg a little behind the mains.
 */
export function gearSequence(gear: number): GearPose {
  const g = Math.min(Math.max(gear, 0), 1);
  return {
    main: smooth(0.12, 0.86, g),
    nose: smooth(0.15, 0.84, g),
    mainDoors: Math.min(smooth(0.0, 0.1, g), 1 - smooth(0.9, 1.0, g)),
    noseDoors: smooth(0.0, 0.12, g),
  };
}

/**
 * The three greens light once the legs are down and locked; the red stays on while anything
 * moves, the doors included (so for a moment after locking down both show).
 */
export function gearLights(gear: number): { down: boolean; transit: boolean } {
  const p = gearSequence(gear);
  const down = p.main >= 0.999 && p.nose >= 0.999;
  const up = p.main <= 0.001 && p.nose <= 0.001;
  const doorsShut = p.mainDoors <= 0.001;
  return { down, transit: !(down || up) || !doorsShut };
}

// ---- the propeller ---------------------------------------------------------------------------

/** Blade angles at 0.75 R (degrees) of the Hartzell HC-E5A-3A on the PT6A-67P. */
export const BLADE = { feather: 86, fine: 12, reverse: -11, coarse: 52 } as const;

/**
 * The blade angle the governor and the beta system hold: feathered with the engine stopped,
 * reverse when selected, the fine stop at idle on the ground, and coarser as the airspeed and
 * the power rise (the governor keeps the propeller's rpm).
 */
export function bladeAngle(e: EngineTelemetry | undefined, tasMs: number): number {
  if (!e) return BLADE.feather;
  if (e.reversing) return BLADE.reverse;
  if (!e.running && !e.starting && (e.propRpm ?? e.rpm) < 600) return BLADE.feather;
  const speed = Math.min(Math.max(tasMs / 140, 0), 1);
  const power = Math.min(Math.max(e.torque ?? e.power, 0), 1.1);
  return Math.min(BLADE.fine + 34 * speed + 7 * power * (0.3 + speed), BLADE.coarse);
}
