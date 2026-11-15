/**
 * Choosing the starting airport: search, order and grouping of the flight setup's list. Pure
 * functions (tested in Node) plus the remembered recent airports.
 */
import { AIRPORTS as GEO_AIRPORTS } from '@geo';
import type { AirportOption } from './api';
import { type Category, eligible, runwayData } from './fleet';
import { type StorageLike, readJson, writeJson } from './persist';

/**
 * Other names a field is looked for by: the town in the other languages, the old name, the
 * region. The data's own name is searched anyway.
 */
const ALIASES: Readonly<Record<string, string>> = {
  LSGG: 'Genf Geneva Geneve Cointrin',
  LSZH: 'Zurich Zuerich Kloten',
  LFSB: 'Basel Bale Basle EuroAirport',
  LSZB: 'Bern Berne Belp',
  LSGS: 'Sitten',
  LSZA: 'Agno',
  LSZS: 'Engadin St. Moritz',
  LSZR: 'St. Gallen Altenrhein',
  LSGL: 'Lausanne',
  LSGC: 'La Chaux-de-Fonds',
  LSGN: 'Neuenburg',
  LSZO: 'Luzern Lucerne',
  LSME: 'Luzern Lucerne',
  LSZP: 'Biel Bienne',
  LSPH: 'Winterthur Hegmatten',
  LSZL: 'Magadino',
  LSMD: 'Zurich',
  LSZC: 'Nidwalden',
  LSGY: 'Yverdon',
  EDNY: 'Bodensee',
  EDTZ: 'Bodensee',
};

/** Lower case, accents off: 'Genève' and 'geneve' are the same word. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** German umlauts also as their two-letter spelling, so 'zuerich' finds 'Zürich'. */
function expandUmlauts(s: string): string {
  return s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue');
}

function words(a: AirportOption): string[] {
  const text = `${a.name} ${ALIASES[a.icao] ?? ''}`;
  return [
    ...new Set([...fold(text).split(/[^a-z0-9]+/), ...expandUmlauts(text).split(/[^a-z0-9]+/)]),
  ].filter(Boolean);
}

/**
 * How well an airport matches a search, lower is better; null when it does not. Every word of
 * the query must match: the ICAO code exactly (0) or by its start (1), a word of the name or
 * an alias by its start (2), or anywhere inside the name (3).
 */
export function airportMatch(a: AirportOption, query: string): number | null {
  const terms = fold(query)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (!terms.length) return 0;
  const icao = a.icao.toLowerCase();
  const ws = words(a);
  const whole = ws.join(' ');
  let worst = 0;
  for (const q of terms) {
    const score =
      icao === q
        ? 0
        : icao.startsWith(q)
          ? 1
          : ws.some((w) => w.startsWith(q))
            ? 2
            : whole.includes(q)
              ? 3
              : null;
    if (score === null) return null;
    worst = Math.max(worst, score);
  }
  return worst;
}

/** What the list says about an airport besides its name. */
export interface AirportFacts {
  swiss: boolean;
  /** An airport with scheduled or regional traffic (the geo data's 'major' and 'regional'). */
  large: boolean;
  military: boolean;
  /** Metres; 0 when unknown. */
  longest: number;
  paved: boolean;
}

export function airportFacts(a: AirportOption): AirportFacts {
  const g = GEO_AIRPORTS.find((x) => x.icao === a.icao);
  const data = runwayData(a);
  const strips = data?.strips ?? [];
  const best = [...strips].sort(
    (x, y) => Number(y.paved) - Number(x.paved) || y.length - x.length,
  )[0];
  const swiss = g ? g.country === 'CH' || g.country === 'LI' : a.icao.startsWith('LS');
  return {
    swiss,
    large: g ? g.kind !== 'airfield' : (best?.paved ?? false) && (best?.length ?? 0) >= 1500,
    military: a.military ?? g?.military ?? false,
    longest: best?.length ?? 0,
    paved: best?.paved ?? false,
  };
}

export type SectionKey = 'recent' | 'large' | 'other' | 'hits' | 'off';

export interface AirportSection {
  key: SectionKey;
  airports: AirportOption[];
}

/**
 * The list of the setup in sections: without a search, recently used fields, the large
 * airports (longest paved runway first) and the rest by name, Swiss fields before foreign ones
 * in each; with a search, the hits by how well they match. Fields the type cannot use come
 * last in either case, in their own section.
 */
export function orderAirports(
  airports: readonly AirportOption[],
  category: Category,
  recent: readonly string[],
  query = '',
): AirportSection[] {
  const facts = new Map(airports.map((a) => [a.icao, airportFacts(a)]));
  const f = (a: AirportOption) => facts.get(a.icao)!;
  const byName = (x: AirportOption, y: AirportOption) =>
    Number(f(y).swiss) - Number(f(x).swiss) || fold(x.name).localeCompare(fold(y.name));
  const bySize = (x: AirportOption, y: AirportOption) =>
    Number(f(y).swiss) - Number(f(x).swiss) || f(y).longest - f(x).longest || byName(x, y);

  const q = query.trim();
  if (q) {
    const scored = airports
      .map((a) => ({ a, s: airportMatch(a, q) }))
      .filter((x): x is { a: AirportOption; s: number } => x.s !== null)
      .sort((x, y) => x.s - y.s || Number(f(y.a).large) - Number(f(x.a).large) || bySize(x.a, y.a))
      .map((x) => x.a);
    return sections([
      { key: 'hits', airports: scored.filter((a) => eligible(a, category)) },
      { key: 'off', airports: scored.filter((a) => !eligible(a, category)) },
    ]);
  }

  const usable = airports.filter((a) => eligible(a, category));
  const recentSet = recent.filter((icao) => usable.some((a) => a.icao === icao));
  const rest = usable.filter((a) => !recentSet.includes(a.icao));
  return sections([
    {
      key: 'recent',
      airports: recentSet.map((icao) => usable.find((a) => a.icao === icao)!),
    },
    { key: 'large', airports: rest.filter((a) => f(a).large).sort(bySize) },
    { key: 'other', airports: rest.filter((a) => !f(a).large).sort(byName) },
    { key: 'off', airports: airports.filter((a) => !eligible(a, category)).sort(byName) },
  ]);
}

function sections(list: AirportSection[]): AirportSection[] {
  return list.filter((s) => s.airports.length > 0);
}

/** Airports worth a label on the whole map: the large ones. */
export function isMainAirport(a: AirportOption): boolean {
  return airportFacts(a).large;
}

// --- Recently used -----------------------------------------------------------------------------

export const RECENT_KEY = 'tfs.recentAirports';
export const RECENT_MAX = 5;

export function readRecent(storage: StorageLike | undefined): string[] {
  const v = readJson(storage, RECENT_KEY);
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX)
    : [];
}

/** Puts an airport at the front of the recent ones (once), keeping the last few. */
export function pushRecent(recent: readonly string[], icao: string): string[] {
  return [icao, ...recent.filter((x) => x !== icao)].slice(0, RECENT_MAX);
}

export function rememberAirport(storage: StorageLike | undefined, icao: string) {
  writeJson(storage, RECENT_KEY, pushRecent(readRecent(storage), icao));
}

/** Which label the map keeps where two would overlap: Swiss fields, then the longest runway. */
export function labelPriority(a: AirportOption): number {
  const f = airportFacts(a);
  return (f.swiss ? 100_000 : 0) + f.longest;
}
