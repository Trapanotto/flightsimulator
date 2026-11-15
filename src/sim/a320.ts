/**
 * Airbus A320-214 with two CFM56-5B4. Published figures, with their sources:
 *
 * - EASA type certificate data sheet A.064 (A320-214): two CFM56-5B4 (or /P), 27 000 lbf
 *   (120.1 kN) take-off thrust each, flat rated to ISA+15 °C; VMO 350 KIAS, MMO 0.82;
 *   maximum operating altitude 39 800 ft; maximum differential pressure 8.6 psi (safety
 *   valve), 8.06 psi normal; the -214 weight variant chosen here: MTOW 73 500 kg, MLW
 *   64 500 kg, MZFW 61 000 kg.
 * - Airbus 'A320 Aircraft Characteristics, Airport and Maintenance Planning' (AC, section 2):
 *   span 34.10 m (without sharklets), length 37.57 m, height 11.76 m, wing area 122.6 m²,
 *   quarter-chord sweep 25°, mean aerodynamic chord 4.19 m, dihedral 5.1°; wheel base
 *   12.64 m, wheel track 7.59 m; usable fuel 23 860 l (wings 2 × 7 805 l, centre 8 250 l),
 *   18 730 kg at 0.785 kg/l; operating empty mass about 42 400 kg.
 * - Flight Crew Operating Manual (FCOM, limitations): VFE CONF 1 230 kt, 1+F 215, 2 200,
 *   3 185, FULL 177; VLO 250 kt extension / 220 kt retraction, VLE 280 kt; tyre speed 195 kt
 *   ground speed; slats / flaps 0/0, 18/0, 18/10, 22/15, 22/20, 27/35 degrees for CONF 0, 1,
 *   1+F, 2, 3, FULL (reconstructed from memory: the FCOM figures as remembered); spoilers 1 to
 *   5 per wing, 2 to 5 roll, 2 to 4 speed brake (40° in flight), all ground spoilers (50°).
 * - Flight controls (FCOM DSC-27, from memory): elevator 30° up / 17° down, ailerons ±25°,
 *   rudder ±30° with a travel limiter, trimmable horizontal stabiliser 13.5° nose up to 4°
 *   nose down; normal law load factor limits +2.5 / -1 g clean, +2 / 0 g with slats or
 *   flaps; bank 33° spiral stability, 67° maximum; pitch 30° nose up (25° CONF FULL at low
 *   speed), 15° nose down; roll rate 15°/s at full stick.
 *
 * Where no figure is published (strip layout, twist, inertia, gear springs, the engine's
 * corrected maps) the values are typical for the class and tuned against the published
 * performance in tests/sim/a320.*.test.ts.
 */
import type { AirfoilData } from './airfoil';
import { A320Fmgc } from './a320/fmgc';
import { A320Computers } from './a320/computers';
import type { AvionicsConfig } from './avionics/config';
import { A320_CONTROLS } from './cockpitA320';
import type { AircraftDefinition, StripControl, StripDef } from './definition';
import { DEG, FT, KT } from './math';
import type { TurbofanDef } from './propulsion';
import type { SystemsData } from './systems/data';
import type { Vec3 } from './types';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const LBF = 4.448222;
const PSI = 6894.757;
/** 1 lb of fuel per lbf of thrust per hour, in kg/(N s). */
const TSFC = 0.45359237 / LBF / 3600;

/**
 * Supercritical section of the A320's wing (about 11 % on the flow normal to the sweep):
 * flat top, aft loading, a nose-down moment. The A320 reaches its drag divergence near Mach
 * 0.80 at its cruise lift, 0.72 normal to the 25° sweep.
 */
const WING_FOIL: AirfoilData = {
  liftSlope: 6.4,
  alpha0: -2.6 * DEG,
  separationPos: 13 * DEG,
  separationNeg: 12 * DEG,
  separationExponent: 10,
  reattachMargin: 4 * DEG,
  lagChords: 3,
  cd0: 0.0062,
  cdLift: 0.004,
  cm0: -0.09,
  plateLift: 1.0,
  plateDrag: 1.3,
  mach: { divergence: 0.73, thickness: 0.11 },
};

const TAIL_FOIL: AirfoilData = {
  liftSlope: 5.9,
  alpha0: 0,
  separationPos: 16 * DEG,
  separationNeg: 16 * DEG,
  separationExponent: 9,
  reattachMargin: 3 * DEG,
  lagChords: 3,
  cd0: 0.0068,
  cdLift: 0.006,
  cm0: 0,
  plateLift: 0.95,
  plateDrag: 1.2,
  mach: { divergence: 0.78, thickness: 0.1 },
};

