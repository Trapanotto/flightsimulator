/**
 * Runways used as start places. Threshold coordinates (WGS84) from OurAirports
 * (public domain, https://ourairports.com/data/); headings are computed from them.
 */
export interface Runway {
  airport: string;
  icao: string;
  /** Runway designator used for the start, e.g. "32". */
  ident: string;
  /** Threshold of `ident` (start end) and the opposite threshold. */
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  widthM: number;
}

export const RUNWAYS: Runway[] = [
  {
    airport: 'Bern-Belp',
    icao: 'LSZB',
    ident: '32',
    from: { lat: 46.907389, lon: 7.505365 },
    to: { lat: 46.91931, lon: 7.490825 },
    widthM: 30,
  },
  {
    airport: 'Sion',
    icao: 'LSGS',
    ident: '25',
    from: { lat: 46.221981, lon: 7.339386 },
    to: { lat: 46.216698, lon: 7.314575 },
    widthM: 40,
  },
  {
    airport: 'Zürich',
    icao: 'LSZH',
    ident: '28',
    from: { lat: 47.4566, lon: 8.57045 },
    to: { lat: 47.4589, lon: 8.53747 },
    widthM: 60,
  },
  {
    airport: 'Samedan',
    icao: 'LSZS',
    ident: '21',
    from: { lat: 46.541489, lon: 9.889842 },
    to: { lat: 46.527025, lon: 9.878102 },
    widthM: 40,
  },
  {
    airport: 'Lugano',
    icao: 'LSZA',
    ident: '01',
    from: { lat: 45.998501, lon: 8.90776 },
    to: { lat: 46.009998, lon: 8.91339 },
    widthM: 30,
  },
  {
    airport: 'Genf',
    icao: 'LSGG',
    ident: '22',
    from: { lat: 46.250401, lon: 6.12699 },
    to: { lat: 46.2258, lon: 6.09092 },
    widthM: 50,
  },
];

const R = 6_371_000;
const rad = Math.PI / 180;

/** True heading from `a` to `b` in degrees (0 = north, clockwise). */
export function bearingDeg(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x =
    Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
    Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return (((Math.atan2(y, x) / rad) % 360) + 360) % 360;
}

export function distanceM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Point `m` metres from the start threshold along the centre line. */
export function alongRunway(r: Runway, m: number): { lat: number; lon: number } {
  const t = m / distanceM(r.from, r.to);
  return {
    lat: r.from.lat + (r.to.lat - r.from.lat) * t,
    lon: r.from.lon + (r.to.lon - r.from.lon) * t,
  };
}
