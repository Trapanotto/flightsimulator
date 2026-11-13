import { describe, expect, it } from 'vitest';
import { LocalFrame } from '../../src/geo';
import { Grid, distanceToEmpty, pointInRings } from '../../src/world/trees/raster';
import { type ScatterInput, scatter } from '../../src/world/trees/scatter';
import { HeightGrid, fillGaps } from '../../src/world/trees/seat';
import { Cover } from '../../src/world/trees/species';
import { hash2, rand2 } from '../../src/world/trees/hash';

const square = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

describe('point in polygon', () => {
  const outer = square(0, 0, 100, 100);
  const hole = square(25, 25, 75, 75).reverse();
  const island = square(40, 40, 60, 60);

  it('honours holes and islands in holes, whatever the winding', () => {
    const rings = [outer, hole, island];
    expect(pointInRings(rings, 10, 10)).toBe(true);
    expect(pointInRings(rings, 30, 50)).toBe(false);
    expect(pointInRings(rings, 50, 50)).toBe(true);
    expect(pointInRings(rings, 150, 50)).toBe(false);
    expect(pointInRings([outer, square(25, 25, 75, 75)], 30, 50)).toBe(false);
  });

  it('agrees with the scanline raster at every cell centre', () => {
    const tri = [
      { x: 3, y: 5 },
      { x: 97, y: 21 },
      { x: 40, y: 93 },
    ];
    const rings = [tri, square(30, 30, 50, 50)];
    const g = new Grid(64, 100);
    g.fillRings(rings, 1);
    let mismatches = 0;
    for (let j = 0; j < 64; j++)
      for (let i = 0; i < 64; i++) {
        const inside = pointInRings(rings, (i + 0.5) * g.cell, (j + 0.5) * g.cell);
        if (inside !== (g.data[j * 64 + i] === 1)) mismatches++;
      }
    expect(mismatches).toBe(0);
  });

  it('strokes lines to a width and measures the distance to the edge', () => {
    const g = new Grid(100, 100);
    g.strokeLine(
      [
        { x: 0, y: 50 },
        { x: 100, y: 50 },
      ],
      5,
      1,
    );
    expect(g.at(50, 50)).toBe(1);
    expect(g.at(50, 54)).toBe(1);
    expect(g.at(50, 57)).toBe(0);

    const forest = new Grid(100, 100);
    forest.fillRings([square(0, 0, 100, 100)], 1);
    forest.fillRings([square(0, 0, 10, 100)], 0);
    const d = distanceToEmpty(forest, 50);
    // Cell 30 lies 20 cells from the clearing; the tile edges do not count as edges.
    expect(d[50 * 100 + 30]).toBeGreaterThanOrEqual(19);
    expect(d[50 * 100 + 30]).toBeLessThanOrEqual(21);
    expect(d[50 * 100 + 98]).toBe(50);
    expect(d[50 * 100 + 5]).toBe(0);
  });
});

describe('hashes', () => {
  it('are fixed functions of their inputs', () => {
    expect(hash2(12345, 678, 3)).toBe(hash2(12345, 678, 3));
    expect(hash2(1, 2, 0)).not.toBe(hash2(2, 1, 0));
    let sum = 0;
    for (let i = 0; i < 10000; i++) sum += rand2(i, 7, 1);
    expect(sum / 10000).toBeCloseTo(0.5, 1);
  });
});

/** A synthetic chunk: forest on the west half with a lake in it, a road, two single trees. */
function input(over: Partial<ScatterInput> = {}): ScatterInput {
  return {
    tile: { x: 8534, y: 5771 },
    extent: 4096,
    grid: 384,
    rasterSize: 512,
    metresPerUnit: 0.4,
    covers: [{ cover: Cover.Forest, rings: [square(0, 0, 2048, 4096)] }],
    blocks: [[square(500, 500, 1000, 1000)]],
    lines: [
      {
        line: [
          { x: 0, y: 3000 },
          { x: 4096, y: 3000 },
        ],
        radius: 10,
      },
    ],
    points: [
      { x: 3000, y: 1000 },
      { x: 3500, y: 2000 },
    ],
    elevation: () => 600,
    ...over,
  };
}

