import { describe, expect, it } from 'vitest';
import { type RunwayInfo, findAirport } from '../../src/geo';
import {
  CAUTION_ZONE,
  EDGE_SPACING,
  LightKind,
  PAPI_ANGLES,
  aimingPoint,
  approachLights,
  glyphIndex,
  papiColour,
  papiReds,
  runwayLights,
  runwayMarkings,
  stripeLayout,
  thresholdStripes,
  touchdownBars,
  touchdownPairs,
} from '../../src/world/airports/layout';

const runway = (over: Partial<RunwayInfo> = {}): RunwayInfo => ({
  width: 45,
  length: 3000,
  surface: 'asphalt',
  lighted: true,
  ends: [
    { ident: '14', lon: 8.5, lat: 47.5 },
    { ident: '32', lon: 8.53, lat: 47.48 },
  ],
  ...over,
});

describe('threshold markings (Annex 14, 5.2.4)', () => {
  it('has the number of stripes the runway width asks for', () => {
    expect(thresholdStripes(18)).toBe(4);
    expect(thresholdStripes(23)).toBe(6);
    expect(thresholdStripes(30)).toBe(8);
    expect(thresholdStripes(45)).toBe(12);
    expect(thresholdStripes(60)).toBe(16);
    // In between: the narrower width's count.
    expect(thresholdStripes(40)).toBe(8);
    expect(thresholdStripes(15)).toBe(4);
  });

  it('spreads the stripes to 3 m inside the edge, at most 27 m from the centre line', () => {
    for (const w of [18, 23, 30, 45, 60]) {
      const { perSide, unit } = stripeLayout(w);
      const outer = 2 * perSide * unit;
      expect(outer).toBeCloseTo(Math.min(w / 2 - 3, 27), 6);
      // Stripes about 1.8 m wide (Annex 14 nominal), never thinner than 1.4 m.
      expect(unit).toBeGreaterThan(1.4);
      expect(unit).toBeLessThan(1.9);
    }
  });
});

describe('aiming point and touchdown zone (Annex 14, table 5-1 and 5.2.6)', () => {
  it('places the aiming point by landing distance', () => {
    expect(aimingPoint(700)).toBeUndefined();
    expect(aimingPoint(1000)!.start).toBe(250);
    expect(aimingPoint(2000)!.start).toBe(300);
    expect(aimingPoint(3000)!.start).toBe(400);
    expect(aimingPoint(3000)!.inner).toBe(18);
  });

  it('has the pairs of touchdown markings the landing distance asks for', () => {
    expect(touchdownPairs(800)).toBe(1);
    expect(touchdownPairs(1000)).toBe(2);
    expect(touchdownPairs(1300)).toBe(3);
    expect(touchdownPairs(2000)).toBe(4);
    expect(touchdownPairs(3000)).toBe(6);
  });

  it('counts the aiming point as a pair and never paints over it', () => {
    const lda = 3000;
    const aim = aimingPoint(lda)!;
    const bars = touchdownBars(lda, aim);
    // Six pairs at 3000 m: the aiming point and five bars (450 m would touch the aiming point).
    expect(bars.length + 1).toBe(6);
    expect(bars.map((b) => b.at)).toEqual([150, 300, 600, 750, 900]);
    for (const b of bars) {
      expect(b.at % 150).toBe(0);
      const overlaps = b.at < aim.start + aim.length && b.at + 22.5 > aim.start;
      expect(overlaps).toBe(false);
    }
    expect(bars[0]).toEqual({ at: 150, count: 3 });
    // Short runway: nothing beyond the middle.
    for (const b of touchdownBars(1000, aimingPoint(1000))) expect(b.at + 22.5).toBeLessThan(500);
  });

  it('puts no paint on grass and the right glyphs on each end', () => {
    expect(runwayMarkings(runway({ surface: 'grass' }))).toBeUndefined();
    const m = runwayMarkings(
      runway({
        ends: [
          { ident: '14L', lon: 8.5, lat: 47.5 },
          { ident: '32R', lon: 8.53, lat: 47.48 },
        ],
      }),
    )!;
    expect(m.ends[0].glyphs).toEqual([1, 4, glyphIndex('L')]);
    expect(m.ends[1].glyphs).toEqual([3, 2, glyphIndex('R')]);
    expect(glyphIndex('C')).toBe(12);
    expect(glyphIndex('')).toBe(-1);
  });
});

describe('PAPI (Annex 14, 5.3.5)', () => {
  it('shows two red and two white on a 3 degree path', () => {
    expect(papiReds(3)).toBe(2);
    expect(papiReds(2)).toBe(4);
    expect(papiReds(4)).toBe(0);
    expect(papiReds(2.7)).toBe(3);
    expect(papiReds(3.3)).toBe(1);
    // The unit nearest the runway has the highest setting.
    expect(PAPI_ANGLES[0]).toBeGreaterThan(PAPI_ANGLES[3]!);
    expect(papiColour(3.5, 3)).toBe('red');
    expect(papiColour(2.5, 3)).toBe('white');
  });
});

