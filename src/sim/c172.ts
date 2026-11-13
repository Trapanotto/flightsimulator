/**
 * Cessna 172S Skyhawk SP: geometry from the Pilot's Operating Handbook and the type
 * certificate data (span 36 ft 1 in, wing area 174 ft², dihedral 1.73°, wash-out 3°, NACA
 * 2412, tailplane 38.4 ft², fin 18.1 ft²), Lycoming IO-360-L2A with a 76 in fixed-pitch
 * McCauley propeller. Positions are relative to the centre of gravity at about 28 % MAC;
 * where the handbook gives no figure (strip layout, inertia, gear rates, aerodynamic
 * efficiencies) the values are typical for the class and tuned against the handbook
 * performance in tests/sim.
 */
import type { AirfoilData } from './airfoil';
import type { AircraftDefinition, StripDef } from './definition';
import { DEG, FT, KT } from './math';
import type { Vec3 } from './types';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

const NACA2412: AirfoilData = {
  liftSlope: 5.9,
  alpha0: -2.1 * DEG,
  separationPos: 16.6 * DEG,
  separationNeg: 14 * DEG,
  separationExponent: 10,
  reattachMargin: 4 * DEG,
  lagChords: 3,
  cd0: 0.0065,
  cdLift: 0.01,
  cm0: -0.05,
  plateLift: 1.0,
  plateDrag: 1.3,
};

const TAIL: AirfoilData = {
  liftSlope: 5.6,
  alpha0: 0,
  separationPos: 16 * DEG,
  separationNeg: 16 * DEG,
  separationExponent: 9,
  reattachMargin: 3 * DEG,
  lagChords: 3,
  cd0: 0.008,
  cdLift: 0.006,
  cm0: 0,
  plateLift: 0.95,
  plateDrag: 1.2,
};

// Wing: rectangular centre section to 2.5 m from the centre line, tapered to the tip.
const WING_Z = -0.85;
const WING_X = 0.15;
const DIHEDRAL = 1.73 * DEG;
const ROOT_CHORD = 1.63;
const TIP_CHORD = 1.13;
const HALF_SPAN = 5.5;
const TAPER_START = 2.5;
const chordAt = (y: number) =>
  y <= TAPER_START
    ? ROOT_CHORD
    : ROOT_CHORD + ((TIP_CHORD - ROOT_CHORD) * (y - TAPER_START)) / (HALF_SPAN - TAPER_START);
const incidenceAt = (y: number) =>
  y <= TAPER_START ? 1.5 * DEG : (1.5 - (3 * (y - TAPER_START)) / (HALF_SPAN - TAPER_START)) * DEG;
/** Strip edges along one half span; flaps on the first three, ailerons on the next three. */
const EDGES = [0.55, 1.25, 2.0, 2.75, 3.4, 4.05, 4.75, 5.5];
const FLAP_STRIPS = 3;
const AILERON_STRIPS = 3;

/** Chord and lift axes of a surface turned by incidence (about y) and then dihedral (about x). */
function axes(incidence: number, dihedral: number): { chord: Vec3; lift: Vec3 } {
  const ci = Math.cos(incidence);
  const si = Math.sin(incidence);
  const cd = Math.cos(dihedral);
  const sd = Math.sin(dihedral);
  // Ry(i) x = (cos i, 0, -sin i); Ry(i) (-z) = (-sin i, 0, -cos i); then Rx(d).
  const chord = v(ci, sd * si, -cd * si);
  const lift = v(-si, sd * ci, -cd * ci);
  return { chord, lift };
}

function wingStrips(): StripDef[] {
  const strips: StripDef[] = [];
  // Centre section over the cabin: carries lift, no controls, group of the right half so both
  // halves see the same share (its induced angle is the mean of the two, see the model).
  const centre = axes(1.5 * DEG, 0);
  strips.push({
    name: 'wing-centre',
    group: 0,
    position: v(WING_X, 0, WING_Z),
    chordAxis: centre.chord,
    liftAxis: centre.lift,
    area: 2 * EDGES[0]! * ROOT_CHORD,
    chord: ROOT_CHORD,
    foil: NACA2412,
    liftFactor: 0.8,
    slipstreamDevelopment: 0.6,
  });
  for (const side of [-1, 1]) {
    for (let i = 0; i < EDGES.length - 1; i++) {
      const y0 = EDGES[i]!;
      const y1 = EDGES[i + 1]!;
      const yc = (y0 + y1) / 2;
      // Integrate chord over the strip (it is piecewise linear) with a fine sum.
      let area = 0;
      for (let k = 0; k < 20; k++)
        area += chordAt(y0 + ((k + 0.5) * (y1 - y0)) / 20) * ((y1 - y0) / 20);
      const chord = area / (y1 - y0);
      const ax = axes(incidenceAt(yc), side > 0 ? -DIHEDRAL : DIHEDRAL);
      const strip: StripDef = {
        name: `wing-${side > 0 ? 'right' : 'left'}-${i}`,
        group: side > 0 ? 1 : 2,
        position: v(WING_X, side * yc, WING_Z - yc * Math.tan(DIHEDRAL)),
        chordAxis: ax.chord,
        liftAxis: ax.lift,
        area,
        chord,
        foil: NACA2412,
        slipstreamDevelopment: 0.6,
        wingRoot: i < 2,
      };
      if (i < FLAP_STRIPS) strip.control = { kind: 'flap', effectiveness: 0.75 };
      else if (i < FLAP_STRIPS + AILERON_STRIPS)
        strip.control = { kind: 'aileron', effectiveness: 0.45, side };
      strips.push(strip);
    }
  }
  return strips;
}

