/**
 * The stratus deck ("Hochnebel") as a medium: plain TypeScript, no three.js, so the density,
 * the visibility and the light through the deck are tested in Node, and the shader
 * (stratusNode.ts) evaluates exactly the same profile.
 *
 * The deck is a level layer, so its extinction depends on height only: a piecewise-linear
 * profile from the misty air below (thickening towards the base), through the ragged base,
 * the dense interior (densest near the top, where a stratus holds the most water) to a soft
 * top. Along a straight piece of a ray the optical depth is then the difference of the
 * profile's integral at the two end heights divided by the height change: no march, so a
 * flight through base and top cannot band or flicker.
 */
import type { Weather } from './weather';

export type Stratus = NonNullable<Weather['stratus']>;

/** Koschmieder: contrast falls to 2 % at the visibility (3.912 = -ln 0.02). */
export const KOSCHMIEDER = 3.912;
/** Visibility inside the deck near its base and near its top, metres. */
export const VISIBILITY_INSIDE_BASE = 140;
export const VISIBILITY_INSIDE_TOP = 75;
/** Depth below the base over which the mist thickens towards it, metres. */
export const MIST_DEPTH = 200;
/** Asymmetry of the droplets' phase function (diffusion through the deck). */
export const DROPLET_G = 0.85;
/** Share of the light on top of a thick stratus that it reflects. */
export const STRATUS_ALBEDO = 0.8;
/** Horizontal period of the billow texture, metres. */
export const BILLOW_PERIOD = 4096;
export const BILLOW_SIZE = 256;

/**
 * Knots of the profile: heights (m above sea level) and extinction (1/m). Below the first
 * knot the extinction stays at the mist's, above the last it is zero. `amplitude` is how far
 * the billows of the top rise and fall around `top`, `scud` how far ragged scud hangs below
 * the base.
 */
export interface StratusProfile {
  h: [number, number, number, number, number];
  s: [number, number, number, number, number];
  base: number;
  top: number;
  amplitude: number;
  scud: number;
}

/** The profile of a deck; `top` is clamped to at least 50 m above `base`. */
export function stratusProfile(st: Stratus): StratusProfile {
  const base = st.base;
  const top = Math.max(st.top, st.base + 50);
  const thick = top - base;
  const mist = KOSCHMIEDER / Math.max(st.visibilityBelow, 50);
  const sBase = KOSCHMIEDER / VISIBILITY_INSIDE_BASE;
  const sTop = KOSCHMIEDER / VISIBILITY_INSIDE_TOP;
  // Ramps and billows scale with thin decks so the knots never cross (h2 < h3 - amplitude).
  const rampBase = Math.min(60, 0.25 * thick);
  const rampTop = Math.min(50, 0.2 * thick);
  const amplitude = Math.min(35, 0.2 * thick);
  return {
    h: [base - MIST_DEPTH, base - 25, base + rampBase, top - rampTop, top + 12],
    // Just below the base the mist is several times denser than lower down (the scud).
    s: [mist, Math.min(mist * 3 + 0.004, sBase), sBase, sTop, 0],
    base,
    top,
    amplitude,
    scud: Math.min(60, 0.3 * thick),
  };
}

/** The knot heights shifted by a local base (scud) and top (billow) offset. */
function knots(p: StratusProfile, dBase: number, dTop: number): number[] {
  return [p.h[0], p.h[1] + dBase, p.h[2] + dBase, p.h[3] + dTop, p.h[4] + dTop];
}

/** Extinction (1/m) at height h, for a local shift of the base and the top. */
export function stratusExtinction(p: StratusProfile, h: number, dBase = 0, dTop = 0): number {
  const k = knots(p, dBase, dTop);
  if (h <= k[0]!) return p.s[0];
  if (h >= k[4]!) return 0;
  for (let i = 0; i < 4; i++) {
    if (h <= k[i + 1]!) {
      const f = (h - k[i]!) / Math.max(k[i + 1]! - k[i]!, 1e-6);
      return p.s[i]! + (p.s[i + 1]! - p.s[i]!) * f;
    }
  }
  return 0;
}

