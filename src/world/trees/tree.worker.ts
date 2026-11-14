/// <reference lib="webworker" />
import { VectorTile, type VectorTileLayer } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import {
  LocalFrame,
  QM_MAX,
  SWISSIMAGE_URL,
  TERRAIN_BASE,
  TerrainSurface,
  type TileKey,
  VECTOR_TILE_URL,
  decodeQuantizedMesh,
  fillTemplate,
  geoTileAt,
  geoTileBounds,
  mercatorLat,
  mercatorLon,
  parseTerrainLayer,
  tileId,
  vectorTilePointToLonLat,
} from '@geo';
import { CELLS, CHUNK_ZOOM, SCATTER_GRID, type ChunkKey } from './chunks';
import { photoToAlbedo, srgbToLinear } from './photo';
import {
  type CellData,
  type ChunkJob,
  type ChunkOutput,
  type FormData,
  STRIDE,
  type TreeWorkerRequest,
  type TreeWorkerResponse,
} from './protocol';
import type { Pt } from './raster';
import { type ScatterInput, scatter } from './scatter';
import { Cover, FORM_COUNT, SPECIES_COUNT, formOf } from './species';

declare const self: DedicatedWorkerGlobalScope;

/** Raster cells per chunk side: about 1.6 m, finer than a crown. */
const RASTER = 1024;
/** Terrain zoom for the elevations that pick species (about 40 m between samples). */
const ELEVATION_ZOOM = 12;
/** Orthophoto zoom for the tree colours: about 3.3 m per pixel, 2 x 2 tiles per chunk. */
const PHOTO_ZOOM = CHUNK_ZOOM + 1;
const EARTH_CIRCUMFERENCE = 40_075_017;

const jobs = new Map<number, AbortController>();
/**
 * Shared downloads are not tied to one job's signal: a cancelled job's tile is still good for
 * the next job that needs it (a neighbour, or the same chunk at another level).
 */
const shared = new AbortController().signal;

class Cancelled extends Error {}

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

/** Small LRU of promises shared by the jobs of this worker (neighbours share terrain tiles). */
function lru<T>(size: number) {
  const map = new Map<string, Promise<T>>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    let p = map.get(key);
    if (p) map.delete(key);
    else {
      const loading = load();
      p = loading;
      // A failed download is tried again by the next job, not remembered.
      loading.catch(() => {
        if (map.get(key) === loading) map.delete(key);
      });
    }
    map.set(key, p);
    if (map.size > size) map.delete(map.keys().next().value!);
    return p;
  };
}

// ---- Elevation from swisstopo's terrain ----

let terrainTemplate: Promise<string | null> | undefined;
function getTerrainTemplate(job: ChunkJob): Promise<string | null> {
  if (job.terrainTemplate) return Promise.resolve(job.terrainTemplate);
  terrainTemplate ??= fetch(TERRAIN_BASE + 'layer.json')
    .then(async (r) => (r.ok ? parseTerrainLayer(await r.json()).template : null))
    .catch(() => {
      terrainTemplate = undefined;
      return null;
    });
  return terrainTemplate;
}

const surfaces = lru<TerrainSurface | null>(12);
function surface(template: string, key: TileKey): Promise<TerrainSurface | null> {
  return surfaces(tileId(key), async () => {
    try {
      const res = await fetchRetry(fillTemplate(template, key.z, key.x, key.y), shared);
      if (!res.ok) return null;
      const qm = decodeQuantizedMesh(await res.arrayBuffer());
      const heights = new Float32Array(qm.vertexCount);
      const span = qm.maxHeight - qm.minHeight;
      for (let i = 0; i < qm.vertexCount; i++)
        heights[i] = qm.minHeight + (qm.h[i]! / QM_MAX) * span;
      // Sea-level heights: the plane intersection treats them as heights above the ellipsoid,
      // which shifts nothing that matters for choosing species.
      return new TerrainSurface(geoTileBounds(key), qm.u, qm.v, heights, qm.indices);
    } catch {
      return null;
    }
  });
}

// ---- Vector tile ----

const vectorTiles = lru<VectorTile | null>(8);
function vectorTile(key: ChunkKey) {
  return vectorTiles(`${key.x}/${key.y}`, () =>
    fetchRetry(fillTemplate(VECTOR_TILE_URL, CHUNK_ZOOM, key.x, key.y), shared).then(
      async (res) => {
        // Outside the coverage there is no tile: an empty chunk, not an error.
        if (res.status === 403 || res.status === 404 || res.status === 204) return null;
        if (!res.ok) throw new Error(`vector tile HTTP ${res.status}`);
        return new VectorTile(new PbfReader(new Uint8Array(await res.arrayBuffer())));
      },
    ),
  );
}

