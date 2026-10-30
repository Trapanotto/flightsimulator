/**
 * Real weather from Open-Meteo (free, no key, CORS open; data under CC BY 4.0, models of
 * MeteoSwiss, DWD, ECMWF): current conditions at the camera turned into the look of the
 * sky (cumulus layer, haze, fog / Hochnebel) and the wind.
 */

/** What the renderer and the flight model need from the weather. */
export interface WeatherLook {
  /** Cumulus layer: coverage threshold 0..0.8 (0 = clear), base and top (m above sea level). */
  coverage: number;
  base: number;
  top: number;
  /** Haze: Mie scattering at sea level (1/m). */
  mie: number;
  /** Stratus slab (fog, Hochnebel) or none. */
  fog: { top: number; base: number; density: number } | null;
  /** Wind at 10 m: direction it blows FROM (degrees) and speed (m/s); gusts (m/s). */
  windFrom: number;
  windSpeed: number;
  gusts: number;
  /** For displays: temperature °C, visibility m, cloud cover %, WMO weather code. */
  temperature: number;
  visibility: number;
  cloudCover: number;
  code: number;
}

export interface OpenMeteoCurrent {
  elevation: number;
  current: {
    temperature_2m: number;
    dew_point_2m: number;
    cloud_cover: number;
    cloud_cover_low: number;
    cloud_cover_mid: number;
    cloud_cover_high: number;
    visibility: number;
    wind_speed_10m: number;
    wind_direction_10m: number;
    wind_gusts_10m: number;
    weather_code: number;
  };
}

const FIELDS = [
  'temperature_2m',
  'dew_point_2m',
  'cloud_cover',
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'visibility',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'weather_code',
];

export function openMeteoUrl(lon: number, lat: number) {
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
    `&current=${FIELDS.join(',')}&wind_speed_unit=ms`
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Open-Meteo "current" -> look of the sky. The cloud base comes from the spread between
 * temperature and dew point (about 125 m per °C, the lifting condensation level); low cloud
 * without mid-level cloud over a cold, moist ground is the Swiss Hochnebel.
 */
export function weatherFromOpenMeteo(r: OpenMeteoCurrent): WeatherLook {
  const c = r.current;
  const elev = r.elevation ?? 500;
  const spread = Math.max(0, c.temperature_2m - c.dew_point_2m);
  const lcl = clamp(125 * spread, 120, 3500);
  const low = c.cloud_cover_low / 100;
  const mid = c.cloud_cover_mid / 100;
  const total = c.cloud_cover / 100;
  const vis = clamp(c.visibility || 30_000, 50, 80_000);
  const code = c.weather_code;
  const thunder = code >= 95;
  const fogCode = code === 45 || code === 48;

  // Cumulus / stratocumulus layer: low cloud from the condensation level; with only
  // mid-level cloud it sits higher.
  const cumulus = Math.max(low, mid * 0.85);
  const base = low >= mid * 0.6 ? elev + lcl : Math.max(elev + lcl, 2800);
  const thickness = thunder ? 7000 : 500 + 2200 * cumulus + (total > 0.9 ? 600 : 0);
  // Coverage threshold of the cloud shader: a few % of cloud -> ~0.1, overcast -> ~0.75.
  const coverage = cumulus < 0.04 ? 0 : clamp(0.08 + 0.7 * cumulus, 0, 0.78);

  // Haze from the visibility, on the scale the renderer is tuned to (the presets): 30 km
  // looks like "fair", 50 km like "clear", 5 km is milky.
  const mie = clamp(1.6e-5 * (30_000 / vis) ** 0.6, 0.8e-5, 7e-5);

  let fog: WeatherLook['fog'] = null;
  if (fogCode || vis < 1500) {
    // Ground fog: as thick as the visibility says, a couple of hundred metres deep.
    fog = {
      top: elev + 150 + Math.min(250, vis / 6),
      base: elev - 500,
      density: 3.9 / Math.max(vis, 60),
    };
  } else if (low > 0.85 && mid < 0.4 && lcl < 450 && !thunder) {
    // Hochnebel: a flat stratus deck a few hundred metres above the lowlands.
    const top = elev + lcl + 350;
    fog = { top, base: elev + lcl, density: 1 / 55 };
  }

  return {
    coverage: fog && fog.base > elev ? Math.min(coverage, 0.05) : coverage,
    base,
    top: base + thickness,
    mie,
    fog,
    windFrom: c.wind_direction_10m,
    windSpeed: Math.max(0, c.wind_speed_10m),
    gusts: Math.max(c.wind_gusts_10m ?? 0, c.wind_speed_10m),
    temperature: c.temperature_2m,
    visibility: vis,
    cloudCover: c.cloud_cover,
    code,
  };
}

/**
 * Wind speed at a height above ground: grows from the 10 m value with the height (power law,
 * exponent ~0.2 over land), up to about twice the surface wind at 1.5 km.
 */
export function windAtHeight(speed10: number, agl: number): number {
  const h = clamp(agl, 10, 1500);
  return speed10 * Math.min(2, (h / 10) ** 0.14);
}

/**
 * Keeps the weather current where the camera is: fetches when the camera has moved 25 km
 * or after 10 minutes. Failures are silent (the previous or the default weather stays).
 */
export class LiveWeather {
  look?: WeatherLook;
  onChange?: (w: WeatherLook) => void;
  private at?: { lon: number; lat: number; time: number };
  private loading = false;

  update(lon: number, lat: number, now = Date.now()) {
    if (this.loading) return;
    const a = this.at;
    if (a) {
      const km = Math.hypot((lon - a.lon) * 76, (lat - a.lat) * 111);
      if (km < 25 && now - a.time < 10 * 60_000) return;
    }
    this.loading = true;
    this.at = { lon, lat, time: now };
    fetch(openMeteoUrl(lon, lat))
      .then((r) => (r.ok ? (r.json() as Promise<OpenMeteoCurrent>) : Promise.reject(r.status)))
      .then((json) => {
        this.look = weatherFromOpenMeteo(json);
        this.onChange?.(this.look);
      })
      .catch((err) => console.warn('live weather', err))
      .finally(() => {
        this.loading = false;
      });
  }
}
