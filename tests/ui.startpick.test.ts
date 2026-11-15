import { describe, expect, it } from 'vitest';
import { AIRPORTS, isPaved } from '../src/geo/airports';
import { airportMatch, orderAirports, pushRecent } from '../src/ui/airportPick';
import type { AirportOption } from '../src/ui/api';

/** Every airport as the app offers them, with its runways. */
const OPTIONS: AirportOption[] = AIRPORTS.map((a) => ({
  icao: a.icao,
  name: a.name,
  lon: a.lon,
  lat: a.lat,
  elevation: a.elevation,
  runways: a.runways.flatMap((r) => r.ends.map((e) => e.ident)),
  strips: a.runways.map((r) => ({
    ends: r.ends.map((e) => e.ident),
    length: r.length,
    paved: isPaved(r.surface),
  })),
  military: a.military,
}));
const apt = (icao: string) => OPTIONS.find((a) => a.icao === icao)!;
const hits = (q: string) =>
  orderAirports(OPTIONS, 'piston', [], q).flatMap((s) => s.airports.map((a) => a.icao));

describe('airport search', () => {
  it('finds fields by name, town or ICAO, without accents and in any language', () => {
    expect(hits('zuri')[0]).toBe('LSZH');
    expect(hits('zuerich')[0]).toBe('LSZH');
    expect(hits('LSZH')[0]).toBe('LSZH');
    for (const q of ['genf', 'geneve', 'Genève', 'geneva']) expect(hits(q)[0], q).toBe('LSGG');
    expect(hits('basel')).toContain('LFSB');
    expect(airportMatch(apt('LSZB'), 'xyz')).toBeNull();
    // An exact code beats a name that merely contains the letters.
    expect(airportMatch(apt('LSZB'), 'lszb')).toBeLessThan(airportMatch(apt('LSZB'), 'bel')!);
  });
});

describe('airport order', () => {
  it('puts recent fields first, then airports with Swiss ones first, the unusable last', () => {
    const sections = orderAirports(OPTIONS, 'airliner', ['LSZB', 'LSGG'], '');
    expect(sections.map((s) => s.key)).toEqual(['recent', 'large', 'other', 'off']);
    // Bern is too short for the A320: not among the recent ones, but at the end.
    expect(sections[0]!.airports.map((a) => a.icao)).toEqual(['LSGG']);
    const large = sections[1]!.airports.map((a) => a.icao);
    expect(large[0]).toBe('LSZH');
    expect(large.indexOf('LFSB')).toBeGreaterThan(large.indexOf('LSZH'));
    expect(sections[3]!.airports.map((a) => a.icao)).toContain('LSZA');
    expect(sections[3]!.airports.map((a) => a.icao)).toContain('LSZB');
  });

  it('keeps the last five recent fields, newest first, each once', () => {
    let r: string[] = [];
    for (const icao of ['A', 'B', 'C', 'B', 'D', 'E', 'F']) r = pushRecent(r, icao);
    expect(r).toEqual(['F', 'E', 'D', 'B', 'C']);
  });
});
