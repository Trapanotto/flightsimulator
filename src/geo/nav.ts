/**
 * Navigation data of Switzerland and its surroundings: radio stations, instrument landing
 * systems, fixes and reporting points, airport frequencies, simplified airspace. The data
 * (nav.generated.ts) is built by tools/nav/build.mjs; its header lists sources and licences.
 * Plain data and geometry: no renderer.
 *
 * The station and waypoint shapes match `NavStation` and `Waypoint` of the simulation
 * structurally (geo cannot import sim), so the app hands them over unchanged.
 */
import {
  type AirportInfo,
  bearingDeg,
  distanceM,
  findAirport,
  findRunwayEnd,
  isPaved,
  offsetPoint,
  thresholdOf,
} from './airports';
import {
  AIRPORT_FREQUENCY_DATA,
  AIRSPACE_DATA,
  FIS_DATA,
  FIS_LINE_DATA,
  NAV_FIX_DATA,
  NAV_STATION_DATA,
} from './nav.generated';

export type NavStationType = 'VOR' | 'VOR-DME' | 'DME' | 'NDB' | 'LOC' | 'ILS';

/** A ground station a receiver can tune. Bearings and courses in degrees TRUE. */
export interface NavStationInfo {
  ident: string;
  name: string;
  type: NavStationType;
  /** kHz: 108 000 .. 117 950 for VOR, DME, LOC and ILS; 190 .. 1750 for NDB. */
  frequency: number;
  lon: number;
  lat: number;
  /** Metres above sea level. */
  elevation: number;
  /** Nautical miles at which it can still be received (at altitude, line of sight permitting). */
  rangeNm: number;
  /** LOC/ILS: the true course the localizer guides along (inbound). */
  course?: number;
  glideSlope?: { lon: number; lat: number; elevation: number; angleDeg: number };
  dme?: { lon: number; lat: number; elevation: number };
  airport?: string;
  runway?: string;
}

export interface NavFix {
  ident: string;
  name: string;
  /** 'vfr': reporting point; 'faf': final approach fix; 'iaf': initial fix / holding; 'star': arrival entry. */
  kind: 'vfr' | 'faf' | 'iaf' | 'star';
  lon: number;
  lat: number;
  airport: string;
  /** FAF: the runway it leads to. */
  runway?: string;
  /** Planned altitude at the fix, metres above sea level (FAFs). */
  altitude?: number;
  /** Placed by rule rather than taken from a published position; see the generated file. */
  approximate?: boolean;
}

export type AirportFrequencyType =
  | 'atis'
  | 'delivery'
  | 'ground'
  | 'apron'
  | 'tower'
  | 'approach'
  | 'arrival'
  | 'departure'
  | 'info';

export interface AirportFrequency {
  airport: string;
  type: AirportFrequencyType;
  /** What the pilot calls: 'Bern Tower', 'Zurich Arrival'. */
  name: string;
  /** kHz, the channel name as dialled (8.33 kHz channels as their 5-digit name, e.g. 121 905). */
  frequency: number;
}

export interface FisStation {
  name: string;
  frequency: number;
}

/** A vertical limit as published: feet above sea level or ground, or a flight level. */
export interface AirspaceLimit {
  ref: 'MSL' | 'AGL' | 'FL';
  /** Feet for MSL and AGL, hundreds of feet for FL. */
  value: number;
}

export interface Airspace {
  name: string;
  /** FOCA designator, e.g. 'LSZH-1'; the first four letters name the airport. */
  designator: string;
  type: 'CTR' | 'TMA' | 'FIZ';
  class: 'C' | 'D' | 'G';
  airport: string;
  lower: AirspaceLimit;
  upper: AirspaceLimit;
  /** Outline, [lon, lat, lon, lat, ...], not closed. Simplified: see `toleranceM`. */
  ring: readonly number[];
  /** The outline is within this many metres of the published one. */
  toleranceM: number;
}

/** A point of a flight plan; matches the simulation's `Waypoint`. */
export interface FlightPlanPoint {
  ident: string;
  lon: number;
  lat: number;
  /** Metres above sea level. */
  altitude?: number;
}

export const NAV_STATIONS: readonly NavStationInfo[] = NAV_STATION_DATA;
export const NAV_FIXES: readonly NavFix[] = NAV_FIX_DATA;
export const AIRPORT_FREQUENCIES: readonly AirportFrequency[] = AIRPORT_FREQUENCY_DATA;
export const FIS_STATIONS: readonly FisStation[] = FIS_DATA;
export const AIRSPACES: readonly Airspace[] = AIRSPACE_DATA;

