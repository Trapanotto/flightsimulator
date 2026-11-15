import type { AircraftId, AircraftInfo, FailureId } from '@sim';
import type { AirportOption, FlightPlan, SeasonChoice, WeatherChoice } from './api';
import {
  type Category,
  airportEligibility,
  categoryOf,
  eligible,
  homeAirport,
  nearest,
  typeDefaults,
} from './fleet';
import { runwayHeading } from './format';

export const SEASON_CHOICES: readonly SeasonChoice[] = [
  'now',
  'spring',
  'summer',
  'autumn',
  'winter',
];

export const WEATHER_CHOICES: readonly WeatherChoice[] = [
  'live',
  'clear',
  'fair',
  'cloudy',
  'overcast',
  'lowStratus',
];

/**
 * Heights above the airport offered for a start in the air, metres (1000, 3000, 6000 ft): the
 * Cessna's. Every type has its own (`typeDefaults(info).airHeights`), always three.
 */
export const AIR_START_HEIGHTS = [304.8, 914.4, 1828.8] as const;

/** Distances out on final offered for an approach start, nautical miles (the Cessna's). */
export const APPROACH_DISTANCES = [4, 6, 8, 10, 12] as const;

/** The range every type's approach distances stay within, NM (a stored value outside is junk). */
export const APPROACH_RANGE = [2, 20] as const;

/** Everything the C172 can be made to fail (`FailureId` of the sim, in the menu's order). */
export const FAILURE_IDS: readonly FailureId[] = [
  'engine',
  'magnetoLeft',
  'alternator',
  'vacuum',
  'pitot',
  'fuelLeak',
  'com1',
];

export type StartKind = 'runway' | 'air' | 'approach';

/** Where on the map an air start may be put: around Switzerland, a margin included. */
export const AIR_LON_RANGE = [5.6, 10.8] as const;
export const AIR_LAT_RANGE = [45.6, 48.0] as const;

const FT = 0.3048;

/** An air start placed on the map: 6000 ft above sea level until the pilot says otherwise. */
export const AIR_ALTITUDE_DEFAULT = 6000 * FT;

/**
 * Altitudes above sea level offered for a start placed on the map, metres: from 2000 ft up
 * to what the kind of aircraft flies at.
 */
export function airAltitudeRange(category: Category): readonly [number, number] {
  const top = { piston: 14_000, turboprop: 28_000, airliner: 39_000, fighter: 45_000 }[category];
  return [2000 * FT, top * FT];
}

/**
 * What the flight setup holds. Richer than a FlightPlan (an air start keeps its airport and
 * runway), so it is what gets remembered between visits. Destination, cold start, radio and
 * failures are no longer chosen: every flight starts with the engine running, air traffic
 * control on and nothing broken.
 */
export interface SetupDraft {
  airport: string;
  runway: string;
  start: StartKind;
  /** Index into the type's air start heights (three for every type). */
  airHeight: number;
  /**
   * An air start above the chosen airport (lined up with its runway), or anywhere the pilot
   * put it on the map, at an altitude above sea level and a heading of the pilot's choice.
   */
  airPlace: 'airport' | 'map';
  /** The map's place, degrees; null until the pilot has put one. */
  airLon: number | null;
  airLat: number | null;
  /** Metres above sea level. */
  airAltitude: number;
  /** Degrees true, 0..359. */
  airHeading: number;
  /** One of the type's approach distances. */
  approachNm: number;
  aircraft: AircraftId | '';
  time: 'now' | number;
  weather: WeatherChoice;
  season: SeasonChoice;
}

export const DRAFT_KEY = 'tfs.setup';

/** Bern-Belp is the home airport of phase 1; any other airport serves if it is missing. */
export const HOME_ICAO = 'LSZB';

/** The runway ends of an airport a category may use (all of them for the Cessna). */
export function usableEnds(a: AirportOption, category: Category): string[] {
  const e = airportEligibility(a, category);
  return e.ok ? e.ends : [];
}

