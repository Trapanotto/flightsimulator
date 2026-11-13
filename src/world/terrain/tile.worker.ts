/// <reference lib="webworker" />
import { VectorTile, type VectorTileLayer } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import {
  type GeoBounds,
  MERCATOR_TILE_PX,
  SWISSIMAGE_URL,
  type TileKey,
  VECTOR_TILE_URL,
  decodeQuantizedMesh,
  fillTemplate,
  geoTileBounds,
  mercatorTileRange,
  planMercatorWarp,
  vectorTilePointToLonLat,
} from '@geo';
import {
  MASK_B_GLACIER,
  MASK_B_GRASS_RUNWAY,
  MASK_B_RUNWAY,
  type TileJob,
  type TileOutput,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol';
import { buildTileGeometry } from './tileGeometry';

declare const self: DedicatedWorkerGlobalScope;

/** Parallel imagery downloads per tile. */
const IMAGE_CONCURRENCY = 6;
/** Shown where an orthophoto tile is missing: a muted meadow green. */
const FALLBACK_COLOR = '#56603f';

class Absent extends Error {}

const jobs = new Map<number, AbortController>();

/** fetch with retries for passing failures (network, 429, 5xx); 4xx fail at once. */
async function fetchRetry(url: string, signal: AbortSignal, retries = 3): Promise<Response> {
  let delay = 300;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal });
      if (res.ok || (res.status < 500 && res.status !== 429) || attempt >= retries) return res;
    } catch (err) {
      if (signal.aborted || attempt >= retries) throw err;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay *= 2;
  }
}

async function loadImage(url: string, signal: AbortSignal): Promise<ImageBitmap | null> {
  try {
    const res = await fetchRetry(url, signal);
    if (!res.ok) return null;
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    // Outside its coverage SWISSIMAGE serves plain white tiles (well under 4 kB as JPEG).
    if (blob.size < 4096 && isBlank(bmp)) {
      bmp.close();
      return null;
    }
    return bmp;
  } catch (err) {
    if (signal.aborted) throw err;
    return null;
  }
}

const probe = new OffscreenCanvas(8, 8);
const probeCtx = probe.getContext('2d', { willReadFrequently: true })!;
function isBlank(bmp: ImageBitmap): boolean {
  probeCtx.drawImage(bmp, 0, 0, 8, 8);
  const d = probeCtx.getImageData(0, 0, 8, 8).data;
  for (let i = 0; i < d.length; i += 4)
    if (d[i]! < 245 || d[i + 1]! < 245 || d[i + 2]! < 245) return false;
  return true;
}

/**
 * The orthophoto of a geographic tile: Mercator tiles are pasted into a mosaic, then the mosaic
 * is redrawn in thin horizontal bands so that every row lands at its true latitude.
 */
async function composeImage(job: TileJob, b: GeoBounds, signal: AbortSignal) {
  const plan = planMercatorWarp(b, job.imageZoom, job.imageSize);
  const r = plan.range;
  const mosaic = new OffscreenCanvas(
    (r.x1 - r.x0 + 1) * MERCATOR_TILE_PX,
    (r.y1 - r.y0 + 1) * MERCATOR_TILE_PX,
  );
  const mctx = mosaic.getContext('2d')!;
  mctx.fillStyle = FALLBACK_COLOR;
  mctx.fillRect(0, 0, mosaic.width, mosaic.height);

  const tasks: Array<{ x: number; y: number }> = [];
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) tasks.push({ x, y });
  let missing = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(IMAGE_CONCURRENCY, tasks.length) }, async () => {
      while (next < tasks.length) {
        const t = tasks[next++]!;
        const bmp = await loadImage(fillTemplate(SWISSIMAGE_URL, plan.zoom, t.x, t.y), signal);
        if (!bmp) {
          missing++;
          continue;
        }
        mctx.drawImage(bmp, (t.x - r.x0) * MERCATOR_TILE_PX, (t.y - r.y0) * MERCATOR_TILE_PX);
        bmp.close();
      }
    }),
  );

  const out = new OffscreenCanvas(job.imageSize, job.imageSize);
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const sw = plan.sx1 - plan.sx0;
  for (const band of plan.bands)
    ctx.drawImage(
      mosaic,
      plan.sx0,
      band.sy0,
      sw,
      band.sy1 - band.sy0,
      0,
      band.dy0,
      job.imageSize,
      band.dy1 - band.dy0,
    );
  return { image: out.transferToImageBitmap(), missing };
}

// ---- Land-cover mask from vector tiles ----

const vectorCache = new Map<string, Promise<VectorTile | null>>();

function vectorTile(z: number, x: number, y: number, signal: AbortSignal) {
  const key = `${z}/${x}/${y}`;
  let p = vectorCache.get(key);
  if (!p) {
    // Not tied to the job's signal: neighbouring tiles share vector tiles.
    p = fetchRetry(fillTemplate(VECTOR_TILE_URL, z, x, y), new AbortController().signal)
      .then(async (res) =>
        res.ok ? new VectorTile(new PbfReader(new Uint8Array(await res.arrayBuffer()))) : null,
      )
      .catch(() => null);
    vectorCache.set(key, p);
    if (vectorCache.size > 64) vectorCache.delete(vectorCache.keys().next().value!);
  } else {
    // Refresh its place in the LRU order.
    vectorCache.delete(key);
    vectorCache.set(key, p);
  }
  return signal.aborted ? Promise.reject(new DOMException('aborted', 'AbortError')) : p;
}

