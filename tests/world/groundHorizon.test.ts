import { describe, expect, it } from 'vitest';
import { WORLD_QUALITY } from '../../src/world/World';
import { GROUND_SETTINGS, groundBytes, mippedBytes } from '../../src/world/terrain/groundSettings';
import {
  HORIZON_STEPS_PER_DEG,
  type HeightField,
  directionWeights,
  horizonMap,
  rasterizeMesh,
  skyView,
} from '../../src/world/terrain/horizon';
import { decodeRowDirection, rowDirections } from '../../src/world/terrain/rows';

const M_PER_DEG = 111_132;
const bounds = { west: 7.0, east: 7.02, south: 46.0, north: 46.02 };

/** A field over `b` from a height function of (east, north) metres from the south-west corner. */
function field(b: typeof bounds, n: number, h: (e: number, nm: number) => number): HeightField {
  const mLon = M_PER_DEG * Math.cos(((b.north + b.south) / 2) * (Math.PI / 180));
  const data = new Float32Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const e = ((x + 0.5) / n) * (b.east - b.west) * mLon;
      const nm = (1 - (y + 0.5) / n) * (b.north - b.south) * M_PER_DEG;
      data[y * n + x] = h(e, nm);
    }
  return { bounds: b, w: n, h: n, data };
}

/** Horizon angle (degrees) at grid point (i, j) in direction k (0 = N, 2 = E, 4 = S, 6 = W). */
function angle(map: Uint8Array, size: number, i: number, j: number, k: number) {
  return map[(j * size * 2 + (k >> 2) * size + i) * 4 + (k & 3)]! / HORIZON_STEPS_PER_DEG;
}

describe('horizon', () => {
  it('sees a wall to the north from the plain in front of it, and nothing to the south', () => {
    // A 300 m wall along the north edge of a 2.2 km tile.
    const near = field(bounds, 65, (_e, nm) => (nm > 2000 ? 300 : 0));
    const size = 17;
    const map = horizonMap({ bounds, size, near });
    const j = size - 1; // south edge, about 2 km from the wall
    const north = angle(map, size, 8, j, 0);
    expect(north).toBeGreaterThan(5);
    expect(north).toBeLessThan(12);
    expect(angle(map, size, 8, j, 4)).toBe(0);
    // Closer to the wall it rises higher.
    expect(angle(map, size, 8, 4, 0)).toBeGreaterThan(north);
  });

  it('reads mountains beyond the tile from the coarse surroundings', () => {
    const flat = field(bounds, 33, () => 500);
    const wide = { west: 6.9, east: 7.12, south: 45.9, north: 46.12 };
    // A 2000 m ridge 5 km east of the tile.
    const far = field(wide, 64, (e) => (e > 13_500 && e < 15_000 ? 2500 : 500));
    const size = 9;
    const map = horizonMap({ bounds, size, near: flat, far });
    const east = angle(map, size, 4, 4, 2);
    // atan(2000 / ~5000 m) is about 20°.
    expect(east).toBeGreaterThan(14);
    expect(east).toBeLessThan(26);
    expect(angle(map, size, 4, 4, 6)).toBe(0);
    expect(horizonMap({ bounds, size, near: flat })[0]).toBe(0);
  });

  it('measures the sky a point sees', () => {
    expect(skyView([0, 0, 0, 0, 0, 0, 0, 0])).toBe(1);
    expect(skyView([30, 30, 30, 30, 30, 30, 30, 30])).toBeCloseTo(0.75, 6);
  });

  it('shares the light between the two nearest directions', () => {
    const w = directionWeights(Math.PI / 2 + Math.PI / 8);
    expect(w[2]).toBeCloseTo(0.5, 6);
    expect(w[3]).toBeCloseTo(0.5, 6);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(directionWeights(-0.0001)[0]).toBeCloseTo(1, 2);
  });

  it('rasterises a mesh with its vertex heights', () => {
    // Two triangles over the unit square, heights rising to the east.
    const f = rasterizeMesh(
      [0, 10, 10, 0],
      [0, 0, 10, 10],
      [0, 100, 100, 0],
      [0, 1, 2, 0, 2, 3],
      10,
      bounds,
      8,
      8,
    );
    expect(f.data[0]).toBeCloseTo(100 * (0.5 / 8), 3);
    expect(f.data[7]).toBeCloseTo(100 * (7.5 / 8), 3);
    for (const v of f.data) expect(Number.isNaN(v)).toBe(false);
  });
});

describe('field rows', () => {
  it('finds the direction of stripes in a photo', () => {
    const n = 64;
    for (const deg of [0, 30, 90, 135]) {
      const a = (deg * Math.PI) / 180;
      const rgba = new Uint8Array(n * n * 4);
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          // Stripes running along angle a: brightness varies across them, every 4 px.
          const across = -x * Math.sin(a) + y * Math.cos(a);
          const v = 128 + 60 * Math.sin((across / 4) * 2 * Math.PI);
          rgba.set([v, v, v, 255], (y * n + x) * 4);
        }
      const dirs = rowDirections(rgba, n, 32, 4);
      const got = decodeRowDirection(dirs[16 * 32 + 16]!)!;
      const diff = Math.abs(((got - a + Math.PI * 1.5) % Math.PI) - Math.PI / 2);
      expect(diff).toBeLessThan(0.13); // within 7°
    }
  });

  it('finds none in a plain photo', () => {
    const rgba = new Uint8Array(32 * 32 * 4).fill(120);
    expect(rowDirections(rgba, 32, 16, 3).every((b) => b === 0)).toBe(true);
  });
});

describe('ground memory', () => {
  it('counts mipmapped textures', () => {
    expect(mippedBytes(4, 2)).toBe((16 + 4 + 1) * 2);
  });

  it('adds about a fifth to a desktop tile and less than a tenth on phones', () => {
    const tile = (size: number, mask: number) => mippedBytes(size, 4) + mippedBytes(mask, 4);
    const d = WORLD_QUALITY.desktop;
    const m = WORLD_QUALITY.mobile;
    const desktop = groundBytes(d.maskSize, GROUND_SETTINGS.desktop);
    const mobile = groundBytes(m.maskSize, GROUND_SETTINGS.mobile);
    expect(desktop / tile(d.textureSize, d.maskSize)).toBeLessThan(0.25);
    expect(mobile / tile(m.textureSize, m.maskSize)).toBeLessThan(0.12);
    expect(mobile).toBeLessThan(desktop / 3);
  });
});
