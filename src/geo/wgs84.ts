/** WGS84 ellipsoid: geodetic coordinates, ECEF and local frames. Angles in degrees. */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Longitude and latitude in degrees, height above the ellipsoid in metres. */
export interface Geodetic {
  lon: number;
  lat: number;
  h: number;
}

export const WGS84_A = 6_378_137;
export const WGS84_F = 1 / 298.257223563;
export const WGS84_B = WGS84_A * (1 - WGS84_F);
const E2 = WGS84_F * (2 - WGS84_F);
const RAD = Math.PI / 180;

export function geodeticToEcef<T extends Vec3Like>(lon: number, lat: number, h: number, out: T): T {
  const sinLat = Math.sin(lat * RAD);
  const cosLat = Math.cos(lat * RAD);
  const n = WGS84_A / Math.sqrt(1 - E2 * sinLat * sinLat);
  out.x = (n + h) * cosLat * Math.cos(lon * RAD);
  out.y = (n + h) * cosLat * Math.sin(lon * RAD);
  out.z = (n * (1 - E2) + h) * sinLat;
  return out;
}

/** Bowring's method with two refinements: exact to well below a millimetre near the Earth. */
export function ecefToGeodetic(p: Vec3Like, out: Geodetic = { lon: 0, lat: 0, h: 0 }): Geodetic {
  const r = Math.hypot(p.x, p.y);
  const ep2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);
  let beta = Math.atan2(p.z * WGS84_A, r * WGS84_B);
  let lat = 0;
  for (let i = 0; i < 3; i++) {
    const sb = Math.sin(beta);
    const cb = Math.cos(beta);
    lat = Math.atan2(p.z + ep2 * WGS84_B * sb * sb * sb, r - E2 * WGS84_A * cb * cb * cb);
    beta = Math.atan2((1 - WGS84_F) * Math.sin(lat), Math.cos(lat));
  }
  const sinLat = Math.sin(lat);
  const n = WGS84_A / Math.sqrt(1 - E2 * sinLat * sinLat);
  out.lon = Math.atan2(p.y, p.x) / RAD;
  out.lat = lat / RAD;
  // Near the poles r / cos(lat) loses precision; use z there.
  out.h = Math.abs(Math.cos(lat)) > 1e-3 ? r / Math.cos(lat) - n : p.z / sinLat - n * (1 - E2);
  return out;
}

/** Unit vector of the ellipsoid normal ("up") at lon/lat, in ECEF. */
export function upAt<T extends Vec3Like>(lon: number, lat: number, out: T): T {
  const cosLat = Math.cos(lat * RAD);
  out.x = cosLat * Math.cos(lon * RAD);
  out.y = cosLat * Math.sin(lon * RAD);
  out.z = Math.sin(lat * RAD);
  return out;
}

/**
 * A local tangent frame at a point of the ellipsoid, used as render space:
 * x = east, y = up, z = south (right-handed, y up as three.js expects), metres.
 *
 * The renderer works in single precision, so the frame's origin follows the camera
 * (floating origin): create a new frame when the camera has moved a few kilometres.
 */
export class LocalFrame {
  readonly origin: Geodetic;
  private readonly o = { x: 0, y: 0, z: 0 };
  private readonly east = { x: 0, y: 0, z: 0 };
  private readonly up = { x: 0, y: 0, z: 0 };
  private readonly south = { x: 0, y: 0, z: 0 };

  constructor(lon: number, lat: number, h = 0) {
    this.origin = { lon, lat, h };
    geodeticToEcef(lon, lat, h, this.o);
    const sl = Math.sin(lon * RAD);
    const cl = Math.cos(lon * RAD);
    const sp = Math.sin(lat * RAD);
    const cp = Math.cos(lat * RAD);
    this.east = { x: -sl, y: cl, z: 0 };
    this.up = { x: cp * cl, y: cp * sl, z: sp };
    // south = -north
    this.south = { x: sp * cl, y: sp * sl, z: -cp };
  }

  /** ECEF point -> local coordinates. */
  toLocal<T extends Vec3Like>(ecef: Vec3Like, out: T): T {
    const dx = ecef.x - this.o.x;
    const dy = ecef.y - this.o.y;
    const dz = ecef.z - this.o.z;
    out.x = dx * this.east.x + dy * this.east.y + dz * this.east.z;
    out.y = dx * this.up.x + dy * this.up.y + dz * this.up.z;
    out.z = dx * this.south.x + dy * this.south.y + dz * this.south.z;
    return out;
  }

  /** Local coordinates -> ECEF point. */
  toEcef<T extends Vec3Like>(local: Vec3Like, out: T): T {
    const { x, y, z } = local;
    out.x = this.o.x + x * this.east.x + y * this.up.x + z * this.south.x;
    out.y = this.o.y + x * this.east.y + y * this.up.y + z * this.south.y;
    out.z = this.o.z + x * this.east.z + y * this.up.z + z * this.south.z;
    return out;
  }

  /** ECEF direction -> local direction (no translation). */
  dirToLocal<T extends Vec3Like>(d: Vec3Like, out: T): T {
    const { x, y, z } = d;
    out.x = x * this.east.x + y * this.east.y + z * this.east.z;
    out.y = x * this.up.x + y * this.up.y + z * this.up.z;
    out.z = x * this.south.x + y * this.south.y + z * this.south.z;
    return out;
  }

  /** Geodetic point -> local coordinates. */
  fromGeodetic<T extends Vec3Like>(lon: number, lat: number, h: number, out: T): T {
    return this.toLocal(geodeticToEcef(lon, lat, h, out), out);
  }

  /** Local coordinates -> geodetic point. */
  toGeodetic(local: Vec3Like, out: Geodetic = { lon: 0, lat: 0, h: 0 }): Geodetic {
    return ecefToGeodetic(this.toEcef(local, { x: 0, y: 0, z: 0 }), out);
  }
}
