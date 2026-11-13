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
  ground: GroundJob;
}

/** What the ground of a tile bakes (see groundSettings.ts). */
export interface GroundJob {
  /** 4 = lights and roads, 2 = lights only. */
  channels: 2 | 4;
  /** Bake the road field (only close tiles need it). */
  roads: boolean;
  /** Find the direction of field rows in the photo (into the mask's alpha). */
  rows: boolean;
  horizonSize: number;
  /** Read the coarse terrain of the surroundings for the horizon. */
  context: boolean;
  /** URL template of the terrain tiles (for the surroundings). */
  terrainTemplate: string;
}

/**
 * The ground texture (mip chain; channels: lamps, glow, road distance, road info, see
 * lights.ts and roads.ts) and the horizon texture of a tile (see horizon.ts).
 */
export interface GroundOutput {
  mips: Array<{ data: Uint8Array; width: number; height: number }>;
  channels: number;
  /** Luminance (cd/m²) a byte of 255 stands for in the lamp and glow channels. */
  lightScale: [number, number];
  /** Lamps placed (for the report). */
  lamps: number;
  horizon: Uint8Array;
  horizonSize: number;
  /** CPU time of the parts, ms (for the report). */
  timing: { lights: number; roads: number; horizon: number; mips: number };
}

/**
 * Channels of the land-cover mask, drawn from swisstopo's vector tiles:
 * R = water (lakes, rivers), G = forest, B = class code (see MASK_B_*), A = direction of
 * field rows from the photo on close tiles (see rows.ts; 0 = none).
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
  ground: GroundOutput;
  /** Wall time of the whole job (downloads included) and of its CPU work alone, ms. */
  timing: { totalMs: number; cpuMs: number };
}

export type WorkerRequest =
  { type: 'build'; id: number; job: TileJob } | { type: 'cancel'; id: number };

export type WorkerResponse =
  | { id: number; ok: true; result: TileOutput }
  /** absent: the source has no such tile (outside coverage); the parent stays the leaf. */
  | { id: number; ok: false; reason: 'absent' | 'cancelled' | 'error'; error?: string };
