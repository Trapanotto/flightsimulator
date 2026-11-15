/**
 * Phase 4 fakes for the interface demo: the three new types as their `info` will look once
 * the simulation has them (published figures, SI units), their cockpit controls and engine
 * telemetry. `?fleet` adds them to AIRCRAFT; `?aircraft=pc12|a320|fa18` flies one.
 */
import {
  AIRCRAFT,
  type AircraftId,
  type AircraftInfo,
  type ControlSpec,
  type EngineTelemetry,
  PC12_CONTROLS,
  C172_CONTROLS,
} from '@sim';

const KT = 1852 / 3600;
const FT = 0.3048;
const FPM = FT / 60;
const LB = 0.45359237;

/** The Cessna as the sim agent will describe it (the figures of the POH). */
export const C172_EXTRA: Partial<AircraftInfo> = {
  category: 'piston',
  speedbrake: false,
  reverse: false,
  vRotate: 55 * KT,
  vApproach: 65 * KT,
  specs: {
    maker: 'Cessna Aircraft, Wichita',
    powerplant: 'Lycoming IO-360-L2A, 180 hp',
    span: 11.0,
    length: 8.28,
    height: 2.72,
    emptyMass: 1691 * LB,
    cruiseSpeed: 124 * KT,
    maxSpeed: 163 * KT,
    ceiling: 14_000 * FT,
    range: 640 * 1852,
    climbRate: 730 * FPM,
    takeoffRoll: 960 * FT,
    landingRoll: 575 * FT,
    seats: 4,
    firstFlight: 1955,
  },
};

export const FLEET: AircraftInfo[] = [
  {
    id: 'pc12',
    name: 'Pilatus PC-12 NG',
    engines: 1,
    vs: 87 * KT,
    vs0: 67 * KT,
    vne: 236 * KT,
    maxTakeoffMass: 4740,
    retractableGear: true,
    category: 'turboprop',
    speedbrake: false,
    reverse: true,
    vRotate: 85 * KT,
    vApproach: 85 * KT,
    specs: {
      maker: 'Pilatus Aircraft, Stans',
      powerplant: 'Pratt & Whitney Canada PT6A-67P, 1200 shp',
      span: 16.28,
      length: 14.4,
      height: 4.26,
      emptyMass: 3200,
      cruiseSpeed: 280 * KT,
      maxSpeed: 236 * KT,
      ceiling: 30_000 * FT,
      range: 1803 * 1852,
      climbRate: 1920 * FPM,
      takeoffRoll: 430,
      landingRoll: 290,
      seats: 11,
      firstFlight: 1991,
    },
  },
  {
    id: 'a320',
    name: 'Airbus A320-214',
    engines: 2,
    vs: 130 * KT,
    vs0: 107 * KT,
    vne: 350 * KT,
    maxTakeoffMass: 78_000,
    retractableGear: true,
    category: 'airliner',
    speedbrake: true,
    reverse: true,
    vRotate: 145 * KT,
    vApproach: 135 * KT,
    specs: {
      maker: 'Airbus, Toulouse',
      powerplant: '2 × CFM International CFM56-5B4, 120 kN',
      span: 34.1,
      length: 37.57,
      height: 11.76,
      emptyMass: 42_600,
      cruiseSpeed: 447 * KT,
      maxSpeed: 350 * KT,
      maxMach: 0.82,
      ceiling: 39_800 * FT,
      range: 3100 * 1852,
      climbRate: 2500 * FPM,
      takeoffRoll: 1700,
      landingRoll: 900,
      seats: 180,
      firstFlight: 1987,
    },
  },
  {
    id: 'fa18',
    name: 'Boeing F/A-18C Hornet',
    engines: 2,
    vs: 135 * KT,
    vs0: 115 * KT,
    vne: 700 * KT,
    maxTakeoffMass: 23_540,
    retractableGear: true,
    category: 'fighter',
    speedbrake: true,
    reverse: false,
    vRotate: 150 * KT,
    vApproach: 140 * KT,
    specs: {
      maker: 'McDonnell Douglas, St. Louis',
      powerplant: '2 × General Electric F404-GE-402, 79 kN',
      span: 11.43,
      length: 17.07,
      height: 4.66,
      emptyMass: 10_810,
      cruiseSpeed: 570 * KT,
      maxSpeed: 700 * KT,
      maxMach: 1.8,
      ceiling: 50_000 * FT,
      range: 1800 * 1852,
      climbRate: 50_000 * FPM,
      takeoffRoll: 430,
      landingRoll: 850,
      seats: 1,
      firstFlight: 1978,
    },
  },
];

/** Adds the fleet to the simulation's list (the demo's stand-in for the merged sim). */
export function installFleet() {
  const c172 = AIRCRAFT.find((a) => a.id === 'c172');
  if (c172) Object.assign(c172, C172_EXTRA);
  for (const f of FLEET) if (!AIRCRAFT.some((a) => a.id === f.id)) AIRCRAFT.push(f);
}

const button = (id: string): ControlSpec => ({ id, kind: 'button', initial: 0 });
const toggle = (id: string, initial = 0, running?: number): ControlSpec =>
  running === undefined
    ? { id, kind: 'toggle', initial }
    : { id, kind: 'toggle', initial, running };

/** The radios every type shares, taken from the Cessna's list. */
const RADIOS = C172_CONTROLS.filter((c) => /^(com|nav)[12]|^xpdr|^dmeSource/.test(c.id));

/**
 * An A320-like cockpit with names nobody has labelled yet (APU, engine masters, autobrake):
 * they must show readably in the group 'other' rather than break the panels.
 */
