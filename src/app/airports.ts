/**
 * Airports a flight can start from. Threshold coordinates (WGS84) from OurAirports (public
 * domain). Phase 2 replaces this list with all Swiss airfields from the data pipeline.
 */
export interface RunwayEnd {
  /** Designator, e.g. "32". */
  ident: string;
  lon: number;
  lat: number;
}

export interface Airport {
  icao: string;
  name: string;
  /** Metres above sea level. */
  elevation: number;
  /** Both ends of each runway: a start from `ends[0]` rolls towards `ends[1]` and vice versa. */
  runways: Array<{ ends: [RunwayEnd, RunwayEnd]; width: number }>;
}

export const AIRPORTS: Airport[] = [
  {
    icao: 'LSZB',
    name: 'Bern-Belp',
    elevation: 510,
    runways: [
      {
        ends: [
          { ident: '32', lon: 7.505365, lat: 46.907389 },
          { ident: '14', lon: 7.490825, lat: 46.91931 },
        ],
        width: 30,
      },
    ],
  },
  {
    icao: 'LSGS',
    name: 'Sion',
    elevation: 482,
    runways: [
      {
        ends: [
          { ident: '25', lon: 7.339386, lat: 46.221981 },
          { ident: '07', lon: 7.314575, lat: 46.216698 },
        ],
        width: 40,
      },
    ],
  },
  {
    icao: 'LSZH',
    name: 'Zürich',
    elevation: 432,
    runways: [
      {
        ends: [
          { ident: '28', lon: 8.57045, lat: 47.4566 },
          { ident: '10', lon: 8.53747, lat: 47.4589 },
        ],
        width: 60,
      },
    ],
  },
  {
    icao: 'LSZS',
    name: 'Samedan',
    elevation: 1707,
    runways: [
      {
        ends: [
          { ident: '21', lon: 9.889842, lat: 46.541489 },
          { ident: '03', lon: 9.878102, lat: 46.527025 },
        ],
        width: 40,
      },
    ],
  },
  {
    icao: 'LSZA',
    name: 'Lugano',
    elevation: 279,
    runways: [
      {
        ends: [
          { ident: '01', lon: 8.90776, lat: 45.998501 },
          { ident: '19', lon: 8.91339, lat: 46.009998 },
        ],
        width: 30,
      },
    ],
  },
  {
    icao: 'LSGG',
    name: 'Genève',
    elevation: 430,
    runways: [
      {
        ends: [
          { ident: '22', lon: 6.12699, lat: 46.250401 },
          { ident: '04', lon: 6.09092, lat: 46.2258 },
        ],
        width: 50,
      },
    ],
  },
];

const RAD = Math.PI / 180;
const EARTH_R = 6_371_000;

/** True bearing from a to b in degrees (0 = north, clockwise). Fine for runway lengths. */
export function bearingDeg(
  a: { lon: number; lat: number },
  b: { lon: number; lat: number },
): number {
  const dLon = (b.lon - a.lon) * RAD;
  const y = Math.sin(dLon) * Math.cos(b.lat * RAD);
  const x =
    Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) -
    Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos(dLon);
  return (((Math.atan2(y, x) / RAD) % 360) + 360) % 360;
}

/** The point `metres` from `from` in the direction `bearing` (degrees true). */
export function offsetPoint(
  from: { lon: number; lat: number },
  bearing: number,
  metres: number,
): { lon: number; lat: number } {
  const d = metres / EARTH_R;
  const b = bearing * RAD;
  const lat1 = from.lat * RAD;
  const lat = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon =
    from.lon * RAD +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat),
    );
  return { lon: lon / RAD, lat: lat / RAD };
}

/**
 * Where an aircraft lines up for take-off from the runway end `ident`: on the centre line,
 * `inset` metres past the threshold, facing down the runway.
 */
export function runwayStart(
  airport: Airport,
  ident: string,
  inset = 40,
): { lon: number; lat: number; headingDeg: number } | undefined {
  for (const r of airport.runways) {
    const i = r.ends.findIndex((e) => e.ident === ident);
    if (i < 0) continue;
    const from = r.ends[i]!;
    const to = r.ends[1 - i]!;
    const headingDeg = bearingDeg(from, to);
    return { ...offsetPoint(from, headingDeg, inset), headingDeg };
  }
  return undefined;
}

export function findAirport(icao: string): Airport | undefined {
  return AIRPORTS.find((a) => a.icao === icao);
}
