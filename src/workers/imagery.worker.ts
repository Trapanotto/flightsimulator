/// <reference lib="webworker" />
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
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

/** Water polygons exist from zoom 8; zoom 14 is the most detailed level. */
const WATER_MIN_ZOOM = 8;
const WATER_MAX_ZOOM = 14;
/** Alpha removed where there is water: land keeps alpha 1 (exact colours), water gets 0.5. */
const WATER_ALPHA = 0.5;
const tileCache = new Map<string, Promise<VectorTile | null>>();

function vectorTile(template: string, z: number, x: number, y: number) {
  const key = `${z}/${x}/${y}`;
  let p = tileCache.get(key);
  if (!p) {
    const url = template
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y));
    p = fetchRetry(url)
      .then(async (res) =>
        res.ok ? new VectorTile(new PbfReader(new Uint8Array(await res.arrayBuffer()))) : null,
      )
      .catch(() => null);
    tileCache.set(key, p);
    // Neighbouring terrain tiles share vector tiles; keep the last few dozen.
    if (tileCache.size > 48) tileCache.delete(tileCache.keys().next().value!);
  }
  return p;
}

/** About one vector tile per terrain tile: geographic zoom z is as wide as mercator z + 1. */
function waterRange(job: ImageryJob) {
  const vz = Math.min(WATER_MAX_ZOOM, Math.max(WATER_MIN_ZOOM, job.zoom - 1));
  return { vz, r: mercatorTileRange(job.bounds, vz) };
}

/** Starts the vector downloads early so they run alongside the imagery. */
function prefetchWater(job: ImageryJob) {
  const { vz, r } = waterRange(job);
  for (let ty = r.y0; ty <= r.y1; ty++)
    for (let tx = r.x0; tx <= r.x1; tx++) void vectorTile(job.water!, vz, tx, ty);
}

/**
 * Cuts the water polygons out of the alpha channel. Points go straight from vector tile
 * coordinates (Web Mercator) to the geographic texture, so no strip warping is needed.
 */
async function drawWater(ctx: OffscreenCanvasRenderingContext2D, job: ImageryJob) {
  const { bounds: b, size } = job;
  const { vz, r } = waterRange(job);
  const n = 2 ** vz;
  const sx = size / (b.east - b.west);
  const sy = size / (b.north - b.south);
  const loads: Array<Promise<void>> = [];
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = `rgba(0,0,0,${WATER_ALPHA})`;
  for (let ty = r.y0; ty <= r.y1; ty++) {
    for (let tx = r.x0; tx <= r.x1; tx++) {
      loads.push(
        vectorTile(job.water!, vz, tx, ty).then((vt) => {
          const layer = vt?.layers.water;
          if (!layer) return;
          const extent = layer.extent;
          for (let i = 0; i < layer.length; i++) {
            const f = layer.feature(i);
            if (f.type !== 3) continue;
            // One path per feature with even-odd fill, so islands stay land.
            ctx.beginPath();
            for (const ring of f.loadGeometry()) {
              for (let k = 0; k < ring.length; k++) {
                const pt = ring[k]!;
                const lon = ((tx + pt.x / extent) / n) * 360 - 180;
                const my = Math.PI * (1 - (2 * (ty + pt.y / extent)) / n);
                const lat = (Math.atan(Math.sinh(my)) * 180) / Math.PI;
                const px = (lon - b.west) * sx;
                const py = (b.north - lat) * sy;
                if (k === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
              }
              ctx.closePath();
            }
            ctx.fill('evenodd');
          }
        }),
      );
    }
  }
  await Promise.all(loads);
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * Builds one texture for a geographic (EPSG:4326) terrain tile from
 * Web Mercator (EPSG:3857) imagery tiles: mosaic first, then redraw the mosaic
 * in thin strips so that every row lands at its true latitude.
 */
async function compose(job: ImageryJob): Promise<ImageryResult> {
  const { bounds: b, zoom: z, size } = job;
  if (job.water) prefetchWater(job);
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
  if (job.water) await drawWater(ctx, job);
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
