import { prng } from './hash';

/**
 * Procedural tree meshes in "tree space": y from the ground (0) to the top (1); x and z in units
 * of the crown radius for crown and branches, of the trunk radius for the trunk. The shader
 * scales each part by the instance's own height, crown width and trunk thickness, so one mesh
 * serves every size and proportion.
 *
 * Per vertex:
 *   position, normal (tree space, before the instance's non-uniform scale)
 *   part: 0 trunk, 1 crown, 2 branch (hidden in the leafy crown, seen in winter)
 *   ao: baked ambient occlusion of the crown (inner and lower parts darker)
 */
export interface TreeMesh {
  positions: Float32Array;
  normals: Float32Array;
  parts: Float32Array;
  ao: Float32Array;
  indices: Uint16Array;
}

class Builder {
  p: number[] = [];
  n: number[] = [];
  part: number[] = [];
  ao: number[] = [];
  idx: number[] = [];

  vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    part: number,
    ao: number,
  ) {
    const l = Math.hypot(nx, ny, nz) || 1;
    this.p.push(x, y, z);
    this.n.push(nx / l, ny / l, nz / l);
    this.part.push(part);
    this.ao.push(ao);
    return this.p.length / 3 - 1;
  }

  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }

  build(): TreeMesh {
    return {
      positions: new Float32Array(this.p),
      normals: new Float32Array(this.n),
      parts: new Float32Array(this.part),
      ao: new Float32Array(this.ao),
      indices: new Uint16Array(this.idx),
    };
  }
}

/**
 * A tapered prism from (x0, y0, z0) to (x1, y1, z1); radii in the units of `part`. Its ends are
 * open: the bottom is in the ground or the trunk, the top inside the crown.
 */
function prism(
  b: Builder,
  sides: number,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  r0: number,
  r1: number,
  part: number,
  ao0: number,
  ao1: number,
) {
  // Any frame perpendicular to the axis.
  const ax = to[0] - from[0];
  const ay = to[1] - from[1];
  const az = to[2] - from[2];
  const al = Math.hypot(ax, ay, az) || 1;
  const dx = ax / al;
  const dy = ay / al;
  const dz = az / al;
  // u = normalize(axis x X) or (axis x Z) when nearly parallel to X.
  let ux = 0;
  let uy = dz;
  let uz = -dy;
  if (Math.hypot(uy, uz) < 0.3) {
    ux = dy;
    uy = -dx;
    uz = 0;
  }
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = dy * uz - dz * uy;
  const vy = dz * ux - dx * uz;
  const vz = dx * uy - dy * ux;
  const base = b.p.length / 3;
  for (let s = 0; s <= sides; s++) {
    const a = (s / sides) * Math.PI * 2;
    const c = Math.cos(a);
    const si = Math.sin(a);
    const nx = ux * c + vx * si;
    const ny = uy * c + vy * si;
    const nz = uz * c + vz * si;
    b.vertex(from[0] + nx * r0, from[1] + ny * r0, from[2] + nz * r0, nx, ny, nz, part, ao0);
    b.vertex(to[0] + nx * r1, to[1] + ny * r1, to[2] + nz * r1, nx, ny, nz, part, ao1);
  }
  for (let s = 0; s < sides; s++) {
    const i = base + s * 2;
    b.tri(i, i + 2, i + 1);
    b.tri(i + 1, i + 2, i + 3);
  }
}

export interface ConiferOptions {
  /** Whorls of branches from the crown base to the top. */
  tiers: number;
  /** Branch tips per whorl. */
  spokes: number;
  /** Close each whorl from below (seen from low and near). */
  underside: boolean;
  /** Sides of the trunk, 0 = none. */
  trunkSides: number;
  seed?: number;
}

/** Height of the crown base of conifers (fraction of the tree): the trunk shows below it. */
export const CONIFER_CROWN_BASE = 0.14;
/** Height of the crown base of broadleaf trees. */
export const BROADLEAF_CROWN_BASE = 0.36;

