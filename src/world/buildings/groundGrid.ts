import { type LocalFrame, geodeticToEcef } from '@geo';
import { type MeshData, buildingOf, isGround, vertexPosition } from './mesh';

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
  /**
   * The fill under way, swapped in when complete so a half-filled grid is never shown. Only
   * held while filling: most tiles sit still most of the time.
   */
  private next?: Float32Array;
  /**
   * Longitude and latitude of the grid's four corners (west-north, east-north, west-south,
   * east-south in the tile frame). Over a tile of 1.7 km, the samples in between are
   * bilinear in these to a few centimetres, so they need not be stored per sample.
   */
  private readonly corners: Float64Array;
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
    this.values = new Float32Array(this.nx * this.nz);
    this.corners = new Float64Array(8);
    const g = { lon: 0, lat: 0, h: 0 };
    [
      [minX, minZ],
      [maxX, minZ],
      [minX, maxZ],
      [maxX, maxZ],
    ].forEach(([x, z], k) => {
      frame.toGeodetic({ x: x!, y: 0, z: z! }, g);
      this.corners[2 * k] = g.lon;
      this.corners[2 * k + 1] = g.lat;
    });
  }

  get size() {
    return this.nx * this.nz;
  }

  /** Bytes held on the CPU. */
  get bytes() {
    return this.values.byteLength + (this.next?.byteLength ?? 0) + this.corners.byteLength;
  }

  /** Longitude and latitude of sample k. */
  samplePoint(k: number, out = { lon: 0, lat: 0 }): { lon: number; lat: number } {
    const c = this.corners;
    const u = (k % this.nx) / (this.nx - 1);
    const v = Math.floor(k / this.nx) / (this.nz - 1);
    const w00 = (1 - u) * (1 - v);
    const w10 = u * (1 - v);
    const w01 = (1 - u) * v;
    const w11 = u * v;
    out.lon = c[0]! * w00 + c[2]! * w10 + c[4]! * w01 + c[6]! * w11;
    out.lat = c[1]! * w00 + c[3]! * w10 + c[5]! * w01 + c[7]! * w11;
    return out;
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
  lift(m: MeshData, out: Float32Array, start = 0, end = m.vertexCount) {
    if (start >= end) return;
    const p = { x: 0, y: 0, z: 0 };
    let b = buildingOf(m, start);
    let next = m.starts[b + 1]!;
    let gA = this.sample(m.anchors[2 * b]!, m.anchors[2 * b + 1]!);
    for (let i = start; i < end; i++) {
      while (i >= next) {
        b++;
        next = m.starts[b + 1]!;
        gA = this.sample(m.anchors[2 * b]!, m.anchors[2 * b + 1]!);
      }
      if (isGround(m, i)) {
        vertexPosition(m, i, p);
        const own = this.sample(p.x, p.z) - 0.4;
        out[i] = Math.min(p.y + gA, own) - p.y;
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
    const next = (this.next ??= new Float32Array(n));
    const up = this.frame.dirToEcef({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 });
    const o = this.frame.originEcef({ x: 0, y: 0, z: 0 });
    const e = { x: 0, y: 0, z: 0 };
    const ll = { lon: 0, lat: 0 };
    let taken = 0;
    while (this.cursor < n && taken < maxSamples) {
      const k = this.cursor++;
      taken++;
      this.samplePoint(k, ll);
      const h = groundHeight(ll.lon, ll.lat);
      if (h === undefined) {
        next[k] = NaN;
        this.missing++;
        continue;
      }
      geodeticToEcef(ll.lon, ll.lat, h, e);
      next[k] = (e.x - o.x) * up.x + (e.y - o.y) * up.y + (e.z - o.z) * up.z;
    }
    if (this.cursor < n) return { samples: taken, completed: false };
    this.cursor = 0;
    if (this.missing === n) {
      // Nothing under the tile yet: try again later.
      this.missing = 0;
      return { samples: taken, completed: false };
    }
    if (this.missing) fillGaps(next, this.nx, this.nz);
    this.missing = 0;
    this.values.set(next);
    this.next = undefined;
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
