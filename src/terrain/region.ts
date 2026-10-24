import { type TileKey, geoTileBounds } from '../geo/tiles';

/**
 * Phase 1 test area: Bernese Alps (Interlaken – Lauterbrunnen – Eiger/Mönch/Jungfrau).
 * Inner 8x8 tiles at zoom 12 (~3.4 x 4.9 km each), surrounded by a ring of zoom 10 tiles
 * for the far view. The inner block is aligned to zoom 10 tile edges so the two sets
 * meet without overlap.
 */
export const INNER = { z: 12, x0: 4272, x1: 4279, y0: 3104, y1: 3111 };
export const OUTER = { z: 10, x0: 1066, x1: 1071, y0: 774, y1: 779 };

export function regionCenter(): [number, number] {
  const sw = geoTileBounds({ z: INNER.z, x: INNER.x0, y: INNER.y0 });
  const ne = geoTileBounds({ z: INNER.z, x: INNER.x1, y: INNER.y1 });
  return [(sw.west + ne.east) / 2, (sw.south + ne.north) / 2];
}

export function regionTiles(): TileKey[] {
  const tiles: TileKey[] = [];
  for (let y = INNER.y0; y <= INNER.y1; y++)
    for (let x = INNER.x0; x <= INNER.x1; x++) tiles.push({ z: INNER.z, x, y });

  const scale = 2 ** (INNER.z - OUTER.z);
  for (let y = OUTER.y0; y <= OUTER.y1; y++)
    for (let x = OUTER.x0; x <= OUTER.x1; x++) {
      const coveredByInner =
        x * scale >= INNER.x0 &&
        (x + 1) * scale - 1 <= INNER.x1 &&
        y * scale >= INNER.y0 &&
        (y + 1) * scale - 1 <= INNER.y1;
      if (!coveredByInner) tiles.push({ z: OUTER.z, x, y });
    }
  return tiles;
}
