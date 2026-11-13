import { describe, expect, it } from 'vitest';
import { NOISE_SLOPE_SCALE, buildNoiseTexels } from '../../src/world/terrain/noise';

describe('detail noise', () => {
  const size = 64;
  const t = buildNoiseTexels(size);
  const at = (x: number, y: number, c: number) =>
    t[(((y + size) % size) * size + ((x + size) % size)) * 4 + c]!;

  it('is the same on every machine', () => {
    expect(buildNoiseTexels(size)).toEqual(t);
  });

  it('tiles without a seam', () => {
    // Steps across the wrap are no larger than steps inside the texture.
    let inner = 0;
    let wrap = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size - 1; x++)
        inner = Math.max(inner, Math.abs(at(x + 1, y, 0) - at(x, y, 0)));
      wrap = Math.max(wrap, Math.abs(at(0, y, 0) - at(size - 1, y, 0)));
    }
    expect(wrap).toBeLessThanOrEqual(inner + 1);
  });

  it('stores the slope of the noise next to it', () => {
    // Slope channel against a central difference of the value channel (texture-width units).
    let err = 0;
    let n = 0;
    for (let y = 0; y < size; y += 3)
      for (let x = 0; x < size; x += 3) {
        const stored = (at(x, y, 1) / 255 - 0.5) / NOISE_SLOPE_SCALE;
        const diff = (((at(x + 1, y, 0) - at(x - 1, y, 0)) / 255) * 2 * size) / 2;
        err += Math.abs(stored - diff);
        n++;
      }
    expect(err / n).toBeLessThan(0.15 * size * 0.1);
  });
});
