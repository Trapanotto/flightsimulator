import { describe, expect, it } from 'vitest';
import { INNER, regionTiles } from '../src/terrain/region';

describe('phase 1 region', () => {
  it('has 64 inner tiles and an outer ring without overlap', () => {
    const tiles = regionTiles();
    expect(tiles.filter((t) => t.z === INNER.z)).toHaveLength(64);
    expect(tiles.filter((t) => t.z === 10)).toHaveLength(32);
  });
});
