/**
 * Tile maths for the two tiling schemes streamed from swisstopo:
 * - Terrain: geographic EPSG:4326, TMS (y counted from the south), 2 x 1 tiles at zoom 0.
 * - Imagery and vector tiles: Web Mercator EPSG:3857, XYZ (y counted from the north).
 */

export interface TileKey {
  z: number;
  x: number;
  y: number;
}

/** Degrees. */
export interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

const RAD = Math.PI / 180;
/** Metres per degree of latitude near 47° N (good to 0.1 %, used only for distances and LOD). */
const M_PER_DEG_LAT = 111_200;

export const tileId = (t: TileKey) => `${t.z}/${t.x}/${t.y}`;

/** Size of a geographic tile in degrees (the same for longitude and latitude). */
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

/** The geographic tile at zoom z that contains lon/lat. */
export function geoTileAt(lon: number, lat: number, z: number): TileKey {
  const s = geoTileSpan(z);
  return { z, x: Math.floor((lon + 180) / s), y: Math.floor((lat + 90) / s) };
}

/** The four children in the order south-west, south-east, north-west, north-east. */
export function geoTileChildren(t: TileKey): TileKey[] {
  const z = t.z + 1;
  const x = t.x * 2;
  const y = t.y * 2;
  return [
    { z, x, y },
    { z, x: x + 1, y },
    { z, x, y: y + 1 },
    { z, x: x + 1, y: y + 1 },
  ];
}

export function boundsIntersect(a: GeoBounds, b: GeoBounds): boolean {
  return a.east > b.west && a.west < b.east && a.north > b.south && a.south < b.north;
}

/** East-west width of a geographic tile at its middle latitude, metres. */
export function geoTileWidthMetres(t: TileKey): number {
  const b = geoTileBounds(t);
  return (b.east - b.west) * M_PER_DEG_LAT * Math.cos(((b.south + b.north) / 2) * RAD);
}

/**
 * Horizontal distance in metres from lon/lat to the nearest point of the bounds (0 inside).
 * A local flat approximation: plenty for level-of-detail decisions within a few hundred km.
 */
export function distanceToBounds(lon: number, lat: number, b: GeoBounds): number {
  const clon = Math.min(Math.max(lon, b.west), b.east);
  const clat = Math.min(Math.max(lat, b.south), b.north);
  const dx = (lon - clon) * M_PER_DEG_LAT * Math.cos(((lat + clat) / 2) * RAD);
  const dy = (lat - clat) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

// ---- Web Mercator ----

/** Pixels per Web Mercator tile side of swisstopo's WMTS. */
export const MERCATOR_TILE_PX = 256;

/** Web Mercator x in tile units at zoom z (0 at 180° W). */
export function mercatorX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

/** Web Mercator y in tile units at zoom z (0 at the north edge, about 85.05° N). */
export function mercatorY(lat: number, z: number): number {
  const m = Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));
  return ((1 - m / Math.PI) / 2) * 2 ** z;
}

/** Inverse of mercatorX. */
export function mercatorLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

/** Inverse of mercatorY. */
export function mercatorLat(y: number, z: number): number {
  const m = Math.PI * (1 - (2 * y) / 2 ** z);
  return Math.atan(Math.sinh(m)) / RAD;
}

/** Inclusive range of Web Mercator tiles at zoom z that cover the bounds. */
export function mercatorTileRange(b: GeoBounds, z: number) {
  const eps = 1e-9;
  const n = 2 ** z;
  const clamp = (v: number) => Math.min(Math.max(v, 0), n - 1);
  return {
    x0: clamp(Math.floor(mercatorX(b.west, z))),
    x1: clamp(Math.floor(mercatorX(b.east, z) - eps)),
    y0: clamp(Math.floor(mercatorY(b.north, z))),
    y1: clamp(Math.floor(mercatorY(b.south, z) - eps)),
  };
}

/**
 * One horizontal band of the warp from Web Mercator onto a geographic tile texture.
 * Destination rows [dy0, dy1) of a `size`-pixel texture (row 0 = north edge) take source rows
 * [sy0, sy1) of a mosaic of Mercator tiles whose top-left tile is (x0, y0), in mosaic pixels.
 */
export interface WarpBand {
  dy0: number;
  dy1: number;
  sy0: number;
  sy1: number;
}

/** The Mercator-to-geographic warp of one tile texture. */
export interface WarpPlan {
  /** Mercator zoom of the source imagery. */
  zoom: number;
  range: ReturnType<typeof mercatorTileRange>;
  /** Source columns of the tile's west and east edges, in mosaic pixels. */
  sx0: number;
  sx1: number;
  bands: WarpBand[];
}

/**
 * Plans the warp of Mercator imagery at `zoom` onto the geographic bounds as a `size` x `size`
 * texture. Longitude maps linearly in both projections, so only rows need warping; within a
 * band of `bandPx` rows the Mercator stretch is treated as constant (error below 0.01 px for
 * tiles from zoom 6 on at 4-pixel bands).
 */
export function planMercatorWarp(b: GeoBounds, zoom: number, size: number, bandPx = 4): WarpPlan {
  const range = mercatorTileRange(b, zoom);
  const ox = range.x0 * MERCATOR_TILE_PX;
  const oy = range.y0 * MERCATOR_TILE_PX;
  const bands: WarpBand[] = [];
  const latSpan = b.north - b.south;
  for (let dy0 = 0; dy0 < size; dy0 += bandPx) {
    const dy1 = Math.min(size, dy0 + bandPx);
    const top = b.north - (latSpan * dy0) / size;
    const bottom = b.north - (latSpan * dy1) / size;
    bands.push({
      dy0,
      dy1,
      sy0: mercatorY(top, zoom) * MERCATOR_TILE_PX - oy,
      sy1: mercatorY(bottom, zoom) * MERCATOR_TILE_PX - oy,
    });
  }
  return {
    zoom,
    range,
    sx0: mercatorX(b.west, zoom) * MERCATOR_TILE_PX - ox,
    sx1: mercatorX(b.east, zoom) * MERCATOR_TILE_PX - ox,
    bands,
  };
}

/**
 * Mercator zoom whose pixels match a geographic tile texture of `size` pixels at zoom z.
 * A geographic tile is as wide in longitude as a Mercator tile one zoom deeper, and a Mercator
 * tile has 256 pixels, so each doubling of the texture size needs one more zoom level.
 */
export function imageryZoomFor(z: number, size: number, maxZoom: number): number {
  return Math.min(maxZoom, z + 1 + Math.round(Math.log2(size / MERCATOR_TILE_PX)));
}

/** Converts a point of a vector tile (extent units, y down) to lon/lat in degrees. */
export function vectorTilePointToLonLat(
  tile: TileKey,
  extent: number,
  px: number,
  py: number,
  out: { lon: number; lat: number },
) {
  out.lon = mercatorLon(tile.x + px / extent, tile.z);
  out.lat = mercatorLat(tile.y + py / extent, tile.z);
  return out;
}
