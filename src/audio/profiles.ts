/**
 * How each aircraft type sounds: the engine kind and its published figures, where the engines
 * sit, how much of each sound gets into the cabin, the airframe sounds and the warnings.
 * Plain data, chosen by aircraft id (`soundProfileFor`).
 */
import type { AircraftId, AircraftInfo } from '@sim';

/** The synthesis voice of the worklet (engine-worklet.js). */
export type EngineKind = 'piston' | 'turboprop' | 'turbofan' | 'afterburning';

/** Figures of a turbine engine; the speeds are the 100 % references of the cockpit gauges. */
export interface TurbineSpec {
  /** Gas generator (a turboprop's Ng, a jet's N2) at 100 %, rpm. */
  coreRpm100: number;
  /** A jet's fan (N1) at 100 %, rpm; a turboprop's governed propeller speed, rpm. */
  fanRpm100: number;
  /** Ground idle: gas generator and fan, per cent. */
  idleCore: number;
  idleFan: number;
  /**
   * Blade counts of the compressor stages that make the whine: each sings at the core shaft
   * frequency times its count (the first is the loudest).
   */
  compressorOrders: readonly number[];
  /** Fan tip diameter, m: its tip speed decides when the buzz-saw starts (jets). */
  fanDiameter: number;
  /** Fully expanded exhaust velocity at idle, at full dry power and with full afterburner, m/s. */
  jetIdle: number;
  jetMax: number;
  jetBurner?: number;
  /** Exhaust nozzle diameter closed and fully open, m. */
  nozzle: readonly [number, number];
  /** The gas generator speed at which the starter cuts out, and fuel and ignition come on, %. */
  starterCutout: number;
  ignitionOn: number;
  lightOff: number;
  /** Seconds to spool up and down, used only when the telemetry lacks the turbine speeds. */
  spoolUp: number;
  spoolDown: number;
}

/** What gets into the cabin (or the fighter's cockpit) from outside. */
export interface CabinSpec {
  /** Low-pass of everything heard inside, Hz: the walls let the low end through. */
  lowpassHz: number;
  /** Engine gain inside, and the weight of each part of the engine sound there. */
  engine: number;
  tone: number;
  buzz: number;
  whine: number;
  roar: number;
  /** Wind level inside at `windFullSpeed`. */
  wind: number;
  /** Air conditioning (environmental control system) hiss, level and centre, Hz. */
  ecs: number;
  ecsHz: number;
}

/** The airframe sounds of a type. Levels are outside gains 0..1 before the cabin weighting. */
export interface AirframeSpec {
  /** Gear extension and retraction: hydraulic whine level and its pitch, lock thumps. */
  gearHydraulic: number;
  gearHz: number;
  gearThump: number;
  /** The roar of the extended gear in the airstream at `windFullSpeed`. */
  gearRoar: number;
  /** Flaps and slats running: 'none' (the cockpit sound has the Cessna's motor). */
  flapsDrive: 'none' | 'electric' | 'hydraulic';
  flapsHz: number;
  flapsLevel: number;
  /** Speed brake buffet at `windFullSpeed`. */
  buffet: number;
  /** Shock noise rising towards and beyond Mach 1 (only a fighter goes there). */
  shock: number;
  /** Tyres: chirp pitch, and scales of the rumble level and pitch and the touch-down thump. */
  chirpHz: number;
  rumble: number;
  rumbleHz: number;
  thump: number;
  /** Ground speed at which the tyre rumble is full, m/s (heavier aircraft roll faster). */
  rollFullSpeed: number;
}

export interface WarningSpec {
  /** How the stall warning sounds. */
  stall: 'horn' | 'shaker' | 'cricket' | 'tone';
  /** An overspeed clacker for the app's overspeed flag. */
  overspeed: boolean;
  /** An altitude alert chime for the app's altitude alert flag. */
  altitudeChime: boolean;
  /** The autopilot disconnect: the KAP 140's pulsed tone, or the Airbus cavalry charge. */
  disconnect: 'tone' | 'cavalry';
}

/** An engine's position in body axes (x forward, y right, z down), metres from the datum. */
export interface Position {
  x: number;
  y: number;
  z: number;
}

