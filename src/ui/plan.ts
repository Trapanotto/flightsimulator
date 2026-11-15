import type { AircraftId, AircraftInfo, FailureId } from '@sim';
import type { AirportOption, FlightPlan, PlannedFailure, SeasonChoice, WeatherChoice } from './api';
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
import { sunTimes } from './sun';

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

/** When a chosen failure strikes, minutes after the start. */
export const FAILURE_MINUTES = [1, 3, 5, 10, 20] as const;

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
 *
 * Phase 4: the draft also fits its aircraft. An airport the type may not use gives way to the
 * type's home (choosing the A320 at Bern moves the setup to Zürich), a runway or destination
 * it may not use is dropped, the approach distance moves to the nearest the type offers.
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

  const dest = airports.find((a) => a.icao === o.destination && eligible(a, category));
  const destRunways = dest ? usableEnds(dest, category) : [];
  const destRunway =
    dest && typeof o.destinationRunway === 'string' && destRunways.includes(o.destinationRunway)
      ? o.destinationRunway
      : (destRunways[0] ?? '');

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
  const dest = airports.find((a) => a.icao === draft.destination);
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

// --- Scenarios -----------------------------------------------------------------------------

export type ScenarioId =
  | 'ilsZurich'
  | 'bernCircuit'
  | 'alpsSamedan'
  | 'nightGeneva'
  | 'a320Zurich'
  | 'fa18Meiringen'
  | 'pc12Samedan';

export interface Scenario {
  id: ScenarioId;
  /** The airports it needs; without them it is not offered. */
  needs: string[];
  /**
   * Phase 4: the type it is made for; offered only while that type exists. Without it the
   * scenario flies the pilot's choice, if that type may use the airports.
   */
  aircraft?: AircraftId;
  /** The time of day is a quarter of an hour after today's sunset at the airport. */
  dusk?: boolean;
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
    // The A320 on the same runway as the evening wave of arrivals comes in.
    id: 'a320Zurich',
    needs: ['LSZH'],
    aircraft: 'a320',
    dusk: true,
    draft: {
      airport: 'LSZH',
      runway: '14',
      start: 'approach',
      approachNm: 12,
      weather: 'fair',
      season: 'autumn',
      destination: 'LSZH',
      destinationRunway: '14',
      coldStart: false,
      atc: true,
      failureMode: 'none',
    },
  },
  {
    // Out of the Haslital and down the valleys, as the Hornets of Meiringen train.
    id: 'fa18Meiringen',
    needs: ['LSMM', 'LSMP'],
    aircraft: 'fa18',
    draft: {
      airport: 'LSMM',
      runway: '28',
      start: 'runway',
      weather: 'clear',
      time: 10,
      season: 'summer',
      destination: 'LSMP',
      destinationRunway: '23',
      coldStart: false,
      atc: true,
      failureMode: 'none',
    },
  },
  {
    // Samedan, 1707 m: down the Engadine onto runway 21 on a winter morning.
    id: 'pc12Samedan',
    needs: ['LSZS'],
    aircraft: 'pc12',
    draft: {
      airport: 'LSZS',
      runway: '21',
      start: 'approach',
      approachNm: 8,
      weather: 'clear',
      time: 10,
      season: 'winter',
      destination: 'LSZS',
      destinationRunway: '21',
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

/**
 * The scenarios this set of airports can fly. The ones made for a type come only while that
 * type is in `aircraft`.
 */
export function availableScenarios(
  airports: readonly AirportOption[],
  aircraft: readonly AircraftInfo[] = [],
): Scenario[] {
  return SCENARIOS.filter(
    (s) =>
      s.needs.every((icao) => airports.some((a) => a.icao === icao)) &&
      (!s.aircraft || aircraft.some((a) => a.id === s.aircraft)),
  );
}

/** The type a scenario flies: its own, else the pilot's choice. */
export function scenarioAircraft(
  scenario: Scenario,
  base: SetupDraft,
  aircraft: readonly AircraftInfo[],
): AircraftInfo | undefined {
  return aircraft.find((a) => a.id === (scenario.aircraft ?? base.aircraft));
}

/**
 * Why the pilot's type cannot fly a scenario: the first of its airports it may not use (a
 * circuit at Bern is too short for the A320), or null when it can.
 */
export function scenarioBlocker(
  scenario: Scenario,
  base: SetupDraft,
  airports: readonly AirportOption[],
  aircraft: readonly AircraftInfo[],
): AirportOption | null {
  const category = categoryOf(scenarioAircraft(scenario, base, aircraft));
  for (const icao of [scenario.draft.airport, scenario.draft.destination]) {
    const a = airports.find((x) => x.icao === icao);
    if (a && !eligible(a, category)) return a;
  }
  return null;
}

/** The setup of a scenario on top of the pilot's aircraft choice; null when it cannot fly. */
export function scenarioDraft(
  scenario: Scenario,
  base: SetupDraft,
  airports: readonly AirportOption[],
  aircraft: readonly AircraftInfo[],
  today = new Date(),
): SetupDraft | null {
  if (!availableScenarios(airports, aircraft).includes(scenario)) return null;
  if (scenarioBlocker(scenario, base, airports, aircraft)) return null;
  const patch: Partial<SetupDraft> = { ...scenario.draft };
  if (scenario.aircraft) patch.aircraft = scenario.aircraft;
  if (scenario.dusk) patch.time = duskHours(airports, scenario.draft.airport, today);
  const d = sanitizeDraft({ ...base, ...patch }, airports, aircraft);
  return planProblem(d, airports, aircraft) ? null : d;
}

/** A quarter of an hour after sunset at the airport, to the quarter hour (18:00 if unknown). */
export function duskHours(
  airports: readonly AirportOption[],
  icao: string | undefined,
  today: Date,
): number {
  const a = airports.find((x) => x.icao === icao);
  const sun = a ? sunTimes(today, a.lat, a.lon) : null;
  if (!sun) return 18;
  return Math.min(24, Math.round((sun.sunset + 0.25) * 4) / 4);
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
