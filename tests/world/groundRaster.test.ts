import { describe, expect, it } from 'vitest';
import {
  addField,
  blur,
  byteMips,
  fieldAt,
  fillPolygon,
  grid,
  sample,
  splat,
} from '../../src/world/terrain/raster';

const sum = (a: ArrayLike<number>) => Array.from(a).reduce((s, v) => s + v, 0);

describe('ground rasters', () => {
  it('fills polygons at cell centres with holes left empty', () => {
    const g = grid(20, 20);
    const outer = [2, 2, 18, 2, 18, 18, 2, 18];
    const hole = [8, 8, 12, 8, 12, 12, 8, 12];
    fillPolygon(g, [outer, hole]);
    expect(sum(g.data)).toBe(16 * 16 - 4 * 4);
    expect(g.data[10 * 20 + 10]).toBe(0);
    expect(g.data[3 * 20 + 3]).toBe(1);
    expect(g.data[1 * 20 + 1]).toBe(0);
  });

  it('fills polygons reaching beyond the grid and with many vertices', () => {
    const g = grid(16, 16);
    const circle: number[] = [];
    for (let i = 0; i < 400; i++) {
      const a = (i / 400) * 2 * Math.PI;
      circle.push(8 + Math.cos(a) * 12, 8 + Math.sin(a) * 12);
    }
    fillPolygon(g, [circle]);
    // A circle of radius 12 around the centre covers the whole 16 x 16 grid.
    expect(sum(g.data)).toBe(256);
  });

  it('splats points without losing or moving energy', () => {
    const g = grid(10, 10);
    splat(g, 4.3, 6.8, 5);
    expect(sum(g.data)).toBeCloseTo(5, 6);
    let mx = 0;
    let my = 0;
    for (let y = 0; y < 10; y++)
      for (let x = 0; x < 10; x++) {
        mx += g.data[y * 10 + x]! * (x + 0.5);
        my += g.data[y * 10 + x]! * (y + 0.5);
      }
    expect(mx / 5).toBeCloseTo(4.3, 6);
    expect(my / 5).toBeCloseTo(6.8, 6);
  });

  it('blurs like a Gaussian of the asked width and keeps the sum', () => {
    const g = grid(81, 81);
    g.data[40 * 81 + 40] = 1;
    blur(g, 6);
    expect(sum(g.data)).toBeCloseTo(1, 5);
    let v = 0;
    for (let x = 0; x < 81; x++) v += g.data[40 * 81 + x]! * (x - 40) ** 2;
    const row = sum(g.data.subarray(40 * 81, 41 * 81));
    expect(Math.sqrt(v / row)).toBeGreaterThan(5);
    expect(Math.sqrt(v / row)).toBeLessThan(7);
  });

  it('resamples a field over the tile like sampling it texel by texel', () => {
    const g = grid(7, 5);
    for (let i = 0; i < g.data.length; i++) g.data[i] = Math.sin(i * 1.7) + i * 0.1;
    const f = { g, margin: 3, cell: 2.5 };
    const out = new Float32Array(12 * 12);
    addField(f, out, 12, 2);
    for (let y = 0; y < 12; y++)
      for (let x = 0; x < 12; x++)
        expect(out[y * 12 + x]).toBeCloseTo(2 * fieldAt(f, x + 0.5, y + 0.5), 5);
    expect(sample(g, 0.5, 0.5)).toBeCloseTo(g.data[0]!, 6);
  });

  it('builds mip chains that keep the energy of square-root coded light', () => {
    // One bright texel in an 8 x 8 image, coded sqrt(v): at 1 x 1 it is 1/64 of the light.
    const top = new Uint8Array(8 * 8 * 2);
    top[(3 * 8 + 5) * 2] = 255;
    top[(3 * 8 + 5) * 2 + 1] = 200;
    const mips = byteMips(top, 8, 2, [false, true]);
    expect(mips.map((m) => m.width)).toEqual([8, 4, 2, 1]);
    const last = mips[3]!.data;
    expect((last[0]! / 255) ** 2).toBeCloseTo(1 / 64, 2);
    // The linear channel averages plainly.
    expect(last[1]).toBe(Math.round(200 / 64));
  });
});
