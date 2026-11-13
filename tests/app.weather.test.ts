import { describe, expect, it } from 'vitest';
import { weatherFromReport } from '../src/app/liveWeather';
import { SNOW_LINE, nightFactor, seasonOf } from '../src/app/season';

describe('weatherFromReport', () => {
  const report = {
    temperature_2m: 18,
    dew_point_2m: 8,
    cloud_cover: 40,
    wind_speed_10m: 3.5,
    wind_direction_10m: 250,
    visibility: 24_000,
    precipitation: 0,
  };

  it('puts the cloud base where the air reaches its dew point', () => {
    const w = weatherFromReport(report, 510);
    // 10 degrees of spread: 1250 m above the field.
    expect(w.cloudBase).toBeCloseTo(1760, 0);
    expect(w.cloudTop).toBeGreaterThan(w.cloudBase + 700);
    expect(w.cloudCover).toBeCloseTo(0.4);
    expect(w.windFromDeg).toBe(250);
    expect(w.windSpeed).toBe(3.5);
    expect(w.visibility).toBe(24_000);
    expect(w.precipitation).toBe(0);
  });

  it('gives the temperature at sea level', () => {
    expect(weatherFromReport(report, 0).temperature).toBe(18);
    expect(weatherFromReport(report, 1707).temperature).toBeCloseTo(29.1, 1);
  });

  it('keeps odd reports inside sensible limits', () => {
    const w = weatherFromReport(
      {
        ...report,
        dew_point_2m: 19,
        cloud_cover: 130,
        visibility: 50,
        precipitation: 30,
        wind_direction_10m: -10,
      },
      510,
    );
    expect(w.cloudBase).toBe(810);
    expect(w.cloudCover).toBe(1);
    expect(w.visibility).toBe(1500);
    expect(w.precipitation).toBe(1);
    expect(w.windFromDeg).toBe(350);
    expect(weatherFromReport({ ...report, visibility: undefined }, 0).visibility).toBe(30_000);
  });
});

describe('season and night', () => {
  it('takes the season from the calendar', () => {
    expect(seasonOf(new Date('2026-01-15T12:00Z'))).toBe('winter');
    expect(seasonOf(new Date('2026-04-15T12:00Z'))).toBe('spring');
    expect(seasonOf(new Date('2026-07-15T12:00Z'))).toBe('summer');
    expect(seasonOf(new Date('2026-11-13T12:00Z'))).toBe('autumn');
    expect(seasonOf(new Date('2026-12-24T12:00Z'))).toBe('winter');
    expect(SNOW_LINE.winter).toBeLessThan(SNOW_LINE.spring);
    expect(SNOW_LINE.summer).toBeGreaterThan(SNOW_LINE.autumn);
  });

  it('turns the lights on through dusk', () => {
    expect(nightFactor(20)).toBe(0);
    expect(nightFactor(2)).toBe(0);
    expect(nightFactor(-6)).toBe(1);
    expect(nightFactor(-30)).toBe(1);
    expect(nightFactor(-2)).toBeCloseTo(0.5);
  });
});
