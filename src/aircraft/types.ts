/**
 * Aircraft types of the Trapanotto Airlines fleet: model file, arcade flight figures, cameras,
 * engine sound and HUD display per type. Models are built in Blender
 * (tools/blender/types/<id>.py); the numbers marked "model" come from the build's META.
 *
 * Model axes: x = left wing, y = up, z = nose; origin = reference point `gearHeight` above
 * the ground with the gear down.
 */

const DEG = Math.PI / 180;

type V3 = [number, number, number];

export interface AircraftPhysics {
  /** Acceleration along the path at full throttle, m/s². */
  thrust: number;
  /** Drag coefficient; top speed in level flight is sqrt(thrust / drag). */
  drag: number;
  /** Extra drag factors with gear down / full flaps. */
  gearDrag: number;
  flapDrag: number;
  /** Boost (afterburner on the F-35): thrust factor, seconds available, recharge per second. */
  boostFactor: number;
  boostSeconds: number;
  boostRecharge: number;
  /** Clean stall speed and how much full flaps lower it, m/s. */
  stallSpeed: number;
  flapStallDrop: number;
  /** The nose may lift above this speed on the runway, m/s. */
  rotateSpeed: number;
  rollRate: number;
  pitchRate: number;
  yawRate: number;
  /** How fast the flight path follows the nose (1/s). */
  grip: number;
  /** Model origin above ground: gear down / on the belly. */
  gearHeight: number;
  bellyHeight: number;
  maxSinkRate: number;
  /** Highest load factor a full pull can produce. */
  maxG: number;
  /** Angle of attack: aoaRef at aoaSpeed, growing with 1/v², capped at aoaMax. */
  aoaRef: number;
  aoaSpeed: number;
  aoaMax: number;
  /** Hands-off pitch attitude range of the trim and wheel speed, radians (per second). */
  trimMin: number;
  trimMax: number;
  trimRate: number;
  /** Fixed gear: always down, the gear key does nothing. */
  fixedGear: boolean;
  /** Flap angle at full flaps, degrees (HUD). */
  maxFlapDeg: number;
  /** Points that must stay above the terrain (model coordinates). */
  hull: { nose: V3; wingL: V3; wingR: V3; tail: V3 };
}

export interface EngineProfile {
  kind: 'piston' | 'turboprop' | 'jet' | 'fighter';
  /** HUD: propeller rpm or fan speed N1 in %. */
  display: 'rpm' | 'n1';
  /** Idle and maximum (rpm, or N1 %). */
  idle: number;
  max: number;
  /** Propeller / fan: blade count and revolutions per second at full power (visual + sound). */
  blades: number;
  maxRps: number;
}

export interface AircraftType {
  id: string;
  name: string;
  /** Short line for the selection list. */
  info: { de: string; en: string };
  registration: string;
  url: string;
  physics: AircraftPhysics;
  engine: EngineProfile;
  /** Cameras: pilot eye, wing camera, chase distance and height (model coordinates / metres). */
  eye: V3;
  wingCam: V3;
  chaseDistance: number;
  chaseHeight: number;
  /** Overall size for LOD distances and the hangar camera, metres. */
  length: number;
  span: number;
}

const base = import.meta.env?.BASE_URL ?? '/';

export const C172: AircraftType = {
  id: 'c172',
  name: 'Cessna 172 Skyhawk',
  info: {
    de: 'Einmotoriger Hochdecker · 4 Sitze · bis 226 km/h',
    en: 'Single-engine high-wing · 4 seats · up to 226 km/h',
  },
  registration: 'HB-TCA',
  url: `${base}assets/aircraft/c172.glb`,
  physics: {
    thrust: 2.2,
    drag: 2.2 / 63 ** 2,
    gearDrag: 0,
    flapDrag: 0.6,
    boostFactor: 1,
    boostSeconds: 0,
    boostRecharge: 0,
    stallSpeed: 25,
    flapStallDrop: 4,
    rotateSpeed: 27,
    rollRate: 1.5,
    pitchRate: 1.0,
    yawRate: 0.45,
    grip: 3.0,
    gearHeight: 1.19, // model
    bellyHeight: 0.62,
    maxSinkRate: 3.5,
    maxG: 4.4,
    aoaRef: 5 * DEG,
    aoaSpeed: 32,
    aoaMax: 13 * DEG,
    trimMin: -15 * DEG,
    trimMax: 20 * DEG,
    trimRate: 4 * DEG,
    fixedGear: true,
    maxFlapDeg: 30,
    hull: {
      nose: [0, -0.04, 4.02],
      wingL: [5.5, 0.99, 0.75],
      wingR: [-5.5, 0.99, 0.75],
      tail: [0, 1.6, -4.3],
    }, // model
  },
  engine: { kind: 'piston', display: 'rpm', idle: 700, max: 2700, blades: 2, maxRps: 45 },
  eye: [0.27, 0.62, 0.78], // model
  wingCam: [2.4, 0.55, 0.2],
  chaseDistance: 12,
  chaseHeight: 3.0,
  length: 8.28,
  span: 11.0,
};

