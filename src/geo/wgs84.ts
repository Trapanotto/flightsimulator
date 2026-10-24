import { WGS84_A, WGS84_E2 } from './constants';

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export interface GeoPoint {
  lon: number;
  lat: number;
  height: number;
}

export interface EcefPoint {
  x: number;
  y: number;
  z: number;
}

export interface EnuPoint {
  e: number;
  n: number;
  u: number;
}

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

export function geodeticToEcef(
  lonDeg: number,
  latDeg: number,
  height = 0,
): EcefPoint {
  const lon = lonDeg * DEG2RAD;
  const lat = latDeg * DEG2RAD;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);

  return {
    x: (n + height) * cosLat * Math.cos(lon),
    y: (n + height) * cosLat * Math.sin(lon),
    z: (n * (1 - WGS84_E2) + height) * sinLat,
  };
}

/** Iterative ECEF to geodetic conversion, accurate to well below 1 mm. */
export function ecefToGeodetic(point: EcefPoint): GeoPoint {
  const { x, y, z } = point;
  const p = Math.hypot(x, y);
  const lon = Math.atan2(y, x);

  if (p < 1e-9) {
    const lat = z >= 0 ? Math.PI / 2 : -Math.PI / 2;
    return {
      lon: lon * RAD2DEG,
      lat: lat * RAD2DEG,
      height: Math.abs(z) - WGS84_A * (1 - WGS84_E2),
    };
  }

  let lat = Math.atan2(z, p * (1 - WGS84_E2));
  let height = 0;

  for (let i = 0; i < 7; i++) {
    const sinLat = Math.sin(lat);
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    height = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - WGS84_E2 * n / (n + height)));
  }

  return {
    lon: lon * RAD2DEG,
    lat: lat * RAD2DEG,
    height,
  };
}

/**
 * Pre-computed local East/North/Up frame. Used for every terrain vertex, so
 * the trigonometric values are cached instead of recomputed per point.
 */
export class EnuFrame {
  readonly origin: GeoPoint;
  readonly originEcef: EcefPoint;
  private readonly sinLat: number;
  private readonly cosLat: number;
  private readonly sinLon: number;
  private readonly cosLon: number;

  constructor(origin: GeoPoint) {
    this.origin = origin;
    this.originEcef = geodeticToEcef(origin.lon, origin.lat, origin.height);
    const lat = origin.lat * DEG2RAD;
    const lon = origin.lon * DEG2RAD;
    this.sinLat = Math.sin(lat);
    this.cosLat = Math.cos(lat);
    this.sinLon = Math.sin(lon);
    this.cosLon = Math.cos(lon);
  }

  toEnuEcef(x: number, y: number, z: number): EnuPoint {
    const dx = x - this.originEcef.x;
    const dy = y - this.originEcef.y;
    const dz = z - this.originEcef.z;

    return {
      e: -this.sinLon * dx + this.cosLon * dy,
      n:
        -this.sinLat * this.cosLon * dx -
        this.sinLat * this.sinLon * dy +
        this.cosLat * dz,
      u:
        this.cosLat * this.cosLon * dx +
        this.cosLat * this.sinLon * dy +
        this.sinLat * dz,
    };
  }

  toEnu(lonDeg: number, latDeg: number, height = 0): EnuPoint {
    const ecef = geodeticToEcef(lonDeg, latDeg, height);
    return this.toEnuEcef(ecef.x, ecef.y, ecef.z);
  }

  /** Rotate a direction vector from ECEF into ENU (no translation). */
  directionToEnu(x: number, y: number, z: number): EnuPoint {
    return {
      e: -this.sinLon * x + this.cosLon * y,
      n:
        -this.sinLat * this.cosLon * x -
        this.sinLat * this.sinLon * y +
        this.cosLat * z,
      u:
        this.cosLat * this.cosLon * x +
        this.cosLat * this.sinLon * y +
        this.sinLat * z,
    };
  }

  fromEnu(e: number, n: number, u: number): EcefPoint {
    const dx =
      -this.sinLon * e -
      this.sinLat * this.cosLon * n +
      this.cosLat * this.cosLon * u;
    const dy =
      this.cosLon * e -
      this.sinLat * this.sinLon * n +
      this.cosLat * this.sinLon * u;
    const dz = this.cosLat * n + this.sinLat * u;

    return {
      x: this.originEcef.x + dx,
      y: this.originEcef.y + dy,
      z: this.originEcef.z + dz,
    };
  }

  fromEnuGeodetic(e: number, n: number, u: number): GeoPoint {
    return ecefToGeodetic(this.fromEnu(e, n, u));
  }
}

/** Three.js uses +Y up and -Z forward; ENU uses +U up and +N north. */
export function enuToThree(e: number, n: number, u: number) {
  return { x: e, y: u, z: -n };
}

export function threeToEnu(x: number, y: number, z: number): EnuPoint {
  return { e: x, n: -z, u: y };
}

export function clampLat(lat: number): number {
  return clamp(lat, -85.05112878, 85.05112878);
}