/** Half widths (metres) of what is cleared around a line, by class (trunk plus a crown). */
const ROAD_HALF_WIDTH: Record<string, number> = {
  motorway: 15,
  trunk: 10,
  primary: 8,
  secondary: 7,
  tertiary: 6,
  minor: 4.5,
  service: 3.5,
  track: 3,
  path: 1,
  footway: 1,
  cycleway: 1.5,
  rail: 5,
  transit: 4,
  raceway: 6,
};

const COVER_OF: Record<string, Cover> = {
  forest: Cover.Forest,
  loose_forest: Cover.Loose,
  woody_plant: Cover.Woody,
  scrub: Cover.Scrub,
};

type Rings = Pt[][];

function read(
  layer: VectorTileLayer | undefined,
  each: (f: ReturnType<VectorTileLayer['feature']>) => void,
) {
  if (!layer) return;
  for (let i = 0; i < layer.length; i++) each(layer.feature(i));
}

// ---- Photo ----

const photoTiles = lru<ImageBitmap | null>(8);
function photoTile(x: number, y: number) {
  return photoTiles(`${x}/${y}`, async () => {
    try {
      const res = await fetchRetry(fillTemplate(SWISSIMAGE_URL, PHOTO_ZOOM, x, y), shared);
      if (!res.ok) return null;
      const blob = await res.blob();
      // Outside its coverage SWISSIMAGE serves blank white tiles.
      if (blob.size < 4096) return null;
      return await createImageBitmap(blob);
    } catch {
      return null;
    }
  });
}

const LINEAR = Float32Array.from({ length: 256 }, (_, i) => srgbToLinear(i));

/**
 * The chunk's orthophoto as albedo, box-filtered over 3 x 3 pixels (about 10 m: a crown and its
 * shadow), RGB per pixel, 512 x 512. Null where the imagery is missing.
 */
async function photoAlbedo(key: ChunkKey) {
  const size = 512;
  const half = size / 2;
  const tiles = await Promise.all(
    [0, 1, 2, 3].map((i) => photoTile(key.x * 2 + (i % 2), key.y * 2 + (i >> 1))),
  );
  if (tiles.every((t) => !t)) return null;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const present = new Uint8Array(4);
  tiles.forEach((t, i) => {
    if (!t) return;
    ctx.drawImage(t, (i % 2) * half, (i >> 1) * half, half, half);
    present[i] = 1;
  });
  const img = ctx.getImageData(0, 0, size, size).data;
  const lin = new Float32Array(size * size * 3);
  for (let k = 0; k < size * size; k++) {
    lin[k * 3] = LINEAR[img[k * 4]!]!;
    lin[k * 3 + 1] = LINEAR[img[k * 4 + 1]!]!;
    lin[k * 3 + 2] = LINEAR[img[k * 4 + 2]!]!;
  }
  const out = new Float32Array(size * size * 3);
  const c = [0, 0, 0];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(size - 1, Math.max(0, x + dx));
          const yy = Math.min(size - 1, Math.max(0, y + dy));
          const k = (yy * size + xx) * 3;
          r += lin[k]!;
          g += lin[k + 1]!;
          b += lin[k + 2]!;
          n++;
        }
      photoToAlbedo(r / n, g / n, b / n, c);
      const k = (y * size + x) * 3;
      out[k] = c[0]!;
      out[k + 1] = c[1]!;
      out[k + 2] = c[2]!;
    }
  return { size, rgb: out, present };
}

// ---- Build ----

