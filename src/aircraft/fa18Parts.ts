/**
 * Naming convention of the F/A-18C model (written by tools/aircraft/build_fa18.py and
 * tools/aircraft/fa18/, which document the same lists) and the plain maths of its moving parts
 * and its head-up display: the gear's retraction sequence, the nozzle opening, the flight
 * control surfaces' fallbacks, the vapour cues, and the head-up display's projection. Tested
 * in Node.
 */
import { type EngineTelemetry, FA18_CONTROLS } from '@sim';
import { type V3, designBox } from './picking';

const DEG = Math.PI / 180;

/** Movable parts in LOD0 (LOD1 has the same ones with the suffix `_lod1`). */
export const EXTERIOR_PIVOTS = [
  'LEF_L', // leading edge down (extras.maxDeg)
  'LEF_R',
  'TEF_L', // trailing edge down (extras.maxDeg)
  'TEF_R',
  'Aileron_L', // trailing edge down (extras.upDeg, downDeg)
  'Aileron_R',
  'Rudder_L', // trailing edge right (extras.maxDeg)
  'Rudder_R',
  'Stabilator_L', // leading edge down = trailing edge up (extras.upDeg, downDeg)
  'Stabilator_R',
  'Speedbrake', // opens (extras.openDeg)
  'Canopy', // opens, front up (extras.openDeg)
  'MainGear_L', // retracts aft (extras.retractDeg)
  'MainGear_R',
  'MainTwist_L', // wheel turns flat (extras.twistDeg)
  'MainTwist_R',
  'MainDoor_L', // opens (extras.openDeg)
  'MainDoor_R',
  'NoseGear', // retracts forward (extras.retractDeg)
  'NoseSteer', // nose wheels right (extras.maxDeg)
  'NoseDoor_L', // opens (extras.openDeg)
  'NoseDoor_R',
  'LaunchBar', // lowered (extras.downDeg)
  'Hook', // lowered (extras.downDeg)
  'Wheel_N', // rolling forward
  'Wheel_L',
  'Wheel_R',
] as const;

/** Struts slide (extras.slide = axle travel hanging free). */
export const SLIDING_PIVOTS = ['MainOleo_L', 'MainOleo_R', 'NoseOleo'] as const;

/** The stick and the pedals (LOD0 only). */
export const COCKPIT_PIVOTS = ['Stick', 'StickRoll', 'Pedals_L', 'Pedals_R'] as const;

/** The three displays and the head-up display's symbol plane. */
export const DISPLAYS = ['DDI_L', 'DDI_R', 'MPCD', 'HUD'] as const;
/** The small windows of the panel atlas. */
export const PANEL_WINDOWS = [
  'UFC_SP',
  'UFC_OPT',
  'UFC_C1',
  'UFC_C2',
  'IFEI',
  'STBY_ASI',
  'STBY_ALT',
  'STBY_ADI',
  'STBY_VSI',
  'RADALT',
  'CAUTION',
  'AOA',
  'MC',
  'GEAR',
  'HOOK',
  'NAV',
  'IFF',
] as const;
export type PanelWindowId = (typeof PANEL_WINDOWS)[number];

/** Lamp glows by kind (anchors `Glow_<kind>`). */
export const GLOWS = [
  'Nav_L',
  'Nav_R',
  'Tail_L',
  'Tail_R',
  'Strobe_L',
  'Strobe_R',
  'Landing',
  'AB_L',
  'AB_R',
] as const;

export const SPECIAL_NODES = [
  'LOD0',
  'LOD1',
  'LOD2',
  'Cockpit',
  'Eye',
  'Glass',
  'CanopyGlass',
  'Labels',
  'Nozzles',
  'Flame_L',
  'Flame_R',
  'VapourLex',
  'VapourTip',
  'Pilot',
  'Lamp_Formation',
  'MainGear_L_lod2',
  'MainGear_R_lod2',
  'NoseGear_lod2',
  'Canopy_lod2',
  'Hook_lod2',
] as const;

export const controlNode = (id: string) => `Ctl_${id}`;

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
    ...FA18_CONTROLS.map((c) => controlNode(c.id)),
    ...FA18_CONTROLS.map((c) => `Hit_${c.id}`),
  ];
}

// ---- dimensions shared with the Blender build (tools/aircraft/fa18/dims.py) ------------------

/** Design frame -> model frame: the reference point (CG) at FS 8.70, WL 2.00. */
export const REF = { fs: 8.7, wl: 2.0 } as const;
const box = (lo: [number, number, number], hi: [number, number, number]) => designBox(lo, hi, REF);

/** Where a camera counts as sitting in the cockpit, model frame. */
export const CABIN = box([-0.5, 3.6, 2.0], [0.5, 5.4, 3.2]);

