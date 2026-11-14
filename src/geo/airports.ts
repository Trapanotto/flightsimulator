/**
 * Airfields with their runways: every Swiss aerodrome with a runway and the border airports
 * Swiss flying uses. The data (airports.generated.ts) is built by tools/airports/build.mjs from
 * OurAirports (public domain) and OpenStreetMap (ODbL). Plain data and geometry: no renderer.
 */
import { AIRPORT_DATA } from './airports.generated';

export type RunwaySurface = 'asphalt' | 'concrete' | 'grass' | 'gravel' | 'dirt' | 'snow';

export interface RunwayEndInfo {
  /** Designator as painted, e.g. "32", "14L", "06G" (G: glider strip). */
  ident: string;
  /**
   * Where the runway pavement (or strip) ends on this side, WGS84 degrees. With a displaced
   * threshold the landing threshold lies `displaced` metres further down the runway.
   */
  lon: number;
  lat: number;
  /** Metres from the runway end to the landing threshold; absent when the two coincide. */
  displaced?: number;
  /** Metres above sea level at this end, when published; otherwise ask the terrain. */
  elevation?: number;
  /** A published instrument approach to this end: precision (ILS) or not (LOC, RNP). */
  approach?: 'ils' | 'npa';
  /** Approach lighting in front of the threshold: 900 m precision system or a simple one. */
  als?: 'precision' | 'simple';
  /** Precision approach path indicator beside this end, on that side of the runway. */
  papi?: 'left' | 'right';
}

export interface RunwayInfo {
  /** Metres. */
  width: number;
  /** Metres, end to end. */
  length: number;
  surface: RunwaySurface;
  /** Runway edge lights. */
  lighted: boolean;
  /** Centre line lights (big precision runways). */
  centerLights?: boolean;
  ends: [RunwayEndInfo, RunwayEndInfo];
}

export interface AirportInfo {
  icao: string;
  name: string;
  /** ISO country code (CH, LI, or the neighbour of a border airport). */
  country: string;
  kind: 'major' | 'regional' | 'airfield';
  military: boolean;
  /** Aerodrome reference point, WGS84 degrees. */
  lon: number;
  lat: number;
  /** Metres above sea level. */
  elevation: number;
  /** Taxiways, aprons and windsocks are in public/assets/world/airports/<icao>.json. */
  detail: boolean;
  /** Paved runways first, longest first. */
  runways: RunwayInfo[];
}

export const AIRPORTS: readonly AirportInfo[] = AIRPORT_DATA;

/** Credits of the airport data, for the interface. */
export const AIRPORT_ATTRIBUTION = ['OurAirports', '© OpenStreetMap contributors'];

const RAD = Math.PI / 180;
const EARTH_R = 6_371_000;

export function isPaved(surface: RunwaySurface): boolean {
  return surface === 'asphalt' || surface === 'concrete';
}

/** Great-circle distance in metres. */
export function distanceM(
  a: { lon: number; lat: number },
  b: { lon: number; lat: number },
): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** True bearing from a to b in degrees (0 = north, clockwise). */
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

/** Designator of the other end: 32 -> 14, 01 -> 19, 14L -> 32R, 06C -> 24C. */
export function oppositeIdent(ident: string): string {
  const m = /^(\d{1,2})([LRCG]?)$/.exec(ident);
  if (!m) return ident;
  const n = ((Number(m[1]) + 17) % 36) + 1;
  const side = { L: 'R', R: 'L', C: 'C', G: 'G', '': '' }[m[2] as 'L' | 'R' | 'C' | 'G' | ''];
  return String(n).padStart(2, '0') + side;
}

export function findAirport(icao: string): AirportInfo | undefined {
  const code = icao.toUpperCase();
  return AIRPORTS.find((a) => a.icao === code);
}

/** Airports whose reference point is within `radius` metres of lon/lat, nearest first. */
export function airportsNear(
  lon: number,
  lat: number,
  radius: number,
): Array<{ airport: AirportInfo; distance: number }> {
  const here = { lon, lat };
  return AIRPORTS.map((airport) => ({ airport, distance: distanceM(here, airport) }))
    .filter((a) => a.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
}

/** A runway end by designator, with its runway and the opposite end. */
export function findRunwayEnd(
  airport: AirportInfo,
  ident: string,
): { runway: RunwayInfo; end: RunwayEndInfo; opposite: RunwayEndInfo } | undefined {
  for (const runway of airport.runways) {
    const i = runway.ends.findIndex((e) => e.ident === ident);
    if (i >= 0) return { runway, end: runway.ends[i]!, opposite: runway.ends[1 - i]! };
  }
  return undefined;
}

/** The landing threshold of a runway end (the end itself unless it is displaced). */
export function thresholdOf(
  end: RunwayEndInfo,
  opposite: RunwayEndInfo,
): { lon: number; lat: number } {
  if (!end.displaced) return { lon: end.lon, lat: end.lat };
  return offsetPoint(end, bearingDeg(end, opposite), end.displaced);
}

/**
 * Where an aircraft lines up for take-off from the runway end `ident`: on the centre line,
 * `inset` metres past the start of the pavement (the whole runway is usable for take-off, a
 * displaced threshold only moves the landing), facing down the runway. Elevation in metres
 * above sea level when published; otherwise the terrain decides.
 */
export function runwayStart(
  airport: AirportInfo,
  ident: string,
  inset = 40,
): { lon: number; lat: number; headingDeg: number; elevation?: number } | undefined {
  const found = findRunwayEnd(airport, ident);
  if (!found) return undefined;
  const headingDeg = bearingDeg(found.end, found.opposite);
  const p = offsetPoint(found.end, headingDeg, inset);
  return found.end.elevation === undefined
    ? { ...p, headingDeg }
    : { ...p, headingDeg, elevation: found.end.elevation };
}
