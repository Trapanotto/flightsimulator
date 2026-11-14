import type { AircraftId, AircraftInfo, FailureId } from '@sim';
import type { AirportOption, FlightPlan, PlannedFailure, SeasonChoice, WeatherChoice } from './api';
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

/** Heights above the airport offered for a start in the air, metres (1000, 3000, 6000 ft). */
export const AIR_START_HEIGHTS = [304.8, 914.4, 1828.8] as const;

/** Distances out on final offered for an approach start, nautical miles. */
export const APPROACH_DISTANCES = [4, 6, 8, 10, 12] as const;

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

/** When a chosen failure strikes, minutes after the start. */
export const FAILURE_MINUTES = [1, 3, 5, 10, 20] as const;

export type StartKind = 'runway' | 'air' | 'approach';
export type FailureMode = 'none' | 'random' | 'chosen';

/**
 * What the flight setup holds. Richer than a FlightPlan (an air start keeps its airport and
 * runway, a switched-off failure keeps its choice), so it is what gets remembered between
 * visits.
 */
export interface SetupDraft {
  airport: string;
  runway: string;
  start: StartKind;
  /** Index into AIR_START_HEIGHTS. */
  airHeight: number;
  /** One of APPROACH_DISTANCES. */
  approachNm: number;
  aircraft: AircraftId | '';
  time: 'now' | number;
  weather: WeatherChoice;
  season: SeasonChoice;
  /** ICAO of the destination, or '' for none. */
  destination: string;
  destinationRunway: string;
  /** Only with a start on the runway: a parked aircraft has no business in the air. */
  coldStart: boolean;
  atc: boolean;
  failureMode: FailureMode;
  failureId: FailureId;
  /** One of FAILURE_MINUTES. */
  failureAfterMin: number;
  /**
   * Picks the failure of the 'random' mode. Rolled anew at every start, so the plan itself
   * stays a pure function of the draft (the preview must not flicker between failures).
   */
  failureSeed: number;
}

export const DRAFT_KEY = 'tfs.setup';

/** Bern-Belp is the home airport of phase 1; any other airport serves if it is missing. */
export const HOME_ICAO = 'LSZB';

export function defaultDraft(
  airports: readonly AirportOption[],
  aircraft: readonly AircraftInfo[],
): SetupDraft {
  const home = airports.find((a) => a.icao === HOME_ICAO) ?? airports[0];
  return {
    airport: home?.icao ?? '',
    runway: home?.runways[0] ?? '',
    start: 'runway',
    airHeight: 1,
    approachNm: 8,
    aircraft: aircraft[0]?.id ?? '',
    time: 'now',
    weather: 'live',
    season: 'now',
    destination: '',
    destinationRunway: '',
    coldStart: false,
    atc: true,
    failureMode: 'none',
    failureId: 'engine',
    failureAfterMin: 5,
    failureSeed: 0,
  };
}

function oneOf<T>(v: unknown, options: readonly T[], fallback: T): T {
  return options.includes(v as T) ? (v as T) : fallback;
}

/**
 * Makes a stored or edited draft fit what is on offer now: an airport or aircraft that is no
 * longer offered falls back to the default, a runway to the airport's first. Anything that is
 * not a sensible value is replaced, so corrupt storage can never block the menu.
 */
