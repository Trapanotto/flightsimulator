/**
 * The direction of crop rows, furrows and tramlines, read from the orthophoto itself: fields
 * show parallel stripes, and the structure tensor of the photo's brightness finds their
 * direction wherever they are clear. The shader draws fine rows along it close to the ground.
 * Pure functions, tested in Node.
 */
import { blur, grid } from './raster';

/**
 * Byte per texel of a size x size raster: 0 where the photo shows no clear stripes, else
 * 1 + round(angle / PI * 254), the angle of the stripes in image coordinates (x right = east,
 * y down = south), 0 .. PI.
 */
export function rowDirections(
  rgba: Uint8ClampedArray | Uint8Array,
  imageSize: number,
  size: number,
  /** Window of the tensor in output texels (a few metres: several rows). */
  window: number,
): Uint8Array {
  const n = imageSize;
  const lum = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++)
    lum[i] = 0.2126 * rgba[i * 4]! + 0.7152 * rgba[i * 4 + 1]! + 0.0722 * rgba[i * 4 + 2]!;
  const jxx = grid(size, size);
  const jyy = grid(size, size);
  const jxy = grid(size, size);
  const f = size / n;
  for (let y = 1; y < n - 1; y++)
    for (let x = 1; x < n - 1; x++) {
      const gx = lum[y * n + x + 1]! - lum[y * n + x - 1]!;
      const gy = lum[(y + 1) * n + x]! - lum[(y - 1) * n + x]!;
      const k = Math.floor(y * f) * size + Math.floor(x * f);
      jxx.data[k] = jxx.data[k]! + gx * gx;
      jyy.data[k] = jyy.data[k]! + gy * gy;
      jxy.data[k] = jxy.data[k]! + gx * gy;
    }
  blur(jxx, window);
  blur(jyy, window);
  blur(jxy, window);
  const out = new Uint8Array(size * size);
  // Gradient energy below this (per photo pixel, in 8-bit units squared) is texture noise.
  const minEnergy = 6 / (f * f);
  for (let k = 0; k < size * size; k++) {
    const a = jxx.data[k]!;
    const b = jyy.data[k]!;
    const c = jxy.data[k]!;
    const sum = a + b;
    if (sum < minEnergy) continue;
    const coherence = Math.sqrt((a - b) * (a - b) + 4 * c * c) / sum;
    if (coherence < 0.4) continue;
    // The gradient points across the stripes; the stripes run at right angles to it.
    let angle = 0.5 * Math.atan2(2 * c, a - b) + Math.PI / 2;
    angle = ((angle % Math.PI) + Math.PI) % Math.PI;
    out[k] = 1 + Math.round((angle / Math.PI) * 254);
  }
  return out;
}

/** The stripe angle (radians, 0..PI) of a byte from rowDirections, or null. */
export function decodeRowDirection(b: number): number | null {
  return b === 0 ? null : ((b - 1) / 254) * Math.PI;
}
