import { describe, expect, it } from 'vitest';
import {
  EXPOSURE_KEY,
  MIE_EXTINCTION,
  RAYLEIGH_SCATTERING,
  SOLAR_ILLUMINANCE_LUX,
  exposureFor,
  horizontalIlluminance,
  mieDensityFromVisibility,
  opticalDepthToSpace,
  skyDiffuseLux,
  sunIlluminance,
  sunVisibility,
  transmittanceToSpace,
} from '../src/sky/atmosphere';
import {
  azimuthElevation,
  directionFromAzEl,
  equatorialToLocal,
  greenwichSiderealTime,
  moonEquatorial,
  moonIlluminanceLux,
  moonIlluminatedFraction,
  moonPosition,
} from '../src/sky/astro';
import { weatherMapData } from '../src/sky/cloudNoise';
import { solarPosition } from '../src/sky/solar';
import { WEATHER_PRESETS, cloudWind } from '../src/sky/weather';

const BERN = { lat: 46.95, lon: 7.44 };

describe('atmosphere', () => {
  it('has the optical depth of an exponential atmosphere straight up', () => {
    // Rayleigh: beta * H (1 - e^(-100/H)); Mie: ext * H_M; ozone: the tent's area (15 km).
    const [r, , b] = opticalDepthToSpace(0, 1, 1);
    const rayleigh = (beta: number) => beta * 8 * (1 - Math.exp(-100 / 8));
    const mie = MIE_EXTINCTION * 1.2;
    expect(r).toBeCloseTo(rayleigh(RAYLEIGH_SCATTERING[0]) + mie + 0.65e-3 * 15, 3);
    expect(b).toBeCloseTo(rayleigh(RAYLEIGH_SCATTERING[2]) + mie + 0.085e-3 * 15, 3);
  });

  it('matches the published Rayleigh optical depth at 550 nm', () => {
    // Bucholtz 1995: 0.0973 at sea level for 550 nm; the model's green channel stands for it.
    const tau = RAYLEIGH_SCATTERING[1] * 8;
    expect(Math.abs(tau - 0.0973) / 0.0973).toBeLessThan(0.15);
  });

  it('lets the noon sun through white-ish and the setting sun red', () => {
    const noon = solarPosition(new Date('2026-06-21T11:32:00Z'), BERN.lat, BERN.lon);
    const mu = Math.sin((noon.elevation * Math.PI) / 180);
    const [r, g, b] = sunIlluminance(0.5, mu, mieDensityFromVisibility(50_000));
    expect(Math.min(r, g, b)).toBeGreaterThan(0.6);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(b / r).toBeGreaterThan(0.75);

    const [hr, hg, hb] = sunIlluminance(0.5, 0.005, mieDensityFromVisibility(50_000));
    expect(hr).toBeGreaterThan(3 * hg);
    expect(hr).toBeGreaterThan(30 * hb);
    expect(hr).toBeLessThan(0.1);
  });

  it('sinks the sun disc behind the curved Earth over its own size', () => {
    // From 10 km the horizon dips by about 3.2 degrees.
    const dip = Math.acos(6360 / 6370);
    expect(sunVisibility(10, Math.sin(-dip + 0.01))).toBe(1);
    expect(sunVisibility(10, Math.sin(-dip - 0.01))).toBe(0);
    expect(sunVisibility(10, Math.sin(-dip))).toBeCloseTo(0.5, 1);
    expect(sunIlluminance(0.5, -0.2)).toEqual([0, 0, 0]);
  });

  it('sees more of the sky through less air from higher up', () => {
    const low = transmittanceToSpace(0, 0.3);
    const high = transmittanceToSpace(10, 0.3);
    for (let c = 0; c < 3; c++) expect(high[c]!).toBeGreaterThan(low[c]!);
  });

  it('turns visibility into haze that gives that visibility back (Koschmieder)', () => {
    for (const v of [5_000, 20_000, 60_000]) {
      const ext = RAYLEIGH_SCATTERING[1] + MIE_EXTINCTION * mieDensityFromVisibility(v);
      expect(ext * (v / 1000)).toBeCloseTo(3.912, 2);
    }
    // Clearer than the air molecules alone allow: clamped, never negative.
    expect(mieDensityFromVisibility(400_000)).toBeGreaterThan(0);
  });

  it('knows the twilight illuminance', () => {
    // About 700 lux at sunset, 3.4 at the end of civil twilight (USNO).
    expect(skyDiffuseLux(0)).toBeGreaterThan(500);
    expect(skyDiffuseLux(0)).toBeLessThan(1000);
    expect(skyDiffuseLux(-6)).toBeGreaterThan(2.5);
    expect(skyDiffuseLux(-6)).toBeLessThan(4.5);
    for (let el = -20; el < 90; el += 0.5)
      expect(skyDiffuseLux(el + 0.5)).toBeGreaterThanOrEqual(skyDiffuseLux(el));
  });

  it('suggests an exposure that darkens the picture smoothly into the night', () => {
    const noonLux = horizontalIlluminance(66, [0.85, 0.85, 0.85], 0);
    expect(noonLux).toBeGreaterThan(80_000);
    const noon = exposureFor(noonLux, 66);
    expect(noon).toBeCloseTo(EXPOSURE_KEY / (noonLux / SOLAR_ILLUMINANCE_LUX) ** 0.65, 5);
    // The picture of the land darkens monotonically as the sun goes down, without jumps.
    let lastX = 0;
    let lastBrightness = Infinity;
    for (let el = 30; el >= -25; el -= 0.25) {
      const sinEl = Math.max(Math.sin((el * Math.PI) / 180), 0);
      const lux = horizontalIlluminance(el, [0.8 * sinEl, 0.8 * sinEl, 0.8 * sinEl], 0);
      const x = exposureFor(lux, el);
      expect(lux * x).toBeLessThanOrEqual(lastBrightness * 1.0001);
      if (lastX) expect(Math.abs(Math.log(x / lastX))).toBeLessThan(Math.log(1.6));
      lastX = x;
      lastBrightness = lux * x;
    }
    expect(lastX).toBeGreaterThan(1e4 * noon);
    // A night is a night: the picture of the land is much darker than at noon.
    const night = exposureFor(horizontalIlluminance(-25, [0, 0, 0], 0), -25);
    const nightBrightness = horizontalIlluminance(-25, [0, 0, 0], 0) * night;
    expect(nightBrightness / (noonLux * noon)).toBeLessThan(0.05);
    expect(nightBrightness / (noonLux * noon)).toBeGreaterThan(0.005);
  });
});

