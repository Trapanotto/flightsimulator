/**
 * Pilatus PC-12 NG (PC-12/47E). Published figures, with their sources:
 *
 * - EASA type certificate data sheet A.089 and the Pilatus PC-12 NG brochure: MTOW 4740 kg,
 *   span 16.28 m, length 14.40 m, height 4.26 m, wing area 25.81 m²; Pratt & Whitney Canada
 *   PT6A-67P flat-rated to 1200 shp (894.8 kW) at 1700 propeller rpm (torque limit 44.34 psi);
 *   five-blade Hartzell propeller, 2.67 m; usable fuel 1227 kg (402 US gal of Jet A at
 *   6.75 lb/gal: 2 × 613.5 kg in the wings).
 * - Pilot's Information Manual (PC-12/47E), section 2: VMO 240 KIAS, MMO 0.48; VFE 165 KIAS
 *   flaps 15, 130 KIAS flaps 30, 117 KIAS flaps 40; VLO / VLE 180 KIAS (gear operating
 *   and extended); flaps 0 / 15 / 30 / 40; maximum ITT 820 °C in flight, 1000 °C for 5 s at
 *   the start; Ng 104 %; Np 1700 rpm; maximum cabin differential 5.75 psi; 30 000 ft maximum
 *   operating altitude; stick shaker and pusher.
 * - Section 5 (performance, as given in the brochure and the task): take-off ground roll about
 *   450 m and 793 m over 50 ft at MTOW, sea level ISA; rate of climb 1920 ft/min at sea level;
 *   maximum cruise about 280 KTAS between FL 200 and FL 250; stall 93 KCAS clean and 67 KCAS
 *   flaps 40 at MTOW; landing 558 m over 50 ft, ground roll about 370 m with reverse; glide
 *   about 16:1 with the propeller feathered.
 *
 * Where no figure is published (strip layout, inertia, gear rates, the engine's corrected map,
 * the blade element of the propeller) the values are typical for the class and tuned against
 * the published performance in tests/sim/pc12.*.test.ts.
 */
import type { AirfoilData } from './airfoil';
import type { AvionicsConfig } from './avionics/config';
import { PC12_CONTROLS } from './cockpitPc12';
import type { AircraftDefinition, StripDef } from './definition';
import { DEG, FT, KT } from './math';
import type { TurbopropDef } from './propulsion';
import type { SystemsData } from './systems/data';
import type { Vec3 } from './types';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const SHP = 745.7;
const PSI = 6894.757;
const RPM = (2 * Math.PI) / 60;

/** A thick, aft-loaded natural-laminar section of the GA(W) family (the PC-12's wing is about 17 %). */
const WING_FOIL: AirfoilData = {
  liftSlope: 6.1,
  alpha0: -3.5 * DEG,
  separationPos: 11 * DEG,
  separationNeg: 13 * DEG,
  separationExponent: 9,
  reattachMargin: 4 * DEG,
  lagChords: 3,
  cd0: 0.0062,
  cdLift: 0.007,
  cm0: -0.07,
  plateLift: 1.0,
  plateDrag: 1.3,
  // Korn's relation for a conventional 17 % section at its cruise lift: Mdd ≈ 0.87 - t/c - cl/10.
  mach: { divergence: 0.67, thickness: 0.17 },
};

const TAIL_FOIL: AirfoilData = {
  liftSlope: 5.8,
  alpha0: 0,
  separationPos: 15 * DEG,
  separationNeg: 15 * DEG,
  separationExponent: 9,
  reattachMargin: 3 * DEG,
  lagChords: 3,
  cd0: 0.0075,
  cdLift: 0.006,
  cm0: 0,
  plateLift: 0.95,
  plateDrag: 1.2,
  mach: { divergence: 0.75, thickness: 0.12 },
};

/** Propeller blade section at 3/4 radius (thin, cambered). */
const BLADE_FOIL: AirfoilData = {
  liftSlope: 5.8,
  alpha0: -2 * DEG,
  separationPos: 14 * DEG,
  separationNeg: 12 * DEG,
  separationExponent: 7,
  reattachMargin: 2 * DEG,
  lagChords: 2,
  cd0: 0.011,
  cdLift: 0.009,
  cm0: 0,
  plateLift: 1.0,
  plateDrag: 1.3,
};

