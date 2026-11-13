/**
 * geo – coordinates, frames, tiles and data sources. Plain TypeScript: no renderer, no DOM.
 * Depends on no other package.
 */
export {
  type Geodetic,
  LocalFrame,
  type Vec3Like,
  WGS84_A,
  WGS84_B,
  WGS84_F,
  ecefToGeodetic,
  geodeticToEcef,
  upAt,
} from './wgs84';
export { lv95ToWgs84, wgs84ToLv95 } from './lv95';
export { ellipsoidToSeaLevel, geoidUndulation, seaLevelToEllipsoid } from './geoid';
export {
  type GeoBounds,
  MERCATOR_TILE_PX,
  type TileKey,
  type WarpBand,
  type WarpPlan,
  boundsIntersect,
  distanceToBounds,
  geoTileAt,
  geoTileBounds,
  geoTileChildren,
  geoTileSpan,
  geoTileWidthMetres,
  imageryZoomFor,
  mercatorLat,
  mercatorLon,
  mercatorTileRange,
  mercatorX,
  mercatorY,
  planMercatorWarp,
  tileId,
  vectorTilePointToLonLat,
} from './tiles';
export { QM_MAX, type QuantizedMesh, decodeQuantizedMesh } from './quantizedMesh';
export { type SurfaceHit, TerrainSurface } from './terrainSurface';
export {
  SWISSIMAGE_MAX_ZOOM,
  SWISSIMAGE_URL,
  SWISSTOPO_ATTRIBUTION,
  TERRAIN_BASE,
  type TerrainLayer,
  VECTOR_TILE_MAX_ZOOM,
  VECTOR_TILE_URL,
  fillTemplate,
  parseTerrainLayer,
} from './sources';
