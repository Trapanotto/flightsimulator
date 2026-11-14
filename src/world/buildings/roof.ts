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

/** A roof plane: height = c + ax x + az z. */
export interface RoofPlane {
  c: number;
  ax: number;
  az: number;
}

/**
 * The roof as the lowest of a few planes (it is concave): one for a flat roof, the two sides
 * of a gabled roof, the two sides and two ends of a hipped one. roofHeight is their minimum.
 */
export function roofPlanes(r: RoofShape): RoofPlane[] {
  if (r.kind === 'flat') return [{ c: r.eave, ax: 0, az: 0 }];
  const b = r.box;
  const W = Math.max(b.halfWidth, 1e-3);
  const k = (r.ridge - r.eave) / W;
  // s = u.(p - c) along the box, t = v.(p - c) across it, v = (-uz, ux).
  const vx = -b.uz;
  const vz = b.ux;
  const plane = (d: number, dx: number, dz: number): RoofPlane => ({
    // eave + k (d - (dx, dz).(p - c))
    c: r.eave + k * (d + dx * b.cx + dz * b.cz),
    ax: -k * dx,
    az: -k * dz,
  });
  const planes = [plane(W, vx, vz), plane(W, -vx, -vz)];
  if (r.kind === 'hipped')
    planes.push(plane(b.halfLength, b.ux, b.uz), plane(b.halfLength, -b.ux, -b.uz));
  return planes;
}

const planeAt = (p: RoofPlane, x: number, z: number) => p.c + p.ax * x + p.az * z;

/** Keeps the part of a convex polygon (flat x/z array) where a x + b z <= c. */
function clipConvex(poly: number[], a: number, b: number, c: number): number[] {
  const n = poly.length / 2;
  const out: number[] = [];
  const eps = 1e-7;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x = poly[2 * i]!;
    const z = poly[2 * i + 1]!;
    const di = a * x + b * z - c;
    const dj = a * poly[2 * j]! + b * poly[2 * j + 1]! - c;
    if (di <= eps) out.push(x, z);
    if ((di < -eps && dj > eps) || (di > eps && dj < -eps)) {
      const t = di / (di - dj);
      out.push(x + (poly[2 * j]! - x) * t, z + (poly[2 * j + 1]! - z) * t);
    }
  }
  return out.length >= 6 ? out : [];
}

/**
 * Splits a convex polygon into the roof's facets: the part where each plane is the lowest.
 * Every facet is convex and flat, so it is drawn as a fan; there are no cuts where the roof
 * does not bend.
 */
export function roofFacets(poly: number[], planes: RoofPlane[]): number[][] {
  if (planes.length === 1) return [poly];
  const out: number[][] = [];
  for (let k = 0; k < planes.length; k++) {
    let f = poly;
    const pk = planes[k]!;
    for (let j = 0; j < planes.length && f.length; j++) {
      if (j === k) continue;
      const pj = planes[j]!;
      // pk <= pj  <=>  (pk.ax - pj.ax) x + (pk.az - pj.az) z <= pj.c - pk.c
      f = clipConvex(f, pk.ax - pj.ax, pk.az - pj.az, pj.c - pk.c);
    }
    if (f.length) out.push(f);
  }
  return out;
}

/**
 * Where the roof bends along the segment a -> b, as fractions 0 < t < 1 (sorted): the points
 * where another plane becomes the lowest. Walls and fascias split their top there, at the
 * same points as the roof facets' corners.
 */
export function roofBends(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  planes: RoofPlane[],
): number[] {
  const ts: number[] = [];
  if (planes.length < 2) return ts;
  const dx = bx - ax;
  const dz = bz - az;
  const at = (p: RoofPlane, t: number) => planeAt(p, ax + dx * t, az + dz * t);
  const rate = (p: RoofPlane) => p.ax * dx + p.az * dz;
  // The lowest plane at the start, ties going to the one that falls fastest.
  let k = 0;
  for (let j = 1; j < planes.length; j++) {
    const d = at(planes[j]!, 0) - at(planes[k]!, 0);
    if (d < -1e-9 || (Math.abs(d) <= 1e-9 && rate(planes[j]!) < rate(planes[k]!))) k = j;
  }
  let t = 0;
  for (let guard = 0; guard < planes.length; guard++) {
    let best = 1;
    let next = -1;
    const pk = planes[k]!;
    for (let j = 0; j < planes.length; j++) {
      const pj = planes[j]!;
      const fall = rate(pk) - rate(pj);
      if (j === k || fall <= 1e-12) continue;
      const tj = t + (at(pj, t) - at(pk, t)) / fall;
      if (tj > t + 1e-9 && tj < best) {
        best = tj;
        next = j;
      }
    }
    if (next < 0 || best >= 1 - 1e-9) break;
    ts.push(best);
    t = best;
    k = next;
  }
  return ts;
}

/** True for a ring (positive area) whose every corner turns the same way. */
export function isConvex(r: Ring): boolean {
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n;
    const b = (i + 1) % n;
    const cross =
      (r[2 * i]! - r[2 * a]!) * (r[2 * b + 1]! - r[2 * i + 1]!) -
      (r[2 * i + 1]! - r[2 * a + 1]!) * (r[2 * b]! - r[2 * i]!);
    if (cross < -1e-9) return false;
  }
  return true;
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
  const planes = roofPlanes(roof);
  const baseFlags = s.grounded ? FLAG_GROUND : 0;

  // ---- walls ----
  // One flat polygon per ring edge: the foot along the base, the top following the roof
  // (pointed at a gable). The roof is concave, so the polygon is convex: a fan from one foot.
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
      const b0 = m.vertex(ax, s.base, az, baseFlags);
      const b1 = m.vertex(bx, s.base, bz, baseFlags);
      const ts = [1, ...roofBends(ax, az, bx, bz, planes).reverse(), 0];
      let prev = b1;
      for (const t of ts) {
        const x = ax + dx * t;
        const z = az + dz * t;
        const top = m.vertex(x, roofHeight(roof, x, z), z);
        m.triangle(b0, prev, top, nx, 0, nz);
        prev = top;
      }
    }
  }

  // ---- roof ----
  const outline = s.roofOutline ?? s.outer;
  const holes = s.roofOutline ? [] : s.holes;
  const pieces: number[][] = [];
  if (!holes.length && isConvex(outline)) pieces.push(...roofFacets(outline, planes));
  else {
    const pts = [...outline, ...holes.flat()];
    const tris = triangulate(outline, holes);
    for (let i = 0; i < tris.length; i += 3) {
      const tri = [0, 1, 2].flatMap((k) => [pts[2 * tris[i + k]!]!, pts[2 * tris[i + k]! + 1]!]);
      pieces.push(...roofFacets(tri, planes));
    }
  }
  for (const p of pieces) {
    const ids: number[] = [];
    for (let k = 0; k < p.length; k += 2)
      ids.push(m.vertex(p[k]!, roofHeight(roof, p[k]!, p[k + 1]!), p[k + 1]!));
    for (let k = 1; k + 1 < ids.length; k++) m.triangle(ids[0]!, ids[k]!, ids[k + 1]!, 0, 1, 0);
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
        const ts = [0, ...roofBends(ax, az, bx, bz, planes), 1];
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