// ---- wing: a kinked trapezoid that gives the published area and MAC ----
export const A320_HALF_SPAN = 34.1 / 2;
const ROOT_CHORD = 6.3;
const KINK_Y = 6.4;
const KINK_CHORD = 3.9;
const TIP_CHORD = 1.5;
const SWEEP = 25 * DEG;
/** Quarter chord at the mean aerodynamic chord's station sits a little behind the centre of gravity. */
const WING_X = 2.75;
const WING_Z = 1.25;
const DIHEDRAL = 5.1 * DEG;
const chordAt = (y: number) =>
  y <= KINK_Y
    ? ROOT_CHORD + ((KINK_CHORD - ROOT_CHORD) * y) / KINK_Y
    : KINK_CHORD + ((TIP_CHORD - KINK_CHORD) * (y - KINK_Y)) / (A320_HALF_SPAN - KINK_Y);
/** Wash-out from the root to the tip: the root stalls first, the ailerons keep working. */
const incidenceAt = (y: number) => (1.7 - (4.2 * y) / A320_HALF_SPAN) * DEG;
/** Strip edges along one half span: flaps on the first five, ailerons on the last two. */
const EDGES = [1.98, 4.2, KINK_Y, 8.8, 11.2, 13.4, 15.4, A320_HALF_SPAN];
const FLAP_STRIPS = 5;

function axes(incidence: number, dihedral: number): { chord: Vec3; lift: Vec3 } {
  const ci = Math.cos(incidence);
  const si = Math.sin(incidence);
  const cd = Math.cos(dihedral);
  const sd = Math.sin(dihedral);
  return { chord: v(ci, sd * si, -cd * si), lift: v(-si, sd * ci, -cd * ci) };
}

/** Area of the wing between two stations of one half, m². */
function panelArea(y0: number, y1: number) {
  // Piecewise linear chord: integrate exactly over the kink.
  const parts = y0 < KINK_Y && y1 > KINK_Y ? [y0, KINK_Y, y1] : [y0, y1];
  let a = 0;
  for (let i = 0; i < parts.length - 1; i++)
    a += ((chordAt(parts[i]!) + chordAt(parts[i + 1]!)) / 2) * (parts[i + 1]! - parts[i]!);
  return a;
}

const SLAT: StripControl = { kind: 'slat', effectiveness: 0.45 };
const INNER_FLAP: StripControl = { kind: 'flap', effectiveness: 0.68, extension: 0.3 };
const OUTER_FLAP: StripControl = { kind: 'flap', effectiveness: 0.63, extension: 0.25 };

function wingStrips(): StripDef[] {
  const strips: StripDef[] = [];
  const centre = axes(1.9 * DEG, 0);
  strips.push({
    name: 'wing-centre',
    group: 0,
    position: v(WING_X + 0.6, 0, WING_Z),
    chordAxis: centre.chord,
    liftAxis: centre.lift,
    area: 2 * panelArea(0, EDGES[0]!),
    chord: ROOT_CHORD,
    foil: WING_FOIL,
    liftFactor: 0.8,
    slipstreamDevelopment: 0,
    sweep: SWEEP,
  });
  for (const side of [-1, 1]) {
    for (let i = 0; i < EDGES.length - 1; i++) {
      const y0 = EDGES[i]!;
      const y1 = EDGES[i + 1]!;
      const yc = (y0 + y1) / 2;
      const ax = axes(incidenceAt(yc), side > 0 ? -DIHEDRAL : DIHEDRAL);
      const controls: StripControl[] = [];
      if (i > 0) controls.push(SLAT);
      if (i < FLAP_STRIPS) {
        controls.push(i < 2 ? INNER_FLAP : OUTER_FLAP);
        // Spoiler 1 is a speed brake and ground spoiler only; 2 to 5 also roll.
        controls.push(
          i === 0
            ? { kind: 'spoiler', effectiveness: 1, side }
            : { kind: 'spoiler', effectiveness: 1, side, roll: 0.9 },
        );
      } else controls.push({ kind: 'aileron', effectiveness: 0.42, side });
      strips.push({
        name: `wing-${side > 0 ? 'right' : 'left'}-${i}`,
        group: side > 0 ? 1 : 2,
        position: v(
          WING_X - yc * Math.tan(SWEEP),
          side * yc,
          WING_Z - yc * Math.tan(DIHEDRAL),
        ),
        chordAxis: ax.chord,
        liftAxis: ax.lift,
        area: panelArea(y0, y1),
        chord: chordAt(yc),
        foil: WING_FOIL,
        slipstreamDevelopment: 0,
        sweep: SWEEP,
        controls,
      });
    }
  }
  return strips;
}

