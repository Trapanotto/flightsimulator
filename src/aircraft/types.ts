/**
 * Aircraft types of the Trapanotto Airlines fleet: model file, flight physics, cameras,
 * engine sound and HUD display per type. Models are built in Blender
 * (tools/blender/types/<id>.py); the numbers marked "model" come from the build's META.
 *
 * Physics: published figures (mass, wing, power/thrust, inertia, speeds) plus aerodynamic
 * derivatives typical for the class (textbook values in the style of JSBSim/Aeromatic).
 * Control derivatives are per unit stick input (-1..1 = full deflection), positive = the
 * nose up / right roll / nose right.
 *
 * Model axes: x = left wing, y = up, z = nose; origin = reference point `gearHeight` above
 * the ground with the gear down.
 */

type V3 = [number, number, number];

export interface Aero {
  /** Lift: at zero angle of attack, slope (1/rad), maximum clean, added by full flaps. */
  CL0: number;
  CLa: number;
  CLmax: number;
  CLflaps: number;
  CLde: number;
  CLq: number;
  /** Drag: zero-lift, gear, full flaps, Oswald factor. */
  CD0: number;
  CDgear: number;
  CDflaps: number;
  e: number;
  /** Pitch: Cm0, static stability, damping, elevator, flaps. */
  Cm0: number;
  Cma: number;
  Cmq: number;
  Cmde: number;
  Cmflaps: number;
  /** Side force, roll and yaw derivatives. */
  CYb: number;
  CYdr: number;
  Clb: number;
  Clp: number;
  Clr: number;
  Clda: number;
  Cldr: number;
  Cnb: number;
  Cnr: number;
  Cnp: number;
  Cndr: number;
  Cnda: number;
}

export type Propulsion =
  | { kind: 'prop'; power: number; efficiency: number; staticThrust: number }
  | { kind: 'jet'; staticThrust: number; afterburner: number; afterburnerSeconds: number };

export interface AircraftPhysics {
  /** kg, m², m, m (mean chord). */
  mass: number;
  wingArea: number;
  span: number;
  chord: number;
  /** Moments of inertia about the model axes [x pitch, y yaw, z roll], kg m². */
  inertia: V3;
  /** Centre of gravity, model coordinates. */
  cg: V3;
  aero: Aero;
  propulsion: Propulsion;
  /** Maximum operating speed (m/s) for the OVERSPEED warning and course timing. */
  vne: number;
  /** Control surfaces travel per second (fraction of full deflection). */
  controlRate: number;
  /** Wheel contact points (model) with the weight share they are sprung for. */
  wheels: Array<{ pos: V3; share: number; steer?: boolean; brake?: boolean }>;
  /** Static compression of the gear springs, m. */
  gearStroke: number;
  rollFriction: number;
  brakeFriction: number;
  /** Model origin above ground: gear down / belly. */
  gearHeight: number;
  bellyHeight: number;
  /** Highest sink rate the gear survives, m/s. */
  maxSinkRate: number;
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
  idle: number;
  max: number;
  /** Propeller / fan: blade count and revolutions per second at full power (visual + sound). */
  blades: number;
  maxRps: number;
}

export interface AircraftType {
  id: string;
  name: string;
  info: { de: string; en: string };
  registration: string;
  url: string;
  physics: AircraftPhysics;
  engine: EngineProfile;
  /** Cameras: pilot eye, wing camera (model coordinates), chase distance and height (m). */
  eye: V3;
  wingCam: V3;
  chaseDistance: number;
  chaseHeight: number;
  length: number;
  span: number;
}

const base = import.meta.env?.BASE_URL ?? '/';
const KT = 0.5144;

/** Class presets for the stability and control derivatives. */
const LIGHT: Omit<Aero, 'CL0' | 'CLa' | 'CLmax' | 'CLflaps' | 'CD0' | 'CDgear' | 'CDflaps' | 'e'> =
  {
    CLde: 0.25,
    CLq: 3.9,
    Cm0: 0.02,
    Cma: -0.9,
    Cmq: -12,
    Cmde: 0.6,
    Cmflaps: -0.08,
    CYb: -0.35,
    CYdr: 0.08,
    Clb: -0.09,
    Clp: -0.47,
    Clr: 0.1,
    Clda: 0.07,
    Cldr: 0.005,
    Cnb: 0.065,
    Cnr: -0.1,
    Cnp: -0.03,
    Cndr: 0.035,
    Cnda: -0.005,
  };

