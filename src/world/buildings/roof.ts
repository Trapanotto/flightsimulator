import { type Box, type Ring, signedArea, triangulate } from './footprint';
import { FLAG_GROUND, type MeshBuilder } from './mesh';

export type RoofKind = 'flat' | 'gabled' | 'hipped';

/**
 * A roof as a height field over the footprint: piecewise linear, so it is drawn exactly by
 * triangles that do not cross its creases (ridge, hips). Gabled and hipped roofs are laid over
 * the footprint's oriented box with the ridge along its long axis, which is what most Swiss
 * houses and barns do.
 */
export interface RoofShape {
  kind: RoofKind;
  box: Box;
  /** Height of the eaves (where the roof meets the walls at the box's long sides), metres. */
  eave: number;
  /** Height of the ridge. */
  ridge: number;
}

/** Height of the roof at x/z. Outside the box (eave overhang) the planes continue down. */
export function roofHeight(r: RoofShape, x: number, z: number): number {
  if (r.kind === 'flat') return r.eave;
  const b = r.box;
  const dx = x - b.cx;
  const dz = z - b.cz;
  const s = dx * b.ux + dz * b.uz;
  const t = -dx * b.uz + dz * b.ux;
  const W = Math.max(b.halfWidth, 1e-3);
  const slope = (r.ridge - r.eave) / W;
  const across = W - Math.abs(t);
  if (r.kind === 'gabled') return r.eave + slope * across;
  // Hipped: the ends slope at the same pitch as the long sides.
  return r.eave + slope * Math.min(across, b.halfLength - Math.abs(s));
}

/** The creases of a roof as lines a x + b z = c (the height is linear between them). */
export function roofCreases(r: RoofShape): Array<[number, number, number]> {
  if (r.kind === 'flat') return [];
  const b = r.box;
  const vx = -b.uz;
  const vz = b.ux;
  // t = 0: the ridge line.
  const lines: Array<[number, number, number]> = [[vx, vz, vx * b.cx + vz * b.cz]];
  if (r.kind === 'hipped') {
    const d = b.halfLength - b.halfWidth;
    // |s| - |t| = d: the four hip lines. s = u.(p - c), t = v.(p - c).
    for (const ss of [1, -1])
      for (const st of [1, -1]) {
        const a = ss * b.ux - st * vx;
        const bb = ss * b.uz - st * vz;
        lines.push([a, bb, d + a * b.cx + bb * b.cz]);
      }
  }
  return lines;
}

/** Splits a convex polygon (flat x/z array) by a line into the parts on either side. */
function splitConvex(poly: number[], line: [number, number, number]): number[][] {
  const [a, b, c] = line;
  const n = poly.length / 2;
  const pos: number[] = [];
  const neg: number[] = [];
  let anyPos = false;
  let anyNeg = false;
  const side: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = a * poly[2 * i]! + b * poly[2 * i + 1]! - c;
    side.push(d);
    if (d > 1e-6) anyPos = true;
    if (d < -1e-6) anyNeg = true;
  }
  if (!anyPos || !anyNeg) return [poly];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x = poly[2 * i]!;
    const z = poly[2 * i + 1]!;
    const di = side[i]!;
    const dj = side[j]!;
    if (di >= -1e-6) pos.push(x, z);
    if (di <= 1e-6) neg.push(x, z);
    if ((di > 1e-6 && dj < -1e-6) || (di < -1e-6 && dj > 1e-6)) {
      const t = di / (di - dj);
      const px = x + (poly[2 * j]! - x) * t;
      const pz = z + (poly[2 * j + 1]! - z) * t;
      pos.push(px, pz);
      neg.push(px, pz);
    }
  }
  return [pos, neg].filter((p) => p.length >= 6);
}

/** Positions along a ring edge where it crosses a crease (0 < t < 1), sorted. */
function edgeCrossings(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  lines: Array<[number, number, number]>,
): number[] {
  const ts: number[] = [];
  for (const [a, b, c] of lines) {
    const da = a * ax + b * az - c;
    const db = a * bx + b * bz - c;
    if ((da > 1e-6 && db < -1e-6) || (da < -1e-6 && db > 1e-6)) ts.push(da / (da - db));
  }
  return ts.sort((p, q) => p - q);
}

export interface Solid {
  /** Outer ring (positive area) and holes (negative area), tile-frame x/z. */
  outer: Ring;
  holes: Ring[];
  roof: RoofShape;
  /** Where the walls start: below the ground (negative) for buildings, above it for canopies. */
  base: number;
  /** Walls start on the ground (and follow it on slopes) rather than in the air. */
  grounded: boolean;
  /**
   * The roof's own outline when it overhangs the walls (eaves), else undefined (the roof
   * covers the footprint exactly).
   */
  roofOutline?: Ring;
}

/**
 * Adds a building to the mesh: walls from the base up to the roof (gable ends get their
 * pointed top because the wall follows the roof height and is split at the ridge), and the
 * roof as the footprint's triangles cut along the creases and lifted onto the roof planes.
 * Returns the number of triangles added.
 */
