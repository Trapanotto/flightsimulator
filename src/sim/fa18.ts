/**
 * McDonnell Douglas F/A-18C Hornet as the Swiss Air Force flies it (two F404-GE-402, unarmed
 * here). Published figures, with their sources:
 *
 * - NATOPS flight manual A1-F18AC-NFM-000 (figures as generally quoted from it; checked
 *   against the public summaries, not the manual itself): span 11.43 m without tip missiles,
 *   length 17.07 m, height 4.66 m, wing area 37.16 m² (400 ft²), MAC 3.51 m; symmetric limit
 *   7.5 g at 32 357 lb (14 677 kg) and below, -3 g; 750 KCAS, Mach 1.8; gear 250 KCAS; on-speed
 *   approach angle of attack 8.1°; internal fuel 10 860 lb (4930 kg).
 * - Engine: General Electric F404-GE-402, 11 000 lbf (48.9 kN) dry and 17 750 lbf (79.0 kN)
 *   with afterburner, sea level static (GE data sheet).
 * - Geometry of the planform: leading-edge sweep 26.7°, taper 0.35, NACA 65A005 to 65A003.5,
 *   leading-edge extensions of about 56 ft² (NASA TP-2860 and the HARV papers, e.g. NASA
 *   TM-4789, Iliff and Wang); the leading-edge flaps to 34°, trailing-edge flaps to 45°,
 *   stabilators 24° trailing edge up / 10.5° down, rudders ±30°, ailerons ±25° (HARV
 *   simulation documentation, from memory).
 * - Inertia: the HARV's Ixx 22 789, Iyy 176 809, Izz 191 744 slug ft² (NASA TM-4789, from memory),
 *   close to this mass.
 *
 * Reconstructed (marked so where they appear): the strip layout and the section data, which
 * are tuned so the aircraft meets the published performance in tests/sim/fa18.performance.test.ts,
 * the engine's part-power map, the gear springs and the systems' figures.
 *
 * Configuration: clean, no centreline tank, gun and pylons empty, 11 070 kg operating mass
 * (empty 10 810 kg, pilot and equipment 110 kg, oil and trapped fuel 150 kg) plus the full
 * internal fuel: 16 000 kg at take-off.
 */
import type { AirfoilData } from './airfoil';
import type { AvionicsConfig } from './avionics/config';
import { FA18_CONTROLS } from './cockpitFa18';
import type { AircraftDefinition, StripDef } from './definition';
import { Fa18Autopilot } from './fa18/autopilot';
import { Fa18Fcs } from './fa18/fcs';
import { Fa18Systems } from './fa18/systems';
import { tacanTuning } from './fa18/tacan';
import { DEG, FT, KT } from './math';
import type { TurbofanDef } from './propulsion';
import type { SystemsData } from './systems/data';
import type { Vec3 } from './types';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const LBF = 4.448222;
const LB = 0.45359237;

/** Mass of the airframe without fuel, kg: the configuration above. */
export const FA18_OPERATING_MASS = 11_070;
export const FA18_INTERNAL_FUEL = 10_860 * LB;
/** NATOPS: the full symmetric limit of 7.5 g holds up to 32 357 lb. */
export const FA18_DESIGN_MASS = 32_357 * LB;

/** Thin 5 % section with the leading-edge flap's help counted separately (reconstructed). */
const WING_FOIL: AirfoilData = {
  liftSlope: 6.0,
  alpha0: -1.2 * DEG,
  separationPos: 11 * DEG,
  separationNeg: 12 * DEG,
  separationExponent: 3.5,
  reattachMargin: 3 * DEG,
  lagChords: 3,
  cd0: 0.0055,
  cdLift: 0.008,
  cm0: -0.005,
  plateLift: 1.35,
  plateDrag: 1.3,
  // Effective thickness and divergence chosen with the body's drag rise so the transonic drag
  // peak and the supersonic drag meet the published maximum speeds (reconstructed).
  mach: { divergence: 0.85, thickness: 0.055 },
};

