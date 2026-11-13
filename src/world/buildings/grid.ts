import {
  type GeoBounds,
  type TileKey,
  distanceToBounds,
  mercatorLat,
  mercatorLon,
  mercatorX,
  mercatorY,
} from '@geo';

/**
 * swissBUILDINGS3D as 3D Tiles (3d.geo.admin.ch): a single level of b3dm tiles on a regular
 * 2048 x 2048 grid of geographic cells over Switzerland's bounding box (about 168 m x 108 m
 * each), named `11/{cx}/{cy}.b3dm` with cy counted from the south. Every leaf of the published
 * tileset has geometric error 0 and is exactly one such cell, so a cell's URL follows from its
 * position without walking the 450 000-leaf tileset tree. Only cells with buildings exist.
 */
export interface CellGrid {
  /** Degrees. */
  west: number;
  south: number;
  east: number;
  north: number;
  /** Cells per side. */
  size: number;
  /** The level in the tile path. */
  level: number;
}

const DEG = 180 / Math.PI;

/** The grid of the 2026-05-20 release, from its tileset.json root region (radians). */
export const SWISSBUILDINGS_GRID: CellGrid = {
  west: 0.1040118274090453 * DEG,
  south: 0.7996693601551821 * DEG,
  east: 0.1831240027021035 * DEG,
  north: 0.8342953819889662 * DEG,
  size: 2048,
  level: 11,
};

/** Reads the grid from a dated tileset.json (its root region spans the grid exactly). */
export function parseCellGrid(json: unknown): CellGrid {
  const t = json as { root?: { boundingVolume?: { region?: number[] } } };
  const r = t.root?.boundingVolume?.region;
  if (!r || r.length < 4) throw new Error('buildings tileset.json: no root region');
  return {
    west: r[0]! * DEG,
    south: r[1]! * DEG,
    east: r[2]! * DEG,
    north: r[3]! * DEG,
    size: 2048,
    level: 11,
  };
}

export const cellWidth = (g: CellGrid) => (g.east - g.west) / g.size;
export const cellHeight = (g: CellGrid) => (g.north - g.south) / g.size;

/** One number per cell: exact in a float32 (below 2^24), so it can travel as a vertex value. */
export const cellId = (g: CellGrid, cx: number, cy: number) => cy * g.size + cx;

/** The cell at lon/lat, or -1 outside the grid. */
export function cellIdAt(g: CellGrid, lon: number, lat: number): number {
  const cx = Math.floor((lon - g.west) / cellWidth(g));
  const cy = Math.floor((lat - g.south) / cellHeight(g));
  if (cx < 0 || cy < 0 || cx >= g.size || cy >= g.size) return -1;
  return cellId(g, cx, cy);
}

export function cellBounds(g: CellGrid, id: number): GeoBounds {
  const cx = id % g.size;
  const cy = Math.floor(id / g.size);
  const w = cellWidth(g);
  const h = cellHeight(g);
  return {
    west: g.west + cx * w,
    south: g.south + cy * h,
    east: g.west + (cx + 1) * w,
    north: g.south + (cy + 1) * h,
  };
}

export function cellPath(g: CellGrid, id: number): string {
  return `${g.level}/${id % g.size}/${Math.floor(id / g.size)}.b3dm`;
}

// ---- Footprint tiles (swisstopo vector tiles, Web Mercator) ----

export function mercatorTileBounds(t: TileKey): GeoBounds {
  return {
    west: mercatorLon(t.x, t.z),
    east: mercatorLon(t.x + 1, t.z),
    north: mercatorLat(t.y, t.z),
    south: mercatorLat(t.y + 1, t.z),
  };
}

/** Where the camera is: degrees, and metres above the ground under it. */
export interface ViewPoint {
  lon: number;
  lat: number;
  /** Height above the ground (not the ellipsoid): distances are measured in 3D. */
  agl: number;
}

/** Straight-line distance from the camera to the nearest point of a ground area, metres. */
export function viewDistance(v: ViewPoint, b: GeoBounds): number {
  const d = distanceToBounds(v.lon, v.lat, b);
  return Math.hypot(d, Math.max(v.agl, 0));
}

export interface Wanted<K> {
  key: K;
  distance: number;
}

/** Mercator tiles at zoom z closer than `range` to the camera, nearest first. */
export function tilesInRange(v: ViewPoint, z: number, range: number): Wanted<TileKey>[] {
  const out: Wanted<TileKey>[] = [];
  if (v.agl >= range) return out;
  const n = 2 ** z;
  const mPerDegLat = 111_200;
  const dLat = range / mPerDegLat;
  const dLon = range / (mPerDegLat * Math.cos((v.lat * Math.PI) / 180));
  const x0 = Math.max(0, Math.floor(mercatorX(v.lon - dLon, z)));
  const x1 = Math.min(n - 1, Math.floor(mercatorX(v.lon + dLon, z)));
  const y0 = Math.max(0, Math.floor(mercatorY(v.lat + dLat, z)));
  const y1 = Math.min(n - 1, Math.floor(mercatorY(v.lat - dLat, z)));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const key = { z, x, y };
      const distance = viewDistance(v, mercatorTileBounds(key));
      if (distance < range) out.push({ key, distance });
    }
  return out.sort((a, b) => a.distance - b.distance);
}

/**
 * Of the cells known to hold buildings, those closer than `range`, nearest first, at most
 * `max` of them (a dense city centre would otherwise ask for more than the budget).
 */
export function cellsInRange(
  g: CellGrid,
  v: ViewPoint,
  cells: Iterable<number>,
  range: number,
  max: number,
): Wanted<number>[] {
  const out: Wanted<number>[] = [];
  if (v.agl >= range) return out;
  for (const id of cells) {
    const distance = viewDistance(v, cellBounds(g, id));
    if (distance < range) out.push({ key: id, distance });
  }
  out.sort((a, b) => a.distance - b.distance);
  if (out.length > max) out.length = max;
  return out;
}

/**
 * Hysteresis for anything streamed by distance: a tile is wanted inside `range`, kept until
 * it is beyond `range * keep`, so flying along the edge does not load and drop it in turns.
 */
export function shouldEvict(distance: number, range: number, keep = 1.25): boolean {
  return distance > range * keep;
}
