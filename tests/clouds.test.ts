import { describe, expect, it } from 'vitest';
import { makeDetailNoise, makeShapeNoise } from '../src/render/VolumetricClouds';
import { PRESETS, QUALITY_LEVELS } from '../src/core/settings';

/** Spread of a channel and how well it tiles (seam vs. neighbour differences along x). */
function channelStats(data: Uint8Array, size: number, ch: number) {
  let min = 255;
  let max = 0;
  let seam = 0;
  let inside = 0;
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++) {
      const row = (z * size + y) * size;
      for (let x = 0; x < size; x++) {
        const v = data[(row + x) * 4 + ch]!;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      seam += Math.abs(data[(row + size - 1) * 4 + ch]! - data[row * 4 + ch]!);
      inside += Math.abs(data[(row + 1) * 4 + ch]! - data[row * 4 + ch]!);
    }
  return { range: max - min, seam, inside };
}

describe('volumetric clouds', () => {
  it('builds varied, tileable shape noise (Perlin-Worley + Worley fbm)', () => {
    const size = 16;
    const data = makeShapeNoise(size).image.data as Uint8Array;
    expect(data.length).toBe(size ** 3 * 4);
    for (let ch = 0; ch < 4; ch++) {
      const s = channelStats(data, size, ch);
      expect(s.range, `channel ${ch}`).toBeGreaterThan(80);
      // Opposite faces continue each other: neighbours across the seam are close.
      expect(s.seam, `channel ${ch}`).toBeLessThan(s.inside * 2.5);
    }
  });

  it('builds tileable detail noise for the edges', () => {
    const size = 16;
    const data = makeDetailNoise(size).image.data as Uint8Array;
    for (let ch = 0; ch < 3; ch++) {
      const s = channelStats(data, size, ch);
      expect(s.range).toBeGreaterThan(80);
      expect(s.seam).toBeLessThan(s.inside * 2.5);
    }
  });

  it('shows the same clouds on every quality level', () => {
    for (const level of QUALITY_LEVELS) expect(PRESETS[level].volumetricClouds).toBeGreaterThan(0);
    for (const level of QUALITY_LEVELS) expect(PRESETS[level].cloudShadows).toBe(true);
    expect(PRESETS.ultra.volumetricClouds).toBeGreaterThanOrEqual(PRESETS.low.volumetricClouds);
  });
});
