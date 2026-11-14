/**
 * Thermals as a deterministic pattern: one thermal per cell of a grid that drifts with the
 * wind, each with its own position, size, strength and life cycle from a hash of the cell and
 * of its generation, so the same place shows the same thermal for its lifetime and a new one
 * grows when it has died. Strength and height come from the caller (convective velocity
 * scale and the depth of the convective layer); this file only shapes the pattern.
 *
 * Sizes and spacing follow the convective boundary layer literature: updraughts are spaced
 * about 1 to 1.5 times the depth of the layer apart and cover some 20 to 40 % of the area
 * (Lenschow & Stephens 1980, "The role of thermals in the convective boundary layer",
 * Boundary-Layer Meteorology 19; Allen 2006, "Updraft model for development of autonomous
 * soaring uninhabited air vehicles", AIAA 2006-1510). A thermal lives some 10 to 30 minutes
 * (Stull 1988, "An Introduction to Boundary Layer Meteorology", ch. 11).
 */
import { hash3, rehash, unit } from './hash';

/** Grid spacing of the thermal cells, metres. */
export const THERMAL_SPACING = 1500;
/** Core radius (1/e) of an average thermal, metres. */
const RADIUS = 0.3 * THERMAL_SPACING;
/** Position jitter of a thermal inside its cell, fraction of the spacing either way. */
const JITTER = 0.2;
/** Lifetime of one thermal, seconds. */
const LIFE = 1200;
/** Strength is uniform in [S_MIN, S_MIN + S_RANGE]: mean 1. */
const S_MIN = 0.5;
const S_RANGE = 1;
/** Radius factor is uniform in [R_MIN, R_MIN + R_RANGE]. */
const R_MIN = 0.7;
const R_RANGE = 0.6;
/** Beyond this squared distance even the widest thermal is below e^-14 of its peak. */
const FAR2 = 14 * (RADIUS * (R_MIN + R_RANGE)) ** 2;
/**
 * Mean upward flux of the pattern per unit area: E[strength] E[envelope] E[radius²] π / D².
 * E[sin²] = 1/2; E[(0.7 + 0.6 u)²] = 0.49 + 0.42 + 0.12 = 1.03. Subtracting it everywhere is
 * the compensating sink between thermals, so the pattern averages to zero over an area.
 */
const MEAN_FLUX =
  (1 *
    0.5 *
    (R_MIN * R_MIN + R_MIN * R_RANGE + (R_RANGE * R_RANGE) / 3) *
    Math.PI *
    RADIUS *
    RADIUS) /
  (THERMAL_SPACING * THERMAL_SPACING);

/**
 * The pattern, with a small memo of the cells near the last points asked for: a cell's
 * thermal only changes when a new generation starts, so most calls need no hashing. The memo
 * never changes a value, only how fast it is found.
 */
export class ThermalField {
  private readonly ci = new Int32Array(64);
  private readonly cj = new Int32Array(64);
  private readonly gen = new Float64Array(64).fill(NaN);
  private readonly offset = new Float64Array(64);
  private readonly px = new Float64Array(64);
  private readonly py = new Float64Array(64);
  private readonly strength = new Float64Array(64);
  private readonly invR2 = new Float64Array(64);

  constructor(private readonly seed: number) {}

  /**
   * Pattern value at a point of the drifting air mass (metres) and time: about 1 in the core
   * of an average thermal at its peak, slightly negative between thermals, zero mean.
   */
  value(x: number, y: number, t: number): number {
    const ci = Math.floor(x / THERMAL_SPACING);
    const cj = Math.floor(y / THERMAL_SPACING);
    const seed = this.seed;
    let sum = 0;
    for (let j = cj - 1; j <= cj + 1; j++)
      for (let i = ci - 1; i <= ci + 1; i++) {
        const m = (i & 7) | ((j & 7) << 3);
        if (this.ci[m] !== i || this.cj[m] !== j || Number.isNaN(this.gen[m]!)) {
          this.ci[m] = i;
          this.cj[m] = j;
          this.gen[m] = NaN;
          this.offset[m] = unit(hash3(i, j, 0x51ed27, seed));
        }
        // Each cell's life cycle has its own phase; a generation ends when its envelope is
        // zero, so the next one grows from nothing (no step).
        const age = t / LIFE + this.offset[m]!;
        const generation = Math.floor(age);
        if (generation !== this.gen[m]) {
          // Two hashes, 16 bits per property: position, then strength and size.
          const h1 = hash3(i, j, generation, seed ^ 0x2545f491);
          this.px[m] = (i + 0.5 + JITTER * ((h1 & 0xffff) / 32768 - 1)) * THERMAL_SPACING;
          this.py[m] = (j + 0.5 + JITTER * ((h1 >>> 16) / 32768 - 1)) * THERMAL_SPACING;
          const h2 = rehash(h1);
          this.strength[m] = S_MIN + S_RANGE * ((h2 & 0xffff) / 65536);
          const r = RADIUS * (R_MIN + R_RANGE * ((h2 >>> 16) / 65536));
          this.invR2[m] = 1 / (r * r);
          this.gen[m] = generation;
        }
        const dx = x - this.px[m]!;
        const dy = y - this.py[m]!;
        const d2 = dx * dx + dy * dy;
        if (d2 > FAR2) continue;
        const s = Math.sin(Math.PI * (age - generation));
        sum += this.strength[m]! * s * s * Math.exp(-d2 * this.invR2[m]!);
      }
    return sum - MEAN_FLUX;
  }
}

/**
 * Vertical shape of the updraught through the convective layer, 0..1, at zeta = height above
 * ground over layer depth: growing from the ground like zeta^(1/3) (Allen 2006, after
 * Lenschow & Stephens), weakening a little with height, and reaching up to the cloud base
 * (zeta = 1), above which it fades within a tenth of the depth.
 */
export function thermalShape(zeta: number): number {
  if (zeta <= 0 || zeta >= 1.1) return 0;
  const grow = Math.cbrt(Math.min(zeta / 0.15, 1));
  const top = zeta <= 0.95 ? 1 : 1 - smooth((zeta - 0.95) / 0.15);
  return grow * (1 - 0.25 * zeta) * top;
}

const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