/**
 * A spruce or fir: stacked whorls of drooping branches, each a star of branch tips with notches
 * between them, overlapping like skirts, under a narrow spire. The envelope is slightly
 * convex, as old spruces are, and every whorl is turned and jittered on its own.
 */
export function coniferMesh(o: ConiferOptions): TreeMesh {
  const b = new Builder();
  const rnd = prng(o.seed ?? 7);
  const cb = CONIFER_CROWN_BASE;
  const top = 0.93;
  const T = o.tiers;
  const S = o.spokes;
  const step = (top - cb) / T;
  for (let k = 0; k < T; k++) {
    const t = k / T;
    const y = cb + (top - cb) * Math.pow(t, 1.05);
    const R = Math.pow(1 - t, 0.72) * (0.92 + 0.16 * rnd());
    const rimY = y - 0.25 * step;
    const hubY = y + (T > 3 ? 1.9 : 1.5) * step;
    const rot = rnd() * Math.PI * 2;
    // Lower whorls are shaded by the ones above and by the neighbours.
    const aoTier = 0.35 + 0.65 * Math.pow(t, 0.7);
    const rim: Array<[number, number, number, number, number]> = [];
    for (let s = 0; s < S * 2; s++) {
      const a = rot + (s / (S * 2)) * Math.PI * 2 + (rnd() - 0.5) * 0.25;
      const tip = s % 2 === 0;
      const r = tip ? R * (0.88 + 0.24 * rnd()) : R * (0.58 + 0.12 * rnd());
      const ry = tip ? rimY - 0.15 * step * rnd() : rimY + 0.45 * step;
      rim.push([Math.cos(a) * r, ry, Math.sin(a) * r, Math.cos(a), Math.sin(a)]);
    }
    // Upper surface: from the whorl's hub on the stem out to the branch tips.
    const hub = b.vertex(0, hubY, 0, 0, 1, 0, 1, aoTier);
    const first = b.p.length / 3;
    for (const [x, ry, z, cx, cz] of rim) {
      const outer = Math.hypot(x, z) / Math.max(R, 1e-3);
      b.vertex(x, ry, z, cx, 0.45, cz, 1, aoTier * (0.75 + 0.25 * outer));
    }
    for (let s = 0; s < S * 2; s++) b.tri(hub, first + ((s + 1) % (S * 2)), first + s);
    if (o.underside) {
      const under = b.vertex(0, rimY + 0.7 * step, 0, 0, -1, 0, 1, aoTier * 0.35);
      const f2 = b.p.length / 3;
      for (const [x, ry, z, cx, cz] of rim) b.vertex(x, ry, z, cx, -0.6, cz, 1, aoTier * 0.55);
      for (let s = 0; s < S * 2; s++) b.tri(under, f2 + s, f2 + ((s + 1) % (S * 2)));
    }
  }
  // The leader: a thin spire above the last whorl.
  const lastHub = cb + (top - cb) * Math.pow((T - 1) / T, 1.05) + (T > 3 ? 1.9 : 1.5) * step;
  if (lastHub < 1) {
    const tip = b.vertex(0, 1, 0, 0, 1, 0, 1, 1);
    const base = b.p.length / 3;
    const r = 0.05;
    for (let s = 0; s < 3; s++) {
      const a = (s / 3) * Math.PI * 2;
      b.vertex(
        Math.cos(a) * r,
        lastHub - 0.02,
        Math.sin(a) * r,
        Math.cos(a),
        0.3,
        Math.sin(a),
        1,
        0.9,
      );
    }
    for (let s = 0; s < 3; s++) b.tri(tip, base + ((s + 1) % 3), base + s);
  }
  if (o.trunkSides > 0)
    prism(b, o.trunkSides, [0, -0.08, 0], [0, cb + 0.3, 0], 1, 0.6, 0, 0.5, 0.3);
  return b.build();
}

export interface BroadleafOptions {
  /** Leafy lumps of the crown. */
  lumps: number;
  /** Subdivision of each lump (0 = icosahedron, 1 = 80 faces). */
  detail: 0 | 1;
  trunkSides: number;
  /** Main limbs, seen when the crown is bare. */
  limbs: number;
  seed?: number;
}

