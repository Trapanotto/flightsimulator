import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AIRPORT_FREQUENCIES,
  AIRSPACES,
  DECLINATION_RATE,
  DECLINATION_REFERENCE,
  FIS_STATIONS,
  NAV_ATTRIBUTION,
  NAV_FIXES,
  NAV_STATIONS,
  airspacesAt,
  bearingDeg,
  distanceM,
  findAirport,
  findRunwayEnd,
  findStation,
  fisAt,
  fixesOf,
  frequenciesOf,
  ilsFor,
  magneticDeclination,
  navDatabase,
  planFlight,
  stationsNear,
  stationsOnFrequency,
  thresholdOf,
} from '../src/geo';
import type { NavDatabase, NavStation, Waypoint } from '../src/sim';

/** Published offset approaches: the localizer does not run along the runway. */
const OFFSET = new Set(['LSGS 25']);

const angleDiff = (a: number, b: number) => {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(d, 360 - d);
};
/** Along-track and cross-track metres of p from a on bearing brg (flat, fine at an airport). */
function alongCross(
  a: { lon: number; lat: number },
  brg: number,
  p: { lon: number; lat: number },
): [number, number] {
  const d = distanceM(a, p);
  const rel = ((bearingDeg(a, p) - brg) * Math.PI) / 180;
  return [d * Math.cos(rel), d * Math.sin(rel)];
}

const localizers = NAV_STATIONS.filter((s) => s.type === 'ILS' || s.type === 'LOC');

describe('navigation data shape', () => {
  it('hands stations, databases and plans to the simulation unchanged', () => {
    const station: NavStation = NAV_STATIONS[0]!;
    const db: NavDatabase = navDatabase();
    const plan: Waypoint[] | undefined = planFlight('LSZB', 'LSZH');
    expect(station.ident.length).toBeGreaterThan(0);
    expect(db.onFrequency(114_850).map((s) => s.ident)).toContain('KLO');
    expect(plan?.length).toBeGreaterThan(2);
  });

  it('has the stations of the region in useful numbers and stays small', () => {
    const count = (t: string) => NAV_STATIONS.filter((s) => s.type === t).length;
    expect(count('VOR') + count('VOR-DME')).toBeGreaterThanOrEqual(20);
    expect(count('NDB')).toBeGreaterThanOrEqual(10);
    expect(count('ILS')).toBeGreaterThanOrEqual(13);
    for (const s of NAV_STATIONS) {
      expect(s.lon).toBeGreaterThan(4.5);
      expect(s.lon).toBeLessThan(12);
      expect(s.lat).toBeGreaterThan(44.8);
      expect(s.lat).toBeLessThan(48.8);
      expect(s.elevation).toBeGreaterThanOrEqual(0);
      expect(s.elevation).toBeLessThan(3500);
      expect(s.rangeNm).toBeGreaterThan(0);
    }
    expect(fs.statSync('src/geo/nav.generated.ts').size).toBeLessThan(200 * 1024);
    expect(NAV_ATTRIBUTION).toMatch(/OurAirports/);
    expect(NAV_ATTRIBUTION).toMatch(/OpenStreetMap/);
    expect(NAV_ATTRIBUTION).toMatch(/FOCA/);
  });

  it('has unique idents per type', () => {
    for (const type of ['VOR', 'VOR-DME', 'DME', 'NDB', 'ILS', 'LOC']) {
      const ids = NAV_STATIONS.filter((s) => s.type === type).map((s) => s.ident);
      expect(new Set(ids).size, type).toBe(ids.length);
    }
  });
});

