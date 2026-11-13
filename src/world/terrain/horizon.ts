/**
 * Horizon angles of the terrain, baked per tile in the worker: for a grid of points over the
 * tile, how high the terrain rises around them in eight compass directions. The shader takes
 * the horizon in the direction of the sun: below it the point lies in a mountain's shadow, and
 * the average over all directions tells how much sky a point sees (valleys and gullies get
 * less sky light). Pure functions, tested in Node.
 *
 * Shadows of mountains reach for kilometres, beyond the tile: besides the tile's own fine
 * heights the march reads a coarse height field of the surroundings (the same for all tiles of
 * a region), so that a valley floor lies in the same shadow at every level of detail.
 */
import type { GeoBounds } from '@geo';

/** Compass directions, clockwise from north: N, NE, E, SE, S, SW, W, NW. */
export const HORIZON_DIRS = 8;
/** Horizon angles are stored in steps of a quarter degree up to 63.75°. */
export const HORIZON_STEPS_PER_DEG = 4;
const EARTH_RADIUS = 6_371_000;
const M_PER_DEG_LAT = 111_132;

/** Heights over geographic bounds; row 0 is the north edge, cell centres at (i + 0.5) / w. */
export interface HeightField {
  bounds: GeoBounds;
  w: number;
  h: number;
  /** Heights in metres; NaN where unknown. */
  data: Float32Array;
}

/**
 * Rasterises a triangle mesh in tile coordinates (u, v from 0 at west/south to `max` at
 * east/north) with per-vertex heights into a w x h field over `bounds`.
 */
export function rasterizeMesh(
  u: ArrayLike<number>,
  v: ArrayLike<number>,
  heights: ArrayLike<number>,
  indices: ArrayLike<number>,
  max: number,
  bounds: GeoBounds,
  w: number,
  h: number,
): HeightField {
  const data = new Float32Array(w * h).fill(NaN);
  const X = (i: number) => (u[i]! / max) * w;
  const Y = (i: number) => (1 - v[i]! / max) * h;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]!;
    const b = indices[t + 1]!;
    const c = indices[t + 2]!;
    const ax = X(a);
    const ay = Y(a);
    const bx = X(b);
    const by = Y(b);
    const cx = X(c);
    const cy = Y(c);
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (det === 0) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 0.5));
    const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx) - 0.5));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy) - 0.5));
    const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy) - 0.5));
    const eps = -1e-6;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det;
        const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < eps || l2 < eps || l3 < eps) continue;
        data[y * w + x] = l1 * heights[a]! + l2 * heights[b]! + l3 * heights[c]!;
      }
  }
  // Cells no triangle centre covered (slivers at the edges): take a neighbour's height.
  for (let pass = 0; pass < 2; pass++)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!Number.isNaN(data[y * w + x]!)) continue;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = data[ny * w + nx]!;
          if (!Number.isNaN(n)) {
            data[y * w + x] = n;
            break;
          }
        }
      }
  return { bounds, w, h, data };
}

/**
 * Joins fields of equal size laid out in a `cols` x `rows` block (row 0 north) into one; a
 * missing field (outside the data) is left unknown.
 */
export function mosaic(
  parts: Array<HeightField | null>,
  cols: number,
  rows: number,
  bounds: GeoBounds,
  w: number,
  h: number,
): HeightField {
  const W = cols * w;
  const H = rows * h;
  const data = new Float32Array(W * H).fill(NaN);
  parts.forEach((p, i) => {
    if (!p) return;
    const ox = (i % cols) * w;
    const oy = Math.floor(i / cols) * h;
    for (let y = 0; y < h; y++) data.set(p.data.subarray(y * w, y * w + w), (oy + y) * W + ox);
  });
  return { bounds, w: W, h: H, data };
}

