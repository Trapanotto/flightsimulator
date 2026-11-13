import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  type Camera,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Matrix4,
  Mesh,
  Vector3,
} from 'three/webgpu';
import {
  type GeoBounds,
  LocalFrame,
  SWISSTOPO_ATTRIBUTION,
  distanceToBounds,
  geoidUndulation,
  mercatorLat,
  mercatorLon,
} from '@geo';
import type { DeviceClass, LayerContext, Season, WorldLayer } from '../layers';
import { tileToRenderMatrix } from '../terrain/placement';
import {
  CHUNK_ZOOM,
  type ChunkKey,
  chunkBounds,
  chunkId,
  chunksWithin,
  evictionOrder,
  keepAt,
  levelFor,
  upperBoundRank,
} from './chunks';
import { type TreeMesh, buildTreeMeshes } from './geometry';
import {
  type ChunkUniforms,
  type Lod,
  type TreeMaterial,
  TreeUniforms,
  buildTreeNodes,
  createTreeMaterial,
} from './material';
import { type ChunkHandle, type ChunkResult, TreeWorkerPool } from './pool';
import { LOD_BAND, LOD_JITTER, TREE_PRESETS, type TreePreset } from './presets';
import { type CellData, type ChunkOutput, STRIDE } from './protocol';
import { NearSet } from './near';
import { mixPalettes, seasonPalette } from './season';
import { HeightGrid, fillGaps } from './seat';
import { Form } from './species';

/** Height grid of chunks stored below full detail: far away, 50 m between samples is plenty. */
const COARSE_GRID = 33;
/** Seconds over which re-seated trees glide to their new ground height. */
const SEAT_GLIDE = 0.6;
/** Seconds over which a season change blends the crown colours. */
const SEASON_BLEND = 1.5;
/** The loading screen waits at most this long for trees (s). */
const LOADING_PATIENCE = 25;
/** A chunk whose build failed this often is given up for the session. */
const MAX_ERRORS = 3;

/**
 * A set of trees with its own instance buffer: a whole chunk (far level only, for chunks stored
 * below full detail) or one cell of a fully stored chunk (mid and far level).
 */
interface Part {
  form: Form;
  /** STRIDE floats per tree, sorted by rank. */
  data: Float32Array;
  count: number;
  ground: InstancedBufferAttribute;
  groundPrev: InstancedBufferAttribute;
  mid?: Mesh;
  far: Mesh;
  /** Trunk extent in the chunk frame (x, z), grown by the crowns. */
  box: Box3;
}

interface Chunk {
  id: string;
  key: ChunkKey;
  bounds: GeoBounds;
  frame: LocalFrame;
  halfX: number;
  halfZ: number;
  undulation: number;
  group: Group;
  inverse: Matrix4;
  /** Stored share of the trees (1 = all, with near meshes), 0 = nothing yet. */
  level: number;
  job?: { handle: ChunkHandle; level: number };
  errors: number;
  retryAt: number;
  empty: boolean;
  /** Worker output waiting for its upload. */
  pending?: { out: ChunkOutput; level: number };
  /** What the GPU has of the chunk; undefined until its first upload. */
  parts?: Part[];
  bytes: number;
  /** Read by the shared materials per draw. */
  draw: ChunkUniforms;
  grid?: HeightGrid;
  probe?: { grid: HeightGrid; next: number };
  stale: boolean;
  minY: number;
  maxY: number;
  blend: number;
  /** Horizontal and 3D distance from the camera, metres. */
  distance: number;
  distance3: number;
  wanted: boolean;
  wantLevel: number;
  stats?: ChunkOutput['stats'];
}

export interface TreeStats {
  chunks: number;
  chunksReady: number;
  instances: number;
  instancesDrawn: number;
  /** Trees drawn at the near level (full geometry). */
  nearInstances: number;
  draws: number;
  queued: number;
  inFlight: number;
  pendingUploads: number;
  seating: number;
  gpuBytes: number;
  built: number;
  cancelled: number;
  failed: number;
  evicted: number;
  reseated: number;
  probeMs: number;
  /** CPU time of update(), mean over the last frames and worst since the start, ms. */
  updateMs: number;
  updateMaxMs: number;
  loading: boolean;
  workerMs: number;
  species: number[];
  singles: number;
  /** Chunks built with an orthophoto and with elevations. */
  photoChunks: number;
  elevationChunks: number;
}

