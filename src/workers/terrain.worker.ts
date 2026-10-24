/// <reference lib="webworker" />
import { fetchRetry } from '../net/fetchRetry';
import { decodeQuantizedMesh } from '../terrain/quantizedMesh';
import { buildTileMesh } from '../terrain/tileMesh';
import type {
  TerrainJob,
  TerrainResult,
  WorkerRequest,
  WorkerResponse,
} from '../terrain/workerTypes';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (e: MessageEvent<WorkerRequest<TerrainJob>>) => {
  const { id, job } = e.data;
  try {
    const res = await fetchRetry(job.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const mesh = buildTileMesh(decodeQuantizedMesh(await res.arrayBuffer()), job.bounds, job.frame);
    const msg: WorkerResponse<TerrainResult> = { id, ok: true, result: mesh };
    self.postMessage(msg, [
      mesh.positions.buffer,
      mesh.normals.buffer,
      mesh.uvs.buffer,
      mesh.indices.buffer,
    ]);
  } catch (err) {
    const msg: WorkerResponse<TerrainResult> = { id, ok: false, error: String(err) };
    self.postMessage(msg);
  }
};
