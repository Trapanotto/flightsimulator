/**
 * The moving air of the Alps as a pure model: given the weather of the moment and a way to
 * ask for terrain heights, the velocity of the air (east, north, up, m/s) at any point and
 * time. It adds, on top of the large-scale wind:
 *
 * 1. the boundary layer: surface wind strengthening and veering with height above ground;
 * 2. terrain flow: ridge lift, lee sink and rotors, speed-up over crests, shelter in valleys,
 *    deflection round blocking terrain in stable air, at two length scales;
 * 3. thermals over sunlit ground, stronger on slopes facing the sun, drifting with the wind;
 * 4. slope and valley breezes, up by day and down by night;
 * 5. continuous turbulence (Dryden spectra) whose intensity follows wind, terrain roughness,
 *    lee rotors and convection.
 *
 * Deterministic: everything is a function of place, time, weather and seed. The model keeps
 * caches (terrain fits, weather blend), but they never change the answer for a given input,
 * with one exception that is the point of them: when terrain appears or changes, the terrain
 * effects move to the new values over a few seconds instead of jumping.
 *
 * Cheap: per call a handful of cached lattice lookups, 56 cosines for the gusts and nine
 * hashed thermal cells; terrain is only sampled when the position reaches lattice nodes it has
 * not seen (a few samples per 250 m flown). Nothing is allocated per call.
 */
import { clamp, smoothstep } from '../math';
import type { Vec3 } from '../types';
import { GustField, type Gust } from './turbulence';
import { ThermalField, thermalShape } from './thermals';
import {
  type AirTerrain,
  F_A,
  F_GX,
  F_GY,
  F_H,
  F_R,
  F_V,
  F_XX,
  F_XY,
  F_YY,
  NF,
  Projection,
  TerrainField,
} from './terrainField';

/** The weather the air is made from. */
export interface AirWeather {
  /** Surface wind (10 m above open ground, as reported): direction it blows from, degrees true. */
  windFromDeg: number;
  /** Surface wind speed, m/s. */
  windSpeed: number;
  /**
   * Multiplier on the mechanical turbulence, default 1 (what the wind alone gives). From a
   * report with gusts G over a mean wind V, about 1 + (G - V) / V is a fair choice.
   */
  gustiness?: number;
  /** Sun above the horizon, degrees (negative at night). */
  sunElevationDeg: number;
  /** Direction of the sun, degrees true; default 180 (south, noon). */
  sunAzimuthDeg?: number;
  /** Cloud cover 0 (clear) .. 1 (overcast). */
  cloudCover: number;
  /** Surface air temperature, °C. Carries the season: cold ground heats the air little. */
  temperature: number;
  /** Surface dew point, °C: sets the base of convective cloud (Espy, 125 m per K of spread). */
  dewPoint?: number;
  /** Base of convective cloud, metres above sea level; overrides the dew point estimate. */
  cloudBase?: number;
  /**
   * Static stability -1 (convective) .. 0 (neutral) .. 1 (strong inversion). Default: from
   * sun, cloud and wind, the way the Pasquill classes are read off.
   */
  stability?: number;
}

export interface AirModelOptions {
  /** Seed of the thermals and the turbulence. */
  seed?: number;
  /**
   * Reference of the internal projection, degrees; default the middle of Switzerland. The air
   * does not depend on it beyond the projection's small scale error far from it.
   */
  origin?: { lon: number; lat: number };
  /** Seconds over which a new weather blends in (default 20); 0 switches at once. */
  weatherBlend?: number;
}

/** The parts of the last sample, for a debug view or an explanation to the pilot. */
export interface AirComponents {
  /** Terrain height below, m above sea level; NaN while unknown. */
  ground: number;
  /** Height above that ground used by the model, m (a nominal 300 m while terrain is unknown). */
  agl: number;
  /** 0..1: how far the terrain effects are in (0 while the terrain is not loaded). */
  terrainKnown: number;
  /** Steady horizontal wind with height and terrain flow, without breezes and gusts, m/s. */
  windEast: number;
  windNorth: number;
  /** Slope and valley breeze, m/s. */
  breezeEast: number;
  breezeNorth: number;
  /** Vertical parts, m/s: terrain flow (ridge lift, lee sink), thermals, slope breeze, gust. */
  terrainUp: number;
  thermalUp: number;
  breezeUp: number;
  gustEast: number;
  gustNorth: number;
  gustUp: number;
  /** Standard deviations of the gusts the model aims at, m/s (horizontal, vertical). */
  sigmaHorizontal: number;
  sigmaVertical: number;
  /** Turbulence intensity 0 (smooth) .. about 0.3 light .. 0.6 moderate .. 1 severe. */
  turbulence: number;
  /** Top of the convective layer (thermals, cloud base), m above sea level; NaN at night. */
  thermalTop: number;
}

