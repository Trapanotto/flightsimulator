import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { ChallengeRun, ringCrossing, ringNormals } from '../src/game/ChallengeRun';
import {
  type BestStore,
  COURSES,
  type Course,
  courseLength,
  formatTime,
  loadBestTimes,
  medalFor,
  onRunway,
  submitTime,
} from '../src/game/challenges';

/** Flat local frame for tests: x = east, y = up, z = south (metres). */
const toLocal = (lon: number, lat: number, h: number) =>
  new Vector3((lon - 8) * 76_000, h, -(lat - 46.5) * 111_200);

class MemoryStore implements BestStore {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

describe('courses', () => {
  it('has five courses with unique ids', () => {
    expect(COURSES).toHaveLength(5);
    expect(new Set(COURSES.map((c) => c.id)).size).toBe(5);
  });

  it('stays in Switzerland, with sane rings and ordered medal times', () => {
    for (const c of COURSES) {
      expect(c.gates.length, c.id).toBeGreaterThanOrEqual(6);
      expect(c.radius).toBeGreaterThanOrEqual(40);
      for (const g of [c.start, ...c.gates]) {
        expect(g.lon).toBeGreaterThan(5.9);
        expect(g.lon).toBeLessThan(10.5);
        expect(g.lat).toBeGreaterThan(45.8);
        expect(g.lat).toBeLessThan(47.85);
        expect(g.alt).toBeGreaterThan(450);
        expect(g.alt).toBeLessThan(4500);
      }
      expect(c.medals.gold).toBeLessThan(c.medals.silver);
      expect(c.medals.silver).toBeLessThan(c.medals.bronze);
    }
  });

  it('gold is reachable but not trivial (TR-1 tops out around 140 m/s, boost aside)', () => {
    for (const c of COURSES) {
      const len = courseLength(c);
      expect(len / c.medals.gold, c.id).toBeLessThan(140);
      expect(len / c.medals.bronze, c.id).toBeGreaterThan(40);
    }
  });

  it('rings are 0.7–6 km apart', () => {
    for (const c of COURSES) {
      const pts = [c.start, ...c.gates].map((g) => toLocal(g.lon, g.lat, g.alt));
      for (let i = 1; i < pts.length; i++) {
        const d = pts[i]!.distanceTo(pts[i - 1]!);
        expect(d, `${c.id} #${i}`).toBeGreaterThan(700);
        expect(d, `${c.id} #${i}`).toBeLessThan(6000);
      }
    }
  });
});

describe('ring geometry', () => {
  const centre = new Vector3(0, 100, 0);
  const normal = new Vector3(0, 0, 1);

  it('detects a pass through the middle in both directions', () => {
    expect(ringCrossing(new Vector3(0, 100, -5), new Vector3(0, 100, 5), centre, normal)).toBe(0);
    expect(ringCrossing(new Vector3(3, 104, 5), new Vector3(3, 104, -5), centre, normal)).toBe(5);
  });

  it('reports the miss distance and ignores paths that do not reach the plane', () => {
    expect(ringCrossing(new Vector3(80, 100, -5), new Vector3(80, 100, 5), centre, normal)).toBe(
      80,
    );
    expect(ringCrossing(new Vector3(0, 100, -9), new Vector3(0, 100, -1), centre, normal)).toBe(-1);
  });

  it('normals bisect the turn at a ring', () => {
    const [n] = ringNormals(new Vector3(0, 0, 0), [
      new Vector3(100, 0, 0),
      new Vector3(100, 0, 100),
    ]);
    expect(n!.x).toBeCloseTo(Math.SQRT1_2);
    expect(n!.z).toBeCloseTo(Math.SQRT1_2);
  });
});

describe('scoring', () => {
  const c = COURSES[0]!;

  it('medals by time', () => {
    expect(medalFor(c, c.medals.gold)).toBe('gold');
    expect(medalFor(c, c.medals.gold + 1)).toBe('silver');
    expect(medalFor(c, c.medals.bronze)).toBe('bronze');
    expect(medalFor(c, c.medals.bronze + 0.1)).toBeNull();
  });

  it('formats times', () => {
    expect(formatTime(0)).toBe('0:00.0');
    expect(formatTime(83.44)).toBe('1:23.4');
    expect(formatTime(605)).toBe('10:05.0');
  });

  it('keeps only better times', () => {
    const s = new MemoryStore();
    expect(submitTime('x', 120, s)).toBe(true);
    expect(submitTime('x', 130, s)).toBe(false);
    expect(submitTime('x', 99.94, s)).toBe(true);
    expect(loadBestTimes(s)).toEqual({ x: 99.9 });
  });

  it('survives broken storage content', () => {
    const s = new MemoryStore();
    s.setItem('tfs.best', '{oops');
    expect(loadBestTimes(s)).toEqual({});
    s.setItem('tfs.best', JSON.stringify({ a: 'fast', b: -3, c: 50 }));
    expect(loadBestTimes(s)).toEqual({ c: 50 });
  });
});

describe('Samedan runway 03', () => {
  const r = COURSES.find((c) => c.id === 'samedan')!.landing!;

  it('heads north-east (03)', () => {
    expect(r.ident).toBe('03');
    expect(r.to.lat).toBeGreaterThan(r.from.lat);
  });

  it('counts the paved strip, not the field beside it', () => {
    const mid = { lon: (r.from.lon + r.to.lon) / 2, lat: (r.from.lat + r.to.lat) / 2 };
    expect(onRunway(r, mid.lon, mid.lat)).toBe(true);
    expect(onRunway(r, mid.lon + 0.004, mid.lat)).toBe(false); // ~300 m east
  });
});

/** Flies straight from point to point in 10 m steps, like the game does per frame. */
function fly(run: ChallengeRun, path: Vector3[], dt = 0.1) {
  const events = [];
  const pos = path[0]!.clone();
  for (let i = 1; i < path.length; i++) {
    const to = path[i]!;
    while (pos.distanceTo(to) > 0.01) {
      const prev = pos.clone();
      const step = Math.min(10, pos.distanceTo(to));
      pos.add(to.clone().sub(pos).normalize().multiplyScalar(step));
      events.push(...run.update(dt, prev, pos));
    }
  }
  return events;
}

describe('ChallengeRun', () => {
  const course: Course = {
    id: 'test',
    name: { de: 'T', en: 'T' },
    description: { de: '', en: '' },
    start: { lon: 8, lat: 46.5, alt: 1000 },
    gates: [
      { lon: 8, lat: 46.51, alt: 1000 },
      { lon: 8.01, lat: 46.52, alt: 1000 },
      { lon: 8.01, lat: 46.53, alt: 1000 },
    ],
    radius: 50,
    medals: { gold: 50, silver: 60, bronze: 70 },
  };

  it('counts rings in order and finishes with a time and medal', () => {
    const run = new ChallengeRun(course, toLocal, false);
    const events = fly(run, [run.start, ...run.gates.map((g) => g.clone())]);
    expect(events.filter((e) => e.type === 'gate').map((e) => 'index' in e && e.index)).toEqual([
      0, 1, 2,
    ]);
    const finish = events.at(-1)!;
    expect(finish.type).toBe('finish');
    expect(run.finished).toBe(true);
    expect(run.result!.time).toBeGreaterThan(0);
    expect(run.target).toBeUndefined();
  });

  it('a ring skipped is not counted; the next ring only counts after it', () => {
    const run = new ChallengeRun(course, toLocal, false);
    const wide = run.gates[0]!.clone().add(new Vector3(120, 0, 0));
    const events = fly(run, [run.start, wide, run.gates[1]!.clone()]);
    expect(events.some((e) => e.type === 'miss')).toBe(true);
    expect(run.next).toBe(0);
  });

  it('landing courses finish on touchdown on the runway, not before', () => {
    const samedan = COURSES.find((c) => c.id === 'samedan')!;
    const run = new ChallengeRun(samedan, toLocal, false);
    const r = samedan.landing!;
    expect(run.touchdown(r.from.lon, r.from.lat)).toEqual([]); // rings first
    const events = fly(run, [run.start, ...run.gates.map((g) => g.clone())]);
    expect(events.at(-1)!.type).toBe('land');
    expect(run.awaitingLanding).toBe(true);
    expect(run.touchdown(r.from.lon + 0.01, r.from.lat)).toEqual([]); // beside the runway
    const mid = { lon: (r.from.lon + r.to.lon) / 2, lat: (r.from.lat + r.to.lat) / 2 };
    expect(run.touchdown(mid.lon, mid.lat)[0]!.type).toBe('finish');
  });

  it('follows the floating origin', () => {
    const run = new ChallengeRun(course, toLocal, false);
    const before = run.gates[0]!.clone();
    run.rebase(new Vector3(1000, 0, 500));
    expect(run.gates[0]!.x).toBeCloseTo(before.x - 1000);
    const pose = run.respawnPose();
    expect(pose.position.distanceTo(run.start)).toBe(0);
    expect(pose.forward.length()).toBeCloseTo(1);
  });
});
