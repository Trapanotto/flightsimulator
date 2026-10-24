import { describe, expect, it } from 'vitest';
import { RUNWAYS, bearingDeg, distanceM } from '../src/game/airports';

describe('runways', () => {
  it('headings match the runway designators within 10°', () => {
    for (const r of RUNWAYS) {
      const h = bearingDeg(r.from, r.to);
      const designated = Number(r.ident) * 10;
      const diff = Math.abs(((h - designated + 540) % 360) - 180);
      expect(diff, `${r.icao} ${r.ident}: ${h.toFixed(1)}°`).toBeLessThan(10);
    }
  });

  it('lengths are plausible (Bern 1.7 km, Zürich 28 2.5 km)', () => {
    const len = (icao: string) =>
      distanceM(
        RUNWAYS.find((r) => r.icao === icao)!.from,
        RUNWAYS.find((r) => r.icao === icao)!.to,
      );
    expect(len('LSZB')).toBeGreaterThan(1600);
    expect(len('LSZB')).toBeLessThan(1800);
    expect(len('LSZH')).toBeGreaterThan(2400);
  });
});
