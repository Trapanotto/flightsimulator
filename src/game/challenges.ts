import { RUNWAYS, type Runway, bearingDeg, distanceM } from './airports';

/**
 * Ring challenges (concept ch. 14): hand-made courses through real Swiss landscapes.
 *
 * Ring heights are metres above sea level. They were planned against the swisstopo
 * elevation model (api3.geo.admin.ch height/profile services): every ring sits 90–150 m above
 * the ground and the straight line between two rings clears the terrain, so each course can
 * be flown without hitting a slope.
 */

export interface GeoPoint {
  lon: number;
  lat: number;
  /** Metres above sea level. */
  alt: number;
}

type Text = { de: string; en: string };

export interface Course {
  id: string;
  name: Text;
  description: Text;
  /** Air start; the aircraft points at the first ring. */
  start: GeoPoint;
  gates: GeoPoint[];
  /** Ring radius in metres. */
  radius: number;
  /** Medal times in seconds (at or below). */
  medals: { gold: number; silver: number; bronze: number };
  /** Optional finish after the last ring: a landing on this runway. */
  landing?: Runway;
  /** The aircraft flown on this course (id in src/aircraft/types.ts). */
  aircraft: string;
}

export type Medal = 'gold' | 'silver' | 'bronze';

const p = (lon: number, lat: number, alt: number): GeoPoint => ({ lon, lat, alt });

/** Samedan 03: the opposite direction of the runway 21 start place. */
const SAMEDAN = RUNWAYS.find((r) => r.icao === 'LSZS')!;
const SAMEDAN_03: Runway = { ...SAMEDAN, ident: '03', from: SAMEDAN.to, to: SAMEDAN.from };

export const COURSES: Course[] = [
  {
    id: 'lauterbrunnen',
    name: { de: 'Lauterbrunnen Canyon Run', en: 'Lauterbrunnen Canyon Run' },
    description: {
      de: 'Tief durchs Trogtal: an Staubbach und Trümmelbach vorbei bis nach Interlaken.',
      en: 'Low through the glacial valley: past the Staubbach and Trümmelbach falls to Interlaken.',
    },
    start: p(7.8995, 46.5425, 1030),
    gates: [
      p(7.9, 46.54884, 1013),
      p(7.90684, 46.56661, 961),
      p(7.91214, 46.58494, 926),
      p(7.90903, 46.59711, 909),
      p(7.90188, 46.61149, 860),
      p(7.903, 46.62843, 787),
      p(7.88179, 46.64386, 784),
      p(7.869, 46.66, 721),
      p(7.85399, 46.67516, 719),
      p(7.85287, 46.68749, 694),
    ],
    radius: 45,
    medals: { gold: 150, silver: 175, bronze: 210 },
    aircraft: 'pc12',
  },
  {
    id: 'matterhorn',
    name: { de: 'Matterhorn-Umrundung', en: 'Around the Matterhorn' },
    description: {
      de: 'Einmal rund um den Berg, auf 3100 bis 3900 m – über Gletscher und Grate.',
      en: 'Once around the mountain at 3100 to 3900 m – over glaciers and ridges.',
    },
    start: p(7.665, 46.017, 3150),
    gates: [
      p(7.686, 45.9954, 3200),
      p(7.6974, 45.9763, 3500),
      p(7.686, 45.957, 3700),
      p(7.6586, 45.9493, 3500),
      p(7.631, 45.957, 3600),
      p(7.62, 45.9763, 3900),
      p(7.631, 45.9954, 3450),
      p(7.6586, 46.0033, 3100),
    ],
    radius: 60,
    medals: { gold: 170, silver: 200, bronze: 245 },
    aircraft: 'f35',
  },
  {
    id: 'aletsch',
    name: { de: 'Aletsch Gletscher-Express', en: 'Aletsch Glacier Express' },
    description: {
      de: 'Vom Jungfraujoch über den Konkordiaplatz den grössten Gletscher der Alpen hinunter.',
      en: 'From the Jungfraujoch over Konkordiaplatz down the largest glacier of the Alps.',
    },
    start: p(7.999, 46.54, 3750),
    gates: [
      p(8.01366, 46.5251, 3000),
      p(8.02926, 46.5092, 2831),
      p(8.0427, 46.49783, 2775),
      p(8.05095, 46.48201, 2649),
      p(8.06704, 46.46612, 2515),
      p(8.07864, 46.45197, 2470),
      p(8.06069, 46.43755, 2290),
      p(8.06201, 46.41966, 2109),
      p(8.04166, 46.40844, 1880),
      p(8.0258, 46.39854, 1760),
      p(8.0101, 46.3876, 1850),
      p(7.9975, 46.3598, 1760),
    ],
    radius: 60,
    medals: { gold: 200, silver: 235, bronze: 285 },
    aircraft: 'phenom100',
  },
  {
    id: 'vierwaldstaettersee',
    name: { de: 'Seen-Tour Zentralschweiz', en: 'Central Switzerland Lake Tour' },
    description: {
      de: 'Knapp über dem Vierwaldstättersee von Luzern durch die Nase bis nach Flüelen.',
      en: 'Just above Lake Lucerne from Lucerne through the Nase narrows to Flüelen.',
    },
    start: p(8.312, 47.0565, 560),
    gates: [
      p(8.32, 47.05, 544),
      p(8.357, 47.035, 580),
      p(8.4, 47.025, 544),
      p(8.441, 47.02, 544),
      p(8.4775, 47.01, 544),
      p(8.47, 46.997, 544),
      p(8.495, 46.989, 544),
      p(8.54, 46.988, 544),
      p(8.588, 46.99, 544),
      p(8.612, 46.981, 583),
      p(8.605, 46.958, 544),
      p(8.599, 46.93, 544),
      p(8.611, 46.905, 544),
    ],
    radius: 60,
    medals: { gold: 645, silver: 760, bronze: 920 },
    aircraft: 'c172',
  },
  {
    id: 'samedan',
    name: { de: 'Landeanflug Samedan', en: 'Samedan Approach' },
    description: {
      de: 'Über die Oberengadiner Seen, dann Endanflug und Landung auf Piste 03 – auf 1700 m.',
      en: 'Over the Upper Engadine lakes, then final approach and landing on runway 03 – at 1700 m.',
    },
    start: p(9.7, 46.4, 1950),
    gates: [
      p(9.73383, 46.41636, 1940),
      p(9.79474, 46.44691, 1960),
      p(9.83809, 46.48834, 2010),
      p(9.8572, 46.5021, 1990),
      p(9.86634, 46.51301, 1840),
      p(9.87353, 46.52157, 1768),
    ],
    radius: 50,
    medals: { gold: 200, silver: 235, bronze: 280 },
    landing: SAMEDAN_03,
    aircraft: 'a320',
  },
];

