/**
 * The generic core on its own: the jet engines against published engine data, compressible
 * section aerodynamics against theory, several engines on one airframe (asymmetric thrust),
 * and the fly-by-wire hook. The A320 and F/A-18 definitions build on these.
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT, TestEnvironment, isa } from '../../src/sim';
import { machEffects } from '../../src/sim/airfoil';
import { PassThroughLaw } from '../../src/sim/controlLaw';
import type { AircraftDefinition } from '../../src/sim/definition';
import { FlightModel } from '../../src/sim/flightModel';
import { PC12 } from '../../src/sim/pc12';
import {
  TurbofanPowerplant,
  newPowerplantInput,
  type PowerplantInput,
  type TurbofanDef,
} from '../../src/sim/propulsion';
import { FT, KT, fly } from './harness';

const LBF = 4.4482216;
/** 1 lb of fuel per lbf of thrust per hour, in kg/(N s). */
const TSFC = 0.45359237 / (LBF * 3600);

/**
 * CFM56-5B4 (A320): 27 000 lbf take-off thrust flat-rated to ISA+15 °C (EASA TCDS E.067),
 * cruise TSFC about 0.545 lb/lbf/h at M 0.8, FL350, and about 0.34 at sea level static.
 */
const CFM56: TurbofanDef = {
  kind: 'turbofan',
  position: { x: 0, y: 0, z: 0 },
  engine: {
    ratedThrust: 27_000 * LBF,
    throttleRatio: 1.052,
    temperatureLapse: 3.5,
    machLapse: 0.49,
    n1Rpm: 5000,
    n1Max: 1.0,
    n1Idle: 0.2,
    n2Max: 1.0,
    n2Idle: 0.6,
    thrust: [
      [0.2, 0.05],
      [0.5, 0.25],
      [0.7, 0.48],
      [0.85, 0.72],
      [1, 1],
      [1.1, 1.2],
    ],
    tsfc: [0.335 * TSFC, 0.38 * TSFC],
    idleFuel: 0.1,
    egt: [
      [0.5, 600],
      [0.6, 700],
      [0.8, 850],
      [1, 1100],
      [1.1, 1180],
    ],
    spool: { idle: 2.5, high: 0.8, accel: 0.09, decel: 0.12 },
    reverser: { time: 2, share: 0.3, n1: 0.8 },
    start: {
      starterN2: 0.25,
      starterTime: 6,
      lightOffN2: 0.2,
      lightOffDelay: 3,
      cutoutN2: 0.5,
      accel: 0.012,
      peakEgt: 1000,
    },
    angularMomentum: 1500,
  },
};

/**
 * F404-GE-402 (F/A-18C): 11 000 lbf military and 17 700 lbf with afterburner at sea level
 * static; TSFC 0.81 dry and 1.74 lb/lbf/h with full afterburner (GE data).
 */
const F404: TurbofanDef = {
  kind: 'afterburning',
  position: { x: 0, y: 0, z: 0 },
  engine: {
    ...CFM56.engine,
    ratedThrust: 11_000 * LBF,
    throttleRatio: 1.07,
    temperatureLapse: 3.8,
    machLapse: 0,
    n1Rpm: 13_270,
    reverser: undefined,
    tsfc: [0.81 * TSFC, 0.3 * TSFC],
    idleFuel: 0.05,
    afterburner: {
      military: 0.8,
      thrust: 17_700 * LBF,
      tsfc: [1.74 * TSFC, 0.27 * TSFC],
      lightTime: 1.5,
      nozzle: [0.8, 0.35, 1],
    },
  },
};

function input(altitude: number, mach: number, throttle: number): PowerplantInput {
  const air = isa(altitude);
  const i = newPowerplantInput();
  i.pressure = air.pressure;
  i.temperature = air.temperature;
  i.density = air.density;
  i.mach = mach;
  i.airspeed = mach * air.speedOfSound;
  i.throttle = throttle;
  return i;
}

const steady = (def: TurbofanDef, i: PowerplantInput) => {
  const e = new TurbofanPowerplant(def);
  e.reset(true, false);
  e.settle(i, undefined);
  return e;
};