// Wing: tapered from a 2.11 m root to a 1.06 m tip (taper 0.5), which gives the published area.
const HALF_SPAN = 16.28 / 2;
const ROOT_CHORD = 2.114;
const TIP_CHORD = 1.057;
const WING_X = 0.12;
const WING_Z = 0.55;
const DIHEDRAL = 3 * DEG;
const chordAt = (y: number) => ROOT_CHORD + ((TIP_CHORD - ROOT_CHORD) * y) / HALF_SPAN;
/** 3° at the root washing out to 1° at the tip: the root stalls first. */
const incidenceAt = (y: number) => (3 - (2 * y) / HALF_SPAN) * DEG;
/** Strip edges along one half span: Fowler flaps on the first four, ailerons on the last three. */
const EDGES = [0.75, 1.85, 2.95, 4.05, 5.2, 6.2, 7.2, HALF_SPAN];
const FLAP_STRIPS = 4;

function axes(incidence: number, dihedral: number): { chord: Vec3; lift: Vec3 } {
  const ci = Math.cos(incidence);
  const si = Math.sin(incidence);
  const cd = Math.cos(dihedral);
  const sd = Math.sin(dihedral);
  return { chord: v(ci, sd * si, -cd * si), lift: v(-si, sd * ci, -cd * ci) };
}

function wingStrips(): StripDef[] {
  const strips: StripDef[] = [];
  const centre = axes(3 * DEG, 0);
  strips.push({
    name: 'wing-centre',
    group: 0,
    position: v(WING_X, 0, WING_Z),
    chordAxis: centre.chord,
    liftAxis: centre.lift,
    area: 2 * EDGES[0]! * chordAt(EDGES[0]! / 2),
    chord: ROOT_CHORD,
    foil: WING_FOIL,
    liftFactor: 0.75,
    slipstreamDevelopment: 0.5,
  });
  for (const side of [-1, 1]) {
    for (let i = 0; i < EDGES.length - 1; i++) {
      const y0 = EDGES[i]!;
      const y1 = EDGES[i + 1]!;
      const yc = (y0 + y1) / 2;
      const chord = chordAt(yc);
      const ax = axes(incidenceAt(yc), side > 0 ? -DIHEDRAL : DIHEDRAL);
      const strip: StripDef = {
        name: `wing-${side > 0 ? 'right' : 'left'}-${i}`,
        group: side > 0 ? 1 : 2,
        position: v(WING_X, side * yc, WING_Z - yc * Math.tan(DIHEDRAL)),
        chordAxis: ax.chord,
        liftAxis: ax.lift,
        area: (y1 - y0) * chord,
        chord,
        foil: WING_FOIL,
        slipstreamDevelopment: 0.5,
      };
      if (i < FLAP_STRIPS) strip.control = { kind: 'flap', effectiveness: 0.72, extension: 0.3 };
      else strip.control = { kind: 'aileron', effectiveness: 0.45, side };
      strips.push(strip);
    }
  }
  return strips;
}

// T-tail: the tailplane sits on top of the fin, out of the slipstream and above the wake.
const TAIL_X = -7.6;
const TAIL_Z = -2.55;

function tailStrips(): StripDef[] {
  const h = axes(1.5 * DEG, 0);
  const strips: StripDef[] = [];
  for (const side of [-1, 1])
    strips.push({
      name: `tailplane-${side > 0 ? 'right' : 'left'}`,
      group: 3,
      position: v(TAIL_X, side * 1.25, TAIL_Z),
      chordAxis: h.chord,
      liftAxis: h.lift,
      area: 4.9 / 2,
      chord: 0.98,
      foil: TAIL_FOIL,
      qFactor: 0.97,
      control: { kind: 'elevator', effectiveness: 0.5 },
      downwash: true,
      slipstreamDevelopment: 1,
    });
  const fin = { chord: v(1, 0, 0), lift: v(0, -1, 0) };
  strips.push({
    name: 'fin-lower',
    group: 4,
    position: v(-6.9, 0, -0.75),
    chordAxis: fin.chord,
    liftAxis: fin.lift,
    area: 2.6,
    chord: 2.0,
    foil: TAIL_FOIL,
    qFactor: 0.92,
    control: { kind: 'rudder', effectiveness: 0.45 },
    slipstreamDevelopment: 1,
  });
  strips.push({
    name: 'fin-upper',
    group: 4,
    position: v(-7.4, 0, -1.9),
    chordAxis: fin.chord,
    liftAxis: fin.lift,
    area: 1.9,
    chord: 1.5,
    foil: TAIL_FOIL,
    qFactor: 0.97,
    control: { kind: 'rudder', effectiveness: 0.45 },
    slipstreamDevelopment: 1,
  });
  return strips;
}