/**
 * Integral of the extinction from sea level up to h (dimensionless per metre of height):
 * the optical depth of a vertical path is the difference of two of these.
 */
export function stratusCumulative(p: StratusProfile, h: number, dBase = 0, dTop = 0): number {
  const k = knots(p, dBase, dTop);
  let sum = p.s[0] * Math.min(h, k[0]!);
  for (let i = 0; i < 4; i++) {
    const d = Math.max(k[i + 1]! - k[i]!, 1e-6);
    const x = Math.min(Math.max(h, k[i]!), k[i + 1]!) - k[i]!;
    sum += p.s[i]! * x + ((p.s[i + 1]! - p.s[i]!) * x * x) / (2 * d);
  }
  return sum;
}

/** Optical depth of a straight path of `length` metres from height h0 to h1. */
export function stratusOpticalDepth(
  p: StratusProfile,
  h0: number,
  h1: number,
  length: number,
  dBase = 0,
  dTop = 0,
): number {
  const dh = h1 - h0;
  const mean =
    Math.abs(dh) > 0.5
      ? (stratusCumulative(p, h1, dBase, dTop) - stratusCumulative(p, h0, dBase, dTop)) / dh
      : stratusExtinction(p, (h0 + h1) / 2, dBase, dTop);
  return Math.max(mean, 0) * length;
}

/** Optical depth of the whole deck straight up (mist below the base not included). */
export function stratusThickness(p: StratusProfile): number {
  return stratusCumulative(p, p.h[4] + p.amplitude) - stratusCumulative(p, p.base - 25);
}

/** Horizontal visibility (m) at height h from the deck alone; Infinity above it. */
export function stratusVisibility(p: StratusProfile, h: number): number {
  const s = stratusExtinction(p, h);
  return s > 0 ? KOSCHMIEDER / s : Infinity;
}

/**
 * Share of the diffuse light on top of a thick, non-absorbing layer of optical depth tau
 * that comes out of its underside (two-stream diffusion: 1 / (1 + 3/4 (1 - g) tau)).
 */
export function diffuseTransmission(tau: number): number {
  return 1 / (1 + 0.75 * (1 - DROPLET_G) * Math.max(tau, 0));
}

/**
 * Share of the direct light from a source at zenith cosine `mu` that reaches height h:
 * Beer-Lambert through what of the deck lies above. 1 above the deck, 0 under a thick one.
 */
export function directThrough(p: StratusProfile, h: number, mu: number): number {
  if (mu <= 0) return h > p.h[4] + p.amplitude ? 1 : 0;
  const od = stratusCumulative(p, p.h[4] + p.amplitude) - stratusCumulative(p, h);
  return Math.exp(-Math.max(od, 0) / Math.max(mu, 0.02));
}

/**
 * How deep in the deck a height is, 0 above the top .. 1 at and below the base, smooth over
 * the ramps (the blend of everything the camera's surroundings get from the deck).
 */
export function belowness(p: StratusProfile, h: number): number {
  const lo = p.base - 20;
  const hi = p.top + 20;
  const t = Math.min(Math.max((hi - h) / (hi - lo), 0), 1);
  return t * t * (3 - 2 * t);
}

function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}

/** Tileable inverted Worley noise in 2D: domes of `cells` per side, 1 at their centres. */
function domes(cells: number, seed: number) {
  const rnd = rng(seed);
  const pts = Float32Array.from({ length: cells * cells * 2 }, rnd);
  return (x: number, y: number) => {
    const px = x * cells;
    const py = y * cells;
    const cx = Math.floor(px);
    const cy = Math.floor(py);
    let best = 9;
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const ix = (((cx + i) % cells) + cells) % cells;
        const iy = (((cy + j) % cells) + cells) % cells;
        const o = (iy * cells + ix) * 2;
        const dx = cx + i + pts[o]! - px;
        const dy = cy + j + pts[o + 1]! - py;
        best = Math.min(best, dx * dx + dy * dy);
      }
    const d = Math.min(1, Math.sqrt(best));
    // Rounded tops, narrow troughs: the billows of a stratus top seen from above.
    return Math.sqrt(Math.max(0, 1 - d * d));
  };
}

