/**
 * Naming convention of the A320 model (written by tools/aircraft/build_a320.py and
 * tools/aircraft/a320/, which document the same lists), and the plain maths of its moving
 * parts: the gear's sequence, slats and flaps by configuration, the spoilers, the reversers,
 * the fan speed. Tested in Node.
 */
import { A320_CONTROLS, type EngineTelemetry } from '@sim';
import { type V3, designBox } from './picking';

/** Movable parts in LOD0 (LOD1 has the same ones with the suffix `_lod1`). */
export const EXTERIOR_PIVOTS = [
  'Slat_In_L', // slat 1: leading edge down on its arc track (extras.maxDeg)
  'Slat_In_R',
  'Slat_Out_L', // slats 2-5
  'Slat_Out_R',
  'FlapIn_L', // trailing edge down (extras.maxDeg), slides aft (extras.slide)
  'FlapIn_R',
  'FlapOut_L',
  'FlapOut_R',
  'Aileron_L', // trailing edge down
  'Aileron_R',
  'Spoiler1_L', // trailing edge up (extras.maxDeg)
  'Spoiler1_R',
  'Spoiler234_L',
  'Spoiler234_R',
  'Spoiler5_L',
  'Spoiler5_R',
  'Stabilizer', // leading edge down = nose-up trim
  'Elevator_L', // trailing edge up
  'Elevator_R',
  'Rudder', // trailing edge right
  'Fan_L', // engine rotation
  'Fan_R',
  'RevDoor_L0', // reverser doors: forward edge out (extras.openDeg)
  'RevDoor_L1',
  'RevDoor_L2',
  'RevDoor_L3',
  'RevDoor_R0',
  'RevDoor_R1',
  'RevDoor_R2',
  'RevDoor_R3',
  'MainGear_L', // retracts inwards (extras.retractDeg)
  'MainGear_R',
  'MainDoor_L', // opens in transit (extras.openDeg)
  'MainDoor_R',
  'NoseGear', // retracts forward
  'NoseSteer', // nose wheels turn right
  'NoseDoor_L',
  'NoseDoor_R',
  'Wheel_N', // rolling forward
  'Wheel_L',
  'Wheel_R',
] as const;

/** Oleos slide out when unloaded; the flaps run aft on their tracks. */
export const SLIDING_PIVOTS = [
  'MainOleo_L',
  'MainOleo_R',
  'NoseOleo',
  'FlapIn_L',
  'FlapIn_R',
  'FlapOut_L',
  'FlapOut_R',
] as const;

/** Sidesticks, tillers and pedals (LOD0 only). */
export const COCKPIT_PIVOTS = [
  'Sidestick_L',
  'Sidestick_R',
  'SidestickRoll_L',
  'SidestickRoll_R',
  'Tiller_L',
  'Tiller_R',
  'Pedals_L',
  'Pedals_R',
] as const;

/** The six display units, the standby instrument and the two MCDUs. */
export const DISPLAYS = [
  'PFD1',
  'ND1',
  'EWD',
  'SD',
  'ND2',
  'PFD2',
  'ISIS',
  'MCDU1',
  'MCDU2',
] as const;

/** Small windows of the panel atlas (FCU, EFIS, radios, transponder, gear lights, ECAM keys). */
export const PANEL_WINDOWS = [
  'FCU_SPD',
  'FCU_HDG',
  'FCU_ALT',
  'FCU_VS',
  'BARO1',
  'RMP1_COM',
  'RMP1_NAV',
  'RMP2_COM',
  'RMP2_NAV',
  'ADF',
  'ATC',
  'RUDTRIM',
  'GEARIND',
  'ECP',
] as const;
export type PanelWindow = (typeof PANEL_WINDOWS)[number];

/** Push buttons whose legends are drawn by state (`Disp_KY_<id>`). */
export const KEY_LEGENDS = [
  'fuelPumpsLeft',
  'fuelPumpsCenter',
  'fuelPumpsRight',
  'fuelCrossfeed',
  'hydGreen',
  'hydBlue',
  'hydYellow',
  'hydYellowElectric',
  'battery',
  'battery2',
  'externalPower',
  'generator1',
  'apuGenerator',
  'generator2',
  'pack1',
  'bleed1',
  'apuBleed',
  'crossbleed',
  'bleed2',
  'pack2',
  'wingAntiIce',
  'engineAntiIce1',
  'engineAntiIce2',
  'probeHeat',
  'apuMaster',
  'apuStart',
  'fcuLoc',
  'ap1',
  'ap2',
  'athr',
  'fcuExped',
  'fcuAppr',
  'flightDirector',
  'ls',
  'masterWarning',
  'masterCaution',
  'abLo',
  'abMed',
  'abMax',
] as const;
export type KeyLegend = (typeof KEY_LEGENDS)[number];

