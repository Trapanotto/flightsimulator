import { Vector3 } from 'three';

/**
 * The showcase loop through the Bernese Oberland (up the Lauterbrunnen valley, over Kleine
 * Scheidegg past the Eiger north face to Grindelwald and back down the Lütschine). The route
 * was checked against the swisstopo elevation model: at least 120 m above the terrain.
 *
 * The waypoints are joined by a spline, resampled every few metres and smoothed, so the
 * curvature (and with it the bank angle) changes gently instead of jumping at each waypoint.
 */

/** lon, lat, altitude (m above sea level) */
export const ROUTE: ReadonlyArray<readonly [number, number, number]> = [
  [7.903, 46.628, 1500],
  [7.905, 46.6, 1900],
  [7.93, 46.565, 2300],
  [7.965, 46.585, 2450],
  [8.0, 46.598, 2300],
  [8.04, 46.622, 1950],
  [7.99, 46.632, 1600],
  [7.94, 46.64, 1450],
];
export const LON0 = 7.96;
export const LAT0 = 46.61;
/** Metres per degree of longitude / latitude around the loop. */
export const MX = Math.cos((LAT0 * Math.PI) / 180) * 111_320;
export const MY = 110_540;

/** Sample spacing, m. */
const STEP = 4;
/** Box filter width (m), run three times (about a Gaussian with sigma ~ 0.5 x width). */
const SMOOTH = 360;
/** Box filter width for the altitude, m. */
const CLIMB = 1600;
/** Window for the turn rate, m. */
const CURVE = 120;

interface Path {
  /** Local metres east, north, altitude; one sample every STEP metres. */
  p: Vector3[];
  /** Signed horizontal curvature, 1/m (positive = turning left). */
  k: number[];
  length: number;
}

/** Closed Catmull-Rom spline through the waypoints. */
function spline(): Vector3[] {
  const pts = ROUTE.map(([lon, lat, h]) => new Vector3((lon - LON0) * MX, (lat - LAT0) * MY, h));
  const n = pts.length;
  const out: Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]!;
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % n]!;
    const p3 = pts[(i + 2) % n]!;
    for (let s = 0; s < 400; s++) {
      const t = s / 400;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push(
        new Vector3()
          .addScaledVector(p0, -0.5 * t3 + t2 - 0.5 * t)
          .addScaledVector(p1, 1.5 * t3 - 2.5 * t2 + 1)
          .addScaledVector(p2, -1.5 * t3 + 2 * t2 + 0.5 * t)
          .addScaledVector(p3, 0.5 * t3 - 0.5 * t2),
      );
    }
  }
  return out;
}

/** Points every STEP metres along a closed polyline. */
function resample(pts: Vector3[]): Vector3[] {
  const n = pts.length;
  const cum = [0];
  for (let i = 0; i < n; i++) cum.push(cum[i]! + pts[i]!.distanceTo(pts[(i + 1) % n]!));
  const total = cum[n]!;
  const count = Math.round(total / STEP);
  const step = total / count;
  const out: Vector3[] = [];
  let seg = 0;
  for (let j = 0; j < count; j++) {
    const d = j * step;
    while (cum[seg + 1]! < d) seg++;
    const a = pts[seg]!;
    const b = pts[(seg + 1) % n]!;
    const len = cum[seg + 1]! - cum[seg]!;
    out.push(a.clone().lerp(b, len > 0 ? (d - cum[seg]!) / len : 0));
  }
  return out;
}

/** Circular moving average over `w` samples. */
function boxFilter(pts: Vector3[], w: number): Vector3[] {
  const n = pts.length;
  const half = Math.floor(w / 2);
  const sum = new Vector3();
  for (let i = -half; i <= half; i++) sum.add(pts[(i + n) % n]!);
  const out: Vector3[] = [];
  const count = 2 * half + 1;
  for (let i = 0; i < n; i++) {
    out.push(sum.clone().divideScalar(count));
    sum.sub(pts[(i - half + n) % n]!).add(pts[(i + half + 1) % n]!);
  }
  return out;
}

function build(): Path {
  let p = resample(spline());
  const w = Math.round(SMOOTH / STEP);
  for (let i = 0; i < 3; i++) p = boxFilter(p, w);
  // Climbs and descents spread over longer stretches than the turns.
  let z = p.map((v) => new Vector3(v.z, 0, 0));
  for (let i = 0; i < 3; i++) z = boxFilter(z, Math.round(CLIMB / STEP));
  p.forEach((v, i) => (v.z = z[i]!.x));
  p = resample(p);
  const n = p.length;
  const h = Math.round(CURVE / STEP / 2);
  const k: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = p[(i - h + n) % n]!;
    const b = p[i]!;
    const c = p[(i + h) % n]!;
    const h1 = Math.atan2(b.y - a.y, b.x - a.x);
    const h2 = Math.atan2(c.y - b.y, c.x - b.x);
    let d = h2 - h1;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    k.push(d / (h * STEP));
  }
  // Smooth the curvature too: the roll rate then changes gently as well.
  const ks = boxFilter(
    k.map((x) => new Vector3(x, 0, 0)),
    Math.round(CURVE / STEP),
  );
  for (let i = 0; i < 2; i++) ks.splice(0, n, ...boxFilter(ks, Math.round(CURVE / STEP)));
  return { p, k: ks.map((v) => v.x), length: n * STEP };
}

const PATH = build();

/** Length of the loop, m. */
export const PATH_LENGTH = PATH.length;

/** Local position (east, north, altitude) at distance s along the loop (wraps around). */
export function pointAt(s: number, out: Vector3): Vector3 {
  const n = PATH.p.length;
  const x = (((s / STEP) % n) + n) % n;
  const i = Math.floor(x);
  return out.copy(PATH.p[i]!).lerp(PATH.p[(i + 1) % n]!, x - i);
}

/** Signed horizontal curvature at distance s, 1/m (positive = left turn). */
export function curvatureAt(s: number): number {
  const n = PATH.k.length;
  const x = (((s / STEP) % n) + n) % n;
  const i = Math.floor(x);
  const f = x - i;
  return PATH.k[i]! * (1 - f) + PATH.k[(i + 1) % n]! * f;
}

/** Bank angle (rad, positive = left wing down) of a coordinated turn at speed v. */
export function bankAt(s: number, v: number): number {
  const b = Math.atan((v * v * curvatureAt(s)) / 9.81);
  // Soft limit near 50 deg (a hard clamp would jerk the roll).
  return 0.9 * Math.tanh(b / 0.9);
}