// Length scales of the terrain fields. The small one resolves single ridges and spurs, the
// large one valleys and mountain ranges.
const SMALL = 250;
const LARGE = 2000;
/** Height above the terrain feature over which its effect on the flow fades (1/e), m. */
const DECAY_SMALL = 400;
const DECAY_LARGE = 1500;
/**
 * Fraction of the terrain-following vertical velocity V·∇h the air actually takes. Below 1
 * because the flow partly separates and slows in front of steep slopes; tuned so that a 10 m/s
 * wind square onto a steep 500 m ridge gives 2 to 5 m/s of lift, the range glider pilots use
 * (Reichmann, "Cross-Country Soaring", ch. on slope soaring; Wallington, "Meteorology for
 * Glider Pilots", ch. 9: lift about wind speed times the sine of the slope at best, less on
 * gentle or broken slopes).
 */
const RIDGE_FACTOR = 0.6;
/**
 * Fractional speed-up over a crest per unit of (curvature × feature length). Jackson & Hunt
 * (1975, Q. J. R. Meteorol. Soc. 101) and the guidelines of Taylor & Lee (1984, Boundary-Layer
 * Meteorology 29) give ΔS ≈ 1.6 H/L for 2D ridges and 0.8 H/L for hills; for a bell-shaped
 * ridge H/L is about 0.6 × |h''| × L, so linear theory says about 1. It over-predicts on steep
 * slopes, where the flow separates, hence the smaller factor and the soft limit below.
 */
const CREST_FACTOR = 0.6;
/** Channelling through a gap or a valley aligned with the wind, relative to the crest term. */
const GAP_FACTOR = 0.3;
/** Nominal height above ground while the terrain is unknown, m. */
const DEFAULT_AGL = 300;
/** Top of the boundary layer, m above ground: above it the free flow. */
const GRADIENT_HEIGHT = 1000;
/**
 * Peak slope breeze and valley wind in calm weather, m/s (Whiteman 2000, "Mountain
 * Meteorology", ch. 10-11: 1 to 5 m/s).
 */
const SLOPE_WIND = 2.5;
const VALLEY_WIND = 3.5;
/** Thermals tilt downwind: horizontal offset per metre of height = wind / this climb rate. */
const LEAN_CLIMB = 3;
/** Mean wind of the convective layer relative to the surface wind: what the thermals drift with. */
const DRIFT_FACTOR = 1.6;
const FT = 0.3048;
/** Length of a 2D vector (Math.hypot is several times slower in V8, and this is hot). */
const len2 = (a: number, b: number) => Math.sqrt(a * a + b * b);
const DEG = Math.PI / 180;

// Derived weather, blended as numbers when the weather changes.
const P_WE = 0; // surface wind towards east, m/s
const P_WN = 1;
const P_DE = 2; // unit direction the surface wind blows towards (defined even in calm)
const P_DN = 3;
const P_ALPHA = 4; // power-law exponent of the wind profile
const P_VEER = 5; // veer from 10 m to the top of the boundary layer, rad
const P_N = 6; // Brunt-Väisälä frequency, 1/s
const P_HFLAT = 7; // sensible heat flux on flat ground, W/m²
const P_COOL = 8; // night cooling 0..1
const P_SE = 9; // sun unit vector east, north, up
const P_SN = 10;
const P_SU = 11;
const P_DEPTH = 12; // convective layer depth, m above ground
const P_BASE = 13; // cloud base, m above sea level, NaN if not given
const P_GUST = 14;
const P_TK = 15; // temperature, K
const P_CONV = 16; // convection allowed 0..1 (none under overcast)
const P_PROFTOP = 17; // profile factor at the top of the boundary layer
const P_W20 = 18; // profile factor at 20 ft
const NP = 19;