async function build(job: ChunkJob, signal: AbortSignal): Promise<ChunkOutput | null> {
  const t0 = performance.now();
  const key = job.key;
  const extentGuess = 4096;
  const midLat = mercatorLat(key.y + 0.5, CHUNK_ZOOM);
  const midLon = mercatorLon(key.x + 0.5, CHUNK_ZOOM);

  const [vt, photo, template] = await Promise.all([
    vectorTile(key),
    photoAlbedo(key).catch(() => null),
    getTerrainTemplate(job),
  ]);
  if (signal.aborted) throw new Cancelled();
  if (!vt) return null;

  const landcover = vt.layers['landcover'];
  const extent = landcover?.extent ?? extentGuess;
  const toTile = (layer: VectorTileLayer, p: Pt): Pt =>
    layer.extent === extent
      ? p
      : { x: (p.x * extent) / layer.extent, y: (p.y * extent) / layer.extent };

  const covers: ScatterInput['covers'] = [];
  read(landcover, (f) => {
    if (f.type !== 3 || f.properties.class !== 'wood') return;
    const cover = COVER_OF[String(f.properties.subclass)];
    if (cover) covers.push({ cover, rings: f.loadGeometry() as Rings });
  });
  const metresPerUnit =
    (EARTH_CIRCUMFERENCE * Math.cos((midLat * Math.PI) / 180)) / 2 ** CHUNK_ZOOM / extent;
  const blocks: Rings[] = [];
  const lines: ScatterInput['lines'] = [];
  const addPolys = (name: string, match: (p: Record<string, unknown>) => boolean) => {
    const layer = vt.layers[name];
    read(layer, (f) => {
      if (f.type === 3 && match(f.properties))
        blocks.push((f.loadGeometry() as Rings).map((r) => r.map((p) => toTile(layer!, p))));
    });
  };
  const addLines = (name: string, radius: (p: Record<string, unknown>) => number) => {
    const layer = vt.layers[name];
    read(layer, (f) => {
      if (f.type !== 2) return;
      const r = radius(f.properties);
      if (r <= 0) return;
      for (const line of f.loadGeometry() as Rings)
        lines.push({ line: line.map((p) => toTile(layer!, p)), radius: r / metresPerUnit });
    });
  };
  addPolys('water', () => true);
  addPolys('building', () => true);
  addPolys('aeroway', () => true);
  addPolys('landuse', (p) =>
    ['parking', 'pitch', 'swimming_pool', 'sports', 'quarry'].includes(String(p.class)),
  );
  addLines('transportation', (p) => ROAD_HALF_WIDTH[String(p.class)] ?? 2.5);
  addLines('waterway', (p) => {
    const w = Number(p.width);
    return (Number.isFinite(w) && w > 0 ? w / 2 : 1.5) + 1;
  });
  addLines('aeroway', (p) => (p.class === 'runway' ? 30 : p.class === 'taxiway' ? 15 : 0));

  const points: Pt[] = [];
  const ptLayer = vt.layers['landcover_pt'];
  read(ptLayer, (f) => {
    if (f.type !== 1 || f.properties.class !== 'tree') return;
    for (const ring of f.loadGeometry() as Rings)
      for (const p of ring) points.push(toTile(ptLayer!, p));
  });

  // Elevations: the terrain tiles under the chunk, loaded before the scatter starts.
  const ll = { lon: 0, lat: 0 };
  const geoKeys = new Map<string, TileKey>();
  for (const [u, v] of [
    [0, 0],
    [extent, 0],
    [0, extent],
    [extent, extent],
    [extent / 2, extent / 2],
  ] as const) {
    vectorTilePointToLonLat({ z: CHUNK_ZOOM, ...key }, extent, u, v, ll);
    const k = geoTileAt(ll.lon, ll.lat, ELEVATION_ZOOM);
    geoKeys.set(tileId(k), k);
  }
  const loaded = template
    ? await Promise.all([...geoKeys.values()].map((k) => surface(template, k)))
    : [];
  if (signal.aborted) throw new Cancelled();
  const surfaceList = loaded.filter((s): s is TerrainSurface => !!s);
  const tileKey = { z: CHUNK_ZOOM, ...key };
  const elevation = (u: number, v: number) => {
    vectorTilePointToLonLat(tileKey, extent, u, v, ll);
    for (const s of surfaceList) {
      const hit = s.query(ll.lon, ll.lat);
      if (hit) return hit.height;
    }
    return undefined;
  };

  const photoFn = photo
    ? (u: number, v: number, out: number[]) => {
        const px = Math.min(photo.size - 1, Math.max(0, Math.floor((u / extent) * photo.size)));
        const py = Math.min(photo.size - 1, Math.max(0, Math.floor((v / extent) * photo.size)));
        const quadrant = (px >= photo.size / 2 ? 1 : 0) + (py >= photo.size / 2 ? 2 : 0);
        if (!photo.present[quadrant]) return false;
        const k = (py * photo.size + px) * 3;
        out[0] = photo.rgb[k]!;
        out[1] = photo.rgb[k + 1]!;
        out[2] = photo.rgb[k + 2]!;
        return true;
      }
    : undefined;

  const s = scatter({
    tile: key,
    extent,
    grid: SCATTER_GRID,
    rasterSize: RASTER,
    metresPerUnit,
    covers,
    blocks,
    lines,
    points,
    elevation,
    photo: photoFn,
  });

  // Into the chunk's frame, split by form, thinned to the job's share, sorted by rank.
  const frame = new LocalFrame(midLon, midLat, 0);
  const p = { x: 0, y: 0, z: 0 };
  const order: number[][] = Array.from({ length: FORM_COUNT }, () => []);
  for (let i = 0; i < s.count; i++)
    if (s.rank[i]! < job.keep) order[formOf(s.species[i]!)]!.push(i);
  const heightScale = 1 + (job.crownScale - 1) * 0.4;
  const species = new Array<number>(SPECIES_COUNT).fill(0);
  const forms = order.map((list): FormData => {
    list.sort((a, b) => s.rank[a]! - s.rank[b]!);
    const data = new Float32Array(list.length * STRIDE);
    const cellOf = new Uint8Array(list.length);
    list.forEach((i, n) => {
      vectorTilePointToLonLat(tileKey, extent, s.u[i]!, s.v[i]!, ll);
      frame.fromGeodetic(ll.lon, ll.lat, 0, p);
      const o = n * STRIDE;
      data[o] = p.x;
      data[o + 1] = p.y;
      data[o + 2] = p.z;
      data[o + 3] = s.rank[i]! / job.share;
      data[o + 4] = s.height[i]! * heightScale;
      data[o + 5] = s.width[i]! * job.crownScale;
      data[o + 6] = s.rotation[i]!;
      data[o + 7] = s.species[i]! + s.seed[i]! * 0.98;
      data[o + 8] = s.photo[i * 3]!;
      data[o + 9] = s.photo[i * 3 + 1]!;
      data[o + 10] = s.photo[i * 3 + 2]!;
      // Edge distance (whole metres) and photo brightness share one float: see protocol.ts.
      data[o + 11] = Math.min(31, Math.floor(s.edge[i]!)) * 4 + Math.min(3.99, s.bright[i]!);
      const cx = Math.min(CELLS - 1, Math.floor((s.u[i]! / extent) * CELLS));
      const cy = Math.min(CELLS - 1, Math.floor((s.v[i]! / extent) * CELLS));
      cellOf[n] = cy * CELLS + cx;
      species[s.species[i]!]!++;
    });
    // The near and mid meshes draw per cell: split here, off the main thread.
    const cells: CellData[] = [];
    if (job.keep >= job.share) {
      const lists: number[][] = Array.from({ length: CELLS * CELLS }, () => []);
      for (let n = 0; n < list.length; n++) lists[cellOf[n]!]!.push(n);
      for (const members of lists) {
        if (members.length === 0) continue;
        const cd = new Float32Array(members.length * STRIDE);
        const cell: CellData = {
          data: cd,
          index: Uint32Array.from(members),
          minX: Infinity,
          maxX: -Infinity,
          minZ: Infinity,
          maxZ: -Infinity,
        };
        members.forEach((src, k) => {
          cd.set(data.subarray(src * STRIDE, (src + 1) * STRIDE), k * STRIDE);
          const x = data[src * STRIDE]!;
          const z = data[src * STRIDE + 2]!;
          cell.minX = Math.min(cell.minX, x);
          cell.maxX = Math.max(cell.maxX, x);
          cell.minZ = Math.min(cell.minZ, z);
          cell.maxZ = Math.max(cell.maxZ, z);
        });
        cells.push(cell);
      }
    }
    return { data, cells, count: list.length };
  });

  const west = frame.fromGeodetic(mercatorLon(key.x, CHUNK_ZOOM), midLat, 0, { x: 0, y: 0, z: 0 });
  const north = frame.fromGeodetic(midLon, mercatorLat(key.y, CHUNK_ZOOM), 0, { x: 0, y: 0, z: 0 });
  return {
    origin: { lon: midLon, lat: midLat },
    halfX: Math.abs(west.x),
    halfZ: Math.abs(north.z),
    forms: [forms[0]!, forms[1]!],
    stats: {
      trees: forms[0]!.count + forms[1]!.count,
      singles: s.stats.singles,
      candidates: s.stats.candidates,
      forestShare: s.stats.forestCells / (RASTER * RASTER),
      photo: !!photo,
      elevation: surfaceList.length > 0,
      ms: performance.now() - t0,
      species,
    },
  };
}

self.onmessage = async (e: MessageEvent<TreeWorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    jobs.get(msg.id)?.abort();
    return;
  }
  const controller = new AbortController();
  jobs.set(msg.id, controller);
  let reply: TreeWorkerResponse;
  const transfer: Transferable[] = [];
  try {
    const result = await build(msg.job, controller.signal);
    if (!result) reply = { id: msg.id, ok: false, reason: 'empty' };
    else {
      reply = { id: msg.id, ok: true, result };
      for (const f of result.forms) {
        transfer.push(f.data.buffer);
        for (const c of f.cells) transfer.push(c.data.buffer, c.index.buffer);
      }
    }
  } catch (err) {
    const cancelled = controller.signal.aborted || err instanceof Cancelled;
    reply = {
      id: msg.id,
      ok: false,
      reason: cancelled ? 'cancelled' : 'error',
      error: cancelled ? undefined : String(err),
    };
  }
  jobs.delete(msg.id);
  self.postMessage(reply, transfer);
};
