/** A track point: longitude, latitude (degrees), altitude (m). */
export type TrackPoint = [number, number, number];

const RAD = Math.PI / 180;
const EARTH_R = 6_371_000;
/** Climbing or descending this much on the spot (a spiral, a hover) is worth a point too. */
const ALTITUDE_STEP = 50;

/**
 * Records a ground track with bounded memory: a point every `spacing` metres; when the buffer
 * is full every second point goes and the spacing doubles, so a flight of any length fits.
 * `points(max)` then picks the points that keep the shape best (Douglas-Peucker, greedy).
 */
export class TrackRecorder {
  private readonly buffer: TrackPoint[] = [];
  private spacing: number;
  private lastSeen: TrackPoint | undefined;

  constructor(
    private readonly capacity = 1000,
    spacing = 25,
  ) {
    this.spacing = spacing;
  }

  add(lon: number, lat: number, altitude: number): void {
    const p: TrackPoint = [lon, lat, altitude];
    this.lastSeen = p;
    const last = this.buffer.at(-1);
    if (
      last &&
      groundDistance(last, p) < this.spacing &&
      Math.abs(altitude - last[2]) < ALTITUDE_STEP
    )
      return;
    this.buffer.push(p);
    if (this.buffer.length >= this.capacity) {
      // Keep the first and the newest point; the newest is the one the next spacing counts from.
      let j = 0;
      for (let i = 0; i < this.buffer.length; i += 2) this.buffer[j++] = this.buffer[i]!;
      if ((this.buffer.length - 1) % 2 === 1) this.buffer[j++] = this.buffer.at(-1)!;
      this.buffer.length = j;
      this.spacing *= 2;
    }
  }

  /** At most `max` points, first and last always among them. */
  points(max: number): TrackPoint[] {
    const all = this.buffer.slice();
    const end = this.lastSeen;
    if (end && all.at(-1) !== end) all.push(end);
    return simplify(all, max);
  }
}

/** Great-circle distance in metres (haversine, the geo package's sphere). */
export function groundDistance(
  a: readonly [number, number, ...number[]],
  b: readonly [number, number, ...number[]],
): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Greedy Douglas-Peucker: starting from the two ends, keep inserting the point farthest from
 * the line drawn so far until `max` points are kept. Unlike a fixed tolerance this always
 * hits the budget and spends it where the track bends.
 */
export function simplify(points: readonly TrackPoint[], max: number): TrackPoint[] {
  if (points.length <= max) return points.slice();
  if (max < 2) return points.slice(0, max);
  const first = points[0]!;
  const k = Math.cos(first[1] * RAD) * EARTH_R * RAD;
  // Local metres (east, north, up) so lon/lat and altitude weigh alike.
  const xyz = points.map((p) => [(p[0] - first[0]) * k, (p[1] - first[1]) * EARTH_R * RAD, p[2]]);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  // Per segment (by start index): its farthest inner point and that distance.
  const segments = new Map<number, { end: number; far: number; d: number }>();
  const measure = (s: number, e: number) => {
    let far = -1;
    let d = -1;
    for (let i = s + 1; i < e; i++) {
      const di = segmentDistance(xyz[i]!, xyz[s]!, xyz[e]!);
      if (di > d) {
        d = di;
        far = i;
      }
    }
    segments.set(s, { end: e, far, d });
  };
  measure(0, points.length - 1);
  for (let kept = 2; kept < max; kept++) {
    let best = -1;
    let bestD = -1;
    for (const [s, seg] of segments) {
      if (seg.far >= 0 && seg.d > bestD) {
        bestD = seg.d;
        best = s;
      }
    }
    if (best < 0) break;
    const seg = segments.get(best)!;
    keep[seg.far] = 1;
    measure(best, seg.far);
    measure(seg.far, seg.end);
  }
  return points.filter((_, i) => keep[i] === 1);
}

function segmentDistance(p: number[], a: number[], b: number[]): number {
  const abx = b[0]! - a[0]!;
  const aby = b[1]! - a[1]!;
  const abz = b[2]! - a[2]!;
  const apx = p[0]! - a[0]!;
  const apy = p[1]! - a[1]!;
  const apz = p[2]! - a[2]!;
  const ab2 = abx * abx + aby * aby + abz * abz;
  const t = ab2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / ab2)) : 0;
  return Math.hypot(apx - t * abx, apy - t * aby, apz - t * abz);
}
