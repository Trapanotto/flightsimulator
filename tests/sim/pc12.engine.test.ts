/**
 * The PC-12's PT6A-67P and its propeller: the take-off and cruise points, the flat rating,
 * spool-up, the start sequence, beta and reverse, feathering and the inertial separator.
 * Published: 1200 shp flat rating (44.34 psi torque) at 1700 rpm, ITT 820 °C in flight and
 * 1000 °C at the start, Ng 104 % (PIM section 2). The PT6's start figures (fuel at 13 % Ng,
 * light-off within 10 s, the starter cutting out at 50 % Ng, about 30 s to ground idle) are
 * the usual ones of the family.
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT, TestEnvironment, createAircraft } from '../../src/sim';
import type { FlightModel } from '../../src/sim/flightModel';
import { FT, KT, fly, type Flight } from './harness';
import { engine, pc12Airborne, pc12OnGround } from './pc12Harness';

const LB_H = 3600 / 0.45359237;

function cold(): Flight & { ac: FlightModel } {
  const env = new TestEnvironment();
  const ac = createAircraft('pc12') as FlightModel;
  ac.reset(
    { position: env.position(0), headingDeg: 0, speed: 0, onGround: true, enginesRunning: false },
    env,
  );
  return { ac, env };
}

describe('PT6A-67P', () => {
  it('makes 1200 shp at 1700 rpm for take-off at sea level, within its limits', () => {
    const f = pc12OnGround();
    f.ac.controls.parkingBrake = true;
    f.ac.controls.throttle[0] = 1;
    fly(f, 15);
    const e = engine(f);
    expect(e.torque! * 44.34).toBeCloseTo(44.34, 0);
    expect(Math.abs(e.propRpm! / 1700 - 1)).toBeLessThan(0.01);
    expect(e.power).toBeGreaterThan(0.98);
    expect(e.n2).toBeGreaterThan(92);
    expect(e.n2).toBeLessThan(97);
    expect(e.turbineTemperature).toBeGreaterThan(680);
    expect(e.turbineTemperature).toBeLessThan(760);
    // About 0.56 lb/shp/h at take-off power.
    expect(e.fuelFlow * LB_H).toBeGreaterThan(620);
    expect(e.fuelFlow * LB_H).toBeLessThan(720);
    expect(f.ac.telemetry.exceedances).toEqual([]);
  });

  it('is flat-rated: full torque up to the middle altitudes, then the ITT limit takes over', () => {
    const full = (altFt: number, ktas: number, isaDeviation = 0) => {
      const f = pc12Airborne(altFt * FT, ktas, { isaDeviation });
      f.ac.controls.throttle[0] = 1;
      fly(f, 15);
      return engine(f);
    };
    const fl100 = full(10_000, 230);
    const fl250 = full(25_000, 270);
    expect(fl100.torque).toBeGreaterThan(0.98);
    expect(fl100.turbineTemperature).toBeLessThan(815);
    expect(fl250.torque).toBeLessThan(0.85);
    expect(fl250.turbineTemperature).toBeGreaterThan(815);
    // A hot day takes the power away earlier.
    const hot = full(18_000, 260, 20);
    const std = full(18_000, 260);
    expect(hot.torque!).toBeLessThan(std.torque! - 0.05);
    expect(hot.n2).toBeLessThanOrEqual(104);
  });

  it('spools up from flight idle to take-off power in a few seconds', () => {
    const f = pc12Airborne(3000 * FT, 140);
    f.ac.controls.throttle[0] = 0;
    fly(f, 15);
    expect(engine(f).torque).toBeLessThan(0.2);
    f.ac.controls.throttle[0] = 1;
    const t90 = fly(f, 20, () => engine(f).torque! > 0.9);
    expect(t90).toBeGreaterThan(1.5);
    expect(t90).toBeLessThan(7);
  });

  it('starts as a PT6 does: starter, fuel at 13 % Ng, light-off, starter cut-out, ground idle', () => {
    const f = cold();
    const p = f.ac.cockpit;
    const e = engine(f);
    expect(e.running).toBe(false);
    expect(e.n2).toBe(0);
    p.set('battery', 1);
    p.set('generator1', 1);
    p.set('generator2', 1);
    fly(f, 1);
    p.set('starter', 1);
    fly(f, 0.2);
    // Released: the sequence holds by itself.
    p.set('starter', 0);
    let fuelAt = NaN;
    let lightAt = NaN;
    let cutoutNg = NaN;
    let idleAt = NaN;
    let peak = 0;
    let wasStarting = true;
    for (let i = 0; i < 60 / SIM_DT; i++) {
      const t = i * SIM_DT;
      if (Number.isNaN(fuelAt) && e.n2! >= 13) {
        fuelAt = t;
        // Condition lever to ground idle introduces fuel.
        p.set('condition', 1);
      }
      if (Number.isNaN(lightAt) && e.running) lightAt = t;
      if (wasStarting && !e.starting) cutoutNg = e.n2!;
      wasStarting = e.starting === true;
      if (Number.isNaN(idleAt) && e.n2! > 61) idleAt = t;
      peak = Math.max(peak, e.turbineTemperature!);
      f.ac.step(SIM_DT, f.env);
    }
    expect(fuelAt).toBeLessThan(8);
    expect(lightAt - fuelAt).toBeLessThan(10);
    expect(lightAt - fuelAt).toBeGreaterThan(1);
    expect(cutoutNg).toBeGreaterThan(48);
    expect(cutoutNg).toBeLessThan(53);
    expect(idleAt).toBeGreaterThan(20);
    expect(idleAt).toBeLessThan(45);
    // A hot start would pass 1000 °C; a normal one peaks well below.
    expect(peak).toBeGreaterThan(600);
    expect(peak).toBeLessThan(1000);
    // At ground idle the propeller has come out of feather and the generators are on line.
    expect(e.propRpm).toBeGreaterThan(700);
    expect(f.ac.telemetry.systems!.busVolts).toBeGreaterThan(27.5);
    expect(f.ac.telemetry.systems!.oilPressure).toBeGreaterThan(60);
  });

  it('needs battery power to crank and fuel to light', () => {
    const noBattery = cold();
    noBattery.ac.cockpit.set('starter', 1);
    fly(noBattery, 5);
    expect(engine(noBattery).n2).toBe(0);
    const noFuel = cold();
    noFuel.ac.cockpit.set('battery', 1);
    noFuel.ac.cockpit.set('starter', 1);
    fly(noFuel, 0.2);
    noFuel.ac.cockpit.set('starter', 0);
    // The condition lever stays at cut-off: it turns, but never lights.
    fly(noFuel, 20);
    expect(engine(noFuel).n2).toBeGreaterThan(13);
    expect(engine(noFuel).running).toBe(false);
  });

  it('feathers when it is shut down in flight', () => {
    const f = pc12Airborne(10_000 * FT, 200);
    f.ac.cockpit.set('condition', 0);
    fly(f, 15);
    const e = engine(f);
    expect(e.running).toBe(false);
    expect(e.torque).toBeLessThan(0.01);
    expect(e.propRpm).toBeLessThan(150);
  });

  it('goes into beta and reverse on the ground, and only there', () => {
    const f = pc12OnGround();
    const c = f.ac.controls;
    c.reverse = true;
    c.throttle[0] = 1;
    fly(f, 8);
    const e = engine(f);
    expect(e.reversing).toBe(true);
    // The aircraft backs away: the thrust points forward.
    const t = f.ac.telemetry;
    expect(t.groundSpeed).toBeGreaterThan(0.5);
    const drift = ((t.trackDeg - t.headingDeg + 540) % 360) - 180;
    expect(Math.abs(drift)).toBeGreaterThan(150);
    // In the air the lever cannot pass the gate.
    const a = pc12Airborne(5000 * FT, 150);
    a.ac.controls.reverse = true;
    a.ac.controls.throttle[0] = 0.5;
    fly(a, 5);
    expect(engine(a).reversing).toBe(false);
    expect(engine(a).torque).toBeGreaterThan(0.3);
  });

  it('loses a few per cent of power with the inertial separator open', () => {
    const run = (open: boolean) => {
      const f = pc12Airborne(22_000 * FT, 260);
      f.ac.cockpit.set('inertialSeparator', open ? 1 : 0);
      f.ac.controls.throttle[0] = 1;
      fly(f, 15);
      return engine(f).torque!;
    };
    const closed = run(false);
    const open = run(true);
    expect(open).toBeLessThan(closed * 0.98);
    expect(open).toBeGreaterThan(closed * 0.9);
  });

  it('governs the propeller at 1700 rpm through the climb and the cruise', () => {
    const f = pc12Airborne(15_000 * FT, 200);
    f.ac.controls.throttle[0] = 0.7;
    let lo = Infinity;
    let hi = 0;
    fly(f, 30, () => {
      lo = Math.min(lo, engine(f).propRpm!);
      hi = Math.max(hi, engine(f).propRpm!);
    });
    expect(lo).toBeGreaterThan(1680);
    expect(hi).toBeLessThan(1720);
    expect(f.ac.telemetry.ias / KT).toBeGreaterThan(150);
  });
});
