/** Every failure the C172S knows, with the effect its contract describes. */
import { describe, expect, it } from 'vitest';
import type { FailureId } from '../../src/sim';
import type { FlightModel } from '../../src/sim/flightModel';
import { airborne, fly, onGround, type Flight } from './harness';

const cruise = () => {
  const f = airborne(1500, 100);
  return { f, ac: f.ac as FlightModel };
};

/** Throttle set for 1800 rpm on the brakes. */
function runUp(): Flight {
  const f = onGround();
  f.ac.controls.parkingBrake = true;
  let throttle = 0.5;
  for (let k = 0; k < 40; k++) {
    f.ac.controls.throttle[0] = throttle;
    fly(f, 2);
    throttle += (1800 - f.ac.telemetry.engines[0]!.rpm) * 0.0002;
  }
  return f;
}

describe('failures', () => {
  it('knows every failure, sets, repairs and clears them', () => {
    const { ac } = cruise();
    const all: FailureId[] = [
      'engine',
      'alternator',
      'vacuum',
      'pitot',
      'fuelLeak',
      'com1',
      'magnetoLeft',
    ];
    expect([...ac.failures.ids].sort()).toEqual([...all].sort());
    for (const id of all) {
      ac.failures.set(id, true);
      expect(ac.failures.active(id)).toBe(true);
    }
    ac.failures.set('vacuum', false);
    expect(ac.failures.active('vacuum')).toBe(false);
    ac.failures.set('nonsense' as FailureId, true);
    expect(ac.failures.active('nonsense' as FailureId)).toBe(false);
    ac.failures.clear();
    expect(all.some((id) => ac.failures.active(id))).toBe(false);
  });

  it('engine: no more power, the propeller windmills', () => {
    const { f, ac } = cruise();
    ac.failures.set('engine', true);
    fly(f, 5);
    const e = ac.telemetry.engines[0]!;
    expect(e.running).toBe(false);
    expect(e.power).toBeLessThan(0.01);
    expect(e.rpm).toBeGreaterThan(300);
    ac.failures.set('engine', false);
    fly(f, 5);
    expect(e.running).toBe(true);
  });

  it('alternator: the battery takes the load and drains, LOW VOLTS lights', () => {
    const { f, ac } = cruise();
    ac.failures.set('alternator', true);
    fly(f, 60);
    const s = ac.telemetry.systems!;
    expect(s.batteryAmps).toBeLessThan(-10);
    expect(s.batteryCharge).toBeLessThan(1);
    expect(s.annunciators.lowVolts).toBe(true);
    expect(s.avionicsPowered).toBe(true);
  });

  it('vacuum: no suction', () => {
    const { f, ac } = cruise();
    ac.failures.set('vacuum', true);
    fly(f, 10);
    expect(ac.telemetry.systems!.vacuum).toBeLessThan(0.1);
    expect(ac.telemetry.instruments!.gyroFlag).toBe(true);
  });

  it('pitot: blocked with the heat on, in dry air', () => {
    const { f, ac } = cruise();
    ac.cockpit.set('pitotHeat', 1);
    ac.failures.set('pitot', true);
    fly(f, 1);
    expect(ac.telemetry.systems!.pitotBlocked).toBe(true);
    ac.failures.set('pitot', false);
    fly(f, 1);
    expect(ac.telemetry.systems!.pitotBlocked).toBe(false);
  });

  it('fuel leak: the left tank empties faster', () => {
    const { f, ac } = cruise();
    ac.failures.set('fuelLeak', true);
    fly(f, 120);
    const s = ac.telemetry.systems!;
    // About 10 gal/h: a third of a gallon in two minutes.
    expect((s.fuelRight - s.fuelLeft) / (6 * 0.45359237)).toBeCloseTo(1 / 3, 1);
  });

  it('left magneto: rough on BOTH, a stop on LEFT alone, normal drop on RIGHT', () => {
    const f = runUp();
    const ac = f.ac as FlightModel;
    const rpm = () => ac.telemetry.engines[0]!.rpm;
    fly(f, 5);
    const healthy = rpm();
    ac.cockpit.set('magnetos', 1);
    fly(f, 5);
    const rightOnly = rpm();
    ac.cockpit.set('magnetos', 3);
    fly(f, 5);
    ac.failures.set('magnetoLeft', true);
    fly(f, 5);
    let lo = Infinity;
    let hi = 0;
    fly(f, 5, () => {
      lo = Math.min(lo, rpm());
      hi = Math.max(hi, rpm());
    });
    expect(hi).toBeLessThan(healthy - 50);
    // Rough: the rpm will not settle.
    expect(hi - lo).toBeGreaterThan(10);
    ac.cockpit.set('magnetos', 1);
    fly(f, 5);
    expect(rpm()).toBeCloseTo(rightOnly, -1);
    ac.cockpit.set('magnetos', 2);
    fly(f, 8);
    expect(ac.telemetry.engines[0]!.running).toBe(false);
  });
});
