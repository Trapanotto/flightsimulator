import { clampLat } from './wgs84';

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

export interface GeoBounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

export function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

/**
 * Cesium geographic tiling scheme: 2 tiles in X and 1 tile in Y at level 0,
 * TMS row order (y = 0 at the south pole).
 */
export function terrainTileForLonLat(
  lon: number,
  lat: number,
  z: number,
): TileCoord {
  const nx = 2 ** (z + 1);
  const ny = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * nx);
  const y = Math.floor(((clampLat(lat) + 90) / 180) * ny);
  return {
    z,
    x: Math.min(nx - 1, Math.max(0, x)),
    y: Math.min(ny - 1, Math.max(0, y)),
  };
}

export function terrainTileBounds(x: number, y: number, z: number): GeoBounds {
  const nx = 2 ** (z + 1);
  const ny = 2 ** z;
  return {
    west: (x / nx) * 360 - 180,
    east: ((x + 1) / nx) * 360 - 180,
    south: (y / ny) * 180 - 90,
    north: ((y + 1) / ny) * 180 - 90,
  };
}

export function terrainTileCenter(x: number, y: number, z: number) {
  const b = terrainTileBounds(x, y, z);
  return {
    lon: (b.west + b.east) / 2,
    lat: (b.south + b.north) / 2,
  };
}

/** Number of root tiles that cover the given bounds at a zoom level. */
export function terrainTilesForBounds(
  bounds: GeoBounds,
  z: number,
): TileCoord[] {
  const nw = terrainTileForLonLat(bounds.west, bounds.north, z);
  const se = terrainTileForLonLat(bounds.east, bounds.south, z);
  const tiles: TileCoord[] = [];

  for (let x = nw.x; x <= se.x; x++) {
    for (let y = se.y; y <= nw.y; y++) {
      tiles.push({ z, x, y });
    }
  }

  return tiles;
}

export function imageryTileForLonLat(
  lon: number,
  lat: number,
  z: number,
): TileCoord {
  const n = 2 ** z;
  const latRad = clampLat(lat) * (Math.PI / 180);
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(
    ((1 -
      Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) /
      2) *
      n,
  );
  return {
    z,
    x: Math.min(n - 1, Math.max(0, x)),
    y: Math.min(n - 1, Math.max(0, y)),
  };
}

export function imageryTileBounds(
  x: number,
  y: number,
  z: number,
): GeoBounds {
  const n = 2 ** z;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) /
    Math.PI;
  const south =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) /
    Math.PI;
  return { west, east, south, north };
}

/** Global pixel coordinate in the standard Web Mercator pyramid. */
export function imageryPixel(lon: number, lat: number, z: number) {
  const scale = 256 * 2 ** z;
  const latRad = clampLat(lat) * (Math.PI / 180);
  return {
    x: ((lon + 180) / 360) * scale,
    y:
      ((1 -
        Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) /
        2) *
      scale,
  };
}

export function imageryTilesForBounds(
  bounds: GeoBounds,
  z: number,
): TileCoord[] {
  const nw = imageryTileForLonLat(bounds.west, bounds.north, z);
  const se = imageryTileForLonLat(bounds.east, bounds.south, z);
  const tiles: TileCoord[] = [];

  for (let x = Math.min(nw.x, se.x); x <= Math.max(nw.x, se.x); x++) {
    for (let y = Math.min(nw.y, se.y); y <= Math.max(nw.y, se.y); y++) {
      tiles.push({ z, x, y });
    }
  }

  return tiles;
}