// ---- tail: a low-set trimmable stabiliser (31 m², span 12.45 m) and the fin (21.5 m²) ----
const TAIL_X = -17.4;

function tailStrips(): StripDef[] {
  const h = axes(0, 0);
  const strips: StripDef[] = [];
  for (const side of [-1, 1])
    strips.push({
      name: `stabiliser-${side > 0 ? 'right' : 'left'}`,
      group: 3,
      position: v(TAIL_X, side * 3.3, -0.6),
      chordAxis: h.chord,
      liftAxis: h.lift,
      area: 31 / 2,
      chord: 2.6,
      foil: TAIL_FOIL,
      qFactor: 0.92,
      control: { kind: 'elevator', effectiveness: 0.42 },
      downwash: true,
      slipstreamDevelopment: 0,
      sweep: 29 * DEG,
    });
  const fin = { chord: v(1, 0, 0), lift: v(0, -1, 0) };
  strips.push({
    name: 'fin-lower',
    group: 4,
    position: v(-16.2, 0, -3.0),
    chordAxis: fin.chord,
    liftAxis: fin.lift,
    area: 12.5,
    chord: 4.6,
    foil: TAIL_FOIL,
    qFactor: 0.95,
    control: { kind: 'rudder', effectiveness: 0.4 },
    slipstreamDevelopment: 0,
    sweep: 34 * DEG,
  });
  strips.push({
    name: 'fin-upper',
    group: 4,
    position: v(-18.2, 0, -5.6),
    chordAxis: fin.chord,
    liftAxis: fin.lift,
    area: 9,
    chord: 2.8,
    foil: TAIL_FOIL,
    qFactor: 0.98,
    control: { kind: 'rudder', effectiveness: 0.4 },
    slipstreamDevelopment: 0,
    sweep: 34 * DEG,
  });
  return strips;
}

const strips = [...wingStrips(), ...tailStrips()];
const vane = strips.findIndex((s) => s.name === 'wing-left-1');

/**
 * Thrust lever detents on the 0..1 travel (cockpitA320.ts): idle, CLB, FLX/MCT, TOGA.
 * Between idle and CLB the lever is the manual thrust range.
 */
export const A320_DETENTS = { idle: 0, climb: 0.62, mct: 0.82, toga: 1 } as const;

/**
 * CFM56-5B4. Rated thrust and the flat rating are the certificate's; the consumption follows
 * the published 0.335 lb/lbf/h at sea level static and about 0.55 at cruise, raised by a few
 * per cent for the installation (bleed air and generator loads). Idle 19.5 % N1 / 58.5 % N2
 * (FCOM, from memory), take-off at about 95 % N1 at sea level ISA. The engine control's
 * rating schedule puts the climb rating at the CLB detent and the maximum continuous at
 * FLX/MCT.
 */
const CFM56_5B4: TurbofanDef['engine'] = {
  ratedThrust: 27_000 * LBF,
  throttleRatio: 1.052,
  temperatureLapse: 3.5,
  machLapse: 0.35,
  n1Rpm: 5000,
  n1Max: 0.95,
  n1Idle: 0.195,
  n2Max: 0.99,
  n2Idle: 0.585,
  thrust: [
    [0.2, 0.06],
    [0.4, 0.14],
    [0.6, 0.3],
    [0.75, 0.5],
    [0.85, 0.7],
    [1, 1],
    [1.1, 1.18],
  ],
  tsfc: [0.37 * TSFC, 0.46 * TSFC],
  idleFuel: 0.04,
  egt: [
    [0.5, 610],
    [0.59, 670],
    [0.8, 820],
    [1, 1010],
    [1.06, 1090],
  ],
  spool: { idle: 2.5, high: 0.8, accel: 0.09, decel: 0.12 },
  reverser: { time: 2, share: 0.3, n1: 0.8 },
  start: {
    starterN2: 0.28,
    starterTime: 7,
    lightOffN2: 0.16,
    lightOffDelay: 3,
    cutoutN2: 0.5,
    accel: 0.0105,
    peakEgt: 960,
  },
  angularMomentum: 1500,
  lever: [
    [0, 0],
    [A320_DETENTS.climb, 0.918],
    [A320_DETENTS.mct, 0.968],
    [A320_DETENTS.toga, 1],
  ],
};