export function defaultDraft(
  airports: readonly AirportOption[],
  aircraft: readonly AircraftInfo[],
): SetupDraft {
  const info = aircraft[0];
  const category = categoryOf(info);
  const home =
    (category === 'piston' ? airports.find((a) => a.icao === HOME_ICAO) : undefined) ??
    homeAirport(airports, category) ??
    airports[0];
  return {
    airport: home?.icao ?? '',
    runway: (home && usableEnds(home, category)[0]) ?? '',
    start: 'runway',
    airHeight: 1,
    airPlace: 'airport',
    airLon: null,
    airLat: null,
    airAltitude: AIR_ALTITUDE_DEFAULT,
    airHeading: 0,
    approachNm: typeDefaults(info).approachNm,
    aircraft: info?.id ?? '',
    time: 'now',
    weather: 'live',
    season: 'now',
  };
}

function oneOf<T>(v: unknown, options: readonly T[], fallback: T): T {
  return options.includes(v as T) ? (v as T) : fallback;
}

/**
 * Makes a stored or edited draft fit what is on offer now: an airport or aircraft that is no
 * longer offered falls back to the default, a runway to the airport's first. Anything that is
 * not a sensible value is replaced, so corrupt storage can never block the menu.
 *
 * Phase 4: the draft also fits its aircraft. An airport the type may not use gives way to the
 * type's home (choosing the A320 at Bern moves the setup to Zürich), a runway it may not use
 * is dropped, the approach distance moves to the nearest the type offers.
 */
export function sanitizeDraft(
  raw: unknown,
  airports: readonly AirportOption[],
  aircraft: readonly AircraftInfo[],
): SetupDraft {
  const d = defaultDraft(airports, aircraft);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return d;
  const o = raw as Record<string, unknown>;

  const info =
    aircraft.find((a) => a.id === o.aircraft) ?? aircraft.find((a) => a.id === d.aircraft);
  const category = categoryOf(info);
  const defaults = typeDefaults(info);

  const asked = airports.find((a) => a.icao === o.airport);
  const airport =
    asked && eligible(asked, category)
      ? asked
      : asked
        ? homeAirport(airports, category)
        : (airports.find((a) => a.icao === d.airport && eligible(a, category)) ??
          homeAirport(airports, category));
  const icao = airport?.icao ?? d.airport;
  const runways = airport ? usableEnds(airport, category) : [];
  const runway =
    typeof o.runway === 'string' && runways.includes(o.runway) ? o.runway : (runways[0] ?? '');

  const time =
    o.time === 'now'
      ? 'now'
      : typeof o.time === 'number' && Number.isFinite(o.time) && o.time >= 0 && o.time <= 24
        ? o.time
        : d.time;

  const airHeight =
    typeof o.airHeight === 'number' &&
    Number.isInteger(o.airHeight) &&
    o.airHeight >= 0 &&
    o.airHeight < defaults.airHeights.length
      ? o.airHeight
      : d.airHeight;

  const inMap = (v: unknown, [lo, hi]: readonly [number, number]) =>
    typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
  const airLon = inMap(o.airLon, AIR_LON_RANGE);
  const airLat = inMap(o.airLat, AIR_LAT_RANGE);
  const [altLo, altHi] = airAltitudeRange(category);
  const alt = inMap(o.airAltitude, [0, 20_000]);

  return {
    airport: icao,
    runway,
    start: oneOf<StartKind>(o.start, ['runway', 'air', 'approach'], 'runway'),
    airHeight,
    airPlace: oneOf<'airport' | 'map'>(o.airPlace, ['airport', 'map'], 'airport'),
    airLon: airLon !== null && airLat !== null ? airLon : null,
    airLat: airLon !== null && airLat !== null ? airLat : null,
    airAltitude: alt === null ? d.airAltitude : Math.min(altHi, Math.max(altLo, alt)),
    airHeading:
      typeof o.airHeading === 'number' && Number.isFinite(o.airHeading)
        ? ((Math.round(o.airHeading) % 360) + 360) % 360
        : 0,
    // Kept as near as a new type allows; nonsense falls back to the type's default.
    approachNm:
      typeof o.approachNm === 'number' &&
      o.approachNm >= APPROACH_RANGE[0] &&
      o.approachNm <= APPROACH_RANGE[1]
        ? nearest(defaults.approachDistances, o.approachNm)
        : defaults.approachNm,
    aircraft: info?.id ?? '',
    time,
    weather: oneOf(o.weather, WEATHER_CHOICES, d.weather),
    season: oneOf(o.season, SEASON_CHOICES, d.season),
  };
}

