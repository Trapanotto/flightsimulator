/**
 * The PC-12 NG against its published performance (MTOW 4740 kg, sea level ISA unless
 * stated; sources in src/sim/pc12.ts). Each figure is flown by a test pilot and compared
 * with the published value; the target is 5 %.
 */
import { describe, expect, it } from 'vitest';
import { PC12 } from '../../src/sim/pc12';
import { KT } from './harness';
import {
  pc12Climb,
  pc12Glide,
  pc12Landing,
  pc12Level,
  pc12Stall,
  pc12Takeoff,
} from './pc12Procedures';

function within(name: string, actual: number, published: number, tolerance = 0.05) {
  const d = actual / published - 1;
  expect(
    Math.abs(d),
    `${name}: ${actual.toFixed(1)} vs ${published} (${(d * 100).toFixed(1)} %)`,
  ).toBeLessThan(tolerance);
}

const LB_PER_KG = 1 / 0.45359237;

describe('PC-12 NG handbook performance', () => {
  it('keeps the published figures in its definition', () => {
    expect(PC12.info.maxTakeoffMass).toBe(4740);
    expect(PC12.mass + PC12.fuelCapacity).toBeCloseTo(4740, 6);
    expect(PC12.fuelCapacity).toBeCloseTo(1227, 0);
    expect(PC12.wingArea).toBeCloseTo(25.81, 2);
    expect(PC12.wingSpan).toBeCloseTo(16.28, 2);
    const area = PC12.strips
      .filter((s) => PC12.wingGroups.includes(s.group))
      .reduce((a, s) => a + s.area, 0);
    expect(Math.abs(area / PC12.wingArea - 1)).toBeLessThan(0.03);
    expect(PC12.limits!.vmo / KT).toBeCloseTo(240, 6);
    expect(PC12.limits!.mmo).toBe(0.48);
    expect(PC12.controls.flapDetents.map((d) => Math.round((d * 180) / Math.PI))).toEqual([
      0, 15, 30, 40,
    ]);
    const e = PC12.engines[0]!;
    expect(e.kind).toBe('turboprop');
    if (e.kind === 'turboprop') {
      expect(e.engine.ratedPower / 745.7).toBeCloseTo(1200, 6);
      expect(e.engine.propRpm).toBe(1700);
      expect(e.propeller.blades).toBe(5);
    }
  });

  it('stalls (pusher) at about 93 KCAS clean and 67 KCAS in landing configuration', () => {
    const clean = pc12Stall(0, false);
    const landing = pc12Stall(1, true);
    within('VS1', clean.pusherKcas, 93);
    within('VS0', landing.pusherKcas, 67);
    // The shaker warns a few knots before the pusher fires.
    for (const s of [clean, landing]) {
      expect(s.shakerKcas - s.pusherKcas).toBeGreaterThan(2);
      expect(s.shakerKcas - s.pusherKcas).toBeLessThan(10);
    }
  }, 30_000);

  it('takes off in about 450 m ground roll and 793 m over 50 ft (flaps 15)', () => {
    const r = pc12Takeoff();
    expect(r.crashed).toBeUndefined();
    within('ground roll', r.groundRoll, 450);
    within('over 50 ft', r.total, 793);
    expect(r.torque).toBeGreaterThan(0.98);
    expect(r.maxHeadingDeviation).toBeLessThan(5);
  }, 30_000);

  it('climbs at about 1920 ft/min at sea level', () => {
    within('rate of climb', pc12Climb(1000, 130).fpm, 1920);
  }, 30_000);

  it('cruises at about 280 KTAS between FL 200 and FL 250 at maximum cruise power', () => {
    const fl250 = pc12Level(25_000, 275);
    const fl200 = pc12Level(20_000, 275);
    within('KTAS FL250', fl250.ktas, 280);
    within('KTAS FL200', fl200.ktas, 280);
    for (const r of [fl250, fl200]) {
      expect(Math.abs(r.vsFpm)).toBeLessThan(50);
      // The ITT limit caps the power up there, not the torque limit.
      expect(r.itt).toBeGreaterThan(815);
      expect(r.itt).toBeLessThan(825);
      expect(r.torque).toBeLessThan(1);
    }
    // Torque falls with altitude above the flat rating: 35.5 psi at FL250, 41.5 at FL200.
    expect(fl250.torque).toBeLessThan(fl200.torque);
    within('torque FL250 (psi)', fl250.torque * 44.34, 35.5);
    within('torque FL200 (psi)', fl200.torque * 44.34, 41.5);
    // Fuel flow at maximum cruise, lb/h (reconstructed from the cruise tables, see pc12.ts).
    within('fuel flow FL250', fl250.fuelFlow * 3600 * LB_PER_KG, 385);
    within('fuel flow FL200', fl200.fuelFlow * 3600 * LB_PER_KG, 470);
  }, 60_000);

  it('reaches its 30 000 ft maximum operating altitude with climb to spare', () => {
    // Well short of a service ceiling at FL300: still several hundred feet a minute.
    const r = pc12Climb(30_000, 115);
    expect(r.fpm).toBeGreaterThan(400);
  }, 30_000);

  it('glides about 16:1 with the propeller feathered', () => {
    const r = pc12Glide(125);
    within('glide ratio', r.ratio, 16);
    expect(r.propRpm).toBeLessThan(100);
  }, 30_000);

  it('lands in about 558 m over 50 ft and 370 m ground roll with reverse (flaps 40)', () => {
    const r = pc12Landing();
    expect(r.crashed).toBeUndefined();
    within('over 50 ft', r.total, 558);
    within('ground roll', r.groundRoll, 370);
    // Without reverse the roll is clearly longer.
    const plain = pc12Landing(false);
    expect(plain.groundRoll).toBeGreaterThan(r.groundRoll * 1.1);
  }, 30_000);

  it('ranges about 1500 to 2000 NM on its fuel at maximum cruise', () => {
    // Still air, no climb, no reserves: the order of the brochure's 1560 NM with reserves.
    const r = pc12Level(25_000, 275);
    const hours = PC12.fuelCapacity / (r.fuelFlow * 3600);
    const nm = hours * r.ktas;
    expect(nm).toBeGreaterThan(1500);
    expect(nm).toBeLessThan(2100);
    expect(hours * 60).toBeGreaterThan(5 * 60);
  }, 30_000);
});
