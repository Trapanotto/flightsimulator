/**
 * The shape of the terrain at one length scale, as the air model needs it: smoothed height,
 * slope and curvature on a fixed lattice, cached, and interpolated bilinearly in between.
 *
 * Why a fixed lattice instead of a probe that follows the aircraft: every value depends only
 * on the place (and on what the terrain returned), never on where the aircraft was before, so
 * the air is the same whatever order it is asked in, and between lattice nodes it changes
 * smoothly (no steps, which would be felt as jolts). New terrain samples are only taken when
 * a node comes into reach for the first time: a few per lattice cell crossed.
 */

/** What the air model needs from the world: terrain height above sea level, metres. */
export interface AirTerrain {
  /** Undefined while the terrain there is not loaded; the terrain effects fade out there. */
  height(lon: number, lat: number): number | undefined;
}

/** Mean Earth radius (IUGG), metres per radian. */
const EARTH_RADIUS = 6_371_008.8;
const DEG = Math.PI / 180;

/**
 * Equirectangular projection around a fixed reference. Over Switzerland (±2° of latitude)
 * the east-west scale differs by up to 3 % from the true one; the fits correct their slopes
 * for it so gradients are in true metres.
 */
export class Projection {
  readonly mx: number;
  readonly my: number;
  readonly cosLat0: number;
  constructor(
    readonly lon0: number,
    readonly lat0: number,
  ) {
    this.cosLat0 = Math.cos(lat0 * DEG);
    this.my = EARTH_RADIUS * DEG;
    this.mx = this.my * this.cosLat0;
  }
  x(lon: number) {
    return (lon - this.lon0) * this.mx;
  }
  y(lat: number) {
    return (lat - this.lat0) * this.my;
  }
  lon(x: number) {
    return this.lon0 + x / this.mx;
  }
  lat(y: number) {
    return this.lat0 + y / this.my;
  }
}

/** Layout of one node's values. Heights are stored multiplied by the validity (see eval). */
export const F_H = 0; // terrain height at the node × validity
export const F_A = 1; // smoothed (fitted) height × validity
export const F_GX = 2; // slope east, rise over run
export const F_GY = 3; // slope north
export const F_XX = 4; // second derivatives, 1/m
export const F_YY = 5;
export const F_XY = 6;
export const F_R = 7; // rms of the terrain about the fitted surface, m (roughness)
export const F_V = 8; // validity 0..1: 0 where terrain is missing
export const NF = 9;

/** Seconds of simulated time before a missing terrain sample is asked for again. */
const REPROBE = 0.5;
/** Seconds over which a node's values move to new ones when the terrain changes. */
const BLEND = 3;

const EMPTY = 0;
const COMPLETE = 1;
const INCOMPLETE = 2;

export class TerrainField {
  /** Terrain samples taken so far (for tests and the cost budget). */
  probes = 0;
  private generation = 0;
  private readonly mask: number;
  private readonly size: number;
  private readonly keyI: Int32Array;
  private readonly keyJ: Int32Array;
  private readonly used: Uint8Array;
  private readonly raw: Float64Array;
  private readonly rawTime: Float64Array;
  private readonly rawGen: Int32Array;
  private readonly rawState: Uint8Array;
  private readonly fitNew: Float64Array;
  private readonly fitPrev: Float64Array;
  private readonly blendStart: Float64Array;
  private readonly fitTime: Float64Array;
  private readonly fitGen: Int32Array;
  private readonly fitState: Uint8Array;
  private readonly z = new Float64Array(9);

  /**
   * @param spacing lattice spacing and fit stencil spacing, metres: the fit at a node uses
   *   the 3 × 3 nodes around it, so it describes the terrain over twice this distance.
   * @param bits the cache holds 2^bits × 2^bits nodes, addressed toroidally, so any window of
   *   that many nodes never evicts itself.
   * @param meanRadius > 0: each node's height is the mean of five samples (centre and four at
   *   this distance), so a coarse lattice does not alias single peaks.
   */
  constructor(
    readonly spacing: number,
    private readonly bits: number,
    private readonly meanRadius: number,
    private readonly projection: Projection,
  ) {
    const side = 1 << bits;
    this.mask = side - 1;
    this.size = side * side;
    const n = this.size;
    this.keyI = new Int32Array(n);
    this.keyJ = new Int32Array(n);
    this.used = new Uint8Array(n);
    this.raw = new Float64Array(n);
    this.rawTime = new Float64Array(n);
    this.rawGen = new Int32Array(n);
    this.rawState = new Uint8Array(n);
    this.fitNew = new Float64Array(n * NF);
    this.fitPrev = new Float64Array(n * NF);
    this.blendStart = new Float64Array(n);
    this.fitTime = new Float64Array(n);
    this.fitGen = new Int32Array(n);
    this.fitState = new Uint8Array(n);
  }

