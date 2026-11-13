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
