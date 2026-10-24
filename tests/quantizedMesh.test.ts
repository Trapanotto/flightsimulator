import { describe, expect, it } from 'vitest';
import { enuFrame, geodeticToEcef } from '../src/geo/ellipsoid';
import { geoTileBounds } from '../src/geo/tiles';
import { decodeQuantizedMesh, octDecode } from '../src/terrain/quantizedMesh';
import { buildTileMesh } from '../src/terrain/tileMesh';

/** Minimal quantized-mesh encoder, used to produce test tiles without shipping real data. */
function encode(opts: {
  center: [number, number, number];
  minH: number;
  maxH: number;
  u: number[];
  v: number[];
  h: number[];
  tris: number[];
  west: number[];
  south: number[];
  east: number[];
  north: number[];
  oct?: number[];
}): ArrayBuffer {
  const n = opts.u.length;
  let size = 88 + 4 + n * 6;
  size += size % 2;
  size += 4 + opts.tris.length * 2;
  for (const e of [opts.west, opts.south, opts.east, opts.north]) size += 4 + e.length * 2;
  if (opts.oct) size += 5 + n * 2;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  let o = 0;
  const f64 = (x: number) => (dv.setFloat64(o, x, true), (o += 8));
  const f32 = (x: number) => (dv.setFloat32(o, x, true), (o += 4));
  const u32 = (x: number) => (dv.setUint32(o, x, true), (o += 4));
  const u16 = (x: number) => (dv.setUint16(o, x, true), (o += 2));
  opts.center.forEach(f64);
  f32(opts.minH);
  f32(opts.maxH);
  opts.center.forEach(f64);
  f64(5000);
  opts.center.forEach(f64);
  u32(n);
  const zz = (x: number) => ((x << 1) ^ (x >> 31)) >>> 0;
  for (const arr of [opts.u, opts.v, opts.h]) {
    let prev = 0;
    for (const x of arr) {
      u16(zz(x - prev));
      prev = x;
    }
  }
  if (o % 2) o++;
  u32(opts.tris.length / 3);
  let highest = 0;
  for (const idx of opts.tris) {
    const code = highest - idx;
    u16(code);
    if (code === 0) highest++;
  }
  for (const e of [opts.west, opts.south, opts.east, opts.north]) {
    u32(e.length);
    e.forEach(u16);
  }
  if (opts.oct) {
    dv.setUint8(o, 1);
    o += 1;
    u32(n * 2);
    for (const b of opts.oct) dv.setUint8(o++, b);
  }
  return buf;
}

// A 3x3 grid over one tile: indices 0..8, row-major from the south-west corner.
const Q = 32767;
const H = Q / 2;
const grid = {
  u: [0, H, Q, 0, H, Q, 0, H, Q].map(Math.round),
  v: [0, 0, 0, H, H, H, Q, Q, Q].map(Math.round),
  h: [0, 0, 0, 0, Q, 0, 0, 0, 0],
  // Ordered so the high-water-mark encoding sees new indices in increasing order.
  tris: [0, 1, 3, 1, 4, 3, 1, 2, 4, 2, 5, 4, 3, 4, 6, 4, 7, 6, 4, 5, 7, 5, 8, 7],
  west: [6, 0, 3],
  south: [2, 0, 1],
  east: [5, 8, 2],
  north: [7, 6, 8],
};

describe('quantized-mesh decoder', () => {
  const tile = { z: 12, x: 4276, y: 3108 };
  const b = geoTileBounds(tile);
  const center = geodeticToEcef((b.west + b.east) / 2, (b.south + b.north) / 2, 2000);
  const buf = encode({ center, minH: 1000, maxH: 3000, ...grid, oct: new Array(18).fill(128) });

  it('decodes header, vertices, indices and edges', () => {
    const qm = decodeQuantizedMesh(buf);
    expect(qm.vertexCount).toBe(9);
    expect(qm.minHeight).toBe(1000);
    expect(qm.maxHeight).toBe(3000);
    expect(Array.from(qm.u)).toEqual(grid.u);
    expect(Array.from(qm.v)).toEqual(grid.v);
    expect(Array.from(qm.h)).toEqual(grid.h);
    expect(Array.from(qm.indices)).toEqual(grid.tris);
    expect(Array.from(qm.west)).toEqual(grid.west);
    expect(qm.octNormals?.length).toBe(18);
  });

  it('builds a local mesh with skirts and an upward peak', () => {
    const frame = enuFrame((b.west + b.east) / 2, (b.south + b.north) / 2, 0);
    const mesh = buildTileMesh(decodeQuantizedMesh(buf), b, frame);
    // 9 vertices + 4 edges x 3 skirt vertices.
    expect(mesh.positions.length / 3).toBe(21);
    // Peak (vertex 4) at 3000 m, corners at 1000 m, relative to the tile centre at 2000 m.
    expect(mesh.offset[1] + mesh.positions[4 * 3 + 1]!).toBeCloseTo(3000, 0);
    expect(mesh.offset[1] + mesh.positions[1]!).toBeLessThan(1000);
    // West edge lies west (negative x) of the centre.
    expect(mesh.positions[0]!).toBeLessThan(-1000);
    // North edge has negative z.
    expect(mesh.positions[6 * 3 + 2]!).toBeLessThan(-1000);
    // UV: north-west corner maps to texture row 0.
    expect(mesh.uvs[6 * 2]).toBe(0);
    expect(mesh.uvs[6 * 2 + 1]).toBeCloseTo(0, 6);
    // Skirt vertices sit below their edge vertex.
    expect(mesh.positions[9 * 3 + 1]!).toBeLessThan(mesh.positions[0 * 3 + 1]!);
  });

  it('decodes oct normals', () => {
    const out: [number, number, number] = [0, 0, 0];
    octDecode(128, 128, out);
    expect(out[2]).toBeGreaterThan(0.99);
    octDecode(255, 128, out);
    expect(out[0]).toBeGreaterThan(0.99);
  });
});

describe('height grid', () => {
  it('reproduces the synthetic peak', async () => {
    const { buildHeightGrid, sampleHeightGrid, GRID } = await import('../src/terrain/heightGrid');
    const b = geoTileBounds({ z: 12, x: 4276, y: 3108 });
    const center = geodeticToEcef((b.west + b.east) / 2, (b.south + b.north) / 2, 2000);
    const qm = decodeQuantizedMesh(encode({ center, minH: 1000, maxH: 3000, ...grid }));
    const g = buildHeightGrid(qm);
    expect(g).toHaveLength(GRID * GRID);
    expect(sampleHeightGrid(g, 0.5, 0.5)).toBeCloseTo(3000, 0);
    expect(sampleHeightGrid(g, 0, 0)).toBeCloseTo(1000, 0);
    // Halfway between the peak and the west edge the faces are planar: ~2000 m.
    expect(sampleHeightGrid(g, 0.25, 0.5)).toBeCloseTo(2000, -1);
  });
});
