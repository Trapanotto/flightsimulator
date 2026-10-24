import {
  MAX_IMAGERY_ZOOM,
  MIN_IMAGERY_ZOOM,
} from '../geo/constants';
import {
  imageryPixel,
  imageryTileForLonLat,
  type GeoBounds,
} from '../geo/tiles';
import type {
  ImageryRequest,
  ImageryWorkerResponse,
} from '../terrain/workerTypes';

const scope = self as unknown as DedicatedWorkerGlobalScope;

const WMTS_BASE =
  'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage-product/default/current/3857';
const MAX_CACHE = 260;

const imageCache = new Map<string, ImageBitmap>();
const inFlight = new Map<string, Promise<ImageBitmap | null>>();

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function tileCount(bounds: GeoBounds, z: number): number {
  const nw = imageryTileForLonLat(bounds.west, bounds.north, z);
  const se = imageryTileForLonLat(bounds.east, bounds.south, z);
  return (
    (Math.abs(se.x - nw.x) + 1) * (Math.abs(se.y - nw.y) + 1)
  );
}

function chooseImageryZoom(bounds: GeoBounds, terrainZ: number): number {
  let z = clamp(terrainZ + 1, MIN_IMAGERY_ZOOM, MAX_IMAGERY_ZOOM);
  while (z > MIN_IMAGERY_ZOOM && tileCount(bounds, z) > 9) {
    z--;
  }
  return z;
}

function touch(key: string, bitmap: ImageBitmap) {
  imageCache.delete(key);
  imageCache.set(key, bitmap);
  while (imageCache.size > MAX_CACHE) {
    const oldest = imageCache.keys().next().value;
    if (!oldest) break;
    const value = imageCache.get(oldest);
    value?.close();
    imageCache.delete(oldest);
  }
}

async function loadImageryTile(
  z: number,
  x: number,
  y: number,
): Promise<ImageBitmap | null> {
  const key = `${z}/${x}/${y}`;
  const cached = imageCache.get(key);
  if (cached) {
    touch(key, cached);
    return cached;
  }

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const response = await fetch(`${WMTS_BASE}/${z}/${x}/${y}.jpeg`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return null;
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      touch(key, bitmap);
      return bitmap;
    } catch {
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

async function compose(request: ImageryRequest): Promise<ImageBitmap> {
  const { bounds, z } = request;
  const imageryZ = chooseImageryZoom(bounds, z);

  const p0 = imageryPixel(bounds.west, bounds.north, imageryZ);
  const p1 = imageryPixel(bounds.east, bounds.south, imageryZ);
  const width = Math.max(1, p1.x - p0.x);
  const height = Math.max(1, p1.y - p0.y);

  // Distant tiles do not need 512² textures; this cuts GPU memory in half for
  // the large, far-away part of the scene.
  const canvasSize = z >= 13 ? 512 : 256;
  const canvas = new OffscreenCanvas(canvasSize, canvasSize);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#3a4a3a';
  ctx.fillRect(0, 0, canvasSize, canvasSize);

  const nw = imageryTileForLonLat(bounds.west, bounds.north, imageryZ);
  const se = imageryTileForLonLat(bounds.east, bounds.south, imageryZ);
  const x0 = Math.min(nw.x, se.x);
  const x1 = Math.max(nw.x, se.x);
  const y0 = Math.min(nw.y, se.y);
  const y1 = Math.max(nw.y, se.y);

  const scaleX = canvasSize / width;
  const scaleY = canvasSize / height;

  const tiles: Array<{
    tx: number;
    ty: number;
    bitmap: ImageBitmap | null;
  }> = [];

  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      tiles.push({ tx, ty, bitmap: await loadImageryTile(imageryZ, tx, ty) });
    }
  }

  // Draw in a deterministic order so neighbouring edges do not flicker.
  for (const { tx, ty, bitmap } of tiles) {
    if (!bitmap) continue;
    const dx = (tx * 256 - p0.x) * scaleX;
    const dy = (ty * 256 - p0.y) * scaleY;
    ctx.drawImage(bitmap, dx, dy, 256 * scaleX, 256 * scaleY);
  }

  return canvas.transferToImageBitmap();
}

scope.onmessage = async (event: MessageEvent<ImageryRequest>) => {
  const request = event.data;
  if (request.type !== 'compose') return;

  try {
    const bitmap = await compose(request);
    const message: ImageryWorkerResponse = {
      type: 'image',
      id: request.id,
      bitmap,
      imageryZ: chooseImageryZoom(request.bounds, request.z),
    };
    scope.postMessage(message, [bitmap]);
  } catch (error) {
    const message: ImageryWorkerResponse = {
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    };
    scope.postMessage(message);
  }
};
