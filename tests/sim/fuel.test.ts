/**
 * The fuel system against the C172S Information Manual (sections 2 and 7): two wing tanks,
 * 56 US gal total of which 53 usable, selector LEFT/BOTH/RIGHT, shutoff valve, L and R LOW
 * FUEL annunciators below 5 gal in a tank. Avgas at 6 lb/gal as in the weight and balance.
 */
import { describe, expect, it } from 'vitest';
import { C172 } from '../../src/sim/c172';
import type { FlightModel } from '../../src/sim/flightModel';
import { AttitudePilot, DEG, airborne, fly } from './harness';

const GAL = 6 * 0.45359237;

const cruise = () => {
  const f = airborne(1500, 100);
  return { f, ac: f.ac as FlightModel };
};

describe('fuel system', () => {
  it('holds 53 US gal of usable fuel, half in each wing', () => {
    expect((2 * C172.systems.fuel.tankUsable) / GAL).toBeCloseTo(53, 6);
    const { ac } = cruise();
    const s = ac.telemetry.systems!;
    expect(s.fuelLeft / GAL).toBeCloseTo(26.5, 6);
    expect(s.fuelRight / GAL).toBeCloseTo(26.5, 6);
    expect(ac.telemetry.fuel / GAL).toBeCloseTo(53, 6);
    expect(ac.telemetry.instruments!.fuelLeft).toBeCloseTo(1, 6);
  });

  it('burns from both tanks evenly on BOTH, from one tank on LEFT or RIGHT', () => {
    const { f, ac } = cruise();
    const s = ac.telemetry.systems!;
    fly(f, 60);
    expect(s.fuelLeft).toBeLessThan(C172.systems.fuel.tankUsable);
    expect(s.fuelLeft).toBe(s.fuelRight);
    ac.cockpit.set('fuelSelector', 0);
    const right = s.fuelRight;
    const left = s.fuelLeft;
    fly(f, 60);
    expect(s.fuelRight).toBe(right);
    expect(s.fuelLeft).toBeLessThan(left);
    // A minute at cruise burns about 0.13 to 0.2 gal from the one tank.
    expect((left - s.fuelLeft) / GAL).toBeGreaterThan(0.1);
    expect((left - s.fuelLeft) / GAL).toBeLessThan(0.25);
  });

  it('rolls towards the heavier wing', () => {
    const roll = (left: number, right: number) => {
      const { f, ac } = cruise();
      ac.setFuel(left, right);
      fly(f, 15);
      return ac.telemetry.bank;
    };
    const full = C172.systems.fuel.tankUsable;
    const level = roll(full, full);
    const heavyRight = roll(full * 0.3, full);
    const heavyLeft = roll(full, full * 0.3);
    expect(heavyRight - level).toBeGreaterThan(2 * DEG);
    expect(heavyLeft - level).toBeLessThan(-2 * DEG);
    // A small tendency, not a roll-off: well within what the ailerons hold.
    expect(Math.abs(heavyRight - level)).toBeLessThan(45 * DEG);
  });

  it('stops the engine a few seconds after the valve is closed', () => {
    const { f, ac } = cruise();
    ac.cockpit.set('fuelShutoff', 0);
    fly(f, 1);
    expect(ac.telemetry.systems!.fuelAvailable).toBe(false);
    expect(ac.telemetry.engines[0]!.running).toBe(true);
    fly(f, 10);
    expect(ac.telemetry.engines[0]!.running).toBe(false);
  });

  it('starves the engine on an empty tank, and it restarts on the other one', () => {
    const { f, ac } = cruise();
    const full = C172.systems.fuel.tankUsable;
    ac.setFuel(0.01, full);
    ac.cockpit.set('fuelSelector', 0);
    const pilot = new AttitudePilot(ac);
    const glide = (dt: number) => {
      pilot.pitchTo(-4 * DEG, dt);
      pilot.bankTo(0, dt);
    };
    fly(f, 20, glide);
    const e = ac.telemetry.engines[0]!;
    expect(ac.telemetry.systems!.fuelAvailable).toBe(false);
    expect(e.running).toBe(false);
    ac.cockpit.set('fuelSelector', 2);
    // The windmilling propeller turns the engine fast enough to catch.
    fly(f, 10, glide);
    expect(e.running).toBe(true);
  });

  it('lights LOW FUEL for a tank below 5 gal', () => {
    const { f, ac } = cruise();
    const a = ac.telemetry.systems!.annunciators;
    ac.setFuel(5.2 * GAL, 20 * GAL);
    fly(f, 0.1);
    expect(a.lowFuelLeft).toBe(false);
    ac.setFuel(4.8 * GAL, 20 * GAL);
    fly(f, 0.1);
    expect(a.lowFuelLeft).toBe(true);
    expect(a.lowFuelRight).toBe(false);
    expect(ac.telemetry.instruments!.fuelLeft).toBeCloseTo(4.8 / 26.5, 3);
  });

  it('shows the gauges only with power', () => {
    const { f, ac } = cruise();
    ac.cockpit.set('battery', 0);
    fly(f, 0.1);
    expect(ac.telemetry.instruments!.fuelLeft).toBe(0);
    expect(ac.telemetry.systems!.fuelLeft).toBeGreaterThan(70);
  });
});
