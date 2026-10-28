import { describe, expect, it } from 'vitest';
import { makeNoise3D } from '../src/render/VolumetricClouds';
import { PRESETS } from '../src/core/settings';

describe('volumetric clouds', () => {
  it('builds a varied, tileable 3D noise for the cloud shapes', () => {
    const size = 16;
    const tex = makeNoise3D(size);
    const data = tex.image.data as Uint8Array;
    expect(data.length).toBe(size ** 3);
    let min = 255;
    let max = 0;
    for (const v of data) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(max - min).toBeGreaterThan(100);
    // Opposite faces continue each other (tileable): neighbours across the seam are close.
    let seam = 0;
    let inside = 0;
    for (let z = 0; z < size; z++)
      for (let y = 0; y < size; y++) {
        const row = (z * size + y) * size;
        seam += Math.abs(data[row + size - 1]! - data[row]!);
        inside += Math.abs(data[row + 1]! - data[row]!);
      }
    expect(seam).toBeLessThan(inside * 2);
  });

  it('runs on high and ultra, not on weak devices', () => {
    expect(PRESETS.low.volumetricClouds).toBe(0);
    expect(PRESETS.medium.volumetricClouds).toBe(0);
    expect(PRESETS.high.volumetricClouds).toBeGreaterThan(0);
    expect(PRESETS.ultra.volumetricClouds).toBeGreaterThanOrEqual(PRESETS.high.volumetricClouds);
  });
});
