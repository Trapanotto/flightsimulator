import { QM_MAX } from './quantizedMesh';
import type { GeoBounds } from './tiles';
import { type Vec3Like, geodeticToEcef, upAt } from './wgs84';

/** Result of a surface query: the exact point on the triangle mesh below/above lon/lat. */
export interface SurfaceHit {
  /** Height above the ellipsoid, metres. */
  height: number;
  /** Unit normal of the triangle in ECEF, pointing away from the Earth. */
  normal: Vec3Like;
}

const EPS = 1e-7;

/**
 * The triangle surface of one terrain tile, for exact height queries.
 *
 * Queries hit the same flat triangles the GPU draws: the three corners are placed in ECEF and the
 * vertical line through lon/lat is intersected with their plane. Interpolating heights in
 * lon/lat instead would sit a few centimetres above the drawn triangle on large flat triangles
 * (the chord of the Earth's curvature), which wheels would show.
 *
 * Triangles are found through a uniform grid of buckets over the tile, so a query touches only
 * a handful of triangles however dense the tile is.
 */
export class TerrainSurface {
  private readonly cells: number;
  private readonly offsets: Uint32Array;
  private readonly items: Uint32Array;
  private readonly lonSpan: number;
  private readonly latSpan: number;
  private lastTri = -1;
  private readonly a = { x: 0, y: 0, z: 0 };
  private readonly b = { x: 0, y: 0, z: 0 };
  private readonly c = { x: 0, y: 0, z: 0 };
  private readonly p = { x: 0, y: 0, z: 0 };
  private readonly up = { x: 0, y: 0, z: 0 };

  constructor(
    readonly bounds: GeoBounds,
    /** Quantized positions, 0..32767 west->east and south->north. */
    private readonly u: Uint16Array,
    private readonly v: Uint16Array,
    /** Per vertex: height above the ellipsoid, metres. */
    private readonly heights: Float32Array,
    /** Triangles (no skirts). */
    private readonly indices: Uint16Array | Uint32Array,
  ) {
    this.lonSpan = bounds.east - bounds.west;
    this.latSpan = bounds.north - bounds.south;
    const triangles = indices.length / 3;
    // About two triangles per bucket on average.
    this.cells = Math.max(1, Math.min(128, Math.round(Math.sqrt(triangles / 2))));
    const n = this.cells;
    const scale = n / (QM_MAX + 1);
    const counts = new Uint32Array(n * n + 1);
    const forEachCell = (t: number, fn: (cell: number) => void) => {
      const i0 = indices[t * 3]!;
      const i1 = indices[t * 3 + 1]!;
      const i2 = indices[t * 3 + 2]!;
      const x0 = Math.floor(Math.min(u[i0]!, u[i1]!, u[i2]!) * scale);
      const x1 = Math.floor(Math.max(u[i0]!, u[i1]!, u[i2]!) * scale);
      const y0 = Math.floor(Math.min(v[i0]!, v[i1]!, v[i2]!) * scale);
      const y1 = Math.floor(Math.max(v[i0]!, v[i1]!, v[i2]!) * scale);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) fn(y * n + x);
    };
    for (let t = 0; t < triangles; t++) forEachCell(t, (c) => counts[c + 1]!++);
    for (let i = 1; i <= n * n; i++) counts[i]! += counts[i - 1]!;
    this.offsets = counts;
    this.items = new Uint32Array(counts[n * n]!);
    const fill = counts.slice(0, n * n);
    for (let t = 0; t < triangles; t++) forEachCell(t, (c) => (this.items[fill[c]!++] = t));
  }

  /** Bytes held by the index (for memory estimates). */
  get byteLength(): number {
    return this.offsets.byteLength + this.items.byteLength;
  }

  contains(lon: number, lat: number): boolean {
    const b = this.bounds;
    return lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;
  }

  /** The surface at lon/lat (degrees), or undefined outside the tile. */
  query(lon: number, lat: number, out?: SurfaceHit): SurfaceHit | undefined {
    if (!this.contains(lon, lat)) return undefined;
    const qu = ((lon - this.bounds.west) / this.lonSpan) * QM_MAX;
    const qv = ((lat - this.bounds.south) / this.latSpan) * QM_MAX;
    let tri = -1;
    if (this.lastTri >= 0 && this.inside(this.lastTri, qu, qv)) tri = this.lastTri;
    else {
      const n = this.cells;
      const cx = Math.min(n - 1, Math.floor((qu * n) / (QM_MAX + 1)));
      const cy = Math.min(n - 1, Math.floor((qv * n) / (QM_MAX + 1)));
      const cell = cy * n + cx;
      for (let k = this.offsets[cell]!; k < this.offsets[cell + 1]!; k++) {
        const t = this.items[k]!;
        if (this.inside(t, qu, qv)) {
          tri = t;
          break;
        }
      }
    }
    if (tri < 0) return undefined;
    this.lastTri = tri;
    return this.intersect(tri, lon, lat, out ?? { height: 0, normal: { x: 0, y: 0, z: 1 } });
  }

  private inside(t: number, qu: number, qv: number): boolean {
    const { u, v, indices } = this;
    const i0 = indices[t * 3]!;
    const i1 = indices[t * 3 + 1]!;
    const i2 = indices[t * 3 + 2]!;
    const ax = u[i0]!;
    const ay = v[i0]!;
    const bx = u[i1]!;
    const by = v[i1]!;
    const cx = u[i2]!;
    const cy = v[i2]!;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (det === 0) return false;
    const l1 = ((by - cy) * (qu - cx) + (cx - bx) * (qv - cy)) / det;
    const l2 = ((cy - ay) * (qu - cx) + (ax - cx) * (qv - cy)) / det;
    return l1 >= -EPS && l2 >= -EPS && 1 - l1 - l2 >= -EPS;
  }

  private corner(i: number, out: Vec3Like) {
    const lon = this.bounds.west + (this.u[i]! / QM_MAX) * this.lonSpan;
    const lat = this.bounds.south + (this.v[i]! / QM_MAX) * this.latSpan;
    return geodeticToEcef(lon, lat, this.heights[i]!, out);
  }

  private intersect(t: number, lon: number, lat: number, out: SurfaceHit): SurfaceHit {
    const { a, b, c, p, up } = this;
    this.corner(this.indices[t * 3]!, a);
    this.corner(this.indices[t * 3 + 1]!, b);
    this.corner(this.indices[t * 3 + 2]!, c);
    const e1x = b.x - a.x;
    const e1y = b.y - a.y;
    const e1z = b.z - a.z;
    const e2x = c.x - a.x;
    const e2y = c.y - a.y;
    const e2z = c.z - a.z;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    geodeticToEcef(lon, lat, 0, p);
    upAt(lon, lat, up);
    let ndu = nx * up.x + ny * up.y + nz * up.z;
    if (ndu < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
      ndu = -ndu;
    }
    // Plane n·(x - a) = 0, line x = p + t·up.
    const height = (nx * (a.x - p.x) + ny * (a.y - p.y) + nz * (a.z - p.z)) / Math.max(ndu, 1e-6);
    out.height = height;
    out.normal.x = nx;
    out.normal.y = ny;
    out.normal.z = nz;
    return out;
  }
}