const A320_CONTROLS: ControlSpec[] = [
  toggle('battery', 0, 1),
  toggle('apuMaster'),
  button('apuStart'),
  toggle('apuBleed'),
  toggle('engineMaster1', 0, 1),
  toggle('engineMaster2', 0, 1),
  {
    id: 'engineModeSelector',
    kind: 'selector',
    positions: ['crank', 'norm', 'ignStart'],
    initial: 1,
  },
  { id: 'throttle', kind: 'lever', min: 0, max: 1, initial: 0 },
  { id: 'flaps', kind: 'selector', positions: ['0', '1', '2', '3', 'full'], initial: 0 },
  toggle('gear', 1),
  toggle('spoilerArm'),
  { id: 'autobrake', kind: 'selector', positions: ['off', 'lo', 'med', 'max'], initial: 0 },
  toggle('parkingBrake', 1, 0),
  toggle('lightBeacon'),
  toggle('lightStrobe'),
  toggle('lightLanding'),
  toggle('lightNav'),
  toggle('pitotHeat'),
  { id: 'altimeterSetting', kind: 'knob', min: 950, max: 1050, step: 1, initial: 1013 },
  ...RADIOS,
  button('apEngage'),
  button('flightDirector'),
  button('apHdg'),
  button('apNav'),
  button('apApr'),
  button('apAlt'),
  button('apVs'),
  button('apFlc'),
  button('apVsUp'),
  button('apVsDown'),
  button('apAthr'),
  { id: 'apAltitude', kind: 'knob', min: 0, max: 39_000, step: 100, initial: 5000 },
  { id: 'headingBug', kind: 'knob', min: 0, max: 359, step: 1, wraps: true, initial: 0 },
  { id: 'obs1', kind: 'knob', min: 0, max: 359, step: 1, wraps: true, initial: 0 },
];

const FA18_CONTROLS: ControlSpec[] = [
  toggle('battery', 0, 1),
  toggle('generator1', 0, 1),
  toggle('generator2', 0, 1),
  { id: 'throttle', kind: 'lever', min: 0, max: 1, initial: 0 },
  { id: 'flaps', kind: 'selector', positions: ['auto', 'half', 'full'], initial: 0 },
  toggle('gear', 1),
  toggle('launchBar'),
  toggle('arrestingHook'),
  toggle('parkingBrake', 1, 0),
  toggle('lightNav'),
  toggle('lightLanding'),
  toggle('pitotHeat'),
  { id: 'masterArm', kind: 'selector', positions: ['safe', 'arm'], initial: 0 },
  ...RADIOS,
  button('apEngage'),
  button('apHdg'),
  button('apAlt'),
  { id: 'apAltitude', kind: 'knob', min: 0, max: 50_000, step: 100, initial: 10_000 },
  { id: 'headingBug', kind: 'knob', min: 0, max: 359, step: 1, wraps: true, initial: 0 },
];

export const CONTROLS: Record<AircraftId, readonly ControlSpec[]> = {
  c172: C172_CONTROLS,
  pc12: PC12_CONTROLS,
  a320: A320_CONTROLS,
  fa18: FA18_CONTROLS,
};

/** Engines for a lever position, as each kind of engine reports them. */
export function engines(id: AircraftId, throttle: number, reverse: boolean): EngineTelemetry[] {
  switch (id) {
    case 'pc12':
      return [
        {
          running: true,
          rpm: 1700,
          propRpm: 1700,
          power: throttle,
          fuelFlow: 0.03 + throttle * 0.06,
          n2: 62 + throttle * 40,
          torque: 0.18 + throttle * 0.8,
          turbineTemperature: 520 + throttle * 230,
          reversing: reverse,
        },
      ];
    case 'a320':
      return [0, 1].map((i) => ({
        running: true,
        rpm: 0,
        power: throttle,
        fuelFlow: 0.2 + throttle * 0.8,
        n1: 21 + throttle * 64 + i * 0.3,
        n2: 58 + throttle * 38,
        turbineTemperature: 420 + throttle * 360,
        reversing: reverse,
      }));
    case 'fa18': {
      const ab = Math.max(0, (throttle - 0.85) / 0.15);
      return [0, 1].map((i) => ({
        running: true,
        rpm: 0,
        power: throttle + ab * 0.6,
        fuelFlow: 0.3 + throttle * 1.2 + ab * 4,
        n1: 65 + throttle * 34 + i * 0.4,
        n2: 70 + throttle * 30,
        turbineTemperature: 450 + throttle * 420,
        afterburner: ab,
        nozzle: 0.3 + ab * 0.7,
      }));
    }
    default:
      return [{ running: true, rpm: 800 + throttle * 1900, power: throttle, fuelFlow: 0.01 }];
  }
}

/** A flight in progress for each type: speed, height and what the HUD should show. */
export const FLYING: Record<
  AircraftId,
  { ias: number; altitude: number; mach?: number; throttle: number; flaps: number; gear: number }
> = {
  c172: { ias: 50.9, altitude: 1524, throttle: 0.78, flaps: 1 / 3, gear: 1 },
  pc12: { ias: 102, altitude: 4572, throttle: 0.82, flaps: 0, gear: 0 },
  a320: { ias: 141, altitude: 10_668, mach: 0.77, throttle: 0.86, flaps: 0, gear: 0 },
  fa18: { ias: 185, altitude: 4572, mach: 0.63, throttle: 0.93, flaps: 0, gear: 0 },
};