const strips = [...wingStrips(), ...tailStrips()];
const vane = strips.findIndex((s) => s.name === 'wing-left-4');

/**
 * PT6A-67P. The flat rating (1200 shp at 1700 rpm) is the published figure; the corrected
 * gas generator map is shaped so that the take-off point at sea level ISA lands near the
 * usual 94-95 % Ng and 700-720 °C ITT, and so that the 820 °C ITT limit caps the power from
 * about FL 150 at ISA, as the handbook's cruise tables show. The specific consumption runs
 * from 0.56 lb/shp/h at take-off to about 0.45 at high corrected speeds.
 */
const PT6A_67P: TurbopropDef['engine'] = {
  ratedPower: 1200 * SHP,
  propRpm: 1700,
  maxNg: 1.04,
  groundIdleNg: 0.63,
  flightIdleNg: 0.66,
  power: [
    [0.4, 0],
    [0.55, 25 * SHP],
    [0.63, 60 * SHP],
    [0.7, 140 * SHP],
    [0.8, 420 * SHP],
    [0.88, 800 * SHP],
    [0.94, 1200 * SHP],
    [1.0, 1650 * SHP],
    [1.06, 2100 * SHP],
    [1.12, 2550 * SHP],
    [1.2, 3100 * SHP],
  ],
  itt: [
    [0.4, 480 + 273.15],
    [0.63, 525 + 273.15],
    [0.7, 545 + 273.15],
    [0.8, 590 + 273.15],
    [0.88, 645 + 273.15],
    [0.94, 715 + 273.15],
    [1.0, 795 + 273.15],
    [1.06, 895 + 273.15],
    [1.12, 1005 + 273.15],
    [1.2, 1150 + 273.15],
  ],
  fuel: [
    [0.4, 30 / 3600],
    [0.63, 68 / 3600],
    [0.7, 92 / 3600],
    [0.8, 150 / 3600],
    [0.88, 225 / 3600],
    [0.94, 305 / 3600],
    [1.0, 370 / 3600],
    [1.06, 405 / 3600],
    [1.12, 440 / 3600],
    [1.2, 490 / 3600],
  ],
  ittLimit: 820 + 273.15,
  spool: { idle: 2.2, high: 0.9, accel: 0.12, decel: 0.15 },
  start: {
    starterNg: 0.2,
    starterTime: 4,
    lightOffNg: 0.13,
    lightOffDelay: 2.5,
    cutoutNg: 0.5,
    accel: 0.022,
    peakItt: 780 + 273.15,
  },
  inertia: 9,
  friction: 1.5,
  governor: { gain: 1.2, damping: 0.15 },
  reverse: { power: 0.55, rpm: 0.95 },
  separatorLoss: 0.035,
  featherNg: 0.45,
};

export const PC12_ENGINE: TurbopropDef = {
  kind: 'turboprop',
  position: v(4.95, 0, 0.15),
  engine: PT6A_67P,
  propeller: {
    kind: 'variable',
    diameter: 2.67,
    blades: 5,
    chord: 0.2,
    hubRatio: 0.2,
    foil: BLADE_FOIL,
    efficiency: 0.9,
    inducedFactor: 1.6,
    criticalMach: 0.74,
    reverse: -12 * DEG,
    ground: 1 * DEG,
    fine: 9 * DEG,
    feather: 86 * DEG,
    pitchRate: 12 * DEG,
    swirlFactor: 0.3,
  },
};

