import {
  type Geodetic,
  type LocalFrame,
  airportsNear,
  ecefToGeodetic,
  ellipsoidToSeaLevel,
  geoidUndulation,
  magneticDeclination,
  upAt,
} from '@geo';
import {
  AirModel,
  type AirSample,
  type AirTerrain,
  type Environment,
  type GroundSample,
  type Vec3,
  isa,
} from '@sim';

const RAD = Math.PI / 180;
const EARTH_R = 6_371_000;
/** Metres along the runway over which its surface is averaged (two each way, and the place). */
const RUNWAY_SMOOTHING = [-16, -8, 8, 16];
/** The runway under a place is looked up again after this many metres. */
const STRIP_RECHECK = 25;

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
  /** Cumulus: share of the sky covered and the layer's base and top, metres above sea level. */
  cloudCover?: number;
  cloudBase?: number;
  cloudTop?: number;
  /** A closed stratus deck, metres above sea level. */
  stratus?: { base: number; top: number };
  /** 0 dry .. 1 heavy rain or snow. */
  precipitation?: number;
  /** Air temperature at sea level, degrees Celsius. */
  temperature?: number;
  /** Where the sun stands, degrees (elevation above the horizon, azimuth from north). */
  sunElevationDeg?: number;
  sunAzimuthDeg?: number;
}

/**
 * The world as the simulation sees it: the Earth's shape from `geo`, the ground from `world`,
 * the air from the weather. The simulation knows none of those packages.
 */
export class WorldEnvironment implements Environment {
  private state: AirState = { windFromDeg: 240, windSpeed: 0, isaDeviation: 0, wetness: 0 };
  /**
   * Simulated seconds of the flight: the app sets it before every step (thermals and gusts
   * drift with it; the simulation's own interface has no clock).
   */
  time = 0;
  /** The moving air: wind with height, terrain flow, thermals, gusts. */
  readonly airModel = new AirModel();
  private readonly terrain: AirTerrain = {
    height: (lon, lat) => {
      const s = this.world.ground(lon, lat);
      return s ? ellipsoidToSeaLevel(lon, lat, s.height) : undefined;
    },
  };
  private readonly flow: Vec3 = { x: 0, y: 0, z: 0 };

  get air_(): AirState {
    return this.state;
  }

  /** The weather changed (or the sun moved on): blends in over some seconds. */
  set air_(a: AirState) {
    this.state = a;
    this.airModel.setWeather(
      {
        windFromDeg: a.windFromDeg,
        windSpeed: a.windSpeed,
        sunElevationDeg: a.sunElevationDeg ?? 40,
        sunAzimuthDeg: a.sunAzimuthDeg,
        // Under a stratus deck no sun reaches the ground: no thermals.
        cloudCover: a.stratus ? 1 : (a.cloudCover ?? 0.3),
        temperature: a.temperature ?? 15,
        cloudBase: a.cloudBase,
      },
      this.time,
    );
  }

  /** Finer terrain arrived: the air follows the new shape gently. */
  terrainChanged() {
    this.airModel.terrainChanged();
  }

  geoidHeight(position: Vec3): number {
    const g = ecefToGeodetic(position, this.g);
    return geoidUndulation(g.lon, g.lat);
  }

  magneticDeclination(position: Vec3): number {
    const g = ecefToGeodetic(position, this.g);
    return magneticDeclination(g.lon, g.lat);
  }
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
    const s = this.state;
    const h = ellipsoidToSeaLevel(g.lon, g.lat, g.h);
    const a = isa(h, s.isaDeviation);
    out.density = a.density;
    out.temperature = a.temperature;
    out.pressure = a.pressure;
    // In cloud or precipitation: ice builds below freezing.
    const inStratus = s.stratus !== undefined && h > s.stratus.base && h < s.stratus.top;
    const inCumulus =
      (s.cloudCover ?? 0) > 0.5 && h > (s.cloudBase ?? Infinity) && h < (s.cloudTop ?? -Infinity);
    const below = h < (s.stratus?.top ?? s.cloudTop ?? 0);
    out.moisture = inStratus || inCumulus ? 1 : below ? (s.precipitation ?? 0) : 0;
    // East, north and up at the place, in ECEF.
    const f = this.airModel.sample(g.lon, g.lat, h, this.time, this.terrain, this.flow);
    const sl = Math.sin(g.lon * RAD);
    const cl = Math.cos(g.lon * RAD);
    const sp = Math.sin(g.lat * RAD);
    const cp = Math.cos(g.lat * RAD);
    out.wind.x = -sl * f.x - sp * cl * f.y + cp * cl * f.z;
    out.wind.y = cl * f.x - sp * sl * f.y + cp * sl * f.z;
    out.wind.z = cp * f.y + sp * f.z;
    return out;
  }

  /** Where the runway was last looked up, and its direction there (degrees per metre). */
  private readonly strip = { lon: 999, lat: 999, on: false, dLon: 0, dLat: 0 };

  /** The direction of the runway the place lies on, or undefined off a runway. */
  private runwayAt(lon: number, lat: number) {
    const c = this.strip;
    const k = Math.cos(lat * RAD) * EARTH_R * RAD;
    const moved = Math.hypot((lon - c.lon) * k, (lat - c.lat) * EARTH_R * RAD);
    if (moved < STRIP_RECHECK) return c.on ? c : undefined;
    c.lon = lon;
    c.lat = lat;
    c.on = false;
    for (const { airport } of airportsNear(lon, lat, 6000)) {
      for (const runway of airport.runways) {
        const [a, b] = runway.ends;
        const bx = (b.lon - a.lon) * k;
        const by = (b.lat - a.lat) * EARTH_R * RAD;
        const len = Math.hypot(bx, by);
        if (len < 1) continue;
        const ux = bx / len;
        const uy = by / len;
        const px = (lon - a.lon) * k;
        const py = (lat - a.lat) * EARTH_R * RAD;
        const along = px * ux + py * uy;
        const cross = px * uy - py * ux;
        // A little more than the strip: the recheck distance and the shoulders.
        if (along < -60 || along > len + 60 || Math.abs(cross) > runway.width / 2 + 30) continue;
        c.on = true;
        c.dLon = ux / k;
        c.dLat = uy / (EARTH_R * RAD);
        return c;
      }
    }
    return undefined;
  }

  ground(position: Vec3): GroundSample | undefined {
    const g = ecefToGeodetic(position, this.g);
    const s = this.world.ground(g.lon, g.lat);
    if (!s) return undefined;
    // A runway is graded: the terrain model under it is not (a road crossing it stands 20 cm
    // proud at Buochs, enough to break a nose gear at take-off speed). The wheels roll on the
    // terrain averaged along the runway.
    let height = s.height;
    const strip = this.runwayAt(g.lon, g.lat);
    if (strip) {
      let n = 1;
      for (const d of RUNWAY_SMOOTHING) {
        const q = this.world.ground(g.lon + d * strip.dLon, g.lat + d * strip.dLat);
        if (!q) continue;
        height += q.height;
        n++;
      }
      height /= n;
    }
    // The normal comes in render space (x east, y up, z south of the frame's origin).
    const o = this.frame().origin;
    const sl = Math.sin(o.lon * RAD);
    const cl = Math.cos(o.lon * RAD);
    const sp = Math.sin(o.lat * RAD);
    const cp = Math.cos(o.lat * RAD);
    const { x, y, z } = s.normal;
    return {
      height: height + this.heightOffset,
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