/** Credits of the navigation data, for the interface. */
export const NAV_ATTRIBUTION =
  'Navigation data: OurAirports (public domain), © OpenStreetMap contributors (ODbL), airspace © Federal Office of Civil Aviation FOCA (opendata.swiss). Not for real navigation.';

const NM = 1852;
const FT = 0.3048;

const byFrequency = new Map<number, NavStationInfo[]>();
for (const s of NAV_STATIONS) {
  const list = byFrequency.get(s.frequency) ?? [];
  list.push(s);
  byFrequency.set(s.frequency, list);
}

/** Every station on a frequency (kHz). */
export function stationsOnFrequency(frequency: number): readonly NavStationInfo[] {
  return byFrequency.get(Math.round(frequency)) ?? [];
}

/** The stations as the simulation's `NavDatabase`. */
export function navDatabase(): { onFrequency(frequency: number): readonly NavStationInfo[] } {
  return { onFrequency: stationsOnFrequency };
}

export function findStation(ident: string, type?: NavStationType): NavStationInfo | undefined {
  const id = ident.toUpperCase();
  return NAV_STATIONS.find((s) => s.ident === id && (!type || s.type === type));
}

/** The localizer (with or without glide slope) of a runway end. */
export function ilsFor(icao: string, runway: string): NavStationInfo | undefined {
  const code = icao.toUpperCase();
  return NAV_STATIONS.find(
    (s) => (s.type === 'ILS' || s.type === 'LOC') && s.airport === code && s.runway === runway,
  );
}