/** Why a draft cannot fly yet, or null when it can. */
export type PlanProblem = 'noAirport' | 'noAircraft' | 'runway';

export function planProblem(
  draft: SetupDraft,
  airports: readonly AirportOption[],
  aircraft: readonly AircraftInfo[],
): PlanProblem | null {
  const airport = airports.find((a) => a.icao === draft.airport);
  if (!airport) return 'noAirport';
  const info = aircraft.find((a) => a.id === draft.aircraft);
  if (!info) return 'noAircraft';
  if (!eligible(airport, categoryOf(info))) return 'runway';
  return null;
}

/** The plan for the app, or null when the draft is not flyable (see planProblem). */
export function draftToPlan(
  draft: SetupDraft,
  airports: readonly AirportOption[],
  aircraft: readonly AircraftInfo[],
): FlightPlan | null {
  if (planProblem(draft, airports, aircraft)) return null;
  const airport = airports.find((a) => a.icao === draft.airport)!;
  const info = aircraft.find((a) => a.id === draft.aircraft);
  const defaults = typeDefaults(info);
  const ends = usableEnds(airport, categoryOf(info));
  const runway = ends.includes(draft.runway) ? draft.runway : (ends[0] ?? '');
  const heights = defaults.airHeights;
  const placed =
    draft.start === 'air' &&
    draft.airPlace === 'map' &&
    draft.airLon !== null &&
    draft.airLat !== null;
  const start: FlightPlan['start'] = placed
    ? {
        kind: 'air',
        lon: draft.airLon!,
        lat: draft.airLat!,
        altitude: draft.airAltitude,
        headingDeg: draft.airHeading,
        speed: defaults.airSpeed,
      }
    : draft.start === 'air' || !runway
      ? {
          kind: 'air',
          lon: airport.lon,
          lat: airport.lat,
          altitude: airport.elevation + (heights[draft.airHeight] ?? heights[1] ?? 0),
          // Lined up with the chosen runway, so the airport is right ahead after a turn or two.
          headingDeg: runway ? runwayHeading(runway) % 360 : 0,
          speed: defaults.airSpeed,
        }
      : draft.start === 'approach'
        ? { kind: 'approach', airport: airport.icao, runway, distanceNm: draft.approachNm }
        : { kind: 'runway', airport: airport.icao, runway };
  const plan: FlightPlan = {
    aircraft: draft.aircraft as AircraftId,
    start,
    time: draft.time,
    weather: draft.weather,
    season: draft.season,
    // A place on the map belongs to the airport nearest to it (briefing, radio, weather).
    airport: placed
      ? (nearestAirport(airports, draft.airLon!, draft.airLat!)?.icao ?? airport.icao)
      : airport.icao,
    coldStart: false,
    atc: true,
    failures: [],
  };
  return plan;
}

