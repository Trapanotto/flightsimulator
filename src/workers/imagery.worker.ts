/// <reference lib="webworker" />
import { MERCATOR_TILE_PX, mercatorPx, mercatorPy, mercatorTileRange } from '../geo/tiles';
import { fetchRetry } from '../net/fetchRetry';
import type {
  ImageryJob,
  ImageryResult,
  WorkerRequest,
  WorkerResponse,
} from '../terrain/workerTypes';

declare const self: DedicatedWorkerGlobalScope;

/** Parallel source-tile downloads per job. */
const FETCH_CONCURRENCY = 4;
/** Horizontal strips used to bend Web Mercator rows onto the geographic tile. */
const STRIPS = 32;
const FALLBACK_COLOR = '#7d8a6a';

async function loadTile(url: string): Promise<ImageBitmap | null> {
  try {
    const res = await fetchRetry(url);
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob());
  } catch {
    return null;
  }
}

/**
 * Builds one texture for a geographic (EPSG:4326) terrain tile from
 * Web Mercator (EPSG:3857) imagery tiles: mosaic first, then redraw the mosaic
 * in thin strips so that every row lands at its true latitude.
 */
async function compose(job: ImageryJob): Promise<ImageryResult> {
  const { bounds: b, zoom: z, size } = job;
  const r = mercatorTileRange(b, z);
  const cols = r.x1 - r.x0 + 1;
  const rows = r.y1 - r.y0 + 1;

  const mosaic = new OffscreenCanvas(cols * MERCATOR_TILE_PX, rows * MERCATOR_TILE_PX);
  const mctx = mosaic.getContext('2d')!;
  mctx.fillStyle = FALLBACK_COLOR;
  mctx.fillRect(0, 0, mosaic.width, mosaic.height);

  const tasks: Array<{ x: number; y: number }> = [];
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) tasks.push({ x, y });

  let missing = 0;
  let next = 0;
  const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, tasks.length) }, async () => {
    while (next < tasks.length) {
      const t = tasks[next++]!;
      const url = job.template
        .replace('{z}', String(z))
        .replace('{x}', String(t.x))
        .replace('{y}', String(t.y));
      const bmp = await loadTile(url);
      if (!bmp) {
        missing++;
        continue;
      }
      mctx.drawImage(bmp, (t.x - r.x0) * MERCATOR_TILE_PX, (t.y - r.y0) * MERCATOR_TILE_PX);
      bmp.close();
    }
  });
  await Promise.all(workers);

  const out = new OffscreenCanvas(size, size);
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const ox = r.x0 * MERCATOR_TILE_PX;
  const oy = r.y0 * MERCATOR_TILE_PX;
  const sx = mercatorPx(b.west, z) - ox;
  const sw = mercatorPx(b.east, z) - ox - sx;
  const latSpan = b.north - b.south;
  for (let k = 0; k < STRIPS; k++) {
    const top = b.north - (latSpan * k) / STRIPS;
    const bottom = b.north - (latSpan * (k + 1)) / STRIPS;
    const sy0 = mercatorPy(top, z) - oy;
    const sy1 = mercatorPy(bottom, z) - oy;
    const dy0 = Math.round((size * k) / STRIPS);
    const dy1 = Math.round((size * (k + 1)) / STRIPS);
    ctx.drawImage(mosaic, sx, sy0, sw, sy1 - sy0, 0, dy0, size, dy1 - dy0);
  }
  return { bitmap: out.transferToImageBitmap(), missing };
}

self.onmessage = async (e: MessageEvent<WorkerRequest<ImageryJob>>) => {
  const { id, job } = e.data;
  try {
    const result = await compose(job);
    const msg: WorkerResponse<ImageryResult> = { id, ok: true, result };
    self.postMessage(msg, [result.bitmap]);
  } catch (err) {
    const msg: WorkerResponse<ImageryResult> = { id, ok: false, error: String(err) };
    self.postMessage(msg);
  }
};
