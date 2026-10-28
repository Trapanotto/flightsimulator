import { describe, expect, it } from 'vitest';
import { WEATHER_COVERAGE, WEATHER_FOG, type Weather } from '../src/core/settings';

describe('weather presets', () => {
  it('every weather has a cloud cover, fog only for the fog presets', () => {
    for (const w of Object.keys(WEATHER_COVERAGE) as Weather[]) {
      expect(WEATHER_COVERAGE[w]).toBeGreaterThanOrEqual(0);
      expect(WEATHER_COVERAGE[w]).toBeLessThanOrEqual(1);
    }
    expect(WEATHER_FOG.fair).toBeNull();
    expect(WEATHER_FOG.clear).toBeNull();
  });

  it('Hochnebel sits over the Mittelland, below the Alps', () => {
    const f = WEATHER_FOG.hochnebel!;
    // Mittelland 400-600 m lies under it, Napf (1400 m) and the Alps above it.
    expect(f.base).toBeGreaterThan(600);
    expect(f.top).toBeGreaterThan(f.base + 200);
    expect(f.top).toBeLessThan(1400);
    // Visibility inside (3 / extinction) of about 150 m.
    expect(3 / f.density).toBeGreaterThan(100);
    expect(3 / f.density).toBeLessThan(250);
  });

  it('ground fog reaches down to the ground', () => {
    const f = WEATHER_FOG.nebel!;
    expect(f.base).toBeLessThan(0);
    expect(f.top).toBeGreaterThan(500);
  });
});