/** The airport nearest to a place (flat-earth distance, fine across Switzerland). */
export function nearestAirport(
  airports: readonly AirportOption[],
  lon: number,
  lat: number,
): AirportOption | undefined {
  const k = Math.cos((lat * Math.PI) / 180);
  let best: AirportOption | undefined;
  let bestD = Infinity;
  for (const a of airports) {
    const d = ((a.lon - lon) * k) ** 2 + (a.lat - lat) ** 2;
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  return best;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Checks a plan built anywhere (the app, a test, a link) against what is offered. Returns
 * null for a valid plan, otherwise the first problem found.
 */
export function validatePlan(
  plan: unknown,
  airports: readonly AirportOption[],
  aircraft: readonly AircraftInfo[],
): string | null {
  if (!plan || typeof plan !== 'object') return 'not an object';
  const p = plan as Partial<FlightPlan>;
  const info = aircraft.find((a) => a.id === p.aircraft);
  if (!info) return 'unknown aircraft';
  const category = categoryOf(info);
  if (!WEATHER_CHOICES.includes(p.weather as WeatherChoice)) return 'unknown weather';
  if (p.season !== undefined && !SEASON_CHOICES.includes(p.season)) return 'unknown season';
  if (p.time !== 'now' && !(finite(p.time) && p.time >= 0 && p.time <= 24))
    return 'time out of range';
  const s = p.start;
  if (!s || typeof s !== 'object') return 'no start';
  const runwayProblem = (icao: string, rwy: string) => {
    const a = airports.find((x) => x.icao === icao);
    if (!a) return 'unknown airport';
    if (!a.runways.includes(rwy)) return 'unknown runway';
    if (!usableEnds(a, category).includes(rwy)) return 'runway unsuitable for the aircraft';
    return null;
  };
  if (s.kind === 'runway' || s.kind === 'approach') {
    const problem = runwayProblem(s.airport, s.runway);
    if (problem) return problem;
    // Within what the type offers: 4 to 12 NM for the Cessna, out to 15 NM for the A320.
    const offered = typeDefaults(info).approachDistances;
    if (
      s.kind === 'approach' &&
      !(
        finite(s.distanceNm) &&
        s.distanceNm >= Math.min(...offered) &&
        s.distanceNm <= Math.max(...offered)
      )
    )
      return 'approach distance out of range';
  } else if (s.kind === 'air') {
    if (!(Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180)) return 'position out of range';
    if (!(s.altitude > -500 && s.altitude < 20_000)) return 'altitude out of range';
    if (!(s.headingDeg >= 0 && s.headingDeg < 360)) return 'heading out of range';
    if (s.speed !== undefined && !(finite(s.speed) && s.speed > 0 && s.speed < 400))
      return 'speed out of range';
  } else return 'unknown start';

  if (p.destination !== undefined) {
    const d = p.destination;
    if (!d || typeof d !== 'object') return 'bad destination';
    const a = airports.find((x) => x.icao === d.airport);
    if (!a) return 'unknown destination';
    if (d.runway !== undefined && !a.runways.includes(d.runway))
      return 'unknown destination runway';
    if (!eligible(a, category)) return 'destination unsuitable for the aircraft';
  }
  if (p.route !== undefined) {
    if (!Array.isArray(p.route)) return 'bad route';
    for (const w of p.route)
      if (
        !w ||
        typeof w.ident !== 'string' ||
        !finite(w.lat) ||
        !finite(w.lon) ||
        Math.abs(w.lat) > 90 ||
        Math.abs(w.lon) > 180
      )
        return 'bad waypoint';
  }
  if (p.coldStart !== undefined && typeof p.coldStart !== 'boolean') return 'bad cold start';
  if (p.coldStart && s.kind !== 'runway') return 'cold start needs a runway start';
  if (p.atc !== undefined && typeof p.atc !== 'boolean') return 'bad atc';
  if (p.failures !== undefined) {
    if (!Array.isArray(p.failures)) return 'bad failures';
    for (const f of p.failures) {
      if (!f || !FAILURE_IDS.includes(f.id)) return 'unknown failure';
      if (f.after !== 'random' && !(finite(f.after) && f.after >= 0)) return 'bad failure time';
    }
  }
  return null;
}

// --- Distances ---------------------------------------------------------------------------------

/** Great-circle distance in nautical miles (mean earth radius; the briefing rounds it). */
export function distanceNm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return (2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(a)))) / 1852;
}

/** Length of a route through its waypoints, NM. */
export function routeNm(points: readonly { lon: number; lat: number }[]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++)
    sum += distanceNm(points[i - 1]!.lon, points[i - 1]!.lat, points[i]!.lon, points[i]!.lat);
  return sum;
}