/** Jet A as the weight and balance counts it, 6.75 lb per US gallon. */
const TANK = 613.5;

const PC12_SYSTEMS: SystemsData = {
  // PIM section 7: 24 V 42 Ah main battery, 300 A starter-generator, 115 A standby
  // alternator, both on the accessory gearbox (gas generator speed); the second battery is
  // the standby one. Consumer currents are typical, not handbook figures.
  electrical: {
    batteries: [
      { switch: 'battery', ampHours: 42, resistance: 0.012, fullVolts: 24.8, lowVolts: 23.84 },
      { switch: 'battery2', ampHours: 10, resistance: 0.05, fullVolts: 24.8, lowVolts: 23.84 },
    ],
    generators: [
      {
        switch: 'generator1',
        engine: 0,
        volts: 28.2,
        amps: 300,
        cutIn: 52,
        full: 60,
        failure: 'alternator',
      },
      { switch: 'generator2', engine: 0, volts: 28, amps: 115, cutIn: 52, full: 62 },
    ],
    lowVolts: 24.5,
    avionicsMinVolts: 20,
    busMinVolts: 16,
    avionicsSwitch: 'avionics',
    loads: {
      base: 12,
      avionics: 25,
      flapsMotor: 15,
      starter: 450,
      gearMotor: 60,
      switched: [
        { control: 'lightPanel', amps: 3 },
        { control: 'lightCabin', amps: 4 },
        { control: 'lightBeacon', amps: 2 },
        { control: 'lightStrobe', amps: 4 },
        { control: 'lightNav', amps: 2 },
        { control: 'lightLanding', amps: 8 },
        { control: 'lightTaxi', amps: 5 },
        { control: 'lightRecognition', amps: 4 },
        { control: 'lightIce', amps: 2 },
        { control: 'pitotHeat', amps: 10 },
        { control: 'propDeice', amps: 30 },
        { control: 'windshieldHeat', amps: 25 },
        { control: 'ecs', amps: 8 },
      ],
    },
  },
  fuel: {
    tankUsable: TANK,
    tankArm: 2.9,
    // PIM: the low fuel caution lights with about 66 kg left in a wing.
    lowFuel: 66,
    leakRate: 40 / 3600,
    lineFuel: 0.15,
    shutoff: 'fuelShutoff',
    // The automatic fuel balancing runs the boost pump of the heavier side.
    balance: 15,
    pumps: [
      { control: 'fuelPumpLeft', amps: 7 },
      { control: 'fuelPumpRight', amps: 7 },
    ],
  },
  engine: {
    kind: 'turbine',
    starter: 'starter',
    ignition: 'ignition',
    separator: 'inertialSeparator',
    // PT6A-67P: oil pressure 90 to 135 psi, red below 60 psi; warm oil about 75 °C.
    oilPressure: 110,
    normalSpeed: 72,
    lowOilPressure: 60,
    oilTemperature: 75,
  },
  icing: { iceMass: 120, boots: { control: 'bootsDeice', cycles: [0, 180, 60] } },
  // An electrically driven hydraulic power pack runs only while the gear moves.
  hydraulics: [{ id: 'gear', pressure: 1800, electricPump: 60 }],
  pressurisation: {
    maxDifferential: 5.75 * PSI,
    climbRate: (500 * FT) / 60,
    descentRate: (300 * FT) / 60,
    warning: 10_000 * FT,
    // ECS bleed off the compressor, about 40 shp of shaft power.
    bleedPower: 40 * SHP,
    ecs: 'ecs',
    mode: 'pressurisation',
    cabinAltitude: 'cabinAltitude',
  },
  failures: ['engine', 'alternator', 'pitot', 'fuelLeak', 'com1'],
};

export const PC12_AVIONICS: AvionicsConfig = {
  autopilot: 'flightDirector',
  navSources: ['nav1', 'gps', 'nav2'],
};

const identity = [
  [0, 0],
  [300, 300],
] as const;

