import type { AircraftId, AircraftInfo } from '@sim';
import type { AirportOption, FlightPlan, SeasonChoice, WeatherChoice } from './api';
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
];

/** Heights above the airport offered for a start in the air, metres (1000, 3000, 6000 ft). */
export const AIR_START_HEIGHTS = [304.8, 914.4, 1828.8] as const;

/**
 * What the flight setup holds. Richer than a FlightPlan (an air start keeps its airport and
 * runway), so it is what gets remembered between visits.
 */
export interface SetupDraft {
  airport: string;
  runway: string;
  start: 'runway' | 'air';
  /** Index into AIR_START_HEIGHTS. */
  airHeight: number;
  aircraft: AircraftId | '';
  time: 'now' | number;
  weather: WeatherChoice;
  season: SeasonChoice;
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
    aircraft: aircraft[0]?.id ?? '',
    time: 'now',
    weather: 'live',
    season: 'now',
  };
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
    start: o.start === 'air' ? 'air' : 'runway',
    airHeight,
    aircraft: aircraft.find((a) => a.id === o.aircraft)?.id ?? d.aircraft,
    time,
    weather: WEATHER_CHOICES.includes(o.weather as WeatherChoice)
      ? (o.weather as WeatherChoice)
      : d.weather,
    season: SEASON_CHOICES.includes(o.season as SeasonChoice)
      ? (o.season as SeasonChoice)
      : d.season,
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
      : { kind: 'runway', airport: airport.icao, runway };
  return {
    aircraft: draft.aircraft as AircraftId,
    start,
    time: draft.time,
    weather: draft.weather,
    season: draft.season,
    airport: airport.icao,
  };
}

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
  if (p.time !== 'now' && !(typeof p.time === 'number' && p.time >= 0 && p.time <= 24))
    return 'time out of range';
  const s = p.start;
  if (!s || typeof s !== 'object') return 'no start';
  if (s.kind === 'runway') {
    const a = airports.find((x) => x.icao === s.airport);
    if (!a) return 'unknown airport';
    if (!a.runways.includes(s.runway)) return 'unknown runway';
  } else if (s.kind === 'air') {
    if (!(Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180)) return 'position out of range';
    if (!(s.altitude > -500 && s.altitude < 20_000)) return 'altitude out of range';
    if (!(s.headingDeg >= 0 && s.headingDeg < 360)) return 'heading out of range';
  } else return 'unknown start';
  return null;
}
