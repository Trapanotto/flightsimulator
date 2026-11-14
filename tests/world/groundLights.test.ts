import { describe, expect, it } from 'vitest';
import {
  LAMP,
  alongLine,
  bakeLights,
  encodeLights,
  lampSpec,
} from '../../src/world/terrain/lights';
import { grid } from '../../src/world/terrain/raster';
import {
  ROAD_MAX_HALF,
  ROAD_RANGE,
  bakeRoads,
  decodeRoadInfo,
  encodeRoadInfo,
  roadShape,
} from '../../src/world/terrain/roads';

const sum = (a: ArrayLike<number>) => Array.from(a).reduce((s, v) => s + v, 0);

/** A settlement field covering the left half of a tile of `size` texels (and its margin). */
function leftHalf(size: number) {
  const g = grid(6, 1);
  g.data.set([1, 1, 1, 0, 0, 0]);
  return { g, margin: size, cell: size / 2 };
}
const everywhere = () => {
  const g = grid(1, 1);
  g.data[0] = 1;
  return { g, margin: 0, cell: 1e9 };
};

describe('night lights', () => {
  it('lights the roads of towns and villages, not the motorway between junctions', () => {
    expect(lampSpec('minor', false, false, true)).not.toBeNull();
    expect(lampSpec('primary', false, false, true)).not.toBeNull();
    expect(lampSpec('primary', false, false, false)).toBeNull();
    expect(lampSpec('minor', false, false, false)).toBeNull();
    expect(lampSpec('motorway', false, false, true)).toBeNull();
    expect(lampSpec('motorway', true, false, false)).not.toBeNull();
    expect(lampSpec('minor', false, true, true)).toBeNull();
    expect(lampSpec('track', false, false, true)).toBeNull();
    expect(lampSpec('path', false, false, true)).toBeNull();
  });

  it('spaces lamps evenly along a line, across its bends', () => {
    const at: number[] = [];
    alongLine([0, 0, 10, 0, 10, 25], 10, (x, y) => at.push(x, y));
    expect(at).toEqual([5, 0, 10, 5, 10, 15, 10, 25]);
  });

  it('puts lamps on the road inside the settlement only', () => {
    // A minor road across a 256-texel tile at 1 m per texel, half of it in a village.
    const size = 256;
    const r = bakeLights({
      size,
      metresPerPixel: 1,
      roads: [{ cls: 'minor', ramp: false, tunnel: false, points: [0, 128, 256, 128] }],
      points: [],
      settlement: leftHalf(size),
    });
    const left = colSum(r.lamps, size, 0, 120);
    const right = colSum(r.lamps, size, 136, 256);
    expect(left).toBeGreaterThan(0);
    expect(right).toBe(0);
    // About 128 m / 38 m spacing = 3 lamps, each its full energy over the texels.
    expect((left * 1) / LAMP.core).toBeCloseTo(3, 0);
    // The light sits on the road: nothing more than a few texels off it.
    expect(rowSum(r.lamps, size, 0, 120)).toBe(0);
    // The ground around the lamps glows; away from the village it stays dark.
    expect(r.glow[128 * size + 40]).toBeGreaterThan(0);
    expect(r.glow[128 * size + 250]).toBeLessThan(r.glow[128 * size + 40]! * 0.01);
  });

  it('keeps the energy of a lamp at every level of detail (no popping)', () => {
    const energy = (mpp: number, size: number) => {
      // One lamp in the middle of a 60 m piece of road, in a tile of `metres`.
      const c = size / 2;
      const r = bakeLights({
        size,
        metresPerPixel: mpp,
        roads: [
          {
            cls: 'service',
            ramp: false,
            tunnel: false,
            points: [c - 25 / mpp, c, c + 25 / mpp, c],
          },
        ],
        points: [],
        settlement: everywhere(),
      });
      return { lamps: sum(r.lamps) * mpp * mpp, glow: sum(r.glow) * mpp * mpp };
    };
    const fine = energy(1, 256);
    const coarse = energy(8, 64);
    expect(fine.lamps).toBeCloseTo(LAMP.core * 0.6, 0);
    expect(coarse.lamps / fine.lamps).toBeCloseTo(1, 1);
    // The glow includes the even glow of the settled tile area, which grows with the tile:
    // compare the lamp's own pool by removing it.
    const own = (e: { glow: number }, metres: number) => e.glow - metres * metres * LAMP.areaGlow;
    expect(own(coarse, 512) / own(fine, 256)).toBeGreaterThan(0.9);
    expect(own(coarse, 512) / own(fine, 256)).toBeLessThan(1.1);
  });

  it('lights farms and huts outside villages as single points, never water', () => {
    const size = 32;
    const r = bakeLights({
      size,
      metresPerPixel: 4,
      roads: [],
      points: [{ x: 10.5, y: 20.5, weight: 0.5 }],
      dark: (x) => (x > 16 ? 1 : 0),
    });
    expect(r.count).toBe(1);
    expect(r.lamps[20 * size + 10]).toBeCloseTo((LAMP.core * 0.5) / 16, 3);
    // The lake on the right half stays black.
    expect(colSum(r.glow, size, 17, 32)).toBe(0);
  });

  it('compensates the missing minor roads of coarse tiles with an even glow', () => {
    const base = { size: 16, metresPerPixel: 100, roads: [], points: [], settlement: everywhere() };
    const without = bakeLights(base);
    const withMissing = bakeLights({ ...base, missingMinor: 1 });
    expect(withMissing.glow[8 * 16 + 8]! - without.glow[8 * 16 + 8]!).toBeCloseTo(
      LAMP.minorRoadsGlow,
      4,
    );
  });

  it('codes lamps and glow with square roots against their maxima', () => {
    const lamps = new Float32Array([0, 100, 25]);
    const glow = new Float32Array([0.5, 0, 0.125]);
    const out = new Uint8Array(3 * 4);
    const [sL, sG] = encodeLights({ lamps, glow, count: 1 }, out, 4, 0);
    expect(sL).toBe(100);
    expect(sG).toBe(0.5);
    expect([out[4], out[8], out[1], out[9]]).toEqual([255, 128, 255, 128]);
  });
});