describe('turbofan', () => {
  it('gives its rated thrust and consumption at sea level static, and lapses at cruise', () => {
    const sl = steady(CFM56, input(0, 0, 1));
    expect(sl.thrust / LBF).toBeGreaterThan(27_000 * 0.98);
    expect(sl.thrust / LBF).toBeLessThan(27_000 * 1.02);
    expect(sl.fuelFlow / sl.thrust / TSFC).toBeCloseTo(0.335, 2);
    // M 0.78 at FL350: the maximum climb thrust is about a fifth of the static thrust and the
    // consumption the published 0.545 lb/lbf/h.
    const cruise = steady(CFM56, input(35_000 * FT, 0.78, 1));
    expect(cruise.thrust / sl.thrust).toBeGreaterThan(0.17);
    expect(cruise.thrust / sl.thrust).toBeLessThan(0.23);
    expect(Math.abs(cruise.fuelFlow / cruise.thrust / TSFC / 0.545 - 1)).toBeLessThan(0.05);
    // Idle is a few per cent of the static thrust.
    const idle = steady(CFM56, input(0, 0, 0));
    expect(idle.thrust / sl.thrust).toBeGreaterThan(0.03);
    expect(idle.thrust / sl.thrust).toBeLessThan(0.08);
    expect(idle.telemetry.n1).toBeCloseTo(20, 0);
    // Flat-rated: a hot day takes thrust away only beyond ISA+15.
    const warm = input(0, 0, 1);
    warm.temperature += 10;
    const hot = input(0, 0, 1);
    hot.temperature += 30;
    expect(steady(CFM56, warm).thrust).toBeCloseTo(sl.thrust, -2);
    expect(steady(CFM56, hot).thrust).toBeLessThan(sl.thrust * 0.95);
  });

  it('spools up from idle in several seconds and reverses on the ground', () => {
    const e = steady(CFM56, input(0, 0, 0));
    const i = input(0, 0, 1);
    const full = steady(CFM56, input(0, 0, 1)).thrust;
    let t = 0;
    while (e.thrust < 0.95 * full && t < 20) {
      e.step(SIM_DT, i, undefined);
      t += SIM_DT;
    }
    expect(t).toBeGreaterThan(4);
    expect(t).toBeLessThan(9);
    i.reverse = true;
    i.onGround = true;
    for (let k = 0; k < 6 / SIM_DT; k++) e.step(SIM_DT, i, undefined);
    expect(e.telemetry.reversing).toBe(true);
    expect(e.thrust).toBeLessThan(-0.15 * full);
  });

  it('starts on bleed air with the engine master and settles at idle', () => {
    const e = new TurbofanPowerplant(CFM56);
    e.reset(false, false);
    const i = input(0, 0, 0);
    i.condition = 0;
    i.starter = true;
    for (let k = 0; k < 10 / SIM_DT; k++) e.step(SIM_DT, i, undefined);
    expect(e.running).toBe(false);
    expect(e.telemetry.n2).toBeGreaterThan(20);
    i.condition = 1;
    i.starter = false;
    for (let k = 0; k < 80 / SIM_DT; k++) e.step(SIM_DT, i, undefined);
    expect(e.running).toBe(true);
    expect(e.telemetry.n2).toBeCloseTo(60, 0);
    expect(e.telemetry.starting).toBe(false);
  });
});

describe('afterburning turbofan', () => {
  it('gives military and full afterburner thrust and consumption at sea level static', () => {
    const mil = steady(F404, input(0, 0, 0.8));
    const max = steady(F404, input(0, 0, 1));
    expect(Math.abs(mil.thrust / LBF / 11_000 - 1)).toBeLessThan(0.02);
    expect(Math.abs(max.thrust / LBF / 17_700 - 1)).toBeLessThan(0.02);
    expect(mil.fuelFlow / mil.thrust / TSFC).toBeCloseTo(0.81, 2);
    expect(max.fuelFlow / max.thrust / TSFC).toBeCloseTo(1.74, 2);
    expect(max.telemetry.afterburner).toBe(1);
    expect(mil.telemetry.afterburner).toBe(0);
    // The nozzle closes towards military power and opens wide with the afterburner.
    expect(mil.telemetry.nozzle!).toBeLessThan(0.4);
    expect(max.telemetry.nozzle!).toBeGreaterThan(0.95);
    expect(max.telemetry.power).toBeGreaterThan(1.5);
  });

  it('lights the afterburner only with the core at military power', () => {
    const e = steady(F404, input(0, 0, 0));
    const i = input(0, 0, 1);
    e.step(SIM_DT, i, undefined);
    expect(e.afterburner).toBe(0);
    for (let k = 0; k < 15 / SIM_DT; k++) e.step(SIM_DT, i, undefined);
    expect(e.afterburner).toBe(1);
  });
});