export function sanitizeDraft(
  raw: unknown,
  airports: readonly AirportOption[],
  aircraft: readonly AircraftInfo[],
): SetupDraft {
  const d = defaultDraft(airports, aircraft);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return d;
  const o = raw as Record<string, unknown>;

  const airport = airports.find((a) => a.icao === o.airport);
  const icao = airport?.icao ?? d.airport;
  const runways = (airport ?? airports.find((a) => a.icao === icao))?.runways ?? [];
  const runway =
    typeof o.runway === 'string' && runways.includes(o.runway) ? o.runway : (runways[0] ?? '');

  const dest = airports.find((a) => a.icao === o.destination);
  const destRunway =
    dest && typeof o.destinationRunway === 'string' && dest.runways.includes(o.destinationRunway)
      ? o.destinationRunway
      : (dest?.runways[0] ?? '');

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
    o.airHeight < AIR_START_HEIGHTS.length
      ? o.airHeight
      : d.airHeight;

  return {
    airport: icao,
    runway,
    start: oneOf<StartKind>(o.start, ['runway', 'air', 'approach'], 'runway'),
    airHeight,
    approachNm: oneOf<number>(o.approachNm, APPROACH_DISTANCES, d.approachNm),
    aircraft: aircraft.find((a) => a.id === o.aircraft)?.id ?? d.aircraft,
    time,
    weather: oneOf(o.weather, WEATHER_CHOICES, d.weather),
    season: oneOf(o.season, SEASON_CHOICES, d.season),
    destination: dest?.icao ?? '',
    destinationRunway: destRunway,
    coldStart: typeof o.coldStart === 'boolean' ? o.coldStart : d.coldStart,
    atc: typeof o.atc === 'boolean' ? o.atc : d.atc,
    failureMode: oneOf<FailureMode>(o.failureMode, ['none', 'random', 'chosen'], d.failureMode),
    failureId: oneOf(o.failureId, FAILURE_IDS, d.failureId),
    failureAfterMin: oneOf<number>(o.failureAfterMin, FAILURE_MINUTES, d.failureAfterMin),
    failureSeed:
      typeof o.failureSeed === 'number' && Number.isInteger(o.failureSeed) && o.failureSeed >= 0
        ? o.failureSeed
        : d.failureSeed,
  };
}

/** Why a draft cannot fly yet, or null when it can. */
export type PlanProblem = 'noAirport' | 'noAircraft';

export function planProblem(
  draft: SetupDraft,
  airports: readonly AirportOption[],
  aircraft: readonly AircraftInfo[],
): PlanProblem | null {
  if (!airports.some((a) => a.icao === draft.airport)) return 'noAirport';
  if (!aircraft.some((a) => a.id === draft.aircraft)) return 'noAircraft';
  return null;
}

/** The failures a draft asks for. */
export function draftFailures(draft: SetupDraft): PlannedFailure[] {
  if (draft.failureMode === 'chosen')
    return [{ id: draft.failureId, after: draft.failureAfterMin * 60 }];
  if (draft.failureMode === 'random')
    return [{ id: FAILURE_IDS[draft.failureSeed % FAILURE_IDS.length]!, after: 'random' }];
  return [];
}

