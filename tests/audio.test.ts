import { describe, expect, it } from 'vitest';
import { engineLevel, groundRollLevel, windLevel } from '../src/audio/levels';

describe('sound levels', () => {
  it('has a silent stopped engine and a louder one at higher rpm, quieter inside', () => {
    expect(engineLevel(0, false)).toBe(0);
    expect(engineLevel(600, false)).toBeGreaterThan(0.2);
    expect(engineLevel(2700, false)).toBeGreaterThan(engineLevel(1000, false));
    expect(engineLevel(2700, true)).toBeLessThan(engineLevel(2700, false));
    expect(engineLevel(5000, false)).toBeLessThanOrEqual(1);
  });

  it('lets the wind grow with the square of the airspeed', () => {
    expect(windLevel(0, 80, false)).toBe(0);
    expect(windLevel(40, 80, false)).toBeCloseTo(windLevel(80, 80, false) / 4, 6);
    expect(windLevel(200, 80, false)).toBe(windLevel(80, 80, false));
  });

  it('rumbles only while rolling on the ground', () => {
    expect(groundRollLevel(false, 30, false)).toBe(0);
    expect(groundRollLevel(true, 0, false)).toBe(0);
    expect(groundRollLevel(true, 20, false)).toBeGreaterThan(0);
  });
});
