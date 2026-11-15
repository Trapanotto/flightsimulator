import { describe, expect, it } from 'vitest';
import {
  stratusFromReport,
  weatherFromOpenMeteo,
  type StratusReport,
} from '../src/sky/liveStratus';
import { fallSpeed, snowShare, temperatureAt } from '../src/sky/precipitation';
import {
  KOSCHMIEDER,
  belowness,
  billowData,
  diffuseTransmission,
  directThrough,
  sampleBillow,
  stratusCumulative,
  stratusExtinction,
  stratusOpticalDepth,
  stratusProfile,
  stratusThickness,
  stratusVisibility,
} from '../src/sky/stratus';
import { WEATHER_PRESETS } from '../src/sky/weather';

const deck = stratusProfile(WEATHER_PRESETS.lowStratus.stratus!);

describe('stratus deck', () => {
  it('holds the visibility below it and 50-150 m inside it', () => {
    expect(stratusVisibility(deck, 430)).toBeCloseTo(4000, 0);
    for (const h of [760, 850, 940]) {
      expect(stratusVisibility(deck, h)).toBeGreaterThanOrEqual(50);
      expect(stratusVisibility(deck, h)).toBeLessThanOrEqual(150);
    }
    expect(stratusVisibility(deck, 1100)).toBe(Infinity);
  });

  it('thickens the mist towards the base, without steps', () => {
    let last = 0;
    for (let h = 400; h <= 760; h += 1) {
      const s = stratusExtinction(deck, h);
      expect(s).toBeGreaterThanOrEqual(last - 1e-12);
      expect(Math.abs(s - last)).toBeLessThan(0.002);
      last = s;
    }
  });

  it('integrates its profile exactly (cumulative = sum of extinction)', () => {
    let sum = 0;
    const dh = 0.05;
    for (let h = 0; h < 1100; h += dh) sum += stratusExtinction(deck, h + dh / 2) * dh;
    expect(stratusCumulative(deck, 1100)).toBeCloseTo(sum, 3);
  });

  it('gives the optical depth of a slanted path from the end heights', () => {
    // 45 degrees through the whole deck: the vertical depth times sqrt 2.
    const vertical = stratusCumulative(deck, 1100) - stratusCumulative(deck, 500);
    expect(stratusOpticalDepth(deck, 500, 1100, 600 * Math.SQRT2)).toBeCloseTo(
      vertical * Math.SQRT2,
      6,
    );
    // Level: extinction times length (Koschmieder at the ground).
    expect(stratusOpticalDepth(deck, 430, 430, 4000)).toBeCloseTo(KOSCHMIEDER, 3);
  });

  it('is opaque to the sun under a 320 m deck and lets a pale disc through a thin one', () => {
    expect(directThrough(deck, 500, 0.4)).toBeLessThan(1e-6);
    expect(directThrough(deck, 1200, 0.4)).toBe(1);
    const thin = stratusProfile({ base: 700, top: 780, visibilityBelow: 5000 });
    const t = directThrough(thin, 500, 0.6);
    // Faint, but the disc is 10^5 times brighter than the sky around it.
    expect(t).toBeGreaterThan(1e-6);
    expect(t).toBeLessThan(1e-2);
  });

  it('lets a third to a half of the light diffuse through a Hochnebel', () => {
    // Two-stream: 1 / (1 + 3/4 (1 - g) tau); a 320 m deck has tau of about 15.
    expect(stratusThickness(deck)).toBeGreaterThan(10);
    const t = diffuseTransmission(stratusThickness(deck));
    expect(t).toBeGreaterThan(0.3);
    expect(t).toBeLessThan(0.55);
    expect(diffuseTransmission(0)).toBe(1);
  });

  it('blends the camera smoothly from above to below the deck', () => {
    expect(belowness(deck, 1200)).toBe(0);
    expect(belowness(deck, 500)).toBe(1);
    let last = 0;
    for (let h = 1100; h >= 500; h -= 2) {
      const b = belowness(deck, h);
      expect(b).toBeGreaterThanOrEqual(last);
      expect(b - last).toBeLessThan(0.02);
      last = b;
    }
  });

  it('has deterministic billows that the CPU reads like the GPU', () => {
    const a = billowData(64);
    const b = billowData(64);
    expect(a).toEqual(b);
    let lo = 1;
    let hi = 0;
    for (let i = 0; i < a.length; i += 4) {
      lo = Math.min(lo, a[i]!);
      hi = Math.max(hi, a[i]!);
    }
    expect(lo).toBe(0);
    expect(hi).toBe(1);
    // At a texel's centre the bilinear lookup returns the texel; it tiles.
    expect(sampleBillow(a, 64, 10.5 / 64, 20.5 / 64)[0]).toBeCloseTo(a[(20 * 64 + 10) * 4]!, 6);
    expect(sampleBillow(a, 64, 0.3, 0.7)[0]).toBeCloseTo(sampleBillow(a, 64, 1.3, -0.3)[0]!, 6);
  });
});

