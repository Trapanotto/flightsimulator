import { GEOID_GRID } from './geoidGrid';

/**
 * Geoid undulation in metres at lon/lat: ellipsoid height = sea-level height + undulation.
 *
 * swisstopo publishes heights above sea level (the terrain tiles included); the game works with
 * heights above the WGS84 ellipsoid. Over Switzerland the difference is 45..55 m (about 49.9 m
 * at Bern and Thun). The grid comes from swisstopo's own transformation (CHGeo2004), see
 * tools/world/geoid.mjs; outside the grid the nearest edge value is used.
 */
export function geoidUndulation(lon: number, lat: number): number {
  const g = GEOID_GRID;
  const fx = Math.min(Math.max((lon - g.west) / g.step, 0), g.cols - 1);
  const fy = Math.min(Math.max((lat - g.south) / g.step, 0), g.rows - 1);
  const x0 = Math.min(Math.floor(fx), g.cols - 2);
  const y0 = Math.min(Math.floor(fy), g.rows - 2);
  const tx = fx - x0;
  const ty = fy - y0;
  const v = g.values;
  const i = y0 * g.cols + x0;
  const a = v[i]! * (1 - tx) + v[i + 1]! * tx;
  const b = v[i + g.cols]! * (1 - tx) + v[i + g.cols + 1]! * tx;
  return a * (1 - ty) + b * ty;
}

/** Height above the WGS84 ellipsoid from a Swiss height above sea level. */
export const seaLevelToEllipsoid = (lon: number, lat: number, h: number) =>
  h + geoidUndulation(lon, lat);

/** Height above sea level from a height above the WGS84 ellipsoid. */
export const ellipsoidToSeaLevel = (lon: number, lat: number, h: number) =>
  h - geoidUndulation(lon, lat);