export function courseById(id: string): Course | undefined {
  return COURSES.find((c) => c.id === id);
}

/** Flight path length from the start through all rings, metres (without the landing). */
export function courseLength(c: Course): number {
  let len = 0;
  let prev: GeoPoint = c.start;
  for (const g of c.gates) {
    len += distanceM(prev, g);
    prev = g;
  }
  return len;
}

/** Heading from the start to the first ring, degrees. */
export function startHeading(c: Course): number {
  return bearingDeg(c.start, c.gates[0]!);
}

export function medalFor(c: Course, seconds: number): Medal | null {
  if (seconds <= c.medals.gold) return 'gold';
  if (seconds <= c.medals.silver) return 'silver';
  if (seconds <= c.medals.bronze) return 'bronze';
  return null;
}

/** "1:23.4" */
export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}

/** Is lon/lat on the runway (within the paved length plus `margin` metres around it)? */
export function onRunway(r: Runway, lon: number, lat: number, margin = 25): boolean {
  const k = Math.cos((r.from.lat * Math.PI) / 180) * 111_320;
  const ex = (r.to.lon - r.from.lon) * k;
  const ey = (r.to.lat - r.from.lat) * 111_320;
  const px = (lon - r.from.lon) * k;
  const py = (lat - r.from.lat) * 111_320;
  const len = Math.hypot(ex, ey);
  const along = (px * ex + py * ey) / len;
  const across = Math.abs(px * ey - py * ex) / len;
  return along > -margin && along < len + margin && across < r.widthM / 2 + margin;
}

// ---- best times (localStorage) ----

const BEST_KEY = 'tfs.best';

export interface BestStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function store(): BestStore | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function loadBestTimes(s: BestStore | null = store()): Record<string, number> {
  try {
    const raw = s?.getItem(BEST_KEY);
    const data = raw ? (JSON.parse(raw) as unknown) : {};
    if (!data || typeof data !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(data)) if (typeof v === 'number' && v > 0) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** Stores the time if it beats the best; returns true for a new best. */
export function submitTime(id: string, seconds: number, s: BestStore | null = store()): boolean {
  const best = loadBestTimes(s);
  const old = best[id];
  if (old !== undefined && old <= seconds) return false;
  best[id] = Math.round(seconds * 10) / 10;
  try {
    s?.setItem(BEST_KEY, JSON.stringify(best));
  } catch {
    // Storage full or blocked: the result still shows, it is just not kept.
  }
  return true;
}
