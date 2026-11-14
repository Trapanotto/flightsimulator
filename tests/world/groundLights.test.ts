import { describe, expect, it } from 'vitest';
import type { VectorTile } from '@mapbox/vector-tile';
import { vectorTilePointToLonLat } from '../../src/geo';
import { settlementOf } from '../../src/world/terrain/groundBake';
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
/**
 * A settlement field over a tile of `size` texels and a margin (texels), 1 west of tile column
 * `edge`, with cells of `cell` texels; optionally pre-blurred by `sigma` texels (a district).
 */
function halfField(size: number, margin: number, cell: number, edge: number, sigma = 0) {
  const n = Math.ceil((size + 2 * margin) / cell);
  const g = grid(n, n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const px = (x + 0.5) * cell - margin;
      g.data[y * n + x] = sigma > 0 ? 0.5 * erfc((px - edge) / (sigma * Math.SQRT2)) : +(px < edge);
    }
  return { g, margin, cell };
}
/** Complementary error function (Abramowitz and Stegun 7.1.26). */
function erfc(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const e = y * Math.exp(-x * x);
  return x >= 0 ? e : 2 - e;
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

  it('compensates the missing minor roads of coarse tiles, partly as scattered points', () => {
    const size = 32;
    const base = { size, metresPerPixel: 100, roads: [], points: [], settlement: everywhere() };
    const without = bakeLights(base);
    const withMissing = bakeLights({ ...base, missingMinor: 1 });
    const n = size * size;
    const dGlow = (sum(withMissing.glow) - sum(without.glow)) / n;
    const dLamps = (sum(withMissing.lamps) - sum(without.lamps)) / n;
    // The energy of the missing lamps is all there, on average...
    expect((dGlow + dLamps) / LAMP.minorRoadsGlow).toBeGreaterThan(0.9);
    expect((dGlow + dLamps) / LAMP.minorRoadsGlow).toBeLessThan(1.1);
    expect(dLamps / (dGlow + dLamps)).toBeCloseTo(LAMP.minorSparkle, 1);
    // ...but not as an even patch: single texels shine much brighter than others.
    const pts = Array.from(withMissing.lamps);
    expect(Math.max(...pts)).toBeGreaterThan(4 * Math.min(...pts) + dLamps);
  });

  it('fades a town out across the edge of its settlement polygon', () => {
    // 2 m texels, settled land west of x = 128 (256 m into the tile).
    const size = 256;
    const mpp = 2;
    const settlement = halfField(size, 80, 2, 128);
    const glowOnly = bakeLights({ size, metresPerPixel: mpp, roads: [], points: [], settlement });
    const row = (a: Float32Array, x: number) => a[128 * size + x]!;
    // Even glow of the built-up area: full well inside, half at the line, gone well outside,
    // over a width of a street or two rather than a single texel.
    expect(row(glowOnly.glow, 20)).toBeCloseTo(LAMP.areaGlow, 5);
    expect(row(glowOnly.glow, 128) / LAMP.areaGlow).toBeGreaterThan(0.3);
    expect(row(glowOnly.glow, 128) / LAMP.areaGlow).toBeLessThan(0.7);
    expect(row(glowOnly.glow, 220)).toBeLessThan(LAMP.areaGlow * 0.02);
    expect(row(glowOnly.glow, 100)).toBeGreaterThan(row(glowOnly.glow, 115));
    expect(row(glowOnly.glow, 115)).toBeGreaterThan(row(glowOnly.glow, 141));
    expect(row(glowOnly.glow, 141)).toBeGreaterThan(row(glowOnly.glow, 156));
    // Street lamps along roads crossing the edge thin out instead of stopping at one line.
    const roads = Array.from({ length: 40 }, (_, k) => ({
      cls: 'minor',
      ramp: false,
      tunnel: false,
      points: [0, 3 + k * 6.3, 256, 3 + k * 6.3],
    }));
    const r = bakeLights({ size, metresPerPixel: mpp, roads, points: [], settlement });
    const inside = colSum(r.lamps, size, 0, 64);
    const fringeIn = colSum(r.lamps, size, 96, 128);
    const fringeOut = colSum(r.lamps, size, 128, 160);
    // Per metre of road: thinner just outside the line than deep inside.
    expect(fringeOut).toBeLessThan(inside * 0.5 * 0.8);
    expect(fringeOut).toBeGreaterThan(0);
    expect(fringeOut).toBeLessThan(fringeIn);
    expect(colSum(r.lamps, size, 200, 256)).toBe(0);
  });

  it('mirrors a lit shore in the water next to it, fading with distance', () => {
    // A town on the west half, a lake on the east half (1 m texels).
    const size = 256;
    const settlement = halfField(size, 160, 2, 128);
    const roads = Array.from({ length: 8 }, (_, k) => ({
      cls: 'minor',
      ramp: false,
      tunnel: false,
      points: [0, 16 + k * 32, 124, 16 + k * 32],
    }));
    const dark = (x: number) => (x > 128 ? 1 : 0);
    const district = halfField(size, 1100, 16, 128, 320);
    const r = bakeLights({
      size,
      metresPerPixel: 1,
      roads,
      points: [],
      settlement,
      dark,
      district,
    });
    const refl = r.reflection!;
    const at = (x: number) => refl[128 * size + x]!;
    // Nothing on land, plenty on the water by the shore, less further out.
    expect(colSum(refl, size, 0, 128)).toBe(0);
    expect(at(140)).toBeGreaterThan(at(200));
    expect(at(200)).toBeGreaterThan(at(250));
    expect(at(250)).toBeGreaterThan(0);
    // The water stays dark itself: the light is only in the reflection.
    expect(colSum(r.glow, size, 129, 256)).toBe(0);
    // The glow channel carries it on the water.
    const out = new Uint8Array(size * size * 2);
    const [, sG] = encodeLights(r, out, 2, 0);
    const decoded = (out[(128 * size + 200) * 2 + 1]! / 255) ** 2 * sG;
    expect(decoded / at(200)).toBeCloseTo(1, 1);
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

describe('settled land', () => {
  it('finds every part of a multipolygon, not only the first ring', () => {
    // One residential feature in a vector tile: a small part in its north-west corner and a
    // large one in the middle, where the terrain tile lies.
    const tile = { z: 11, x: 1072, y: 717 };
    const square = (x0: number, y0: number, x1: number, y1: number) => [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
    const feature = {
      type: 3,
      properties: { class: 'residential' },
      loadGeometry: () => [square(10, 10, 200, 200), square(1500, 1500, 2600, 2600)],
    };
    const vt = {
      layers: { landuse: { length: 1, extent: 4096, feature: () => feature } },
    } as unknown as VectorTile;
    const a = vectorTilePointToLonLat(tile, 4096, 1900, 1900, { lon: 0, lat: 0 });
    const c = vectorTilePointToLonLat(tile, 4096, 2200, 2200, { lon: 0, lat: 0 });
    const b = { west: a.lon, east: c.lon, north: a.lat, south: c.lat };
    const f = settlementOf([{ tile, vt }], b, b, 64, 0, 16)!;
    expect(f).toBeDefined();
    expect(sum(f.g.data)).toBe(16 * 16);
  });
});
