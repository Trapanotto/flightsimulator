import type { TileKey } from '@geo';
import type { CellGrid } from './grid';
import type { MeshData } from './mesh';
import type { FootprintLod } from './presets';

/** Messages between the building layer and its workers. */
export type BuildingJob =
  | {
      kind: 'footprints';
      url: string;
      key: TileKey;
      lod: FootprintLod;
      elevation: number[];
      grid: CellGrid;
    }
  | { kind: 'cell'; url: string; cell: number; grid: CellGrid };

export type WorkerRequest =
  { type: 'job'; id: number; job: BuildingJob } | { type: 'cancel'; id: number };

export interface JobOutput {
  mesh: MeshData;
  /** Footprint tiles: the swissBUILDINGS3D cells holding their buildings. */
  cells?: Uint32Array;
  /** Bytes downloaded for the job (compressed size where the server says so). */
  bytes: number;
  /** Milliseconds spent decoding and building (not downloading). */
  buildMs: number;
}

export type WorkerResponse =
  | { type: 'done'; id: number; output: JobOutput }
  | { type: 'failed'; id: number; reason: 'absent' | 'cancelled' | 'error'; error?: string };

/** Buffers to transfer instead of copy. */
export function transferables(o: JobOutput): ArrayBuffer[] {
  const m = o.mesh;
  const list = [
    m.position.buffer,
    m.look.buffer,
    m.indices.buffer,
    m.starts.buffer,
    m.anchors.buffer,
    m.ground.buffer,
  ];
  if (o.cells) list.push(o.cells.buffer);
  return list as ArrayBuffer[];
}
