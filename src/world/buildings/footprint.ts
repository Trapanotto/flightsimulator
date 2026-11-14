import { ShapeUtils, Vector2 } from 'three';

/**
 * Footprint geometry in a tile's local plane: metres, x east, z south. A ring is a flat array
 * [x0, z0, x1, z1, ...] without the closing point.
 */
export type Ring = number[];

/**
 * Shoelace area in the x/z plane. Positive for a ring that runs clockwise on a north-up map
 * (east, then south, ...): the orientation used for outer rings here; holes run the other way.
 */
export function signedArea(r: Ring): number {
  let a = 0;
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += r[2 * i]! * r[2 * j + 1]! - r[2 * j]! * r[2 * i + 1]!;
  }
  return a / 2;
}

export function perimeter(r: Ring): number {
  let p = 0;
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    p += Math.hypot(r[2 * j]! - r[2 * i]!, r[2 * j + 1]! - r[2 * i + 1]!);
  }
  return p;
}

export function reverseRing(r: Ring): Ring {
  const out: Ring = [];
  for (let i = r.length / 2 - 1; i >= 0; i--) out.push(r[2 * i]!, r[2 * i + 1]!);
  return out;
}

/**
 * Drops repeated points, the closing point and points on a straight line (they would only add
 * wall quads and slivers). `eps` in metres.
 */
export function cleanRing(r: Ring, eps = 0.05): Ring {
  let pts: Ring = [];
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const x = r[2 * i]!;
    const z = r[2 * i + 1]!;
    const k = pts.length;
    if (k >= 2 && Math.hypot(x - pts[k - 2]!, z - pts[k - 1]!) < eps) continue;
    pts.push(x, z);
  }
  while (pts.length >= 4 && Math.hypot(pts[0]! - pts.at(-2)!, pts[1]! - pts.at(-1)!) < eps)
    pts.length -= 2;
  // Collinear points, repeated until none is left (removing one can expose the next).
  for (let changed = true; changed && pts.length >= 8;) {
    changed = false;
    const m = pts.length / 2;
    const keep: Ring = [];
    for (let i = 0; i < m; i++) {
      const ax = pts[2 * ((i + m - 1) % m)]!;
      const az = pts[2 * ((i + m - 1) % m) + 1]!;
      const bx = pts[2 * i]!;
      const bz = pts[2 * i + 1]!;
      const cx = pts[2 * ((i + 1) % m)]!;
      const cz = pts[2 * ((i + 1) % m) + 1]!;
      const cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
      const len = Math.hypot(cx - ax, cz - az);
      if (len > 0 && Math.abs(cross) / len < eps && !changed) {
        changed = true;
        continue;
      }
      keep.push(bx, bz);
    }
    pts = keep;
  }
  return pts.length >= 6 ? pts : [];
}

/** Douglas-Peucker on a closed ring: far-away buildings do not need every corner. */
export function simplifyRing(r: Ring, tolerance: number): Ring {
  const n = r.length / 2;
  if (n <= 4) return r;
  // Split at the point farthest from the first one, simplify both halves.
  let far = 0;
  let best = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(r[2 * i]! - r[0]!, r[2 * i + 1]! - r[1]!);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const stack: Array<[number, number]> = [
    [0, far],
    [far, n],
  ];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = r[2 * a]!;
    const az = r[2 * a + 1]!;
    const bx = r[2 * (b % n)]!;
    const bz = r[2 * (b % n) + 1]!;
    const len = Math.hypot(bx - ax, bz - az) || 1e-9;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (r[2 * i + 1]! - az) - (bz - az) * (r[2 * i]! - ax)) / len;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at >= 0 && worst > tolerance) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const out: Ring = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(r[2 * i]!, r[2 * i + 1]!);
  return out.length >= 6 ? out : r;
}

