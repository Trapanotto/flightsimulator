/**
 * Tileable 3D noises for the volumetric clouds, as plain RGBA bytes (no three.js): built in a
 * web worker (workers/cloudNoise.worker.ts) so the start does not block the page.
 */

function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}

/**
 * Tileable inverted Worley noise (1 at feature points, 0 far away) for `cells` per side,
 * evaluated at a point given in texture units 0..1.
 */
function worleyField(cells: number, seed: number) {
  const rnd = rng(seed);
  const pts = Float32Array.from({ length: cells * cells * cells * 3 }, rnd);
  return (x: number, y: number, z: number) => {
    const px = x * cells;
    const py = y * cells;
    const pz = z * cells;
    const cx = Math.floor(px);
    const cy = Math.floor(py);
    const cz = Math.floor(pz);
    let best = 9;
    for (let k = -1; k <= 1; k++)
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const ix = (((cx + i) % cells) + cells) % cells;
          const iy = (((cy + j) % cells) + cells) % cells;
          const iz = (((cz + k) % cells) + cells) % cells;
          const o = ((iz * cells + iy) * cells + ix) * 3;
          const dx = cx + i + pts[o]! - px;
          const dy = cy + j + pts[o + 1]! - py;
          const dz = cz + k + pts[o + 2]! - pz;
          best = Math.min(best, dx * dx + dy * dy + dz * dz);
        }
    return 1 - Math.min(1, Math.sqrt(best));
  };
}

/** Tileable value-noise fbm (4 octaves from `base` lattice cells per side). */
function valueFbm(base: number, seed: number) {
  const rnd = rng(seed);
  const octaves = [1, 2, 4, 8].map((k) => {
    const n = base * k;
    return { n, g: Float32Array.from({ length: n * n * n }, rnd) };
  });
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return (x: number, y: number, z: number) => {
    let v = 0;
    let amp = 0.5;
    let total = 0;
    for (const { n, g } of octaves) {
      const fx = x * n;
      const fy = y * n;
      const fz = z * n;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const z0 = Math.floor(fz);
      const tx = smooth(fx - x0);
      const ty = smooth(fy - y0);
      const tz = smooth(fz - z0);
      const at = (i: number, j: number, k: number) =>
        g[(((k % n) + n) % n) * n * n + (((j % n) + n) % n) * n + (((i % n) + n) % n)]!;
      const c00 = lerp(at(x0, y0, z0), at(x0 + 1, y0, z0), tx);
      const c10 = lerp(at(x0, y0 + 1, z0), at(x0 + 1, y0 + 1, z0), tx);
      const c01 = lerp(at(x0, y0, z0 + 1), at(x0 + 1, y0, z0 + 1), tx);
      const c11 = lerp(at(x0, y0 + 1, z0 + 1), at(x0 + 1, y0 + 1, z0 + 1), tx);
      v += lerp(lerp(c00, c10, ty), lerp(c01, c11, ty), tz) * amp;
      total += amp;
      amp *= 0.5;
    }
    return v / total;
  };
}

const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);

/**
 * Cloud shape noise (tileable, RGBA), the low-frequency volume of the clouds:
 *   R  Perlin-Worley: billowy value-noise fbm, its low values carved by Worley cells
 *   GBA  Worley fbm at increasing frequencies (erodes the base shape)
 */
export function shapeNoiseData(size = 64): Uint8Array {
  const fbm = valueFbm(4, 1234567);
  const w = [4, 8, 16, 32, 64].map((c, i) => worleyField(c, 7001 + i * 31));
  const data = new Uint8Array(size * size * size * 4);
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        const t = z / size;
        const f = w.map((fn) => fn(u, v, t));
        const wf = (a: number) => f[a]! * 0.625 + f[a + 1]! * 0.25 + f[a + 2]! * 0.125;
        const p = fbm(u, v, t);
        // Perlin-Worley (Schneider 2015): the fbm remapped onto the Worley fbm floor.
        const pw = wf(0) + Math.min(1, Math.max(0, (p - 0.25) / 0.6)) * (1 - wf(0));
        const o = ((z * size + y) * size + x) * 4;
        data[o] = byte(pw);
        data[o + 1] = byte(wf(0));
        data[o + 2] = byte(wf(1));
        data[o + 3] = byte(wf(2));
      }
  return data;
}

/** Detail noise (tileable, RGB = Worley fbm at three frequencies): erodes the cloud edges. */
export function detailNoiseData(size = 32): Uint8Array {
  const w = [2, 4, 8, 16, 32].map((c, i) => worleyField(c, 9001 + i * 17));
  const data = new Uint8Array(size * size * size * 4);
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const f = w.map((fn) => fn(x / size, y / size, z / size));
        const wf = (a: number) => f[a]! * 0.625 + f[a + 1]! * 0.25 + f[a + 2]! * 0.125;
        const o = ((z * size + y) * size + x) * 4;
        data[o] = byte(wf(0));
        data[o + 1] = byte(wf(1));
        data[o + 2] = byte(wf(2));
        data[o + 3] = 255;
      }
  return data;
}
