import { describe, expect, it } from 'vitest';
import {
  type GroundClass,
  type RGB,
  numberOps as o,
  seasonColor,
} from '../../src/world/terrain/groundMath';

// Linear albedos as the material maps them from SWISSIMAGE.
const MEADOW: RGB<number> = [0.09, 0.16, 0.04];
const BEECH: RGB<number> = [0.12, 0.2, 0.05];
const SPRUCE: RGB<number> = [0.04, 0.08, 0.04];
const ROOF: RGB<number> = [0.3, 0.12, 0.08];
const SOIL: RGB<number> = [0.25, 0.18, 0.11];

const none: GroundClass<number> = { veg: 0, forest: 0, broadleaf: 0, larch: 0, soil: 0 };
const meadow = { ...none, veg: 1 };
const beech = { ...none, veg: 1, forest: 1, broadleaf: 1 };
const spruce = { ...none, veg: 1, forest: 1 };
const field = { ...none, soil: 1 };
const noise = { crown: 0, plot: 0, patch: 0 };
const summer = { spring: 0, autumn: 0, winter: 0 };
const autumn = { ...summer, autumn: 1 };
const winter = { ...summer, winter: 1 };
const spring = { ...summer, spring: 1 };

const lum = (c: RGB<number>) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
/** Hue as red over green: grass ~0.5, yellow ~1, orange and brown > 1. */
const warmth = (c: RGB<number>) => c[0] / c[1];

describe('season colours', () => {
  it('leaves the summer photo exactly as it is', () => {
    for (const [c, k] of [
      [MEADOW, meadow],
      [BEECH, beech],
      [ROOF, none],
    ] as const)
      expect(seasonColor(o, c, k, summer, { crown: 0.7, plot: 0.4, patch: -0.3 })).toEqual(c);
  });

  it('never touches roofs, roads, rock and water', () => {
    for (const w of [autumn, winter, spring])
      expect(seasonColor(o, ROOF, none, w, noise)).toEqual(ROOF);
  });

  it('turns broadleaf forest yellow to rust in autumn, and leaves spruce green', () => {
    const b = seasonColor(o, BEECH, beech, autumn, noise);
    expect(warmth(b)).toBeGreaterThan(1);
    expect(seasonColor(o, SPRUCE, spruce, autumn, noise)).toEqual(SPRUCE);
    // Tree by tree: crowns differ.
    const y = seasonColor(o, BEECH, beech, autumn, { crown: -1, plot: 0, patch: 0 });
    const r = seasonColor(o, BEECH, beech, autumn, { crown: 1, plot: 0, patch: 0 });
    expect(warmth(r)).toBeGreaterThan(warmth(y));
  });

  it('dulls meadows towards yellow-brown in autumn, more in some patches', () => {
    const a = seasonColor(o, MEADOW, meadow, autumn, { crown: 0, plot: 0, patch: 1 });
    const b = seasonColor(o, MEADOW, meadow, autumn, { crown: 0, plot: 0, patch: -1 });
    expect(warmth(a)).toBeGreaterThan(warmth(MEADOW));
    expect(warmth(a)).toBeGreaterThan(warmth(b));
    // A few plots are ploughed already: earth brown, darker than the meadows around.
    const p = seasonColor(o, MEADOW, meadow, autumn, { crown: 0, plot: 1, patch: -1 });
    expect(warmth(p)).toBeGreaterThan(1.1);
    expect(lum(p)).toBeLessThan(lum(b));
  });

  it('makes winter woods bare grey-brown and fields grey', () => {
    const w = seasonColor(o, BEECH, beech, winter, noise);
    expect(w[0] / w[2]).toBeLessThan(2);
    expect(warmth(w)).toBeGreaterThan(0.95);
    const s = seasonColor(o, SOIL, field, winter, noise);
    const sat = (c: RGB<number>) => (Math.max(...c) - Math.min(...c)) / Math.max(...c);
    expect(sat(s)).toBeLessThan(sat(SOIL));
  });

  it('leaves no summer green on winter meadows: olive to straw, some plots bare earth', () => {
    const sat = (c: RGB<number>) => (Math.max(...c) - Math.min(...c)) / Math.max(...c);
    for (const patch of [-1, -0.3, 0.3, 1])
      for (const plot of [-1, 0, 1]) {
        const w = seasonColor(o, MEADOW, meadow, winter, { crown: 0, plot, patch });
        // Red at least close to green: dull olive at most, never grass green.
        expect(warmth(w)).toBeGreaterThan(0.9);
        expect(sat(w)).toBeLessThan(sat(MEADOW) * 0.75);
        // Dormant grass is not brighter than the summer sward.
        expect(lum(w)).toBeLessThan(lum(MEADOW));
      }
    // Dry patches are yellower than dense ones, ploughed plots browner and darker still.
    const dense = seasonColor(o, MEADOW, meadow, winter, { crown: 0, plot: -1, patch: -1 });
    const dry = seasonColor(o, MEADOW, meadow, winter, { crown: 0, plot: -1, patch: 1 });
    const ploughed = seasonColor(o, MEADOW, meadow, winter, { crown: 0, plot: 1, patch: 0 });
    expect(warmth(dry)).toBeGreaterThan(warmth(dense));
    expect(warmth(ploughed)).toBeGreaterThan(1.15);
    expect(lum(ploughed)).toBeLessThan(lum(dense));
    // Bare fields of the summer photo are earth brown and darker than the ripe crop.
    const s = seasonColor(o, SOIL, field, winter, noise);
    expect(warmth(s)).toBeGreaterThan(1.2);
    expect(lum(s)).toBeLessThan(lum(SOIL) * 0.8);
  });

  it('makes spring meadows fresh and light green', () => {
    const s = seasonColor(o, MEADOW, meadow, spring, noise);
    expect(lum(s)).toBeGreaterThan(lum(MEADOW));
    expect(s[1]).toBeGreaterThan(s[0] * 1.5);
  });
});
