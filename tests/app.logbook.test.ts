/**
 * The logbook: what a flight leaves behind (track, distance, landings) and how the stored
 * flights survive a damaged or full storage.
 */
import { describe, expect, it } from 'vitest';
import {
  FlightLogger,
  GeoRunwayFinder,
  type LogEntry,
  Logbook,
  type RunwayFinder,
  type StorageLike,
  TrackRecorder,
  groundDistance,
  worthKeeping,
} from '../src/app/logbook';
import { bearingDeg, findAirport, findRunwayEnd, offsetPoint, thresholdOf } from '../src/geo';
import type { Telemetry } from '../src/sim';

const DT = 1 / 60;

interface Frame {
  lon: number;
  lat: number;
  vs?: number;
  ias?: number;
  onGround?: boolean;
  load?: number;
  heading?: number;
}

/** Feeds `seconds` of frames from `at(t)` (t from 0) into the logger. */
function fly(logger: FlightLogger, seconds: number, at: (t: number) => Frame) {
  for (let t = 0; t < seconds - 1e-9; t += DT) {
    const f = at(t);
    const telemetry = {
      altitude: 600,
      verticalSpeed: f.vs ?? 0,
      ias: f.ias ?? 30,
      groundSpeed: f.ias ?? 30,
      trackDeg: f.heading ?? 0,
      headingDeg: f.heading ?? 0,
      onGround: f.onGround ?? false,
      loadFactor: f.load ?? 1,
      crashed: undefined,
    } as unknown as Telemetry;
    logger.sample(DT, telemetry, { lon: f.lon, lat: f.lat });
  }
}

const noRunways: RunwayFinder = { runwayAt: () => undefined, airportAt: () => undefined };
const logger = (runways: RunwayFinder = noRunways) =>
  new FlightLogger({ aircraft: 'c172', date: new Date('2026-06-21T10:00:00Z'), runways });

// Bern-Belp runway 14 from the geo data: its threshold is displaced by 200 m.
const lszb = findAirport('LSZB')!;
const rwy14 = findRunwayEnd(lszb, '14')!;
const heading14 = bearingDeg(rwy14.end, rwy14.opposite);
const threshold14 = thresholdOf(rwy14.end, rwy14.opposite);
/** A point `along` metres past the threshold of 14, `right` metres right of the centre line. */
const on14 = (along: number, right = 0) =>
  offsetPoint(offsetPoint(threshold14, heading14, along), heading14 + 90, right);

describe('track', () => {
  it('thins a long flight to at most 400 points and keeps its corners', () => {
    // A 40 km square at 60 m/s, one sample per frame: 40 000 raw positions.
    const track = new TrackRecorder();
    const corners = [{ lon: 7.4, lat: 46.9 }];
    for (const b of [0, 90, 180]) corners.push(offsetPoint(corners.at(-1)!, b, 10_000));
    for (let leg = 0; leg < 4; leg++) {
      const start = corners[leg]!;
      for (let d = 0; d < 10_000; d += 1) {
        const p = offsetPoint(start, leg * 90, d);
        track.add(p.lon, p.lat, 1000);
      }
    }
    const points = track.points(400);
    expect(points.length).toBeLessThanOrEqual(400);
    expect(points.length).toBeGreaterThan(100);
    for (const c of corners) {
      const nearest = Math.min(...points.map((p) => groundDistance(p, [c.lon, c.lat])));
      expect(nearest).toBeLessThan(30);
    }
  });

  it('measures the distance over the ground: one degree of a meridian is 111.195 km', () => {
    const log = logger();
    // 1° of latitude at 60 m/s.
    const seconds = 111_195 / 60;
    fly(log, seconds, (t) => ({ lon: 7.5, lat: 46.5 + (t / seconds) * 1 }));
    const entry = log.finish('ended');
    expect(entry.distance).toBeGreaterThan(111_195 * 0.999);
    expect(entry.distance).toBeLessThan(111_195 * 1.001);
    expect(entry.airTime).toBeCloseTo(entry.duration, 0);
    expect(entry.track.length).toBeLessThanOrEqual(400);
  });
});