describe('frequencies', () => {
  it('are on legal channels of their band', () => {
    for (const s of NAV_STATIONS) {
      const f = s.frequency;
      const tenth = Math.floor(f / 100) % 10;
      const label = `${s.ident} ${s.type} ${f}`;
      if (s.type === 'NDB') {
        expect(f, label).toBeGreaterThanOrEqual(190);
        expect(f, label).toBeLessThanOrEqual(1750);
        expect((f * 2) % 1, label).toBe(0);
      } else if (s.type === 'ILS' || s.type === 'LOC') {
        expect(f, label).toBeGreaterThanOrEqual(108_100);
        expect(f, label).toBeLessThanOrEqual(111_950);
        expect(f % 50, label).toBe(0);
        expect(tenth % 2, label).toBe(1);
      } else {
        expect(f, label).toBeGreaterThanOrEqual(108_000);
        expect(f, label).toBeLessThanOrEqual(117_950);
        expect(f % 50, label).toBe(0);
        // Below 112 MHz the odd tenths belong to the localizers.
        if (s.type !== 'DME' && f < 112_000) expect(tenth % 2, label).toBe(0);
      }
    }
  });

  it('never put two stations on one frequency within 200 km', () => {
    for (let i = 0; i < NAV_STATIONS.length; i++)
      for (let j = i + 1; j < NAV_STATIONS.length; j++) {
        const a = NAV_STATIONS[i]!;
        const b = NAV_STATIONS[j]!;
        if (a.frequency !== b.frequency || distanceM(a, b) > 200_000) continue;
        // Opposite localizers of one runway: only one is switched on at a time.
        const oneRunway =
          a.type === 'ILS' && b.type === 'ILS' && a.airport === b.airport && a.runway !== b.runway;
        expect(oneRunway, `${a.ident} and ${b.ident} on ${a.frequency}`).toBe(true);
      }
  });

  it('keeps airport radio on the airband channel raster', () => {
    const all = [...AIRPORT_FREQUENCIES, ...FIS_STATIONS];
    expect(AIRPORT_FREQUENCIES.length).toBeGreaterThan(50);
    for (const f of all) {
      expect(f.frequency, f.name).toBeGreaterThanOrEqual(118_000);
      expect(f.frequency, f.name).toBeLessThanOrEqual(136_990);
      // 25 kHz channels and the 8.33 kHz channel names (.x05, .x10, .x15 after each 25 kHz step).
      expect([0, 5, 10, 15], `${f.name} ${f.frequency}`).toContain(f.frequency % 25);
    }
    for (const f of AIRPORT_FREQUENCIES) expect(findAirport(f.airport), f.airport).toBeDefined();
  });
});

describe('instrument landing systems', () => {
  it('serve the Swiss instrument runways', () => {
    for (const [icao, rwy] of [
      ['LSZH', '14'],
      ['LSZH', '16'],
      ['LSZH', '28'],
      ['LSZH', '34'],
      ['LSGG', '04'],
      ['LSGG', '22'],
      ['LFSB', '15'],
      ['LFSB', '33'],
      ['LSZB', '14'],
      ['LSZA', '01'],
      ['LSZR', '10'],
      ['LSGS', '25'],
    ] as const)
      expect(ilsFor(icao, rwy), `${icao} ${rwy}`).toBeDefined();
  });

  it('line up with the runways as drawn, offsets excepted', () => {
    for (const loc of localizers) {
      const airport = findAirport(loc.airport!)!;
      const found = findRunwayEnd(airport, loc.runway!)!;
      const runway = bearingDeg(found.end, found.opposite);
      const label = `${loc.airport} ${loc.runway}`;
      if (OFFSET.has(label)) expect(angleDiff(loc.course!, runway), label).toBeGreaterThan(2);
      else expect(angleDiff(loc.course!, runway), label).toBeLessThan(0.3);
    }
  });

  it('have the localizer beyond the far end and the glide slope beside the touchdown zone', () => {
    for (const loc of localizers) {
      const airport = findAirport(loc.airport!)!;
      const found = findRunwayEnd(airport, loc.runway!)!;
      const runway = bearingDeg(found.end, found.opposite);
      const label = `${loc.airport} ${loc.runway}`;
      const [along, cross] = alongCross(found.end, runway, loc);
      expect(along, label).toBeGreaterThan(found.runway.length);
      expect(along, label).toBeLessThan(found.runway.length + 1500);
      expect(Math.abs(cross), label).toBeLessThan(OFFSET.has(label) ? 300 : 60);
      if (loc.type !== 'ILS') continue;
      const gs = loc.glideSlope!;
      const [gAlong, gCross] = alongCross(thresholdOf(found.end, found.opposite), runway, gs);
      expect(gAlong, label).toBeGreaterThan(100);
      expect(gAlong, label).toBeLessThan(600);
      expect(Math.abs(gCross), label).toBeGreaterThan(60);
      expect(Math.abs(gCross), label).toBeLessThan(250);
      expect(gs.angleDeg, label).toBeGreaterThanOrEqual(2.5);
      expect(gs.angleDeg, label).toBeLessThanOrEqual(7);
    }
  });
});

