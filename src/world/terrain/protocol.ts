import type { TileKey } from '@geo';
import type { TileGeometry } from './tileGeometry';

/** One tile to build: terrain mesh, orthophoto texture and land-cover mask. */
export interface TileJob {
  key: TileKey;
  terrainUrl: string;
  /** Orthophoto: Mercator zoom and texture size in pixels. */
  imageZoom: number;
  imageSize: number;
  /** Land-cover mask size in pixels (see MASK_* below). */
  maskSize: number;
  /** Vector tile zoom for the mask, or -1 for none. */
  vectorZoom: number;
}

/**
 * Channels of the land-cover mask, drawn from swisstopo's vector tiles:
 * R = water (lakes, rivers), G = forest, B = class code (see MASK_B_*).
 */
export const MASK_B_GLACIER = 255;
export const MASK_B_RUNWAY = 160;
export const MASK_B_GRASS_RUNWAY = 80;

export interface TileOutput {
  geometry: TileGeometry;
  /** Quantized positions of the surface vertices (for the height index). */
  u: Uint16Array;
  v: Uint16Array;
  image: ImageBitmap;
  /** RGBA, maskSize x maskSize, row 0 = north. */
  mask: Uint8Array;
  maskSize: number;
  /** Imagery tiles that could not be loaded (the tile still shows, partly in a flat colour). */
  missingImagery: number;
  /** Wall time of the whole job (downloads included) and of its CPU work alone, ms. */
  timing: { totalMs: number; cpuMs: number };
}

export type WorkerRequest =
  { type: 'build'; id: number; job: TileJob } | { type: 'cancel'; id: number };

export type WorkerResponse =
  | { id: number; ok: true; result: TileOutput }
  /** absent: the source has no such tile (outside coverage); the parent stays the leaf. */
  | { id: number; ok: false; reason: 'absent' | 'cancelled' | 'error'; error?: string };
