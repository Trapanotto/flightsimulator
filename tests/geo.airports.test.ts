import { describe, expect, it } from 'vitest';
import {
  AIRPORTS,
  airportsNear,
  bearingDeg,
  distanceM,
  findAirport,
  findRunwayEnd,
  isPaved,
  oppositeIdent,
  runwayStart,
  thresholdOf,
} from '../src/geo';
import { AIRPORTS as APP_AIRPORTS } from '../src/app/airports';

/** Magnetic variation in Switzerland, 2025 (east). */
const VARIATION = 3;
/**
 * Designators that are officially more than 10 degrees off the true bearing (the published
 * designator lags the drift of the magnetic pole; both sources agree on the geometry).
 */
const OFF_DESIGNATOR = new Set(['LSTA 10', 'LSTA 28']);

const angleDiff = (a: number, b: number) => {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(d, 360 - d);
};

describe('opposite designators', () => {
  it('turns the number by 180 degrees and swaps left and right', () => {
    expect(oppositeIdent('32')).toBe('14');
    expect(oppositeIdent('14')).toBe('32');
    expect(oppositeIdent('01')).toBe('19');
    expect(oppositeIdent('19')).toBe('01');
    expect(oppositeIdent('18')).toBe('36');
    expect(oppositeIdent('36')).toBe('18');
    expect(oppositeIdent('09')).toBe('27');
    expect(oppositeIdent('14L')).toBe('32R');
    expect(oppositeIdent('32R')).toBe('14L');
    expect(oppositeIdent('06C')).toBe('24C');
    expect(oppositeIdent('07G')).toBe('25G');
  });
});