const engine = (side: number): TurbofanDef => ({
  kind: 'turbofan',
  position: v(1.6, side * 5.75, 1.85),
  engine: CFM56_5B4,
});

/**
 * Tyre bristles: a cornering stiffness (stiffness times the 0.35 m relaxation length) of
 * about 10 kN per degree for a main gear's two 46 in tyres and 3 kN per degree for the nose
 * pair, typical of transport tyres (ESDU 82012 order of magnitude, not a manufacturer figure).
 */
const MAIN_TYRES = { stiffness: 1_600_000, damping: 40_000 };
const NOSE_TYRES = { stiffness: 500_000, damping: 15_000 };

/** Usable fuel, kg: two wing tanks and the centre tank (23 860 l at 0.785 kg/l). */
export const A320_TANKS = { wing: 6127, centre: 6476 } as const;
export const A320_FUEL = 2 * A320_TANKS.wing + A320_TANKS.centre;

const A320_SYSTEMS: SystemsData = {
  // Two 23 Ah batteries on the DC battery bus, the integrated drive generators on the
  // engines (here as what their transformer-rectifiers give the DC side). The APU generator
  // and external power are the system computers' (a320/computers.ts): they keep the
  // batteries charged. Consumer currents are typical, not manual figures.
  electrical: {
    batteries: [
      { switch: 'battery', ampHours: 23, resistance: 0.03, fullVolts: 27.5, lowVolts: 24 },
      { switch: 'battery2', ampHours: 23, resistance: 0.03, fullVolts: 27.5, lowVolts: 24 },
    ],
    generators: [
      {
        switch: 'generator1',
        engine: 0,
        volts: 28,
        amps: 200,
        cutIn: 50,
        full: 55,
        failure: 'alternator',
      },
      { switch: 'generator2', engine: 1, volts: 28, amps: 200, cutIn: 50, full: 55 },
    ],
    lowVolts: 25,
    avionicsMinVolts: 20,
    busMinVolts: 18,
    avionicsSwitch: 'battery',
    loads: {
      base: 25,
      avionics: 45,
      flapsMotor: 0,
      starter: 0,
      switched: [
        { control: 'lightBeacon', amps: 2 },
        { control: 'lightNav', amps: 2 },
        { control: 'lightLanding', amps: 10 },
        { control: 'lightStrobe', amps: 3 },
        { control: 'lightWing', amps: 2 },
        { control: 'lightRunwayTurnoff', amps: 3 },
      ],
    },
  },
  fuel: {
    tankUsable: A320_TANKS.wing,
    tankArm: 6,
    tanks: [
      // Wings first: the generic left and right gauges read the first two.
      { id: 'left', usable: A320_TANKS.wing, position: { x: -0.4, y: -6, z: 1.3 } },
      { id: 'right', usable: A320_TANKS.wing, position: { x: -0.4, y: 6, z: 1.3 } },
      { id: 'centre', usable: A320_TANKS.centre, position: { x: 0.8, y: 0, z: 1.6 } },
    ],
    // FCOM: the wing tank low level warning at 750 kg in a wing.
    lowFuel: 750,
    // Each engine draws its own wing and the centre tank (a320/systems.ts sorts out which).
    engineFeeds: [
      [0, 2],
      [1, 2],
    ],
    leakRate: 2,
    lineFuel: 2,
    pumps: [
      { control: 'fuelPumpsLeft', amps: 8 },
      { control: 'fuelPumpsRight', amps: 8 },
      { control: 'fuelPumpsCenter', amps: 8 },
    ],
  },
  engine: {
    kind: 'turbine',
    // The start is pneumatic and automatic (a320/computers.ts); no switch of the generic kind.
    starter: '',
    ignition: '',
    oilPressure: 70,
    normalSpeed: 60,
    lowOilPressure: 13,
    oilTemperature: 90,
  },
  icing: { iceMass: 1200, probeHeat: { control: 'probeHeat', auto: true } },
  // Green moves the gear; the power transfer unit keeps it pressurised from yellow (engine 2).
  hydraulics: [
    {
      id: 'green',
      pressure: 3000,
      enginePumps: [
        { engine: 0, minSpeed: 40 },
        { engine: 1, minSpeed: 40 },
      ],
    },
  ],
  pressurisation: {
    maxDifferential: 8.06 * PSI,
    climbRate: (500 * FT) / 60,
    descentRate: (350 * FT) / 60,
    warning: 9550 * FT,
    bleedPower: 0,
    ecs: 'pack1',
    mode: 'cabinDump',
    cabinAltitude: 'cabinAltitude',
  },
  failures: ['engine', 'alternator', 'pitot', 'fuelLeak', 'com1'],
};