/** The leading-edge extension: a slender strake whose lift is mostly its vortex (Polhamus). */
const LEX_FOIL: AirfoilData = {
  liftSlope: 2.2,
  alpha0: 0,
  separationPos: 40 * DEG,
  separationNeg: 40 * DEG,
  separationExponent: 4,
  reattachMargin: 2 * DEG,
  lagChords: 2,
  cd0: 0.004,
  cdLift: 0.01,
  cm0: 0,
  // Past the vortex burst the strake still carries a flat plate's normal force: the nose-up
  // moment the stabilators work against at high angle of attack.
  plateLift: 1.3,
  plateDrag: 1.1,
  mach: { divergence: 0.9, thickness: 0.03 },
};

const TAIL_FOIL: AirfoilData = {
  liftSlope: 5.8,
  alpha0: 0,
  separationPos: 16 * DEG,
  separationNeg: 16 * DEG,
  separationExponent: 6,
  reattachMargin: 3 * DEG,
  lagChords: 3,
  cd0: 0.006,
  cdLift: 0.008,
  cm0: 0,
  plateLift: 1.0,
  plateDrag: 1.2,
  mach: { divergence: 0.9, thickness: 0.04 },
};

// Wing: trapezoid of 37.16 m² over 11.43 m with taper 0.35 gives a 4.82 m root chord on the
// centre line and the published 3.51 m MAC.
const HALF_SPAN = 11.43 / 2;
const ROOT_CHORD = 4.817;
const TIP_CHORD = 0.35 * ROOT_CHORD;
const SWEEP_C4 = Math.atan(Math.tan(26.7 * DEG) - (1 / 3.516) * (0.65 / 1.35));
/** Quarter chord of the root; the MAC's quarter chord then lies a little behind the centre of gravity. */
const WING_X0 = 1.11;
const WING_Z = 0.05;
const chordAt = (y: number) => ROOT_CHORD + ((TIP_CHORD - ROOT_CHORD) * y) / HALF_SPAN;
const quarterChordX = (y: number) => WING_X0 - y * Math.tan(SWEEP_C4);
const EDGES = [1.25, 2.3, 3.3, 4.4, HALF_SPAN];
/** Trailing-edge flaps inboard, ailerons outboard; leading-edge flaps over the whole span. */
const FLAP_STRIPS = 2;
const LEF = 0.35;

function axes(incidence: number, dihedral: number): { chord: Vec3; lift: Vec3 } {
  const ci = Math.cos(incidence);
  const si = Math.sin(incidence);
  const cd = Math.cos(dihedral);
  const sd = Math.sin(dihedral);
  return { chord: v(ci, sd * si, -cd * si), lift: v(-si, sd * ci, -cd * ci) };
}

function wingStrips(): StripDef[] {
  const strips: StripDef[] = [];
  const level = axes(0, 0);
  strips.push({
    name: 'wing-centre',
    group: 0,
    position: v(quarterChordX(EDGES[0]! / 2), 0, WING_Z),
    chordAxis: level.chord,
    liftAxis: level.lift,
    area: 2 * EDGES[0]! * chordAt(EDGES[0]! / 2),
    chord: chordAt(EDGES[0]! / 2),
    foil: WING_FOIL,
    // The fuselage between the engines carries less lift than a free wing; the strakes' vortex
    // runs over this part of the wing.
    liftFactor: 0.8,
    vortexLift: 0.5,
    sweep: SWEEP_C4,
    leadingEdge: LEF,
    slipstreamDevelopment: 0,
  });
  for (const side of [-1, 1]) {
    for (let i = 0; i < EDGES.length - 1; i++) {
      const y0 = EDGES[i]!;
      const y1 = EDGES[i + 1]!;
      const yc = (y0 + y1) / 2;
      const chord = chordAt(yc);
      // A degree of washout: the outer wing keeps its flow longest.
      const ax = axes(-(yc / HALF_SPAN) * 1 * DEG, 0);
      const strip: StripDef = {
        name: `wing-${side > 0 ? 'right' : 'left'}-${i}`,
        group: side > 0 ? 1 : 2,
        position: v(quarterChordX(yc), side * yc, WING_Z),
        chordAxis: ax.chord,
        liftAxis: ax.lift,
        area: (y1 - y0) * chord,
        chord,
        foil: WING_FOIL,
        sweep: SWEEP_C4,
        leadingEdge: LEF,
        slipstreamDevelopment: 0,
      };
      if (i === 0) strip.vortexLift = 0.5;
      if (i < FLAP_STRIPS) strip.control = { kind: 'flap', effectiveness: 0.85 };
      // The ailerons droop with the flaps: 42° at full flap's 45°.
      else strip.control = { kind: 'aileron', effectiveness: 0.55, side, droop: 42 / 45 };
      strips.push(strip);
    }
  }
  return strips;
}