const TAIL_X = -4.65;
const TAIL_INCIDENCE = -2.5 * DEG;

function tailStrips(): StripDef[] {
  const h = axes(TAIL_INCIDENCE, 0);
  const strips: StripDef[] = [];
  for (const side of [-1, 1])
    strips.push({
      name: `tailplane-${side > 0 ? 'right' : 'left'}`,
      group: 3,
      position: v(TAIL_X, side * 0.86, -0.05),
      chordAxis: h.chord,
      liftAxis: h.lift,
      area: 3.57 / 2,
      chord: 1.03,
      foil: TAIL,
      qFactor: 0.9,
      control: { kind: 'elevator', effectiveness: 0.55 },
      downwash: true,
      slipstreamDevelopment: 1,
    });
  // Fin: positive "lift" pushes the tail to the left, so sideslip from the right (air
  // arriving on the right side) weathercocks the nose into it.
  const fin = { chord: v(1, 0, 0), lift: v(0, -1, 0) };
  strips.push({
    name: 'fin-lower',
    group: 4,
    position: v(-4.75, 0, -0.5),
    chordAxis: fin.chord,
    liftAxis: fin.lift,
    area: 0.95,
    chord: 1.35,
    foil: TAIL,
    qFactor: 0.9,
    control: { kind: 'rudder', effectiveness: 0.5 },
    slipstreamDevelopment: 1,
  });
  strips.push({
    name: 'fin-upper',
    group: 4,
    position: v(-5.0, 0, -1.2),
    chordAxis: fin.chord,
    liftAxis: fin.lift,
    area: 0.73,
    chord: 1.05,
    foil: TAIL,
    qFactor: 0.95,
    control: { kind: 'rudder', effectiveness: 0.5 },
    slipstreamDevelopment: 1,
  });
  return strips;
}

const strips = [...wingStrips(), ...tailStrips()];
const stallHorn = strips.findIndex((s) => s.name === 'wing-left-2');

