import { AIRPORTS as GEO_AIRPORTS, isPaved } from '@geo';
import type { AircraftId, AircraftInfo } from '@sim';
import type { AirportOption, RunwayStrip } from './api';

/**
 * What the interface does differently per kind of aircraft (phase 4): where a type may start,
 * the defaults of its flight setup, its keys. Pure functions over `AircraftInfo`, tested in
 * Node; the screens only ask these.
 */

export type Category = 'piston' | 'turboprop' | 'airliner' | 'fighter';

export const CATEGORIES: readonly Category[] = ['piston', 'turboprop', 'airliner', 'fighter'];

/** Types that predate `AircraftInfo.category` still get the right one. */
const CATEGORY_BY_ID: Partial<Record<AircraftId, Category>> = {
  c172: 'piston',
  pc12: 'turboprop',
  a320: 'airliner',
  fa18: 'fighter',
};

export function categoryOf(info: AircraftInfo | undefined): Category {
  if (!info) return 'piston';
  return info.category ?? CATEGORY_BY_ID[info.id] ?? 'piston';
}

/** Jets and turboprops read their engines differently from a piston engine. */
export function engineKind(info: AircraftInfo | undefined): 'piston' | 'turboprop' | 'jet' {
  const c = categoryOf(info);
  return c === 'airliner' || c === 'fighter' ? 'jet' : c;
}

/** The name on the hangar's cards and in short texts: what a pilot calls the type. */
const SHORT_NAME: Partial<Record<AircraftId, string>> = {
  c172: 'C172',
  pc12: 'PC-12',
  a320: 'A320',
  fa18: 'F/A-18',
};

export function shortName(info: AircraftInfo): string {
  return SHORT_NAME[info.id] ?? info.name;
}

// --- Where a type may start --------------------------------------------------------------------

/**
 * The runway a category needs. An airliner needs a long hard runway; a fighter a shorter hard
 * one, or any hard runway of a military field (arresting gear, its own procedures); a PC-12
 * operates from grass but not from the shortest strips. The piston single goes anywhere.
 */
export interface RunwayNeed {
  /** Metres. */
  minLength: number;
  paved: boolean;
  /** A military field qualifies with any paved runway, whatever its length. */
  military: boolean;
}

export const RUNWAY_NEED: Readonly<Record<Category, RunwayNeed | null>> = {
  piston: null,
  turboprop: { minLength: 700, paved: false, military: false },
  airliner: { minLength: 1800, paved: true, military: false },
  fighter: { minLength: 1200, paved: true, military: true },
};

/**
 * The runways of an airport: the option's own data, else the geo package's by ICAO (the app
 * may not fill them yet). Null when nothing is known: such an airport is never refused.
 */
export function runwayData(a: AirportOption): { strips: RunwayStrip[]; military: boolean } | null {
  if (a.strips) return { strips: a.strips, military: !!a.military };
  const g = GEO_AIRPORTS.find((x) => x.icao === a.icao);
  if (!g) return null;
  return {
    strips: g.runways.map((r) => ({
      ends: r.ends.map((e) => e.ident),
      length: r.length,
      paved: isPaved(r.surface),
    })),
    military: a.military ?? g.military,
  };
}

export type Eligibility =
  | { ok: true; /** Runway ends the type may use. */ ends: string[] }
  | {
      ok: false;
      reason: 'short' | 'unpaved';
      /** Metres: the longest runway of the surface the type needs. */
      longest: number;
      need: RunwayNeed;
    };

export function stripFits(strip: RunwayStrip, military: boolean, need: RunwayNeed): boolean {
  if (need.paved && !strip.paved) return false;
  return strip.length >= need.minLength || (need.military && military && strip.paved);
}

/** Whether a category may start or land at an airport, and on which runway ends. */
export function airportEligibility(a: AirportOption, category: Category): Eligibility {
  const need = RUNWAY_NEED[category];
  const data = need ? runwayData(a) : null;
  if (!need || !data) return { ok: true, ends: a.runways };
  const ends = new Set(
    data.strips.filter((s) => stripFits(s, data.military, need)).flatMap((s) => s.ends),
  );
  const usable = a.runways.filter((r) => ends.has(r));
  if (usable.length) return { ok: true, ends: usable };
  const surface = data.strips.filter((s) => !need.paved || s.paved);
  if (!surface.length) return { ok: false, reason: 'unpaved', longest: 0, need };
  return { ok: false, reason: 'short', longest: Math.max(...surface.map((s) => s.length)), need };
}

export function eligible(a: AirportOption, category: Category): boolean {
  return airportEligibility(a, category).ok;
}

// --- Defaults of the flight setup ----------------------------------------------------------