describe('road field', () => {
  it('knows the width and surface of Swiss road classes', () => {
    expect(roadShape('motorway', undefined, false)!.half).toBeGreaterThan(4);
    expect(roadShape('primary', undefined, false)!.marked).toBe(true);
    expect(roadShape('track', undefined, false)!.paved).toBe(false);
    expect(roadShape('minor', 'unpaved', false)!.paved).toBe(false);
    expect(roadShape('minor', undefined, true)).toBeNull();
    expect(roadShape('path', undefined, false)).toBeNull();
  });

  it('round-trips the road info byte', () => {
    for (const [half, paved, marked] of [
      [3.7, true, true],
      [1.5, false, false],
      [ROAD_MAX_HALF, true, false],
    ] as const) {
      const d = decodeRoadInfo(encodeRoadInfo(half, paved, marked))!;
      expect(d.half).toBeCloseTo(half, 1);
      expect(d.paved).toBe(paved);
      expect(d.marked).toBe(marked);
    }
    expect(decodeRoadInfo(0)).toBeNull();
  });

  it('stores the distance to the nearest centre line and that road', () => {
    const size = 64;
    const out = new Uint8Array(size * size * 4);
    // A primary road along row 32 at 0.5 m per texel; a track along column 10.
    bakeRoads(
      size,
      0.5,
      [
        { cls: 'primary', tunnel: false, points: [0, 32, 64, 32] },
        { cls: 'track', tunnel: false, points: [10, 0, 10, 64] },
      ],
      out,
      4,
      2,
    );
    const at = (x: number, y: number) => ({
      d: (out[(y * size + x) * 4 + 2]! / 255) * ROAD_RANGE,
      road: decodeRoadInfo(out[(y * size + x) * 4 + 3]!),
    });
    expect(at(40, 32).d).toBeCloseTo(0.25, 1);
    expect(at(40, 36).d).toBeCloseTo(2.25, 1);
    expect(at(40, 36).road!.paved).toBe(true);
    expect(at(10, 5).road!.paved).toBe(false);
    // Far from any road: nothing.
    expect(at(40, 2).road).toBeNull();
    expect(at(40, 2).d).toBeCloseTo(ROAD_RANGE, 3);
  });
});

function colSum(a: Float32Array, size: number, x0: number, x1: number) {
  let s = 0;
  for (let y = 0; y < size; y++) for (let x = x0; x < x1; x++) s += a[y * size + x]!;
  return s;
}
function rowSum(a: Float32Array, size: number, y0: number, y1: number) {
  let s = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < size; x++) s += a[y * size + x]!;
  return s;
}