/** The seat and the glareshield's HUD body: nothing is reached through them. */
export const OCCLUDERS: readonly { center: V3; half: V3 }[] = [
  box([-0.2, 4.36, 2.13], [0.2, 4.76, 2.27]),
  box([-0.1, 3.53, 2.66], [0.1, 3.75, 2.76]),
];

/** The nozzle: hinge ring and exit radii (m), its length, the engines' centres (model frame). */
export const NOZZLE = {
  hingeZ: REF.fs - 16.12,
  length: 0.62,
  hingeR: 0.425,
  buildR: 0.4,
  minR: 0.32,
  maxR: 0.47,
  centreX: 0.56,
  centreY: 1.93 - REF.wl,
} as const;

// ---- the gear ------------------------------------------------------------------------------

export interface GearPose {
  /** Main legs: 0 retracted .. 1 down and locked. */
  main: number;
  /** Main wheels turned flat: 0 as standing .. 1 flat in the well. */
  twist: number;
  nose: number;
  mainDoors: number;
  noseDoors: number;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * Where every part of the gear is for `telemetry.gear` (0 up .. 1 down): the doors open first,
 * the legs swing in the middle of the travel (the main wheels turn flat during the first half
 * of the leg's swing up), and the main doors close again once the legs are locked. The nose
 * doors stay open while the leg is down, as on the real aircraft.
 */
export function gearSequence(gear: number): GearPose {
  const g = Math.min(Math.max(gear, 0), 1);
  const main = smooth(0.14, 0.88, g);
  return {
    main,
    twist: 1 - smooth(0.25, 0.8, main),
    nose: smooth(0.12, 0.84, g),
    mainDoors: Math.min(smooth(0.0, 0.12, g), 1 - smooth(0.9, 1.0, g)),
    noseDoors: smooth(0.0, 0.1, g),
  };
}

/** Three greens once down and locked; the handle's light while anything moves. */
export function gearLights(gear: number): { down: boolean; transit: boolean } {
  const p = gearSequence(gear);
  const down = p.main >= 0.999 && p.nose >= 0.999;
  const up = p.main <= 0.001 && p.nose <= 0.001;
  return { down, transit: !(down || up) || p.mainDoors > 0.001 };
}

// ---- engines -------------------------------------------------------------------------------

/**
 * The nozzle opening 0..1 of an F404 when the engine does not report it: wide at idle (the
 * nozzle unloads the fan), closing down towards military power, opening again with the
 * afterburner; open when stopped (the petals hang loose).
 */
export function nozzleOpening(e: EngineTelemetry | undefined): number {
  if (!e) return 0.78;
  if (e.nozzle !== undefined) return Math.min(Math.max(e.nozzle, 0), 1);
  const ab = e.afterburner ?? 0;
  if (ab > 0.001) return 0.25 + 0.75 * Math.min(ab, 1);
  if (!e.running) return 0.78;
  const n2 = e.n2 ?? 60 + 40 * e.power;
  // Idle (about 70 % N2) open, military (about 97 %) nearly closed: the sim's 0.78 and 0.08.
  const t = Math.min(Math.max((n2 - 72) / 24, 0), 1);
  return 0.78 - 0.7 * t;
}

/** Exit radius (m) of the nozzle for an opening 0..1. */
export function nozzleExitRadius(opening: number): number {
  const o = Math.min(Math.max(opening, 0), 1);
  return NOZZLE.minR + (NOZZLE.maxR - NOZZLE.minR) * o;
}

/** Afterburner 0..1 of an engine (reported, or from the power above military). */
export function afterburnerOf(e: EngineTelemetry | undefined): number {
  if (!e?.running) return 0;
  if (e.afterburner !== undefined) return Math.min(Math.max(e.afterburner, 0), 1);
  return Math.min(Math.max((e.power - 1) / 0.6, 0), 1);
}

// ---- flight control surfaces ---------------------------------------------------------------

/** Surface positions in degrees (positive: leading edge down, trailing edge down/right). */
export interface Fa18Surfaces {
  lef: number;
  tef: number;
  aileronL: number;
  aileronR: number;
  /** Stabilators: positive = trailing edge up. */
  stabL: number;
  stabR: number;
  /** Rudders: positive = trailing edge right (both right together is yaw; toe-in differs). */
  rudderL: number;
  rudderR: number;
}

/**
 * The surfaces from the plain telemetry when the flight control system does not report them:
 * leading-edge flaps on their schedule with angle of attack (and down with the trailing-edge
 * flaps for take-off and landing), trailing-edge flaps from `flaps`, the ailerons drooping with
 * them, the stabilators from the elevator with a share of the roll, the rudders together.
 */
export function surfacesFrom(t: {
  alpha: number;
  flaps: number;
  elevator: number;
  aileron: number;
  rudder: number;
  onGround: boolean;
}): Fa18Surfaces {
  const a = t.alpha / DEG;
  const flaps = Math.min(Math.max(t.flaps, 0), 1);
  const lef = t.onGround && flaps < 0.05 ? 0 : Math.min(Math.max(a * 1.25 + 12 * flaps, 0), 34);
  const tef = flaps * 45;
  const droop = flaps * 42;
  const ail = t.aileron * 25;
  const stab = t.elevator > 0 ? t.elevator * 24 : t.elevator * 10.5;
  const diff = t.aileron * 6;
  return {
    lef,
    tef,
    aileronL: Math.min(Math.max(droop - ail, -30), 45),
    aileronR: Math.min(Math.max(droop + ail, -30), 45),
    stabL: stab - diff,
    stabR: stab + diff,
    rudderL: t.rudder * 30,
    rudderR: t.rudder * 30,
  };
}

// ---- vapour --------------------------------------------------------------------------------

/**
 * How visible the LEX vortices and the wing-tip trails are, 0..1, from angle of attack (rad),
 * load factor and a humidity proxy 0..1 (the air's moisture when known, else lower is moister).
 */
export function vapour(alpha: number, g: number, humidity: number): { lex: number; tip: number } {
  const h = Math.min(Math.max(humidity, 0), 1);
  const a = smooth(17, 27, alpha / DEG);
  const gg = smooth(4.5, 7.5, g);
  return { lex: Math.min(1, (0.8 * a + 0.5 * gg) * h), tip: Math.min(1, 0.9 * gg * h) };
}

// ---- the head-up display ---------------------------------------------------------------------

/**
 * Where the head-up display's symbol plane sits relative to the pilot's eye: `distance` ahead
 * along the boresight, its centre `offsetY` up and `offsetX` right of the boresight, and its
 * size (m). The symbols are drawn for the eye point, so they lie on the outside world
 * (collimated) when the camera is there.
 */
export interface HudGeometry {
  distance: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

/** The model's numbers (cockpit.py: HUD_FS, HUD_CENTRE_WL, HUD_PLANE; the eye at FS 4.56). */
export const HUD_GEOMETRY: HudGeometry = {
  distance: 4.56 - (3.9 - 0.004),
  offsetX: 0,
  offsetY: -0.012,
  width: 0.24,
  height: 0.22,
};

/**
 * Canvas pixel of a direction given in the aircraft's axes (forward, right, up), or null
 * behind the eye. `size` is the canvas's width and height in pixels.
 */
export function hudProject(
  g: HudGeometry,
  size: { w: number; h: number },
  fwd: number,
  right: number,
  up: number,
): { x: number; y: number } | null {
  if (fwd <= 1e-4) return null;
  const x = (g.distance * right) / fwd - g.offsetX;
  const y = (g.distance * up) / fwd - g.offsetY;
  return { x: size.w / 2 + (x / g.width) * size.w, y: size.h / 2 - (y / g.height) * size.h };
}

/**
 * A direction given by azimuth (right of the heading) and elevation (above the horizon),
 * radians, in the aircraft's axes for a pitch and bank (radians).
 */
export function earthToBody(
  az: number,
  el: number,
  pitch: number,
  bank: number,
): [number, number, number] {
  const x = Math.cos(el) * Math.cos(az);
  const y = Math.cos(el) * Math.sin(az);
  const z = Math.sin(el);
  const xb = x * Math.cos(pitch) + z * Math.sin(pitch);
  const zp = -x * Math.sin(pitch) + z * Math.cos(pitch);
  const right = y * Math.cos(bank) + zp * Math.sin(bank);
  const up = -y * Math.sin(bank) + zp * Math.cos(bank);
  return [xb, right, up];
}

/** Canvas pixels per degree near the centre of the display (the pitch ladder's scale). */
export function hudPixelsPerDegree(g: HudGeometry, canvasHeight: number): number {
  return (canvasHeight / g.height) * g.distance * Math.tan(DEG);
}

/**
 * The on-speed bracket of the landing mode: the angle of attack 8.1 degrees is the centre,
 * the bracket spans 6.9 (fast) to 9.3 (slow); 'slow' and 'fast' beyond its ends.
 */
export const ON_SPEED = { alpha: 8.1, fast: 6.9, slow: 9.3 } as const;
export function onSpeed(alphaDeg: number): 'fast' | 'onSpeed' | 'slow' {
  return alphaDeg > ON_SPEED.slow ? 'slow' : alphaDeg < ON_SPEED.fast ? 'fast' : 'onSpeed';
}