describe('compressibility', () => {
  const data = { divergence: 0.8, thickness: 0.05 };
  const out = { lift: 1, drag: 0, cpShift: 0, control: 1 };

  it('follows Prandtl-Glauert below and Ackeret above the speed of sound', () => {
    machEffects(data, 2 * Math.PI, 0.5, out);
    expect(out.lift).toBeCloseTo(1 / Math.sqrt(1 - 0.25), 6);
    expect(out.drag).toBe(0);
    expect(out.cpShift).toBe(0);
    machEffects(data, 2 * Math.PI, 2, out);
    expect(out.lift * 2 * Math.PI).toBeCloseTo(4 / Math.sqrt(3), 6);
    expect(out.drag).toBeCloseTo((4 * 0.05 * 0.05) / Math.sqrt(3), 6);
    expect(out.cpShift).toBeCloseTo(0.25, 6);
    expect(out.control).toBeLessThan(0.6);
  });

  it('rises in drag past the critical Mach number, smoothly through the transonic range', () => {
    let last = machEffects(data, 2 * Math.PI, 0.3, out).drag;
    for (let m = 0.3; m <= 2.5; m += 0.01) {
      const d = machEffects(data, 2 * Math.PI, m, out).drag;
      expect(Math.abs(d - last)).toBeLessThan(0.006);
      last = d;
    }
    expect(machEffects(data, 2 * Math.PI, 0.69, out).drag).toBe(0);
    expect(machEffects(data, 2 * Math.PI, 0.8, out).drag).toBeGreaterThan(0.0005);
    expect(machEffects(data, 2 * Math.PI, 0.8, out).drag).toBeLessThan(0.003);
  });
});

/** The PC-12 airframe with a jet under each wing: a test bed for several engines. */
function twin(): AircraftDefinition {
  const jet = (y: number): TurbofanDef => ({
    ...CFM56,
    position: { x: 0.5, y, z: 0.9 },
    engine: { ...CFM56.engine, ratedThrust: 6000 },
  });
  return { ...PC12, engines: [jet(-3), jet(3)] };
}

describe('several engines', () => {
  it('gives each engine its telemetry, and yaws towards the one that stops', () => {
    const env = new TestEnvironment();
    const ac = new FlightModel(twin());
    ac.reset(
      { position: env.position(3000 * FT), headingDeg: 0, speed: 150 * KT, onGround: false },
      env,
    );
    expect(ac.telemetry.engines).toHaveLength(2);
    expect(ac.controls.throttle).toHaveLength(2);
    expect(ac.telemetry.engines[0]!.n1).toBeGreaterThan(20);
    fly({ ac, env }, 2);
    const r0 = ac.state.angularVelocity.z;
    // The left engine's master off.
    ac.controls.condition![0] = 0;
    fly({ ac, env }, 4);
    expect(ac.telemetry.engines[0]!.running).toBe(false);
    expect(ac.telemetry.engines[1]!.running).toBe(true);
    expect(ac.state.angularVelocity.z).toBeLessThan(r0 - 0.01);
    // Throttle levers bind per engine where the cockpit has them, all at once otherwise.
    ac.cockpit.set('throttle', 0.7);
    expect(ac.controls.throttle).toEqual([0.7, 0.7]);
  });

  it('takes a fly-by-wire law in place of the direct one', () => {
    const def: AircraftDefinition = { ...PC12, controlLaw: (d) => new PassThroughLaw(d) };
    const env = new TestEnvironment();
    const ac = new FlightModel(def);
    ac.reset(
      { position: env.position(5000 * FT), headingDeg: 0, speed: 230 * KT, onGround: false },
      env,
    );
    expect(ac.controlLaw).toBeInstanceOf(PassThroughLaw);
    // Powered surfaces: full deflection even at high dynamic pressure.
    fly({ ac, env }, 0.5, () => void (ac.controls.roll = 1));
    expect(ac.telemetry.aileron).toBeGreaterThan(0.95);
  });
});
