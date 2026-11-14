import { WGS84_A, WGS84_F } from '@geo';

const E2 = WGS84_F * (2 - WGS84_F);
const RAD = Math.PI / 180;

/**
 * Ground heights under a chunk on a regular grid in the chunk's own frame (x east, z south),
 * sampled from the terrain and interpolated for every tree. Querying the terrain once per tree
 * would cost tens of milliseconds per chunk; the grid costs a few and is re-sampled whenever
 * the terrain is refined.
 *
 * Grid points are placed with the ellipsoid's radii of curvature at the origin (and the
 * convergence of the meridians): within a chunk the error of that is a few centimetres.
 */
export class HeightGrid {
  readonly values: Float32Array;
  readonly lon: Float64Array;
  readonly lat: Float64Array;
  private readonly sx: number;
  private readonly sz: number;

  constructor(
    readonly n: number,
    readonly halfX: number,
    readonly halfZ: number,
    originLon: number,
    originLat: number,
  ) {
    this.values = new Float32Array(n * n);
    this.lon = new Float64Array(n * n);
    this.lat = new Float64Array(n * n);
    const s = Math.sin(originLat * RAD);
    const w = Math.sqrt(1 - E2 * s * s);
    const N = WGS84_A / w;
    const M = (WGS84_A * (1 - E2)) / (w * w * w);
    const degPerZ = -1 / (M * RAD);
    this.sx = (2 * halfX) / (n - 1);
    this.sz = (2 * halfZ) / (n - 1);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = -halfX + i * this.sx;
        const z = -halfZ + j * this.sz;
        const lat = originLat + z * degPerZ;
        // East-west scale at the point's own latitude: the meridians converge northwards.
        this.lon[j * n + i] = originLon + x / (N * Math.cos(lat * RAD) * RAD);
        this.lat[j * n + i] = lat;
      }
  }

  /** Bilinear height at x, z (clamped to the grid). */
  sample(x: number, z: number): number {
    const n = this.n;
    const fx = Math.min(n - 1.0001, Math.max(0, (x + this.halfX) / this.sx));
    const fz = Math.min(n - 1.0001, Math.max(0, (z + this.halfZ) / this.sz));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const v = this.values;
    const k = j * n + i;
    const a = v[k]! + (v[k + 1]! - v[k]!) * tx;
    const b = v[k + n]! + (v[k + n + 1]! - v[k + n]!) * tx;
    return a + (b - a) * tz;
  }
}

/**
 * Fills grid points the terrain could not answer (NaN) from their nearest answered neighbour
 * along the rows, then the columns. Returns false if no point was answered at all.
 */
export function fillGaps(values: Float32Array, n: number): boolean {
  let any = false;
  for (let k = 0; k < values.length; k++) if (!Number.isNaN(values[k]!)) any = true;
  if (!any) return false;
  const pass = (get: (a: number, b: number) => number) => {
    for (let a = 0; a < n; a++) {
      let last = NaN;
      for (let b = 0; b < n; b++) {
        const k = get(a, b);
        if (Number.isNaN(values[k]!)) {
          if (!Number.isNaN(last)) values[k] = last;
        } else last = values[k]!;
      }
      last = NaN;
      for (let b = n - 1; b >= 0; b--) {
        const k = get(a, b);
        if (Number.isNaN(values[k]!)) {
          if (!Number.isNaN(last)) values[k] = last;
        } else last = values[k]!;
      }
    }
  };
  pass((a, b) => a * n + b);
  pass((a, b) => b * n + a);
  return true;
}
