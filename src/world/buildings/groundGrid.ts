import { type LocalFrame, geodeticToEcef } from '@geo';
import { BUILDING_FLOATS, FLAG_GROUND } from './mesh';

/**
 * The terrain under a building tile, sampled on a regular grid in the tile's frame (heights as
 * tile-frame y). The shader stands every building on it, so the buildings agree with the
 * terrain as drawn (also where it is still coarse) and are re-seated by refilling this grid
 * when finer terrain arrives. Filling is incremental, within a time budget per frame.
 */
export class GroundGrid {
  readonly nx: number;
  readonly nz: number;
  readonly x0: number;
  readonly z0: number;
  readonly dx: number;
  readonly dz: number;
  /** Tile-frame heights, row-major (z rows). */
  readonly values: Float32Array;
  /** The next fill; swapped in when complete so a half-filled grid is never shown. */
  private readonly next: Float32Array;
  private readonly lon: Float64Array;
  private readonly lat: Float64Array;
  private cursor = 0;
  private missing = 0;
  /** True once the grid has been filled completely at least once. */
  ready = false;
  /** A fill is under way (or wanted). */
  dirty = true;
  min = 0;
  max = 0;

  constructor(
    private readonly frame: LocalFrame,
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
    step: number,
  ) {
    // One sample beyond the extent on each side: the bilinear lookup never clamps at an edge.
    const pad = step * 0.5;
    minX -= pad;
    maxX += pad;
    minZ -= pad;
    maxZ += pad;
    this.nx = Math.min(96, Math.max(2, Math.ceil((maxX - minX) / step) + 1));
    this.nz = Math.min(96, Math.max(2, Math.ceil((maxZ - minZ) / step) + 1));
    this.x0 = minX;
    this.z0 = minZ;
    this.dx = (maxX - minX) / (this.nx - 1);
    this.dz = (maxZ - minZ) / (this.nz - 1);
    const n = this.nx * this.nz;
    this.values = new Float32Array(n);
    this.next = new Float32Array(n);
    this.lon = new Float64Array(n);
    this.lat = new Float64Array(n);
    const g = { lon: 0, lat: 0, h: 0 };
    for (let j = 0; j < this.nz; j++)
      for (let i = 0; i < this.nx; i++) {
        frame.toGeodetic({ x: this.x0 + i * this.dx, y: 0, z: this.z0 + j * this.dz }, g);
        this.lon[j * this.nx + i] = g.lon;
        this.lat[j * this.nx + i] = g.lat;
      }
  }

  get size() {
    return this.nx * this.nz;
  }

  /** Bilinear height at tile-frame x/z (clamped to the grid). */
  sample(x: number, z: number): number {
    const fx = Math.min(Math.max((x - this.x0) / this.dx, 0), this.nx - 1);
    const fz = Math.min(Math.max((z - this.z0) / this.dz, 0), this.nz - 1);
    const i = Math.min(Math.floor(fx), this.nx - 2);
    const j = Math.min(Math.floor(fz), this.nz - 2);
    const tx = fx - i;
    const tz = fz - j;
    const v = this.values;
    const k = j * this.nx + i;
    const a = v[k]! + (v[k + 1]! - v[k]!) * tx;
    const b = v[k + this.nx]! + (v[k + this.nx + 1]! - v[k + this.nx]!) * tx;
    return a + (b - a) * tz;
  }

  /**
   * Per-vertex offsets that stand the buildings on this ground: each building is raised by
   * the ground height at its anchor; vertices on the ground (walls' feet) go at least 0.4 m
   * below the terrain right under them, so walls on a slope reach into it instead of
   * floating.
   */
  lift(positions: Float32Array, meta: Uint16Array, buildings: Float32Array, out: Float32Array) {
    const n = positions.length / 3;
    let lastBuilding = -1;
    let gA = 0;
    for (let i = 0; i < n; i++) {
      const b = meta[2 * i]!;
      if (b !== lastBuilding) {
        lastBuilding = b;
        gA = this.sample(buildings[b * BUILDING_FLOATS]!, buildings[b * BUILDING_FLOATS + 1]!);
      }
      if (meta[2 * i + 1]! & FLAG_GROUND) {
        const y = positions[3 * i + 1]!;
        const own = this.sample(positions[3 * i]!, positions[3 * i + 2]!) - 0.4;
        out[i] = Math.min(y + gA, own) - y;
      } else out[i] = gA;
    }
  }

  /** Starts a new fill (the terrain changed). The old values stay in use until it is done. */
  invalidate() {
    this.dirty = true;
  }

  /**
   * Samples up to `maxSamples` points. Returns how many were taken and whether the grid was
   * completed (values updated) by this call.
   */
  fill(
    groundHeight: (lon: number, lat: number) => number | undefined,
    maxSamples: number,
  ): { samples: number; completed: boolean } {
    if (!this.dirty) return { samples: 0, completed: false };
    const n = this.size;
    const up = this.frame.dirToEcef({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 });
    const o = this.frame.originEcef({ x: 0, y: 0, z: 0 });
    const e = { x: 0, y: 0, z: 0 };
    let taken = 0;
    while (this.cursor < n && taken < maxSamples) {
      const k = this.cursor++;
      taken++;
      const h = groundHeight(this.lon[k]!, this.lat[k]!);
      if (h === undefined) {
        this.next[k] = NaN;
        this.missing++;
        continue;
      }
      geodeticToEcef(this.lon[k]!, this.lat[k]!, h, e);
      this.next[k] = (e.x - o.x) * up.x + (e.y - o.y) * up.y + (e.z - o.z) * up.z;
    }
    if (this.cursor < n) return { samples: taken, completed: false };
    this.cursor = 0;
    if (this.missing === n) {
      // Nothing under the tile yet: try again later.
      this.missing = 0;
      return { samples: taken, completed: false };
    }
    if (this.missing) fillGaps(this.next, this.nx, this.nz);
    this.missing = 0;
    this.values.set(this.next);
    let min = Infinity;
    let max = -Infinity;
    for (const v of this.values) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    this.min = min;
    this.max = max;
    this.ready = true;
    this.dirty = false;
    return { samples: taken, completed: true };
  }
}

/** Replaces NaN samples by the nearest known ones (row and column sweeps). */
export function fillGaps(v: Float32Array, nx: number, nz: number) {
  for (let pass = 0; pass < nx + nz; pass++) {
    let any = false;
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (!Number.isNaN(v[k]!)) continue;
        let s = 0;
        let c = 0;
        for (const [di, dj] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const a = i + di;
          const b = j + dj;
          if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
          const w = v[b * nx + a]!;
          if (!Number.isNaN(w)) {
            s += w;
            c++;
          }
        }
        if (c) v[k] = s / c;
        else any = true;
      }
    if (!any) return;
  }
}
