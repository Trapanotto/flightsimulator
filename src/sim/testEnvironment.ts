/**
 * A self-contained world for tests and as the app's fallback while real terrain and weather
 * are missing: the WGS84 ellipsoid, ISA air with an optional steady wind, and a plane of
 * ground at a chosen elevation (optionally sloped) with a chosen surface.
 */
import { isa } from './atmosphere';
import type { AirSample, Environment, GroundSample, Surface, Vec3 } from './types';

const A = 6_378_137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const DEG = Math.PI / 180;

/** ECEF position of a geodetic latitude, longitude (degrees) and height above the ellipsoid. */
export function geodeticToEcef(
  latDeg: number,
  lonDeg: number,
  height: number,
  out: Vec3 = { x: 0, y: 0, z: 0 },
): Vec3 {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const sinLat = Math.sin(lat);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const r = (n + height) * Math.cos(lat);
  out.x = r * Math.cos(lon);
  out.y = r * Math.sin(lon);
  out.z = (n * (1 - E2) + height) * sinLat;
  return out;
}

/** Geodetic latitude, longitude (degrees) and height of an ECEF position. */
export function ecefToGeodetic(p: Vec3): { lat: number; lon: number; height: number } {
  const lon = Math.atan2(p.y, p.x);
  const r = Math.hypot(p.x, p.y);
  // Bowring's start and two Newton refinements are far below a millimetre near the surface.
  let lat = Math.atan2(p.z, r * (1 - E2));
  let height = 0;
  for (let i = 0; i < 4; i++) {
    const s = Math.sin(lat);
    const n = A / Math.sqrt(1 - E2 * s * s);
    height = r / Math.cos(lat) - n;
    lat = Math.atan2(p.z, r * (1 - (E2 * n) / (n + height)));
  }
  return { lat: lat / DEG, lon: lon / DEG, height };
}

export interface TestEnvironmentOptions {
  /** Where the world's local reference (and the ground plane's anchor) sits, degrees. */
  latitude?: number;
  longitude?: number;
  /** Ground height above the ellipsoid, m. */
  elevation?: number;
  surface?: Surface;
  wetness?: number;
  /** Steady horizontal wind: direction it blows from (degrees true) and speed (m/s). */
  wind?: { fromDeg: number; speed: number };
  /** ISA temperature deviation, K. */
  isaDeviation?: number;
  /** Plane of ground falling `gradient` (rise over run) towards `downhillDeg`. */
  slope?: { gradient: number; downhillDeg: number };
  /** No ground at all (as when terrain is not loaded). */
  noGround?: boolean;
  /** Visible moisture 0..1 everywhere (in cloud), for icing. */
  moisture?: number;
  /** Sea-level pressure, hPa (default the standard 1013.25): scales the whole column. */
  qnh?: number;
  /** Magnetic declination, degrees east, and geoid height above the ellipsoid, m (default 0). */
  declination?: number;
  geoidHeight?: number;
}

export class TestEnvironment implements Environment {
  readonly origin: Vec3;
  private readonly lat0: number;
  private readonly lon0: number;
  private readonly elevation: number;
  private readonly surface: Surface;
  private readonly wetness: number;
  private readonly windVector: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly isaDeviation: number;
  private readonly downhill: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly gradient: number;
  noGround: boolean;
  moisture: number;
  qnh: number | undefined;
  declination: number;
  geoid: number;

