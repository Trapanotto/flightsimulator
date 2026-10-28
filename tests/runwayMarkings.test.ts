import { describe, expect, it } from 'vitest';
import { RUNWAYS, distanceM } from '../src/game/airports';
import {
  MAX_RUNWAYS,
  aimingPointDistance,
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

  it('fits every runway into the shader arrays', () => {
    expect(RUNWAYS.length).toBeLessThanOrEqual(MAX_RUNWAYS);
    for (const r of RUNWAYS) expect(distanceM(r.from, r.to)).toBeGreaterThan(1000);
  });
});