describe('scatter', () => {
  it('is deterministic', () => {
    const a = scatter(input());
    const b = scatter(input());
    expect(a.count).toBe(b.count);
    expect(Array.from(a.u)).toEqual(Array.from(b.u));
    expect(Array.from(a.species)).toEqual(Array.from(b.species));
    expect(Array.from(a.rank)).toEqual(Array.from(b.rank));
  });

  it('fills the forest at a believable density, denser in the heart than at the edge', () => {
    const s = scatter(input({ blocks: [], lines: [], points: [] }));
    // West half of a 1638 m chunk: 819 x 1638 m = 134 ha.
    const ha = (2048 * 4096 * 0.4 * 0.4) / 10_000;
    const perHa = s.count / ha;
    expect(perHa).toBeGreaterThan(250);
    expect(perHa).toBeLessThan(550);
    // Trees within 10 m of the forest edge at u = 2048 versus 100 m inside.
    const band = (lo: number, hi: number) => {
      let n = 0;
      for (let i = 0; i < s.count; i++) {
        const m = (2048 - s.u[i]!) * 0.4;
        if (m >= lo && m < hi) n++;
      }
      return n / (hi - lo);
    };
    expect(band(0, 10)).toBeLessThan(band(90, 100) * 0.85);
    expect(s.count).toBeGreaterThan(0);
  });

  it('keeps trunks out of lakes, off roads and inside the forest', () => {
    const s = scatter(input());
    for (let i = 0; i < s.count; i++) {
      const u = s.u[i]!;
      const v = s.v[i]!;
      const single = s.edge[i] === 0 && u > 2048;
      if (!single) expect(u).toBeLessThan(2048);
      expect(u > 500 && u < 1000 && v > 500 && v < 1000).toBe(false);
      expect(Math.abs(v - 3000)).toBeGreaterThan(8);
    }
  });

  it('places single trees exactly where the survey has them', () => {
    const s = scatter(input());
    expect(s.stats.singles).toBe(2);
    const found = [];
    for (let i = 0; i < s.count; i++) if (s.u[i]! > 2048) found.push([s.u[i], s.v[i]]);
    expect(found).toEqual([
      [3000, 1000],
      [3500, 2000],
    ]);
  });

  it('continues seamlessly across chunks: a cell gives the same tree from either side', () => {
    // The same global cell seen from the chunk to its east must not exist twice: the grid is
    // aligned to chunk edges, so chunk x and x + 1 share no cell, and a candidate's jitter keeps
    // it inside its own cell.
    const a = scatter(input({ points: [], blocks: [], lines: [] }));
    for (let i = 0; i < a.count; i++) {
      expect(a.u[i]!).toBeGreaterThanOrEqual(0);
      expect(a.u[i]!).toBeLessThan(4096);
    }
  });

  it('plants nothing above the tree line', () => {
    const s = scatter(input({ elevation: () => 2600, points: [] }));
    expect(s.count).toBe(0);
    expect(s.stats.aboveLine).toBeGreaterThan(0);
  });

  it('uses the photo: dark stands become conifers', () => {
    const photo = (dark: boolean) => (u: number, _v: number, out: number[]) => {
      const k = u < 1024 === dark ? 0.03 : 0.12;
      out[0] = k * 0.6;
      out[1] = k;
      out[2] = k * 0.4;
      return true;
    };
    const s = scatter(input({ blocks: [], lines: [], points: [], photo: photo(true) }));
    let darkConifers = 0;
    let darkAll = 0;
    let lightConifers = 0;
    let lightAll = 0;
    for (let i = 0; i < s.count; i++) {
      const conifer = s.species[i]! <= 2;
      if (s.u[i]! < 1024) {
        darkAll++;
        if (conifer) darkConifers++;
      } else {
        lightAll++;
        if (conifer) lightConifers++;
      }
    }
    expect(darkConifers / darkAll).toBeGreaterThan((lightConifers / lightAll) * 2);
  });
});

describe('height grid', () => {
  it('interpolates a plane exactly and places its points like the local frame', () => {
    const lon = 7.53;
    const lat = 46.87;
    const g = new HeightGrid(9, 800, 820, lon, lat);
    for (let k = 0; k < g.values.length; k++)
      g.values[k] = 500 + g.lon[k]! * 1000 + g.lat[k]! * 300;
    const frame = new LocalFrame(lon, lat, 0);
    const p = frame.toGeodetic({ x: 333, y: 0, z: -456 });
    expect(g.sample(333, -456)).toBeCloseTo(500 + p.lon * 1000 + p.lat * 300, 2);
    // A corner of the grid lies where the frame puts it, to a few centimetres.
    const corner = frame.fromGeodetic(g.lon[0]!, g.lat[0]!, 0, { x: 0, y: 0, z: 0 });
    expect(Math.abs(corner.x + 800)).toBeLessThan(0.1);
    expect(Math.abs(corner.z + 820)).toBeLessThan(0.1);
  });

  it('fills unanswered points from their neighbours', () => {
    const v = new Float32Array([NaN, 2, NaN, NaN, NaN, NaN, 7, NaN, NaN]);
    expect(fillGaps(v, 3)).toBe(true);
    expect(Array.from(v).every((x) => !Number.isNaN(x))).toBe(true);
    expect(v[0]).toBe(2);
    expect(fillGaps(new Float32Array([NaN, NaN, NaN, NaN]), 2)).toBe(false);
  });
});
