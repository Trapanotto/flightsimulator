/**
 * Continuous turbulence as a frozen random field: three independent unit-variance fields
 * (longitudinal, lateral, vertical) built as sums of plane waves whose energies follow the
 * Dryden spectra of MIL-F-8785C (section 3.7.2.2, also MIL-HDBK-1797):
 *
 *   Φu(Ω) = σu² (2 Lu / π) / (1 + (Lu Ω)²)
 *   Φv(Ω) = σv² (Lv / π) (1 + 3 (Lv Ω)²) / (1 + (Lv Ω)²)²     (Φw likewise with Lw)
 *
 * Why a field and not the usual shaping filter driven by white noise: a filter has state, so
 * the gust would depend on the order the air is sampled in and on the step; a field gives the
 * same gust for the same place and time, is smooth (no white-noise kicks a step apart) and is
 * sampled both by the distance flown and by time (each wave also drifts slowly in phase, so a
 * glider circling in still air still feels it change).
 *
 * The energy of each wave is the integral of the spectrum over its band, which has a closed
 * form, so the total variance is exactly 1 for every length scale. Waves point in random 3D
 * directions; along one straight line that spreads each wave's energy to slightly lower
 * wavenumbers than the 1D spectrum, which is inside what the standard's own shape fit allows.
 */
import { mulberry32 } from './hash';

/**
 * Waves per axis: more for the vertical gusts, which the pilot feels most, fewer for the
 * horizontal ones, to stay within the cost budget.
 */
const MODES_W = 24;
const MODES_UV = 16;
/** Wavenumber range, rad/m: from 30 km waves (slower than any gust) to 20 m (an aircraft). */
const K_MIN = (2 * Math.PI) / 30_000;
const K_MAX = (2 * Math.PI) / 20;
/** Length scales the amplitude tables are built for, geometric. */
const L_MIN = 5;
const L_MAX = 1000;
const LEVELS = 20;
/**
 * Phase drift per wavenumber, m/s: eddies of size 1/k turn over in about 1/(k σ), with σ of
 * the order of 1 m/s.
 */
const EVOLVE = 0.6;

/** Cumulative energy fraction below x = L Ω of the longitudinal Dryden form. */
const cumU = (x: number) => (2 / Math.PI) * Math.atan(x);
/** Cumulative energy fraction below x = L Ω of the lateral and vertical Dryden form. */
const cumW = (x: number) => (2 * Math.atan(x) - x / (1 + x * x)) / Math.PI;

class Axis {
  readonly k: Float64Array;
  readonly dx: Float64Array;
  readonly dy: Float64Array;
  readonly dz: Float64Array;
  readonly phase: Float64Array;
  /** Squared amplitude per level and mode. */
  readonly a2: Float64Array;
  /** Amplitudes for the last length scale asked for: flights at one height reuse them. */
  private readonly amp: Float64Array;
  private ampL = NaN;

  constructor(
    random: () => number,
    cum: (x: number) => number,
    private readonly modes: number,
  ) {
    const count = modes;
    this.k = new Float64Array(count);
    this.dx = new Float64Array(count);
    this.dy = new Float64Array(count);
    this.dz = new Float64Array(count);
    this.phase = new Float64Array(count);
    this.a2 = new Float64Array(LEVELS * count);
    this.amp = new Float64Array(count);
    const ratio = (K_MAX / K_MIN) ** (1 / (count - 1));
    const edges = new Float64Array(count + 1);
    edges[0] = 0;
    edges[count] = Infinity;
    for (let n = 1; n < count; n++) edges[n] = K_MIN * ratio ** (n - 0.5);
    for (let n = 0; n < count; n++) {
      // A random wavenumber inside its band, so the field never repeats exactly.
      const lo = n === 0 ? K_MIN / Math.sqrt(ratio) : edges[n]!;
      const hi = n === count - 1 ? K_MAX * Math.sqrt(ratio) : edges[n + 1]!;
      this.k[n] = lo * (hi / lo) ** random();
      // Uniform direction on the sphere.
      const cz = 2 * random() - 1;
      const az = 2 * Math.PI * random();
      const r = Math.sqrt(1 - cz * cz);
      this.dx[n] = r * Math.cos(az);
      this.dy[n] = r * Math.sin(az);
      this.dz[n] = cz;
      this.phase[n] = 2 * Math.PI * random();
    }
    const lr = (L_MAX / L_MIN) ** (1 / (LEVELS - 1));
    for (let l = 0; l < LEVELS; l++) {
      const L = L_MIN * lr ** l;
      for (let n = 0; n < count; n++) {
        const e = cum(L * edges[n + 1]!) - cum(L * edges[n]!);
        // A cosine of amplitude a has variance a²/2.
        this.a2[l * count + n] = 2 * (Number.isFinite(e) ? e : 1 - cum(L * edges[n]!));
      }
    }
  }

  /** Unit-variance value at a point and time for length scale L. */
  value(x: number, y: number, z: number, t: number, L: number): number {
    const count = this.modes;
    const amps = this.amp;
    if (L !== this.ampL) {
      this.ampL = L;
      const f = Math.log(Math.min(Math.max(L, L_MIN), L_MAX) / L_MIN) / Math.log(L_MAX / L_MIN);
      const p = f * (LEVELS - 1);
      const l0 = Math.min(Math.floor(p), LEVELS - 2);
      const w = p - l0;
      const o0 = l0 * count;
      const o1 = o0 + count;
      const a2 = this.a2;
      // Interpolating energies, not amplitudes, keeps the variance exactly 1 between levels.
      for (let n = 0; n < count; n++)
        amps[n] = Math.sqrt(a2[o0 + n]! + (a2[o1 + n]! - a2[o0 + n]!) * w);
    }
    let sum = 0;
    for (let n = 0; n < count; n++) {
      const k = this.k[n]!;
      const amp = amps[n]!;
      if (amp < 1e-4) continue;
      const arg =
        k * (this.dx[n]! * x + this.dy[n]! * y + this.dz[n]! * z) + this.phase[n]! + EVOLVE * k * t;
      sum += amp * Math.cos(arg);
    }
    return sum;
  }
}

export interface Gust {
  /** Along the wind, across it (to the left), up: unit variance each. */
  u: number;
  v: number;
  w: number;
}

export class GustField {
  private readonly u: Axis;
  private readonly v: Axis;
  private readonly w: Axis;

  constructor(seed: number) {
    const r = mulberry32(seed ^ 0x5bd1e995);
    this.u = new Axis(r, cumU, MODES_UV);
    this.v = new Axis(r, cumW, MODES_UV);
    this.w = new Axis(r, cumW, MODES_W);
  }

  /**
   * Unit-variance gusts at a position in the air mass (metres east, north, up) and time.
   * Lu is the longitudinal and lateral length scale, Lw the vertical one, metres.
   */
  sample(x: number, y: number, z: number, t: number, Lu: number, Lw: number, out: Gust): Gust {
    out.u = this.u.value(x, y, z, t, Lu);
    out.v = this.v.value(x, y, z, t, Lu);
    out.w = this.w.value(x, y, z, t, Lw);
    return out;
  }
}