export const C172: AircraftDefinition = {
  info: {
    id: 'c172',
    name: 'Cessna 172S Skyhawk SP',
    engines: 1,
    // Handbook stall speeds (KIAS) and never-exceed speed.
    vs: 48 * KT,
    vs0: 40 * KT,
    vne: 163 * KT,
    maxTakeoffMass: 2550 * 0.45359237,
    retractableGear: false,
  },
  // 2550 lb gross with 53 US gal (318 lb) of usable fuel.
  mass: (2550 - 318) * 0.45359237,
  fuelCapacity: 318 * 0.45359237,
  // JSBSim c172 values (948, 1346, 1967 slug ft²).
  inertia: v(1285, 1825, 2667),
  wingArea: 174 * FT * FT,
  wingSpan: 11.0,
  meanChord: 1.49,
  groups: [
    { name: 'wing-centre', aspectRatio: 7.48, oswald: 0.68, span: 11, inducedFrom: [0, 1, 2] },
    { name: 'wing-right', aspectRatio: 7.48, oswald: 0.68, span: 11 },
    { name: 'wing-left', aspectRatio: 7.48, oswald: 0.68, span: 11 },
    { name: 'tailplane', aspectRatio: 3.33, oswald: 0.75, span: 3.45 },
    // The tailplane and fuselage act as end plates for the fin.
    { name: 'fin', aspectRatio: 2.3, oswald: 0.75, span: 1.5 },
  ],
  strips,
  wingGroups: [0, 1, 2],
  downwashFactor: 1.05,
  tailArm: 4.7,
  stallWarning: { strip: stallHorn, alpha: 10.5 * DEG },
  wingRoot: { strength: 2.0, radius: 0.6 },
  fuselage: {
    dragArea: 0.42,
    dragPoint: v(0.3, 0, 0.35),
    sideArea: 6.5,
    planArea: 5.0,
    crossflowCd: 0.6,
    front: v(1.0, 0, 0.1),
    rear: v(-2.6, 0, -0.1),
    frontShare: 0.45,
    pitchMunk: 0.25,
    yawMunk: 0.05,
  },
  propeller: {
    diameter: 76 * 0.0254,
    position: v(1.95, 0, -0.15),
    swirlFactor: 0.3,
    ct: [
      // Blades partly stalled standing still: static thrust is not the maximum.
      [0, 0.084],
      [0.2, 0.086],
      [0.4, 0.088],
      [0.5, 0.083],
      [0.6, 0.0715],
      [0.7, 0.056],
      [0.8, 0.043],
      [0.9, 0.029],
      [1.0, 0.007],
      [1.1, -0.01],
      [1.2, -0.026],
      [1.4, -0.05],
      [1.7, -0.1],
      [2.0, -0.15],
      [3.0, -0.38],
    ],
    cp: [
      [0, 0.063],
      [0.2, 0.062],
      [0.4, 0.058],
      [0.6, 0.051],
      [0.7, 0.0475],
      [0.8, 0.042],
      [0.9, 0.033],
      [1.0, 0.022],
      [1.1, 0.01],
      [1.2, -0.003],
      [1.4, -0.025],
      [1.7, -0.06],
      [2.0, -0.1],
      [3.0, -0.25],
    ],
  },
  engine: {
    ratedPower: 180 * 745.7,
    ratedRpm: 2700,
    displacement: 361 * 1.6387e-5,
    volumetricEfficiency: 0.85,
    idleManifold: 0.22,
    frictionTorque: 46,
    frictionPerRadS: 0.16,
    pumpingTorque: 40,
    inertia: 2.4,
    fullRichRatio: 1.25,
    starterTorque: 140,
    starterRpm: 280,
  },
  controls: {
    elevatorUp: 28 * DEG,
    elevatorDown: 23 * DEG,
    aileronUp: 20 * DEG,
    aileronDown: 15 * DEG,
    rudder: 16 * DEG,
    trimUp: 14 * DEG,
    trimDown: 8 * DEG,
    flapDetents: [0, 10 * DEG, 20 * DEG, 30 * DEG],
    // About 9 s from up to full down, as the electric flap motor.
    flapRate: (30 * DEG) / 9,
    surfaceRate: 4,
    holdLimitPressure: 3200,
    aileronRigging: -0.003,
    rudderRigging: 0.04,
    stallShift: 0.25,
    flapDrag: 0.45,
  },
  wheels: [
    {
      name: 'nose',
      position: v(1.2, 0, 1.186),
      travel: 0.18,
      spring: 36_000,
      damper: 4_000,
      steering: 10 * DEG,
      breakingForce: 40_000,
    },
    {
      name: 'left',
      position: v(-0.45, -1.27, 1.179),
      travel: 0.2,
      spring: 52_000,
      damper: 4_700,
      brake: 'left',
      brakeForce: 1_150,
      breakingForce: 55_000,
    },
    {
      name: 'right',
      position: v(-0.45, 1.27, 1.179),
      travel: 0.2,
      spring: 52_000,
      damper: 4_700,
      brake: 'right',
      brakeForce: 1_150,
      breakingForce: 55_000,
    },
  ],
  contacts: [
    { name: 'propeller', position: v(1.95, 0, 0.815), crashSpeed: 0, reason: 'propeller' },
    { name: 'left-wingtip', position: v(0, -5.5, -1.02), crashSpeed: 0, reason: 'wing' },
    { name: 'right-wingtip', position: v(0, 5.5, -1.02), crashSpeed: 0, reason: 'wing' },
    { name: 'tail', position: v(-4.2, 0, 0.25), crashSpeed: 3, reason: 'tail' },
    { name: 'belly', position: v(0.3, 0, 0.62), crashSpeed: 2, reason: 'ground' },
    { name: 'fin-top', position: v(-5.3, 0, -1.6), crashSpeed: 0, reason: 'ground' },
  ],
  // Normal category: +3.8 / -1.52 g limit, 1.5 safety factor.
  ultimateLoad: { positive: 5.7, negative: -2.28 },
  // POH airspeed calibration (KCAS to KIAS), flaps 0 / 10 / 20 / 30. The static source and
  // pitot read low at high angles of attack, which is why the handbook stall speeds in KIAS
  // are well below the calibrated ones.
  airspeedCalibration: [
    [
      [0, 0],
      [53, 48],
      [56, 50],
      [62, 60],
      [70, 70],
      [78, 80],
      [87, 90],
      [97, 100],
      [107, 110],
      [117, 120],
      [127, 130],
      [137, 140],
      [147, 150],
      [157, 160],
      [250, 253],
    ],
    [
      [0, 0],
      [51, 43],
      [55, 50],
      [62, 60],
      [70, 70],
      [79, 80],
      [88, 90],
      [97, 100],
      [250, 253],
    ],
    [
      [0, 0],
      [49, 41],
      [54, 50],
      [61, 60],
      [69, 70],
      [78, 80],
      [87, 90],
      [250, 253],
    ],
    [
      [0, 0],
      [48, 40],
      [54, 50],
      [61, 60],
      [69, 70],
      [78, 80],
      [83, 85],
      [250, 253],
    ],
  ],
};
