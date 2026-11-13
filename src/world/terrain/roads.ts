/**
 * Roads for the close-up ground: per texel the distance to the nearest road's centre line and
 * that road's half width and surface, baked in the worker from the vector tiles. The shader
 * draws crisp asphalt or gravel ribbons with edge and centre markings from it, where the
 * orthophoto is only a blur. Pure functions on tile pixel coordinates, tested in Node.
 */

/** A road in tile pixels: x, y pairs (row 0 = north edge). */
export interface RoadLine {
  cls: string;
  /** `surface` of the base map ('paved', 'unpaved', ...), if given. */
  surface?: string;
  tunnel: boolean;
  points: ArrayLike<number>;
}

/** Distances are stored up to this many metres from the centre line. */
export const ROAD_RANGE = 12;
/** Half widths are stored up to this many metres. */
export const ROAD_MAX_HALF = 8;

/**
 * Half width (m) of a road class as built in Switzerland, and whether it is asphalt; null for
 * what is not drawn (paths, rails, tunnels). The base map has one line per carriageway on
 * motorways.
 */
export function roadShape(
  cls: string,
  surface: string | undefined,
  tunnel: boolean,
): { half: number; paved: boolean; marked: boolean } | null {
  if (tunnel) return null;
  const unpaved = surface === 'unpaved' || surface === 'gravel' || surface === 'dirt';
  switch (cls) {
    case 'motorway':
      return { half: 5.2, paved: true, marked: true };
    case 'trunk':
      return { half: 4.2, paved: true, marked: true };
    case 'primary':
      return { half: 3.7, paved: true, marked: true };
    case 'secondary':
      return { half: 3.3, paved: true, marked: true };
    case 'tertiary':
      return { half: 2.9, paved: !unpaved, marked: false };
    case 'minor':
      return { half: 2.4, paved: !unpaved, marked: false };
    case 'service':
      return { half: 1.8, paved: !unpaved, marked: false };
    case 'track':
      return { half: 1.5, paved: surface === 'paved', marked: false };
    default:
      return null;
  }
}

/**
 * Texel byte layout: dist = distance to the centre line / ROAD_RANGE (255 = none near);
 * info = 0 no road, else 1 + 2 * round(half / ROAD_MAX_HALF * 60) + marked, plus 128 when paved.
 */
export function encodeRoadInfo(half: number, paved: boolean, marked: boolean): number {
  return (
    (paved ? 128 : 0) +
    1 +
    2 * Math.round((Math.min(half, ROAD_MAX_HALF) / ROAD_MAX_HALF) * 60) +
    (marked ? 1 : 0)
  );
}

export function decodeRoadInfo(
  b: number,
): { half: number; paved: boolean; marked: boolean } | null {
  if (b === 0) return null;
  const paved = b >= 128;
  const v = (b & 127) - 1;
  return { half: (Math.floor(v / 2) / 60) * ROAD_MAX_HALF, paved, marked: (v & 1) === 1 };
}

/**
 * Writes the road field of a tile into `out` (texels of `stride` bytes, the distance at
 * `offset`, the road info at `offset + 1`). Where roads come close, the nearest one wins.
 */
export function bakeRoads(
  size: number,
  metresPerPixel: number,
  roads: RoadLine[],
  out: Uint8Array,
  stride: number,
  offset: number,
) {
  const best = new Float32Array(size * size).fill(Infinity);
  const info = new Uint8Array(size * size);
  const range = ROAD_RANGE / metresPerPixel;
  for (const road of roads) {
    const shape = roadShape(road.cls, road.surface, road.tunnel);
    if (!shape) continue;
    const code = encodeRoadInfo(shape.half, shape.paved, shape.marked);
    const p = road.points;
    for (let i = 2; i < p.length; i += 2) {
      // Long segments go in pieces, so the boxes scanned hug the road (diagonal roads).
      const sx = p[i - 2]!;
      const sy = p[i - 1]!;
      const pieces = Math.max(1, Math.ceil(Math.hypot(p[i]! - sx, p[i + 1]! - sy) / (2 * range)));
      for (let q = 0; q < pieces; q++) {
        const ax = sx + ((p[i]! - sx) * q) / pieces;
        const ay = sy + ((p[i + 1]! - sy) * q) / pieces;
        const bx = sx + ((p[i]! - sx) * (q + 1)) / pieces;
        const by = sy + ((p[i + 1]! - sy) * (q + 1)) / pieces;
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - range));
        const x1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx) + range));
        const y0 = Math.max(0, Math.floor(Math.min(ay, by) - range));
        const y1 = Math.min(size - 1, Math.ceil(Math.max(ay, by) + range));
        if (x0 > x1 || y0 > y1) continue;
        const halfPx = shape.half / metresPerPixel;
        const range2 = range * range;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) {
            const px = x + 0.5 - ax;
            const py = y + 0.5 - ay;
            const t = len2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / len2)) : 0;
            const ex = px - dx * t;
            const ey = py - dy * t;
            const d2 = ex * ex + ey * ey;
            if (d2 > range2) continue;
            const d = Math.sqrt(d2);
            const k = y * size + x;
            // Measured from the road's edge, so a wide road is not hidden by a lane beside it.
            const edge = d - halfPx;
            if (edge < best[k]!) {
              best[k] = edge;
              info[k] = code;
              out[k * stride + offset] = Math.round(Math.min(d / range, 1) * 255);
            }
          }
      }
    }
  }
  for (let k = 0; k < size * size; k++) {
    if (info[k] === 0) out[k * stride + offset] = 255;
    out[k * stride + offset + 1] = info[k]!;
  }
}