/** The plan for the app, or null when the draft is not flyable (see planProblem). */
export function draftToPlan(
  draft: SetupDraft,
  airports: readonly AirportOption[],
  aircraft: readonly AircraftInfo[],
): FlightPlan | null {
  if (planProblem(draft, airports, aircraft)) return null;
  const airport = airports.find((a) => a.icao === draft.airport)!;
  const runway = airport.runways.includes(draft.runway) ? draft.runway : (airport.runways[0] ?? '');
  const start: FlightPlan['start'] =
    draft.start === 'air' || !runway
      ? {
          kind: 'air',
          lon: airport.lon,
          lat: airport.lat,
          altitude:
            airport.elevation + (AIR_START_HEIGHTS[draft.airHeight] ?? AIR_START_HEIGHTS[1]),
          // Lined up with the chosen runway, so the airport is right ahead after a turn or two.
          headingDeg: runway ? runwayHeading(runway) % 360 : 0,
        }
      : draft.start === 'approach'
        ? { kind: 'approach', airport: airport.icao, runway, distanceNm: draft.approachNm }
        : { kind: 'runway', airport: airport.icao, runway };
  const dest = airports.find((a) => a.icao === draft.destination);
  const plan: FlightPlan = {
    aircraft: draft.aircraft as AircraftId,
    start,
    time: draft.time,
    weather: draft.weather,
    season: draft.season,
    airport: airport.icao,
    coldStart: start.kind === 'runway' && draft.coldStart,
    atc: draft.atc,
    failures: draftFailures(draft),
  };
  if (dest)
    plan.destination = dest.runways.includes(draft.destinationRunway)
      ? { airport: dest.icao, runway: draft.destinationRunway }
      : { airport: dest.icao };
  return plan;
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
  if (!aircraft.some((a) => a.id === p.aircraft)) return 'unknown aircraft';
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
    return null;
  };
  if (s.kind === 'runway' || s.kind === 'approach') {
    const problem = runwayProblem(s.airport, s.runway);
    if (problem) return problem;
    if (s.kind === 'approach' && !(finite(s.distanceNm) && s.distanceNm >= 4 && s.distanceNm <= 12))
      return 'approach distance out of range';
  } else if (s.kind === 'air') {
    if (!(Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180)) return 'position out of range';
    if (!(s.altitude > -500 && s.altitude < 20_000)) return 'altitude out of range';
    if (!(s.headingDeg >= 0 && s.headingDeg < 360)) return 'heading out of range';
  } else return 'unknown start';

  if (p.destination !== undefined) {
    const d = p.destination;
    if (!d || typeof d !== 'object') return 'bad destination';
    const a = airports.find((x) => x.icao === d.airport);
    if (!a) return 'unknown destination';
    if (d.runway !== undefined && !a.runways.includes(d.runway))
      return 'unknown destination runway';
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

// --- Scenarios -----------------------------------------------------------------------------

export type ScenarioId = 'ilsZurich' | 'bernCircuit' | 'alpsSamedan' | 'nightGeneva';

export interface Scenario {
  id: ScenarioId;
  /** The airports it needs; without them it is not offered. */
  needs: string[];
  draft: Partial<SetupDraft>;
}

/** Ready-made flights, one click from the setup. The first is the showpiece of phase 3. */
export const SCENARIOS: readonly Scenario[] = [
  {
    // ILS 14 at Zurich under a Hochnebel deck: break out at about 1000 ft above the ground.
    id: 'ilsZurich',
    needs: ['LSZH'],
    draft: {
      airport: 'LSZH',
      runway: '14',
      start: 'approach',
      approachNm: 10,
      weather: 'lowStratus',
      time: 9,
      season: 'autumn',
      destination: 'LSZH',
      destinationRunway: '14',
      coldStart: false,
      atc: true,
      failureMode: 'none',
    },
  },
  {
    id: 'bernCircuit',
    needs: ['LSZB'],
    draft: {
      airport: 'LSZB',
      runway: '14',
      start: 'runway',
      weather: 'fair',
      time: 10.5,
      season: 'summer',
      destination: 'LSZB',
      destinationRunway: '14',
      coldStart: false,
      atc: true,
      failureMode: 'none',
    },
  },
  {
    // Over the Bernese Oberland and Grisons into the Engadine, 1707 m up.
    id: 'alpsSamedan',
    needs: ['LSZB', 'LSZS'],
    draft: {
      airport: 'LSZB',
      runway: '14',
      start: 'runway',
      weather: 'clear',
      time: 9,
      season: 'summer',
      destination: 'LSZS',
      destinationRunway: '21',
      coldStart: false,
      atc: true,
      failureMode: 'none',
    },
  },
  {
    id: 'nightGeneva',
    needs: ['LSGG'],
    draft: {
      airport: 'LSGG',
      runway: '22',
      start: 'approach',
      approachNm: 8,
      weather: 'clear',
      time: 21.75,
      season: 'autumn',
      destination: 'LSGG',
      destinationRunway: '22',
      coldStart: false,
      atc: true,
      failureMode: 'none',
    },
  },
];

/** The scenarios this set of airports can fly. */
export function availableScenarios(airports: readonly AirportOption[]): Scenario[] {
  return SCENARIOS.filter((s) => s.needs.every((icao) => airports.some((a) => a.icao === icao)));
}

/** The setup of a scenario on top of the pilot's aircraft choice; null when it cannot fly. */
export function scenarioDraft(
  scenario: Scenario,
  base: SetupDraft,
  airports: readonly AirportOption[],
  aircraft: readonly AircraftInfo[],
): SetupDraft | null {
  if (!availableScenarios(airports).includes(scenario)) return null;
  const d = sanitizeDraft({ ...base, ...scenario.draft }, airports, aircraft);
  return planProblem(d, airports, aircraft) ? null : d;
}

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
