/** Airframe icing: where it forms, and what it does to weight, drag and the stall. */
import { describe, expect, it } from 'vitest';
import type { FlightModel } from '../../src/sim/flightModel';
import { icingSeverity } from '../../src/sim/systems/icing';
import { AltitudePilot, KT, airborne, fly } from './harness';
import { stallSpeed } from './procedures';

const fm = (ac: unknown) => ac as FlightModel;

describe('airframe icing', () => {
  it('forms in visible moisture below freezing only', () => {
    expect(icingSeverity(-5, 1)).toBe(1);
    expect(icingSeverity(-5, 0)).toBe(0);
    expect(icingSeverity(5, 1)).toBe(0);
    // Very cold cloud is ice crystals that do not stick.
    expect(icingSeverity(-30, 1)).toBe(0);
    expect(icingSeverity(-20, 1)).toBeGreaterThan(0);
    expect(icingSeverity(-20, 1)).toBeLessThan(1);

    const cloud = airborne(1500, 100, { isaDeviation: -20, moisture: 1 });
    const pilot = new AltitudePilot(cloud.ac, 0, 1500);
    fly(cloud, 300, (dt) => pilot.step(dt));
    const ice = cloud.ac.telemetry.systems!.airframeIce;
    expect(ice).toBeGreaterThan(0.2);
    expect(ice).toBeLessThan(0.6);
    const warm = airborne(1500, 100, { moisture: 1 });
    fly(warm, 60);
    expect(warm.ac.telemetry.systems!.airframeIce).toBe(0);
  });

  it('melts off in air above freezing', () => {
    const f = airborne(1500, 100, { isaDeviation: 10 });
    fm(f.ac).systems.icing.airframe = 0.5;
    fly(f, 120);
    expect(f.ac.telemetry.systems!.airframeIce).toBeLessThan(0.5);
  });

  it('adds weight and drag: the same power gives less speed', () => {
    const speed = (ice: number) => {
      // Cold and dry: the ice neither grows nor melts.
      const f = airborne(1500, 105, { isaDeviation: -20 });
      const ac = fm(f.ac);
      const mass = ac.mass;
      ac.systems.icing.airframe = ice;
      if (ice > 0) expect(ac.mass).toBeGreaterThan(mass + 20);
      const pilot = new AltitudePilot(ac, 0, 1500);
      fly(f, 150, (dt) => pilot.step(dt));
      return ac.telemetry.tas / KT;
    };
    const clean = speed(0);
    const iced = speed(0.7);
    expect(iced).toBeLessThan(clean - 8);
  });

  it('raises the stall speed, and the stall horn warns late', () => {
    const clean = stallSpeed(0);
    const iced = stallSpeed(0, (f) => {
      fm(f.ac).systems.icing.airframe = 0.7;
    });
    expect(iced.stalled).toBe(true);
    expect(iced.kcas).toBeGreaterThan(clean.kcas * 1.05);
    const margin = (s: typeof clean) => (s.warningKias ? s.warningKias - s.kias : 0);
    expect(margin(iced)).toBeLessThan(margin(clean) - 2);
  });
});