const MESH_LODS: Lod[] = [0, 1, 2];

/**
 * Real 3D trees on swisstopo's forest areas. See index.ts for the overview.
 */
export class TreeLayer implements WorldLayer {
  readonly object = new Group();
  readonly attribution = [SWISSTOPO_ATTRIBUTION];
  private readonly preset: TreePreset;
  private readonly uniforms = new TreeUniforms();
  private readonly pool: TreeWorkerPool;
  private readonly chunks = new Map<string, Chunk>();
  /** Shared vertex data per form and level of detail. */
  private readonly base: BufferGeometry[][];
  /** One material per form and level of detail, shared by all chunks. */
  private readonly materials: TreeMaterial[][];
  private frame: LocalFrame;
  private revision = -1;
  private season: Season | undefined;
  private paletteFrom = seasonPalette('summer');
  private paletteTo = seasonPalette('summer');
  private paletteT = 1;
  private readonly palette = new Float32Array(this.paletteFrom.length);
  private loadingSince = 0;
  private isLoading = true;
  private clock = 0;
  private readonly frustum = new Frustum();
  private readonly m = new Matrix4();
  private readonly cam = new Vector3();
  private readonly camLocal = new Vector3();
  private readonly dir = new Vector3();
  private readonly box = new Box3();
  private readonly counters = {
    built: 0,
    cancelled: 0,
    failed: 0,
    evicted: 0,
    reseated: 0,
    workerMs: 0,
  };
  private probeMs = 0;
  private updateMs = 0;
  private updateMaxMs = 0;
  private drawn = { instances: 0, draws: 0, near: 0 };
  private nearDirty = true;
  private readonly near: NearSet;

