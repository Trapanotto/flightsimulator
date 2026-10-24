import { QM_MAX, type QuantizedMesh } from './quantizedMesh';

/** Samples per side of the per-tile height grid used for collision and AGL queries. */
export const GRID = 33;

/**
 * Rasterises the tile's triangles into a GRID x GRID height grid (metres).
 * Row 0 is the south edge, column 0 the west edge. Cost is O(triangles + cells).
 */
export function buildHeightGrid(qm: QuantizedMesh): Float32Array {
  const grid = new Float32Array(GRID * GRID).fill(NaN);
  const scale = (GRID - 1) / QM_MAX;
  const hScale = (qm.maxHeight - qm.minHeight) / QM_MAX;
  const idx = qm.indices;

  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]!;
    const b = idx[t + 1]!;
    const c = idx[t + 2]!;
    const ax = qm.u[a]! * scale;
    const ay = qm.v[a]! * scale;
    const bx = qm.u[b]! * scale;
    const by = qm.v[b]! * scale;
    const cx = qm.u[c]! * scale;
    const cy = qm.v[c]! * scale;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (det === 0) continue;
    const ha = qm.minHeight + qm.h[a]! * hScale;
    const hb = qm.minHeight + qm.h[b]! * hScale;
    const hc = qm.minHeight + qm.h[c]! * hScale;

    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx)));
    const x1 = Math.min(GRID - 1, Math.floor(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy)));
    const y1 = Math.min(GRID - 1, Math.floor(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
        const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
        const l3 = 1 - l1 - l2;
        const eps = -1e-6;
        if (l1 >= eps && l2 >= eps && l3 >= eps) {
          grid[y * GRID + x] = l1 * ha + l2 * hb + l3 * hc;
        }
      }
    }
  }
  // Fill any cell a degenerate triangle missed with the tile's mid height.
  const mid = (qm.minHeight + qm.maxHeight) / 2;
  for (let i = 0; i < grid.length; i++) if (Number.isNaN(grid[i]!)) grid[i] = mid;
  return grid;
}

/** Bilinear height lookup; u, v in 0..1 (west->east, south->north). */
export function sampleHeightGrid(grid: Float32Array, u: number, v: number): number {
  const fx = Math.min(Math.max(u, 0), 1) * (GRID - 1);
  const fy = Math.min(Math.max(v, 0), 1) * (GRID - 1);
  const x0 = Math.min(Math.floor(fx), GRID - 2);
  const y0 = Math.min(Math.floor(fy), GRID - 2);
  const tx = fx - x0;
  const ty = fy - y0;
  const i = y0 * GRID + x0;
  const h00 = grid[i]!;
  const h10 = grid[i + 1]!;
  const h01 = grid[i + GRID]!;
  const h11 = grid[i + GRID + 1]!;
  return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
}
