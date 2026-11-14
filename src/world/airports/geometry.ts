/**
 * The ground surfaces of an airport as meshes draped on the terrain: runways (paved, with
 * their marking parameters per vertex), grass strips, taxiways and aprons. Built from the data
 * as plain arrays: each vertex keeps its lon/lat, and its height is filled in later from the
 * terrain (AirportLayer seats it, and re-seats it when finer terrain arrives).
 *
 * Positions are in the airport's own tangent frame (x east, y up, z south at the reference
 * point): float32 holds millimetres there, and the floating origin only moves the frame.
 */
import { type AirportInfo, LocalFrame, type RunwayInfo, isPaved } from '@geo';
import { ShapeUtils, Vector2 } from 'three/webgpu';
import { type RunwayMarkings, runwayMarkings } from './layout';
import type { AirportDetail } from './detail';

/** A mesh before it has heights: lon/lat per vertex, attributes, triangles. */
export interface Draped {
  lon: Float64Array;
  lat: Float64Array;
  attributes: Record<string, { size: number; array: Float32Array }>;
  index: Uint32Array;
}

/** Vertices to stand on the ground with something else (a light, a windsock) on top. */
class Builder {
  private readonly lon: number[] = [];
  private readonly lat: number[] = [];
  private readonly data: Record<string, number[]> = {};
  readonly index: number[] = [];
  private readonly p = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly frame: LocalFrame,
    private readonly sizes: Record<string, number>,
  ) {
    for (const k of Object.keys(sizes)) this.data[k] = [];
  }

  get count() {
    return this.lon.length;
  }

  /** A vertex at local x/z (metres), with its attribute values. */
  vertex(x: number, z: number, values: Record<string, ArrayLike<number>>): number {
    this.p.x = x;
    this.p.y = 0;
    this.p.z = z;
    const g = this.frame.toGeodetic(this.p);
    this.lon.push(g.lon);
    this.lat.push(g.lat);
    for (const [k, size] of Object.entries(this.sizes)) {
      const v = values[k]!;
      const out = this.data[k]!;
      for (let i = 0; i < size; i++) out.push(v[i] ?? 0);
    }
    return this.lon.length - 1;
  }

  tri(a: number, b: number, c: number) {
    this.index.push(a, b, c);
  }

  /** A grid of rows x cols vertices made by `at(row, col)`, triangulated. */
  grid(rows: number, cols: number, at: (i: number, j: number) => number) {
    const ids: number[] = [];
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) ids.push(at(i, j));
    for (let i = 0; i + 1 < rows; i++)
      for (let j = 0; j + 1 < cols; j++) {
        const a = ids[i * cols + j]!;
        const b = ids[i * cols + j + 1]!;
        const c = ids[(i + 1) * cols + j]!;
        const d = ids[(i + 1) * cols + j + 1]!;
        // Rows run along, columns to the right: (a, b, c) faces up (+y) in a frame whose z
        // points south.
        this.tri(a, b, c);
        this.tri(b, d, c);
      }
  }

  finish(): Draped {
    const attributes: Draped['attributes'] = {};
    for (const [k, size] of Object.entries(this.sizes))
      attributes[k] = { size, array: Float32Array.from(this.data[k]!) };
    return {
      lon: Float64Array.from(this.lon),
      lat: Float64Array.from(this.lat),
      attributes,
      index: Uint32Array.from(this.index),
    };
  }
}

/** A runway in the airport frame: end A, unit direction towards B, unit right. */
export interface RunwayAxes {
  ax: number;
  az: number;
  dx: number;
  dz: number;
  rx: number;
  rz: number;
  length: number;
}

