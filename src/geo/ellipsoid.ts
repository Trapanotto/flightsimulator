/** WGS84 ellipsoid maths: geodetic <-> ECEF and local east-north-up frames. */

export const WGS84_A = 6378137.0;
export const WGS84_F = 1 / 298.257223563;
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);

export const DEG = Math.PI / 180;

export type Vec3 = [number, number, number];

/** lon/lat in degrees, height in metres. */
export function geodeticToEcef(
  lonDeg: number,
  latDeg: number,
  h: number,
  out: Vec3 = [0, 0, 0],
): Vec3 {
  const lon = lonDeg * DEG;
  const lat = latDeg * DEG;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  out[0] = (n + h) * cosLat * Math.cos(lon);
  out[1] = (n + h) * cosLat * Math.sin(lon);
  out[2] = (n * (1 - WGS84_E2) + h) * sinLat;
  return out;
}

/** Returns [lonDeg, latDeg, h]. Iterative (Bowring start), converges to < 1 mm in 3 steps. */
export function ecefToGeodetic(x: number, y: number, z: number): Vec3 {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - WGS84_E2));
  let h = 0;
  for (let i = 0; i < 4; i++) {
    const sinLat = Math.sin(lat);
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (WGS84_E2 * n) / (n + h)));
  }
  return [lon / DEG, lat / DEG, h];
}

/**
 * Local tangent frame at a geodetic point. Game axes follow three.js (Y up):
 * x = east, y = up, z = -north.
 */
export interface EnuFrame {
  origin: Vec3;
  east: Vec3;
  north: Vec3;
  up: Vec3;
}

export function enuFrame(lonDeg: number, latDeg: number, h = 0): EnuFrame {
  const lon = lonDeg * DEG;
  const lat = latDeg * DEG;
  const sl = Math.sin(lon);
  const cl = Math.cos(lon);
  const sp = Math.sin(lat);
  const cp = Math.cos(lat);
  return {
    origin: geodeticToEcef(lonDeg, latDeg, h),
    east: [-sl, cl, 0],
    north: [-sp * cl, -sp * sl, cp],
    up: [cp * cl, cp * sl, sp],
  };
}

/** ECEF direction (no translation) -> local game axes. */
export function ecefDirToLocal(
  f: EnuFrame,
  dx: number,
  dy: number,
  dz: number,
  out: Vec3 = [0, 0, 0],
): Vec3 {
  const e = f.east;
  const n = f.north;
  const u = f.up;
  out[0] = dx * e[0] + dy * e[1] + dz * e[2];
  out[1] = dx * u[0] + dy * u[1] + dz * u[2];
  out[2] = -(dx * n[0] + dy * n[1] + dz * n[2]);
  return out;
}

/** ECEF point -> local game coordinates relative to the frame origin. */
export function ecefToLocal(
  f: EnuFrame,
  x: number,
  y: number,
  z: number,
  out: Vec3 = [0, 0, 0],
): Vec3 {
  return ecefDirToLocal(f, x - f.origin[0], y - f.origin[1], z - f.origin[2], out);
}

/** Local game coordinates -> ECEF point. */
export function localToEcef(
  f: EnuFrame,
  lx: number,
  ly: number,
  lz: number,
  out: Vec3 = [0, 0, 0],
): Vec3 {
  const e = f.east;
  const n = f.north;
  const u = f.up;
  const nn = -lz;
  out[0] = f.origin[0] + lx * e[0] + ly * u[0] + nn * n[0];
  out[1] = f.origin[1] + lx * e[1] + ly * u[1] + nn * n[1];
  out[2] = f.origin[2] + lx * e[2] + ly * u[2] + nn * n[2];
  return out;
}