/** Unit icosphere (subdivided `detail` times): vertices and faces. */
function icosphere(detail: number) {
  const t = (1 + Math.sqrt(5)) / 2;
  const v: number[][] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map((p) => {
    const l = Math.hypot(p[0]!, p[1]!, p[2]!);
    return [p[0]! / l, p[1]! / l, p[2]! / l];
  });
  let f: number[][] = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  for (let d = 0; d < detail; d++) {
    const cache = new Map<string, number>();
    const mid = (a: number, b: number) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      let i = cache.get(key);
      if (i === undefined) {
        const p = v[a]!;
        const q = v[b]!;
        const m = [p[0]! + q[0]!, p[1]! + q[1]!, p[2]! + q[2]!];
        const l = Math.hypot(m[0]!, m[1]!, m[2]!);
        i = v.push([m[0]! / l, m[1]! / l, m[2]! / l]) - 1;
        cache.set(key, i);
      }
      return i;
    };
    const next: number[][] = [];
    for (const [a, b, c] of f) {
      const ab = mid(a!, b!);
      const bc = mid(b!, c!);
      const ca = mid(c!, a!);
      next.push([a!, ab, ca], [b!, bc, ab], [c!, ca, bc], [ab, bc, ca]);
    }
    f = next;
  }
  return { v, f };
}

/**
 * A broadleaf tree: a crown of overlapping leafy lumps (each bumped by its own noise) on a
 * short trunk with a few main limbs. Normals are half the lump's own and half the whole
 * crown's, so the crown reads as one volume lit from the side but keeps its clumps.
 * Also used, with other proportions and colours, for pines and shrubs.
 */
