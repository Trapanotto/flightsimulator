/**
 * Hochnebel from a numerical weather report (Open-Meteo): plain TypeScript, tested in Node.
 *
 * A Hochnebel is a low, closed cloud under a temperature inversion: cold, saturated air at
 * the bottom, warmer and much drier air above. The report gives the low cloud cover and the
 * temperature and humidity on pressure levels; the deck's top is where the moist air ends
 * under the inversion, its base where the air at the ground would saturate when lifted.
 */
import type { Weather } from './weather';

/** One pressure level of the report (Open-Meteo `temperature_925hPa`, ...). */
export interface ReportLevel {
  /** Geopotential height, metres above sea level (`geopotential_height_925hPa`). */
  height: number;
  /** Air temperature, °C. */
  temperature: number;
  /** Relative humidity, %. */
  humidity: number;
}

/** The values of a report this needs; the pressure levels are optional but make it reliable. */
export interface StratusReport {
  temperature_2m: number;
  dew_point_2m: number;
  /** Total cloud cover and the share of low clouds (below about 2 km), %. */
  cloud_cover: number;
  cloud_cover_low: number;
  /** Cover of the mid-level clouds, %: the cumulus layer above a Hochnebel. */
  cloud_cover_mid?: number;
  /** Horizontal visibility at the ground, metres. */
  visibility?: number;
  wind_speed_10m: number;
  wind_direction_10m: number;
  /** mm in the last hour. */
  precipitation: number;
  /** Pressure levels in any order (1000, 975, 950, 925, 900, 850 hPa are the useful ones). */
  levels?: ReportLevel[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The deck a report shows at a place `elevation` metres above sea level, or undefined when
 * there is none: too little low cloud, or no inversion above the moist air.
 */
export function stratusFromReport(r: StratusReport, elevation: number): Weather['stratus'] {
  if (r.cloud_cover_low < 70) return undefined;
  const spread = Math.max(0, r.temperature_2m - r.dew_point_2m);
  const visibility = r.visibility ?? 10_000;
  const levels = (r.levels ?? [])
    .filter((l) => l.height > elevation + 30)
    .sort((a, b) => a.height - b.height);
  let top: number | undefined;
  if (levels.length > 0) {
    // Walk up from the ground: the deck is moist air; the first level that is clearly drier
    // and not colder than the one below it is the inversion, and the deck ends half way to it.
    let below = { height: elevation, temperature: r.temperature_2m, humidity: 100 };
    for (const l of levels) {
      const inversion = l.temperature >= below.temperature - 0.3;
      if (l.humidity < 75 && (inversion || below.humidity >= 90)) {
        top = (below.height + l.height) / 2;
        break;
      }
      if (l.humidity < 75) return undefined; // dry above, and no low cloud to speak of
      below = l;
    }
    // Moist all the way up: a deep overcast, not a Hochnebel.
    if (top === undefined) return undefined;
  } else {
    // Without the levels the low cloud cover alone: a deck of the usual 300-400 m.
    top = elevation + 250 + 125 * spread + 350;
  }
  // The base: lifted ground air saturates after ~125 m per degree of dew point spread; fog
  // on the ground when the visibility says so.
  const fog = visibility < 1000 && spread < 1;
  let base = fog ? elevation + 20 : elevation + clamp(125 * spread, 60, 1200);
  if (base > top - 100) base = top - 100;
  if (base < elevation + 20) return undefined;
  return {
    base,
    top,
    visibilityBelow: fog ? clamp(visibility, 200, 1000) : clamp(visibility, 1000, 20_000),
  };
}

/**
 * The whole weather of a report, with the Hochnebel when there is one. The cumulus layer
 * comes from the total cover (or, under a deck, the mid-level cover) as the app derives it
 * from the dew point spread.
 */
export function weatherFromOpenMeteo(r: StratusReport, elevation: number): Weather {
  const spread = Math.max(0, r.temperature_2m - r.dew_point_2m);
  const stratus = stratusFromReport(r, elevation);
  let cloudBase = clamp(elevation + 125 * spread, elevation + 300, 4500);
  let cloudCover = clamp(r.cloud_cover / 100, 0, 1);
  if (stratus) {
    // Above the deck only what the mid levels report; the cumulus stand clear of it.
    cloudCover = clamp((r.cloud_cover_mid ?? 0) / 100, 0, 1);
    cloudBase = Math.max(cloudBase, stratus.top + 800);
  }
  const weather: Weather = {
    cloudCover,
    cloudBase,
    cloudTop: cloudBase + 700 + 900 * cloudCover,
    // Above an inversion the air is clear; the reported visibility is the murk below it.
    visibility: stratus ? 70_000 : clamp(r.visibility ?? 30_000, 1500, 90_000),
    windFromDeg: ((r.wind_direction_10m % 360) + 360) % 360,
    windSpeed: Math.max(0, r.wind_speed_10m),
    precipitation: clamp(r.precipitation / 5, 0, 1),
    temperature: r.temperature_2m + 0.0065 * elevation,
  };
  if (stratus) weather.stratus = stratus;
  return weather;
}