  constructor(frame: LocalFrame, device: DeviceClass) {
    this.frame = frame;
    this.preset = TREE_PRESETS[device];
    this.object.name = 'Trees';
    this.object.userData.treeStats = () => this.stats();
    // For the demo page's experiments: the live distances and the preset.
    this.object.userData.treeDebug = { uniforms: this.uniforms, preset: this.preset };
    const meshes = buildTreeMeshes(this.preset.lite);
    const toGeometry = (t: TreeMesh) => {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(t.positions, 3));
      g.setAttribute('normal', new BufferAttribute(t.normals, 3));
      g.setAttribute('part', new BufferAttribute(t.parts, 1));
      g.setAttribute('ao', new BufferAttribute(t.ao, 1));
      g.setIndex(new BufferAttribute(t.indices, 1));
      return g;
    };
    this.base = [meshes.conifer.map(toGeometry), meshes.broadleaf.map(toGeometry)];
    this.materials = [Form.Conifer, Form.Broadleaf].map((form) =>
      MESH_LODS.map((lod) =>
        createTreeMaterial(
          buildTreeNodes(
            this.uniforms,
            form,
            lod,
            lod === 0 ? 2 : lod === 1 && !this.preset.lite ? 1 : 0,
          ),
        ),
      ),
    );
    this.near = new NearSet(
      this.base.map((byLod) => byLod[0]!),
      this.materials.map((byLod) => byLod[0]!),
      this.preset.nearCapacity,
    );
    for (const m of this.near.meshes) this.object.add(m);
    this.uniforms.wind.value = this.preset.wind ? 1 : 0;
    this.uniforms.thin.value = this.preset.thinStart;
    this.uniforms.fadeStart.value = this.preset.fadeStart;
    this.uniforms.fadeEnd.value = this.preset.fadeEnd;
    this.uniforms.setPalette(this.paletteTo);
    this.pool = new TreeWorkerPool(
      () => new Worker(new URL('./tree.worker.ts', import.meta.url), { type: 'module' }),
      this.preset.workers,
      this.preset.jobsInFlight,
    );
  }

  get loading(): boolean {
    return this.isLoading;
  }

  setFrame(frame: LocalFrame) {
    this.frame = frame;
    for (const c of this.chunks.values()) this.place(c);
  }

  update(ctx: LayerContext) {
    const t0 = performance.now();
    const p = this.preset;
    this.clock += ctx.dt;
    this.updateConditions(ctx);

    // Distances are tuned for 1080 lines at 55°: scale them with the pixels per radian.
    const fov = (ctx.camera as Camera & { fov?: number }).fov ?? 55;
    const ppr = ctx.screenHeight / (2 * Math.tan((fov * Math.PI) / 360));
    const lodScale = Math.min(1.6, Math.max(0.6, ppr / 1037));
    this.uniforms.near.value = p.nearRange * lodScale;
    this.uniforms.mid.value = Math.min(p.midRange * lodScale, p.thinStart * 0.95);

    const camera = ctx.camera;
    camera.updateWorldMatrix(true, false);
    camera.getWorldPosition(this.cam);
    camera.getWorldDirection(this.dir);
    this.m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(
      this.m,
      camera.coordinateSystem,
      (camera as Camera & { reversedDepth?: boolean }).reversedDepth ?? false,
    );

    // ---- Which chunks the view needs, at which level ----
    const { lon, lat, h } = ctx.view;
    const groundHere = ctx.groundHeight(lon, lat);
    const agl = Math.max(0, h - (groundHere ?? h - 300));
    for (const c of this.chunks.values()) c.wanted = false;
    for (const key of chunksWithin(lon, lat, p.fadeEnd)) {
      const id = chunkId(key);
      let c = this.chunks.get(id);
      if (!c) {
        c = this.createChunk(key);
        this.chunks.set(id, c);
      }
      c.wanted = true;
    }
    const now = this.clock;
    for (const c of this.chunks.values()) {
      c.distance = distanceToBounds(lon, lat, c.bounds);
      c.distance3 = Math.hypot(c.distance, agl);
      c.wantLevel = c.wanted ? levelFor(c.distance3, p) : 0;
      if (!c.wanted && c.distance > p.fadeEnd * 1.1) this.cancel(c);
      if (c.empty || !c.wanted) continue;
      const have = Math.max(c.level, c.pending?.level ?? 0, c.job?.level ?? 0);
      if (c.wantLevel > have && c.errors < MAX_ERRORS && now >= c.retryAt) {
        this.cancel(c);
        this.request(c, c.wantLevel);
      }
      c.job?.handle.setPriority(-c.distance3);
    }

    // ---- Heights, uploads, eviction ----
    if (ctx.groundRevision !== this.revision) {
      this.revision = ctx.groundRevision;
      for (const c of this.chunks.values()) if (c.grid) c.stale = true;
    }
    this.seat(ctx, t0);
    const ready = [...this.chunks.values()]
      .filter((c) => c.pending && c.grid)
      .sort((a, b) => a.distance3 - b.distance3);
    for (let i = 0; i < p.uploadsPerFrame && i < ready.length; i++) this.upload(ready[i]!);
    for (const id of evictionOrder(
      [...this.chunks.values()].map((c) => ({ id: c.id, distance: c.distance, wanted: c.wanted })),
      p.maxChunks,
    ))
      this.free(this.chunks.get(id)!);

    // ---- Drawing ----
    this.select(ctx.dt);

    // ---- Loading: the trees of the near view, not the far fringe ----
    let missing = 0;
    for (const c of this.chunks.values())
      if (c.wanted && !c.empty && c.distance3 < p.thinStart && (!c.parts || c.level < c.wantLevel))
        missing++;
    if (missing === 0) {
      this.isLoading = false;
      this.loadingSince = now;
    } else this.isLoading = now - this.loadingSince < LOADING_PATIENCE;
    const ms = performance.now() - t0;
    this.updateMs += (ms - this.updateMs) * 0.05;
    this.updateMaxMs = Math.max(this.updateMaxMs, ms);
  }

  private updateConditions(ctx: LayerContext) {
    const c = ctx.conditions;
    const u = this.uniforms;
    u.time.value = c.time;
    u.snowLine.value = c.snowLine;
    if (c.season !== this.season) {
      const target = seasonPalette(c.season);
      // The first season is set at once; later changes blend.
      if (this.season === undefined) {
        this.paletteFrom = target;
        this.paletteT = 1;
      } else {
        this.paletteFrom = mixPalettes(this.paletteFrom, this.paletteTo, this.paletteT);
        this.paletteT = 0;
      }
      this.paletteTo = target;
      this.season = c.season;
      mixPalettes(this.paletteFrom, this.paletteTo, this.paletteT, this.palette);
      u.setPalette(this.palette);
    } else if (this.paletteT < 1) {
      this.paletteT = Math.min(1, this.paletteT + ctx.dt / SEASON_BLEND);
      mixPalettes(this.paletteFrom, this.paletteTo, this.paletteT, this.palette);
      u.setPalette(this.palette);
    }
  }

  // ---- Chunks ----

  private createChunk(key: ChunkKey): Chunk {
    const bounds = chunkBounds(key);
    const midLon = mercatorLon(key.x + 0.5, CHUNK_ZOOM);
    const midLat = mercatorLat(key.y + 0.5, CHUNK_ZOOM);
    const frame = new LocalFrame(midLon, midLat, 0);
    const w = frame.fromGeodetic(bounds.west, midLat, 0, { x: 0, y: 0, z: 0 });
    const n = frame.fromGeodetic(midLon, bounds.north, 0, { x: 0, y: 0, z: 0 });
    const group = new Group();
    group.name = `trees ${chunkId(key)}`;
    group.matrixAutoUpdate = false;
    const undulation = geoidUndulation(midLon, midLat);
    const c: Chunk = {
      id: chunkId(key),
      key,
      bounds,
      frame,
      halfX: Math.abs(w.x),
      halfZ: Math.abs(n.z),
      undulation,
      group,
      inverse: new Matrix4(),
      level: 0,
      errors: 0,
      retryAt: 0,
      empty: false,
      draw: { blend: 1, undulation, farFrom: 0 },
      bytes: 0,
      stale: false,
      minY: 0,
      maxY: 0,
      blend: 1,
      distance: Infinity,
      distance3: Infinity,
      wanted: false,
      wantLevel: 0,
    };
    this.place(c);
    this.object.add(group);
    return c;
  }

  private place(c: Chunk) {
    tileToRenderMatrix(c.frame, this.frame, c.group.matrix.elements);
    c.group.matrixWorldNeedsUpdate = true;
    c.inverse.copy(c.group.matrix).invert();
  }

  private request(c: Chunk, level: number) {
    const p = this.preset;
    const handle = this.pool.submit(
      {
        key: c.key,
        keep: p.share * level,
        share: p.share,
        crownScale: p.crownScale,
        terrainTemplate: '',
      },
      -c.distance3,
      (r) => this.onResult(c, job, r),
    );
    const job = { handle, level };
    c.job = job;
  }

  private cancel(c: Chunk) {
    if (!c.job) return;
    c.job.handle.cancel();
    c.job = undefined;
    this.counters.cancelled++;
  }

  private onResult(c: Chunk, job: Chunk['job'], r: ChunkResult) {
    if (c.job !== job || !job) return;
    c.job = undefined;
    if (r.ok) {
      this.counters.built++;
      this.counters.workerMs += r.result.stats.ms;
      c.errors = 0;
      c.pending = { out: r.result, level: job.level };
    } else if (r.reason === 'empty') c.empty = true;
    else if (r.reason === 'error') {
      this.counters.failed++;
      c.errors++;
      c.retryAt = this.clock + 2 * c.errors;
      if (c.errors >= MAX_ERRORS) console.warn(`trees ${c.id} failed:`, r.error);
    }
  }

  // ---- Seating on the terrain ----

  /**
   * Samples the ground under the chunks within the frame's time budget: chunks without heights
   * first (nearest first), then chunks whose terrain may have been refined.
   */
  private seat(ctx: LayerContext, t0: number) {
    const budget = this.preset.seatBudgetMs;
    const start = performance.now();
    const needs = (c: Chunk) => c.wanted && !c.empty;
    const order = [...this.chunks.values()]
      .filter((c) => needs(c) && (c.probe || !c.grid || c.stale || c.grid.n < this.gridSize(c)))
      .sort((a, b) => {
        const fa = a.grid ? 1 : 0;
        const fb = b.grid ? 1 : 0;
        return fa !== fb ? fa - fb : a.distance3 - b.distance3;
      });
    for (const c of order) {
      if (performance.now() - start > budget) break;
      if (!c.probe) {
        c.probe = {
          grid: new HeightGrid(
            this.gridSize(c),
            c.halfX,
            c.halfZ,
            c.frame.origin.lon,
            c.frame.origin.lat,
          ),
          next: 0,
        };
        c.stale = false;
      }
      const g = c.probe.grid;
      const total = g.n * g.n;
      let k = c.probe.next;
      while (k < total) {
        const h = ctx.groundHeight(g.lon[k]!, g.lat[k]!);
        g.values[k] = h ?? NaN;
        k++;
        if ((k & 63) === 0 && performance.now() - start > budget) break;
      }
      c.probe.next = k;
      if (k < total) break;
      c.probe = undefined;
      if (!fillGaps(g.values, g.n)) continue;
      this.applyGrid(c, g);
    }
    this.probeMs = performance.now() - start;
    void t0;
  }

  private gridSize(c: Chunk) {
    return c.level >= 1 || (c.pending?.level ?? 0) >= 1 ? this.preset.heightGrid : COARSE_GRID;
  }

  /** New ground heights: trees glide to them if the chunk is already shown. */
  private applyGrid(c: Chunk, g: HeightGrid) {
    const old = c.grid;
    c.grid = g;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const v of g.values) {
      if (v < minY) minY = v;
      if (v > maxY) maxY = v;
    }
    c.minY = minY;
    c.maxY = maxY;
    if (!c.parts) return;
    let moved = 0;
    const blend = c.blend;
    for (const part of c.parts) {
      const ground = part.ground.array as Float32Array;
      const prev = part.groundPrev.array as Float32Array;
      for (let i = 0; i < part.count; i++) {
        const o = i * STRIDE;
        const next = g.sample(part.data[o]!, part.data[o + 2]!);
        const shown = prev[i]! + (ground[i]! - prev[i]!) * blend;
        if (Math.abs(next - ground[i]!) > 0.05) moved++;
        prev[i] = shown;
        ground[i] = next;
      }
    }
    if (moved === 0 && old) {
      // Nothing moved: keep what is shown, but settle the glide.
      for (const part of c.parts)
        (part.groundPrev.array as Float32Array).set(part.ground.array as Float32Array);
      return;
    }
    c.blend = 0;
    this.counters.reseated++;
    this.nearDirty = true;
    for (const part of c.parts) {
      part.ground.needsUpdate = true;
      part.groundPrev.needsUpdate = true;
    }
  }

  // ---- GPU ----

  private upload(c: Chunk) {
    const { out, level } = c.pending!;
    c.pending = undefined;
    const g = c.grid!;
    this.disposeParts(c);
    c.stats = out.stats;
    const parts: Part[] = [];
    out.forms.forEach((fd, form) => {
      // A fully stored chunk draws per cell (mid and far level); others as a whole (far only).
      const whole: CellData = {
        data: fd.data,
        index: new Uint32Array(0),
        minX: -c.halfX,
        maxX: c.halfX,
        minZ: -c.halfZ,
        maxZ: c.halfZ,
      };
      const sets = fd.cells.length > 0 ? fd.cells : [whole];
      for (const set of sets)
        if (set.data.length > 0)
          parts.push(this.buildPart(c, form as Form, set, fd.cells.length > 0, g));
    });
    c.parts = parts;
    c.bytes = 0;
    for (const part of parts) c.bytes += part.data.byteLength + part.count * 8;
    c.level = level;
    c.blend = 1;
    this.nearDirty = true;
    // A coarse grid on a chunk that is now detailed: refine it.
    if (g.n < this.gridSize(c)) c.stale = true;
  }

  private buildPart(c: Chunk, form: Form, set: CellData, withMid: boolean, g: HeightGrid): Part {
    const data = set.data;
    const count = data.length / STRIDE;
    const ground = new Float32Array(count);
    for (let i = 0; i < count; i++) ground[i] = g.sample(data[i * STRIDE]!, data[i * STRIDE + 2]!);
    const groundAttr = new InstancedBufferAttribute(ground, 1);
    const prevAttr = new InstancedBufferAttribute(ground.slice(), 1);
    // One instance buffer for both levels of the part.
    const inter = new InstancedInterleavedBuffer(data, STRIDE);
    const far = this.instancedMesh(form, 2, inter, groundAttr, prevAttr, count, c.draw);
    c.group.add(far);
    let mid: Mesh | undefined;
    if (withMid) {
      mid = this.instancedMesh(form, 1, inter, groundAttr, prevAttr, count, c.draw);
      c.group.add(mid);
    }
    // Crowns reach out of the trunks' box by up to about 15 m.
    const box = new Box3(
      new Vector3(set.minX - 15, 0, set.minZ - 15),
      new Vector3(set.maxX + 15, 0, set.maxZ + 15),
    );
    return { form, data, count, ground: groundAttr, groundPrev: prevAttr, mid, far, box };
  }

  private instancedMesh(
    form: Form,
    lod: Lod,
    inter: InstancedInterleavedBuffer,
    ground: InstancedBufferAttribute,
    prev: InstancedBufferAttribute,
    count: number,
    draw: ChunkUniforms,
  ): Mesh {
    const base = this.base[form]![lod]!;
    const g = new InstancedBufferGeometry();
    g.setIndex(base.index);
    for (const name of ['position', 'normal', 'part', 'ao'])
      g.setAttribute(name, base.getAttribute(name));
    g.setAttribute('iPos', new InterleavedBufferAttribute(inter, 4, 0));
    g.setAttribute('iShape', new InterleavedBufferAttribute(inter, 4, 4));
    g.setAttribute('iPhoto', new InterleavedBufferAttribute(inter, 4, 8));
    g.setAttribute('iGround', ground);
    g.setAttribute('iGroundPrev', prev);
    g.instanceCount = count;
    const mesh = new Mesh(g, this.materials[form]![lod]!);
    mesh.userData.trees = draw;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.visible = false;
    mesh.name = `${form === Form.Conifer ? 'conifer' : 'broadleaf'} lod${lod}`;
    return mesh;
  }

  /**
   * Chooses what is drawn: chunks and cells in view, how many trees of each by rank, and the
   * near trees around the camera.
   */
  private select(dt: number) {
    const p = this.preset;
    // The farthest any tree switches (its jitter pulls it closer), plus a margin.
    const reach = (1 + LOD_BAND) / (1 - LOD_JITTER / 2) + 0.03;
    const nearR = this.uniforms.near.value * reach;
    const midR = this.uniforms.mid.value * reach;
    // The nearest any tree leaves the mid level.
    const midIn = (this.uniforms.mid.value * (1 - LOD_BAND)) / (1 + LOD_JITTER / 2) - 20;
    let instances = 0;
    let draws = 0;
    for (const c of this.chunks.values()) {
      if (c.blend < 1) {
        c.blend = Math.min(1, c.blend + dt / SEAT_GLIDE);
        if (c.distance3 < nearR * 2) this.nearDirty = true;
      }
      c.draw.blend = c.blend;
      c.draw.farFrom = c.level >= 1 ? 1 : 0;
      if (!c.parts) continue;
      this.camLocal.copy(this.cam).applyMatrix4(c.inverse);
      const yLo = c.minY - 40;
      const yHi = c.maxY + 60;
      for (const part of c.parts) {
        this.box.min.set(part.box.min.x, yLo, part.box.min.z);
        this.box.max.set(part.box.max.x, yHi, part.box.max.z);
        const d = this.box.distanceToPoint(this.camLocal);
        // A cell entirely inside the mid range needs no far level.
        const reachFar = farthest(this.box, this.camLocal) >= midIn;
        let inView = c.wanted && d < p.fadeEnd;
        if (inView) {
          this.box.applyMatrix4(c.group.matrix);
          inView = this.frustum.intersectsBox(this.box);
        }
        const mid = inView && !!part.mid && d < midR;
        if (part.mid) part.mid.visible = mid;
        const n =
          inView && (!part.mid || reachFar)
            ? upperBoundRank(part.data, part.count, keepAt(d, p) * 1.05)
            : 0;
        part.far.visible = n > 0;
        (part.far.geometry as InstancedBufferGeometry).instanceCount = n;
        if (mid) {
          draws++;
          instances += part.count;
        }
        if (n > 0) {
          draws++;
          instances += n;
        }
      }
    }
    const near = this.near.update(
      this.chunks.values(),
      this.cam,
      this.dir,
      this.frustum,
      nearR,
      this.nearDirty,
    );
    this.nearDirty = false;
    draws += near.draws;
    this.drawn = { instances, draws, near: near.count };
  }

  private disposeParts(c: Chunk) {
    if (!c.parts) return;
    for (const part of c.parts)
      for (const m of [part.far, part.mid]) {
        if (!m) continue;
        c.group.remove(m);
        m.geometry.dispose();
      }
    c.parts = undefined;
    this.nearDirty = true;
  }

  private free(c: Chunk) {
    this.cancel(c);
    this.disposeParts(c);
    this.object.remove(c.group);
    this.chunks.delete(c.id);
    this.counters.evicted++;
  }

  stats(): TreeStats {
    let instances = 0;
    let gpuBytes = 0;
    let ready = 0;
    let pendingUploads = 0;
    let seating = 0;
    let singles = 0;
    let photoChunks = 0;
    let elevationChunks = 0;
    const species: number[] = [];
    for (const c of this.chunks.values()) {
      if (c.pending) pendingUploads++;
      if (c.probe) seating++;
      if (!c.parts) continue;
      ready++;
      for (const part of c.parts) instances += part.count;
      gpuBytes += c.bytes;
      if (c.stats) {
        singles += c.stats.singles;
        if (c.stats.photo) photoChunks++;
        if (c.stats.elevation) elevationChunks++;
        c.stats.species.forEach((n, s) => (species[s] = (species[s] ?? 0) + n));
      }
    }
    gpuBytes += this.near.bytes;
    // The shared meshes are small; count them once.
    for (const byLod of this.base)
      for (const g of byLod)
        for (const a of Object.values(g.attributes))
          gpuBytes += (a.array as Float32Array).byteLength;
    return {
      chunks: this.chunks.size,
      chunksReady: ready,
      instances,
      instancesDrawn: this.drawn.instances + this.drawn.near,
      nearInstances: this.drawn.near,
      draws: this.drawn.draws,
      queued: this.pool.queued,
      inFlight: this.pool.inFlight,
      pendingUploads,
      seating,
      gpuBytes,
      ...this.counters,
      probeMs: this.probeMs,
      updateMs: this.updateMs,
      updateMaxMs: this.updateMaxMs,
      loading: this.isLoading,
      species,
      singles,
      photoChunks,
      elevationChunks,
    };
  }

  dispose() {
    this.pool.dispose();
    for (const c of [...this.chunks.values()]) this.free(c);
    for (const byLod of this.base) for (const g of byLod) g.dispose();
    for (const byLod of this.materials) for (const m of byLod) m.dispose();
    this.near.dispose();
  }
}

/** Distance from p to the farthest corner of the box. */
function farthest(b: Box3, p: Vector3) {
  const dx = Math.max(Math.abs(p.x - b.min.x), Math.abs(p.x - b.max.x));
  const dy = Math.max(Math.abs(p.y - b.min.y), Math.abs(p.y - b.max.y));
  const dz = Math.max(Math.abs(p.z - b.min.z), Math.abs(p.z - b.max.z));
  return Math.hypot(dx, dy, dz);
}