describe('moon and stars', () => {
  it('computes sidereal time (Meeus, example 12.a)', () => {
    // 1987 April 10, 0h UT: 13h10m46.3668s.
    const gmst = greenwichSiderealTime(new Date('1987-04-10T00:00:00Z'));
    expect(gmst).toBeCloseTo((13 + 10 / 60 + 46.3668 / 3600) * 15, 2);
  });

  it('places the moon (Meeus, example 47.a)', () => {
    // 1992 April 12, 0h TD: right ascension 134.688°, declination +13.768°.
    const m = moonEquatorial(new Date('1992-04-12T00:00:00Z'));
    expect(Math.abs(m.ra - 134.688)).toBeLessThan(0.5);
    expect(Math.abs(m.dec - 13.768)).toBeLessThan(0.5);
    expect(m.parallax).toBeGreaterThan(0.9);
    expect(m.parallax).toBeLessThan(1.02);
  });

  it('knows full and new moon', () => {
    const fraction = (iso: string) => {
      const date = new Date(iso);
      const s = solarPosition(date, BERN.lat, BERN.lon);
      const sun = directionFromAzEl(s.azimuth, s.elevation);
      return moonIlluminatedFraction(sun, moonPosition(date, BERN.lat, BERN.lon).direction);
    };
    // Full moon 2024-01-25 17:54 UTC, new moon 2024-01-11 11:57 UTC.
    expect(fraction('2024-01-25T17:54:00Z')).toBeGreaterThan(0.98);
    expect(fraction('2024-01-11T11:57:00Z')).toBeLessThan(0.02);
    expect(fraction('2024-01-18T03:53:00Z')).toBeCloseTo(0.5, 1);
  });

  it('dims the moonlight with the phase', () => {
    expect(moonIlluminanceLux(1)).toBeCloseTo(0.26, 2);
    const half = moonIlluminanceLux(0.5) / moonIlluminanceLux(1);
    expect(half).toBeGreaterThan(0.06);
    expect(half).toBeLessThan(0.14);
    expect(moonIlluminanceLux(0)).toBeLessThan(0.001);
  });

  it('turns the sky about the pole star', () => {
    // Polaris (RA 2h31m49s, Dec +89.264°) stands at the latitude, due north.
    const ra = ((2 + 31 / 60 + 49 / 3600) * 15 * Math.PI) / 180;
    const dec = (89.264 * Math.PI) / 180;
    const e = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
    for (const iso of ['2026-06-21T22:00:00Z', '2026-12-21T03:00:00Z']) {
      const m = equatorialToLocal(new Date(iso), BERN.lat, BERN.lon);
      const v = [0, 1, 2].map(
        (i) => m[i * 3]! * e[0]! + m[i * 3 + 1]! * e[1]! + m[i * 3 + 2]! * e[2]!,
      );
      const { azimuth, elevation } = azimuthElevation(v as [number, number, number]);
      expect(Math.abs(elevation - BERN.lat)).toBeLessThan(1);
      expect(Math.min(azimuth, 360 - azimuth)).toBeLessThan(1.5);
    }
  });

  it('round-trips azimuth and elevation in render space (x east, y up, z south)', () => {
    expect(directionFromAzEl(90, 0)[0]).toBeCloseTo(1);
    expect(directionFromAzEl(180, 0)[2]).toBeCloseTo(1);
    const back = azimuthElevation(directionFromAzEl(237, 21));
    expect(back.azimuth).toBeCloseTo(237, 6);
    expect(back.elevation).toBeCloseTo(21, 6);
  });
});

