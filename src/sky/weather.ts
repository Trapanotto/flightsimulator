/** The weather the sky shows. The app also feeds wind and visibility to the simulation. */
export interface Weather {
  /** Share of the sky covered by cumulus, 0..1. */
  cloudCover: number;
  /** Base and top of the cumulus layer, metres above sea level. */
  cloudBase: number;
  cloudTop: number;
  /** Horizontal visibility at the ground, metres. */
  visibility: number;
  /** Surface wind: direction it comes from (degrees true) and speed (m/s). */
  windFromDeg: number;
  windSpeed: number;
  /** 0 dry .. 1 heavy rain (snow below freezing). */
  precipitation: number;
  /** Air temperature at sea level, degrees Celsius. */
  temperature: number;
  /**
   * A closed stratus deck below the cumulus layer (phase 3): the high fog of the Swiss
   * Plateau in autumn and winter, sunshine above it. Base and top in metres above sea level.
   * `visibilityBelow` is the visibility under the deck, metres (misty); `visibility` holds
   * above it.
   */
  stratus?: { base: number; top: number; visibilityBelow: number };
}

export type WeatherPreset = 'clear' | 'fair' | 'cloudy' | 'overcast' | 'lowStratus';

/**
 * Typical Swiss Plateau weather (ground about 500 m above sea level). Cumulus bases of
 * 1500-2000 m on fair days; an overcast deck is lower and thinner, with hazier air under it.
 */
export const WEATHER_PRESETS: Record<WeatherPreset, Weather> = {
  clear: {
    cloudCover: 0,
    cloudBase: 1900,
    cloudTop: 3000,
    visibility: 80_000,
    windFromDeg: 270,
    windSpeed: 3,
    precipitation: 0,
    temperature: 20,
  },
  fair: {
    cloudCover: 0.3,
    cloudBase: 1700,
    cloudTop: 3200,
    visibility: 50_000,
    windFromDeg: 250,
    windSpeed: 5,
    precipitation: 0,
    temperature: 19,
  },
  cloudy: {
    cloudCover: 0.62,
    cloudBase: 1500,
    cloudTop: 3400,
    visibility: 30_000,
    windFromDeg: 240,
    windSpeed: 7,
    precipitation: 0,
    temperature: 15,
  },
  overcast: {
    cloudCover: 0.97,
    cloudBase: 1200,
    cloudTop: 2300,
    visibility: 15_000,
    windFromDeg: 230,
    windSpeed: 8,
    precipitation: 0,
    temperature: 11,
  },
  // Hochnebel: a deck from about 250 m above the Plateau to 1000 m above sea level, calm and
  // cold below, clear and mild above. An instrument approach to Zurich breaks out low.
  lowStratus: {
    cloudCover: 0,
    cloudBase: 2500,
    cloudTop: 3200,
    visibility: 70_000,
    windFromDeg: 50,
    windSpeed: 2,
    precipitation: 0,
    temperature: 4,
    stratus: { base: 680, top: 1000, visibilityBelow: 4000 },
  },
};

/**
 * Wind at the cloud layer as an east/south velocity in render space (m/s). Winds aloft are
 * stronger than at the surface and veer to the right (Ekman spiral, northern hemisphere).
 */
export function cloudWind(w: Weather): { east: number; south: number } {
  const speed = Math.max(w.windSpeed, 0) * 1.8 + 2;
  // The wind blows towards windFromDeg + 180; veer by 20°.
  const to = (w.windFromDeg + 180 + 20) * (Math.PI / 180);
  return { east: Math.sin(to) * speed, south: -Math.cos(to) * speed };
}