/** Lamp glows by kind (anchors `Glow_<kind>`). */
export const GLOWS = [
  'Nav_L',
  'Nav_R',
  'Tail',
  'Strobe_L',
  'Strobe_R',
  'Strobe_Tail',
  'Beacon_Top',
  'Beacon_Bottom',
  'Landing_L',
  'Landing_R',
  'Wing_L',
  'Wing_R',
  'Logo_L',
  'Logo_R',
  'Taxi',
  'Takeoff',
  'Turnoff_L',
  'Turnoff_R',
] as const;

export const SPECIAL_NODES = [
  'LOD0',
  'LOD1',
  'LOD2',
  'Cockpit',
  'Eye',
  'Glass',
  'Labels',
  'FanBlades_L',
  'FanBlades_R',
  'FanDisc_L',
  'FanDisc_R',
  'RevLatch_2',
  'TrimWheel_R',
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
};

/** Controls without a moving part of their own (a window, a row of keys, a group). */
export const STILL_CONTROLS = [
  'com1Active',
  'com2Active',
  'nav1Active',
  'nav2Active',
  'xpdrCode',
  'ecamPage',
  'autobrake',
] as const;

export function allExpectedNodes(): string[] {
  return [
    ...EXTERIOR_PIVOTS,
    ...EXTERIOR_PIVOTS.map((n) => `${n}_lod1`),
    ...SLIDING_PIVOTS,
    ...COCKPIT_PIVOTS,
    ...DISPLAYS.map((d) => `Disp_${d}`),
    ...PANEL_WINDOWS.map((d) => `Disp_${d}`),
    ...KEY_LEGENDS.map((k) => `Disp_KY_${k}`),
    ...GLOWS.map((g) => `Glow_${g}`),
    ...SPECIAL_NODES,
    ...A320_CONTROLS.map((c) => controlNode(c.id)),
    ...Object.keys(DUAL_KNOBS).map((id) => `${controlNode(id)}_outer`),
    ...A320_CONTROLS.map((c) => `Hit_${c.id}`),
  ];
}

// ---- cabin and occluders --------------------------------------------------------------------

/** Design frame -> model frame: the reference point (CG) at FS 16.17, WL 3.20 (a320/dims.py). */
export const REF = { fs: 16.17, wl: 3.2 } as const;
const box = (lo: [number, number, number], hi: [number, number, number]) => designBox(lo, hi, REF);

/** Where a camera counts as sitting on the flight deck, model frame. */
export const CABIN = box([-1.9, 2.3, 3.4], [1.9, 5.5, 5.95]);

/** Seat backs: nothing is reached through them (from the jump seat, say). */
export const OCCLUDERS: readonly { center: V3; half: V3 }[] = [0.53, -0.53].map((bl) =>
  box([bl - 0.26, 4.4, 4.1], [bl + 0.26, 4.55, 4.95]),
);

// ---- the gear ----------------------------------------------------------------------------------

