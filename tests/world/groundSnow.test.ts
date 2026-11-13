import { describe, expect, it } from 'vitest';
import {
  PHOTO_SNOW_LINE,
  SNOW_BAND,
  type SnowSite,
  numberOps as o,
  seasonSnowAmount,
  snowCover,
} from '../../src/world/terrain/groundMath';

const site = (s: Partial<SnowSite<number>>): SnowSite<number> => ({
  elevation: 2000,
  snowLine: 1500,
  up: 1,
  north: 0,
  hollow: 0,
  noiseLine: 0,
  noisePatch: 0,
  ...s,
});
const cover = (s: Partial<SnowSite<number>>) => snowCover(o, site(s)).cover;

describe('snow cover', () => {
  it('covers gentle ground well above the snow line and leaves it bare well below', () => {
    expect(cover({ elevation: 2200 })).toBe(1);
    expect(cover({ elevation: 900 })).toBe(0);
  });

  it('rises through a band of a few hundred metres, not along a contour line', () => {
    const at = (e: number) => cover({ elevation: e });
    // Monotonic in height...
    let last = -1;
    for (let e = 1000; e <= 2200; e += 25) {
      expect(at(e)).toBeGreaterThanOrEqual(last);
      last = at(e);
    }
    // ...and the step from first patches to full cover takes about a band's width.
    const first = [...Array(200).keys()].map((i) => 1000 + i * 10).find((e) => at(e) > 0.02)!;
    const full = [...Array(200).keys()].map((i) => 1000 + i * 10).find((e) => at(e) > 0.98)!;
    expect(full - first).toBeGreaterThan(SNOW_BAND * 0.5);
    expect(full - first).toBeLessThan(SNOW_BAND * 2);
  });

  it('breaks into patches inside the band: the patch noise decides there, not far above', () => {
    const band = { elevation: 1500 };
    expect(cover({ ...band, noisePatch: 1 })).toBeGreaterThan(0.9);
    expect(cover({ ...band, noisePatch: -1 })).toBeLessThan(0.1);
    expect(cover({ elevation: 2300, noisePatch: -1 })).toBe(1);
  });

  it('frays the line with large-scale noise by hundreds of metres', () => {
    const e = 1550;
    expect(cover({ elevation: e, noiseLine: 1 })).toBeLessThan(0.05);
    expect(cover({ elevation: e, noiseLine: -1 })).toBeGreaterThan(0.95);
  });

  it('slides off steep rock: none on cliffs, plenty on gentle slopes', () => {
    const cos = (deg: number) => Math.cos((deg * Math.PI) / 180);
    expect(cover({ elevation: 2600, up: cos(70) })).toBeCloseTo(0, 6);
    expect(cover({ elevation: 2600, up: cos(60) })).toBeCloseTo(0, 6);
    expect(cover({ elevation: 2600, up: cos(25) })).toBe(1);
    expect(cover({ elevation: 2600, up: cos(45) })).toBeGreaterThan(0);
  });

  it('lies lower on north faces and in hollows than on south faces', () => {
    const e = 1450;
    const north = cover({ elevation: e, north: 0.6 });
    const south = cover({ elevation: e, north: -0.6 });
    const hollow = cover({ elevation: e, hollow: 1 });
    const open = cover({ elevation: e });
    expect(north).toBeGreaterThan(open);
    expect(open).toBeGreaterThan(south);
    expect(hollow).toBeGreaterThan(open);
    // ...and deeper there.
    const d = (s: Partial<SnowSite<number>>) => snowCover(o, site(s)).depth;
    expect(d({ elevation: 1900, hollow: 1 })).toBeGreaterThan(d({ elevation: 1900 }));
  });

  it('adds nothing to the photos in summer and everything below their snow line', () => {
    expect(seasonSnowAmount(PHOTO_SNOW_LINE)).toBe(0);
    expect(seasonSnowAmount(2900)).toBe(0);
    expect(seasonSnowAmount(2300)).toBe(1);
    expect(seasonSnowAmount(900)).toBe(1);
  });
});