export const PC12: AircraftDefinition = {
  info: {
    id: 'pc12',
    name: 'Pilatus PC-12 NG',
    engines: 1,
    // Stall speeds at MTOW (handbook, KCAS ≈ KIAS here): clean 93, flaps 40 67; VMO 240 KIAS.
    vs: 93 * KT,
    vs0: 67 * KT,
    vne: 240 * KT,
    maxTakeoffMass: 4740,
    retractableGear: true,
    category: 'turboprop',
    speedbrake: false,
    reverse: true,
    // Approach in landing configuration about 1.3 VS0; rotation at MTOW with flaps 15.
    vApproach: 85 * KT,
    vRotate: 83 * KT,
    specs: {
      maker: 'Pilatus Aircraft, Stans',
      powerplant: 'Pratt & Whitney Canada PT6A-67P, 1200 shp',
      span: 16.28,
      length: 14.4,
      height: 4.26,
      // Basic empty mass of a typical executive configuration.
      emptyMass: 3050,
      cruiseSpeed: 280 * KT,
      maxSpeed: 240 * KT,
      maxMach: 0.48,
      ceiling: 30_000 * FT,
      // Brochure: 1560 NM at maximum range with IFR reserves.
      range: 1560 * 1852,
      climbRate: (1920 * FT) / 60,
      takeoffRoll: 450,
      landingRoll: 370,
      seats: 11,
      firstFlight: 1991,
    },
  },
  // MTOW with the full 1227 kg of usable fuel: crew, cabin and baggage make up the rest.
  mass: 4740 - 2 * TANK,
  fuelCapacity: 2 * TANK,
  // Radii of gyration of single-engine turboprops (Roskam, Airplane Design part V): 0.25 b/2,
  // 0.34 L/2, 0.39 (b + L)/4.
  inertia: v(19_300, 28_000, 43_000),
  wingArea: 25.81,
  wingSpan: 16.28,
  meanChord: 1.644,
  groups: [
    { name: 'wing-centre', aspectRatio: 10.27, oswald: 0.8, span: 16.28, inducedFrom: [0, 1, 2] },
    { name: 'wing-right', aspectRatio: 10.27, oswald: 0.8, span: 16.28 },
    { name: 'wing-left', aspectRatio: 10.27, oswald: 0.8, span: 16.28 },
    // The fin is an end plate for the T-tail's tailplane, and the tailplane for the fin.
    { name: 'tailplane', aspectRatio: 5.4, oswald: 0.85, span: 5.0 },
    { name: 'fin', aspectRatio: 2.2, oswald: 0.8, span: 2.3 },
  ],
  strips,
  wingGroups: [0, 1, 2],
  // Above the wing's wake the T-tail sees less downwash than a low tail.
  downwashFactor: 0.85,
  tailArm: 7.7,
  stallWarning: { strip: vane, alpha: 30 * DEG },
  wingRoot: { strength: 0, radius: 0.8 },
  fuselage: {
    dragArea: 0.32,
    dragPoint: v(0.5, 0, 0.1),
    sideArea: 14,
    planArea: 11,
    crossflowCd: 0.6,
    front: v(2.2, 0, 0.1),
    rear: v(-4.2, 0, -0.2),
    frontShare: 0.45,
    pitchMunk: 0.28,
    yawMunk: 0.06,
  },
  engines: [PC12_ENGINE],
  controls: {
    elevatorUp: 22 * DEG,
    elevatorDown: 16 * DEG,
    aileronUp: 18 * DEG,
    aileronDown: 14 * DEG,
    rudder: 25 * DEG,
    // The stabiliser trims from 4° nose down to 7° nose up.
    trim: 'stabiliser',
    trimUp: 7 * DEG,
    trimDown: 4 * DEG,
    rollTrim: 0.1,
    yawTrim: 0.35,
    flapDetents: [0, 15 * DEG, 30 * DEG, 40 * DEG],
    // Electric flaps, about 14 s from up to 40°.
    flapRate: (40 * DEG) / 14,
    surfaceRate: 3,
    holdLimitPressure: 9000,
    aileronRigging: 0,
    rudderRigging: 0.06,
    stallShift: 0.2,
    flapDrag: 0.12,
  },
  gear: {
    extendTime: 7,
    retractTime: 8,
    power: 'gear',
    dragArea: 0.33,
    dragPoint: v(0, 0, 1.4),
    vlo: 180 * KT,
    vle: 180 * KT,
  },
  stallProtection: {
    // Vane angles (the outboard wing strip's local angle) for flaps 0 / 15 / 30 / 40.
    shaker: [7.1 * DEG, 4.6 * DEG, 2.8 * DEG, 1.6 * DEG],
    pusher: [8.9 * DEG, 6.5 * DEG, 4.8 * DEG, 3.6 * DEG],
    push: 0.8,
    release: 4 * DEG,
  },
  yawDamper: { gain: 0.9, washout: 2 },
  limits: {
    vmo: 240 * KT,
    mmo: 0.48,
    vfe: [Infinity, 165 * KT, 130 * KT, 117 * KT],
    // 44.34 psi is the torque limit; a few per cent are tolerated in transients.
    torque: 1.02,
    itt: 820 + 273.15 + 30,
    ng: 104.5,
    propRpm: 1700 * 1.03,
  },
  wheels: [
    {
      name: 'nose',
      position: v(4.4, 0, 1.95),
      travel: 0.22,
      spring: 70_000,
      damper: 8_000,
      steering: 15 * DEG,
      breakingForce: 60_000,
    },
    {
      name: 'left',
      position: v(-0.55, -2.26, 1.95),
      travel: 0.25,
      spring: 210_000,
      damper: 20_000,
      brake: 'left',
      brakeForce: 2_900,
      breakingForce: 130_000,
    },
    {
      name: 'right',
      position: v(-0.55, 2.26, 1.95),
      travel: 0.25,
      spring: 210_000,
      damper: 20_000,
      brake: 'right',
      brakeForce: 2_900,
      breakingForce: 130_000,
    },
  ],
  contacts: [
    // Wheels up, the propeller strikes first and the belly slides: wrecked engine, not a crash.
    {
      name: 'propeller',
      position: v(4.95, 0, 1.48),
      crashSpeed: 3,
      maxDepth: 0.8,
      reason: 'propeller',
      skid: true,
    },
    {
      name: 'belly-front',
      position: v(2.5, 0, 1.15),
      crashSpeed: 2.5,
      maxDepth: 0.6,
      reason: 'ground',
      skid: true,
    },
    {
      name: 'belly-rear',
      position: v(-2.0, 0, 1.1),
      crashSpeed: 2.5,
      maxDepth: 0.6,
      reason: 'ground',
      skid: true,
    },
    // Wheels up it rests on the propeller, the belly and the wing roots' flap fairings.
    {
      name: 'belly-left',
      position: v(-0.6, -1.3, 1.25),
      crashSpeed: 2.5,
      maxDepth: 0.6,
      reason: 'ground',
      skid: true,
    },
    {
      name: 'belly-right',
      position: v(-0.6, 1.3, 1.25),
      crashSpeed: 2.5,
      maxDepth: 0.6,
      reason: 'ground',
      skid: true,
    },
    { name: 'left-wingtip', position: v(-0.2, -HALF_SPAN, 0.12), crashSpeed: 0, reason: 'wing' },
    { name: 'right-wingtip', position: v(-0.2, HALF_SPAN, 0.12), crashSpeed: 0, reason: 'wing' },
    { name: 'tail', position: v(-6.4, 0, 1.0), crashSpeed: 6, maxDepth: 0.8, reason: 'tail' },
    { name: 'fin-top', position: v(-7.8, 0, -2.6), crashSpeed: 0, reason: 'ground' },
  ],
  // Normal category at 4740 kg: n = 2.1 + 24 000 / (W + 10 000) = 3.3 g (CS 23.337), times 1.5.
  ultimateLoad: { positive: 4.95, negative: -1.98 },
  airspeedCalibration: [identity, identity, identity, identity],
  systems: PC12_SYSTEMS,
  cockpit: PC12_CONTROLS,
  avionics: PC12_AVIONICS,
};

/** Torque in psi on the PC-12's gauge for a torque share (44.34 psi at the limit). */
export const torquePsi = (share: number) => share * 44.34;
/** The torque limit in N m: rated power at the governed propeller speed. */
export const PC12_TORQUE_LIMIT = (1200 * SHP) / (1700 * RPM);
