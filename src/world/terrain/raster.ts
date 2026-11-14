/**
 * Small raster tools for baking tile data in the worker: polygon filling, energy-conserving
 * splats, blurs and resampling on Float32 grids. Pure functions, tested in Node.
 *
 * A grid is row-major, `w` by `h` cells, cell (x, y) covering [x, x+1) x [y, y+1); a point at
 * (x + 0.5, y + 0.5) is the centre of a cell.
 */

export interface Grid {
  w: number;
  h: number;
  data: Float32Array;
}

export function grid(w: number, h: number): Grid {
  return { w, h, data: new Float32Array(w * h) };
}

/**
 * Fills polygons (rings of x, y pairs in cell units) with `value` by the even-odd rule, sampled
 * at cell centres: holes stay empty. Cells already higher keep their value (max blending).
 */
export function fillPolygon(g: Grid, rings: ArrayLike<number>[], value = 1) {
  // Edges bucketed by the first row whose centre they cross, then swept down the rows: the
  // cost grows with edges plus crossings, not with edges times rows (towns have thousands
  // of vertices).
  const buckets = new Map<number, number[]>();
  for (const r of rings) {
    const n = r.length >> 1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      let ax = r[i * 2]!;
      let ay = r[i * 2 + 1]!;
      let bx = r[j * 2]!;
      let by = r[j * 2 + 1]!;
      if (ay === by) continue;
      if (ay > by) [ax, ay, bx, by] = [bx, by, ax, ay];
      // Rows whose centre y + 0.5 lies in [ay, by).
      const first = Math.max(0, Math.ceil(ay - 0.5));
      const last = Math.min(g.h - 1, Math.ceil(by - 0.5) - 1);
      if (first > last) continue;
      let list = buckets.get(first);
      if (!list) buckets.set(first, (list = []));
      list.push(ax, ay, (bx - ax) / (by - ay), last);
    }
  }
  if (buckets.size === 0) return;
  const startRow = Math.min(...buckets.keys());
  const lastStart = Math.max(...buckets.keys());
  let active: number[] = [];
  const xs: number[] = [];
  for (let y = startRow; y < g.h; y++) {
    const fresh = buckets.get(y);
    if (fresh) active = active.concat(fresh);
    if (active.length === 0) {
      if (y > lastStart) break;
      continue;
    }
    const cy = y + 0.5;
    xs.length = 0;
    const keep: number[] = [];
    for (let e = 0; e < active.length; e += 4) {
      xs.push(active[e]! + (cy - active[e + 1]!) * active[e + 2]!);
      if (active[e + 3]! > y) keep.push(active[e]!, active[e + 1]!, active[e + 2]!, active[e + 3]!);
    }
    active = keep;
    xs.sort((a, b) => a - b);
    const row = y * g.w;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k]! - 0.5));
      const xb = Math.min(g.w - 1, Math.ceil(xs[k + 1]! - 0.5) - 1);
      for (let x = xa; x <= xb; x++) if (g.data[row + x]! < value) g.data[row + x] = value;
    }
  }
}

/**
 * Adds `amount` at the point (x, y) (cell units) spread bilinearly over the four nearest cells:
 * the sum over the grid grows by exactly `amount` when all four cells lie inside, and the
 * centre of mass stays at the point.
 */
export function splat(g: Grid, x: number, y: number, amount: number) {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const add = (cx: number, cy: number, w: number) => {
    if (cx < 0 || cy < 0 || cx >= g.w || cy >= g.h || w === 0) return;
    const i = cy * g.w + cx;
    g.data[i] = g.data[i]! + amount * w;
  };
  add(x0, y0, (1 - tx) * (1 - ty));
  add(x0 + 1, y0, tx * (1 - ty));
  add(x0, y0 + 1, (1 - tx) * ty);
  add(x0 + 1, y0 + 1, tx * ty);
}

/** One box blur pass of half-width r along x then y (edges clamp: sums stay put inside). */
function boxPass(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const tmp = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += x >= 0 && x < w ? src[row + x]! : 0;
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / n;
      const out = x - r;
      const inn = x + r + 1;
      if (out >= 0) acc -= src[row + out]!;
      if (inn < w) acc += src[row + inn]!;
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += y >= 0 && y < h ? tmp[y * w + x]! : 0;
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc / n;
      const out = y - r;
      const inn = y + r + 1;
      if (out >= 0) acc -= tmp[out * w + x]!;
      if (inn < h) acc += tmp[inn * w + x]!;
    }
  }
}

/**
 * Approximate Gaussian blur of standard deviation `sigma` cells by three box passes (each
 * conserves the sum away from the edges). Sigmas below half a cell leave the grid as it is.
 */
