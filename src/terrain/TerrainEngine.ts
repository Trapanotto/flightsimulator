import {
  BufferAttribute,
  BufferGeometry,
  type Frustum,
  Group,
  Mesh,
  type MeshLambertMaterial,
  SRGBColorSpace,
  Sphere,
  Texture,
  Vector3,
} from 'three';
import { type JobHandle, WorkerPool } from '../core/WorkerPool';
import type { EnuFrame } from '../geo/ellipsoid';
import { tileId } from '../geo/tiles';
import { Quadtree, type QuadtreeOptions, type TileNode, type TileProvider } from './Quadtree';
import type { AtmosphereUniforms } from '../render/Atmosphere';
import { SWISSIMAGE_TEMPLATE, type TerrainSource } from './sources';
import { type TerrainLook, createTerrainMaterial, setTerrainDefines } from './terrainMaterial';
import type { ImageryJob, ImageryResult, TerrainJob, TerrainResult } from './workerTypes';

export interface TerrainSettings {
  /** Screen-space error threshold in pixels. Lower = more detail. */
  tau: number;
  maxZoom: number;
  /** Max tiles kept on the GPU (each ≈ 1.4 MB at 512 px). */
  maxTiles: number;
  /** New tiles uploaded to the GPU per frame (limits frame spikes). */
  uploadsPerFrame: number;
}

/** Quality "medium": ~165 draw calls and ~310 tiles in memory in low flight (measured in tests). */
export const DEFAULT_TERRAIN: TerrainSettings = {
  tau: 6,
  maxZoom: 15,
  maxTiles: 400,
  uploadsPerFrame: 4,
};

/** Switzerland plus a margin; outside, terrain stays coarse (no SWISSIMAGE coverage). */
const SWISS_BOUNDS = { west: 5.85, south: 45.75, east: 10.6, north: 47.9 };
/** Zoom 7 roots over Switzerland: 4 x 3 tiles of 1.4°. */
const ROOTS = { z: 7, x0: 132, x1: 135, y0: 96, y1: 98 };

interface Loaded {
  node: TileNode;
  mesh: TerrainResult;
  img: ImageryResult;
}

interface TileGpu {
  mesh: Mesh;
  /** Tile centre relative to the base frame origin (double precision). */
  offset: Vector3;
}

/**
 * Streaming terrain: quadtree LOD + worker downloads + GPU upload budget + floating origin.
 */
export class TerrainEngine implements TileProvider {
  readonly group = new Group();
  readonly tree: Quadtree;
  private readonly terrainPool: WorkerPool<TerrainJob, TerrainResult>;
  private readonly imageryPool: WorkerPool<ImageryJob, ImageryResult>;
  private readonly jobs = new Map<
    TileNode,
    { terrain: JobHandle<TerrainResult>; imagery: JobHandle<ImageryResult>; cancelled: boolean }
  >();
  private readonly gpu = new Map<TileNode, TileGpu>();
  private readonly uploads: Loaded[] = [];
  private readonly shift = new Vector3();
  failed = 0;

  /** Tiles receive the aircraft shadow (set from the quality preset). */
  receiveShadow = false;

  constructor(
    private readonly source: TerrainSource,
    private readonly frame: EnuFrame,
    private readonly anisotropy: number,
    private readonly atmosphere: AtmosphereUniforms,
    readonly look: TerrainLook = { detail: true, cloudShadows: true },
    readonly settings: TerrainSettings = { ...DEFAULT_TERRAIN },
  ) {
    const opts: QuadtreeOptions = {
      roots: ROOTS,
      maxZoom: Math.min(settings.maxZoom, source.maxZoom),
      maxZoomOutside: 10,
      detailBounds: SWISS_BOUNDS,
      tau: settings.tau,
    };
    this.tree = new Quadtree(frame, opts, this);

    const cores = navigator.hardwareConcurrency || 4;
    const size = Math.max(1, Math.min(2, cores - 2));
    // In-flight caps keep us at ≈ 10 parallel requests (fair use, see concept ch. 19):
    // 2 terrain + 2 imagery jobs with 4 downloads each.
    this.terrainPool = new WorkerPool(
      () =>
        new Worker(new URL('../workers/terrain.worker.ts', import.meta.url), { type: 'module' }),
      size,
      2,
    );
    this.imageryPool = new WorkerPool(
      () =>
        new Worker(new URL('../workers/imagery.worker.ts', import.meta.url), { type: 'module' }),
      size,
      2,
    );
  }

  get pendingUploads() {
    return this.uploads.length;
  }

  get queued() {
    return this.terrainPool.queued + this.imageryPool.queued;
  }

  get inFlight() {
    return this.terrainPool.inFlight + this.imageryPool.inFlight;
  }

  /**
   * Per frame: pick tiles, upload a few finished ones, free old ones, show the selection.
   * cameraRender is the camera position in render coordinates (base - shift).
   */
  update(
    cameraRender: Vector3,
    forward: Vector3,
    frustum: Frustum,
    screenHeight: number,
    fovY: number,
  ) {
    const cameraBase = cameraRender.clone().add(this.shift);
    this.tree.update(cameraBase, forward, frustum, this.shift, screenHeight, fovY);

    for (const [node, job] of this.jobs) {
      job.terrain.setPriority(node.priority);
      job.imagery.setPriority(node.priority);
    }

    if (this.uploads.length > 1) this.uploads.sort((a, b) => b.node.priority - a.node.priority);
    for (let i = 0; i < this.settings.uploadsPerFrame && this.uploads.length > 0; i++) {
      this.upload(this.uploads.shift()!);
    }

    for (const node of this.tree.evictionCandidates(this.settings.maxTiles)) this.free(node);

    for (const t of this.gpu.values()) t.mesh.visible = false;
    for (const node of this.tree.rendered) {
      const t = this.gpu.get(node);
      if (t) t.mesh.visible = true;
    }
  }

