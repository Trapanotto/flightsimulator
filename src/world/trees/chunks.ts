import {
  type GeoBounds,
  distanceToBounds,
  mercatorLat,
  mercatorLon,
  mercatorX,
  mercatorY,
} from '@geo';
import { THIN_POWER, type TreePreset } from './presets';
import { STRIDE } from './protocol';

/**
 * Trees are built per Web Mercator tile of zoom 14 (about 1.7 km wide in Switzerland), the
 * finest zoom of swisstopo's vector tiles: one chunk is one vector tile, so a chunk is built
 * from one download and its edges are the tile's edges.
 */
export const CHUNK_ZOOM = 14;
/** Scatter cells per chunk side: about 4.3 m in Switzerland, one tree per cell at most. */
export const SCATTER_GRID = 384;
/** Each chunk is split into CELLS x CELLS cells for culling and the near levels of detail. */
export const CELLS = 4;

export interface ChunkKey {
  x: number;
  y: number;
}

export const chunkId = (k: ChunkKey) => `${k.x}/${k.y}`;

export function chunkBounds(k: ChunkKey): GeoBounds {
  return {
    west: mercatorLon(k.x, CHUNK_ZOOM),
    east: mercatorLon(k.x + 1, CHUNK_ZOOM),
    north: mercatorLat(k.y, CHUNK_ZOOM),
    south: mercatorLat(k.y + 1, CHUNK_ZOOM),
  };
}

/** Chunks whose ground lies within `radius` metres (horizontally) of lon/lat. */
export function chunksWithin(lon: number, lat: number, radius: number): ChunkKey[] {
  // A generous range in tiles, then the exact distance per tile.
  const mPerTile = (40_075_017 * Math.cos((lat * Math.PI) / 180)) / 2 ** CHUNK_ZOOM;
  const r = Math.ceil(radius / mPerTile) + 1;
  const cx = Math.floor(mercatorX(lon, CHUNK_ZOOM));
  const cy = Math.floor(mercatorY(lat, CHUNK_ZOOM));
  const out: ChunkKey[] = [];
  for (let y = cy - r; y <= cy + r; y++)
    for (let x = cx - r; x <= cx + r; x++) {
      const k = { x, y };
      if (distanceToBounds(lon, lat, chunkBounds(k)) <= radius) out.push(k);
    }
  return out;
}

/**
 * Share of the trees shown at distance d (metres): all of them up to thinStart, then fewer as
 * (thinStart / d)^THIN_POWER, faded to none between fadeStart and fadeEnd. The shader uses the
 * same curve per tree (a tree is drawn while its rank is below it).
 */
export function keepAt(d: number, p: TreePreset): number {
  let k = d <= p.thinStart ? 1 : Math.pow(p.thinStart / d, THIN_POWER);
  if (d > p.fadeStart) {
    const t = Math.min(1, (d - p.fadeStart) / (p.fadeEnd - p.fadeStart));
    k *= 1 - t * t * (3 - 2 * t);
  }
  return k;
}

/**
 * Detail levels a chunk is stored at: the share of its trees (by rank) kept in memory. A far
 * chunk needs only its few highest-ranked trees; it is rebuilt with more when it comes closer.
 */
export const LEVELS = [1, 0.5, 0.25, 0.125] as const;

/** The smallest stored level that holds every tree shown at distance d. */
export function levelFor(d: number, p: TreePreset): number {
  const k = keepAt(d, p);
  let level: number = LEVELS[0];
  for (const l of LEVELS) if (l >= k * 1.02) level = l;
  return level;
}

export interface ChunkState {
  id: string;
  /** Metres from the camera to the chunk's nearest ground. */
  distance: number;
  /** Still needed for the current view. */
  wanted: boolean;
}

/**
 * Which chunks to free so that at most `max` stay: chunks the view no longer needs first,
 * farthest first; wanted chunks only if the view needs more than the budget, again farthest
 * first.
 */
export function evictionOrder(chunks: readonly ChunkState[], max: number): string[] {
  const over = chunks.length - max;
  if (over <= 0) return [];
  const sorted = [...chunks].sort((a, b) =>
    a.wanted !== b.wanted ? (a.wanted ? 1 : -1) : b.distance - a.distance,
  );
  return sorted.slice(0, over).map((c) => c.id);
}

/** Number of trees with rank below `keep` (data sorted by rank). */
export function upperBoundRank(data: Float32Array, count: number, keep: number): number {
  if (keep >= 1) return count;
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (data[mid * STRIDE + 3]! < keep) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