export function addSolid(m: MeshBuilder, s: Solid): number {
  const before = m.triangleCount;
  const roof = s.roof;
  const lines = roofCreases(roof);
  const baseFlags = s.grounded ? FLAG_GROUND : 0;

  // ---- walls ----
  for (const ring of [s.outer, ...s.holes]) {
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = ring[2 * i]!;
      const az = ring[2 * i + 1]!;
      const bx = ring[2 * j]!;
      const bz = ring[2 * j + 1]!;
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 1e-3) continue;
      // Outward for both: outer rings run with positive area, holes the other way round, so
      // (dz, -dx) points away from the building's inside in either case.
      const nx = dz / len;
      const nz = -dx / len;
      const ts = [0, ...edgeCrossings(ax, az, bx, bz, lines), 1];
      for (let k = 0; k + 1 < ts.length; k++) {
        const p0x = ax + dx * ts[k]!;
        const p0z = az + dz * ts[k]!;
        const p1x = ax + dx * ts[k + 1]!;
        const p1z = az + dz * ts[k + 1]!;
        const b0 = m.vertex(p0x, s.base, p0z, baseFlags);
        const b1 = m.vertex(p1x, s.base, p1z, baseFlags);
        const t0 = m.vertex(p0x, roofHeight(roof, p0x, p0z), p0z);
        const t1 = m.vertex(p1x, roofHeight(roof, p1x, p1z), p1z);
        m.triangle(b0, b1, t1, nx, 0, nz);
        m.triangle(b0, t1, t0, nx, 0, nz);
      }
    }
  }

  // ---- roof ----
  const outline = s.roofOutline ?? s.outer;
  const holes = s.roofOutline ? [] : s.holes;
  const pts = [...outline, ...holes.flat()];
  const tris = triangulate(outline, holes);
  for (let i = 0; i < tris.length; i += 3) {
    let pieces: number[][] = [
      [
        pts[2 * tris[i]!]!,
        pts[2 * tris[i]! + 1]!,
        pts[2 * tris[i + 1]!]!,
        pts[2 * tris[i + 1]! + 1]!,
        pts[2 * tris[i + 2]!]!,
        pts[2 * tris[i + 2]! + 1]!,
      ],
    ];
    for (const line of lines) pieces = pieces.flatMap((p) => splitConvex(p, line));
    for (const p of pieces) {
      const ids: number[] = [];
      for (let k = 0; k < p.length; k += 2)
        ids.push(m.vertex(p[k]!, roofHeight(roof, p[k]!, p[k + 1]!), p[k + 1]!));
      for (let k = 1; k + 1 < ids.length; k++) m.triangle(ids[0]!, ids[k]!, ids[k + 1]!, 0, 1, 0);
    }
  }

  // An overhanging roof needs its underside (seen from the street) and canopies their soffit.
  if (s.roofOutline || !s.grounded) {
    const under = s.roofOutline ?? s.outer;
    const ut = triangulate(under, s.roofOutline ? [] : s.holes);
    const up = [...under, ...(s.roofOutline ? [] : s.holes.flat())];
    for (let i = 0; i < ut.length; i += 3) {
      const ids = [ut[i]!, ut[i + 1]!, ut[i + 2]!].map((k) => {
        const x = up[2 * k]!;
        const z = up[2 * k + 1]!;
        // A thin roof slab: 25 cm below the roof surface, or the canopy's base.
        const y = s.grounded ? roofHeight(roof, x, z) - 0.25 : s.base;
        return m.vertex(x, y, z);
      });
      m.triangle(ids[0]!, ids[1]!, ids[2]!, 0, -1, 0);
    }
    // The overhang's edge: a narrow fascia all round, so the roof does not look paper thin.
    if (s.roofOutline) {
      const n = under.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = under[2 * i]!;
        const az = under[2 * i + 1]!;
        const bx = under[2 * j]!;
        const bz = under[2 * j + 1]!;
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1e-3) continue;
        const nx = (bz - az) / len;
        const nz = -(bx - ax) / len;
        const ts = [0, ...edgeCrossings(ax, az, bx, bz, lines), 1];
        for (let k = 0; k + 1 < ts.length; k++) {
          const p0x = ax + (bx - ax) * ts[k]!;
          const p0z = az + (bz - az) * ts[k]!;
          const p1x = ax + (bx - ax) * ts[k + 1]!;
          const p1z = az + (bz - az) * ts[k + 1]!;
          const h0 = roofHeight(roof, p0x, p0z);
          const h1 = roofHeight(roof, p1x, p1z);
          const a0 = m.vertex(p0x, h0, p0z);
          const a1 = m.vertex(p1x, h1, p1z);
          const c0 = m.vertex(p0x, h0 - 0.25, p0z);
          const c1 = m.vertex(p1x, h1 - 0.25, p1z);
          m.triangle(c0, c1, a1, nx, 0, nz);
          m.triangle(c0, a1, a0, nx, 0, nz);
        }
      }
    }
  }
  return m.triangleCount - before;
}

/** Makes an outer ring run with positive area and holes with negative area. */
export function orient(outer: Ring, holes: Ring[]): { outer: Ring; holes: Ring[] } {
  const rev = (r: Ring) => {
    const out: Ring = [];
    for (let i = r.length / 2 - 1; i >= 0; i--) out.push(r[2 * i]!, r[2 * i + 1]!);
    return out;
  };
  return {
    outer: signedArea(outer) >= 0 ? outer : rev(outer),
    holes: holes.map((h) => (signedArea(h) <= 0 ? h : rev(h))),
  };
}