export interface GearPose {
  /** Main legs: 0 retracted .. 1 down and locked. */
  main: number;
  /** Nose leg. */
  nose: number;
  /** Hydraulic main doors and the nose's forward doors: 0 closed .. 1 open. */
  mainDoors: number;
  noseDoors: number;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * Where every part of the gear is for `telemetry.gear` (0 up .. 1 down). The A320's doors
 * open, the legs move, and the doors close again behind them, so with the gear down only the
 * doors fixed to the legs stay open; the same in both directions.
 */
export function gearSequence(gear: number): GearPose {
  const g = Math.min(Math.max(gear, 0), 1);
  return {
    main: smooth(0.16, 0.84, g),
    nose: smooth(0.14, 0.8, g),
    mainDoors: Math.min(smooth(0.0, 0.13, g), 1 - smooth(0.88, 1.0, g)),
    noseDoors: Math.min(smooth(0.0, 0.11, g), 1 - smooth(0.86, 1.0, g)),
  };
}

/**
 * The gear indicator: a green triangle per leg down and locked, red UNLK while it moves (or a
 * door is open).
 */
export function gearLights(gear: number): { down: boolean; transit: boolean; up: boolean } {
  const p = gearSequence(gear);
  const down = p.main >= 0.999 && p.nose >= 0.999;
  const up = p.main <= 0.001 && p.nose <= 0.001;
  const doorsShut = p.mainDoors <= 0.001 && p.noseDoors <= 0.001;
  return { down, up: up && doorsShut, transit: !(down || up) || !doorsShut };
}

// ---- slats and flaps ---------------------------------------------------------------------------

/** Slat and flap angles (degrees) of each flap lever position of the A320 (FCOM 1.27.50). */
export const CONFIGS = [
  { label: '0', slats: 0, flaps: 0 },
  { label: '1', slats: 18, flaps: 0 },
  { label: '2', slats: 22, flaps: 15 },
  { label: '3', slats: 22, flaps: 20 },
  { label: 'FULL', slats: 27, flaps: 40 },
] as const;
/** CONF 1+F: lever 1 with the flaps at 10 for take-off (they retract above 210 kt). */
export const CONF_1F = { label: '1+F', slats: 18, flaps: 10 } as const;
export const SLAT_MAX = 27;
export const FLAP_MAX = 40;

export interface HighLift {
  slats: number;
  flaps: number;
  /** The configuration shown on the E/WD ('0', '1', '1+F', '2', '3', 'FULL'), '' in between. */
  label: string;
}

/**
 * Slats and flaps for the flap position the simulation reports (`telemetry.flaps`, the lever's
 * share 0..1 in five steps, lagged): between positions they move together; lever 1 means 1+F
 * below 210 kt.
 */
export function highLift(share: number, iasKt: number): HighLift {
  const k = Math.min(Math.max(share, 0), 1) * 4;
  const i = Math.min(Math.floor(k), 3);
  const f = k - i;
  const one = iasKt < 210 ? CONF_1F : CONFIGS[1];
  const at = (n: number) => (n === 1 ? one : CONFIGS[n]!);
  const a = at(i);
  const b = at(i + 1);
  const slats = a.slats + (b.slats - a.slats) * f;
  const flaps = a.flaps + (b.flaps - a.flaps) * f;
  const near = Math.abs(k - Math.round(k)) < 0.02 ? at(Math.round(k)).label : '';
  return { slats, flaps, label: near };
}

/** The label of the configuration slats and flaps are in, '' while they move between. */
export function configLabel(slats: number, flaps: number): string {
  for (const c of [...CONFIGS, CONF_1F])
    if (Math.abs(c.slats - slats) < 0.6 && Math.abs(c.flaps - flaps) < 0.6) return c.label;
  return '';
}

// ---- spoilers ----------------------------------------------------------------------------------

/** Spoiler panels per wing: 1 (ground only), 2-4 (speed brake, roll, ground), 5 (roll, ground). */
export interface SpoilerPose {
  /** Degrees, trailing edge up, per group: [panel 1, panels 2-4, panel 5]. */
  left: [number, number, number];
  right: [number, number, number];
}

export const SPOILER_LIMITS = { ground: 50, speedbrake: 40, roll: 35 } as const;

/**
 * The spoilers for the speed brake (`telemetry.speedbrake`, 0..1) and the ailerons
 * (`telemetry.aileron`, positive = roll right). On the ground a deployed speed brake means
 * the ground spoilers: all ten panels go fully up. In the air panels 2-4 are the speed brake;
 * panels 2-5 of the down-going wing rise with the roll, and the up-going wing's speed brake
 * panels retract by as much.
 */
export function spoilerPose(speedbrake: number, aileron: number, onGround: boolean): SpoilerPose {
  const sb = Math.min(Math.max(speedbrake, 0), 1);
  if (onGround && sb > 0.5) {
    const g = SPOILER_LIMITS.ground * sb;
    return { left: [g, g, g], right: [g, g, g] };
  }
  const brake = SPOILER_LIMITS.speedbrake * sb;
  const roll = (Math.max(0, Math.abs(aileron) - 0.06) / 0.94) * SPOILER_LIMITS.roll;
  const down = (base: number) => Math.min(Math.max(base, roll), SPOILER_LIMITS.ground);
  const up = (base: number) => Math.max(0, base - roll);
  // Rolling right: the right wing goes down, its spoilers rise.
  const right = aileron > 0;
  const wing = (rolling: boolean): [number, number, number] => [
    0,
    rolling ? down(brake) : up(brake),
    rolling ? down(0) : 0,
  ];
  return { left: wing(!right && aileron !== 0), right: wing(right) };
}

// ---- engines -----------------------------------------------------------------------------------

/** CFM56-5B: 100 % N1 = 5000 rpm (type certificate E37NE). */
export const N1_RPM = 5000;

/** Fan speed for the telemetry: N1 when the engine reports it, else its rpm. */
export function fanRpm(e: EngineTelemetry | undefined): number {
  if (!e) return 0;
  if (e.n1 !== undefined) return (e.n1 / 100) * N1_RPM;
  return e.rpm;
}

/** The fan blurs into a disc from about 900 rpm (18 % N1); blades vanish over 2000. */
export function fanBlur(rpm: number): { disc: number; blades: boolean } {
  return { disc: Math.min(1, Math.max(0, (rpm - 700) / 1400)), blades: rpm < 2000 };
}