/** Tileable value noise, `cells` per side. */
function value2(cells: number, seed: number) {
  const rnd = rng(seed);
  const g = Float32Array.from({ length: cells * cells }, rnd);
  const at = (i: number, j: number) =>
    g[(((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells)]!;
  const s = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number) => {
    const fx = x * cells;
    const fy = y * cells;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = s(fx - ix);
    const ty = s(fy - iy);
    const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * tx;
    const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * tx;
    return a + (b - a) * ty;
  };
}

/** Largest height gradient per texture period that the G and B channels store. */
export const BILLOW_GRADIENT_SCALE = 24;

/**
 * The billow texture, RGBA in 0..1, `size` x `size`, tiling with BILLOW_PERIOD: R the height
 * of the top (mean about one half), G and B its gradient along x and y per period (0.5 =
 * flat, ±BILLOW_GRADIENT_SCALE at 0 and 1), A the raggedness of the base. Seeded, so every
 * run and the CPU copy agree. Uploaded as half floats: eight bits would draw contour lines
 * where a grazing ray meets the gently sloping top.
 */
export function billowData(size = BILLOW_SIZE): Float32Array {
  const big = domes(8, 11); // cells of 500 m
  const small = domes(19, 23); // about 220 m
  // Slow rises and falls over kilometres, so the cells do not look like cobbles.
  const swellA = value2(3, 37);
  const swellB = value2(6, 31);
  const swellC = value2(13, 29);
  const ragA = value2(24, 41);
  const ragB = value2(61, 43);
  const height = new Float32Array(size * size);
  const rag = new Float32Array(size * size);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const x = i / size;
      const y = j / size;
      height[j * size + i] =
        0.32 * big(x, y) +
        0.12 * small(x, y) +
        0.24 * swellA(x, y) +
        0.2 * swellB(x, y) +
        0.12 * swellC(x, y);
      rag[j * size + i] = 0.6 * ragA(x, y) + 0.4 * ragB(x, y);
    }
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of height) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  for (let k = 0; k < height.length; k++) height[k] = (height[k]! - lo) / (hi - lo);
  const out = new Float32Array(size * size * 4);
  const at = (i: number, j: number) => height[((j + size) % size) * size + ((i + size) % size)]!;
  const unit = (v: number) => Math.min(Math.max(v, 0), 1);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const gx = ((at(i + 1, j) - at(i - 1, j)) * size) / 2;
      const gy = ((at(i, j + 1) - at(i, j - 1)) * size) / 2;
      const o = (j * size + i) * 4;
      out[o] = unit(at(i, j));
      out[o + 1] = unit(0.5 + gx / (2 * BILLOW_GRADIENT_SCALE));
      out[o + 2] = unit(0.5 + gy / (2 * BILLOW_GRADIENT_SCALE));
      out[o + 3] = unit(rag[j * size + i]!);
    }
  return out;
}

/** Bilinear, wrapping lookup of the billow texture at texture coordinates (u, v): 0..1 each. */
export function sampleBillow(data: Float32Array, size: number, u: number, v: number): number[] {
  const fx = u * size - 0.5;
  const fy = v * size - 0.5;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const texel = (i: number, j: number, c: number) =>
    data[((((j % size) + size) % size) * size + (((i % size) + size) % size)) * 4 + c]!;
  return [0, 1, 2, 3].map((c) => {
    const a = texel(ix, iy, c) + (texel(ix + 1, iy, c) - texel(ix, iy, c)) * tx;
    const b = texel(ix, iy + 1, c) + (texel(ix + 1, iy + 1, c) - texel(ix, iy + 1, c)) * tx;
    return a + (b - a) * ty;
  });
}