function lexStrips(): StripDef[] {
  const level = axes(0, 0);
  return [-1, 1].map((side) => ({
    name: `lex-${side > 0 ? 'right' : 'left'}`,
    group: 3,
    position: v(3.1, side * 0.95, WING_Z - 0.1),
    chordAxis: level.chord,
    liftAxis: level.lift,
    // About 56 ft² for both strakes.
    area: 2.6,
    chord: 3.6,
    foil: LEX_FOIL,
    vortexLift: 1.8,
    sweep: 70 * DEG,
    slipstreamDevelopment: 0,
  }));
}

// All-moving stabilators (8.18 m², 42.8° leading-edge sweep, 2° anhedral) behind the wing and
// below it; twin fins canted 20° outboard, 4.83 m² each, ahead of the stabilators.
const STAB_X = -5.75;
const FIN_CANT = 20 * DEG;

function tailStrips(): StripDef[] {
  const strips: StripDef[] = [];
  for (const side of [-1, 1]) {
    const ax = axes(0, side > 0 ? -2 * DEG : 2 * DEG);
    strips.push({
      name: `stabilator-${side > 0 ? 'right' : 'left'}`,
      group: 4,
      position: v(STAB_X, side * 2.0, 0.25),
      chordAxis: ax.chord,
      liftAxis: ax.lift,
      area: 8.18 / 2,
      chord: 1.75,
      foil: TAIL_FOIL,
      qFactor: 0.95,
      control: { kind: 'elevator', effectiveness: 1, side, roll: 1 },
      downwash: true,
      sweep: 35 * DEG,
      slipstreamDevelopment: 0,
    });
  }
  for (const side of [-1, 1]) {
    const c = Math.cos(FIN_CANT);
    const s = Math.sin(FIN_CANT);
    strips.push({
      name: `fin-${side > 0 ? 'right' : 'left'}`,
      group: side > 0 ? 5 : 6,
      position: v(-4.7, side * (1.45 + 1.3 * s), -0.85 - 1.3 * c),
      chordAxis: v(1, 0, 0),
      // Normal of a fin leaning outboard: to the left and, on the right fin, a little up.
      liftAxis: v(0, -c, -side * s),
      area: 4.83,
      chord: 1.9,
      foil: TAIL_FOIL,
      qFactor: 0.92,
      control: { kind: 'rudder', effectiveness: 0.42 },
      sweep: 40 * DEG,
      slipstreamDevelopment: 0,
    });
  }
  return strips;
}

const strips = [...wingStrips(), ...lexStrips(), ...tailStrips()];
const vane = strips.findIndex((s) => s.name === 'wing-centre');

/**
 * F404-GE-402. Dry and afterburning ratings are GE's; fuel flows are set to about 3700 kg/h
 * per engine at military power and a little over 17 000 kg/h in full afterburner at sea
 * level (the figures the task gives; published SFCs of 0.8 and 1.8-1.9 lb/lbf/h would give
 * about 4000 and 15 000 kg/h). The thrust lapse with ram follows Mattingly's afterburning
 * low-bypass form with a throttle ratio of 1.05 (reconstructed so the published maximum speeds
 * come out); spool speeds, map and temperatures are typical values, from memory.
 */
