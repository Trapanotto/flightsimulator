/** Graphics presets (concept ch. 16) and user settings, stored in localStorage. */

import type { WeatherLook } from '../world/liveWeather';

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';
export const QUALITY_LEVELS: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];

export interface Quality {
  /** Always the full device resolution, capped at this pixel ratio (no downscaling). */
  maxPixelRatio: number;
  /** Terrain screen-space error threshold (px), max zoom and tile budget. */
  tau: number;
  maxZoom: number;
  maxTiles: number;
  terrainDetail: boolean;
  cloudLayers: number;
  /**
   * Ray-marched volumetric clouds (replace the flat layers): march steps, 0 = off. The same
   * clouds on every level; fewer steps only add noise that the frame accumulation smooths.
   */
  volumetricClouds: number;
  cloudShadows: boolean;
  /** Aircraft shadow map size, 0 = off. */
  shadowMap: number;
  bloom: boolean;
  smaa: boolean;
  flare: boolean;
  trails: boolean;
  /** Regional houses around the camera, metres (0 = off). */
  buildingRadius: number;
  /** Lakes and rivers as water surfaces (mask from the vector tiles). */
  water: boolean;
}

export const PRESETS: Record<QualityLevel, Quality> = {
  low: {
    maxPixelRatio: 2,
    tau: 9,
    maxZoom: 14,
    maxTiles: 260,
    terrainDetail: false,
    cloudLayers: 1,
    volumetricClouds: 32,
    cloudShadows: true,
    shadowMap: 0,
    bloom: false,
    smaa: false,
    flare: false,
    trails: false,
    buildingRadius: 1500,
    water: true,
  },
  medium: {
    maxPixelRatio: 2,
    tau: 6,
    maxZoom: 15,
    maxTiles: 400,
    terrainDetail: true,
    cloudLayers: 2,
    volumetricClouds: 40,
    cloudShadows: true,
    shadowMap: 1024,
    bloom: true,
    smaa: true,
    flare: true,
    trails: true,
    buildingRadius: 3000,
    water: true,
  },
  high: {
    maxPixelRatio: 2,
    tau: 4.5,
    maxZoom: 17,
    maxTiles: 560,
    terrainDetail: true,
    cloudLayers: 3,
    volumetricClouds: 48,
    cloudShadows: true,
    shadowMap: 2048,
    bloom: true,
    smaa: true,
    flare: true,
    trails: true,
    buildingRadius: 4500,
    water: true,
  },
  ultra: {
    maxPixelRatio: 2,
    tau: 3.5,
    maxZoom: 18,
    maxTiles: 720,
    terrainDetail: true,
    cloudLayers: 4,
    volumetricClouds: 64,
    cloudShadows: true,
    shadowMap: 2048,
    bloom: true,
    smaa: true,
    flare: true,
    trails: true,
    buildingRadius: 6000,
    water: true,
  },
};

export type TrafficMode = 'auto' | 'sim' | 'off';
export type TimeOfDay = 'real' | 'morning' | 'noon' | 'golden';
/** `live`: real weather at the aircraft (Open-Meteo); until it arrives it looks like `fair`. */
export type Weather = 'live' | 'clear' | 'fair' | 'cloudy' | 'hochnebel' | 'nebel';
export const WEATHER_COVERAGE: Record<Weather, number> = {
  live: 0.38,
  clear: 0,
  fair: 0.38,
  cloudy: 0.62,
  hochnebel: 0.04,
  nebel: 0.18,
};

/**
 * Stratus layer of the weather (metres above sea level, extinction per metre), or null.
 * Hochnebel: the autumn/winter sea of fog over the Mittelland, the Alps above it in sunshine.
 * Nebel: ground fog in the lowlands up to ~640 m.
 */
/** Haze of the weather: Mie scattering at sea level (1/m). Visibility ~ 3.9 / (1.1 x this). */
export const WEATHER_HAZE: Record<Weather, number> = {
  live: 1.6e-5,
  clear: 0.9e-5,
  fair: 1.6e-5,
  cloudy: 2.6e-5,
  hochnebel: 2.4e-5,
  nebel: 3.2e-5,
};

/** Cumulus layer of the weather (base and top, metres above sea level). */
export const WEATHER_CLOUDS: Record<Weather, { base: number; top: number }> = {
  live: { base: 2300, top: 3700 },
  clear: { base: 2600, top: 3600 },
  fair: { base: 2300, top: 3700 },
  cloudy: { base: 1700, top: 3500 },
  hochnebel: { base: 2600, top: 3400 },
  nebel: { base: 2200, top: 3300 },
};