export const PC12: AircraftType = {
  id: 'pc12',
  name: 'Pilatus PC-12 NGX',
  info: {
    de: 'Einmotoriger Turboprop aus Stans · 9 Sitze · bis 528 km/h',
    en: 'Single-engine turboprop from Stans · 9 seats · up to 528 km/h',
  },
  registration: 'HB-TPC',
  url: `${base}assets/aircraft/pc12.glb`,
  physics: {
    thrust: 5.5,
    drag: 5.5 / 145 ** 2,
    gearDrag: 0.3,
    flapDrag: 0.5,
    boostFactor: 1,
    boostSeconds: 0,
    boostRecharge: 0,
    stallSpeed: 34,
    flapStallDrop: 8,
    rotateSpeed: 38,
    rollRate: 1.6,
    pitchRate: 0.95,
    yawRate: 0.4,
    grip: 2.8,
    gearHeight: 1.85, // model
    bellyHeight: 1.0,
    maxSinkRate: 3.5,
    maxG: 3.3,
    aoaRef: 5 * DEG,
    aoaSpeed: 45,
    aoaMax: 12 * DEG,
    trimMin: -15 * DEG,
    trimMax: 20 * DEG,
    trimRate: 3.5 * DEG,
    fixedGear: false,
    maxFlapDeg: 40,
    hull: {
      nose: [0, -0.05, 7.4],
      wingL: [8.1, 0.5, 1.6],
      wingR: [-8.1, 0.5, 1.6],
      tail: [0, 2.95, -7.4],
    }, // model
  },
  engine: { kind: 'turboprop', display: 'rpm', idle: 950, max: 1700, blades: 5, maxRps: 28 },
  eye: [0.38, 0.82, 2.75], // model
  wingCam: [3.2, -0.2, 0.2],
  chaseDistance: 18,
  chaseHeight: 4.2,
  length: 14.4,
  span: 16.28,
};

export const PHENOM100: AircraftType = {
  id: 'phenom100',
  name: 'Embraer Phenom 100',
  info: {
    de: 'Leichter Businessjet · 2 Turbofans · 6 Sitze · bis 720 km/h',
    en: 'Light business jet · 2 turbofans · 6 seats · up to 720 km/h',
  },
  registration: 'HB-TEP',
  url: `${base}assets/aircraft/phenom100.glb`,
  physics: {
    thrust: 4.5,
    drag: 4.5 / 200 ** 2,
    gearDrag: 0.35,
    flapDrag: 0.55,
    boostFactor: 1,
    boostSeconds: 0,
    boostRecharge: 0,
    stallSpeed: 46,
    flapStallDrop: 9,
    rotateSpeed: 50,
    rollRate: 1.8,
    pitchRate: 0.85,
    yawRate: 0.35,
    grip: 2.5,
    gearHeight: 1.3, // model
    bellyHeight: 0.7,
    maxSinkRate: 3.2,
    maxG: 3.5,
    aoaRef: 4 * DEG,
    aoaSpeed: 60,
    aoaMax: 12 * DEG,
    trimMin: -12 * DEG,
    trimMax: 18 * DEG,
    trimRate: 3 * DEG,
    fixedGear: false,
    maxFlapDeg: 36,
    hull: {
      nose: [0, -0.05, 6.3],
      wingL: [6.15, -0.07, -1.0],
      wingR: [-6.15, -0.07, -1.0],
      tail: [0, 2.45, -5.9],
    }, // model
  },
  engine: { kind: 'jet', display: 'n1', idle: 24, max: 100, blades: 22, maxRps: 60 },
  eye: [0.35, 0.72, 3.1], // model
  wingCam: [3.0, -0.1, -0.3],
  chaseDistance: 17,
  chaseHeight: 3.8,
  length: 12.82,
  span: 12.3,
};

export const F35: AircraftType = {
  id: 'f35',
  name: 'Lockheed Martin F-35 Lightning II',
  info: {
    de: 'Kampfjet · Nachbrenner statt Boost · bis 1190 km/h im Tiefflug',
    en: 'Fighter jet · afterburner instead of boost · up to 1190 km/h down low',
  },
  registration: 'T-35',
  url: `${base}assets/aircraft/f35.glb`,
  physics: {
    thrust: 9,
    drag: 9 / 330 ** 2,
    gearDrag: 0.3,
    flapDrag: 0.4,
    boostFactor: 1.5,
    boostSeconds: 10,
    boostRecharge: 0.5,
    stallSpeed: 58,
    flapStallDrop: 10,
    rotateSpeed: 68,
    rollRate: 4.0,
    pitchRate: 1.8,
    yawRate: 0.7,
    grip: 3.5,
    gearHeight: 1.76, // model
    bellyHeight: 0.6,
    maxSinkRate: 4.0,
    maxG: 9,
    aoaRef: 4 * DEG,
    aoaSpeed: 80,
    aoaMax: 16 * DEG,
    trimMin: -20 * DEG,
    trimMax: 30 * DEG,
    trimRate: 5 * DEG,
    fixedGear: false,
    maxFlapDeg: 30,
    hull: {
      nose: [0, 0, 8.2],
      wingL: [5.35, -0.24, -2.4],
      wingR: [-5.35, -0.24, -2.4],
      tail: [0, 2.62, -5.6],
    }, // model
  },
  engine: { kind: 'fighter', display: 'n1', idle: 30, max: 100, blades: 18, maxRps: 70 },
  eye: [0, 0.86, 4.25], // model
  wingCam: [3.2, 0.25, -1.4],
  chaseDistance: 20,
  chaseHeight: 4.0,
  length: 15.67,
  span: 10.7,
};

export const AIRCRAFT: AircraftType[] = [C172, PC12, PHENOM100, F35];
export const DEFAULT_AIRCRAFT = C172;

/** The type with this id, if it is in the fleet already. */
export function findAircraft(id: string | null | undefined): AircraftType | undefined {
  return AIRCRAFT.find((a) => a.id === id);
}

export function aircraftById(id: string | null | undefined): AircraftType {
  return AIRCRAFT.find((a) => a.id === id) ?? DEFAULT_AIRCRAFT;
}

const KEY = 'tfs.aircraft';

export function loadAircraftChoice(): AircraftType {
  try {
    return aircraftById(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_AIRCRAFT;
  }
}

export function saveAircraftChoice(id: string) {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Not critical.
  }
}
