import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { bankAt, PATH_LENGTH, pointAt } from '../src/game/showcasePath';

const DEG = Math.PI / 180;

describe('showcase flight path', () => {
  it('is a closed loop of about 29 km', () => {
    expect(PATH_LENGTH).toBeGreaterThan(24_000);
    expect(PATH_LENGTH).toBeLessThan(32_000);
    const a = pointAt(0, new Vector3());
    const b = pointAt(PATH_LENGTH, new Vector3());
    expect(a.distanceTo(b)).toBeLessThan(1);
  });

  for (const v of [55, 80, 110]) {
    it(`banks smoothly at ${v} m/s (no jumps, gentle roll rates)`, () => {
      const dt = 1 / 30;
      let worstRate = 0;
      let worstAccel = 0;
      let maxBank = 0;
      let prevRate = 0;
      let prev = bankAt(0, v);
      for (let s = v * dt; s < PATH_LENGTH; s += v * dt) {
        const b = bankAt(s, v);
        const rate = (b - prev) / dt;
        worstRate = Math.max(worstRate, Math.abs(rate));
        worstAccel = Math.max(worstAccel, Math.abs(rate - prevRate) / dt);
        maxBank = Math.max(maxBank, Math.abs(b));
        prev = b;
        prevRate = rate;
      }
      expect(worstRate).toBeLessThan(12 * DEG);
      expect(worstAccel).toBeLessThan(25 * DEG);
      expect(maxBank).toBeGreaterThan(10 * DEG);
    });
  }

  it('climbs and descends gently', () => {
    const step = 50;
    let worst = 0;
    const a = new Vector3();
    const b = new Vector3();
    for (let s = 0; s < PATH_LENGTH; s += step) {
      pointAt(s, a);
      pointAt(s + step, b);
      worst = Math.max(worst, Math.abs(b.z - a.z) / step);
    }
    // Flight path angle below ~8 degrees.
    expect(worst).toBeLessThan(0.14);
  });
});
