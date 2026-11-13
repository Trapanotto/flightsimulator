import type { Weather } from '@sky';

/** The fields of Open-Meteo's `current` block this uses. */
export interface OpenMeteoCurrent {
  temperature_2m: number;
  dew_point_2m: number;
  cloud_cover: number;
  wind_speed_10m: number;
  wind_direction_10m: number;
  visibility?: number;
  precipitation: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Turns a weather report at a place into what the sky shows. `elevation` is the height of
 * the place above sea level in metres.
 */
export function weatherFromReport(c: OpenMeteoCurrent, elevation: number): Weather {
  // Cumulus forms where rising air reaches its dew point: about 125 m per degree of spread.
  const spread = Math.max(0, c.temperature_2m - c.dew_point_2m);
  const cloudBase = clamp(elevation + 125 * spread, elevation + 300, 4500);
  const cloudCover = clamp(c.cloud_cover / 100, 0, 1);
  return {
    cloudCover,
    cloudBase,
    // Fair-weather clouds are shallow, a closed deck is thick.
    cloudTop: cloudBase + 700 + 900 * cloudCover,
    visibility: clamp(c.visibility ?? 30_000, 1500, 90_000),
    windFromDeg: ((c.wind_direction_10m % 360) + 360) % 360,
    windSpeed: Math.max(0, c.wind_speed_10m),
    // 5 mm/h is steady rain.
    precipitation: clamp(c.precipitation / 5, 0, 1),
    // The simulation wants the temperature at sea level: standard lapse rate down from here.
    temperature: c.temperature_2m + 0.0065 * elevation,
  };
}

/** The weather right now at lon/lat (Open-Meteo, free, no key). Rejects when unreachable. */
export async function fetchLiveWeather(
  lon: number,
  lat: number,
  elevation: number,
  signal?: AbortSignal,
): Promise<Weather> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
    '&current=temperature_2m,dew_point_2m,cloud_cover,wind_speed_10m,wind_direction_10m,visibility,precipitation' +
    '&wind_speed_unit=ms';
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`weather: HTTP ${res.status}`);
  const data = (await res.json()) as { current?: OpenMeteoCurrent };
  if (!data.current) throw new Error('weather: no current block');
  return weatherFromReport(data.current, elevation);
}