/** Weather as the numbers the model uses. */
function derive(w: AirWeather, out: Float64Array): Float64Array {
  const to = (w.windFromDeg + 180) * DEG;
  const speed = Math.max(0, w.windSpeed);
  out[P_DE] = Math.sin(to);
  out[P_DN] = Math.cos(to);
  out[P_WE] = out[P_DE]! * speed;
  out[P_WN] = out[P_DN]! * speed;
  const elev = w.sunElevationDeg;
  const cloud = clamp(w.cloudCover, 0, 1);
  // Global radiation: clear sky after Holtslag & van Ulden (1983, J. Clim. Appl. Meteorol. 22),
  // K = 1041 sin(elevation) - 69 W/m², reduced by cloud after Kasten & Czeplak (1980, Solar
  // Energy 24): factor 1 - 0.75 N^3.4.
  const radiation =
    Math.max(0, 1041 * Math.sin(elev * DEG) - 69) * (1 - 0.75 * Math.pow(cloud, 3.4));
  // Sensible heat is some 15-35 % of it over land (Bowen ratios of summer meadows to wet or
  // snowy winter ground, Stull 1988 ch. 7); the temperature carries the season.
  const sensible = 0.15 + 0.2 * smoothstep(-5, 20, w.temperature);
  const hflat = sensible * radiation;
  out[P_HFLAT] = hflat;
  // Clear nights cool the ground from shortly before sunset (net radiation turns negative).
  out[P_COOL] = (1 - cloud) * smoothstep(8, -2, elev);
  const az = (w.sunAzimuthDeg ?? 180) * DEG;
  out[P_SE] = Math.cos(elev * DEG) * Math.sin(az);
  out[P_SN] = Math.cos(elev * DEG) * Math.cos(az);
  out[P_SU] = Math.sin(elev * DEG);
  // Convective layer depth: from the dew point spread (Espy: cumulus base 125 m per K), else
  // a stand-in for how deep a day's heating mixes (about 600 m in winter, 1400 m in summer).
  out[P_DEPTH] =
    w.dewPoint !== undefined
      ? clamp(125 * (w.temperature - w.dewPoint), 0, 3500)
      : clamp(400 + 4 * hflat, 400, 2500);
  out[P_BASE] = w.cloudBase ?? NaN;
  out[P_GUST] = Math.max(0, w.gustiness ?? 1);
  out[P_TK] = w.temperature + 273.15;
  out[P_CONV] = 1 - smoothstep(0.7, 1, cloud);
  let stab = w.stability;
  if (stab === undefined) {
    // Pasquill-like: strong sun makes it convective, clear calm nights stable, wind and cloud
    // neutral.
    const heat = clamp(hflat / 150, 0, 1);
    const mix = 1 / (1 + (speed / 5) ** 2);
    stab = (0.9 * out[P_COOL]! - 0.9 * heat) * (0.3 + 0.7 * mix);
  }
  stab = clamp(stab, -1, 1);
  // Hellmann exponents of the wind profile: about 0.1 unstable, 1/7 neutral, 0.3 stable
  // (Counihan 1975, Atmos. Environ. 9; Stull 1988 ch. 9). Veer across the Ekman layer over
  // land 20-40°, less when convection mixes momentum (Holton, "Dynamic Meteorology", 5.3).
  out[P_ALPHA] = stab < 0 ? 0.16 + 0.06 * stab : 0.16 + 0.14 * stab;
  out[P_VEER] = (25 + 15 * stab) * DEG;
  out[P_N] = 0.01 + 0.008 * stab;
  return out;
}

/**
 * The air mass (thermals, frozen turbulence) drifts with the mean wind of the convective
 * layer: about 1.6 times the surface wind, turned by half the veer.
 */
const driftEast = (p: Float64Array) => {
  const a = p[P_VEER]! / 2;
  return DRIFT_FACTOR * (p[P_WE]! * Math.cos(a) + p[P_WN]! * Math.sin(a));
};
const driftNorth = (p: Float64Array) => {
  const a = p[P_VEER]! / 2;
  return DRIFT_FACTOR * (-p[P_WE]! * Math.sin(a) + p[P_WN]! * Math.cos(a));
};

