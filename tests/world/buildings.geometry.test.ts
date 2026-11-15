import { describe, expect, it } from 'vitest';
import {
  boxRing,
  cleanRing,
  clipRingToRect,
  orientedBox,
  signedArea,
  simplifyRing,
  triangulate,
} from '../../src/world/buildings/footprint';
import { MeshBuilder } from '../../src/world/buildings/mesh';
import {
  addSolid,
  orient,
  roofCreases,
  roofHeight,
  type RoofShape,
} from '../../src/world/buildings/roof';
import { unpack } from './buildings.helpers';

/** Rectangle w x h (x east, z south) as an outer ring: clockwise on the map. */
const rect = (w: number, h: number, x = 0, z = 0) => [x, z, x + w, z, x + w, z + h, x, z + h];

/** Sum of triangle areas in the x/z plane. */
function triangleArea(pts: number[], tris: number[]) {
  let a = 0;
  for (let i = 0; i < tris.length; i += 3) {
    const [p, q, r] = [tris[i]!, tris[i + 1]!, tris[i + 2]!];
    const ax = pts[2 * p]!;
    const az = pts[2 * p + 1]!;
    a += Math.abs(
      (pts[2 * q]! - ax) * (pts[2 * r + 1]! - az) - (pts[2 * r]! - ax) * (pts[2 * q + 1]! - az),
    );
  }
  return a / 2;
}

describe('footprints', () => {
  it('orients outer rings positive and holes negative', () => {
    expect(signedArea(rect(20, 10))).toBeCloseTo(200, 9);
    const o = orient(rect(20, 10).reverse(), [rect(4, 4, 2, 2)]);
    expect(signedArea(o.outer)).toBeGreaterThan(0);
    expect(signedArea(o.holes[0]!)).toBeLessThan(0);
  });

  it('drops repeated, closing and collinear points', () => {
    const r = [0, 0, 5, 0, 10, 0, 10, 0, 10, 10, 0, 10, 0, 0];
    expect(cleanRing(r).length).toBe(8);
    expect(Math.abs(signedArea(cleanRing(r)))).toBeCloseTo(100, 9);
  });

  it('triangulates a courtyard building without covering the courtyard', () => {
    const outer = rect(30, 20);
    const hole = rect(10, 8, 10, 6).reverse();
    const pts = [...outer, ...hole];
    const tris = triangulate(outer, [hole]);
    expect(triangleArea(pts, tris)).toBeCloseTo(600 - 80, 6);
  });

  it('finds the oriented box of a rotated rectangle, long axis first', () => {
    const a = (30 * Math.PI) / 180;
    const r: number[] = [];
    for (const [x, z] of [
      [-12, -4],
      [12, -4],
      [12, 4],
      [-12, 4],
    ] as const)
      r.push(100 + x * Math.cos(a) - z * Math.sin(a), 50 + x * Math.sin(a) + z * Math.cos(a));
    const b = orientedBox(r);
    expect(b.halfLength).toBeCloseTo(12, 6);
    expect(b.halfWidth).toBeCloseTo(4, 6);
    expect(Math.abs(b.ux * Math.cos(a) + b.uz * Math.sin(a))).toBeCloseTo(1, 6);
    expect(b.cx).toBeCloseTo(100, 6);
    expect(b.cz).toBeCloseTo(50, 6);
    expect(Math.abs(signedArea(boxRing(b, 1)))).toBeCloseTo(26 * 10, 6);
  });

  it('simplifies far outlines and clips at tile edges', () => {
    const wobbly = [0, 0, 5, 0.05, 10, 0, 10, 10, 5, 10.05, 0, 10];
    expect(simplifyRing(wobbly, 0.5).length).toBe(8);
    const clipped = clipRingToRect(rect(20, 10, -5, 0), 0, -100, 100, 100);
    expect(Math.abs(signedArea(clipped))).toBeCloseTo(150, 9);
  });
});