export function runwayAxes(frame: LocalFrame, r: RunwayInfo): RunwayAxes {
  const h = frame.origin.h;
  const a = frame.fromGeodetic(r.ends[0].lon, r.ends[0].lat, h, { x: 0, y: 0, z: 0 });
  const b = frame.fromGeodetic(r.ends[1].lon, r.ends[1].lat, h, { x: 0, y: 0, z: 0 });
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  const dx = (b.x - a.x) / length;
  const dz = (b.z - a.z) / length;
  // Right of the direction of travel, seen from above (x east, z south): (-dz, dx).
  return { ax: a.x, az: a.z, dx, dz, rx: -dz, rz: dx, length };
}

/** Local x/z of runway coordinates (s along from end A, t to the right). */
export function runwayPoint(axes: RunwayAxes, s: number, t: number): [number, number] {
  return [axes.ax + axes.dx * s + axes.rx * t, axes.az + axes.dz * s + axes.rz * t];
}

/** Settings of the draped meshes (per device class). */
export interface SurfaceOptions {
  /** Metres between rows along a runway or taxiway (finer follows the terrain closer). */
  step: number;
  /** Metres between columns across a runway. */
  across: number;
}

/** Metres of mesh outside the pavement edge, for the antialiased edge to fade out in. */
export const EDGE_MARGIN = 1.5;

/** Floats per vertex of the runway parameters (seven vec4 attributes rw0..rw6). */
export const RUNWAY_PARAMS = 28;

/** Runway marking parameters as the shader reads them (see surfaceMaterial.ts). */
export function packRunway(m: RunwayMarkings): Float32Array {
  const p = new Float32Array(RUNWAY_PARAMS);
  p.set([m.length, m.width, m.centreWidth, m.edgeWidth], 0);
  m.ends.forEach((e, i) => {
    const o = 4 + i * 12;
    // Touchdown zone bars as a bit mask of the pattern slots at 150, 300, ... m.
    let mask = 0;
    for (const bar of e.tdz) mask |= 1 << (Math.round(bar.at / 150) - 1);
    p.set([e.threshold, e.stripesPerSide, e.stripeUnit, mask], o);
    const aim = e.aim;
    p.set(aim ? [aim.start, aim.length, aim.width, aim.inner] : [0, 0, 0, 0], o + 4);
    p.set([e.glyphs[0], e.glyphs[1], e.glyphs[2], 0], o + 8);
  });
  return p;
}

/**
 * The paved runways of an airport, one grid per runway, least important first: where two
 * runways cross, the one drawn last (the longest) keeps its markings, as on the real thing.
 */
export function buildRunways(frame: LocalFrame, airport: AirportInfo, opt: SurfaceOptions): Draped {
  return runToEnd(runwaySteps(frame, airport, opt));
}

/**
 * A build that yields between pieces (a runway, a taxiway, an apron), so that the layer can
 * spread a big airport over several frames instead of stalling one.
 */
export type Steps<T> = Generator<void, T, void>;

