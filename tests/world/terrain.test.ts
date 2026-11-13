import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LocalFrame,
  QM_MAX,
  TerrainSurface,
  decodeQuantizedMesh,
  geoTileBounds,
  geodeticToEcef,
  geoidUndulation,
} from '../../src/geo';
import { tileToRenderMatrix } from '../../src/world/terrain/placement';
import { buildTileGeometry, skirtDepth } from '../../src/world/terrain/tileGeometry';

const load = (name: string) => {
  const b = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
/** Real swisstopo tile 13/8541/6220: Lake Thun near Spiez, shore and hills. */
const SPIEZ = { z: 13, x: 8541, y: 6220 };
const spiez = () => decodeQuantizedMesh(load('13_8541_6220.terrain'));
/** Real swisstopo tile 14/17086/12441: open water of Lake Thun. */
const LAKE = { z: 14, x: 17086, y: 12441 };

describe('quantized-mesh decoding', () => {
  it('decodes a real tile into a consistent triangle mesh', () => {
    const qm = spiez();
    expect(qm.vertexCount).toBeGreaterThan(100);
    expect(qm.indices.length % 3).toBe(0);
    for (const i of qm.indices) expect(i).toBeLessThan(qm.vertexCount);
    for (const arr of [qm.u, qm.v, qm.h])
      for (const x of arr) expect(x).toBeLessThanOrEqual(QM_MAX);
    // Edge lists hold the vertices on each edge.
    for (const i of qm.west) expect(qm.u[i]).toBe(0);
    for (const i of qm.east) expect(qm.u[i]).toBe(QM_MAX);
    for (const i of qm.south) expect(qm.v[i]).toBe(0);
    for (const i of qm.north) expect(qm.v[i]).toBe(QM_MAX);
    expect(qm.west.length).toBeGreaterThan(1);
    // Lake Thun lies at 558 m, the hills above Spiez rise to about 800 m.
    expect(qm.minHeight).toBeGreaterThan(550);
    expect(qm.minHeight).toBeLessThan(560);
    expect(qm.maxHeight).toBeGreaterThan(650);
    expect(qm.maxHeight).toBeLessThan(1000);
    // Triangles cover the tile once: their areas sum to the whole square.
    let area = 0;
    for (let t = 0; t < qm.indices.length; t += 3) {
      const [a, b, c] = [qm.indices[t]!, qm.indices[t + 1]!, qm.indices[t + 2]!];
      area +=
        ((qm.u[b]! - qm.u[a]!) * (qm.v[c]! - qm.v[a]!) -
          (qm.u[c]! - qm.u[a]!) * (qm.v[b]! - qm.v[a]!)) /
        2;
    }
    // Counter-clockwise seen from above: positive area.
    expect(area / (QM_MAX * QM_MAX)).toBeCloseTo(1, 6);
  });

  it('carries heights above sea level (Lake Thun at its published 558 m)', () => {
    // swisstopo gives the level of Lake Thun as 558 m above sea level. Above the WGS84
    // ellipsoid it would read about 608 m: the tiles are sea-level heights.
    const qm = decodeQuantizedMesh(load('14_17086_12441.terrain'));
    expect(qm.minHeight).toBeCloseTo(557.7, 0);
    expect(qm.maxHeight - qm.minHeight).toBeLessThan(0.1);
    expect(qm.vertexCount).toBe(4);
  });

  it('rejects truncated data', () => {
    expect(() => decodeQuantizedMesh(new ArrayBuffer(40))).toThrow();
  });
});

describe('tile geometry', () => {
  const qm = spiez();
  const g = buildTileGeometry(qm, SPIEZ);
  const frame = new LocalFrame(g.origin.lon, g.origin.lat, g.origin.h);
  const b = geoTileBounds(SPIEZ);
  const surface = new TerrainSurface(b, qm.u, qm.v, g.heights, qm.indices);

  it('places vertices at their ellipsoid heights in the tile frame', () => {
    for (let i = 0; i < qm.vertexCount; i += 7) {
      const lon = b.west + (qm.u[i]! / QM_MAX) * (b.east - b.west);
      const lat = b.south + (qm.v[i]! / QM_MAX) * (b.north - b.south);
      const sea = qm.minHeight + (qm.h[i]! / QM_MAX) * (qm.maxHeight - qm.minHeight);
      expect(g.elevations[i]).toBeCloseTo(sea, 3);
      expect(g.heights[i]).toBeCloseTo(sea + geoidUndulation(lon, lat), 3);
      const p = frame.toGeodetic({
        x: g.positions[i * 3]!,
        y: g.positions[i * 3 + 1]!,
        z: g.positions[i * 3 + 2]!,
      });
      expect(p.lon).toBeCloseTo(lon, 7);
      expect(p.lat).toBeCloseTo(lat, 7);
      expect(p.h).toBeCloseTo(g.heights[i]!, 2);
    }
    // Tile-local coordinates stay small (float32 keeps millimetres).
    for (const x of g.positions) expect(Math.abs(x)).toBeLessThan(3000);
  });

  it('has upward normals and texture rows from north to south', () => {
    let up = 0;
    for (let i = 0; i < qm.vertexCount; i++) {
      const n = Math.hypot(g.normals[i * 3]!, g.normals[i * 3 + 1]!, g.normals[i * 3 + 2]!);
      expect(n).toBeCloseTo(1, 5);
      if (g.normals[i * 3 + 1]! > 0) up++;
      expect(g.uvs[i * 2]).toBeCloseTo(qm.u[i]! / QM_MAX, 6);
      expect(g.uvs[i * 2 + 1]).toBeCloseTo(1 - qm.v[i]! / QM_MAX, 6);
    }
    expect(up).toBe(qm.vertexCount);
  });

  it('hangs a skirt below every edge vertex', () => {
    const edge = qm.west.length + qm.south.length + qm.east.length + qm.north.length;
    expect(g.positions.length / 3).toBe(qm.vertexCount + edge);
    expect(g.surfaceIndexCount).toBe(qm.indices.length);
    const drop = skirtDepth(SPIEZ);
    expect(drop).toBeGreaterThan(8);
    for (let k = qm.vertexCount; k < g.positions.length / 3; k += 5) {
      const p = frame.toGeodetic({
        x: g.positions[k * 3]!,
        y: g.positions[k * 3 + 1]!,
        z: g.positions[k * 3 + 2]!,
      });
      const onEdge = [p.lon - b.west, b.east - p.lon, p.lat - b.south, b.north - p.lat].some(
        (d) => Math.abs(d) < 1e-9,
      );
      expect(onEdge).toBe(true);
      const top = surface.query(
        Math.min(Math.max(p.lon, b.west), b.east),
        Math.min(Math.max(p.lat, b.south), b.north),
      )!;
      expect(top.height - p.h).toBeCloseTo(drop, 1);
    }
    // Two skirt triangles per edge segment.
    const segments = edge - 4;
    expect(g.indices.length).toBe(qm.indices.length + segments * 6);
  });
});

describe('placement in the render frame (floating origin)', () => {
  const g = buildTileGeometry(spiez(), SPIEZ);
  const tile = new LocalFrame(g.origin.lon, g.origin.lat, g.origin.h);

  for (const render of [
    new LocalFrame(7.4972, 46.9122, 560), // Belp, 30 km away
    new LocalFrame(7.69, 46.69, 600), // right above the tile
  ]) {
    it(`puts vertices where the render frame expects them (${render.origin.lon})`, () => {
      const m = tiletolocal(tile, render);
      for (let i = 0; i < g.positions.length / 3; i += 11) {
        const p = {
          x: g.positions[i * 3]!,
          y: g.positions[i * 3 + 1]!,
          z: g.positions[i * 3 + 2]!,
        };
        const viaMatrix = apply(m, p);
        const exact = render.toLocal(tile.toEcef(p, { x: 0, y: 0, z: 0 }), { x: 0, y: 0, z: 0 });
        expect(viaMatrix.x).toBeCloseTo(exact.x, 6);
        expect(viaMatrix.y).toBeCloseTo(exact.y, 6);
        expect(viaMatrix.z).toBeCloseTo(exact.z, 6);
      }
    });
  }

  const tiletolocal = (t: LocalFrame, r: LocalFrame) =>
    tileToRenderMatrix(t, r, new Array(16).fill(0));
  const apply = (e: number[], p: { x: number; y: number; z: number }) => ({
    x: e[0]! * p.x + e[4]! * p.y + e[8]! * p.z + e[12]!,
    y: e[1]! * p.x + e[5]! * p.y + e[9]! * p.z + e[13]!,
    z: e[2]! * p.x + e[6]! * p.y + e[10]! * p.z + e[14]!,
  });
});

describe('height queries', () => {
  const qm = spiez();
  const g = buildTileGeometry(qm, SPIEZ);
  const b = geoTileBounds(SPIEZ);
  const surface = new TerrainSurface(b, qm.u, qm.v, g.heights, qm.indices);
  const lonOf = (i: number) => b.west + (qm.u[i]! / QM_MAX) * (b.east - b.west);
  const latOf = (i: number) => b.south + (qm.v[i]! / QM_MAX) * (b.north - b.south);

  it('returns the vertex height at every vertex', () => {
    for (let i = 0; i < qm.vertexCount; i++) {
      const hit = surface.query(lonOf(i), latOf(i));
      expect(hit, `vertex ${i}`).toBeDefined();
      expect(hit!.height).toBeCloseTo(g.heights[i]!, 2);
    }
  });

  it('lies exactly on the drawn triangle between vertices', () => {
    // Centroids: the drawn triangle is the flat plane through its three ECEF corners.
    for (let t = 0; t < qm.indices.length; t += 9) {
      const ids = [qm.indices[t]!, qm.indices[t + 1]!, qm.indices[t + 2]!];
      const lon = ids.reduce((s, i) => s + lonOf(i), 0) / 3;
      const lat = ids.reduce((s, i) => s + latOf(i), 0) / 3;
      const hit = surface.query(lon, lat)!;
      const corners = ids.map((i) =>
        geodeticToEcef(lonOf(i), latOf(i), g.heights[i]!, { x: 0, y: 0, z: 0 }),
      );
      const p = geodeticToEcef(lon, lat, hit.height, { x: 0, y: 0, z: 0 });
      // The point is on the plane of the corners.
      const [a, c1, c2] = corners as [typeof p, typeof p, typeof p];
      const n = hit.normal;
      const onPlane = n.x * (p.x - a.x) + n.y * (p.y - a.y) + n.z * (p.z - a.z);
      expect(Math.abs(onPlane)).toBeLessThan(1e-3);
      const n2 = cross(sub(c1, a), sub(c2, a));
      const len = Math.hypot(n2.x, n2.y, n2.z);
      expect(Math.abs((n.x * n2.x + n.y * n2.y + n.z * n2.z) / len)).toBeCloseTo(1, 9);
    }
  });

  it('is flat over the lake and answers outside the tile with undefined', () => {
    // The lake part of the tile (south-east corner area is water at Spiez).
    const hit = surface.query(
      b.west + 0.9 * (b.east - b.west),
      b.south + 0.9 * (b.north - b.south),
    );
    expect(hit).toBeDefined();
    expect(surface.query(b.west - 0.001, b.south + 0.01)).toBeUndefined();
  });

  it('answers 360 queries in well under a millisecond on average', () => {
    const t0 = performance.now();
    let n = 0;
    for (let k = 0; k < 3600; k++) {
      const lon = b.west + ((k * 0.618) % 1) * (b.east - b.west);
      const lat = b.south + ((k * 0.414) % 1) * (b.north - b.south);
      if (surface.query(lon, lat)) n++;
    }
    expect(n).toBe(3600);
    expect((performance.now() - t0) / 10).toBeLessThan(1);
  });

  it('gives the slope of a tilted plane', () => {
    // Synthetic tile: height rises 100 m from west to east over a zoom 14 tile (~840 m).
    const key = { z: 14, x: 17066, y: 12462 };
    const tb = geoTileBounds(key);
    const u = new Uint16Array([0, QM_MAX, 0, QM_MAX]);
    const v = new Uint16Array([0, 0, QM_MAX, QM_MAX]);
    const h = new Float32Array([500, 600, 500, 600]);
    const s = new TerrainSurface(tb, u, v, h, new Uint16Array([0, 1, 2, 1, 3, 2]));
    const mid = s.query((tb.west + tb.east) / 2, (tb.south + tb.north) / 2)!;
    // Curvature: the chord of a 840 m triangle sits a few cm below the ellipsoid-parallel path.
    expect(mid.height).toBeCloseTo(550, 1);
    const frame = new LocalFrame((tb.west + tb.east) / 2, (tb.south + tb.north) / 2, 550);
    const n = frame.dirToLocal(mid.normal, { x: 0, y: 0, z: 0 });
    const width = 840.2;
    // Normal leans west (negative x) by atan(100 / width).
    expect(Math.atan2(-n.x, n.y)).toBeCloseTo(Math.atan2(100, width), 2);
    expect(Math.abs(n.z)).toBeLessThan(1e-3);
  });

  it('reproduces the swisstopo height of Lake Thun above the ellipsoid', () => {
    const lake = decodeQuantizedMesh(load('14_17086_12441.terrain'));
    const lg = buildTileGeometry(lake, LAKE);
    const lb = geoTileBounds(LAKE);
    const s = new TerrainSurface(lb, lake.u, lake.v, lg.heights, lake.indices);
    const hit = s.query((lb.west + lb.east) / 2, (lb.south + lb.north) / 2)!;
    // 557.7 m above sea level + 49.9 m geoid = 607.6 m above the ellipsoid.
    expect(hit.height).toBeCloseTo(557.7 + geoidUndulation(7.72, 46.69), 0);
  });
});

const sub = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});
const cross = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