describe('well-known facts', () => {
  it('match the published frequencies', () => {
    const vor: Array<[string, number]> = [
      ['ZUE', 110_050],
      ['KLO', 114_850],
      ['WIL', 116_900],
      ['FRI', 110_850],
      ['GVA', 115_750],
      ['SPR', 113_900],
      ['HOC', 113_200],
    ];
    for (const [ident, f] of vor) {
      expect(findStation(ident, 'VOR-DME')?.frequency, ident).toBe(f);
    }
    // Trasadingen: the VOR antenna is gone, the DME remains on its channel (OurAirports, OSM).
    expect(findStation('TRA', 'DME')?.frequency).toBe(114_300);
    const ils: Array<[string, string, string, number]> = [
      ['LSZH', '14', 'IKL', 108_300],
      ['LSZH', '16', 'IZH', 110_500],
      ['LSZH', '28', 'IZW', 109_750],
      ['LSZH', '34', 'IZS', 110_750],
      ['LSZB', '14', 'IBE', 110_100],
      ['LSGG', '04', 'INE', 110_900],
      ['LSGG', '22', 'ISW', 108_700],
      ['LFSB', '15', 'MH', 111_550],
      ['LFSB', '33', 'BLU', 109_350],
    ];
    for (const [icao, rwy, ident, f] of ils) {
      const s = ilsFor(icao, rwy);
      expect(s?.ident, `${icao} ${rwy}`).toBe(ident);
      expect(s?.frequency, `${icao} ${rwy}`).toBe(f);
    }
    expect(stationsOnFrequency(108_300).map((s) => s.ident)).toEqual(['IKL']);
  });

  it('name the radio stations as pilots call them', () => {
    const bern = frequenciesOf('LSZB');
    expect(bern).toContainEqual({
      airport: 'LSZB',
      type: 'tower',
      name: 'Bern Tower',
      frequency: 119_700,
    });
    expect(frequenciesOf('LSZH').find((f) => f.type === 'tower')?.name).toBe('Zurich Tower');
    expect(frequenciesOf('EDNY').map((f) => f.name)).toContain('Zurich Arrival');
    expect(fisAt(6.14, 46.2)).toEqual({ name: 'Geneva Information', frequency: 126_350 });
    expect(fisAt(8.55, 47.45)).toEqual({ name: 'Zurich Information', frequency: 124_700 });
    expect(fisAt(7.36, 46.23).name).toBe('Geneva Information'); // Sion
    expect(fisAt(9.88, 46.53).name).toBe('Zurich Information'); // Samedan
  });
});

