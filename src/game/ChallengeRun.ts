import { Vector3 } from 'three';
import { type Course, type Medal, medalFor, onRunway, submitTime } from './challenges';

export type ChallengeEvent =
  | { type: 'gate'; index: number }
  | { type: 'miss'; index: number }
  | { type: 'land' }
  | { type: 'finish'; time: number; medal: Medal | null; newBest: boolean };

export interface ChallengeResult {
  time: number;
  medal: Medal | null;
  newBest: boolean;
}

/**
 * Does the path prev → cur pass through the ring (centre, unit normal, radius)? Both
 * directions count; the crossing point of the ring plane must lie inside the radius.
 * Returns the distance from the centre at the crossing, or -1 when the plane is not crossed.
 */
export function ringCrossing(prev: Vector3, cur: Vector3, centre: Vector3, normal: Vector3) {
  const s0 = tmpA.subVectors(prev, centre).dot(normal);
  const s1 = tmpB.subVectors(cur, centre).dot(normal);
  if (s0 === s1 || (s0 > 0 && s1 > 0) || (s0 < 0 && s1 < 0)) return -1;
  const t = s0 / (s0 - s1);
  tmpA.subVectors(cur, prev).multiplyScalar(t).add(prev);
  return tmpA.distanceTo(centre);
}
const tmpA = new Vector3();
const tmpB = new Vector3();

/** Ring normals: the average of the incoming and outgoing direction (render positions). */
export function ringNormals(start: Vector3, gates: Vector3[]): Vector3[] {
  return gates.map((g, i) => {
    const prev = i === 0 ? start : gates[i - 1]!;
    const n = new Vector3().subVectors(g, prev).normalize();
    const next = gates[i + 1];
    if (next) n.add(new Vector3().subVectors(next, g).normalize()).normalize();
    return n;
  });
}

type ToRender = (lon: number, lat: number, h: number) => Vector3;

/**
 * One attempt at a course: ring positions in render coordinates (kept in step with the
 * floating origin), the next ring, the clock and the result.
 */
export class ChallengeRun {
  readonly start: Vector3;
  readonly gates: Vector3[];
  readonly normals: Vector3[];
  /** Runway touchdown target for landing courses (render coordinates). */
  readonly landingTarget?: Vector3;
  /** Index of the next ring; equals gates.length once all are passed. */
  next = 0;
  time = 0;
  result?: ChallengeResult;

  constructor(
    readonly course: Course,
    toRender: ToRender,
    private readonly saveBest = true,
  ) {
    const s = course.start;
    this.start = toRender(s.lon, s.lat, s.alt);
    this.gates = course.gates.map((g) => toRender(g.lon, g.lat, g.alt));
    this.normals = ringNormals(this.start, this.gates);
    const r = course.landing;
    if (r) {
      const lon = r.from.lon + (r.to.lon - r.from.lon) * 0.25;
      const lat = r.from.lat + (r.to.lat - r.from.lat) * 0.25;
      this.landingTarget = toRender(lon, lat, this.course.gates.at(-1)!.alt - 60);
    }
  }

  get finished(): boolean {
    return this.result !== undefined;
  }

  /** All rings passed, the landing is still to do. */
  get awaitingLanding(): boolean {
    return !this.finished && this.next >= this.gates.length && !!this.course.landing;
  }

  /** Where the HUD marker points: the next ring, or the runway. */
  get target(): Vector3 | undefined {
    if (this.finished) return undefined;
    return this.gates[this.next] ?? this.landingTarget;
  }

  rebase(delta: Vector3) {
    this.start.sub(delta);
    for (const g of this.gates) g.sub(delta);
    this.landingTarget?.sub(delta);
  }

  /** Clock and ring checks for one frame; `prev` → `cur` is the aircraft's path. */
  update(dt: number, prev: Vector3, cur: Vector3): ChallengeEvent[] {
    if (this.finished) return [];
    this.time += dt;
    const i = this.next;
    const centre = this.gates[i];
    if (!centre) return [];
    const d = ringCrossing(prev, cur, centre, this.normals[i]!);
    if (d < 0) return [];
    const r = this.course.radius;
    if (d > r) return d < r * 5 ? [{ type: 'miss', index: i }] : [];
    this.next++;
    const events: ChallengeEvent[] = [{ type: 'gate', index: i }];
    if (this.next >= this.gates.length) {
      events.push(this.course.landing ? { type: 'land' } : this.finish());
    }
    return events;
  }

  /** A touchdown without crash at lon/lat (landing courses finish here). */
  touchdown(lon: number, lat: number): ChallengeEvent[] {
    if (!this.awaitingLanding || !onRunway(this.course.landing!, lon, lat)) return [];
    return [this.finish()];
  }

  private finish(): ChallengeEvent {
    const time = this.time;
    const medal = medalFor(this.course, time);
    const newBest = this.saveBest ? submitTime(this.course.id, time) : false;
    this.result = { time, medal, newBest };
    return { type: 'finish', time, medal, newBest };
  }

  /** Respawn pose after a crash: the last ring passed (or the start), facing the next one. */
  respawnPose(): { position: Vector3; forward: Vector3 } {
    const at = this.next > 0 ? this.gates[this.next - 1]! : this.start;
    const toward = this.target ?? at.clone().add(this.normals[this.gates.length - 1]!);
    const forward = new Vector3().subVectors(toward, at).normalize();
    return { position: at.clone(), forward };
  }
}
