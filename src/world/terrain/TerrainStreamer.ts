import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  ClampToEdgeWrapping,
  NoColorSpace,
  RGBAFormat,
  RGFormat,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
} from 'three/webgpu';
import {
  type GeoBounds,
  LocalFrame,
  SWISSIMAGE_MAX_ZOOM,
  type TerrainLayer,
  TerrainSurface,
  type TileKey,
  VECTOR_TILE_MAX_ZOOM,
  fillTemplate,
  imageryZoomFor,
  tileId,
} from '@geo';
import type { DeviceClass } from '../layers';
import { GROUND_SETTINGS, type GroundSettings } from './groundSettings';
import { tileToRenderMatrix } from './placement';
import type { GroundOutput, TileOutput } from './protocol';
import { Quadtree, type TileNode, type TileProvider, type ViewState } from './Quadtree';
import type { TerrainMaterials, TerrainNodeMaterial } from './terrainMaterial';
import { type JobHandle, type JobResult, WorkerPool } from './WorkerPool';

/** Limits of the streamer; filled from WorldQuality. */
export interface StreamerSettings {
  viewDistance: number;
  maxTexelPx: number;
  textureSize: number;
  maskSize: number;
  maxTiles: number;
  uploadsPerFrame: number;
  tilesInFlight: number;
  workers: number;
  maxZoom: number;
  anisotropy: number;
  /** Picks the ground preset (lights, roads, horizon); desktop if not given. */
  device?: DeviceClass;
}

/** Switzerland: inside, tiles refine down to the full zoom; outside, they stay coarse. */
export const DETAIL_BOUNDS: GeoBounds = { west: 5.9, south: 45.8, east: 10.5, north: 47.85 };
const MAX_ZOOM_OUTSIDE = 11;
/** Root tiles at zoom 8 (0.7°) from 5.0° to 11.0° E and 45.2° to 48.4° N. */
const ROOT_ZOOM = 8;
const ROOT_RANGE = { x0: 263, x1: 271, y0: 192, y1: 196 };
/** A download failing this often (not 403/404) is given up for the session. */
const MAX_ERRORS = 3;
/** Behind a loading screen this many times the tiles are built at once. */
const HURRY_IN_FLIGHT = 2;

let blank: OffscreenCanvas | undefined;
/** A 1 x 1 image that can always be uploaded. */
function blankPixel(): OffscreenCanvas {
  if (!blank) {
    blank = new OffscreenCanvas(1, 1);
    blank.getContext('2d');
  }
  return blank;
}