/** Bilinear height at lon/lat, NaN outside the field or where unknown. */
export function heightAt(f: HeightField, lon: number, lat: number): number {
  const b = f.bounds;
  const fx = ((lon - b.west) / (b.east - b.west)) * f.w - 0.5;
  const fy = ((b.north - lat) / (b.north - b.south)) * f.h - 0.5;
  if (fx < -0.5 || fy < -0.5 || fx > f.w - 0.5 || fy > f.h - 0.5) return NaN;
  const x0 = Math.max(0, Math.min(f.w - 2, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(f.h - 2, Math.floor(fy)));
  const tx = Math.min(1, Math.max(0, fx - x0));
  const ty = Math.min(1, Math.max(0, fy - y0));
  const d = f.data;
  const i = y0 * f.w + x0;
  const a = d[i]! * (1 - tx) + d[i + 1]! * tx;
  const c = d[i + f.w]! * (1 - tx) + d[i + f.w + 1]! * tx;
  return a * (1 - ty) + c * ty;
}

export interface HorizonOptions {
  /** The tile. */
  bounds: GeoBounds;
  /** Points per side of the horizon grid (corners included). */
  size: number;
  /** The tile's own heights (fine). */
  near: HeightField;
  /** Heights of the surroundings (coarse, larger than the tile), if any. */
  far?: HeightField;
  /** How far the march reaches, metres. */
  reach?: number;
}

/**
 * Horizon angles over the tile: (2 * size) x size RGBA8 texels, the left half holding the
 * directions N, NE, E, SE in R, G, B, A and the right half S, SW, W, NW. Angles in degrees
 * above the horizontal (Earth's curvature included) times HORIZON_STEPS_PER_DEG.
 */
export function horizonMap(o: HorizonOptions): Uint8Array {
  const { bounds: b, size, near, far } = o;
  const reach = o.reach ?? 20_000;
  const lat0 = (b.north + b.south) / 2;
  const mLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  /** A field in cell coordinates: cells per metre east and north, and the sampler. */
  const prepare = (f: HeightField) => {
    const fb = f.bounds;
    const perEast = f.w / ((fb.east - fb.west) * mLon);
    const perNorth = f.h / ((fb.north - fb.south) * M_PER_DEG_LAT);
    const cx = (lon: number) => ((lon - fb.west) / (fb.east - fb.west)) * f.w - 0.5;
    const cy = (lat: number) => ((fb.north - lat) / (fb.north - fb.south)) * f.h - 0.5;
    const w = f.w;
    const d = f.data;
    const maxX = f.w - 1;
    const maxY = f.h - 1;
    // Bilinear, NaN outside: the march stops at the field's edge.
    const at = (x: number, y: number) => {
      if (x < -0.5 || y < -0.5 || x > maxX + 0.5 || y > maxY + 0.5) return NaN;
      const xc = x < 0 ? 0 : x > maxX ? maxX : x;
      const yc = y < 0 ? 0 : y > maxY ? maxY : y;
      let x0 = Math.floor(xc);
      let y0 = Math.floor(yc);
      if (x0 >= maxX) x0 = maxX - 1;
      if (y0 >= maxY) y0 = maxY - 1;
      const tx = xc - x0;
      const ty = yc - y0;
      const i = y0 * w + x0;
      const a = d[i]! + (d[i + 1]! - d[i]!) * tx;
      const c = d[i + w]! + (d[i + w + 1]! - d[i + w]!) * tx;
      return a + (c - a) * ty;
    };
    return { perEast, perNorth, cx, cy, at, cell: 1 / Math.max(perEast, perNorth) };
  };
  const N = prepare(near);
  const Fr = far ? prepare(far) : undefined;
  const farCell = Fr ? Math.max(1 / Fr.perEast, 1 / Fr.perNorth) : 0;
  const out = new Uint8Array(size * 2 * size * 4);
  const dirE = Array.from({ length: HORIZON_DIRS }, (_, k) =>
    Math.sin((k * 2 * Math.PI) / HORIZON_DIRS),
  );
  const dirN = Array.from({ length: HORIZON_DIRS }, (_, k) =>
    Math.cos((k * 2 * Math.PI) / HORIZON_DIRS),
  );
  const k2R = 1 / (2 * EARTH_RADIUS);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const lon = b.west + (i / (size - 1)) * (b.east - b.west);
      const lat = b.north - (j / (size - 1)) * (b.north - b.south);
      const nx = N.cx(lon);
      const ny = N.cy(lat);
      const h0 = N.at(nx, ny);
      if (Number.isNaN(h0)) continue;
      const fx = Fr ? Fr.cx(lon) : 0;
      const fy = Fr ? Fr.cy(lat) : 0;
      const farBias = Fr ? Math.max(0, (Fr.at(fx, fy) || h0) - h0) : 0;
      for (let k = 0; k < HORIZON_DIRS; k++) {
        const e = dirE[k]!;
        const n = dirN[k]!;
        let best = 0;
        // Near: the tile's own heights, in steps of its cells.
        let d = N.cell;
        let step = N.cell;
        const sxN = e * N.perEast;
        const syN = -n * N.perNorth;
        for (let s = 0; s < 32 && d < reach; s++) {
          const h = N.at(nx + sxN * d, ny + syN * d);
          if (Number.isNaN(h)) break;
          const t = (h - h0 - d * d * k2R) / d;
          if (t > best) best = t;
          d += step;
          if (s > 8) step *= 1.15;
        }
        if (Fr) {
          // Far: the surroundings, from a few coarse cells out (closer in, the coarse field is
          // too smooth to tell a valley floor from its slopes).
          const sxF = e * Fr.perEast;
          const syF = -n * Fr.perNorth;
          d = Math.max(d, 2.5 * farCell);
          step = farCell * 0.75;
          while (d < reach) {
            const h = Fr.at(fx + sxF * d, fy + syF * d);
            if (Number.isNaN(h)) break;
            const base = farBias > 0 ? h0 + farBias * Math.exp(-d / (4 * farCell)) : h0;
            const t = (h - base - d * d * k2R) / d;
            if (t > best) best = t;
            d += step;
            step *= 1.18;
          }
        }
        const deg = (Math.atan(best) * 180) / Math.PI;
        const half = k >> 2;
        out[(j * size * 2 + half * size + i) * 4 + (k & 3)] = Math.min(
          255,
          Math.round(deg * HORIZON_STEPS_PER_DEG),
        );
      }
    }
  return out;
}

/** Fraction of the sky seen from a horizontal surface with these horizon angles (degrees). */
export function skyView(angles: ArrayLike<number>): number {
  let s = 0;
  for (let k = 0; k < angles.length; k++) s += Math.sin((angles[k]! * Math.PI) / 180) ** 2;
  return 1 - s / angles.length;
}

/**
 * Weights of the eight directions for a light at `azimuth` (radians clockwise from north): the
 * two directions either side share the light linearly. Same as the shader uses.
 */
export function directionWeights(azimuth: number, out = new Array<number>(HORIZON_DIRS)) {
  const t =
    ((((azimuth / (2 * Math.PI)) * HORIZON_DIRS) % HORIZON_DIRS) + HORIZON_DIRS) % HORIZON_DIRS;
  const k0 = Math.floor(t);
  const f = t - k0;
  out.fill(0);
  out[k0] = 1 - f;
  out[(k0 + 1) % HORIZON_DIRS] = f;
  return out;
}