describe('precipitation', () => {
  it('turns to snow below about 1 °C', () => {
    expect(snowShare(5)).toBe(0);
    expect(snowShare(1)).toBeCloseTo(0.5, 6);
    expect(snowShare(-1)).toBe(1);
    expect(fallSpeed(0)).toBeCloseTo(7, 6);
    expect(fallSpeed(1)).toBeCloseTo(1.2, 6);
    expect(temperatureAt(4, 1000)).toBeCloseTo(-2.5, 6);
  });
});

describe('Hochnebel from a weather report', () => {
  // Zurich (430 m) on a November morning: 1 °C and saturated, a deck to ~1000 m, 7 °C and
  // dry above (Open-Meteo pressure levels).
  const zurich: StratusReport = {
    temperature_2m: 1,
    dew_point_2m: 0,
    cloud_cover: 100,
    cloud_cover_low: 100,
    cloud_cover_mid: 0,
    visibility: 3500,
    wind_speed_10m: 2,
    wind_direction_10m: 60,
    precipitation: 0,
    levels: [
      { height: 110, temperature: 2, humidity: 95 }, // 1000 hPa, below the ground
      { height: 320, temperature: 1.5, humidity: 96 }, // 975
      { height: 540, temperature: 0.5, humidity: 98 }, // 950
      { height: 780, temperature: -0.5, humidity: 99 }, // 925
      { height: 1020, temperature: 6.5, humidity: 35 }, // 900: the inversion
      { height: 1500, temperature: 4, humidity: 30 }, // 850
    ],
  };

  it('finds the deck under the inversion', () => {
    const s = stratusFromReport(zurich, 430)!;
    expect(s).toBeDefined();
    expect(s.top).toBeCloseTo(900, 0);
    expect(s.base).toBeGreaterThan(450);
    expect(s.base).toBeLessThan(700);
    expect(s.visibilityBelow).toBe(3500);
  });

  it('gives a whole weather with clear air above the deck', () => {
    const w = weatherFromOpenMeteo(zurich, 430);
    expect(w.stratus).toBeDefined();
    expect(w.cloudCover).toBe(0);
    expect(w.visibility).toBeGreaterThan(50_000);
    expect(w.temperature).toBeCloseTo(1 + 0.0065 * 430, 6);
    expect(w.windFromDeg).toBe(60);
  });

  it('sees no Hochnebel on a clear day or in a deep moist overcast', () => {
    expect(stratusFromReport({ ...zurich, cloud_cover_low: 10 }, 430)).toBeUndefined();
    const deep = zurich.levels!.map((l) => ({
      ...l,
      humidity: 97,
      temperature: 1 - l.height / 200,
    }));
    expect(stratusFromReport({ ...zurich, levels: deep }, 430)).toBeUndefined();
    expect(weatherFromOpenMeteo({ ...zurich, cloud_cover_low: 10 }, 430).stratus).toBeUndefined();
  });

  it('puts fog on the ground when the visibility says so', () => {
    const s = stratusFromReport({ ...zurich, visibility: 300, dew_point_2m: 0.8 }, 430)!;
    expect(s.base).toBeCloseTo(450, 0);
    expect(s.visibilityBelow).toBe(300);
  });

  it('falls back to a usual deck without pressure levels', () => {
    const s = stratusFromReport({ ...zurich, levels: undefined }, 430)!;
    expect(s.top - s.base).toBeGreaterThan(200);
  });
});
