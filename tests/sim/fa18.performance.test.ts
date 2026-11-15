/**
 * The F/A-18C against its published performance (sources in src/sim/fa18.ts). Clean, no
 * tank, 16 000 kg at take-off (full internal fuel), sea level ISA unless stated; the turn
 * figures at a combat mass with half the internal fuel, as E-M charts are drawn. Each figure
 * is flown by a test pilot of fa18Procedures.ts. Where a figure is published the target is
 * 5 %; where only a band is quoted the band is the test; reconstructed figures are marked.
 */
import { describe, expect, it } from 'vitest';
import { FA18, FA18_INTERNAL_FUEL } from '../../src/sim/fa18';
import { KT } from './harness';
import * as P from './fa18Procedures';

function within(name: string, actual: number, published: number, tolerance = 0.05) {
  const d = actual / published - 1;
  expect(
    Math.abs(d),
    `${name}: ${actual.toFixed(2)} vs ${published} (${(d * 100).toFixed(1)} %)`,
  ).toBeLessThan(tolerance);
}

function between(name: string, actual: number, lo: number, hi: number) {
  const msg = `${name}: ${actual.toFixed(3)} not in ${lo}..${hi}`;
  expect(actual, msg).toBeGreaterThanOrEqual(lo);
  expect(actual, msg).toBeLessThanOrEqual(hi);
}

/** Half the internal fuel: the combat mass of the turn figures (about 13 500 kg). */
const COMBAT_FUEL = FA18_INTERNAL_FUEL / 2;