/** An approach to Bern 14 touching down `touch` metres past the threshold, `right` of the line. */
function approach(log: FlightLogger, touch: number, right: number) {
  const speed = 33;
  // 30 s of final at 3 m/s down, then 1.5 s of flare at 1.2 m/s.
  fly(log, 31.5, (t) => ({
    ...on14(touch - speed * (31.5 - t), right),
    vs: t < 30 ? -3 : -1.2,
    ias: speed,
    heading: heading14,
  }));
}

/** On the ground along 14 from `from` metres past the threshold, slowing down. */
function rollout(log: FlightLogger, from: number, seconds: number, right = 0) {
  fly(log, seconds, (t) => ({
    ...on14(from + 30 * t - t * t, right),
    // The gear has taken most of the sink rate in the contact frame already.
    vs: t < DT ? -0.2 : 0,
    ias: 30 - 2 * t,
    onGround: true,
    load: t < 0.3 ? 1.6 : 1,
    heading: heading14,
  }));
}

describe('landings', () => {
  it('finds Bern 14 and measures the touchdown before the gear damps it', () => {
    const log = logger(new GeoRunwayFinder());
    approach(log, 350, 4);
    rollout(log, 350, 8, 4);
    const entry = log.finish('landed');
    expect(entry.landings).toHaveLength(1);
    const landing = entry.landings[0]!;
    expect(landing.airport).toBe('LSZB');
    expect(landing.runway).toBe('14');
    expect(landing.sinkRate).toBeCloseTo(1.2, 2);
    expect(landing.speed).toBeCloseTo(33, 0);
    expect(landing.load).toBeCloseTo(1.6, 2);
    expect(landing.centreline!).toBeCloseTo(4, 0);
    expect(landing.pastThreshold!).toBeGreaterThan(345);
    expect(landing.pastThreshold!).toBeLessThan(355);
    expect(entry.to).toBe('LSZB');
    expect(entry.from).toBeUndefined();
  });

  it('measures left of the centre line as negative, also landing the other way', () => {
    const finder = new GeoRunwayFinder();
    const hit14 = finder.runwayAt(on14(500, -10).lon, on14(500, -10).lat, heading14)!;
    expect(hit14.runway).toBe('14');
    expect(hit14.centreline).toBeCloseTo(-10, 0);
    // The same spot seen landing on 32: right of its centre line, and far past its threshold.
    const hit32 = finder.runwayAt(on14(500, -10).lon, on14(500, -10).lat, heading14 + 180)!;
    expect(hit32.runway).toBe('32');
    expect(hit32.centreline).toBeCloseTo(10, 0);
    expect(hit32.pastThreshold).toBeCloseTo(lszb.runways[0]!.length - 200 - 500, -1);
    // 100 m beside the pavement is not on the runway.
    expect(finder.runwayAt(on14(500, -100).lon, on14(500, -100).lat, heading14)).toBeUndefined();
  });

  it('counts a bounce as one landing with the worse sink rate', () => {
    const log = logger(new GeoRunwayFinder());
    approach(log, 300, 0);
    rollout(log, 300, 0.2);
    // Back in the air for two seconds, then down harder.
    fly(log, 2, (t) => ({ ...on14(306 + 30 * t), vs: t < 1 ? 1 : -2, heading: heading14 }));
    rollout(log, 366, 5);
    const entry = log.finish('landed');
    expect(entry.landings).toHaveLength(1);
    expect(entry.landings[0]!.sinkRate).toBeCloseTo(2, 2);
    expect(entry.landings[0]!.pastThreshold!).toBeLessThan(310);
  });

  it('gives a touch-and-go two landings and knows where it took off', () => {
    const log = logger(new GeoRunwayFinder());
    // Take-off roll on 14, then a 60 s circuit-like leg in the air.
    fly(log, 20, (t) => ({ ...on14(100 + t * t), onGround: true, heading: heading14 }));
    fly(log, 60, (t) => ({ ...on14(500 + 30 * t), vs: 3, heading: heading14 }));
    approach(log, 300, 0);
    rollout(log, 300, 10);
    fly(log, 30, (t) => ({ ...on14(600 + 30 * t), vs: 3, heading: heading14 }));
    approach(log, 400, -2);
    rollout(log, 400, 10, -2);
    const entry = log.finish('landed');
    expect(entry.from).toBe('LSZB');
    expect(entry.landings).toHaveLength(2);
    expect(entry.landings[1]!.centreline!).toBeCloseTo(-2, 0);
    expect(entry.landings[1]!.time).toBeGreaterThan(entry.landings[0]!.time + 30);
  });
});