export function blur(g: Grid, sigma: number) {
  if (sigma < 0.5) return;
  // Three boxes of width n have variance 3 (n^2 - 1) / 12.
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  boxPass(g.data, g.data, g.w, g.h, r);
  boxPass(g.data, g.data, g.w, g.h, r);
  boxPass(g.data, g.data, g.w, g.h, r);
}

/** Bilinear sample of a grid at (x, y) in cell units (cell centres at +0.5); edges clamp. */
export function sample(g: Grid, x: number, y: number): number {
  const fx = Math.min(Math.max(x - 0.5, 0), g.w - 1);
  const fy = Math.min(Math.max(y - 0.5, 0), g.h - 1);
  const x0 = Math.min(Math.floor(fx), g.w - 2 < 0 ? 0 : g.w - 2);
  const y0 = Math.min(Math.floor(fy), g.h - 2 < 0 ? 0 : g.h - 2);
  const tx = g.w > 1 ? fx - x0 : 0;
  const ty = g.h > 1 ? fy - y0 : 0;
  const x1 = Math.min(x0 + 1, g.w - 1);
  const y1 = Math.min(y0 + 1, g.h - 1);
  const d = g.data;
  const a = d[y0 * g.w + x0]! * (1 - tx) + d[y0 * g.w + x1]! * tx;
  const b = d[y1 * g.w + x0]! * (1 - tx) + d[y1 * g.w + x1]! * tx;
  return a * (1 - ty) + b * ty;
}

/**
 * Mip chain of a square 8-bit image of `channels` channels whose channels are stored with a square-root encoding
 * scaled per channel (v = sqrt(linear / scale)): each level averages the linear values of the
 * one above, so a bright point keeps its energy when seen from far away. Channels listed in
 * `linear` are averaged as they are instead (plain data). Level 0 is the input itself.
 */
export function byteMips(
  level0: Uint8Array,
  size: number,
  channels: number,
  linear: readonly boolean[] = [],
): Array<{ data: Uint8Array; width: number; height: number }> {
  const C = channels;
  const levels = [{ data: level0, width: size, height: size }];
  let src = level0;
  let s = size;
  const decode = new Float32Array(256);
  for (let i = 0; i < 256; i++) decode[i] = (i / 255) ** 2;
  while (s > 1) {
    const n = s >> 1;
    const dst = new Uint8Array(n * n * C);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const a = (2 * y * s + 2 * x) * C;
        const b = a + C;
        const c = a + s * C;
        const d = c + C;
        for (let k = 0; k < C; k++) {
          let v: number;
          if (linear[k]) v = (src[a + k]! + src[b + k]! + src[c + k]! + src[d + k]!) / 4;
          else {
            const m =
              (decode[src[a + k]!]! +
                decode[src[b + k]!]! +
                decode[src[c + k]!]! +
                decode[src[d + k]!]!) /
              4;
            v = Math.sqrt(m) * 255;
          }
          dst[(y * n + x) * C + k] = Math.round(v);
        }
      }
    levels.push({ data: dst, width: n, height: n });
    src = dst;
    s = n;
  }
  return levels;
}

/**
 * A grid laid over a tile's pixels with a margin around it: tile pixel (x, y) lies at cell
 * ((x + margin) / cell, (y + margin) / cell).
 */
export interface Field {
  g: Grid;
  margin: number;
  cell: number;
}

export function fieldAt(f: Field, x: number, y: number): number {
  return sample(f.g, (x + f.margin) / f.cell, (y + f.margin) / f.cell);
}

/**
 * Adds k times the field, sampled bilinearly at every texel centre, into `out` (size x size).
 * The same as fieldAt per texel, with the interpolation set up once per row and column.
 */
export function addField(f: Field, out: Float32Array, size: number, k = 1) {
  const g = f.g;
  const axis = (n: number) => {
    const i0 = new Int32Array(size);
    const i1 = new Int32Array(size);
    const t = new Float32Array(size);
    for (let x = 0; x < size; x++) {
      const c = Math.min(Math.max((x + 0.5 + f.margin) / f.cell - 0.5, 0), n - 1);
      const a = Math.min(Math.floor(c), Math.max(n - 2, 0));
      i0[x] = a;
      i1[x] = Math.min(a + 1, n - 1);
      t[x] = n > 1 ? c - a : 0;
    }
    return { i0, i1, t };
  };
  const X = axis(g.w);
  const Y = axis(g.h);
  const d = g.data;
  for (let y = 0; y < size; y++) {
    const r0 = Y.i0[y]! * g.w;
    const r1 = Y.i1[y]! * g.w;
    const ty = Y.t[y]!;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const a = X.i0[x]!;
      const b = X.i1[x]!;
      const tx = X.t[x]!;
      const top = d[r0 + a]! + (d[r0 + b]! - d[r0 + a]!) * tx;
      const bottom = d[r1 + a]! + (d[r1 + b]! - d[r1 + a]!) * tx;
      out[row + x] = out[row + x]! + k * (top + (bottom - top) * ty);
    }
  }
}
