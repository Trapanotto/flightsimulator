import { type Geodetic, type LocalFrame, ecefToGeodetic, ellipsoidToSeaLevel, upAt } from '@geo';
import { type AirSample, type Environment, type GroundSample, type Vec3, isa } from '@sim';

const RAD = Math.PI / 180;

/** What the environment needs from the world: the ground at a place, in render space. */
export interface GroundSource {
  ground(
    lon: number,
    lat: number,
  ):
    | {
        height: number;
        normal: { x: number; y: number; z: number };
        surface: GroundSample['surface'];
      }
    | undefined;
}

/** The wind and temperature of the moment, as the simulation needs them. */
export interface AirState {
  /** Direction the surface wind comes from, degrees true, and its speed in m/s. */
  windFromDeg: number;
  windSpeed: number;
  /** Deviation from the standard atmosphere, K. */
  isaDeviation: number;
  /** 0 dry .. 1 soaked ground. */
  wetness: number;
}

/**
 * The world as the simulation sees it: the Earth's shape from `geo`, the ground from `world`,
 * the air from the weather. The simulation knows none of those packages.
 */
export class WorldEnvironment implements Environment {
  air_: AirState = { windFromDeg: 240, windSpeed: 0, isaDeviation: 0, wetness: 0 };
  /**
   * Added to every ground height, metres. When finer terrain arrives the ground under the
   * wheels moves; the app puts the difference here and lets it fade, so the aircraft is
   * lowered or raised gently instead of being dropped or kicked.
   */
  heightOffset = 0;
  private readonly g: Geodetic = { lon: 0, lat: 0, h: 0 };

  constructor(
    private readonly world: GroundSource,
    /** The current render frame (the ground normal comes back in its axes). */
    private readonly frame: () => LocalFrame,
  ) {}

  up(position: Vec3, out: Vec3): Vec3 {
    const g = ecefToGeodetic(position, this.g);
    return upAt(g.lon, g.lat, out);
  }

  north(position: Vec3, out: Vec3): Vec3 {
    const g = ecefToGeodetic(position, this.g);
    const sl = Math.sin(g.lon * RAD);
    const cl = Math.cos(g.lon * RAD);
    const sp = Math.sin(g.lat * RAD);
    const cp = Math.cos(g.lat * RAD);
    out.x = -sp * cl;
    out.y = -sp * sl;
    out.z = cp;
    return out;
  }

  altitude(position: Vec3): number {
    return ecefToGeodetic(position, this.g).h;
  }

  air(position: Vec3, out: AirSample): AirSample {
    const g = ecefToGeodetic(position, this.g);
    // The standard atmosphere is defined over sea level, positions are over the ellipsoid.
    const a = isa(ellipsoidToSeaLevel(g.lon, g.lat, g.h), this.air_.isaDeviation);
    out.density = a.density;
    out.temperature = a.temperature;
    out.pressure = a.pressure;
    // Wind grows with height above the ground (power law), up to about three times the
    // surface wind at altitude.
    const ground = this.world.ground(g.lon, g.lat)?.height ?? g.h - 300;
    const agl = Math.max(g.h - ground, 2);
    const speed = this.air_.windSpeed * Math.min(3, (agl / 10) ** 0.16);
    const to = (this.air_.windFromDeg + 180) * RAD;
    // East and north unit vectors at the place, in ECEF.
    const sl = Math.sin(g.lon * RAD);
    const cl = Math.cos(g.lon * RAD);
    const sp = Math.sin(g.lat * RAD);
    const cp = Math.cos(g.lat * RAD);
    const e = Math.sin(to) * speed;
    const n = Math.cos(to) * speed;
    out.wind.x = -sl * e - sp * cl * n;
    out.wind.y = cl * e - sp * sl * n;
    out.wind.z = cp * n;
    return out;
  }

  ground(position: Vec3): GroundSample | undefined {
    const g = ecefToGeodetic(position, this.g);
    const s = this.world.ground(g.lon, g.lat);
    if (!s) return undefined;
    // The normal comes in render space (x east, y up, z south of the frame's origin).
    const o = this.frame().origin;
    const sl = Math.sin(o.lon * RAD);
    const cl = Math.cos(o.lon * RAD);
    const sp = Math.sin(o.lat * RAD);
    const cp = Math.cos(o.lat * RAD);
    const { x, y, z } = s.normal;
    return {
      height: s.height + this.heightOffset,
      normal: {
        x: x * -sl + y * cp * cl + z * sp * cl,
        y: x * cl + y * cp * sl + z * sp * sl,
        z: y * sp - z * cp,
      },
      surface: s.surface,
      wetness: this.air_.wetness,
    };
  }
}