interface MaskRule {
  layer: string;
  match: (props: Record<string, unknown>) => boolean;
  color: string;
}

const MASK_RULES: MaskRule[] = [
  {
    layer: 'water',
    match: (p) => p.class === 'lake' || p.class === 'river',
    color: 'rgb(255,0,0)',
  },
  {
    layer: 'landcover',
    match: (p) => p.class === 'wood' && (p.subclass === 'forest' || p.subclass === 'loose_forest'),
    color: 'rgb(0,255,0)',
  },
  {
    layer: 'landcover',
    match: (p) => p.class === 'ice',
    color: `rgb(0,0,${MASK_B_GLACIER})`,
  },
  { layer: 'aeroway', match: (p) => p.class === 'runway', color: `rgb(0,0,${MASK_B_RUNWAY})` },
  {
    layer: 'aeroway',
    match: (p) => p.class === 'runway_grass',
    color: `rgb(0,0,${MASK_B_GRASS_RUNWAY})`,
  },
];

function drawLayer(
  ctx: OffscreenCanvasRenderingContext2D,
  layer: VectorTileLayer | undefined,
  tile: TileKey,
  b: GeoBounds,
  size: number,
  rule: MaskRule,
) {
  if (!layer) return;
  const sx = size / (b.east - b.west);
  const sy = size / (b.north - b.south);
  const ll = { lon: 0, lat: 0 };
  ctx.fillStyle = rule.color;
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 3 || !rule.match(f.properties)) continue;
    // One path per feature with even-odd filling, so islands stay land.
    ctx.beginPath();
    for (const ring of f.loadGeometry()) {
      for (let k = 0; k < ring.length; k++) {
        const pt = ring[k]!;
        vectorTilePointToLonLat(tile, layer.extent, pt.x, pt.y, ll);
        const px = (ll.lon - b.west) * sx;
        const py = (b.north - ll.lat) * sy;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }
}

async function composeMask(job: TileJob, b: GeoBounds, signal: AbortSignal): Promise<Uint8Array> {
  const size = job.maskSize;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  if (job.vectorZoom >= 0) {
    const r = mercatorTileRange(b, job.vectorZoom);
    const loads: Array<Promise<{ tile: TileKey; vt: VectorTile | null }>> = [];
    for (let y = r.y0; y <= r.y1; y++)
      for (let x = r.x0; x <= r.x1; x++) {
        const tile = { z: job.vectorZoom, x, y };
        loads.push(vectorTile(tile.z, x, y, signal).then((vt) => ({ tile, vt })));
      }
    const tiles = await Promise.all(loads);
    // Additive drawing: channels of overlapping classes combine instead of covering each other.
    ctx.globalCompositeOperation = 'lighter';
    for (const rule of MASK_RULES)
      for (const { tile, vt } of tiles)
        if (vt) drawLayer(ctx, vt.layers[rule.layer], tile, b, size, rule);
  }
  return new Uint8Array(ctx.getImageData(0, 0, size, size).data.buffer);
}

async function build(job: TileJob, controller: AbortController): Promise<TileOutput> {
  const b = geoTileBounds(job.key);
  const signal = controller.signal;
  const terrain = fetchRetry(job.terrainUrl, signal).then(async (res) => {
    if (res.status === 403 || res.status === 404) throw new Absent();
    if (!res.ok) throw new Error(`terrain HTTP ${res.status}`);
    return res.arrayBuffer();
  });
  // Without terrain there is no tile: stop the imagery downloads too.
  terrain.catch(() => controller.abort());
  const [buffer, img, mask] = await Promise.all([
    terrain,
    composeImage(job, b, signal),
    composeMask(job, b, signal),
  ]);
  const qm = decodeQuantizedMesh(buffer);
  const geometry = buildTileGeometry(qm, job.key);
  return {
    geometry,
    u: qm.u,
    v: qm.v,
    image: img.image,
    mask,
    maskSize: job.maskSize,
    missingImagery: img.missing,
  };
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    jobs.get(msg.id)?.abort();
    return;
  }
  const controller = new AbortController();
  jobs.set(msg.id, controller);
  let reply: WorkerResponse;
  const transfer: Transferable[] = [];
  try {
    const result = await build(msg.job, controller);
    reply = { id: msg.id, ok: true, result };
    const g = result.geometry;
    transfer.push(
      g.positions.buffer,
      g.normals.buffer,
      g.uvs.buffer,
      g.elevations.buffer,
      g.indices.buffer,
      g.heights.buffer,
      result.u.buffer,
      result.v.buffer,
      result.mask.buffer,
      result.image,
    );
  } catch (err) {
    const reason =
      err instanceof Absent ? 'absent' : controller.signal.aborted ? 'cancelled' : 'error';
    reply = { id: msg.id, ok: false, reason, error: reason === 'error' ? String(err) : undefined };
  }
  jobs.delete(msg.id);
  self.postMessage(reply, transfer);
};
