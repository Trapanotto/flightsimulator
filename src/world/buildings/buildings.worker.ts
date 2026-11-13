/// <reference lib="webworker" />
import dracoWrapper from 'three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js?raw';
import dracoWasmUrl from 'three/examples/jsm/libs/draco/gltf/draco_decoder.wasm?url';
import { parseB3dm } from './b3dm';
import { type DracoModule, createDraco } from './draco';
import { buildFootprintTile } from './extrude';
import { type BuildingJob, type JobOutput, type WorkerRequest, type WorkerResponse, transferables } from './protocol';
import { buildDetailTile } from './tile3d';

/**
 * Downloads, decodes and builds building tiles off the main thread: footprint tiles from the
 * vector tiles, swissBUILDINGS3D cells from their b3dm (Draco). Results are plain arrays,
 * transferred without copying.
 */
const scope = self as unknown as DedicatedWorkerGlobalScope;
const running = new Map<number, AbortController>();
let draco: Promise<DracoModule> | undefined;

class Absent extends Error {}

/** fetch with a few retries for passing failures; 403/404 mean "no such tile". */
async function download(url: string, signal: AbortSignal): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal });
      if (res.status === 403 || res.status === 404) throw new Absent();
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      if (res.status < 500 && res.status !== 429) throw new Error(`HTTP ${res.status}`);
      if (attempt >= 3) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (err instanceof Absent || signal.aborted || attempt >= 3) throw err;
    }
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  }
}

function decoder(): Promise<DracoModule> {
  draco ??= fetch(dracoWasmUrl)
    .then((r) => r.arrayBuffer())
    .then((wasm) => createDraco(dracoWrapper, wasm));
  // A failed start may be passing (network): try again with the next tile.
  draco.catch(() => (draco = undefined));
  return draco;
}

async function run(job: BuildingJob, signal: AbortSignal): Promise<JobOutput> {
  const bytes = await download(job.url, signal);
  const t0 = performance.now();
  if (job.kind === 'footprints') {
    const r = buildFootprintTile(bytes, job);
    return { mesh: r.mesh, cells: r.cells, bytes: bytes.length, buildMs: performance.now() - t0 };
  }
  const tile = parseB3dm(bytes);
  const needsDraco = tile.gltf.extensionsUsed?.includes('KHR_draco_mesh_compression');
  const d = needsDraco ? await decoder() : undefined;
  const t1 = performance.now();
  const mesh = buildDetailTile(tile, d, job.grid, job.cell);
  return { mesh, bytes: bytes.length, buildMs: performance.now() - t1 + (t1 - t0) };
}

scope.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    running.get(msg.id)?.abort();
    return;
  }
  const ctrl = new AbortController();
  running.set(msg.id, ctrl);
  run(msg.job, ctrl.signal).then(
    (output) => {
      running.delete(msg.id);
      const res: WorkerResponse = { type: 'done', id: msg.id, output };
      scope.postMessage(res, transferables(output));
    },
    (err: unknown) => {
      running.delete(msg.id);
      const res: WorkerResponse = {
        type: 'failed',
        id: msg.id,
        reason: err instanceof Absent ? 'absent' : ctrl.signal.aborted ? 'cancelled' : 'error',
        error: String(err),
      };
      scope.postMessage(res);
    },
  );
};