describe('weather', () => {
  it('has the four presets of phase 1, from clear to overcast', () => {
    const order = ['clear', 'fair', 'cloudy', 'overcast'] as const;
    for (const name of order) {
      const w = WEATHER_PRESETS[name];
      expect(w.cloudCover).toBeGreaterThanOrEqual(0);
      expect(w.cloudCover).toBeLessThanOrEqual(1);
      expect(w.cloudTop).toBeGreaterThan(w.cloudBase + 500);
      expect(w.visibility).toBeGreaterThan(1000);
    }
    for (let i = 1; i < order.length; i++) {
      expect(WEATHER_PRESETS[order[i]!].cloudCover).toBeGreaterThan(
        WEATHER_PRESETS[order[i - 1]!].cloudCover,
      );
      expect(WEATHER_PRESETS[order[i]!].visibility).toBeLessThan(
        WEATHER_PRESETS[order[i - 1]!].visibility,
      );
    }
    expect(WEATHER_PRESETS.clear.cloudCover).toBe(0);
    expect(WEATHER_PRESETS.overcast.cloudCover).toBeGreaterThan(0.9);
  });

  it('drifts the clouds downwind, a little veered', () => {
    // A west wind carries the clouds east; the wind aloft veers to the right.
    const w = cloudWind({ ...WEATHER_PRESETS.fair, windFromDeg: 270, windSpeed: 5 });
    expect(w.east).toBeGreaterThan(5);
    expect(w.south).toBeGreaterThan(0);
    expect(w.south).toBeLessThan(w.east);
  });
});

describe('cloud noise', () => {
  it('is deterministic and spans clear and covered ground', () => {
    const a = weatherMapData(32);
    const b = weatherMapData(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    let lo = 255;
    let hi = 0;
    for (let i = 0; i < a.length; i += 4) {
      lo = Math.min(lo, a[i]!);
      hi = Math.max(hi, a[i]!);
    }
    expect(lo).toBeLessThan(40);
    expect(hi).toBeGreaterThan(200);
  });
});
