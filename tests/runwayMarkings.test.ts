import { describe, expect, it } from 'vitest';
import { RUNWAYS, distanceM } from '../src/game/airports';
import { AERODROMES, ALL_RUNWAYS } from '../src/game/aerodromes.generated';
import {
  MAX_RUNWAYS,
  aimingPointDistance,
  nearestRunways,
  oppositeIdent,
  thresholdStripesPerSide,
} from '../src/world/runwayMarkings';

describe('runway markings', () => {
  it('names the opposite end like the real runways', () => {
    const pairs = RUNWAYS.map((r) => `${r.ident}/${oppositeIdent(r.ident)}`);
    expect(pairs).toEqual(['32/14', '25/07', '28/10', '21/03', '01/19', '22/04']);
    expect(oppositeIdent('18')).toBe('36');
    expect(oppositeIdent('36')).toBe('18');
  });

  it('paints as many threshold stripes as ICAO asks for the width', () => {
    // ICAO Annex 14: 18 m -> 4, 23 m -> 6, 30 m -> 8, 45 m -> 12, 60 m -> 16 stripes.
    expect([18, 23, 30, 45, 60].map((w) => 2 * thresholdStripesPerSide(w))).toEqual([
      4, 6, 8, 12, 16,
    ]);
  });

  it('puts the aiming point by runway length', () => {
    expect(aimingPointDistance(1000)).toBe(250);
    expect(aimingPointDistance(1730)).toBe(300);
    expect(aimingPointDistance(2500)).toBe(400);
  });

  it('knows the Swiss airports and their runways (OpenStreetMap)', () => {
    expect(AERODROMES.length).toBeGreaterThan(30);
    expect(ALL_RUNWAYS.length).toBeGreaterThan(40);
    const zrh = ALL_RUNWAYS.filter((r) => r.icao === 'LSZH').map((r) => r.ident);
    expect(zrh.sort()).toEqual(['10', '14', '34']);
    for (const r of ALL_RUNWAYS) {
      expect(distanceM(r.from, r.to)).toBeGreaterThan(300);
      expect(r.widthM).toBeGreaterThanOrEqual(10);
    }
    // The curated start runways are among them (same airport).
    for (const r of RUNWAYS) expect(ALL_RUNWAYS.some((a) => a.icao === r.icao)).toBe(true);
  });

  it('paints the runways nearest to the camera', () => {
    const near = nearestRunways(8.55, 47.46);
    expect(near.length).toBe(MAX_RUNWAYS);
    expect(near.slice(0, 3).every((r) => r.icao === 'LSZH')).toBe(true);
  });
});
