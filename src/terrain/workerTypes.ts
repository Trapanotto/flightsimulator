import type { GeoBounds } from '../geo/tiles';
import type { BuiltTerrainMesh } from './buildMesh';

export interface TerrainDecodeRequest {
  type: 'decode';
  id: number;
  url: string;
  bounds: GeoBounds;
  z: number;
  origin: { lon: number; lat: number; height: number };
}

export interface TerrainDecodeSuccess {
  type: 'decoded';
  id: number;
  mesh: BuiltTerrainMesh;
}

export interface TerrainDecodeError {
  type: 'error';
  id: number;
  message: string;
}

export type TerrainWorkerResponse = TerrainDecodeSuccess | TerrainDecodeError;

export interface ImageryRequest {
  type: 'compose';
  id: number;
  bounds: GeoBounds;
  z: number;
}

export interface ImagerySuccess {
  type: 'image';
  id: number;
  bitmap: ImageBitmap;
  imageryZ: number;
}

export interface ImageryError {
  type: 'error';
  id: number;
  message: string;
}

export type ImageryWorkerResponse = ImagerySuccess | ImageryError;