const F404: TurbofanDef['engine'] = {
  ratedThrust: 11_000 * LBF,
  throttleRatio: 1.05,
  temperatureLapse: 3.5,
  machLapse: 0,
  n1Rpm: 13_270,
  n1Max: 1,
  n1Idle: 0.62,
  n2Max: 1,
  n2Idle: 0.7,
  thrust: [
    [0.5, 0.03],
    [0.62, 0.085],
    [0.7, 0.16],
    [0.8, 0.33],
    [0.9, 0.6],
    [1.0, 1.0],
    [1.06, 1.16],
  ],
  tsfc: [2.1e-5, 0.7e-5],
  idleFuel: 0.03,
  egt: [
    [0.15, 470],
    [0.5, 600],
    [0.7, 690],
    [0.85, 830],
    [1.0, 1135],
    [1.06, 1220],
  ],
  // Idle to military power in about 4 s: the F404's quick spool.
  spool: { idle: 1.1, high: 0.45, accel: 0.11, decel: 0.18 },
  start: {
    starterN2: 0.26,
    starterTime: 5,
    lightOffN2: 0.15,
    lightOffDelay: 2,
    cutoutN2: 0.6,
    accel: 0.025,
    peakEgt: 600 + 273.15,
  },
  angularMomentum: 2000,
  afterburner: {
    military: 0.75,
    thrust: 17_750 * LBF,
    tsfc: [6.05e-5, 1.0e-5],
    lightTime: 2,
    // Open at idle (it lowers the idle thrust), nearly closed at military, wide open at full.
    nozzle: [0.78, 0.08, 1],
  },
};

export const FA18_ENGINES: TurbofanDef[] = [-1, 1].map((side) => ({
  kind: 'afterburning',
  position: v(-7.0, side * 0.55, 0.15),
  engine: F404,
}));

/** JP-8 in the internal tanks: feed tanks 2 and 3 first (the gauges' left and right), kg (reconstructed split). */
const TANKS = [
  { id: 'tank2', usable: 1250, position: v(-0.4, 0, -0.5) },
  { id: 'tank3', usable: 760, position: v(-1.9, 0, -0.5) },
  { id: 'tank1', usable: 720, position: v(1.6, 0, -0.6) },
  { id: 'tank4', usable: 1160, position: v(-3.2, 0, -0.4) },
  { id: 'wingLeft', usable: (FA18_INTERNAL_FUEL - 3890) / 2, position: v(-1.0, -2.6, 0.05) },
  { id: 'wingRight', usable: (FA18_INTERNAL_FUEL - 3890) / 2, position: v(-1.0, 2.6, 0.05) },
];

const FA18_SYSTEMS: SystemsData = {
  // 24 V battery; the two AC generators (40/75 kVA) feed the DC buses through transformer
  // rectifiers, here as their DC equivalent. They come on line with the AMAD near idle.
  electrical: {
    batteries: [
      { switch: 'battery', ampHours: 15, resistance: 0.02, fullVolts: 25.5, lowVolts: 23.5 },
    ],
    generators: [
      {
        switch: 'generatorLeft',
        engine: 0,
        volts: 28,
        amps: 300,
        cutIn: 52,
        full: 60,
        failure: 'alternator',
      },
      { switch: 'generatorRight', engine: 1, volts: 28, amps: 300, cutIn: 52, full: 60 },
    ],
    lowVolts: 24,
    avionicsMinVolts: 20,
    busMinVolts: 16,
    // No avionics master: the mission computers come with the battery switch.
    avionicsSwitch: 'battery',
    loads: {
      base: 18,
      avionics: 45,
      flapsMotor: 0,
      // Air turbine starters: the APU's air, not the battery, turns the engines.
      starter: 0,
      switched: [
        { control: 'lightNav', amps: 2 },
        { control: 'lightStrobe', amps: 3 },
        { control: 'lightLanding', amps: 6 },
        { control: 'pitotHeat', amps: 10 },
        { control: 'engineAntiIce', amps: 2 },
      ],
    },
  },
  fuel: {
    tankUsable: 0,
    tankArm: 0,
    tanks: TANKS,
    // FUEL LO: a feed tank below 800 lb.
    lowFuel: 800 * LB,
    leakRate: 0.1,
    lineFuel: 1,
  },
  engine: {
    kind: 'turbine',
    // The crank switch and the throttles are read by the type's own systems (fa18/systems.ts).
    starter: 'fa18Starter',
    ignition: 'fa18Ignition',
    oilPressure: 45,
    normalSpeed: 70,
    lowOilPressure: 12,
    oilTemperature: 95,
  },
  icing: { iceMass: 200 },
  // 3000 psi, one engine-driven pump each on the AMAD. The landing gear moves on the first
  // system (the core takes the first one for the gear; on the aircraft it is HYD 2).
  hydraulics: [
    { id: 'hyd1', pressure: 3000, enginePumps: [{ engine: 0, minSpeed: 45 }] },
    { id: 'hyd2', pressure: 3000, enginePumps: [{ engine: 1, minSpeed: 45 }] },
  ],
  failures: ['engine', 'alternator', 'pitot', 'fuelLeak', 'com1'],
};