/** Sutherland-Hodgman against an axis-aligned rectangle (for features cut at a tile edge). */
export function clipRingToRect(
  r: Ring,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): Ring {
  let pts = r;
  const edges: Array<(x: number, z: number) => number> = [
    (x) => x - minX,
    (x) => maxX - x,
    (_x, z) => z - minZ,
    (_x, z) => maxZ - z,
  ];
  for (const inside of edges) {
    const out: Ring = [];
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = pts[2 * i]!;
      const az = pts[2 * i + 1]!;
      const j = (i + 1) % n;
      const bx = pts[2 * j]!;
      const bz = pts[2 * j + 1]!;
      const da = inside(ax, az);
      const db = inside(bx, bz);
      if (da >= 0) out.push(ax, az);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        out.push(ax + (bx - ax) * t, az + (bz - az) * t);
      }
    }
    pts = out;
    if (pts.length < 6) return [];
  }
  return pts;
}

/** Oriented bounding box: centre, unit long axis u, half length (along u) and half width. */
export interface Box {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  halfLength: number;
  halfWidth: number;
}

/**
 * The smallest-area rectangle around a ring, tried along every edge direction (the minimum
 * always has a side on the convex hull, and footprints have few edges). Its long axis is where
 * the ridge of a pitched roof runs.
 */
export function orientedBox(r: Ring): Box {
  const n = r.length / 2;
  let best: Box | undefined;
  let bestArea = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    let ux = r[2 * j]! - r[2 * i]!;
    let uz = r[2 * j + 1]! - r[2 * i + 1]!;
    const len = Math.hypot(ux, uz);
    if (len < 1e-6) continue;
    ux /= len;
    uz /= len;
    let s0 = Infinity;
    let s1 = -Infinity;
    let t0 = Infinity;
    let t1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const x = r[2 * k]!;
      const z = r[2 * k + 1]!;
      const s = x * ux + z * uz;
      const t = -x * uz + z * ux;
      s0 = Math.min(s0, s);
      s1 = Math.max(s1, s);
      t0 = Math.min(t0, t);
      t1 = Math.max(t1, t);
    }
    const area = (s1 - s0) * (t1 - t0);
    if (area < bestArea - 1e-9) {
      bestArea = area;
      const sm = (s0 + s1) / 2;
      const tm = (t0 + t1) / 2;
      best = {
        cx: sm * ux - tm * uz,
        cz: sm * uz + tm * ux,
        ux,
        uz,
        halfLength: (s1 - s0) / 2,
        halfWidth: (t1 - t0) / 2,
      };
    }
  }
  best ??= { cx: r[0] ?? 0, cz: r[1] ?? 0, ux: 1, uz: 0, halfLength: 0, halfWidth: 0 };
  // The long axis is u.
  if (best.halfWidth > best.halfLength) {
    const { ux, uz } = best;
    best.ux = -uz;
    best.uz = ux;
    [best.halfLength, best.halfWidth] = [best.halfWidth, best.halfLength];
  }
  return best;
}

/** The four corners of a box grown by `grow` metres on every side, as an outer ring. */
export function boxRing(b: Box, grow = 0): Ring {
  const L = b.halfLength + grow;
  const W = b.halfWidth + grow;
  const vx = -b.uz;
  const vz = b.ux;
  const pts: Ring = [];
  for (const [s, t] of [
    [-L, -W],
    [L, -W],
    [L, W],
    [-L, W],
  ] as const)
    pts.push(b.cx + s * b.ux + t * vx, b.cz + s * b.uz + t * vz);
  return signedArea(pts) >= 0 ? pts : reverseRing(pts);
}

/**
 * Triangles of a polygon with holes (ear clipping, three's Earcut). Returns indices into the
 * outer ring's points followed by each hole's points.
 */
export function triangulate(outer: Ring, holes: Ring[] = []): number[] {
  const toV = (r: Ring) => {
    const v: Vector2[] = [];
    for (let i = 0; i < r.length; i += 2) v.push(new Vector2(r[i], r[i + 1]));
    return v;
  };
  const faces = ShapeUtils.triangulateShape(toV(outer), holes.map(toV));
  const out: number[] = [];
  for (const f of faces) out.push(f[0]!, f[1]!, f[2]!);
  return out;
}
