import { describe, expect, it } from 'vitest';
import { resolveTime, solarPosition, swissTime } from '../src/render/sun';

const BERN = { lat: 46.948, lon: 7.4474 };

describe('sun', () => {
  it('is high at noon in summer and low in winter (Bern)', () => {
    // Solar noon in Bern is ~11:30 UTC.
    const summer = solarPosition(new Date(Date.UTC(2026, 5, 21, 11, 30)), BERN.lat, BERN.lon);
    expect(summer.elevation).toBeGreaterThan(65.8);
    expect(summer.elevation).toBeLessThan(67);
    expect(summer.azimuth).toBeGreaterThan(170);
    expect(summer.azimuth).toBeLessThan(190);
    const winter = solarPosition(new Date(Date.UTC(2026, 11, 21, 11, 30)), BERN.lat, BERN.lon);
    expect(winter.elevation).toBeGreaterThan(19);
    expect(winter.elevation).toBeLessThan(20.5);
  });

  it('rises in the east and sets in the west', () => {
    const morning = solarPosition(new Date(Date.UTC(2026, 5, 21, 4, 30)), BERN.lat, BERN.lon);
    expect(morning.azimuth).toBeGreaterThan(50);
    expect(morning.azimuth).toBeLessThan(80);
    const evening = solarPosition(new Date(Date.UTC(2026, 5, 21, 19, 0)), BERN.lat, BERN.lon);
    expect(evening.azimuth).toBeGreaterThan(280);
    expect(evening.azimuth).toBeLessThan(310);
  });

  it('converts Swiss local time with summer time', () => {
    expect(swissTime(new Date(Date.UTC(2026, 6, 1)), 12, 0).toISOString()).toBe(
      '2026-07-01T10:00:00.000Z',
    );
    expect(swissTime(new Date(Date.UTC(2026, 0, 15)), 12, 0).toISOString()).toBe(
      '2026-01-15T11:00:00.000Z',
    );
  });

  it('replaces night with the evening golden hour', () => {
    const night = new Date(Date.UTC(2026, 9, 24, 22, 0));
    const t = resolveTime(null, night);
    const e = solarPosition(t, 46.8, 8.2).elevation;
    expect(e).toBeGreaterThan(5);
    expect(e).toBeLessThan(11);
    expect(resolveTime('19:30', night).toISOString()).toBe('2026-10-24T17:30:00.000Z');
  });
});

describe('time-of-day presets', () => {
  it('morning, noon and golden hour have daylight in winter and summer', async () => {
    const { morning, noon, goldenHour } = await import('../src/render/sun');
    for (const day of [new Date(Date.UTC(2026, 11, 21)), new Date(Date.UTC(2026, 5, 21))]) {
      expect(solarPosition(morning(day), 46.8, 8.2).elevation).toBeGreaterThan(9);
      expect(solarPosition(noon(day), 46.8, 8.2).elevation).toBeGreaterThan(18);
      const g = solarPosition(goldenHour(day), 46.8, 8.2);
      expect(g.elevation).toBeGreaterThan(5);
      expect(g.azimuth).toBeGreaterThan(200);
    }
  });
});
