import type { EnuFrame } from '../geo/ellipsoid';
import type { GeoBounds } from '../geo/tiles';
import type { TileMeshData } from './tileMesh';

export interface TerrainJob {
  url: string;
  bounds: GeoBounds;
  frame: EnuFrame;
}
export type TerrainResult = TileMeshData;

export interface ImageryJob {
  /** URL template with {z}/{x}/{y}. */
  template: string;
  bounds: GeoBounds;
  zoom: number;
  size: number;
  /** Vector tile template for the water mask (stored in the alpha channel), or null. */
  water: string | null;
}
export interface ImageryResult {
  bitmap: ImageBitmap;
  /** Number of source tiles that failed (e.g. outside coverage). */
  missing: number;
}

export type WorkerRequest<T> = { id: number; job: T };
export type WorkerResponse<R> =
  { id: number; ok: true; result: R } | { id: number; ok: false; error: string };