describe('F/A-18C published performance', () => {
  it('keeps the published figures in its definition', () => {
    expect(FA18.wingArea).toBeCloseTo(37.16, 2);
    expect(FA18.wingSpan).toBeCloseTo(11.43, 2);
    expect(FA18.meanChord).toBeCloseTo(3.51, 2);
    const area = FA18.strips
      .filter((s) => FA18.wingGroups.includes(s.group))
      .reduce((a, s) => a + s.area, 0);
    expect(Math.abs(area / FA18.wingArea - 1)).toBeLessThan(0.01);
    expect(Math.abs(FA18.mass + FA18.fuelCapacity - 16_000)).toBeLessThan(10);
    expect(FA18.fuelCapacity).toBeCloseTo(4926, 0);
    expect(FA18.limits!.vmo / KT).toBeCloseTo(750, 6);
    expect(FA18.limits!.mmo).toBe(1.8);
    expect(FA18.ultimateLoad.positive / 1.5).toBeCloseTo(7.5, 6);
    expect(FA18.ultimateLoad.negative / 1.5).toBeCloseTo(-3, 6);
    expect(FA18.engines).toHaveLength(2);
    for (const e of FA18.engines) {
      expect(e.kind).toBe('afterburning');
      if (e.kind === 'afterburning') {
        expect(e.engine.ratedThrust / 4.448222).toBeCloseTo(11_000, 0);
        expect(e.engine.afterburner!.thrust / 4.448222).toBeCloseTo(17_750, 0);
        expect(e.engine.afterburner!.military).toBe(0.75);
      }
    }
  });

  it('reaches about Mach 1.0 to 1.08 at sea level and 1.7 to 1.8 at 36 000 ft', () => {
    const sl = P.maxLevelMach(1000, 640);
    const high = P.maxLevelMach(36_000, 1000);
    between('Mach at sea level', sl.mach, 1.0, 1.08);
    between('Mach at 36 000 ft', high.mach, 1.7, 1.8);
    for (const r of [sl, high]) {
      expect(r.crashed).toBeUndefined();
      expect(Math.abs(r.altitudeError)).toBeLessThan(30);
    }
  }, 120_000);

  it('climbs at about 45 000 to 50 000 ft/min at sea level in afterburner', () => {
    // At the best climb speed, about Mach 0.8.
    between('rate of climb', P.climbRate(1000, 0.8).fpm, 45_000, 50_000);
  }, 60_000);

  it('climbs from 1000 ft to 30 000 ft in about a minute (reconstructed)', () => {
    // Reconstructed from the climb rate's fall with altitude; no published figure in hand.
    between('time to 30 000 ft (s)', P.timeToClimb(30_000).seconds, 50, 80);
  }, 60_000);

  it('has the published service ceiling of 50 000 ft (100 ft/min of excess power)', () => {
    // Full afterburner at Mach 0.9, the best subsonic climb up there; the ceiling interpolated
    // between 45 000 and 50 000 ft. The pressure-ratio lapse alone carried it to 55 300 ft:
    // the F404's Reynolds number loss at altitude (src/sim/fa18.ts) brings it down.
    const a = P.excessPower(45_000, 0.9).ps;
    const b = P.excessPower(50_000, 0.9).ps;
    const fpm = (ps: number) => (ps * 60) / 0.3048;
    const ceiling = 45_000 + (5000 * (fpm(a) - 100)) / (fpm(a) - fpm(b));
    within('service ceiling (ft)', ceiling, 50_000, 0.04);
  }, 60_000);

  it('has the specific excess power of its class (reconstructed)', () => {
    // 1 g, full afterburner: consistent with the climb rate at sea level and falling with
    // altitude and through the transonic drag rise.
    between('Ps SL M0.8 (m/s)', P.excessPower(1000, 0.8).ps, 190, 260);
    between('Ps 15 000 ft M0.9 (m/s)', P.excessPower(15_000, 0.9).ps, 140, 220);
    between('Ps 30 000 ft M1.2 (m/s)', P.excessPower(30_000, 1.2).ps, 60, 140);
  }, 60_000);

  it('takes off in afterburner and at military power (flaps HALF, 16 000 kg)', () => {
    const ab = P.takeoff(1);
    const mil = P.takeoff(0.75);
    expect(ab.crashed).toBeUndefined();
    expect(mil.crashed).toBeUndefined();
    // Published about 430 m with afterburner; at this clean 16 t the model rolls about
    // 14 % less (the published figure's mass and stores are not known to me).
    between('ground roll AB (m)', ab.groundRoll, 340, 450);
    // Military power: reconstructed.
    between('ground roll MIL (m)', mil.groundRoll, 520, 700);
    expect(mil.groundRoll).toBeGreaterThan(1.4 * ab.groundRoll);
    for (const r of [ab, mil]) {
      between('lift-off KIAS', r.liftOffKias, 140, 170);
      expect(r.maxDeviation).toBeLessThan(2);
    }
  }, 60_000);

  it('flies on speed (8.1° AoA) at about 134 to 140 KIAS at a 15 000 kg landing mass', () => {
    const r = P.onSpeedApproach(15_000);
    between('on-speed KIAS', r.kias, 134, 140);
    expect(Math.abs(r.alpha - 8.1)).toBeLessThan(0.3);
    expect(r.onSpeed).toBe('onSpeed');
  }, 60_000);

  it('lands from an on-speed approach and stops in about 850 m (reconstructed)', () => {
    const r = P.landing(15_000);
    expect(r.crashed).toBeUndefined();
    // No flare: the sink rate of a carrier-style approach, well inside the gear's limit.
    expect(r.touchdownSink).toBeGreaterThan(-6);
    between('touchdown KIAS', r.touchdownKias, 132, 150);
    between('landing roll (m)', r.groundRoll, 650, 1000);
  }, 60_000);

  it('turns about 19 to 20 °/s sustained and 24 °/s instantaneous at sea level', () => {
    const st = P.sustainedTurn(1000, 0.6, COMBAT_FUEL);
    const itr = P.instantaneousTurn(1000, 340, COMBAT_FUEL);
    within('sustained turn SL M0.6 (°/s)', st.rate, 19.5, 0.06);
    within('instantaneous turn SL 340 KCAS (°/s)', itr.rate, 24);
    expect(itr.peakG).toBeLessThan(7.5 * 1.05);
    expect(st.crashed).toBeUndefined();
  }, 60_000);

  it('sustains about 14 to 16 °/s at 15 000 ft, Mach 0.8', () => {
    // The task's 19-20 °/s would need 7.5 g at Mach 0.6 there, a lift coefficient of 2.2:
    // that is the sea-level figure. No published 15 000 ft figure in hand.
    const st = P.sustainedTurn(15_000, 0.8, COMBAT_FUEL);
    between('sustained turn 15 000 ft M0.8 (°/s)', st.rate, 13, 17);
  }, 60_000);

  it('flies down to its angle of attack limits without a stall break', () => {
    const clean = P.minimumSpeed(0, false);
    const full = P.minimumSpeed(1, true);
    between('minimum KIAS clean', clean.kias, 80, 110);
    between('minimum KIAS full flaps', full.kias, 105, 130);
    expect(full.alpha).toBeLessThan(16);
    expect(clean.crashed).toBeUndefined();
    expect(full.crashed).toBeUndefined();
  }, 60_000);

  it('accelerates from Mach 0.8 to 1.2 at 35 000 ft in about a minute (reconstructed)', () => {
    between('0.8 to 1.2 (s)', P.acceleration(35_000, 0.8, 1.2).seconds, 45, 80);
  }, 60_000);

  it('cruises at Mach 0.85 at 36 000 ft with a combat radius of the order of 290 NM', () => {
    const r = P.cruise(36_000, 0.85);
    // Out and back at cruise on the internal fuel less the mission's allowances (reconstructed):
    // start, taxi and take-off 300 kg, climb 400 kg, two minutes of combat in afterburner at
    // altitude 600 kg, a 20-minute reserve 900 kg. The published clean radius is about 290 NM.
    const allowance = 300 + 400 + 600 + 900;
    const hours = (FA18_INTERNAL_FUEL - allowance) / (r.fuelFlow * 3600);
    const radius = (hours * r.ktas) / 2;
    within('combat radius (NM)', radius, 290, 0.15);
    between('cruise fuel flow (kg/h)', r.fuelFlow * 3600, 1800, 2600);
  }, 60_000);
});