/** Stations within `radius` metres, nearest first. */
export function stationsNear(
  lon: number,
  lat: number,
  radius = 100_000,
  types?: readonly NavStationType[],
): Array<{ station: NavStationInfo; distance: number }> {
  const here = { lon, lat };
  return NAV_STATIONS.filter((s) => !types || types.includes(s.type))
    .map((station) => ({ station, distance: distanceM(here, station) }))
    .filter((s) => s.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
}

export function frequenciesOf(icao: string): readonly AirportFrequency[] {
  const code = icao.toUpperCase();
  return AIRPORT_FREQUENCIES.filter((f) => f.airport === code);
}

export function fixesOf(icao: string): readonly NavFix[] {
  const code = icao.toUpperCase();
  return NAV_FIXES.filter((f) => f.airport === code);
}

/** The flight information service responsible for a position (Zurich or Geneva Information). */
export function fisAt(lon: number, lat: number): FisStation {
  // West of the sector line is Geneva: the line runs north to south, so the sign of the cross
  // product with the segment at this latitude tells the side.
  const line = FIS_LINE_DATA;
  let i = 0;
  while (i < line.length - 2 && lat < line[i + 1]![1]) i++;
  const [ax, ay] = line[i]!;
  const [bx, by] = line[i + 1]!;
  const west = (bx - ax) * (lat - ay) - (by - ay) * (lon - ax) < 0;
  const name = west ? 'Geneva Information' : 'Zurich Information';
  return FIS_STATIONS.find((f) => f.name === name)!;
}

/**
 * A limit in metres above sea level. AGL needs the ground elevation below; flight levels are
 * taken in the standard atmosphere (pressure altitude as altitude).
 */
export function limitMetres(limit: AirspaceLimit, groundElevation: number): number {
  if (limit.ref === 'FL') return limit.value * 100 * FT;
  if (limit.ref === 'AGL') return groundElevation + limit.value * FT;
  return limit.value * FT;
}

function insideRing(lon: number, lat: number, ring: readonly number[]): boolean {
  let c = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i]!;
    const yi = ring[2 * i + 1]!;
    const xj = ring[2 * j]!;
    const yj = ring[2 * j + 1]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/**
 * The airspaces containing a point at `altitude` metres above sea level, CTRs first. Without
 * `groundElevation`, AGL limits are measured from the elevation of the airspace's airport.
 */
export function airspacesAt(
  lon: number,
  lat: number,
  altitude: number,
  groundElevation?: number,
): Airspace[] {
  const order = { CTR: 0, FIZ: 1, TMA: 2 };
  return AIRSPACES.filter((a) => {
    const ground = groundElevation ?? findAirport(a.airport)?.elevation ?? 0;
    // A lower limit at the ground includes the ground, even a little below it.
    const lower =
      a.lower.value === 0 && a.lower.ref !== 'FL' ? -Infinity : limitMetres(a.lower, ground);
    return (
      altitude >= lower && altitude < limitMetres(a.upper, ground) && insideRing(lon, lat, a.ring)
    );
  }).sort((p, q) => order[p.type] - order[q.type]);
}

/**
 * The final approach fix of a runway end: `distanceNm` out on the extended centre line (or the
 * localizer course of an offset approach), at the glide path height above the threshold.
 */
export function finalApproachFix(
  icao: string,
  runway: string,
  distanceNm = 6,
): FlightPlanPoint | undefined {
  const airport = findAirport(icao);
  const found = airport && findRunwayEnd(airport, runway);
  if (!airport || !found) return undefined;
  const thr = thresholdOf(found.end, found.opposite);
  const ils = ilsFor(airport.icao, runway);
  const course = ils?.course ?? bearingDeg(found.end, found.opposite);
  const angle = ils?.glideSlope?.angleDeg ?? 3;
  const p = offsetPoint(thr, course + 180, distanceNm * NM);
  const elevation = found.end.elevation ?? airport.elevation;
  const altitude = elevation + 15 + Math.tan((angle * Math.PI) / 180) * distanceNm * NM;
  return { ident: `FF${runway}`, lon: p.lon, lat: p.lat, altitude: Math.round(altitude) };
}

/**
 * The runway end to land on when arriving from `from`: an ILS end if there is one, else the
 * longest paved runway; of its two ends the one whose final approach starts nearest to the
 * direction of arrival (no wind is known here).
 */
function landingRunway(
  airport: AirportInfo,
  from: { lon: number; lat: number },
): string | undefined {
  const inbound = bearingDeg(from, airport);
  const ends = airport.runways.flatMap((r) => r.ends.map((e, i) => ({ e, o: r.ends[1 - i]!, r })));
  if (ends.length === 0) return undefined;
  const score = (x: (typeof ends)[number]) => {
    const course = bearingDeg(x.e, x.o);
    const turn = Math.abs(((((course - inbound) % 360) + 540) % 360) - 180);
    const ils = ilsFor(airport.icao, x.e.ident) ? 0 : 1000;
    const paved = isPaved(x.r.surface) ? 0 : 2000;
    return ils + paved - x.r.length / 100 + turn;
  };
  return ends.reduce((best, x) => (score(x) < score(best) ? x : best)).e.ident;
}

/**
 * A simple flight plan from one airport to another: the departure airport, up to two VORs near
 * the direct line, the final approach fix of the destination runway (6 NM out) and its
 * threshold. Undefined if an airport or the runway is unknown.
 */
export function planFlight(
  fromIcao: string,
  toIcao: string,
  options: { runway?: string } = {},
): FlightPlanPoint[] | undefined {
  const from = findAirport(fromIcao);
  const to = findAirport(toIcao);
  if (!from || !to) return undefined;
  const runway = options.runway ?? landingRunway(to, from);
  const found = runway ? findRunwayEnd(to, runway) : undefined;
  if (!runway || !found) return undefined;
  const faf = finalApproachFix(to.icao, runway)!;
  const thr = thresholdOf(found.end, found.opposite);
  const plan: FlightPlanPoint[] = [
    { ident: from.icao, lon: from.lon, lat: from.lat, altitude: Math.round(from.elevation) },
  ];
  // VORs that lie within 12 km of the direct line, between a fifth and four fifths of the way,
  // so that the detour stays small and the points are worth tuning.
  const total = distanceM(from, faf);
  const course = bearingDeg(from, faf);
  if (total > 40_000) {
    const candidates = NAV_STATIONS.filter((s) => s.type === 'VOR' || s.type === 'VOR-DME')
      .map((s) => {
        const d = distanceM(from, s);
        const rel = ((bearingDeg(from, s) - course) * Math.PI) / 180;
        return { s, along: d * Math.cos(rel), cross: Math.abs(d * Math.sin(rel)) };
      })
      .filter((c) => c.cross < 12_000 && c.along > 0.2 * total && c.along < 0.8 * total)
      .sort((a, b) => a.cross - b.cross);
    const chosen: typeof candidates = [];
    for (const c of candidates) {
      if (chosen.length >= 2) break;
      if (chosen.every((o) => Math.abs(o.along - c.along) > 20_000)) chosen.push(c);
    }
    chosen.sort((a, b) => a.along - b.along);
    for (const c of chosen) plan.push({ ident: c.s.ident, lon: c.s.lon, lat: c.s.lat });
  }
  const elevation = found.end.elevation ?? to.elevation;
  plan.push(faf, {
    ident: `RW${runway}`,
    lon: thr.lon,
    lat: thr.lat,
    altitude: Math.round(elevation),
  });
  return plan;
}