export interface TypeDefaults {
  /** Heights above the airport offered for a start in the air, metres. */
  airHeights: readonly number[];
  /** Indicated airspeed of a start in the air, m/s. */
  airSpeed: number;
  /** Distances out on final offered for an approach start, NM, and the default. */
  approachDistances: readonly number[];
  approachNm: number;
  /** Where the type is at home, in order of preference (the first that is offered wins). */
  home: readonly string[];
}

const FT = 0.3048;
const KT = 1852 / 3600;

export const TYPE_DEFAULTS: Readonly<Record<Category, TypeDefaults>> = {
  // A circuit height, a cross-country height, and above the Jura.
  piston: {
    airHeights: [304.8, 914.4, 1828.8],
    airSpeed: (100 * 1852) / 3600,
    approachDistances: [4, 6, 8, 10, 12],
    approachNm: 8,
    home: ['LSZB'],
  },
  // Pilatus flies its aircraft out of Buochs, next to the factory at Stans.
  turboprop: {
    airHeights: [2000 * FT, 5000 * FT, 10000 * FT],
    airSpeed: 200 * KT,
    approachDistances: [4, 6, 8, 10, 12],
    approachNm: 8,
    home: ['LSZC', 'LSZB'],
  },
  // 250 kt is the speed limit below FL 100; a jet is established on the ILS further out.
  airliner: {
    airHeights: [3000 * FT, 6000 * FT, 10000 * FT],
    airSpeed: 250 * KT,
    approachDistances: [6, 8, 10, 12, 15],
    approachNm: 10,
    home: ['LSZH', 'LSGG'],
  },
  fighter: {
    airHeights: [3000 * FT, 10000 * FT, 20000 * FT],
    airSpeed: 350 * KT,
    approachDistances: [4, 6, 8, 10, 12],
    approachNm: 6,
    home: ['LSMP', 'LSMM', 'LSME'],
  },
};

export function typeDefaults(info: AircraftInfo | undefined): TypeDefaults {
  return TYPE_DEFAULTS[categoryOf(info)];
}

/** The airport a type starts from by default: its home, else the first it may use. */
export function homeAirport(
  airports: readonly AirportOption[],
  category: Category,
): AirportOption | undefined {
  for (const icao of TYPE_DEFAULTS[category].home) {
    const a = airports.find((x) => x.icao === icao);
    if (a && eligible(a, category)) return a;
  }
  return airports.find((a) => eligible(a, category));
}

/** The offered value nearest to `v` (an approach distance kept across a change of type). */
export function nearest(options: readonly number[], v: number): number {
  let best = options[0] ?? v;
  for (const o of options) if (Math.abs(o - v) < Math.abs(best - v)) best = o;
  return best;
}

// --- Speeds of the handbook -----------------------------------------------------------------

/** Rotation speed: the type's own, else about 1.15 times the clean stall speed. */
export function rotateSpeed(info: AircraftInfo): number {
  return info.vRotate ?? info.vs * 1.15;
}

/** Approach speed: the type's own, else 1.3 times the landing stall speed (VREF). */
export function approachSpeed(info: AircraftInfo): number {
  return info.vApproach ?? info.vs0 * 1.3;
}

/**
 * The speed above which the aircraft is too fast right now: VNE (or VMO), or at height the
 * airspeed of the type's maximum Mach number, whichever is lower.
 */
export function overspeedLimit(info: AircraftInfo, ias: number, mach: number | undefined): number {
  const mmo = info.specs?.maxMach;
  if (!mmo || !mach || mach <= 0.05) return info.vne;
  return Math.min(info.vne, (ias * mmo) / mach);
}

/** Mach number shows next to the airspeed on fast types once it means something. */
export const MACH_SHOWN_FROM = 0.4;

export function showsMach(info: AircraftInfo | undefined): boolean {
  return !!info && (!!info.specs?.maxMach || engineKind(info) === 'jet');
}

// --- Keys -----------------------------------------------------------------------------------

/**
 * Keys of the phase 4 levers, as KeyboardEvent.code. The app binds them; the interface only
 * shows them. J and M sit above each other like F and V of the flaps (extend, retract); H is
 * held for reverse. Free of the app's keys and the panels' (see panels.ts), and none of them
 * is Y or Z, which swap places on a Swiss keyboard.
 */
export const FLEET_KEYS = {
  speedbrakeExtend: 'KeyJ',
  speedbrakeRetract: 'KeyM',
  reverse: 'KeyH',
  gear: 'KeyG',
} as const;

/** What a type has that needs keys of its own. */
export function typeFeatures(info: AircraftInfo | undefined): {
  gear: boolean;
  speedbrake: boolean;
  reverse: boolean;
} {
  return {
    gear: !!info?.retractableGear,
    speedbrake: !!info?.speedbrake,
    reverse: !!info?.reverse,
  };
}