export function broadleafMesh(o: BroadleafOptions): TreeMesh {
  const b = new Builder();
  const rnd = prng(o.seed ?? 11);
  const cb = BROADLEAF_CROWN_BASE;
  // The crown: x, z in [-1, 1], y in [cb, 1]; hy is its half height in tree units.
  const hy = (1 - cb) / 2;
  const cy = cb + hy;
  const ico = icosphere(o.detail);
  const lumps: Array<[number, number, number, number]> = [];
  if (o.lumps <= 1) lumps.push([0, cy, 0, 1]);
  else if (o.lumps <= 3) {
    lumps.push([0, cy + 0.35 * hy, 0, 0.75]);
    for (let i = 0; i < o.lumps - 1; i++) {
      const a = (i / (o.lumps - 1)) * Math.PI * 2 + 0.6;
      lumps.push([Math.cos(a) * 0.38, cy - 0.2 * hy, Math.sin(a) * 0.38, 0.66]);
    }
  } else {
    // A core that fills the inside (seen through gaps as shade), and clumps spread evenly over
    // the crown's shell (a Fibonacci spiral), fewer underneath where branches carry less.
    lumps.push([0, cy - 0.05 * hy, 0, 0.66]);
    const shell = o.lumps - 1;
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < shell; i++) {
      // From the top (y = 1) down to about 40 degrees below the equator.
      const yy = 1 - (i + 0.5) * (1.62 / shell);
      const rr = Math.sqrt(Math.max(0, 1 - yy * yy));
      const a = i * golden + (rnd() - 0.5) * 0.5;
      const dist = 0.62 + 0.1 * rnd();
      lumps.push([
        Math.cos(a) * rr * dist,
        cy + yy * dist * hy,
        Math.sin(a) * rr * dist,
        // Fewer clumps are bigger, so the crown stays closed.
        (0.36 + 0.1 * rnd()) * (yy > 0.6 ? 1.1 : 1) * Math.min(1.45, Math.pow(14 / shell, 0.4)),
      ]);
    }
  }
  for (const [lx, ly, lz, lr] of lumps) {
    const base = b.p.length / 3;
    const phase = rnd() * 100;
    for (const [nx, ny, nz] of ico.v) {
      // Bumps on the lump: a few low-frequency waves, at most about 18 % of its radius.
      const bump =
        1 +
        0.13 * Math.sin(nx! * 5.1 + phase) * Math.cos(nz! * 4.3 + phase * 0.7) +
        0.1 * Math.sin(ny! * 6.7 + nx! * 2.1 + phase * 1.3);
      const r = lr * bump;
      const x = lx + nx! * r;
      const y = ly + ny! * r * hy;
      const z = lz + nz! * r;
      // Crown normal of the ellipsoid x² + ((y - cy) / hy)² + z² = 1, in tree space.
      const cxn = x;
      const cyn = (y - cy) / (hy * hy);
      const czn = z;
      const cl = Math.hypot(cxn, cyn, czn) || 1;
      // Lump normal (ellipsoid with half height lr * hy).
      const lyn = ny! / hy;
      const ll = Math.hypot(nx!, lyn, nz!) || 1;
      const wx = 0.45 * (nx! / ll) + 0.55 * (cxn / cl);
      const wy = 0.45 * (lyn / ll) + 0.55 * (cyn / cl);
      const wz = 0.45 * (nz! / ll) + 0.55 * (czn / cl);
      // Occlusion: the crown's inside and underside are dark; tops of lumps catch sky light.
      const radial = Math.min(1, Math.hypot(x, z));
      const height = (y - cb) / (1 - cb);
      const ao = Math.min(
        1,
        (0.3 + 0.45 * radial + 0.35 * height) * (0.75 + 0.25 * Math.max(0, ny!)),
      );
      b.vertex(x, y, z, wx, wy, wz, 1, ao);
    }
    for (const [i0, i1, i2] of ico.f) b.tri(base + i0!, base + i1!, base + i2!);
  }
  if (o.trunkSides > 0)
    prism(b, o.trunkSides, [0, -0.08, 0], [0, cb + 0.2, 0], 1, 0.75, 0, 0.5, 0.3);
  // Limbs, in crown units like the crown: from the top of the trunk up and out.
  for (let i = 0; i < o.limbs; i++) {
    const a = (i / o.limbs) * Math.PI * 2 + rnd() * 0.8;
    const r = 0.55 + 0.25 * rnd();
    prism(
      b,
      3,
      [0, cb - 0.04, 0],
      [Math.cos(a) * r, cy + (rnd() * 0.6 + 0.1) * hy, Math.sin(a) * r],
      0.045,
      0.012,
      2,
      0.5,
      0.8,
    );
  }
  if (o.limbs > 0) prism(b, 3, [0, cb - 0.04, 0], [0, 0.97, 0], 0.07, 0.02, 2, 0.5, 0.9);
  return b.build();
}

/** Levels of detail per form: near (full), mid, far. */
export interface TreeMeshes {
  conifer: [TreeMesh, TreeMesh, TreeMesh];
  broadleaf: [TreeMesh, TreeMesh, TreeMesh];
}

export function buildTreeMeshes(lite: boolean): TreeMeshes {
  return {
    conifer: [
      coniferMesh(
        lite
          ? { tiers: 6, spokes: 7, underside: true, trunkSides: 5 }
          : { tiers: 10, spokes: 9, underside: true, trunkSides: 6 },
      ),
      coniferMesh({ tiers: 4, spokes: 6, underside: !lite, trunkSides: 3, seed: 3 }),
      coniferMesh({ tiers: 2, spokes: 4, underside: false, trunkSides: 0, seed: 5 }),
    ],
    broadleaf: [
      broadleafMesh(
        lite
          ? { lumps: 7, detail: 1, trunkSides: 5, limbs: 4 }
          : { lumps: 15, detail: 1, trunkSides: 6, limbs: 7 },
      ),
      broadleafMesh({ lumps: 6, detail: 0, trunkSides: 3, limbs: 0, seed: 4 }),
      broadleafMesh({ lumps: 1, detail: 0, trunkSides: 0, limbs: 0, seed: 6 }),
    ],
  };
}