  constructor(options: TestEnvironmentOptions = {}) {
    this.lat0 = options.latitude ?? 46.91;
    this.lon0 = options.longitude ?? 7.5;
    this.elevation = options.elevation ?? 0;
    this.surface = options.surface ?? 'asphalt';
    this.wetness = options.wetness ?? 0;
    this.isaDeviation = options.isaDeviation ?? 0;
    this.noGround = options.noGround ?? false;
    this.moisture = options.moisture ?? 0;
    this.qnh = options.qnh;
    this.declination = options.declination ?? 0;
    this.geoid = options.geoidHeight ?? 0;
    this.origin = geodeticToEcef(this.lat0, this.lon0, this.elevation);
    const up = this.up(this.origin, { x: 0, y: 0, z: 0 });
    const north = this.north(this.origin, { x: 0, y: 0, z: 0 });
    const east = cross(north, up);
    if (options.wind) {
      // A wind "from" a direction blows towards the opposite one.
      const d = options.wind.fromDeg * DEG;
      const s = -options.wind.speed;
      this.windVector.x = s * (Math.cos(d) * north.x + Math.sin(d) * east.x);
      this.windVector.y = s * (Math.cos(d) * north.y + Math.sin(d) * east.y);
      this.windVector.z = s * (Math.cos(d) * north.z + Math.sin(d) * east.z);
    }
    this.gradient = options.slope?.gradient ?? 0;
    const dd = (options.slope?.downhillDeg ?? 0) * DEG;
    this.downhill.x = Math.cos(dd) * north.x + Math.sin(dd) * east.x;
    this.downhill.y = Math.cos(dd) * north.y + Math.sin(dd) * east.y;
    this.downhill.z = Math.cos(dd) * north.z + Math.sin(dd) * east.z;
  }

  /** World position at a height above the ground plane's anchor, offset north and east (m). */
  position(height: number, northM = 0, eastM = 0, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
    const up = this.up(this.origin, { x: 0, y: 0, z: 0 });
    const north = this.north(this.origin, { x: 0, y: 0, z: 0 });
    const east = cross(north, up);
    out.x = this.origin.x + up.x * height + north.x * northM + east.x * eastM;
    out.y = this.origin.y + up.y * height + north.y * northM + east.y * eastM;
    out.z = this.origin.z + up.z * height + north.z * northM + east.z * eastM;
    // The tangent plane falls away from the ellipsoid; put the point back at its height.
    const g = ecefToGeodetic(out);
    const target = this.groundHeightAt(out) + height;
    return geodeticToEcef(g.lat, g.lon, target, out);
  }

  up(position: Vec3, out: Vec3): Vec3 {
    const g = ecefToGeodetic(position);
    const lat = g.lat * DEG;
    const lon = g.lon * DEG;
    out.x = Math.cos(lat) * Math.cos(lon);
    out.y = Math.cos(lat) * Math.sin(lon);
    out.z = Math.sin(lat);
    return out;
  }

  north(position: Vec3, out: Vec3): Vec3 {
    const g = ecefToGeodetic(position);
    const lat = g.lat * DEG;
    const lon = g.lon * DEG;
    out.x = -Math.sin(lat) * Math.cos(lon);
    out.y = -Math.sin(lat) * Math.sin(lon);
    out.z = Math.cos(lat);
    return out;
  }

  altitude(position: Vec3): number {
    return ecefToGeodetic(position).height;
  }

  air(position: Vec3, out: AirSample): AirSample {
    const s = isa(this.altitude(position) - this.geoid, this.isaDeviation);
    out.density = s.density;
    out.pressure = s.pressure;
    out.temperature = s.temperature;
    if (this.qnh !== undefined) {
      out.pressure = s.pressure * (this.qnh / 1013.25);
      out.density = out.pressure / (287.053 * s.temperature);
    }
    out.moisture = this.moisture;
    out.wind.x = this.windVector.x;
    out.wind.y = this.windVector.y;
    out.wind.z = this.windVector.z;
    return out;
  }

  geoidHeight(): number {
    return this.geoid;
  }

  magneticDeclination(): number {
    return this.declination;
  }

  private groundHeightAt(position: Vec3): number {
    if (this.gradient === 0) return this.elevation;
    const dx = position.x - this.origin.x;
    const dy = position.y - this.origin.y;
    const dz = position.z - this.origin.z;
    const along = dx * this.downhill.x + dy * this.downhill.y + dz * this.downhill.z;
    return this.elevation - this.gradient * along;
  }

  ground(position: Vec3): GroundSample | undefined {
    if (this.noGround) return undefined;
    const up = this.up(position, { x: 0, y: 0, z: 0 });
    const n = {
      x: up.x + this.gradient * this.downhill.x,
      y: up.y + this.gradient * this.downhill.y,
      z: up.z + this.gradient * this.downhill.z,
    };
    const l = Math.hypot(n.x, n.y, n.z);
    n.x /= l;
    n.y /= l;
    n.z /= l;
    return {
      height: this.groundHeightAt(position),
      normal: n,
      surface: this.surface,
      wetness: this.wetness,
    };
  }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