function memoryStorage(limit = Infinity): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      if (v.length > limit) throw new DOMException('full', 'QuotaExceededError');
      data.set(k, v);
    },
  };
}

function entry(n: number, track = 0): LogEntry {
  return {
    id: `f${n}`,
    date: new Date(Date.UTC(2026, 0, 1) + n * 3_600_000).toISOString(),
    aircraft: 'c172',
    duration: 600,
    airTime: 500,
    distance: 20_000,
    maxAltitude: 1500,
    landings: [{ time: 590, sinkRate: 1, speed: 30 }],
    outcome: 'landed',
    track: Array.from(
      { length: track },
      (_, i) => [7 + i * 1e-3, 46, 1000] as [number, number, number],
    ),
  };
}

describe('logbook storage', () => {
  it('survives corrupt data and drops only the bad entries', () => {
    const storage = memoryStorage();
    storage.setItem('tfs.logbook', '{not json');
    expect(new Logbook().load(storage)).toEqual([]);
    storage.setItem(
      'tfs.logbook',
      JSON.stringify({
        version: 1,
        entries: [
          entry(1),
          { id: 'x', aircraft: 'b747' },
          42,
          { ...entry(2), track: [[1, 2], 'z'] },
        ],
      }),
    );
    const book = new Logbook();
    const loaded = book.load(storage);
    expect(loaded.map((e) => e.id)).toEqual(['f2', 'f1']);
    expect(loaded[0]!.track).toEqual([]);
    // Written back newest first under the versioned format.
    book.add(entry(3));
    const stored = JSON.parse(storage.data.get('tfs.logbook')!);
    expect(stored.version).toBe(1);
    expect(stored.entries.map((e: LogEntry) => e.id)).toEqual(['f3', 'f2', 'f1']);
    expect(book.remove('f2').map((e) => e.id)).toEqual(['f3', 'f1']);
    expect(book.clear()).toEqual([]);
  });

  it('keeps the newest flights up to the cap', () => {
    const book = new Logbook(5);
    book.load(memoryStorage());
    for (let n = 0; n < 8; n++) book.add(entry(n));
    expect(book.entries.map((e) => e.id)).toEqual(['f7', 'f6', 'f5', 'f4', 'f3']);
  });

  it('on a full storage drops the tracks of the oldest flights first', () => {
    // Room for all five flights but not for all five tracks.
    const full = JSON.stringify({ version: 1, entries: [0, 1, 2, 3, 4].map((n) => entry(n, 100)) });
    const storage = memoryStorage(full.length * 0.8);
    const book = new Logbook();
    book.load(storage);
    for (let n = 0; n < 5; n++) book.add(entry(n, 100));
    const stored = JSON.parse(storage.data.get('tfs.logbook')!).entries as LogEntry[];
    expect(stored).toHaveLength(5);
    expect(stored[0]!.track).toHaveLength(100);
    expect(stored.at(-1)!.track).toHaveLength(0);
  });

  it('keeps only real flights', () => {
    expect(worthKeeping(entry(1))).toBe(true);
    expect(worthKeeping({ ...entry(1), duration: 12 })).toBe(false);
    expect(worthKeeping({ ...entry(1), distance: 3, airTime: 0 })).toBe(false);
  });
});