export class AirModel {
  /** Parts of the last sample (overwritten by each call). */
  readonly last: AirComponents = {
    ground: NaN,
    agl: DEFAULT_AGL,
    terrainKnown: 0,
    windEast: 0,
    windNorth: 0,
    breezeEast: 0,
    breezeNorth: 0,
    terrainUp: 0,
    thermalUp: 0,
    breezeUp: 0,
    gustEast: 0,
    gustNorth: 0,
    gustUp: 0,
    sigmaHorizontal: 0,
    sigmaVertical: 0,
    turbulence: 0,
    thermalTop: NaN,
  };
  private readonly seed: number;
  private readonly projection: Projection;
  private readonly small: TerrainField;
  private readonly large: TerrainField;
  private readonly gusts: GustField;
  private readonly thermals: ThermalField;
  private readonly blendTime: number;
  private hasWeather = false;
  private readonly from = new Float64Array(NP);
  private readonly to = new Float64Array(NP);
  private readonly p = new Float64Array(NP);
  private blendStart = -Infinity;
  private paramsTime = NaN;
  // Drift of the air mass (thermals, frozen turbulence): offset at driftTime plus velocity.
  private driftX = 0;
  private driftY = 0;
  private driftVX = 0;
  private driftVY = 0;
  private driftTime = 0;
  private withGusts = true;
  private terrain: AirTerrain | undefined;
  private readonly fs = new Float64Array(NF);
  private readonly fl = new Float64Array(NF);
  private readonly fs2 = new Float64Array(NF);
  private readonly fl2 = new Float64Array(NF);
  private readonly fu = new Float64Array(NF);
  private readonly gust: Gust = { u: 0, v: 0, w: 0 };
  private readonly scratch: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(options: AirModelOptions = {}) {
    this.seed = (options.seed ?? 1) >>> 0;
    const o = options.origin ?? { lon: 8.23, lat: 46.8 };
    this.projection = new Projection(o.lon, o.lat);
    this.small = new TerrainField(SMALL, 6, 0, this.projection);
    this.large = new TerrainField(LARGE, 5, LARGE / 4, this.projection);
    this.gusts = new GustField(this.seed);
    this.thermals = new ThermalField(this.seed);
    this.blendTime = options.weatherBlend ?? 20;
    this.setWeather({
      windFromDeg: 0,
      windSpeed: 0,
      sunElevationDeg: -20,
      cloudCover: 0,
      temperature: 15,
    });
    this.hasWeather = false;
  }

  /** Terrain samples taken so far (for tests and profiling). */
  get terrainSamples(): number {
    return this.small.probes + this.large.probes;
  }

  /**
   * Sets the weather. With `time` (simulated seconds, the clock passed to sample) the change
   * blends in over `weatherBlend` seconds and the drifting thermals and gusts carry on from
   * where they are; without it, or the first time, it applies at once.
   */
  setWeather(weather: AirWeather, time?: number) {
    const blend = this.hasWeather && time !== undefined && this.blendTime > 0;
    // What the air shows now is where the blend starts.
    if (blend) this.from.set(this.params(time));
    derive(weather, this.to);
    if (blend) {
      this.blendStart = time;
    } else {
      this.from.set(this.to);
      this.blendStart = -Infinity;
    }
    if (time !== undefined) this.moveDrift(time);
    this.hasWeather = true;
    this.paramsTime = NaN;
    // The drift velocity may change at once: the drifted position stays continuous.
    this.driftVX = driftEast(this.to);
    this.driftVY = driftNorth(this.to);
  }

  /** The terrain changed (finer data arrived): its effects move to the new shape over seconds. */
  terrainChanged() {
    this.small.invalidate();
    this.large.invalidate();
  }

  private moveDrift(time: number) {
    this.driftX += this.driftVX * (time - this.driftTime);
    this.driftY += this.driftVY * (time - this.driftTime);
    this.driftTime = time;
  }

  private params(t: number): Float64Array {
    if (t === this.paramsTime) return this.p;
    const f =
      this.blendStart === -Infinity
        ? 1
        : smoothstep(this.blendStart, this.blendStart + this.blendTime, t);
    const p = this.p;
    for (let k = 0; k < NP; k++) p[k] = this.from[k]! + (this.to[k]! - this.from[k]!) * f;
    p[P_PROFTOP] = Math.pow(GRADIENT_HEIGHT / 10, p[P_ALPHA]!);
    p[P_W20] = Math.pow((20 * FT) / 10, p[P_ALPHA]!);
    if (Number.isNaN(p[P_BASE]!)) p[P_BASE] = f < 0.5 ? this.from[P_BASE]! : this.to[P_BASE]!;
    const dl = len2(p[P_DE]!, p[P_DN]!);
    if (dl > 1e-6) {
      p[P_DE] = p[P_DE]! / dl;
      p[P_DN] = p[P_DN]! / dl;
    } else {
      p[P_DE] = this.to[P_DE]!;
      p[P_DN] = this.to[P_DN]!;
    }
    this.paramsTime = t;
    return p;
  }