describe('generated airport data', () => {
  it('has the Swiss airfields and the chosen border airports, each once', () => {
    const codes = AIRPORTS.map((a) => a.icao);
    expect(new Set(codes).size).toBe(codes.length);
    expect(AIRPORTS.length).toBeGreaterThanOrEqual(55);
    for (const c of ['LSZH', 'LSGG', 'LSZB', 'LSGS', 'LSZS', 'LSZA', 'LSZR', 'LSZG', 'LSMP'])
      expect(codes).toContain(c);
    for (const c of ['LFSB', 'EDNY']) expect(codes).toContain(c);
    for (const a of AIRPORTS) {
      expect(a.icao).toMatch(/^[A-Z]{4}$/);
      expect(a.name.length).toBeGreaterThan(1);
      // Swiss area with a margin for the border airports.
      expect(a.lon).toBeGreaterThan(5.7);
      expect(a.lon).toBeLessThan(10.7);
      expect(a.lat).toBeGreaterThan(45.7);
      expect(a.lat).toBeLessThan(47.95);
      expect(a.elevation).toBeGreaterThan(190);
      expect(a.elevation).toBeLessThan(2600);
      expect(a.runways.length).toBeGreaterThan(0);
    }
  });

  it('has both ends of every runway, where the length and width say', () => {
    for (const a of AIRPORTS)
      for (const r of a.runways) {
        const [e0, e1] = r.ends;
        expect(e0.ident, a.icao).not.toBe(e1.ident);
        expect(oppositeIdent(e0.ident), `${a.icao} ${e0.ident}`).toBe(e1.ident);
        const d = distanceM(e0, e1);
        expect(Math.abs(d - r.length), `${a.icao} ${e0.ident}`).toBeLessThan(2);
        // The runway lies at its airport.
        expect(distanceM(a, e0), a.icao).toBeLessThan(4000);
        expect(r.length, a.icao).toBeGreaterThan(150);
        expect(r.length, a.icao).toBeLessThan(4200);
        expect(r.width, a.icao).toBeGreaterThanOrEqual(10);
        expect(r.width, a.icao).toBeLessThanOrEqual(80);
        if (isPaved(r.surface)) expect(r.width, a.icao).toBeLessThanOrEqual(60);
        for (const e of r.ends) {
          expect(e.displaced ?? 0).toBeGreaterThanOrEqual(0);
          expect(e.displaced ?? 0, `${a.icao} ${e.ident}`).toBeLessThan(r.length / 2);
          if (e.elevation !== undefined)
            expect(Math.abs(e.elevation - a.elevation), `${a.icao} ${e.ident}`).toBeLessThan(60);
          if (e.als || e.papi) expect(r.lighted || e.papi !== undefined).toBe(true);
        }
      }
  });

  it('has every designator within about 10 degrees of the magnetic bearing', () => {
    for (const a of AIRPORTS)
      for (const r of a.runways)
        for (let i = 0; i < 2; i++) {
          const end = r.ends[i]!;
          const brg = bearingDeg(end, r.ends[1 - i]!);
          const number = Number(end.ident.slice(0, 2)) * 10;
          const off = angleDiff(number, brg - VARIATION);
          if (OFF_DESIGNATOR.has(`${a.icao} ${end.ident}`)) expect(off).toBeLessThan(15);
          else
            expect(off, `${a.icao} ${end.ident}: true ${brg.toFixed(1)}`).toBeLessThanOrEqual(10);
        }
  });

  it('has the airports of the game today, at the same places', () => {
    for (const old of APP_AIRPORTS) {
      const a = findAirport(old.icao);
      expect(a, old.icao).toBeDefined();
      expect(Math.abs(a!.elevation - old.elevation), old.icao).toBeLessThan(5);
      for (const r of old.runways)
        for (const e of r.ends) {
          const found = findRunwayEnd(a!, e.ident);
          expect(found, `${old.icao} ${e.ident}`).toBeDefined();
          // OSM's runway ends (traced from the orthophoto) replace OurAirports' where both
          // exist; they agree within a few dozen metres.
          expect(distanceM(found!.end, e), `${old.icao} ${e.ident}`).toBeLessThan(40);
          expect(Math.abs(found!.runway.width - r.width), old.icao).toBeLessThan(11);
        }
    }
  });

  it('knows the instrument runways and their lights', () => {
    const zurich = findAirport('LSZH')!;
    expect(zurich.runways).toHaveLength(3);
    const r14 = findRunwayEnd(zurich, '14')!;
    expect(r14.end.approach).toBe('ils');
    expect(r14.end.als).toBe('precision');
    expect(r14.runway.lighted).toBe(true);
    expect(r14.runway.width).toBe(60);
    const bern = findRunwayEnd(findAirport('LSZB')!, '14')!;
    expect(bern.end.approach).toBe('ils');
    expect(bern.end.papi).toBeDefined();
    // A grass airfield: no lights, no paint.
    const thun = findAirport('LSZW')!;
    expect(thun.runways[0]!.surface).toBe('grass');
    expect(thun.runways[0]!.lighted).toBe(false);
  });
});

describe('helpers', () => {
  it('finds airports near a point, nearest first', () => {
    const near = airportsNear(7.5, 46.91, 20_000);
    expect(near[0]!.airport.icao).toBe('LSZB');
    for (let i = 1; i < near.length; i++)
      expect(near[i]!.distance).toBeGreaterThanOrEqual(near[i - 1]!.distance);
    expect(airportsNear(8.3, 46.6, 1000)).toHaveLength(0);
    expect(findAirport('lszh')?.name).toBe('Zürich');
  });

  it('lines up on the centre line facing down the runway', () => {
    const bern = findAirport('LSZB')!;
    const s = runwayStart(bern, '32')!;
    const { end, opposite } = findRunwayEnd(bern, '32')!;
    expect(s.headingDeg).toBeCloseTo(bearingDeg(end, opposite), 6);
    expect(angleDiff(s.headingDeg, 320 + VARIATION)).toBeLessThan(8);
    expect(distanceM(s, end)).toBeCloseTo(40, 0);
    expect(runwayStart(bern, '99')).toBeUndefined();
  });

  it('puts a displaced threshold down the runway', () => {
    const zurich = findAirport('LSZH')!;
    const { end, opposite } = findRunwayEnd(zurich, '34')!;
    expect(end.displaced).toBeGreaterThan(300);
    const t = thresholdOf(end, opposite);
    expect(distanceM(t, end)).toBeCloseTo(end.displaced!, 0);
    expect(distanceM(t, opposite)).toBeCloseTo(distanceM(end, opposite) - end.displaced!, 0);
  });
});