/** Runs a stepped build to its end at once (tests, small airports). */
export function runToEnd<T>(steps: Steps<T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

export function* runwaySteps(
  frame: LocalFrame,
  airport: AirportInfo,
  opt: SurfaceOptions,
): Steps<Draped> {
  const sizes: Record<string, number> = { st: 2 };
  for (let i = 0; i < 7; i++) sizes[`rw${i}`] = 4;
  const b = new Builder(frame, sizes);
  const paved = airport.runways.filter((r) => isPaved(r.surface));
  paved.sort((p, q) => p.length - q.length);
  for (const r of paved) {
    const axes = runwayAxes(frame, r);
    const m = runwayMarkings(r, axes.length)!;
    const packed = packRunway(m);
    const values: Record<string, ArrayLike<number>> = { st: [0, 0] };
    for (let i = 0; i < 7; i++) values[`rw${i}`] = packed.subarray(i * 4, i * 4 + 4);
    const L = axes.length;
    const half = r.width / 2 + EDGE_MARGIN;
    const rows = Math.max(2, Math.ceil((L + 2 * EDGE_MARGIN) / opt.step) + 1);
    const cols = Math.max(3, Math.ceil((2 * half) / opt.across) + 1) | 1; // odd: a centre column
    const st = [0, 0];
    values.st = st;
    b.grid(rows, cols, (i, j) => {
      const s = -EDGE_MARGIN + (i / (rows - 1)) * (L + 2 * EDGE_MARGIN);
      const t = -half + (j / (cols - 1)) * 2 * half;
      st[0] = s;
      st[1] = t;
      const [x, z] = runwayPoint(axes, s, t);
      return b.vertex(x, z, values);
    });
    yield;
  }
  yield;
  return b.finish();
}

/** Kinds of the ground mesh (attribute `ground.x`). */
export const GROUND_APRON = 0;
export const GROUND_TAXIWAY = 1;
export const GROUND_GRASS = 2;
/** Holding position markings across a taxiway (pattern A). */
export const GROUND_HOLD = 3;

/**
 * Aprons, taxiways, holding positions and grass runways: one mesh, drawn in this order. The
 * taxiway centre lines are drawn by a second material over the same mesh (st.y = 0 on the line).
 */
export function buildGround(
  frame: LocalFrame,
  airport: AirportInfo,
  detail: AirportDetail | undefined,
  opt: SurfaceOptions,
): Draped {
  return runToEnd(groundSteps(frame, airport, detail, opt));
}

export function* groundSteps(
  frame: LocalFrame,
  airport: AirportInfo,
  detail: AirportDetail | undefined,
  opt: SurfaceOptions,
): Steps<Draped> {
  const b = new Builder(frame, { st: 2, ground: 3 });
  const p = { x: 0, y: 0, z: 0 };
  const local = (lon: number, lat: number): [number, number] => {
    frame.fromGeodetic(lon, lat, frame.origin.h, p);
    return [p.x, p.z];
  };

  for (const ring of detail?.aprons ?? []) {
    const contour: Vector2[] = [];
    for (let i = 0; i < ring.length; i += 2) {
      const [x, z] = local(ring[i]!, ring[i + 1]!);
      contour.push(new Vector2(x, z));
    }
    if (contour.length < 3) continue;
    const tris = ShapeUtils.triangulateShape(contour, []);
    const values = { st: [0, 0], ground: [GROUND_APRON, 1e4, 0] };
    for (const tri of tris) {
      const A = contour[tri[0]!]!;
      const B = contour[tri[1]!]!;
      const C = contour[tri[2]!]!;
      subdivideTriangle(b, A, B, C, opt.step * 1.5, values);
    }
    yield;
  }

  const lines: Array<{ pts: Array<[number, number]>; half: number }> = [];
  let lastYield = 0;
  for (const tw of detail?.taxiways ?? []) {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < tw.line.length; i += 2) {
      const q = local(tw.line[i]!, tw.line[i + 1]!);
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 0.2) pts.push(q);
    }
    if (pts.length < 2) continue;
    ribbon(b, pts, tw.width / 2, opt.step);
    if (b.count - lastYield > 3000) {
      lastYield = b.count;
      yield;
    }
    lines.push({ pts, half: tw.width / 2 });
  }

  const runways = airport.runways
    .filter((r) => isPaved(r.surface))
    .map((r) => runwayAxes(frame, r));
  for (const [lon, lat] of detail?.holds ?? []) {
    const h = placeHold(local(lon, lat), lines, runways);
    if (h) holdMarking(b, h, opt);
  }

  for (const r of airport.runways) {
    if (isPaved(r.surface)) continue;
    const axes = runwayAxes(frame, r);
    const L = axes.length;
    const half = r.width / 2 + EDGE_MARGIN;
    const rows = Math.max(2, Math.ceil((L + 2 * EDGE_MARGIN) / opt.step) + 1);
    const cols = Math.max(3, Math.ceil((2 * half) / opt.across) + 1);
    const values = { st: [0, 0], ground: [GROUND_GRASS, r.width / 2, L] };
    b.grid(rows, cols, (i, j) => {
      const s = -EDGE_MARGIN + (i / (rows - 1)) * (L + 2 * EDGE_MARGIN);
      const t = -half + (j / (cols - 1)) * 2 * half;
      values.st = [s, t];
      const [x, z] = runwayPoint(axes, s, t);
      return b.vertex(x, z, values);
    });
  }
  // The arrays are built in a frame of their own.
  yield;
  return b.finish();
}