  /** The terrain changed (finer data arrived): nodes are re-fitted as they are used and blend. */
  invalidate() {
    this.generation++;
  }

  /** Forgets everything (another terrain source). */
  clear() {
    this.used.fill(0);
    this.generation++;
  }

  private slot(i: number, j: number): number {
    const s = (i & this.mask) | ((j & this.mask) << this.bits);
    if (this.used[s] === 0 || this.keyI[s] !== i || this.keyJ[s] !== j) {
      this.used[s] = 1;
      this.keyI[s] = i;
      this.keyJ[s] = j;
      this.rawState[s] = EMPTY;
      this.fitState[s] = EMPTY;
    }
    return s;
  }

  private rawAt(i: number, j: number, t: number, terrain: AirTerrain): number {
    const s = this.slot(i, j);
    const stale =
      this.rawState[s] === EMPTY ||
      this.rawGen[s] !== this.generation ||
      (Number.isNaN(this.raw[s]!) && Math.abs(t - this.rawTime[s]!) >= REPROBE);
    if (stale) {
      const p = this.projection;
      const lon = p.lon(i * this.spacing);
      const lat = p.lat(j * this.spacing);
      let h: number;
      if (this.meanRadius > 0) {
        const dLon = this.meanRadius / (p.my * Math.cos(lat * DEG));
        const dLat = this.meanRadius / p.my;
        const h0 = terrain.height(lon, lat);
        const h1 = terrain.height(lon + dLon, lat);
        const h2 = terrain.height(lon - dLon, lat);
        const h3 = terrain.height(lon, lat + dLat);
        const h4 = terrain.height(lon, lat - dLat);
        this.probes += 5;
        h =
          h0 === undefined ||
          h1 === undefined ||
          h2 === undefined ||
          h3 === undefined ||
          h4 === undefined
            ? NaN
            : (h0 + h1 + h2 + h3 + h4) / 5;
      } else {
        const h0 = terrain.height(lon, lat);
        this.probes++;
        h = h0 === undefined ? NaN : h0;
      }
      this.raw[s] = h;
      this.rawTime[s] = t;
      this.rawGen[s] = this.generation;
      this.rawState[s] = COMPLETE;
    }
    return this.raw[s]!;
  }

  /** Blend factor of a node at time t (1 once settled). */
  private blendOf(s: number, t: number): number {
    const d = t - this.blendStart[s]!;
    if (d >= BLEND) return 1;
    if (d <= 0) return 0;
    const u = d / BLEND;
    return u * u * (3 - 2 * u);
  }

  /** Slot of node (i, j) with its fit up to date. */
  private node(i: number, j: number, t: number, terrain: AirTerrain): number {
    let s = this.slot(i, j);
    const state = this.fitState[s]!;
    if (
      state !== EMPTY &&
      this.fitGen[s] === this.generation &&
      !(state === INCOMPLETE && Math.abs(t - this.fitTime[s]!) >= REPROBE)
    )
      return s;

    const z = this.z;
    let missing = false;
    for (let b = -1, k = 0; b <= 1; b++)
      for (let a = -1; a <= 1; a++, k++) {
        const h = this.rawAt(i + a, j + b, t, terrain);
        z[k] = h;
        if (Number.isNaN(h)) missing = true;
      }
    // rawAt may not evict (i, j) inside a 3 × 3 window, but re-take the slot to be sure.
    s = this.slot(i, j);
    const o = s * NF;
    const next = this.fitPrev;
    if (state === EMPTY) {
      this.blendStart[s] = -Infinity;
    } else {
      // Freeze what the node shows now and move from there to the new values.
      const f = this.blendOf(s, t);
      for (let k = 0; k < NF; k++) {
        const pv = next[o + k]!;
        next[o + k] = pv + (this.fitNew[o + k]! - pv) * f;
      }
      this.blendStart[s] = t;
    }
    const out = this.fitNew;
    if (missing) {
      for (let k = 0; k < NF; k++) out[o + k] = 0;
      this.fitState[s] = INCOMPLETE;
    } else {
      this.fit(z, j * this.spacing, out, o);
      this.fitState[s] = COMPLETE;
    }
    if (state === EMPTY) for (let k = 0; k < NF; k++) next[o + k] = out[o + k]!;
    this.fitTime[s] = t;
    this.fitGen[s] = this.generation;
    return s;
  }

