/**
 * The loop the aircraft of the menu flies: through the Bernese Oberland, up the Lauterbrunnen
 * valley, over Kleine Scheidegg past the Eiger north face to Grindelwald and back down the
 * Lütschine. The route was checked against the swisstopo elevation model: at least 120 m above
 * the terrain.
 *
 * The waypoints are joined by a spline, resampled every few metres and smoothed, so the
 * curvature (and with it the bank angle) changes gently instead of jumping at each waypoint.
 */

/** lon, lat (degrees), altitude (metres above sea level). */
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
const LON0 = 7.96;
const LAT0 = 46.61;
/** Metres per degree of longitude and latitude around the loop. */
const MX = Math.cos((LAT0 * Math.PI) / 180) * 111_320;
const MY = 110_540;

/** Sample spacing, m. */
const STEP = 4;
/** Box filter width (m), run three times (about a Gaussian with sigma ~ 0.5 x width). */
const SMOOTH = 360;
/** Box filter width for the altitude, m. */
const CLIMB = 1600;
/** Window for the turn rate, m. */
const CURVE = 120;

/** Local metres east, north, and altitude. */
type P = [number, number, number];

const lerp = (a: P, b: P, t: number): P => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const dist = (a: P, b: P) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

/** Closed Catmull-Rom spline through the waypoints. */
function spline(): P[] {
  const pts = ROUTE.map(([lon, lat, h]): P => [(lon - LON0) * MX, (lat - LAT0) * MY, h]);
  const n = pts.length;
  const out: P[] = [];
  for (let i = 0; i < n; i++) {
    const p = [pts[(i - 1 + n) % n]!, pts[i]!, pts[(i + 1) % n]!, pts[(i + 2) % n]!];
    for (let s = 0; s < 400; s++) {
      const t = s / 400;
      const t2 = t * t;
      const t3 = t2 * t;
      const w = [
        -0.5 * t3 + t2 - 0.5 * t,
        1.5 * t3 - 2.5 * t2 + 1,
        -1.5 * t3 + 2 * t2 + 0.5 * t,
        0.5 * t3 - 0.5 * t2,
      ];
      const q: P = [0, 0, 0];
      for (let j = 0; j < 4; j++) for (let c = 0; c < 3; c++) q[c]! += p[j]![c]! * w[j]!;
      out.push(q);
    }
  }
  return out;
}

/** Points every STEP metres along a closed polyline. */
function resample(pts: P[]): P[] {
  const n = pts.length;
  const cum = [0];
  for (let i = 0; i < n; i++) cum.push(cum[i]! + dist(pts[i]!, pts[(i + 1) % n]!));
  const total = cum[n]!;
  const count = Math.round(total / STEP);
  const step = total / count;
  const out: P[] = [];
  let seg = 0;
  for (let j = 0; j < count; j++) {
    const d = j * step;
    while (cum[seg + 1]! < d) seg++;
    const len = cum[seg + 1]! - cum[seg]!;
    out.push(lerp(pts[seg]!, pts[(seg + 1) % n]!, len > 0 ? (d - cum[seg]!) / len : 0));
  }
  return out;
}

/** Circular moving average over `w` samples. */
function boxFilter(pts: P[], w: number): P[] {
  const n = pts.length;
  const half = Math.floor(w / 2);
  const count = 2 * half + 1;
  const sum: P = [0, 0, 0];
  for (let i = -half; i <= half; i++) for (let c = 0; c < 3; c++) sum[c]! += pts[(i + n) % n]![c]!;
  const out: P[] = [];
  for (let i = 0; i < n; i++) {
    out.push([sum[0] / count, sum[1] / count, sum[2] / count]);
    const leave = pts[(i - half + n) % n]!;
    const enter = pts[(i + half + 1) % n]!;
    for (let c = 0; c < 3; c++) sum[c]! += enter[c]! - leave[c]!;
  }
  return out;
}

function build() {
  let p = resample(spline());
  for (let i = 0; i < 3; i++) p = boxFilter(p, Math.round(SMOOTH / STEP));
  // Climbs and descents spread over longer stretches than the turns.
  let z = p.map((v): P => [v[2], 0, 0]);
  for (let i = 0; i < 3; i++) z = boxFilter(z, Math.round(CLIMB / STEP));
  p.forEach((v, i) => (v[2] = z[i]![0]));
  p = resample(p);
  const n = p.length;
  const h = Math.round(CURVE / STEP / 2);
  let k: P[] = [];
  for (let i = 0; i < n; i++) {
    const a = p[(i - h + n) % n]!;
    const b = p[i]!;
    const c = p[(i + h) % n]!;
    const d = Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]);
    k.push([Math.atan2(Math.sin(d), Math.cos(d)) / (h * STEP), 0, 0]);
  }
  // Smooth the curvature too: the roll rate then changes gently as well.
  for (let i = 0; i < 3; i++) k = boxFilter(k, Math.round(CURVE / STEP));
  return { p, k: k.map((v) => v[0]), length: n * STEP };
}

const PATH = build();

/** Length of the loop, m. */
export const PATH_LENGTH = PATH.length;

export interface PathPoint {
  lon: number;
  lat: number;
  /** Metres above sea level. */
  altitude: number;
}

/** Where the loop is at distance s along it (wraps around). */
export function pointAt(s: number, out: PathPoint = { lon: 0, lat: 0, altitude: 0 }): PathPoint {
  const n = PATH.p.length;
  const x = (((s / STEP) % n) + n) % n;
  const i = Math.floor(x);
  const q = lerp(PATH.p[i]!, PATH.p[(i + 1) % n]!, x - i);
  out.lon = LON0 + q[0] / MX;
  out.lat = LAT0 + q[1] / MY;
  out.altitude = q[2];
  return out;
}

/** Signed horizontal curvature at distance s, 1/m (positive = left turn). */
export function curvatureAt(s: number): number {
  const n = PATH.k.length;
  const x = (((s / STEP) % n) + n) % n;
  const i = Math.floor(x);
  const f = x - i;
  return PATH.k[i]! * (1 - f) + PATH.k[(i + 1) % n]! * f;
}

/** Bank angle (rad, positive = left wing down) of a coordinated turn at speed v (m/s). */
export function bankAt(s: number, v: number): number {
  const b = Math.atan((v * v * curvatureAt(s)) / 9.81);
  // Soft limit near 50 degrees (a hard clamp would jerk the roll).
  return 0.9 * Math.tanh(b / 0.9);
}

/** True heading in degrees at distance s. */
export function headingAt(s: number): number {
  const a = pointAt(s - 20);
  const b = pointAt(s + 20);
  const deg = (Math.atan2((b.lon - a.lon) * MX, (b.lat - a.lat) * MY) * 180) / Math.PI;
  return (deg + 360) % 360;
}