  /**
   * Velocity of the air at a point: x east, y north, z up, m/s, written into `out`.
   *
   * @param lon, lat degrees; `height` metres above sea level; `time` simulated seconds (the
   *   same clock for every call: thermals live, gusts evolve and the air mass drifts with it).
   * @param terrain heights above sea level; where it returns undefined the terrain effects
   *   (and thermals and breezes, which need the ground) fade to none.
   */
  sample(
    lon: number,
    lat: number,
    height: number,
    time: number,
    terrain: AirTerrain,
    out: Vec3,
  ): Vec3 {
    if (terrain !== this.terrain) {
      // Another world: nothing cached about the old one applies, not even to blend from.
      this.terrain = terrain;
      this.small.clear();
      this.large.clear();
    }
    const P = this.params(time);
    const L = this.last;
    const proj = this.projection;
    const x = proj.x(lon);
    const y = proj.y(lat);
    const z = height;

    // Terrain at both scales at the point.
    const fs = this.small.eval(x, y, time, terrain, this.fs);
    const fl = this.large.eval(x, y, time, terrain, this.fl);
    const known = fs[F_V]!;
    const knownL = fl[F_V]!;
    const ground = known > 1e-9 ? fs[F_H]! / known : NaN;
    const aS = known > 1e-9 ? fs[F_A]! / known : z;
    const aL = knownL > 1e-9 ? fl[F_A]! / knownL : aS;
    const agl =
      known > 1e-9 ? DEFAULT_AGL + (Math.max(z - ground, 0) - DEFAULT_AGL) * known : DEFAULT_AGL;

    // 1. Boundary layer: power law up to the gradient height (a smooth minimum keeps the
    //    profile free of kinks), the wind turning clockwise with height (Ekman spiral, northern
    //    hemisphere) as it gains speed.
    const alpha = P[P_ALPHA]!;
    const ze = Math.max(agl, 1.5);
    const zr = ze / GRADIENT_HEIGHT;
    const zs = ze / Math.sqrt(Math.sqrt(1 + zr * zr * zr * zr));
    const prof = Math.pow(zs / 10, alpha);
    const profTop = P[P_PROFTOP]!;
    const veer = P[P_VEER]! * clamp((prof - 1) / (profTop - 1), 0, 1);
    const cv = Math.cos(veer);
    const sv = Math.sin(veer);
    let ve = prof * (P[P_WE]! * cv + P[P_WN]! * sv);
    let vn = prof * (-P[P_WE]! * sv + P[P_WN]! * cv);
    const U = len2(ve, vn);
    const wx = U > 1e-9 ? ve / U : P[P_DE]!;
    const wy = U > 1e-9 ? vn / U : P[P_DN]!;

    // 2. Terrain flow. The slope that lifts the air is read a little downstream, because the
    //    air starts rising before it reaches the slope: the best lift is upwind of the crest.
    const reach = smoothstep(0, 1, U);
    const fs2 = this.small.eval(
      x + wx * reach * 0.25 * SMALL,
      y + wy * reach * 0.25 * SMALL,
      time,
      terrain,
      this.fs2,
    );
    const fl2 = this.large.eval(
      x + wx * reach * 0.25 * LARGE,
      y + wy * reach * 0.25 * LARGE,
      time,
      terrain,
      this.fl2,
    );
    // The small scale sees only what the large one does not (band-pass), so a long mountain
    // flank is not counted twice.
    const gsx = fs2[F_GX]! - fl2[F_GX]!;
    const gsy = fs2[F_GY]! - fl2[F_GY]!;
    const glx = fl2[F_GX]!;
    const gly = fl2[F_GY]!;
    const dS = Math.exp(-Math.max(z - aS, 0) / DECAY_SMALL);
    const dL = Math.exp(-Math.max(z - aL, 0) / DECAY_LARGE);
    // Curvature along and across the wind (negative along = crest across the wind).
    const sxx = fs[F_XX]! - fl[F_XX]!;
    const syy = fs[F_YY]! - fl[F_YY]!;
    const sxy = fs[F_XY]! - fl[F_XY]!;
    const lxx = fl[F_XX]!;
    const lyy = fl[F_YY]!;
    const lxy = fl[F_XY]!;
    const alongS = sxx * wx * wx + 2 * sxy * wx * wy + syy * wy * wy;
    const acrossS = sxx * wy * wy - 2 * sxy * wx * wy + syy * wx * wx;
    const alongL = lxx * wx * wx + 2 * lxy * wx * wy + lyy * wy * wy;
    const acrossL = lxx * wy * wy - 2 * lxy * wx * wy + lyy * wx * wx;
    const speedUp =
      dS * 2 * SMALL * (-CREST_FACTOR * alongS + GAP_FACTOR * CREST_FACTOR * Math.max(acrossS, 0)) +
      dL * 2 * LARGE * (-CREST_FACTOR * alongL + GAP_FACTOR * CREST_FACTOR * Math.max(acrossL, 0));
    // Soft limits: at most about 1.8 times the wind over a crest, 0.55 of it deep in a valley.
    const factor = Math.exp(0.6 * Math.tanh(speedUp / 0.6));
    ve *= factor;
    vn *= factor;
    // Stable air with too little energy to climb the terrain (Froude number U / (N H) below
    // about 1) goes round it instead: the component into the slope is taken away near the
    // ground (Smith 1979, "The influence of mountains on the atmosphere", Adv. Geophys. 21).
    const N = P[P_N]!;
    // The height the air has to climb is that of the whole obstacle: the local slope's share
    // plus how far the local terrain stands above its smoothed surroundings, or the relief the
    // large scale shows, whichever is more.
    const relief = Math.max(
      2 * SMALL * len2(fs[F_GX]!, fs[F_GY]!) + Math.abs(aS - aL),
      2 * LARGE * len2(glx, gly) + LARGE * LARGE * Math.abs(alongL),
    );
    const froude = U / (N * relief + 1e-6);
    const block = 0.85 * (1 - smoothstep(0.3, 1.5, froude));
    ({ ve, vn } = this.deflect(ve, vn, gsx, gsy, block * dS));
    ({ ve, vn } = this.deflect(ve, vn, glx, gly, block * dL));
    // Air follows the terrain: vertical velocity V·∇h, fading with height above it.
    const terrainUp = RIDGE_FACTOR * (dS * (ve * gsx + vn * gsy) + dL * (ve * glx + vn * gly));

    // 4. Slope and valley breezes: thermally driven, so only in light synoptic wind.
    const U10 = len2(P[P_WE]!, P[P_WN]!);
    const calm = known / (1 + (U10 / 4) ** 2);
    const gx = fs[F_GX]!;
    const gy = fs[F_GY]!;
    const gmag = len2(gx, gy);
    const sunUp = P[P_SU]!;
    // Insolation of the slope relative to flat ground: cosine of the sun's incidence on the
    // slope over the sine of its elevation (Whiteman 2000, ch. 12).
    const nz = 1 / Math.sqrt(1 + gmag * gmag);
    const inc = Math.max(0, (-gx * P[P_SE]! - gy * P[P_SN]! + sunUp) * nz);
    const slopeRatio = sunUp > 0 ? clamp(inc / Math.max(sunUp, 0.1), 0, 2.5) : 0;
    const hflat = P[P_HFLAT]!;
    const cool = P[P_COOL]!;
    const slopeDrive = clamp((hflat * slopeRatio) / 200, 0, 1.5) - cool;
    const valleyDrive = clamp(hflat / 200, 0, 1.5) - cool;
    let be = 0;
    let bn = 0;
    let breezeUp = 0;
    if (calm > 1e-4) {
      if (gmag > 1e-6) {
        // Anabatic layers are some 50-150 m deep, katabatic ones 10-50 m.
        const depth = slopeDrive > 0 ? 80 : 30;
        const a = Math.max(agl, 0);
        const v =
          SLOPE_WIND *
          slopeDrive *
          calm *
          smoothstep(0.03, 0.25, gmag) *
          (a / (a + 3)) *
          Math.exp(-a / depth);
        be += (v * gx) / gmag;
        bn += (v * gy) / gmag;
        breezeUp += v * gmag;
      }
      // Valley axis: the direction of least curvature of a valley (concave across it), up
      // the valley where the floor rises.
      const tr = 0.5 * (lxx + lyy);
      const dd = Math.sqrt(0.25 * (lxx - lyy) ** 2 + lxy * lxy);
      const l1 = tr + dd;
      const l2 = tr - dd;
      const valley = smoothstep(2e-5, 1.5e-4, l1) * smoothstep(1e-5, 8e-5, l1 - l2);
      if (valley > 0) {
        let axx = lxy;
        let axy = l2 - lxx;
        if (Math.abs(lxx - l2) < Math.abs(lyy - l2)) {
          axx = l2 - lyy;
          axy = lxy;
        }
        const al = len2(axx, axy);
        if (al > 1e-12) {
          axx /= al;
          axy /= al;
          const up = Math.tanh((axx * fl[F_GX]! + axy * fl[F_GY]!) / 0.01);
          const a = Math.max(agl, 0);
          const v =
            VALLEY_WIND * valleyDrive * calm * valley * up * (a / (a + 10)) * Math.exp(-a / 300);
          be += v * axx;
          bn += v * axy;
        }
      }
    }

    // 3. Thermals. Strength from the convective velocity scale w* = (g/T · H/(ρ cp) · zi)^(1/3)
    //    (Deardorff 1970, J. Atmos. Sci. 27); slopes facing the sun feed stronger ones.
    const aRef = knownL > 1e-9 ? aL : aS;
    const base = P[P_BASE]!;
    const top = Number.isNaN(base) ? aRef + P[P_DEPTH]! : base;
    let thermalUp = 0;
    let wStar = 0;
    let zeta = 0;
    let src = 0;
    const conv = P[P_CONV]! * known;
    if (hflat > 1 && conv > 0 && !Number.isNaN(ground)) {
      const zi = clamp(top - aRef, 0, 3000);
      wStar = Math.cbrt(((9.81 / P[P_TK]!) * hflat * zi) / (1.1 * 1005));
      src = clamp(0.4 + 0.6 * slopeRatio, 0, 1.6);
      const span = top - ground;
      // Strong wind breaks thermals up.
      const windCut = 1 - 0.7 * smoothstep(6, 14, U10 * DRIFT_FACTOR);
      const amp = 1.2 * wStar * src * windCut * conv * smoothstep(150, 400, span);
      if (amp > 0 && span > 0) {
        zeta = (z - ground) / span;
        const shape = thermalShape(zeta);
        if (shape > 0) {
          // The lean uses the blended wind: it is an offset, so it must not jump.
          const lean = Math.max(z - ground, 0) / LEAN_CLIMB;
          const dx = this.driftX + this.driftVX * (time - this.driftTime) + driftEast(P) * lean;
          const dy = this.driftY + this.driftVY * (time - this.driftTime) + driftNorth(P) * lean;
          thermalUp = amp * shape * this.thermals.value(x - dx, y - dy, time);
        }
      }
    }

    // 5. Turbulence. Mechanical part after MIL-F-8785C 3.7.2.3 (low altitude, below 1000 ft):
    //    σw = 0.1 W20, σu = σv = σw / (0.177 + 0.000823 h)^0.4, Lw = h,
    //    Lu = Lv = h / (0.177 + 0.000823 h)^1.2 (h and L in feet); above 2000 ft L = 1750 ft
    //    and linear in between. Above that height the mechanical turbulence dies away slowly
    //    towards the light values of the free atmosphere (our simplification of the
    //    standard's exceedance curves).
    const W20 = U10 * P[P_W20]! * P[P_GUST]!;
    const hft = Math.max(agl / FT, 10);
    let sw: number;
    let su: number;
    let Lu: number;
    let Lw: number;
    if (hft <= 1000) {
      const q = 0.177 + 0.000823 * hft;
      sw = 0.1 * W20;
      su = sw / Math.pow(q, 0.4);
      Lw = hft * FT;
      Lu = (hft / Math.pow(q, 1.2)) * FT;
    } else {
      const f = Math.min((hft - 1000) / 1000, 1);
      const fade = Math.max(0.4, 1 - Math.max(agl - 610, 0) / 3000);
      sw = 0.1 * W20 * fade;
      su = sw;
      Lw = (1000 + 750 * f) * FT;
      Lu = Lw;
    }
    // Rough terrain upwind stirs the low-level flow (up to about twice the open-country value).
    const fu = this.small.eval(x - wx * 400, y - wy * 400, time, terrain, this.fu);
    const rough = fu[F_R]!;
    const roughFactor = 1 + smoothstep(5, 60, rough) * Math.exp(-agl / 600);
    sw *= roughFactor;
    su *= roughFactor;
    // Lee rotor: below crest height downwind of a steep slope in a moderate or strong wind.
    const leeSlope = -(wx * (fs[F_GX]! - fl[F_GX]!) + wy * (fs[F_GY]! - fl[F_GY]!));
    const rotor =
      0.25 *
      U *
      smoothstep(0.08, 0.35, leeSlope) *
      smoothstep(4, 10, U) *
      Math.exp(-Math.max(z - aS, 0) / 250);
    // Convective turbulence (Lenschow et al. 1980, J. Atmos. Sci. 37):
    // σw / w* = 1.8 ζ^(2/3) (1 - 0.8 ζ)², σu / w* ≈ 0.6 in the mixed layer; half of it,
    // because the thermal pattern above already carries the large eddies.
    let cw = 0;
    let cu = 0;
    if (wStar > 0 && zeta > 0 && zeta < 1.1) {
      const zz = Math.min(zeta, 1);
      const fade = zeta <= 1 ? 1 : 1 - smoothstep(1, 1.1, zeta);
      cw = 0.5 * wStar * src * 1.8 * Math.pow(zz, 2 / 3) * (1 - 0.8 * zz) ** 2 * fade * conv;
      cu = 0.5 * wStar * src * 0.6 * fade * conv * Math.cbrt(Math.min(zz / 0.1, 1));
    }
    // Even calm stable air is never perfectly smooth.
    const floor = 0.05;
    const sigW = Math.sqrt(sw * sw + rotor * rotor + cw * cw + floor * floor);
    const sigU = Math.sqrt(su * su + rotor * rotor + cu * cu + floor * floor);
    let ge = 0;
    let gn = 0;
    let gw = 0;
    if (this.withGusts) {
      const dx = this.driftX + this.driftVX * (time - this.driftTime);
      const dy = this.driftY + this.driftVY * (time - this.driftTime);
      const g = this.gusts.sample(x - dx, y - dy, z, time, Lu, Lw, this.gust);
      // u along the surface wind, v to its left.
      const de = P[P_DE]!;
      const dn = P[P_DN]!;
      ge = sigU * (g.u * de - g.v * dn);
      gn = sigU * (g.u * dn + g.v * de);
      gw = sigW * g.w;
    }

    out.x = ve + be + ge;
    out.y = vn + bn + gn;
    out.z = terrainUp + thermalUp + breezeUp + gw;

    L.ground = ground;
    L.agl = agl;
    L.terrainKnown = known;
    L.windEast = ve;
    L.windNorth = vn;
    L.breezeEast = be;
    L.breezeNorth = bn;
    L.terrainUp = terrainUp;
    L.thermalUp = thermalUp;
    L.breezeUp = breezeUp;
    L.gustEast = ge;
    L.gustNorth = gn;
    L.gustUp = gw;
    L.sigmaHorizontal = sigU;
    L.sigmaVertical = sigW;
    // Light turbulence is σ about 1 m/s, moderate 2, severe 3.5 and more (MIL-F-8785C fig. 7).
    L.turbulence = clamp(Math.sqrt((2 * sigU * sigU + sigW * sigW) / 3) / 3.5, 0, 1);
    L.thermalTop = hflat > 1 ? top : NaN;
    return out;
  }