describe('roofs', () => {
  const house = (kind: RoofShape['kind']): RoofShape => ({
    kind,
    box: orientedBox(rect(20, 10)),
    eave: 6,
    ridge: 10,
  });

  it('runs the ridge of a gabled roof along the long side, eaves on the long walls', () => {
    const r = house('gabled');
    // The long axis is x (20 m); the ridge is the line z = 5.
    expect(roofHeight(r, 0, 5)).toBeCloseTo(10, 9);
    expect(roofHeight(r, 20, 5)).toBeCloseTo(10, 9);
    expect(roofHeight(r, 10, 0)).toBeCloseTo(6, 9);
    expect(roofHeight(r, 10, 10)).toBeCloseTo(6, 9);
    expect(roofHeight(r, 10, 2.5)).toBeCloseTo(8, 9);
    expect(roofCreases(r)).toHaveLength(1);
  });

  it('slopes the ends of a hipped roof at the same pitch', () => {
    const r = house('hipped');
    expect(roofHeight(r, 10, 5)).toBeCloseTo(10, 9);
    expect(roofHeight(r, 0, 5)).toBeCloseTo(6, 9);
    // 2 m in from the end: 2 m up at a slope of 4 m over 5 m.
    expect(roofHeight(r, 2, 5)).toBeCloseTo(6 + 0.8 * 2, 9);
    expect(roofCreases(r)).toHaveLength(5);
  });

  it('builds a closed house: pointed gable walls, roof at the right heights', () => {
    const m = new MeshBuilder();
    m.begin({
      anchorX: 10,
      anchorZ: 5,
      cell: -1,
      seed: 0.5,
      roof: [0.3, 0.1, 0.05],
      wall: [0.6, 0.6, 0.5],
      kind: 0,
      eave: 6,
    });
    const tris = addSolid(m, {
      outer: rect(20, 10),
      holes: [],
      roof: house('gabled'),
      base: -1,
      grounded: true,
    });
    const d = m.finish();
    expect(tris).toBeGreaterThan(8);
    expect(d.maxY).toBeCloseTo(10, 6);
    expect(d.minY).toBeCloseTo(-1, 6);
    // Ridge vertices sit at the middle of the short walls (z = 5), at the ridge height.
    const u = unpack(d);
    const ridge: Array<[number, number]> = [];
    for (let i = 0; i < u.positions.length; i += 3)
      if (Math.abs(u.positions[i + 1]! - 10) < 1e-3)
        ridge.push([u.positions[i]!, u.positions[i + 2]!]);
    expect(ridge.length).toBeGreaterThanOrEqual(2);
    for (const [, z] of ridge) expect(z).toBeCloseTo(5, 3);
    // Wall feet are marked to follow the ground.
    for (let i = 0; i < d.vertexCount; i++)
      expect(u.ground[i]).toBe(u.positions[3 * i + 1]! < -0.5);
    // Every triangle faces outwards or up: roof normals point up.
    const p = u.positions;
    for (let t = 0; t < d.indices.length; t += 3) {
      const [a, b, c] = [d.indices[t]!, d.indices[t + 1]!, d.indices[t + 2]!];
      const ux = p[3 * b]! - p[3 * a]!;
      const uy = p[3 * b + 1]! - p[3 * a + 1]!;
      const uz = p[3 * b + 2]! - p[3 * a + 2]!;
      const vx = p[3 * c]! - p[3 * a]!;
      const vy = p[3 * c + 1]! - p[3 * a + 1]!;
      const vz = p[3 * c + 2]! - p[3 * a + 2]!;
      const ny = uz * vx - ux * vz;
      const nx = uy * vz - uz * vy;
      const nz = ux * vy - uy * vx;
      const cx = (p[3 * a]! + p[3 * b]! + p[3 * c]!) / 3 - 10;
      const cz = (p[3 * a + 2]! + p[3 * b + 2]! + p[3 * c + 2]!) / 3 - 5;
      // Outward: the normal points away from the box centre (or up for the roof).
      expect(nx * cx + nz * cz + ny * 10).toBeGreaterThan(0);
    }
  });

  it('covers a footprint with holes by its roof and walls the courtyard', () => {
    const m = new MeshBuilder();
    m.begin({
      anchorX: 0,
      anchorZ: 0,
      cell: -1,
      seed: 0,
      roof: [0, 0, 0],
      wall: [0, 0, 0],
      kind: 1,
      eave: 15,
    });
    const o = orient(rect(30, 20), [rect(10, 8, 10, 6)]);
    addSolid(m, {
      outer: o.outer,
      holes: o.holes,
      roof: { kind: 'flat', box: orientedBox(o.outer), eave: 15, ridge: 15 },
      base: -1,
      grounded: true,
    });
    const d = m.finish();
    // Roof area: triangles at y = 15.
    let roof = 0;
    const p = unpack(d).positions;
    for (let t = 0; t < d.indices.length; t += 3) {
      const [a, b, c] = [d.indices[t]!, d.indices[t + 1]!, d.indices[t + 2]!];
      if ([a, b, c].every((v) => Math.abs(p[3 * v + 1]! - 15) < 1e-3)) {
        roof +=
          Math.abs(
            (p[3 * b]! - p[3 * a]!) * (p[3 * c + 2]! - p[3 * a + 2]!) -
              (p[3 * c]! - p[3 * a]!) * (p[3 * b + 2]! - p[3 * a + 2]!),
          ) / 2;
      }
    }
    expect(roof).toBeCloseTo(600 - 80, 1);
  });
});
