/** WGS84 ellipsoid and the geographical region covered by phase 1. */
export const WGS84_A = 6_378_137.0;
export const WGS84_F = 1 / 298.257223563;
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);
export const WGS84_B = WGS84_A * (1 - WGS84_F);

/** Switzerland plus a comfortable border buffer. */
export const CH_BOUNDS = {
  west: 5.5,
  east: 11.0,
  south: 45.5,
  north: 48.1,
} as const;

/**
 * Fixed local ENU origin for phase 1. It sits roughly in the centre of
 * Switzerland, keeping the whole country within ~160 km and therefore well
 * inside float32 precision.
 */
export const WORLD_ORIGIN = {
  lon: 8.2,
  lat: 46.8,
  height: 0,
} as const;

/** Terrain tiles are fetched from zoom 8 downwards in phase 1. */
export const ROOT_TERRAIN_ZOOM = 8;
export const MAX_TERRAIN_ZOOM = 14;

/** Imagery is coupled to the terrain zoom to keep the request count low. */
export const MIN_IMAGERY_ZOOM = 9;
export const MAX_IMAGERY_ZOOM = 19;

export const EARTH_RADIUS_MEAN = 6_371_008.8;