/** Splits a triangle into n x n smaller ones so that it can follow the terrain. */
function subdivideTriangle(
  b: Builder,
  A: Vector2,
  B: Vector2,
  C: Vector2,
  maxEdge: number,
  values: Record<string, ArrayLike<number>>,
) {
  const longest = Math.max(A.distanceTo(B), B.distanceTo(C), C.distanceTo(A));
  const n = Math.max(1, Math.ceil(longest / maxEdge));
  const ids: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const row: number[] = [];
    for (let j = 0; j <= n - i; j++) {
      const u = i / n;
      const v = j / n;
      const x = A.x + (B.x - A.x) * u + (C.x - A.x) * v;
      const z = A.y + (B.y - A.y) * u + (C.y - A.y) * v;
      row.push(b.vertex(x, z, values));
    }
    ids.push(row);
  }
  // ShapeUtils keeps the contour's winding; make every triangle face up.
  const up = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x) < 0;
  const tri = (a: number, c: number, d: number) => (up ? b.tri(a, c, d) : b.tri(a, d, c));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n - i; j++) {
      tri(ids[i]![j]!, ids[i + 1]![j]!, ids[i]![j + 1]!);
      if (j + 1 < n - i) tri(ids[i]![j + 1]!, ids[i + 1]![j]!, ids[i + 1]![j + 1]!);
    }
}

/** Metres of taxiway mesh outside its edge (antialiasing room). */
const TAXI_MARGIN = 1;

/**
 * A taxiway along a polyline: a mitred ribbon (no gaps or overlaps in bends), subdivided along
 * its length to follow the terrain, with round caps at both ends. st = (metres along, metres
 * right of the centre line).
 */
function ribbon(b: Builder, pts: Array<[number, number]>, half: number, step: number) {
  const w = half + TAXI_MARGIN;
  const n = pts.length;
  const normals: Array<[number, number]> = [];
  for (let i = 0; i + 1 < n; i++) {
    const dx = pts[i + 1]![0] - pts[i]![0];
    const dz = pts[i + 1]![1] - pts[i]![1];
    const l = Math.hypot(dx, dz);
    normals.push([-dz / l, dx / l]);
  }
  // Mitre direction and length at each point (limited where the bend is sharp).
  const miter = pts.map((_, i) => {
    const a = normals[Math.max(0, i - 1)]!;
    const c = normals[Math.min(n - 2, i)]!;
    let mx = a[0] + c[0];
    let mz = a[1] + c[1];
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) return [c[0], c[1], 1] as const;
    mx /= ml;
    mz /= ml;
    const scale = 1 / Math.max(0.5, mx * c[0] + mz * c[1]);
    return [mx, mz, scale] as const;
  });
  const ground = [GROUND_TAXIWAY, half, 0];
  const st = [0, 0];
  const values = { st, ground };
  let along = 0;
  let prev: number[] | undefined;
  for (let i = 0; i + 1 < n; i++) {
    const p0 = pts[i]!;
    const p1 = pts[i + 1]!;
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const rows = Math.max(1, Math.ceil(len / step));
    const m0 = miter[i]!;
    const m1 = miter[i + 1]!;
    for (let k = prev ? 1 : 0; k <= rows; k++) {
      const f = k / rows;
      const cx = p0[0] + (p1[0] - p0[0]) * f;
      const cz = p0[1] + (p1[1] - p0[1]) * f;
      const mx = m0[0] + (m1[0] - m0[0]) * f;
      const mz = m0[1] + (m1[1] - m0[1]) * f;
      const ms = (m0[2] + (m1[2] - m0[2]) * f) * w;
      st[0] = along + len * f;
      const row: number[] = [];
      for (const side of [-1, 0, 1]) {
        st[1] = side * w;
        row.push(b.vertex(cx + mx * ms * side, cz + mz * ms * side, values));
      }
      if (prev) {
        b.tri(prev[0]!, prev[1]!, row[0]!);
        b.tri(prev[1]!, row[1]!, row[0]!);
        b.tri(prev[1]!, prev[2]!, row[1]!);
        b.tri(prev[2]!, row[2]!, row[1]!);
      }
      prev = row;
    }
    along += len;
  }
  // Round caps: a fan around each end, st.y = distance from the end point.
  for (const p of [pts[0]!, pts[n - 1]!]) {
    st[0] = 0;
    st[1] = 0;
    const c = b.vertex(p[0], p[1], values);
    const seg = 12;
    const rim: number[] = [];
    st[1] = w;
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      rim.push(b.vertex(p[0] + Math.cos(a) * w, p[1] + Math.sin(a) * w, values));
    }
    for (let k = 0; k < seg; k++) b.tri(c, rim[(k + 1) % seg]!, rim[k]!);
  }
}