export const WEATHER_FOG: Record<Weather, { top: number; base: number; density: number } | null> = {
  live: null,
  clear: null,
  fair: null,
  cloudy: null,
  hochnebel: { top: 1100, base: 750, density: 1 / 55 },
  nebel: { top: 640, base: -500, density: 1 / 45 },
};

/** Surface wind of the fixed weather presets (from WSW, the usual Swiss westerly), m/s. */
export const WEATHER_WIND: Record<Weather, number> = {
  live: 4,
  clear: 3,
  fair: 4,
  cloudy: 7,
  hochnebel: 2,
  nebel: 1,
};

/** The look of a fixed weather preset (`live` falls back to `fair` until data arrives). */
export function weatherPreset(w: Weather): WeatherLook {
  const fog = WEATHER_FOG[w];
  return {
    coverage: WEATHER_COVERAGE[w],
    base: WEATHER_CLOUDS[w].base,
    top: WEATHER_CLOUDS[w].top,
    mie: WEATHER_HAZE[w],
    fog: fog ? { ...fog } : null,
    windFrom: 245,
    windSpeed: WEATHER_WIND[w],
    gusts: WEATHER_WIND[w] * 1.5,
    temperature: 12,
    isaDeviation: 0,
    visibility: 3.9 / (1.1 * WEATHER_HAZE[w]),
    cloudCover: Math.round(WEATHER_COVERAGE[w] * 120),
    code: 0,
  };
}

export interface Settings {
  /** 'auto' picks a level from the GPU. */
  quality: QualityLevel | 'auto';
  time: TimeOfDay;
  weather: Weather;
  /** Other aircraft: real (if a relay is configured, else simulated), simulated, none. */
  traffic: TrafficMode;
  invertPitch: boolean;
  sound: boolean;
  /** 0..1 */
  volume: number;
}

const KEY = 'tfs.settings';
const DEFAULTS: Settings = {
  quality: 'auto',
  time: 'real',
  weather: 'live',
  traffic: 'auto',
  invertPitch: false,
  sound: true,
  volume: 0.7,
};

export function loadSettings(): Settings {
  let s: Settings = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) s = { ...s, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // Storage blocked or corrupt: defaults.
  }
  // URL overrides for testing and sharing: ?quality=high&t=19:00&weather=cloudy
  const q = new URLSearchParams(location.search);
  const quality = q.get('quality');
  if (quality && (QUALITY_LEVELS as string[]).includes(quality))
    s.quality = quality as QualityLevel;
  const weather = q.get('weather');
  if (weather && weather in WEATHER_COVERAGE) s.weather = weather as Weather;
  return s;
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Not critical.
  }
}

/** Picks a preset from the GPU name (WEBGL_debug_renderer_info). */
export function detectQuality(): QualityLevel {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const name = String(
      ext ? gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL) : (gl?.getParameter(gl.RENDERER) ?? ''),
    );
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
    if (mobile || /Mali|Adreno|PowerVR|Apple GPU|SwiftShader|llvmpipe/i.test(name)) return 'low';
    if (/Intel|UHD|Iris/i.test(name)) return 'medium';
    return 'high';
  } catch {
    return 'medium';
  }
}

export function resolveQuality(s: Settings): { level: QualityLevel; quality: Quality } {
  const level = s.quality === 'auto' ? detectQuality() : s.quality;
  const quality = { ...PRESETS[level] };
  // Test switches for profiling, e.g. ?fx=noclouds,nopost,noshadow,nodetail,nocloudshadow
  const fx = new URLSearchParams(location.search).get('fx')?.split(',') ?? [];
  if (fx.includes('noclouds')) quality.cloudLayers = quality.volumetricClouds = 0;
  if (fx.includes('nopost')) quality.bloom = quality.smaa = false;
  if (fx.includes('nopost') || fx.includes('flatclouds')) quality.volumetricClouds = 0;
  if (fx.includes('nobloom')) quality.bloom = false;
  if (fx.includes('nosmaa')) quality.smaa = false;
  if (fx.includes('noshadow')) quality.shadowMap = 0;
  if (fx.includes('nodetail')) quality.terrainDetail = false;
  if (fx.includes('nocloudshadow')) quality.cloudShadows = false;
  if (fx.includes('nobuildings')) quality.buildingRadius = 0;
  if (fx.includes('nowater')) quality.water = false;
  return { level, quality };
}

/** Time-of-day setting as "HH:MM" for resolveTime(), or null for real time / golden hour. */
export function timeSpec(s: Settings): string | null {
  const q = new URLSearchParams(location.search).get('t');
  if (q) return q;
  return s.time === 'real' ? null : s.time;
}