  /**
   * Takes away the part of the wind that runs into the slope g, by the fraction `block`.
   * Proportional to |g|² near flat ground, so the direction of g, undefined there, never shows.
   */
  private deflect(
    ve: number,
    vn: number,
    gx: number,
    gy: number,
    block: number,
  ): { ve: number; vn: number } {
    const out = this.deflected;
    out.ve = ve;
    out.vn = vn;
    const g2 = gx * gx + gy * gy;
    if (g2 < 1e-12 || block <= 0) return out;
    const b = block * smoothstep(0, 0.05, Math.sqrt(g2));
    const into = (ve * gx + vn * gy) / g2;
    out.ve = ve - b * into * gx;
    out.vn = vn - b * into * gy;
    return out;
  }
  private readonly deflected = { ve: 0, vn: 0 };

  /** Turbulence intensity 0..1 at a point (see AirComponents.turbulence). */
  turbulenceAt(lon: number, lat: number, height: number, time: number, terrain: AirTerrain) {
    this.sample(lon, lat, height, time, terrain, this.scratch);
    return this.last.turbulence;
  }

  /**
   * Vertical air velocity without the random gusts (terrain flow, thermals, breezes) on an
   * n × n horizontal grid centred on a point, `spacing` metres apart, into out[j * n + i]
   * with i towards east and j towards north. `height` is above sea level, or above the
   * ground at each grid point when `aboveGround` is set. For a debug view: it may take
   * terrain samples well beyond those of a single sample.
   */
  verticalGrid(
    lon: number,
    lat: number,
    height: number,
    time: number,
    terrain: AirTerrain,
    spacing: number,
    n: number,
    out: Float32Array,
    aboveGround = false,
  ): Float32Array {
    const proj = this.projection;
    const x0 = proj.x(lon);
    const y0 = proj.y(lat);
    const c = (n - 1) / 2;
    this.withGusts = false;
    try {
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const pl = proj.lon(x0 + (i - c) * spacing);
          const pa = proj.lat(y0 + (j - c) * spacing);
          let v = this.sample(pl, pa, height, time, terrain, this.scratch).z;
          if (aboveGround && !Number.isNaN(this.last.ground))
            v = this.sample(pl, pa, this.last.ground + height, time, terrain, this.scratch).z;
          out[j * n + i] = v;
        }
    } finally {
      this.withGusts = true;
    }
    return out;
  }
}