/** How an aircraft type sounds. */
export interface SoundProfile {
  engine: EngineKind;
  cylinders: number;
  /** Propeller blades, or the blades of a jet's first fan stage. */
  blades: number;
  /** Speed at which the wind noise is at full level, m/s. */
  windFullSpeed: number;
  /** Phase 4. Every field below is optional: without them a profile sounds like the Cessna. */
  id?: AircraftId;
  /** Where the engines and the pilot's head are; one engine per entry. */
  engines?: readonly Position[];
  pilot?: Position;
  /** Distance of the outside view from the aircraft, m: the level reference for distance. */
  viewDistance?: number;
  /** Engine gain outside. */
  outside?: number;
  turbine?: TurbineSpec;
  cabin?: CabinSpec;
  airframe?: AirframeSpec;
  warnings?: WarningSpec;
}

export const C172_SOUND: SoundProfile = {
  engine: 'piston',
  cylinders: 4,
  blades: 2,
  windFullSpeed: 80,
};

/**
 * Pilatus PC-12 NG: one PT6A-67P driving a five-blade Hartzell propeller governed at 1700 rpm.
 * The PT6's gas generator turns 37,468 rpm at 100 % Ng; ground idle is a little above 50 %.
 * Starter and igniters run from the start to about 50 % Ng; fuel comes on at 13 % Ng.
 */
export const PC12_SOUND: SoundProfile = {
  id: 'pc12',
  engine: 'turboprop',
  cylinders: 0,
  blades: 5,
  windFullSpeed: 130,
  engines: [{ x: 4, y: 0, z: 0 }],
  pilot: { x: 2, y: -0.4, z: -0.6 },
  viewDistance: 18,
  outside: 0.85,
  turbine: {
    coreRpm100: 37_468,
    fanRpm100: 1700,
    idleCore: 56,
    idleFan: 56,
    // The centrifugal impeller and the first axial stage (counts assumed, not published).
    compressorOrders: [15, 26],
    fanDiameter: 2.67,
    jetIdle: 60,
    jetMax: 150,
    nozzle: [0.3, 0.3],
    starterCutout: 50,
    ignitionOn: 0,
    lightOff: 13,
    spoolUp: 2.5,
    spoolDown: 5,
  },
  cabin: {
    lowpassHz: 1300,
    engine: 0.5,
    tone: 1,
    buzz: 0,
    whine: 0.2,
    roar: 0.4,
    wind: 0.22,
    ecs: 0.012,
    ecsHz: 2500,
  },
  airframe: {
    gearHydraulic: 0.05,
    gearHz: 420,
    gearThump: 0.35,
    gearRoar: 0.3,
    flapsDrive: 'electric',
    flapsHz: 260,
    flapsLevel: 0.035,
    buffet: 0,
    shock: 0,
    chirpHz: 2100,
    rumble: 1.1,
    rumbleHz: 0.9,
    thump: 1.1,
    rollFullSpeed: 40,
  },
  warnings: { stall: 'shaker', overspeed: true, altitudeChime: true, disconnect: 'tone' },
};

/**
 * Airbus A320 with CFM56-5B: 36 fan blades, N1 100 % = 5000 rpm, N2 100 % = 14,460 rpm,
 * fan 1.735 m. Ground idle about 20 % N1 and 58 % N2. Automatic start: ignition at 16 % N2,
 * fuel at 22 %, starter cut-out at 50 %.
 */
export const A320_SOUND: SoundProfile = {
  id: 'a320',
  engine: 'turbofan',
  cylinders: 0,
  blades: 36,
  windFullSpeed: 170,
  engines: [
    { x: 3, y: -5.75, z: 1.6 },
    { x: 3, y: 5.75, z: 1.6 },
  ],
  pilot: { x: 17, y: -0.5, z: -1 },
  viewDistance: 45,
  // Two engines, each through a panner: their sum sets the level.
  outside: 0.62,
  turbine: {
    coreRpm100: 14_460,
    fanRpm100: 5000,
    idleCore: 58,
    idleFan: 20,
    // First stages of the high-pressure compressor (counts assumed).
    compressorOrders: [38, 53],
    fanDiameter: 1.735,
    jetIdle: 110,
    jetMax: 330,
    nozzle: [1.1, 1.1],
    starterCutout: 50,
    ignitionOn: 16,
    lightOff: 22,
    spoolUp: 2,
    spoolDown: 6,
  },
  cabin: {
    lowpassHz: 450,
    engine: 0.12,
    tone: 0.25,
    buzz: 0.45,
    whine: 0.08,
    roar: 0.8,
    wind: 0.3,
    ecs: 0.02,
    ecsHz: 1800,
  },
  airframe: {
    gearHydraulic: 0.035,
    gearHz: 520,
    gearThump: 0.3,
    gearRoar: 1,
    flapsDrive: 'hydraulic',
    flapsHz: 760,
    flapsLevel: 0.06,
    buffet: 0.5,
    shock: 0,
    chirpHz: 1500,
    rumble: 1.5,
    rumbleHz: 0.7,
    thump: 1.6,
    rollFullSpeed: 70,
  },
  warnings: { stall: 'cricket', overspeed: true, altitudeChime: true, disconnect: 'cavalry' },
};