  /**
   * Least-squares quadratic surface through the 3 × 3 samples z (row by row, x fastest). On a
   * balanced grid the fit separates into column and row means, so it is closed-form.
   */
  private fit(z: Float64Array, y: number, out: Float64Array, o: number) {
    const s = this.spacing;
    const c0 = z[0]! + z[3]! + z[6]!; // x = -s
    const c1 = z[1]! + z[4]! + z[7]!;
    const c2 = z[2]! + z[5]! + z[8]!;
    const r0 = z[0]! + z[1]! + z[2]!; // y = -s
    const r1 = z[3]! + z[4]! + z[5]!;
    const r2 = z[6]! + z[7]! + z[8]!;
    const s2 = s * s;
    // Slopes and curvatures in projected metres; x is stretched by cos(lat0)/cos(lat).
    const k = this.projection.cosLat0 / Math.cos(this.projection.lat(y) * DEG);
    const gx = (c2 - c0) / (6 * s);
    const gy = (r2 - r0) / (6 * s);
    const hxx = (c2 + c0 - 2 * c1) / (3 * s2);
    const hyy = (r2 + r0 - 2 * r1) / (3 * s2);
    const hxy = (z[8]! - z[6]! - z[2]! + z[0]!) / (4 * s2);
    const mean = (c0 + c1 + c2) / 9;
    const a = mean - ((hxx + hyy) * s2) / 3;
    let rr = 0;
    for (let b = -1, n = 0; b <= 1; b++)
      for (let q = -1; q <= 1; q++, n++) {
        const x = q * s;
        const yy = b * s;
        const f = a + gx * x + gy * yy + 0.5 * hxx * x * x + 0.5 * hyy * yy * yy + hxy * x * yy;
        const d = z[n]! - f;
        rr += d * d;
      }
    out[o + F_H] = z[4]!;
    out[o + F_A] = a;
    out[o + F_GX] = gx * k;
    out[o + F_GY] = gy;
    out[o + F_XX] = hxx * k * k;
    out[o + F_YY] = hyy;
    out[o + F_XY] = hxy * k;
    out[o + F_R] = Math.sqrt(rr / 9);
    out[o + F_V] = 1;
  }

  /**
   * Values at projected (x, y), bilinear between the four surrounding nodes. Slopes,
   * curvatures and roughness fade to zero towards missing terrain; heights are returned
   * multiplied by the validity in out[F_V] (divide by it, when it is above zero, to get them).
   */
  eval(x: number, y: number, t: number, terrain: AirTerrain, out: Float64Array): Float64Array {
    const fx = x / this.spacing;
    const fy = y / this.spacing;
    const i0 = Math.floor(fx);
    const j0 = Math.floor(fy);
    const u = fx - i0;
    const v = fy - j0;
    for (let k = 0; k < NF; k++) out[k] = 0;
    this.accumulate(i0, j0, (1 - u) * (1 - v), t, terrain, out);
    this.accumulate(i0 + 1, j0, u * (1 - v), t, terrain, out);
    this.accumulate(i0, j0 + 1, (1 - u) * v, t, terrain, out);
    this.accumulate(i0 + 1, j0 + 1, u * v, t, terrain, out);
    return out;
  }

  private accumulate(
    i: number,
    j: number,
    w: number,
    t: number,
    terrain: AirTerrain,
    out: Float64Array,
  ) {
    if (w === 0) return;
    const s = this.node(i, j, t, terrain);
    const o = s * NF;
    const f = this.blendOf(s, t);
    const nw = this.fitNew;
    if (f >= 1) {
      for (let k = 0; k < NF; k++) out[k] = out[k]! + w * nw[o + k]!;
    } else {
      const pv = this.fitPrev;
      for (let k = 0; k < NF; k++) {
        const p = pv[o + k]!;
        out[k] = out[k]! + w * (p + (nw[o + k]! - p) * f);
      }
    }
  }
}