/** Sampling of the orthophoto: sRGB, mipmapped, anisotropic. */
export function tileImageTexture(t: Texture, anisotropy: number): Texture {
  t.colorSpace = SRGBColorSpace;
  t.flipY = false;
  t.anisotropy = anisotropy;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** The land-cover mask as a texture: linear data, mipmapped. */
export function tileMaskTexture(data: Uint8Array, size: number): DataTexture {
  const t = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  t.colorSpace = NoColorSpace;
  t.flipY = false;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * The ground texture of a tile (lights, road field) with the mip chain the worker computed:
 * the lamp channels must be averaged as energy, which the GPU's own mipmaps would not do.
 */
export function tileGroundTexture(g: GroundOutput): DataTexture {
  const top = g.mips[0]!;
  const t = new DataTexture(
    top.data,
    top.width,
    top.height,
    g.channels === 4 ? RGBAFormat : RGFormat,
    UnsignedByteType,
  );
  t.mipmaps = g.mips;
  t.colorSpace = NoColorSpace;
  t.flipY = false;
  t.generateMipmaps = false;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Horizon angles of a tile (horizon.ts): tiny, smooth, no mipmaps. */
export function tileHorizonTexture(g: GroundOutput): DataTexture {
  const t = new DataTexture(
    g.horizon,
    g.horizonSize * 2,
    g.horizonSize,
    RGBAFormat,
    UnsignedByteType,
  );
  t.colorSpace = NoColorSpace;
  t.flipY = false;
  t.generateMipmaps = false;
  t.minFilter = LinearFilter;
  t.magFilter = LinearFilter;
  t.wrapS = t.wrapT = ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

/** A loaded tile: what the GPU draws and what height queries read. */
export interface TileData {
  mesh: Mesh;
  /** The tile's own tangent frame; its vertices are relative to it. */
  frame: LocalFrame;
  image: Texture;
  mask: DataTexture;
  ground: DataTexture;
  horizon: DataTexture;
  maskBytes: Uint8Array;
  maskSize: number;
  surfaceArgs: [Uint16Array, Uint16Array, Float32Array, Uint16Array | Uint32Array];
  surface?: TerrainSurface;
  triangles: number;
  /** GPU bytes of the textures (with mipmaps) and buffers. */
  bytes: number;
}

interface Pending {
  handle: JobHandle;
  errors: number;
}

interface Upload {
  node: TileNode<TileData>;
  out: TileOutput;
}

/**
 * Streams terrain tiles: quadtree selection, worker jobs (download, decode, compose), a limited
 * number of GPU uploads per frame, eviction to a tile budget, and placement in the render frame.
 */
export class TerrainStreamer implements TileProvider<TileData> {
  readonly group = new Group();
  readonly tree: Quadtree<TileData>;
  private readonly pool: WorkerPool;
  private readonly jobs = new Map<TileNode<TileData>, Pending>();
  private readonly errors = new Map<TileNode<TileData>, number>();
  private readonly uploads: Upload[] = [];
  private frame: LocalFrame;
  private readonly ground: GroundSettings;
  /** Behind a loading screen: more downloads at once, and no limit on uploads per frame. */
  hurry = false;
  /** Counters for the demo and the performance report. */
  readonly counters = {
    uploaded: 0,
    evicted: 0,
    failed: 0,
    absent: 0,
    cancelled: 0,
    /** Tiles built by the workers, their summed wall time and CPU time (ms). */
    built: 0,
    buildMs: 0,
    bakeMs: 0,
    /** Bytes of the ground data (lights, roads, horizon) of all tiles built, and lamps baked. */
    groundBytes: 0,
    lamps: 0,
    /** Summed CPU time of the ground's parts in the workers, ms. */
    lightsMs: 0,
    roadsMs: 0,
    horizonMs: 0,
    mipsMs: 0,
  };

  constructor(
    private readonly layer: TerrainLayer,
    frame: LocalFrame,
    private readonly settings: StreamerSettings,
    private readonly materials: TerrainMaterials,
  ) {
    this.frame = frame;
    this.group.name = 'Terrain';
    this.ground = GROUND_SETTINGS[settings.device ?? 'desktop'];
    materials.configure(this.ground);
    const roots: TileKey[] = [];
    for (let y = ROOT_RANGE.y0; y <= ROOT_RANGE.y1; y++)
      for (let x = ROOT_RANGE.x0; x <= ROOT_RANGE.x1; x++) roots.push({ z: ROOT_ZOOM, x, y });
    this.tree = new Quadtree<TileData>(
      {
        roots,
        maxZoom: Math.min(settings.maxZoom, layer.maxZoom),
        maxZoomOutside: MAX_ZOOM_OUTSIDE,
        detailBounds: DETAIL_BOUNDS,
        texelsPerTile: settings.textureSize,
        maxTexelPx: settings.maxTexelPx,
        viewDistance: settings.viewDistance,
        staleFrames: 20,
      },
      this,
    );
    this.pool = new WorkerPool(
      () => new Worker(new URL('./tile.worker.ts', import.meta.url), { type: 'module' }),
      settings.workers,
      settings.tilesInFlight,
    );
  }

  get pendingUploads() {
    return this.uploads.length;
  }

  get queued() {
    return this.pool.queued;
  }

  get inFlight() {
    return this.pool.inFlight;
  }

  update(view: ViewState) {
    this.tree.eager = this.hurry;
    this.tree.update(view);
    for (const [node, job] of this.jobs) job.handle.setPriority(node.priority);

    if (this.uploads.length > 1) this.uploads.sort((a, b) => b.node.priority - a.node.priority);
    this.pool.limit = this.settings.tilesInFlight * (this.hurry ? HURRY_IN_FLIGHT : 1);
    const uploads = this.hurry ? Infinity : this.settings.uploadsPerFrame;
    for (let i = 0; i < uploads && this.uploads.length > 0; i++) this.upload(this.uploads.shift()!);

    for (const node of this.tree.evictionCandidates(this.settings.maxTiles)) this.free(node);

    for (const node of this.tree.ready) node.data!.mesh.visible = false;
    for (const node of this.tree.rendered) node.data!.mesh.visible = true;
  }

  /** The render frame moved: re-place every tile (vertices stay, only matrices change). */
  setFrame(frame: LocalFrame) {
    this.frame = frame;
    for (const node of this.tree.ready) this.place(node.data!);
  }

  // ---- TileProvider ----

  request(node: TileNode<TileData>) {
    const { z, x, y } = node.key;
    const s = this.settings;
    // Coarse tiles far away are seen small: half the texture size is plenty there.
    const imageSize = z <= 9 ? Math.min(256, s.textureSize) : s.textureSize;
    const vectorZoom = Math.min(VECTOR_TILE_MAX_ZOOM, Math.max(8, z + 1));
    const pending: Pending = { handle: undefined!, errors: this.errors.get(node) ?? 0 };
    pending.handle = this.pool.submit(
      {
        key: node.key,
        terrainUrl: fillTemplate(this.layer.template, z, x, y),
        imageZoom: imageryZoomFor(z, imageSize, SWISSIMAGE_MAX_ZOOM),
        imageSize,
        maskSize: z <= 9 ? Math.min(128, s.maskSize) : s.maskSize,
        vectorZoom,
        ground: {
          channels: this.ground.groundChannels,
          roads: z >= this.ground.roadsMinZoom,
          rows: z >= this.ground.roadsMinZoom,
          horizonSize: this.ground.horizonSize,
          context: this.ground.horizonContext,
          terrainTemplate: this.layer.template,
        },
      },
      node.priority,
      (r) => this.onResult(node, pending, r),
    );
    this.jobs.set(node, pending);
  }

  cancel(node: TileNode<TileData>) {
    const job = this.jobs.get(node);
    if (!job) return;
    this.jobs.delete(node);
    job.handle.cancel();
    this.counters.cancelled++;
  }

  private onResult(node: TileNode<TileData>, pending: Pending, r: JobResult) {
    // A cancelled or superseded job: drop what it brought.
    if (this.jobs.get(node) !== pending) {
      if (r.ok) r.result.image.close();
      return;
    }
    this.jobs.delete(node);
    if (r.ok) {
      this.errors.delete(node);
      this.counters.built++;
      this.counters.buildMs += r.result.timing.totalMs;
      this.counters.bakeMs += r.result.timing.cpuMs;
      const g = r.result.ground;
      this.counters.groundBytes +=
        g.horizon.byteLength + g.mips.reduce((sum, m) => sum + m.data.byteLength, 0);
      this.counters.lamps += g.lamps;
      this.counters.lightsMs += g.timing.lights;
      this.counters.roadsMs += g.timing.roads;
      this.counters.horizonMs += g.timing.horizon;
      this.counters.mipsMs += g.timing.mips;
      this.uploads.push({ node, out: r.result });
      return;
    }
    if (r.reason === 'absent') {
      // Outside the data coverage: the parent stays the leaf, no error.
      this.counters.absent++;
      this.tree.markFailed(node);
    } else if (r.reason === 'error') {
      this.counters.failed++;
      const errors = pending.errors + 1;
      this.errors.set(node, errors);
      if (errors >= MAX_ERRORS) {
        console.warn(`terrain tile ${tileId(node.key)} failed:`, r.error);
        this.tree.markFailed(node);
      } else this.tree.markIdle(node);
    } else this.tree.markIdle(node);
  }

  // ---- GPU ----

  private upload({ node, out }: Upload) {
    // A load cancelled after its data arrived is still good data: use it. Only a node that
    // meanwhile became ready or failed has no use for it.
    if (node.state === 'ready' || node.state === 'failed') {
      out.image.close();
      return;
    }
    const g = out.geometry;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(g.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(g.normals, 3));
    geometry.setAttribute('uv', new BufferAttribute(g.uvs, 2));
    geometry.setAttribute('elevation', new BufferAttribute(g.elevations, 1));
    geometry.setIndex(new BufferAttribute(g.indices, 1));

    const image = tileImageTexture(new Texture(out.image), this.settings.anisotropy);
    // The GPU keeps its own copy; free the decoded bitmap once it is uploaded.
    image.name = `photo ${tileId(node.key)}`;
    image.onUpdate = () => out.image.close();

    const mask = tileMaskTexture(out.mask, out.maskSize);
    const ground = tileGroundTexture(out.ground);
    const horizon = tileHorizonTexture(out.ground);

    const material = this.materials.create(image, mask, ground, horizon, out.ground.lightScale);
    const mesh = new Mesh(geometry, material);
    mesh.name = tileId(node.key);
    mesh.matrixAutoUpdate = false;
    // The quadtree already culled; three's own test would only cost time.
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.visible = false;

    const imageSize = out.image.width;
    const bytes =
      Math.round(imageSize * imageSize * 4 * 1.33) +
      Math.round(out.maskSize * out.maskSize * 4 * 1.33) +
      out.ground.mips.reduce((sum, m) => sum + m.data.byteLength, 0) +
      out.ground.horizon.byteLength +
      g.positions.byteLength +
      g.normals.byteLength +
      g.uvs.byteLength +
      g.elevations.byteLength +
      g.indices.byteLength;
    const data: TileData = {
      mesh,
      frame: new LocalFrame(g.origin.lon, g.origin.lat, g.origin.h),
      image,
      mask,
      ground,
      horizon,
      maskBytes: out.mask,
      maskSize: out.maskSize,
      surfaceArgs: [out.u, out.v, g.heights, g.indices.subarray(0, g.surfaceIndexCount)],
      triangles: g.indices.length / 3,
      bytes,
    };
    node.data = data;
    this.place(data);
    this.group.add(mesh);
    this.counters.uploaded++;
    this.tree.markReady(node, g.minHeight, g.maxHeight);
  }

  /** Model matrix: the tile frame's axes and origin expressed in the render frame. */
  private place(d: TileData) {
    tileToRenderMatrix(d.frame, this.frame, d.mesh.matrix.elements);
    d.mesh.matrixWorldNeedsUpdate = true;
  }

  private free(node: TileNode<TileData>) {
    const d = node.data;
    if (d) {
      this.group.remove(d.mesh);
      d.mesh.geometry.dispose();
      (d.mesh.material as TerrainNodeMaterial).dispose();
      d.image.dispose();
      // The renderer shares one shader among all tiles and keeps the textures of the tile it
      // built it with as a template; it uploads them again for every new tile, also after
      // that first tile is gone. Its photo is closed by then: leave a pixel in its place.
      d.image.image = blankPixel();
      d.mask.dispose();
      d.ground.dispose();
      d.horizon.dispose();
      this.counters.evicted++;
    }
    this.tree.markEvicted(node);
  }

  /** Height surface of a loaded tile, built on first use. */
  surfaceOf(node: TileNode<TileData>): TerrainSurface {
    const d = node.data!;
    d.surface ??= new TerrainSurface(node.bounds, ...d.surfaceArgs);
    return d.surface;
  }

  /** GPU memory, triangles and draw calls of what is loaded and drawn. */
  stats() {
    let bytes = 0;
    let triangles = 0;
    for (const n of this.tree.ready) bytes += n.data!.bytes;
    for (const n of this.tree.rendered) triangles += n.data!.triangles;
    return {
      gpuBytes: bytes,
      triangles,
      drawn: this.tree.rendered.length,
      loaded: this.tree.ready.size,
    };
  }

  dispose() {
    this.pool.dispose();
    for (const node of [...this.tree.ready]) this.free(node);
    for (const u of this.uploads) u.out.image.close();
    this.uploads.length = 0;
  }
}
