import type { ChunkKey } from './chunks';

/** One chunk to build in the worker. */
export interface ChunkJob {
  key: ChunkKey;
  /** Share of the trees kept, by rank (the device's share times the chunk's level). */
  keep: number;
  /** The device's share: ranks are divided by it, so 0..1 again on every device. */
  share: number;
  /** Crown and height scale of the device preset. */
  crownScale: number;
  /** Terrain tile URL template ({z}/{x}/{y}) for elevations, or '' to load it in the worker. */
  terrainTemplate: string;
}

/**
 * Floats per tree in the instance buffers:
 *   0..3  x, yc, z, rank   position in the chunk frame at zero ellipsoid height (x east, y up,
 *                          z south; yc is the Earth's curvature drop), rank 0..1
 *   4..7  height, width, rotation, species + seed * 0.98
 *   8..11 photo r, g, b (linear albedo, r < 0: none), and packed: whole metres to the forest
 *          edge (0..31) * 4 + photo brightness relative to the chunk's forest (0..3.99)
 */
export const STRIDE = 12;

export interface FormData {
  /** STRIDE floats per tree, sorted by rank. */
  data: Float32Array;
  /** Cell (0 .. CELLS² - 1) of each tree. */
  cells: Uint8Array;
  count: number;
}

export interface ChunkOutput {
  /** Centre of the chunk frame: lon, lat in degrees (height 0 above the ellipsoid). */
  origin: { lon: number; lat: number };
  /** Half sizes of the chunk in its own frame, metres (x east, z south). */
  halfX: number;
  halfZ: number;
  /** Conifer and broadleaf forms. */
  forms: [FormData, FormData];
  stats: {
    trees: number;
    singles: number;
    candidates: number;
    forestShare: number;
    photo: boolean;
    elevation: boolean;
    ms: number;
    species: number[];
  };
}

export type TreeWorkerRequest =
  { type: 'build'; id: number; job: ChunkJob } | { type: 'cancel'; id: number };

export type TreeWorkerResponse =
  | { id: number; ok: true; result: ChunkOutput }
  | { id: number; ok: false; reason: 'cancelled' | 'error' | 'empty'; error?: string };
