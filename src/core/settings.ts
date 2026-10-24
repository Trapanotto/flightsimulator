/** Graphics presets (concept ch. 16) and user settings, stored in localStorage. */

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';
export const QUALITY_LEVELS: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];

export interface Quality {
  /** Highest render scale for dynamic resolution (share of the device pixel ratio). */
  maxRenderScale: number;
  maxPixelRatio: number;
  /** Terrain screen-space error threshold (px), max zoom and tile budget. */
  tau: number;
  maxZoom: number;
  maxTiles: number;
  terrainDetail: boolean;
  cloudLayers: number;
  cloudShadows: boolean;
  /** Aircraft shadow map size, 0 = off. */
  shadowMap: number;
  bloom: boolean;
  smaa: boolean;
  flare: boolean;
  trails: boolean;
}

export const PRESETS: Record<QualityLevel, Quality> = {
  low: {
    maxRenderScale: 0.75,
    maxPixelRatio: 1,
    tau: 9,
    maxZoom: 14,
    maxTiles: 260,
    terrainDetail: false,
    cloudLayers: 1,
    cloudShadows: false,
    shadowMap: 0,
    bloom: false,
    smaa: false,
    flare: false,
    trails: false,
  },
  medium: {
    maxRenderScale: 1,
    maxPixelRatio: 1.25,
    tau: 6,
    maxZoom: 15,
    maxTiles: 400,
    terrainDetail: true,
    cloudLayers: 2,
    cloudShadows: true,
    shadowMap: 1024,
    bloom: true,
    smaa: true,
    flare: true,
    trails: true,
  },
  high: {
    maxRenderScale: 1,
    maxPixelRatio: 1.5,
    tau: 4.5,
    maxZoom: 16,
    maxTiles: 560,
    terrainDetail: true,
    cloudLayers: 3,
    cloudShadows: true,
    shadowMap: 2048,
    bloom: true,
    smaa: true,
    flare: true,
    trails: true,
  },
  ultra: {
    maxRenderScale: 1,
    maxPixelRatio: 2,
    tau: 3.5,
    maxZoom: 17,
    maxTiles: 720,
    terrainDetail: true,
    cloudLayers: 4,
    cloudShadows: true,
    shadowMap: 2048,
    bloom: true,
    smaa: true,
    flare: true,
    trails: true,
  },
};

export type TimeOfDay = 'real' | 'morning' | 'noon' | 'golden';
export type Weather = 'clear' | 'fair' | 'cloudy';
export const WEATHER_COVERAGE: Record<Weather, number> = { clear: 0, fair: 0.38, cloudy: 0.62 };

export interface Settings {
  /** 'auto' picks a level from the GPU. */
  quality: QualityLevel | 'auto';
  time: TimeOfDay;
  weather: Weather;
  invertPitch: boolean;
}

const KEY = 'tfs.settings';
const DEFAULTS: Settings = { quality: 'auto', time: 'real', weather: 'fair', invertPitch: false };

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
  if (fx.includes('noclouds')) quality.cloudLayers = 0;
  if (fx.includes('nopost')) quality.bloom = quality.smaa = false;
  if (fx.includes('nobloom')) quality.bloom = false;
  if (fx.includes('nosmaa')) quality.smaa = false;
  if (fx.includes('noshadow')) quality.shadowMap = 0;
  if (fx.includes('nodetail')) quality.terrainDetail = false;
  if (fx.includes('nocloudshadow')) quality.cloudShadows = false;
  if (fx.includes('fixedscale')) quality.maxRenderScale = 1;
  return { level, quality };
}

/** Time-of-day setting as "HH:MM" for resolveTime(), or null for real time / golden hour. */
export function timeSpec(s: Settings): string | null {
  const q = new URLSearchParams(location.search).get('t');
  if (q) return q;
  return s.time === 'real' ? null : s.time;
}
