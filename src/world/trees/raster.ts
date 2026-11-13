/**
 * Plain-TypeScript polygon and line rasterisation for the tree scatter. The worker could draw
 * with an OffscreenCanvas, but canvas antialiasing differs between browsers and GPUs, and the
 * forest must come out the same for every player: so the coverage is computed here, exactly.
 */

export interface Pt {
  x: number;
  y: number;
}

/**
 * Even-odd point-in-polygon over all rings of a feature: holes (and islands in holes) work
 * whatever their winding, the same rule the vector tile renderers and our raster use.
 */
export function pointInRings(rings: ReadonlyArray<ReadonlyArray<Pt>>, x: number, y: number) {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = ring[i]!;
      const b = ring[j]!;
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x)
        inside = !inside;
    }
  }
  return inside;
}

/**
 * A square grid of cells over a vector tile: cell (i, j) covers tile units
 * [i, i + 1) * cell x [j, j + 1) * cell, row 0 at the top (vector tile y grows downwards).
 */
export class Grid {
  readonly data: Uint8Array;
  readonly cell: number;

  constructor(
    readonly size: number,
    readonly extent: number,
  ) {
    this.data = new Uint8Array(size * size);
    this.cell = extent / size;
  }

  at(x: number, y: number): number {
    const i = Math.floor(x / this.cell);
    const j = Math.floor(y / this.cell);
    if (i < 0 || j < 0 || i >= this.size || j >= this.size) return 0;
    return this.data[j * this.size + i]!;
  }

  /**
   * Sets every cell whose centre lies inside the rings (even-odd) to `value`. Scanline fill:
   * per cell row, the crossings of the row's centre line with all edges, sorted, fill in pairs.
   */
  fillRings(rings: ReadonlyArray<ReadonlyArray<Pt>>, value: number) {
    const { size, cell, data } = this;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const r of rings)
      for (const p of r) {
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    const j0 = Math.max(0, Math.floor(minY / cell - 0.5));
    const j1 = Math.min(size - 1, Math.ceil(maxY / cell - 0.5));
    const xs: number[] = [];
    for (let j = j0; j <= j1; j++) {
      const y = (j + 0.5) * cell;
      xs.length = 0;
      for (const ring of rings) {
        const n = ring.length;
        for (let i = 0, k = n - 1; i < n; k = i++) {
          const a = ring[i]!;
          const b = ring[k]!;
          if (a.y > y !== b.y > y) xs.push(((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x);
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        // Cells whose centre x lies in [xa, xb).
        const i0 = Math.max(0, Math.ceil(xs[k]! / cell - 0.5));
        const i1 = Math.min(size - 1, Math.ceil(xs[k + 1]! / cell - 0.5) - 1);
        const row = j * size;
        for (let i = i0; i <= i1; i++) data[row + i] = value;
      }
    }
  }

  /** Sets every cell within `radius` (tile units) of the polyline to `value`. */
  strokeLine(line: ReadonlyArray<Pt>, radius: number, value: number) {
    const { size, cell, data } = this;
    for (let s = 0; s + 1 < line.length; s++) {
      const a = line[s]!;
      const b = line[s + 1]!;
      const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - radius) / cell));
      const i1 = Math.min(size - 1, Math.floor((Math.max(a.x, b.x) + radius) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - radius) / cell));
      const j1 = Math.min(size - 1, Math.floor((Math.max(a.y, b.y) + radius) / cell));
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy || 1;
      const r2 = radius * radius;
      for (let j = j0; j <= j1; j++) {
        const py = (j + 0.5) * cell;
        for (let i = i0; i <= i1; i++) {
          const px = (i + 0.5) * cell;
          const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
          const ex = a.x + t * dx - px;
          const ey = a.y + t * dy - py;
          if (ex * ex + ey * ey <= r2) data[j * size + i] = value;
        }
      }
    }
  }
}

/**
 * Distance in cells from every non-zero cell of `grid` to the nearest zero cell (3-4 chamfer,
 * within about 8 % of the true distance), capped at `cap` cells. Cells outside the grid do not
 * count as empty: a forest cut by the tile edge continues into the next tile and must not get
 * an edge there.
 */
export function distanceToEmpty(grid: Grid, cap: number): Uint16Array {
  const n = grid.size;
  const inf = Math.min(65535, cap * 3);
  const d = new Uint16Array(n * n);
  for (let k = 0; k < n * n; k++) d[k] = grid.data[k] ? inf : 0;
  const relax = (k: number, other: number, cost: number) => {
    const v = d[other]! + cost;
    if (v < d[k]!) d[k] = v;
  };
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (!d[k]) continue;
      if (i > 0) relax(k, k - 1, 3);
      if (j > 0) {
        relax(k, k - n, 3);
        if (i > 0) relax(k, k - n - 1, 4);
        if (i < n - 1) relax(k, k - n + 1, 4);
      }
    }
  for (let j = n - 1; j >= 0; j--)
    for (let i = n - 1; i >= 0; i--) {
      const k = j * n + i;
      if (!d[k]) continue;
      if (i < n - 1) relax(k, k + 1, 3);
      if (j < n - 1) {
        relax(k, k + n, 3);
        if (i < n - 1) relax(k, k + n + 1, 4);
        if (i > 0) relax(k, k + n - 1, 4);
      }
    }
  // Back to cells (the chamfer counts 3 per straight step).
  for (let k = 0; k < n * n; k++) d[k] = Math.min(cap, Math.round(d[k]! / 3));
  return d;
}
