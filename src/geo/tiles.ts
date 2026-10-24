/**
 * Tile maths for the two tiling schemes we stream:
 * - Terrain: geographic EPSG:4326, TMS (y counted from the south), 2x1 tiles at zoom 0.
 * - Imagery: Web Mercator EPSG:3857, XYZ (y counted from the north), 256 px tiles.
 */

export interface TileKey {
  z: number;
  x: number;
  y: number;
}

export interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export const tileId = (t: TileKey) => `${t.z}/${t.x}/${t.y}`;

/** Size of a geographic tile in degrees (same for lon and lat). */
export const geoTileSpan = (z: number) => 180 / 2 ** z;

export function geoTileBounds(t: TileKey): GeoBounds {
  const s = geoTileSpan(t.z);
  return {
    west: -180 + t.x * s,
    south: -90 + t.y * s,
    east: -180 + (t.x + 1) * s,
    north: -90 + (t.y + 1) * s,
  };
}

export function geoTileAt(lonDeg: number, latDeg: number, z: number): TileKey {
  const s = geoTileSpan(z);
  return { z, x: Math.floor((lonDeg + 180) / s), y: Math.floor((latDeg + 90) / s) };
}

export const MERCATOR_TILE_PX = 256;

/** Global Web Mercator pixel x at zoom z. */
export function mercatorPx(lonDeg: number, z: number): number {
  return ((lonDeg + 180) / 360) * MERCATOR_TILE_PX * 2 ** z;
}

/** Global Web Mercator pixel y at zoom z (0 at the north edge). */
export function mercatorPy(latDeg: number, z: number): number {
  const phi = (latDeg * Math.PI) / 180;
  const m = Math.log(Math.tan(Math.PI / 4 + phi / 2));
  return ((1 - m / Math.PI) / 2) * MERCATOR_TILE_PX * 2 ** z;
}

/** Inclusive range of mercator tiles needed to cover geographic bounds at zoom z. */
export function mercatorTileRange(b: GeoBounds, z: number) {
  const eps = 1e-6;
  return {
    x0: Math.floor(mercatorPx(b.west, z) / MERCATOR_TILE_PX),
    x1: Math.floor((mercatorPx(b.east, z) - eps) / MERCATOR_TILE_PX),
    y0: Math.floor(mercatorPy(b.north, z) / MERCATOR_TILE_PX),
    y1: Math.floor((mercatorPy(b.south, z) - eps) / MERCATOR_TILE_PX),
  };
}
