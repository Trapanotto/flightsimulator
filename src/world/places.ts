/** Start places for the free camera (lon/lat in degrees, height in m, heading in degrees from north). */
export interface Place {
  name: string;
  lon: number;
  lat: number;
  h: number;
  heading: number;
  pitch?: number;
}

export const PLACES: Place[] = [
  { name: 'Genf', lon: 6.1432, lat: 46.2044, h: 1300, heading: 45 },
  { name: 'Bern', lon: 7.4474, lat: 46.948, h: 1300, heading: 135 },
  { name: 'Zürich', lon: 8.5417, lat: 47.3769, h: 1300, heading: 150 },
  { name: 'Lauterbrunnen', lon: 7.909, lat: 46.63, h: 1900, heading: 180, pitch: -12 },
  { name: 'Matterhorn', lon: 7.725, lat: 46.0, h: 4100, heading: 245, pitch: -6 },
  { name: 'St. Moritz', lon: 9.8355, lat: 46.4908, h: 2700, heading: 230 },
];

/** Phase 2 acceptance flight: Geneva -> St. Moritz along the Alps, ~330 km. */
export const TEST_ROUTE: Array<{ lon: number; lat: number; h: number }> = [
  { lon: 6.1432, lat: 46.2044, h: 2200 },
  { lon: 6.633, lat: 46.519, h: 2200 },
  { lon: 7.4474, lat: 46.948, h: 2400 },
  { lon: 7.863, lat: 46.686, h: 3000 },
  { lon: 8.333, lat: 46.567, h: 3600 },
  { lon: 8.852, lat: 46.703, h: 3400 },
  { lon: 9.53, lat: 46.85, h: 3200 },
  { lon: 9.8355, lat: 46.4908, h: 3200 },
];
