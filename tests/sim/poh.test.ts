/**
 * The C172S against its Pilot's Operating Handbook (2550 lb, sea level, ISA unless stated).
 * Each figure is flown by a test pilot with the handbook technique and compared with the
 * published value; the target is 5 %.
 */
import { describe, expect, it } from 'vitest';
import {
  climbRate,
  glideRatio,
  landing,
  levelSpeed,
  serviceCeiling,
  stallSpeed,
  staticRpm,
  takeoff,
} from './procedures';

/** Relative deviation from the published value. */
const deviation = (actual: number, published: number) => actual / published - 1;

function within(name: string, actual: number, published: number, tolerance = 0.05) {
  const d = deviation(actual, published);
  expect(
    Math.abs(d),
    `${name}: ${actual.toFixed(1)} vs ${published} (${(d * 100).toFixed(1)} %)`,
  ).toBeLessThan(tolerance);
}

describe('C172S handbook performance', () => {
  it('stalls at 48 KIAS clean and 40 KIAS with full flaps (power off, 1 kt/s)', () => {
    const clean = stallSpeed(0);
    const flaps = stallSpeed(1);
    expect(clean.stalled).toBe(true);
    expect(flaps.stalled).toBe(true);
    // Handbook (most rearward CG): 48 KIAS = 53 KCAS clean, 40 KIAS = 48 KCAS flaps 30. The
    // indicated values are the familiar ones; the calibrated ones test the aerodynamics.
    within('Vs1 KIAS', clean.kias, 48);
    within('Vs1 KCAS', clean.kcas, 53);
    within('Vs0 KIAS', flaps.kias, 40);
    within('Vs0 KCAS', flaps.kcas, 48);
    // The horn sounds 5 to 10 knots above the stall.
    for (const s of [clean, flaps]) {
      const margin = s.warningKias - s.kias;
      expect(margin, `stall warning margin ${margin.toFixed(1)} kt`).toBeGreaterThan(4.5);
      expect(margin).toBeLessThan(10.5);
    }
  });

  it('takes off in about 960 ft ground roll and 1630 ft over 50 ft (flaps 10, short field)', () => {
    const r = takeoff();
    expect(r.crashed).toBeUndefined();
    within('lift-off KIAS', r.liftOffKias, 51);
    within('ground roll', r.groundRollFt, 960);
    within('total over 50 ft', r.totalFt, 1630);
  });

  it('climbs at about 730 ft/min at Vy 74 KIAS at sea level', () => {
    const r = climbRate(1000);
    within('rate of climb', r.fpm, 730);
    expect(r.rpm).toBeLessThan(2700);
  });

  it('has a service ceiling of about 14 000 ft', () => {
    within('service ceiling', serviceCeiling(), 14_000);
  }, 60_000);

  it('cruises at about 122 KTAS at 8000 ft with 75 % power', () => {
    const r = levelSpeed(8000, 0.75, 115);
    // The fixed-pitch propeller holds the engine to about 2610 rpm at 8000 ft, where full
    // throttle gives 73 % rather than the handbook's 75 %: a known shortfall of the model.
    expect(r.power).toBeGreaterThan(0.72);
    expect(r.power).toBeLessThan(0.76);
    within('cruise KTAS', r.ktas, 122);
  });

  it('reaches about 126 kt at sea level, full throttle, without passing 2700 rpm', () => {
    const r = levelSpeed(1000, 'full', 115);
    within('maximum level speed', r.ktas, 126);
    expect(r.rpm).toBeLessThanOrEqual(2700);
    expect(r.rpm).toBeGreaterThan(2550);
  });

  it('glides about 9:1 at 68 KIAS with the engine idling', () => {
    const r = glideRatio(68);
    within('glide ratio', r.ratio, 9);
    expect(r.rpm).toBeGreaterThan(600);
  });

  it('lands in about 575 ft ground roll (short field, maximum braking)', () => {
    const r = landing();
    expect(r.crashed).toBeUndefined();
    within('landing ground roll', r.groundRollFt, 575);
  });

  it('turns about 2300 rpm at full throttle standing still', () => {
    const r = staticRpm();
    within('static rpm', r.rpm, 2300);
    expect(r.moved).toBeLessThan(0.01);
  });
});