describe('runway lights', () => {
  it('puts edge lights at most 60 m apart on both sides, yellow on the last 600 m', () => {
    const r = runway({
      ends: [
        { ident: '14', lon: 8.5, lat: 47.5, approach: 'ils' },
        { ident: '32', lon: 8.53, lat: 47.48 },
      ],
    });
    const lights = runwayLights(r, { centreSpacing: 15, touchdownZone: true });
    const edges = lights.filter(
      (l) =>
        Math.abs(Math.abs(l.t) - (r.width / 2 + 1)) < 1e-6 && l.kind === LightKind.Bidirectional,
    );
    const left = edges
      .filter((l) => l.t < 0)
      .map((l) => l.s)
      .sort((a, b) => a - b);
    for (let i = 1; i < left.length; i++)
      expect(left[i]! - left[i - 1]!).toBeLessThanOrEqual(EDGE_SPACING + 1e-6);
    // Landing on 14 (towards B) sees colour B: yellow near the far end only.
    for (const l of edges) {
      expect(l.colourB).toBe(r.length - l.s < CAUTION_ZONE ? 'yellow' : 'white');
      expect(l.colourA).toBe('white'); // 32 has no instrument approach
    }
  });

  it('shows green to the approach and red to the runway at each end', () => {
    const lights = runwayLights(runway(), { centreSpacing: 30, touchdownZone: false });
    const atA = lights.filter((l) => l.s === 0 && Math.abs(l.t) <= 22.5);
    expect(atA.length).toBeGreaterThanOrEqual(6);
    for (const l of atA) {
      expect(l.axis).toBe(1);
      expect(l.colourB).toBe('green'); // the approach to 14 is behind the A->B axis
      expect(l.colourA).toBe('red');
    }
  });

  it('builds an approach light system and four PAPI units per equipped end', () => {
    const r = runway({
      ends: [
        { ident: '14', lon: 8.5, lat: 47.5, approach: 'ils', als: 'precision', papi: 'left' },
        { ident: '32', lon: 8.53, lat: 47.48, als: 'simple', papi: 'right' },
      ],
    });
    const lights = runwayLights(r, { centreSpacing: 15, touchdownZone: true });
    const papi = lights.filter((l) => l.kind === LightKind.Papi);
    expect(papi).toHaveLength(8);
    // 14's PAPI on its left (t < 0), 32's on its right (also t < 0 looking from A).
    expect(papi.filter((l) => l.s < 1000).every((l) => l.t < -r.width / 2)).toBe(true);
    expect(papi.filter((l) => l.s > 2000).every((l) => l.t < -r.width / 2)).toBe(true);
    const flashers = lights.filter((l) => l.kind === LightKind.Flasher);
    expect(flashers.length).toBeGreaterThan(15);
    expect(flashers.every((l) => l.s < -300 && l.s >= -900)).toBe(true);
    // Simple system: 420 m long in front of 32.
    const als32 = lights.filter((l) => l.s > r.length && l.kind === LightKind.Unidirectional);
    expect(Math.max(...als32.map((l) => l.s)) - r.length).toBeCloseTo(420, 6);
    // Lights per runway: a few hundred, not thousands.
    expect(lights.length).toBeLessThan(1500);
  });

  it('turns the centre line red towards the end (Annex 14, 5.3.12.7)', () => {
    const r = runway({ centerLights: true });
    const centre = runwayLights(r, { centreSpacing: 15, touchdownZone: false }).filter(
      (l) => l.t === 0,
    );
    for (const l of centre) {
      const remaining = r.length - l.s; // landing towards B looks with colour B
      if (remaining < 300) expect(l.colourB).toBe('red');
      if (remaining > 900) expect(l.colourB).toBe('white');
    }
    expect(centre.length).toBeGreaterThan(r.length / 15 - 2);
  });

  it('has no lights on an unlit runway', () => {
    expect(
      runwayLights(runway({ lighted: false }), { centreSpacing: 15, touchdownZone: true }),
    ).toHaveLength(0);
  });

  it('places approach lights on the extended centre line only', () => {
    let n = 0;
    approachLights('simple', (a, x) => {
      n++;
      expect(a).toBeLessThan(0);
      expect(Math.abs(x)).toBeLessThanOrEqual(15);
    });
    expect(n).toBeGreaterThan(20);
  });

  it('lights the real airports with a few thousand lights at most', () => {
    for (const icao of ['LSZH', 'LSGG', 'LSZB']) {
      const a = findAirport(icao)!;
      const n = a.runways.reduce(
        (s, r) => s + runwayLights(r, { centreSpacing: 15, touchdownZone: true }).length,
        0,
      );
      expect(n, icao).toBeGreaterThan(50);
      expect(n, icao).toBeLessThan(4000);
    }
  });
});