/**
 * Boeing F/A-18 with two F404-GE-400: fan 13,270 rpm and core 16,810 rpm at 100 %, fan about
 * 0.7 m. 11,000 lbf dry, 17,700 lbf with afterburner (telemetry power up to about 1.6).
 */
export const FA18_SOUND: SoundProfile = {
  id: 'fa18',
  engine: 'afterburning',
  cylinders: 0,
  // First fan stage (count assumed).
  blades: 24,
  windFullSpeed: 300,
  engines: [
    { x: -6, y: -0.55, z: 0.2 },
    { x: -6, y: 0.55, z: 0.2 },
  ],
  pilot: { x: 5, y: 0, z: -0.8 },
  viewDistance: 30,
  outside: 0.68,
  turbine: {
    coreRpm100: 16_810,
    fanRpm100: 13_270,
    idleCore: 70,
    idleFan: 62,
    compressorOrders: [42, 61],
    fanDiameter: 0.7,
    jetIdle: 200,
    jetMax: 620,
    // Effective for the noise: the afterburner's hot jet is fast but thin, and the
    // radiated power grows with its density as well as its velocity.
    jetBurner: 780,
    nozzle: [0.45, 0.8],
    starterCutout: 55,
    ignitionOn: 15,
    lightOff: 20,
    spoolUp: 2,
    spoolDown: 5,
  },
  cabin: {
    lowpassHz: 600,
    engine: 0.28,
    tone: 0.15,
    buzz: 0.2,
    whine: 0.25,
    roar: 0.9,
    wind: 0.18,
    ecs: 0.03,
    ecsHz: 2200,
  },
  airframe: {
    gearHydraulic: 0.05,
    gearHz: 610,
    gearThump: 0.5,
    gearRoar: 0.4,
    flapsDrive: 'hydraulic',
    flapsHz: 880,
    flapsLevel: 0.03,
    buffet: 1,
    shock: 0.8,
    chirpHz: 1900,
    rumble: 1.2,
    rumbleHz: 0.85,
    thump: 1.3,
    rollFullSpeed: 70,
  },
  warnings: { stall: 'tone', overspeed: true, altitudeChime: true, disconnect: 'tone' },
};

const BY_ID: Record<AircraftId, SoundProfile> = {
  c172: C172_SOUND,
  pc12: PC12_SOUND,
  a320: A320_SOUND,
  fa18: FA18_SOUND,
};

const BY_CATEGORY: Record<NonNullable<AircraftInfo['category']>, SoundProfile> = {
  piston: C172_SOUND,
  turboprop: PC12_SOUND,
  airliner: A320_SOUND,
  fighter: FA18_SOUND,
};

/** The highest engine count the worklet synthesises; the slots beyond it stay silent. */
export const MAX_ENGINES = 2;

/**
 * The profile of a type: by its id, else by its category (a type added later sounds like
 * its kind), else the Cessna.
 */
export function soundProfileFor(
  info: Pick<AircraftInfo, 'id' | 'category'> | { id: string; category?: string },
): SoundProfile {
  const byId = (BY_ID as Record<string, SoundProfile | undefined>)[info.id];
  if (byId) return byId;
  const byCategory = info.category
    ? (BY_CATEGORY as Record<string, SoundProfile | undefined>)[info.category]
    : undefined;
  return byCategory ?? C172_SOUND;
}