describe('fixes and airspace', () => {
  it('give every controlled airport its reporting points inside reach', () => {
    for (const icao of ['LSZH', 'LSGG', 'LSZB', 'LSZG', 'LSZA', 'LSGS', 'LSZR']) {
      const vfr = fixesOf(icao).filter((f) => f.kind === 'vfr');
      expect(vfr.length, icao).toBeGreaterThanOrEqual(3);
      const ap = findAirport(icao)!;
      for (const f of vfr) expect(distanceM(ap, f), `${icao} ${f.ident}`).toBeLessThan(40_000);
    }
    expect(fixesOf('LSZB').map((f) => f.name)).toEqual(
      expect.arrayContaining(['Whiskey', 'Echo', 'Sierra']),
    );
    const idents = NAV_FIXES.map((f) => `${f.airport} ${f.ident}`);
    expect(new Set(idents).size).toBe(idents.length);
  });

  it('puts the final approach fixes 6 NM out on the localizer course', () => {
    const faf = fixesOf('LSZH').find((f) => f.ident === 'FF14')!;
    const ap = findAirport('LSZH')!;
    const found = findRunwayEnd(ap, '14')!;
    const thr = thresholdOf(found.end, found.opposite);
    expect(distanceM(faf, thr)).toBeCloseTo(6 * 1852, -1);
    expect(angleDiff(bearingDeg(faf, thr), ilsFor('LSZH', '14')!.course!)).toBeLessThan(0.1);
  });

  it('has simplified zones with sane limits', () => {
    expect(AIRSPACES.filter((a) => a.type === 'CTR').length).toBeGreaterThanOrEqual(12);
    for (const a of AIRSPACES) {
      const n = a.ring.length / 2;
      expect(n, a.name).toBeGreaterThanOrEqual(3);
      expect(n, a.name).toBeLessThanOrEqual(28);
      expect(['C', 'D', 'G']).toContain(a.class);
      if (a.lower.ref === a.upper.ref) expect(a.upper.value, a.name).toBeGreaterThan(a.lower.value);
    }
  });

  it('knows which zone an aircraft is in', () => {
    const zh = findAirport('LSZH')!;
    const low = airspacesAt(zh.lon, zh.lat, 600);
    expect(low[0]?.type).toBe('CTR');
    expect(low[0]?.airport).toBe('LSZH');
    expect(low[0]?.class).toBe('D');
    const high = airspacesAt(zh.lon, zh.lat, 2500);
    expect(high.some((a) => a.type === 'TMA' && a.airport === 'LSZH' && a.class === 'C')).toBe(
      true,
    );
    expect(airspacesAt(zh.lon, zh.lat, 12_000)).toEqual([]);
    const bern = findAirport('LSZB')!;
    expect(airspacesAt(bern.lon, bern.lat, 700)[0]?.designator).toBe('LSZB');
    // The Bernese Oberland north of the Jungfrau: no CTR down low.
    expect(airspacesAt(7.9, 46.62, 1500).some((a) => a.type === 'CTR')).toBe(false);
  });
});

describe('queries', () => {
  it('finds the nearest stations', () => {
    const zh = findAirport('LSZH')!;
    const near = stationsNear(zh.lon, zh.lat, 50_000, ['VOR', 'VOR-DME']);
    expect(near[0]?.station.ident).toBe('KLO');
    for (let i = 1; i < near.length; i++)
      expect(near[i]!.distance).toBeGreaterThanOrEqual(near[i - 1]!.distance);
  });

  it('plans a flight to the final approach fix and the threshold', () => {
    const plan = planFlight('LSGG', 'LSZH')!;
    expect(plan[0]?.ident).toBe('LSGG');
    const last = plan.at(-1)!;
    const faf = plan.at(-2)!;
    expect(last.ident).toMatch(/^RW(14|16|28|34)$/);
    const rwy = last.ident.slice(2);
    expect(faf.ident).toBe(`FF${rwy}`);
    expect(distanceM(faf, last)).toBeCloseTo(6 * 1852, -1);
    // Geneva to Zürich passes some VOR on the way.
    expect(plan.length).toBeGreaterThanOrEqual(5);
    for (const p of plan.slice(1, -2)) expect(findStation(p.ident)).toBeDefined();
    expect(faf.altitude! - last.altitude!).toBeGreaterThan(500);
    // A named runway is honoured; an unknown one is refused.
    expect(planFlight('LSZB', 'LSZH', { runway: '34' })!.at(-1)?.ident).toBe('RW34');
    expect(planFlight('LSZB', 'LSZH', { runway: '99' })).toBeUndefined();
    expect(planFlight('LSZB', 'XXXX')).toBeUndefined();
  });
});

describe('magnetic declination', () => {
  it('reproduces the fitted World Magnetic Model values to half a degree', () => {
    for (const [name, lon, lat, d] of DECLINATION_REFERENCE) {
      expect(Math.abs(magneticDeclination(lon, lat, 2025) - d), name).toBeLessThan(0.2);
      const d2030 = d + 5 * DECLINATION_RATE;
      expect(Math.abs(magneticDeclination(lon, lat, 2030) - d2030), name).toBeLessThan(0.5);
    }
  });

  it('is about 3 degrees east over Switzerland and grows eastward', () => {
    expect(magneticDeclination(8.54, 47.38, 2025)).toBeCloseTo(3.3, 0);
    expect(magneticDeclination(10, 46.8)).toBeGreaterThan(magneticDeclination(6, 46.8));
    expect(magneticDeclination(8, 46.8, 2030)).toBeGreaterThan(magneticDeclination(8, 46.8, 2025));
  });
});