/** Distance from a point to a runway's centre line segment. */
function runwayDistance(x: number, z: number, r: RunwayAxes): number {
  const px = x - r.ax;
  const pz = z - r.az;
  const s = Math.max(0, Math.min(r.length, px * r.dx + pz * r.dz));
  return Math.hypot(px - r.dx * s, pz - r.dz * s);
}

/**
 * A holding position on its taxiway: the nearest taxiway segment gives the direction, the
 * nearest runway which way is "towards the runway". Undefined if no taxiway passes there.
 */
export function placeHold(
  p: [number, number],
  lines: Array<{ pts: Array<[number, number]>; half: number }>,
  runways: RunwayAxes[],
): { x: number; z: number; dx: number; dz: number; half: number } | undefined {
  let best: { x: number; z: number; dx: number; dz: number; half: number } | undefined;
  let bestD = 4;
  for (const { pts, half } of lines)
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i]!;
      const [bx, bz] = pts[i + 1]!;
      const ex = bx - ax;
      const ez = bz - az;
      const l = Math.hypot(ex, ez);
      const f = Math.max(0, Math.min(1, ((p[0] - ax) * ex + (p[1] - az) * ez) / (l * l)));
      const d = Math.hypot(ax + ex * f - p[0], az + ez * f - p[1]);
      if (d < bestD) {
        bestD = d;
        best = { x: ax + ex * f, z: az + ez * f, dx: ex / l, dz: ez / l, half };
      }
    }
  if (!best || runways.length === 0) return best;
  const near = (x: number, z: number) => Math.min(...runways.map((r) => runwayDistance(x, z, r)));
  if (
    near(best.x + best.dx * 5, best.z + best.dz * 5) >
    near(best.x - best.dx * 5, best.z - best.dz * 5)
  ) {
    best.dx = -best.dx;
    best.dz = -best.dz;
  }
  return best;
}

/**
 * Holding position marking (pattern A: two solid and two dashed yellow lines across the
 * taxiway, the dashed ones on the runway side). st = (metres along the taxiway from the
 * first solid line towards the runway, metres across).
 */
function holdMarking(
  b: Builder,
  h: { x: number; z: number; dx: number; dz: number; half: number },
  opt: SurfaceOptions,
) {
  const values = { st: [0, 0], ground: [GROUND_HOLD, h.half, 0] };
  const w = h.half;
  const cols = Math.max(2, Math.ceil((2 * w) / opt.across) + 1);
  const depth = 1.4;
  b.grid(2, cols, (i, j) => {
    const a = -0.2 + i * depth;
    const t = -w + (j / (cols - 1)) * 2 * w;
    values.st = [a, t];
    return b.vertex(h.x + h.dx * a - h.dz * t, h.z + h.dz * a + h.dx * t, values);
  });
}