export const A320_AVIONICS: AvionicsConfig = {
  autopilot: () => new A320Fmgc(),
  navSources: ['nav1', 'gps', 'nav2'],
};

const identity = [
  [0, 0],
  [400, 400],
] as const;

/** Operating empty mass (AC), and the payload that makes MTOW with the tanks full. */
export const A320_OEW = 42_400;
export const A320_MTOW = 73_500;
export const A320_MLW = 64_500;

export const A320: AircraftDefinition = {
  info: {
    id: 'a320',
    name: 'Airbus A320-214',
    engines: 2,
    // VS1g at MTOW: clean about 168 kt, CONF FULL about 115 kt (the stall speeds of the tests at 60 t scaled).
    vs: 168 * KT,
    vs0: 115 * KT,
    vne: 350 * KT,
    maxTakeoffMass: A320_MTOW,
    retractableGear: true,
    category: 'airliner',
    speedbrake: true,
    reverse: true,
    vApproach: 137 * KT,
    vRotate: 145 * KT,
    specs: {
      maker: 'Airbus, Toulouse',
      powerplant: 'Two CFM International CFM56-5B4, 27 000 lbf (120 kN) each',
      span: 34.1,
      length: 37.57,
      height: 11.76,
      emptyMass: A320_OEW,
      // Mach 0.78 at FL 370: 447 KTAS.
      cruiseSpeed: 447 * KT,
      maxSpeed: 350 * KT,
      maxMach: 0.82,
      ceiling: 39_800 * FT,
      range: 3300 * 1852,
      climbRate: (2500 * FT) / 60,
      takeoffRoll: 1700,
      landingRoll: 1000,
      seats: 150,
      firstFlight: 1987,
    },
  },
  mass: A320_MTOW - A320_FUEL,
  fuelCapacity: A320_FUEL,
  // Radii of gyration of twin-engined transports (Roskam, Airplane Design part V): 0.246,
  // 0.38 and 0.443 of half span, half length and the mean of both, at about 65 t.
  inertia: v(1_150_000, 3_300_000, 4_200_000),
  wingArea: 122.6,
  wingSpan: 34.1,
  meanChord: 4.19,
  groups: [
    { name: 'wing-centre', aspectRatio: 9.48, oswald: 0.8, span: 34.1, inducedFrom: [0, 1, 2] },
    { name: 'wing-right', aspectRatio: 9.48, oswald: 0.8, span: 34.1 },
    { name: 'wing-left', aspectRatio: 9.48, oswald: 0.8, span: 34.1 },
    { name: 'stabiliser', aspectRatio: 5.0, oswald: 0.85, span: 12.45 },
    { name: 'fin', aspectRatio: 1.6, oswald: 0.8, span: 5.9 },
  ],
  strips,
  wingGroups: [0, 1, 2],
  downwashFactor: 1,
  tailArm: 17.5,
  // Airbus has no stall warning in normal law; the vane only feeds the computers.
  stallWarning: { strip: vane, alpha: 40 * DEG },
  wingRoot: { strength: 0, radius: 2 },
  fuselage: {
    dragArea: 1.55,
    dragPoint: v(0, 0, 0.4),
    sideArea: 140,
    planArea: 140,
    crossflowCd: 0.5,
    front: v(8, 0, 0),
    rear: v(-12, 0, -0.5),
    frontShare: 0.4,
    pitchMunk: 0.9,
    yawMunk: 0.13,
    machDrag: { critical: 0.8, rise: 0.4 },
  },
  engines: [engine(-1), engine(1)],
  controls: {
    elevatorUp: 30 * DEG,
    elevatorDown: 17 * DEG,
    aileronUp: 25 * DEG,
    aileronDown: 25 * DEG,
    rudder: 30 * DEG,
    trim: 'stabiliser',
    trimUp: 13.5 * DEG,
    trimDown: 4 * DEG,
    // Rudder trim ±20° of the 30° travel.
    yawTrim: 20 / 30,
    flapDetents: [0, 10 * DEG, 15 * DEG, 20 * DEG, 35 * DEG],
    slatDetents: [0, 18 * DEG, 22 * DEG, 22 * DEG, 27 * DEG],
    // Flaps run out to FULL in about 20 s.
    flapRate: (35 * DEG) / 20,
    surfaceRate: 1.2,
    holdLimitPressure: Infinity,
    aileronRigging: 0,
    rudderRigging: 0,
    stallShift: 0.35,
    flapDrag: 0.07,
    spoilerDrag: 0.12,
    spoilerRate: 1.5,
  },
  gear: {
    extendTime: 12,
    retractTime: 10,
    power: 'green',
    dragArea: 2.2,
    dragPoint: v(-0.5, 0, 3.0),
    vlo: 250 * KT,
    vle: 280 * KT,
  },
  controlLaw: (def) => new A320Computers(def),
  limits: {
    vmo: 350 * KT,
    mmo: 0.82,
    vfe: [Infinity, 215 * KT, 200 * KT, 185 * KT, 177 * KT],
    egt: 950 + 273.15,
    n1: 104,
    ng: 105,
  },
  wheels: [
    {
      name: 'nose',
      position: v(11.25, 0, 3.4),
      travel: 0.35,
      spring: 320_000,
      damper: 45_000,
      // The tiller turns it 75°; the pedals 6° (the computers schedule it).
      steering: 75 * DEG,
      breakingForce: 700_000,
      tyre: NOSE_TYRES,
    },
    {
      name: 'left',
      position: v(-1.4, -3.795, 3.4),
      travel: 0.45,
      spring: 1_150_000,
      damper: 140_000,
      brake: 'left',
      brakeForce: 240_000,
      breakingForce: 2_200_000,
      tyre: MAIN_TYRES,
    },
    {
      name: 'right',
      position: v(-1.4, 3.795, 3.4),
      travel: 0.45,
      spring: 1_150_000,
      damper: 140_000,
      brake: 'right',
      brakeForce: 240_000,
      breakingForce: 2_200_000,
      tyre: MAIN_TYRES,
    },
  ],
  contacts: [
    { name: 'belly-front', position: v(8, 0, 2.0), crashSpeed: 3, maxDepth: 0.8, reason: 'ground', skid: true },
    { name: 'belly-rear', position: v(-6, 0, 2.0), crashSpeed: 3, maxDepth: 0.8, reason: 'ground', skid: true },
    // Tail strike at about 11.7° with the struts compressed (AC: clearance angles).
    { name: 'tail', position: v(-16, 0, 0.45), crashSpeed: 4, maxDepth: 0.6, reason: 'tail', skid: true },
    { name: 'engine-left', position: v(3, -5.75, 2.85), crashSpeed: 2, maxDepth: 0.4, reason: 'engine' },
    { name: 'engine-right', position: v(3, 5.75, 2.85), crashSpeed: 2, maxDepth: 0.4, reason: 'engine' },
    {
      name: 'left-wingtip',
      position: v(-5.2, -A320_HALF_SPAN, WING_Z - A320_HALF_SPAN * Math.tan(DIHEDRAL)),
      crashSpeed: 0,
      reason: 'wing',
    },
    {
      name: 'right-wingtip',
      position: v(-5.2, A320_HALF_SPAN, WING_Z - A320_HALF_SPAN * Math.tan(DIHEDRAL)),
      crashSpeed: 0,
      reason: 'wing',
    },
    { name: 'nose-cone', position: v(17.5, 0, 1.5), crashSpeed: 0, reason: 'ground' },
  ],
  // CS 25.337: limit load factor +2.5 / -1 g, ultimate 1.5 times.
  ultimateLoad: { positive: 3.75, negative: -1.5 },
  airspeedCalibration: [identity, identity, identity, identity, identity],
  systems: A320_SYSTEMS,
  cockpit: A320_CONTROLS,
  avionics: A320_AVIONICS,
};

/** The A320 with another payload (kg above the operating empty mass, crew included). */
export function a320WithPayload(payload: number): AircraftDefinition {
  return { ...A320, mass: A320_OEW + payload };
}

/** Configurations of the flap lever's positions, and VFE of each (FCOM), knots. */
export const A320_CONFIGS = ['0', '1', '1+F', '2', '3', 'FULL'] as const;
export const A320_VFE: Record<string, number> = {
  '0': 350,
  '1': 230,
  '1+F': 215,
  '2': 200,
  '3': 185,
  FULL: 177,
};
export const A320_SLATS_FLAPS: Record<string, [number, number]> = {
  '0': [0, 0],
  '1': [18, 0],
  '1+F': [18, 10],
  '2': [22, 15],
  '3': [22, 20],
  FULL: [27, 35],
};