export const C172: AircraftType = {
  id: 'c172',
  name: 'Cessna 172 Skyhawk',
  info: {
    de: 'Einmotoriger Hochdecker · 4 Sitze · 180 PS · bis 230 km/h',
    en: 'Single-engine high-wing · 4 seats · 180 hp · up to 230 km/h',
  },
  registration: 'HB-TCA',
  url: `${base}assets/aircraft/c172.glb`,
  physics: {
    mass: 1043,
    wingArea: 16.2,
    span: 11.0,
    chord: 1.49,
    inertia: [1825, 2667, 1285],
    cg: [0, 0.1, 0.85],
    aero: {
      ...LIGHT,
      CL0: 0.3,
      CLa: 4.8,
      CLmax: 1.55,
      CLflaps: 0.65,
      CD0: 0.027,
      CDgear: 0.008,
      CDflaps: 0.05,
      e: 0.75,
    },
    propulsion: { kind: 'prop', power: 134_000, efficiency: 0.78, staticThrust: 2600 },
    vne: 163 * KT,
    controlRate: 4,
    wheels: [
      { pos: [0, -1.19, 2.96], share: 0.3, steer: true },
      { pos: [1.27, -1.19, -0.06], share: 0.35, brake: true },
      { pos: [-1.27, -1.19, -0.06], share: 0.35, brake: true },
    ],
    gearStroke: 0.1,
    rollFriction: 0.025,
    brakeFriction: 0.45,
    gearHeight: 1.19, // model
    bellyHeight: 0.62,
    maxSinkRate: 3.0,
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
    de: 'Einmotoriger Turboprop aus Stans · 1200 PS · 9 Sitze',
    en: 'Single-engine turboprop from Stans · 1200 shp · 9 seats',
  },
  registration: 'HB-TPC',
  url: `${base}assets/aircraft/pc12.glb`,
  physics: {
    mass: 4500,
    wingArea: 25.81,
    span: 16.28,
    chord: 1.75,
    inertia: [18000, 29000, 13000],
    cg: [0, 0, 1.5],
    aero: {
      ...LIGHT,
      CL0: 0.25,
      CLa: 5.0,
      CLmax: 1.55,
      CLflaps: 1.1,
      CD0: 0.023,
      CDgear: 0.015,
      CDflaps: 0.07,
      e: 0.8,
      Cm0: 0.03,
      Cma: -1.0,
      Cmq: -14,
      Cmde: 0.55,
      Cmflaps: -0.1,
      Clb: -0.1,
      Clp: -0.48,
      Clda: 0.06,
      Cnb: 0.08,
      Cnr: -0.11,
      CYb: -0.4,
      CLq: 4,
    },
    propulsion: { kind: 'prop', power: 895_000, efficiency: 0.82, staticThrust: 11_000 },
    vne: 240 * KT,
    controlRate: 3.5,
    wheels: [
      { pos: [0, -1.85, 5.32], share: 0.2, steer: true },
      { pos: [2.2, -1.85, 0.38], share: 0.4, brake: true },
      { pos: [-2.2, -1.85, 0.38], share: 0.4, brake: true },
    ],
    gearStroke: 0.12,
    rollFriction: 0.025,
    brakeFriction: 0.45,
    gearHeight: 1.85, // model
    bellyHeight: 1.0,
    maxSinkRate: 3.0,
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
    de: 'Leichter Businessjet · 2 × 7,7 kN · 6 Sitze',
    en: 'Light business jet · 2 × 7.7 kN · 6 seats',
  },
  registration: 'HB-TEP',
  url: `${base}assets/aircraft/phenom100.glb`,
  physics: {
    mass: 4500,
    wingArea: 18.79,
    span: 12.3,
    chord: 1.6,
    inertia: [20000, 27000, 9000],
    cg: [0, 0, 0.35],
    aero: {
      ...LIGHT,
      CL0: 0.15,
      CLa: 4.8,
      CLmax: 1.35,
      CLflaps: 0.75,
      CD0: 0.026,
      CDgear: 0.02,
      CDflaps: 0.08,
      e: 0.78,
      Cm0: 0.02,
      Cma: -1.1,
      Cmq: -15,
      Cmde: 0.5,
      Clb: -0.1,
      Clp: -0.45,
      Clda: 0.05,
      Cnb: 0.09,
      Cnr: -0.12,
      Cnp: -0.02,
      Cndr: 0.03,
      CYb: -0.4,
      CLq: 4.5,
    },
    propulsion: { kind: 'jet', staticThrust: 15_400, afterburner: 1, afterburnerSeconds: 0 },
    vne: 275 * KT,
    controlRate: 3.5,
    wheels: [
      { pos: [0, -1.3, 4.74], share: 0.15, steer: true },
      { pos: [1.62, -1.3, -0.04], share: 0.425, brake: true },
      { pos: [-1.62, -1.3, -0.04], share: 0.425, brake: true },
    ],
    gearStroke: 0.12,
    rollFriction: 0.02,
    brakeFriction: 0.5,
    gearHeight: 1.3, // model
    bellyHeight: 0.7,
    maxSinkRate: 3.0,
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
    de: 'Kampfjet · 125 kN, mit Nachbrenner 191 kN (Leertaste)',
    en: 'Fighter jet · 125 kN, 191 kN with afterburner (space)',
  },
  registration: 'T-35',
  url: `${base}assets/aircraft/f35.glb`,
  physics: {
    mass: 22_000,
    wingArea: 42.7,
    span: 10.7,
    chord: 4.58,
    inertia: [190_000, 220_000, 40_000],
    cg: [0, 0, -0.6],
    aero: {
      ...LIGHT,
      CL0: 0.05,
      CLa: 3.6,
      CLmax: 1.6,
      CLflaps: 0.3,
      CD0: 0.022,
      CDgear: 0.02,
      CDflaps: 0.04,
      e: 0.7,
      Cm0: 0,
      Cma: -0.35,
      Cmq: -6,
      Cmde: 0.5,
      Cmflaps: -0.02,
      Clb: -0.06,
      Clp: -0.3,
      Clr: 0.03,
      Clda: 0.04,
      Cnb: 0.1,
      Cnr: -0.25,
      Cnp: -0.01,
      Cndr: 0.03,
      Cnda: -0.002,
      CYb: -0.8,
      CLq: 3,
    },
    propulsion: { kind: 'jet', staticThrust: 125_000, afterburner: 1.53, afterburnerSeconds: 15 },
    vne: 700 * KT,
    controlRate: 6,
    wheels: [
      { pos: [0, -1.76, 6.1], share: 0.12, steer: true },
      { pos: [1.55, -1.76, -1.35], share: 0.44, brake: true },
      { pos: [-1.55, -1.76, -1.35], share: 0.44, brake: true },
    ],
    gearStroke: 0.15,
    rollFriction: 0.02,
    brakeFriction: 0.5,
    gearHeight: 1.76, // model
    bellyHeight: 0.6,
    maxSinkRate: 4.0,
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

export const A320: AircraftType = {
  id: 'a320',
  name: 'Airbus A320',
  info: {
    de: 'Kurz- und Mittelstrecke · 2 × 120 kN · 180 Sitze · Sharklets',
    en: 'Short and medium haul · 2 × 120 kN · 180 seats · sharklets',
  },
  registration: 'HB-JTA',
  url: `${base}assets/aircraft/a320.glb`,
  physics: {
    mass: 64_000,
    wingArea: 122.6,
    span: 34.1,
    chord: 4.19,
    inertia: [4.3e6, 7.0e6, 2.8e6],
    cg: [0, -0.5, 0.4],
    aero: {
      ...LIGHT,
      CL0: 0.2,
      CLa: 5.2,
      CLmax: 1.45,
      CLflaps: 1.35,
      CD0: 0.02,
      CDgear: 0.018,
      CDflaps: 0.08,
      e: 0.82,
      Cm0: 0.05,
      Cma: -1.2,
      Cmq: -20,
      Cmde: 0.45,
      Cmflaps: -0.12,
      Clb: -0.15,
      Clp: -0.4,
      Clda: 0.025,
      Cnb: 0.12,
      Cnr: -0.18,
      Cnp: -0.02,
      Cndr: 0.04,
      Cnda: -0.002,
      CYb: -0.6,
      CYdr: 0.12,
      CLde: 0.3,
      CLq: 5,
    },
    propulsion: { kind: 'jet', staticThrust: 240_000, afterburner: 1, afterburnerSeconds: 0 },
    vne: 350 * KT,
    controlRate: 2,
    wheels: [
      { pos: [0, -3.6, 15.5], share: 0.08, steer: true },
      { pos: [3.8, -3.6, -1.05], share: 0.46, brake: true },
      { pos: [-3.8, -3.6, -1.05], share: 0.46, brake: true },
    ],
    gearStroke: 0.25,
    rollFriction: 0.02,
    brakeFriction: 0.45,
    gearHeight: 3.6, // model
    bellyHeight: 1.55,
    maxSinkRate: 3.0,
    fixedGear: false,
    maxFlapDeg: 35,
    hull: {
      nose: [0, 0, 18.8],
      wingL: [17.6, 2.6, -6.5],
      wingR: [-17.6, 2.6, -6.5],
      tail: [0, 8.1, -16.5],
    }, // model
  },
  engine: { kind: 'jet', display: 'n1', idle: 21, max: 100, blades: 24, maxRps: 45 },
  eye: [0.52, 1.1, 16.6], // model
  wingCam: [9.0, 0.6, -1.0],
  chaseDistance: 55,
  chaseHeight: 11,
  length: 37.57,
  span: 35.8,
};

export const B747: AircraftType = {
  id: 'b747',
  name: 'Boeing 747-400',
  info: {
    de: 'Jumbo-Jet · 4 × 252 kN · über 400 Sitze · Oberdeck',
    en: 'Jumbo jet · 4 × 252 kN · over 400 seats · upper deck',
  },
  registration: 'HB-JTB',
  url: `${base}assets/aircraft/b747.glb`,
  physics: {
    mass: 300_000,
    wingArea: 525,
    span: 64.4,
    chord: 8.32,
    // NASA CR-2144 (747 at 288 t): roll 24.7e6, pitch 44.9e6, yaw 67.4e6 kg m².
    inertia: [44.9e6, 67.4e6, 24.7e6],
    cg: [0, -1.0, -1.1],
    aero: {
      ...LIGHT,
      CL0: 0.2,
      CLa: 5.5,
      CLmax: 1.4,
      CLflaps: 1.4,
      CD0: 0.019,
      CDgear: 0.02,
      CDflaps: 0.09,
      e: 0.8,
      Cm0: 0.05,
      Cma: -1.45,
      Cmq: -21,
      Cmde: 0.4,
      Cmflaps: -0.12,
      Clb: -0.2,
      Clp: -0.42,
      Clda: 0.025,
      Cnb: 0.15,
      Cnr: -0.25,
      Cnp: -0.02,
      Cndr: 0.04,
      Cnda: -0.002,
      CYb: -0.9,
      CYdr: 0.14,
      CLde: 0.3,
      CLq: 5.5,
    },
    propulsion: { kind: 'jet', staticThrust: 1_008_000, afterburner: 1, afterburnerSeconds: 0 },
    vne: 365 * KT,
    controlRate: 1.5,
    wheels: [
      { pos: [0, -5.42, 27.8], share: 0.06, steer: true },
      { pos: [5.85, -5.42, -2.1], share: 0.24, brake: true },
      { pos: [-5.85, -5.42, -2.1], share: 0.24, brake: true },
      { pos: [1.95, -5.42, -5.1], share: 0.23, brake: true },
      { pos: [-1.95, -5.42, -5.1], share: 0.23, brake: true },
    ],
    gearStroke: 0.3,
    rollFriction: 0.02,
    brakeFriction: 0.45,
    gearHeight: 5.42, // model
    bellyHeight: 3.6,
    maxSinkRate: 3.0,
    fixedGear: false,
    maxFlapDeg: 30,
    hull: {
      nose: [0, 0.4, 35.3],
      wingL: [31.5, 2.0, -16.0],
      wingR: [-31.5, 2.0, -16.0],
      tail: [0, 13.9, -32.0],
    }, // model
  },
  engine: { kind: 'jet', display: 'n1', idle: 22, max: 100, blades: 38, maxRps: 40 },
  eye: [0.55, 4.2, 31.9], // model
  wingCam: [16.0, 1.5, -6.0],
  chaseDistance: 95,
  chaseHeight: 20,
  length: 70.66,
  span: 64.44,
};

export const AIRCRAFT: AircraftType[] = [C172, PC12, PHENOM100, F35, A320, B747];
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