  /** Applies a quality preset: detail threshold, max zoom, tile budget and shader features. */
  applyQuality(q: {
    tau: number;
    maxZoom: number;
    maxTiles: number;
    terrainDetail: boolean;
    cloudShadows: boolean;
    shadowMap: number;
  }) {
    this.settings.tau = q.tau;
    this.settings.maxZoom = q.maxZoom;
    this.settings.maxTiles = q.maxTiles;
    this.tree.setTau(q.tau);
    this.tree.setMaxZoom(Math.min(q.maxZoom, this.source.maxZoom));
    if (this.look.detail !== q.terrainDetail || this.look.cloudShadows !== q.cloudShadows) {
      this.look.detail = q.terrainDetail;
      this.look.cloudShadows = q.cloudShadows;
      for (const t of this.gpu.values()) {
        const m = t.mesh.material as MeshLambertMaterial;
        setTerrainDefines(m, this.look);
        m.needsUpdate = true;
      }
    }
    this.setReceiveShadow(q.shadowMap > 0);
  }

  /** Turns shadow receiving on or off for all tiles (quality preset). */
  setReceiveShadow(on: boolean) {
    this.receiveShadow = on;
    for (const t of this.gpu.values()) t.mesh.receiveShadow = on;
  }

  /** Moves the render origin by `delta` (render coordinates) to keep numbers small. */
  rebase(delta: Vector3) {
    this.shift.add(delta);
    for (const t of this.gpu.values()) this.place(t);
  }

  get originShift(): Vector3 {
    return this.shift;
  }

  // ---- TileProvider ----

  request(node: TileNode) {
    const { z, x, y } = node.key;
    const big = z >= 12;
    const terrain = this.terrainPool.submit(
      { url: this.source.url(z, x, y), bounds: node.bounds, frame: this.frame },
      node.priority,
    );
    const imagery = this.imageryPool.submit(
      {
        template: SWISSIMAGE_TEMPLATE,
        bounds: node.bounds,
        // 512 px textures for detail tiles, 256 px for far tiles (a quarter of the memory).
        zoom: Math.min(19, z + (big ? 2 : 1)),
        size: big ? 512 : 256,
      },
      node.priority,
    );
    const job = { terrain, imagery, cancelled: false };
    this.jobs.set(node, job);

    void Promise.allSettled([terrain.promise, imagery.promise]).then(([t, i]) => {
      this.jobs.delete(node);
      if (job.cancelled) {
        if (i.status === 'fulfilled') i.value.bitmap.close();
        return;
      }
      if (t.status === 'fulfilled' && i.status === 'fulfilled') {
        this.uploads.push({ node, mesh: t.value, img: i.value });
        return;
      }
      if (i.status === 'fulfilled') i.value.bitmap.close();
      const err = t.status === 'rejected' ? t.reason : (i as PromiseRejectedResult).reason;
      // 403/404: swisstopo has no tile at this zoom (outside coverage). Keep the parent, no error.
      if (!/HTTP 40[34]/.test(String(err))) {
        this.failed++;
        console.warn(`terrain tile ${tileId(node.key)} failed:`, err);
      }
      this.tree.markFailed(node);
    });
  }

  cancel(node: TileNode): boolean {
    const job = this.jobs.get(node);
    if (!job) return false;
    // Only cancel if neither download has started; otherwise let it finish and be cached.
    if (!job.terrain.cancel()) return false;
    // If the imagery download already runs, its result is dropped when it arrives.
    job.imagery.cancel();
    job.cancelled = true;
    this.tree.markIdle(node);
    return true;
  }

  // ---- GPU ----

  private upload({ node, mesh, img }: Loaded) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
    geometry.setAttribute('uv', new BufferAttribute(mesh.uvs, 2));
    geometry.setAttribute('elevation', new BufferAttribute(mesh.elevations, 1));
    geometry.setIndex(new BufferAttribute(mesh.indices, 1));
    geometry.boundingSphere = new Sphere(new Vector3(...mesh.sphereCenter), mesh.sphereRadius);

    const texture = new Texture(img.bitmap);
    texture.flipY = false;
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = this.anisotropy;
    texture.needsUpdate = true;
    // The GPU has its own copy after upload; free the CPU-side bitmap.
    texture.onUpdate = () => img.bitmap.close();

    const m = new Mesh(geometry, createTerrainMaterial(texture, this.atmosphere, this.look));
    m.receiveShadow = this.receiveShadow;
    m.name = tileId(node.key);
    m.matrixAutoUpdate = false;
    m.visible = false;
    const t: TileGpu = { mesh: m, offset: new Vector3(...mesh.offset) };
    this.place(t);
    this.gpu.set(node, t);
    this.group.add(m);
    this.tree.markReady(node, mesh.minHeight, mesh.maxHeight, mesh.heights);
  }

  private place(t: TileGpu) {
    t.mesh.position.copy(t.offset).sub(this.shift);
    t.mesh.updateMatrix();
  }

  private free(node: TileNode) {
    const t = this.gpu.get(node);
    if (t) {
      this.group.remove(t.mesh);
      t.mesh.geometry.dispose();
      const mat = t.mesh.material as MeshLambertMaterial;
      mat.map?.dispose();
      mat.dispose();
      this.gpu.delete(node);
    }
    this.tree.markEvicted(node);
  }

  dispose() {
    this.terrainPool.dispose();
    this.imageryPool.dispose();
    for (const node of [...this.gpu.keys()]) this.free(node);
  }
}
