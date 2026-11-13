import { describe, expect, it } from 'vitest';
import { FixedStep, SIM_DT, SIM_HZ, isa } from '../src/sim';

describe('FixedStep', () => {
  it('takes the same number of steps whatever the frame rate', () => {
    for (const fps of [30, 60, 144, 240]) {
      const loop = new FixedStep();
      for (let i = 0; i < fps * 2; i++) loop.advance(1 / fps, () => {});
      // Two seconds of frames = two seconds of simulation (one step of rounding slack).
      expect(Math.abs(loop.steps - 2 * SIM_HZ)).toBeLessThanOrEqual(1);
    }
  });

  it('always steps by the fixed dt and returns a blend factor in 0..1', () => {
    const loop = new FixedStep();
    const dts: number[] = [];
    const alpha = loop.advance(0.0201, (dt) => dts.push(dt));
    expect(dts.every((dt) => dt === SIM_DT)).toBe(true);
    expect(dts.length).toBe(2);
    expect(alpha).toBeGreaterThanOrEqual(0);
    expect(alpha).toBeLessThan(1);
  });

  it('cuts a long frame instead of spiralling', () => {
    const loop = new FixedStep(SIM_DT, 8);
    let n = 0;
    loop.advance(5, () => n++);
    expect(n).toBe(8);
  });

  it('is repeatable: same frames, same steps', () => {
    const run = () => {
      const loop = new FixedStep();
      const frames = [0.016, 0.017, 0.033, 0.008, 0.1, 0.016];
      return frames.map((f) => {
        let n = 0;
        loop.advance(f, () => n++);
        return n;
      });
    };
    expect(run()).toEqual(run());
  });
});

describe('isa', () => {
  it('matches the standard atmosphere', () => {
    const sea = isa(0);
    expect(sea.temperature).toBeCloseTo(288.15, 2);
    expect(sea.pressure).toBeCloseTo(101_325, 0);
    expect(sea.density).toBeCloseTo(1.225, 3);
    expect(sea.speedOfSound).toBeCloseTo(340.3, 1);
    // Published table values.
    expect(isa(2000).density).toBeCloseTo(1.0066, 3);
    expect(isa(5000).pressure).toBeCloseTo(54_048, -2);
    expect(isa(11_000).temperature).toBeCloseTo(216.65, 2);
    expect(isa(15_000).pressure).toBeCloseTo(12_045, -1);
  });

  it('gives thinner air on a hot day', () => {
    expect(isa(500, 20).density).toBeLessThan(isa(500).density);
    expect(isa(500, 20).pressure).toBe(isa(500).pressure);
  });
});
