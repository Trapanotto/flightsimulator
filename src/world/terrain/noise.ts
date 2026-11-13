/**
 * Tileable noise for the close-up detail of the ground and the waves of the water, baked once
 * into a small texture so the shader pays one texture read per octave (cheap on phones too).
 *
 * Channels: R = fractal gradient noise, G/B = its slope along x/y, A = a second, independent
 * noise (blotches). Pure function, no renderer.
 */

export const NOISE_SIZE = 256;
/** Gradient channels store slope * this + 0.5 (slope per texture width). */
export const NOISE_SLOPE_SCALE = 1 / 64;

/** Small deterministic PRNG (mulberry32): the same texture on every machine. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Periodic gradient (Perlin) noise with `cells` cells across the period, values about -1..1. */
function gradientNoise(size: number, cells: number, seed: number): Float32Array {
  const rand = rng(seed);
  const gx = new Float32Array(cells * cells);
  const gy = new Float32Array(cells * cells);
  for (let i = 0; i < cells * cells; i++) {
    const a = rand() * Math.PI * 2;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  const out = new Float32Array(size * size);
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells;
      const fy = (y / size) * cells;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const dot = (cx: number, cy: number, dx: number, dy: number) => {
        const i = (cy % cells) * cells + (cx % cells);
        return gx[i]! * dx + gy[i]! * dy;
      };
      const n00 = dot(x0, y0, tx, ty);
      const n10 = dot(x0 + 1, y0, tx - 1, ty);
      const n01 = dot(x0, y0 + 1, tx, ty - 1);
      const n11 = dot(x0 + 1, y0 + 1, tx - 1, ty - 1);
      const u = fade(tx);
      const v = fade(ty);
      out[y * size + x] = (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v;
    }
  }
  return out;
}

function fractal(size: number, seed: number, octaves: Array<[cells: number, weight: number]>) {
  const out = new Float32Array(size * size);
  octaves.forEach(([cells, weight], i) => {
    const n = gradientNoise(size, cells, seed + i * 101);
    for (let k = 0; k < out.length; k++) out[k] = out[k]! + n[k]! * weight;
  });
  return out;
}

/** RGBA8 texels of the detail noise, NOISE_SIZE x NOISE_SIZE, tileable in both directions. */
export function buildNoiseTexels(size = NOISE_SIZE): Uint8Array {
  const a = fractal(size, 7, [
    [8, 0.55],
    [16, 0.3],
    [32, 0.15],
  ]);
  const b = fractal(size, 911, [
    [4, 0.6],
    [12, 0.4],
  ]);
  const out = new Uint8Array(size * size * 4);
  const at = (f: Float32Array, x: number, y: number) =>
    f[((y + size) % size) * size + ((x + size) % size)]!;
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Central differences, as slope per texture width.
      const sx = ((at(a, x + 1, y) - at(a, x - 1, y)) / 2) * size;
      const sy = ((at(a, x, y + 1) - at(a, x, y - 1)) / 2) * size;
      out[i] = byte(at(a, x, y) * 0.5 + 0.5);
      out[i + 1] = byte(sx * NOISE_SLOPE_SCALE + 0.5);
      out[i + 2] = byte(sy * NOISE_SLOPE_SCALE + 0.5);
      out[i + 3] = byte(at(b, x, y) * 0.5 + 0.5);
    }
  }
  return out;
}
