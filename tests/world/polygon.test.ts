import { describe, expect, it } from 'vitest';
import { meanWidth } from '../../src/world/terrain/polygon';

const rect = (w: number, h: number, x = 0, y = 0) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

describe('mean polygon width', () => {
  it('is the width of a long strip (a river)', () => {
    expect(meanWidth([rect(1000, 20)])).toBeCloseTo(20, 0);
    expect(meanWidth([rect(5000, 8)])).toBeCloseTo(8, 1);
  });

  it('does not depend on winding and subtracts holes', () => {
    expect(meanWidth([rect(100, 100).reverse()])).toBeCloseTo(50, 6);
    // 100 x 100 with a 50 x 50 island: area 7500, perimeter 600.
    const withHole = meanWidth([rect(100, 100), rect(50, 50, 25, 25).reverse()]);
    expect(withHole).toBeCloseTo((2 * 7500) / 600, 6);
  });
});