export const FA18_AVIONICS: AvionicsConfig = {
  autopilot: () => new Fa18Autopilot(),
  // The positions of FA18_CONTROLS' navSource: ILS on NAV 1, the GPS waypoints, TACAN on NAV 2.
  navSources: ['nav1', 'gps', 'nav2'],
  nav2Tuning: tacanTuning,
};

const identity = [
  [0, 0],
  [1000, 1000],
] as const;

export const FA18: AircraftDefinition = {
  info: {
    id: 'fa18',
    name: 'McDonnell Douglas F/A-18C Hornet',
    engines: 2,
    // Measured in tests/sim/fa18.performance.test.ts: lowest steady speed clean and with full
    // flaps at the take-off mass (the FCS limits the angle of attack, there is no stall break).
    vs: 125 * KT,
    vs0: 112 * KT,
    vne: 750 * KT,
    maxTakeoffMass: 23_400,
    retractableGear: true,
    category: 'fighter',
    speedbrake: true,
    reverse: false,
    vApproach: 137 * KT,
    vRotate: 130 * KT,
    specs: {
      maker: 'McDonnell Douglas, St. Louis (Swiss final assembly RUAG, Emmen)',
      powerplant: '2 × General Electric F404-GE-402, 48.9 kN dry, 79.0 kN with afterburner',
      span: 11.43,
      length: 17.07,
      height: 4.66,
      emptyMass: 10_810,
      // Mach 0.85 at 36 000 ft.
      cruiseSpeed: 488 * KT,
      maxSpeed: 750 * KT,
      maxMach: 1.8,
      ceiling: 50_000 * FT,
      // Ferry range with three tanks, about 1800 NM; clean on internal fuel far less.
      range: 1800 * 1852,
      climbRate: (45_000 * FT) / 60,
      takeoffRoll: 430,
      landingRoll: 850,
      seats: 1,
      firstFlight: 1978,
    },
  },
  mass: FA18_OPERATING_MASS,
  fuelCapacity: FA18_INTERNAL_FUEL,
  inertia: v(22_789 * 1.35582, 176_809 * 1.35582, 191_744 * 1.35582),
  wingArea: 37.16,
  wingSpan: 11.43,
  meanChord: 3.51,
  groups: [
    { name: 'wing-centre', aspectRatio: 3.52, oswald: 0.85, span: 11.43, inducedFrom: [0, 1, 2] },
    { name: 'wing-right', aspectRatio: 3.52, oswald: 0.85, span: 11.43 },
    { name: 'wing-left', aspectRatio: 3.52, oswald: 0.85, span: 11.43 },
    { name: 'lex', aspectRatio: 1.0, oswald: 0.9, span: 2.5 },
    { name: 'stabilators', aspectRatio: 3.0, oswald: 0.85, span: 6.58 },
    { name: 'fin-right', aspectRatio: 1.75, oswald: 0.8, span: 2.9 },
    { name: 'fin-left', aspectRatio: 1.75, oswald: 0.8, span: 2.9 },
  ],
  strips,
  wingGroups: [0, 1, 2],
  downwashFactor: 0.8,
  tailArm: 5.6,
  stallWarning: { strip: vane, alpha: 45 * DEG },
  wingRoot: { strength: 0, radius: 1 },
  fuselage: {
    dragArea: 0.42,
    dragPoint: v(0, 0, 0),
    sideArea: 22,
    planArea: 24,
    crossflowCd: 0.9,
    front: v(4.8, 0, 0),
    rear: v(-4.5, 0, -0.2),
    frontShare: 0.5,
    pitchMunk: 0.1,
    yawMunk: 0.05,
    // The body's wave drag (reconstructed with the wing's, see WING_FOIL).
    machDrag: { critical: 0.8, rise: 1.05 },
  },
  engines: FA18_ENGINES,
  controls: {
    elevatorUp: 24 * DEG,
    elevatorDown: 10.5 * DEG,
    aileronUp: 25 * DEG,
    aileronDown: 25 * DEG,
    rudder: 30 * DEG,
    // The FCS trims; on the ground the trim is a stabilator angle (take-off trim 4° nose up).
    trimUp: 24 * DEG,
    trimDown: 10.5 * DEG,
    // AUTO, HALF, FULL: trailing-edge flaps 0 (scheduled), 30° and 45°.
    flapDetents: [0, 30 * DEG, 45 * DEG],
    // About 20°/s for the leading- and trailing-edge flaps.
    flapRate: 20 * DEG,
    slatDetents: [0, 9 * DEG, 9 * DEG],
    // Stabilators about 40°/s, the fastest surfaces somewhat more.
    surfaceRate: 1.25,
    holdLimitPressure: Infinity,
    aileronRigging: 0,
    rudderRigging: 0,
    stallShift: 0.1,
    flapDrag: 0.06,
    spoilerRate: 0.5,
  },
  gear: {
    extendTime: 6,
    retractTime: 6,
    power: 'hyd1',
    dragArea: 0.55,
    dragPoint: v(0.5, 0, 1.4),
    vlo: 250 * KT,
    vle: 250 * KT,
  },
  // Between the fins, opening upwards: drag above and behind the centre of gravity.
  speedbrake: { dragArea: 1.1, position: v(-4.2, 0, -1.0) },
  controlLaw: (def) => new Fa18Fcs(def),
  limits: {
    vmo: 750 * KT,
    mmo: 1.8,
    vfe: [Infinity, 250 * KT, 250 * KT],
    egt: 885 + 273.15 + 30,
  },
  wheels: [
    {
      name: 'nose',
      position: v(4.77, 0, 1.95),
      travel: 0.3,
      spring: 140_000,
      damper: 16_000,
      // Low gain ±16°; the high gain (±75°) is the type's systems' steering scale.
      steering: 16 * DEG,
      breakingForce: 300_000,
    },
    {
      name: 'left',
      position: v(-0.65, -1.555, 1.95),
      travel: 0.35,
      spring: 450_000,
      damper: 45_000,
      brake: 'left',
      brakeForce: 32_000,
      breakingForce: 700_000,
    },
    {
      name: 'right',
      position: v(-0.65, 1.555, 1.95),
      travel: 0.35,
      spring: 450_000,
      damper: 45_000,
      brake: 'right',
      brakeForce: 32_000,
      breakingForce: 700_000,
    },
  ],
  contacts: [
    {
      name: 'belly-front',
      position: v(3, 0, 1.0),
      crashSpeed: 2.5,
      maxDepth: 0.6,
      reason: 'ground',
      skid: true,
    },
    {
      name: 'belly-rear',
      position: v(-3, 0, 0.95),
      crashSpeed: 2.5,
      maxDepth: 0.6,
      reason: 'ground',
      skid: true,
    },
    {
      name: 'nozzle-left',
      position: v(-7.4, -0.55, 0.65),
      crashSpeed: 2,
      maxDepth: 0.5,
      reason: 'tail',
      skid: true,
    },
    {
      name: 'nozzle-right',
      position: v(-7.4, 0.55, 0.65),
      crashSpeed: 2,
      maxDepth: 0.5,
      reason: 'tail',
      skid: true,
    },
    { name: 'nose', position: v(8.5, 0, 0.4), crashSpeed: 0, reason: 'ground' },
    { name: 'left-wingtip', position: v(-1.3, -HALF_SPAN, WING_Z), crashSpeed: 0, reason: 'wing' },
    { name: 'right-wingtip', position: v(-1.3, HALF_SPAN, WING_Z), crashSpeed: 0, reason: 'wing' },
    { name: 'left-stabilator', position: v(-6.6, -3.29, 0.35), crashSpeed: 0, reason: 'tail' },
    { name: 'right-stabilator', position: v(-6.6, 3.29, 0.35), crashSpeed: 0, reason: 'tail' },
    { name: 'fin-top', position: v(-5.6, 2.45, -3.55), crashSpeed: 0, reason: 'ground' },
  ],
  // 1.5 times the 7.5 g and -3 g limits.
  ultimateLoad: { positive: 11.25, negative: -4.5 },
  airspeedCalibration: [identity, identity, identity],
  systems: FA18_SYSTEMS,
  cockpit: FA18_CONTROLS,
  avionics: FA18_AVIONICS,
  typeSystems: () => new Fa18Systems(),
};
