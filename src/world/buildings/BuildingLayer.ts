import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Matrix4,
  Sphere,
  Vector3,
  type MeshStandardNodeMaterial,
} from 'three/webgpu';
import {
  type GeoBounds,
  LocalFrame,
  SWISSTOPO_ATTRIBUTION,
  type TileKey,
  VECTOR_TILE_URL,
  fillTemplate,
  geoidUndulation,
} from '@geo';
import type { DeviceClass, LayerContext, WorldLayer } from '../layers';
import { FOOTPRINT_ZOOM } from './extrude';
import {
  type CellGrid,
  SWISSBUILDINGS_GRID,
  type ViewPoint,
  cellBounds,
  cellPath,
  cellWidth,
  cellHeight,
  cellsInRange,
  mercatorTileBounds,
  shouldEvict,
  tilesInRange,
  viewDistance,
} from './grid';
import { GroundGrid } from './groundGrid';
import { BuildingMaterials, BuildingMesh, MASK_SIZE } from './material';
import { BuildingWorkers, type JobHandle, type JobResult } from './pool';
import { BUILDING_PRESETS, type BuildingPreset, type FootprintLod, footprintLod } from './presets';
import type { BuildingJob, JobOutput } from './protocol';

/** swissBUILDINGS3D 3.0 as 3D Tiles; the dated release folder comes from this tileset.json. */
export const BUILDINGS_3D_BASE = 'https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/';

type TileState = 'queued' | 'built' | 'shown' | 'absent' | 'failed';

interface Tile {
  kind: 'footprints' | 'cell';
  id: string;
  key?: TileKey;
  cell?: number;
  lod: FootprintLod;
  bounds: GeoBounds;
  frame: LocalFrame;
  distance: number;
  state: TileState;
  handle?: JobHandle;
  output?: JobOutput;
  mesh?: BuildingMesh;
  ground?: GroundGrid;
  fade: number;
  /** Per-vertex lift being computed for the current ground, a slice per frame. */
  lifting?: { out: Float32Array; cursor: number };
  cells?: Uint32Array;
  /** A finer or coarser build of the same tile waiting to take this one's place. */
  successor?: Tile;
  failedAt: number;
  bytes: number;
}

/** Numbers for the demo page and performance notes. */
export interface BuildingStats {
  footprintTiles: number;
  cells: number;
  buildings: number;
  triangles: number;
  drawn: number;
  queued: number;
  inFlight: number;
  pendingUploads: number;
  /** Geometry and textures on the GPU, bytes (estimate). */
  gpuBytes: number;
  /** Downloaded since the start, bytes. */
  downloaded: number;
  absentCells: number;
  failed: number;
  evicted: number;
  buildMs: number;
  updateMs: number;
  updateMaxMs: number;
}

const AXES = [
  { x: 1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: 0, z: 1 },
];

/** Matrix that takes a tile's tangent frame into the render frame (double precision maths). */
function placeTile(tile: LocalFrame, render: LocalFrame, out: Matrix4): Matrix4 {
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 0, y: 0, z: 0 };
  const e = out.elements;
  AXES.forEach((axis, col) => {
    render.dirToLocal(tile.dirToEcef(axis, a), b);
    e[col * 4] = b.x;
    e[col * 4 + 1] = b.y;
    e[col * 4 + 2] = b.z;
    e[col * 4 + 3] = 0;
  });
  render.toLocal(tile.originEcef(a), b);
  e[12] = b.x;
  e[13] = b.y;
  e[14] = b.z;
  e[15] = 1;
  return out;
}

/**
 * The buildings of Switzerland. Two sources, one look:
 * - swissBUILDINGS3D (3D Tiles, real roofs and towers) in the cells around the camera,
 * - footprints from swisstopo's vector tiles, extruded to their real heights with generated
 *   roofs, out to the horizon of the preset.
 * A footprint building gives way (dithered) wherever the 3D model of its cell has faded in.
 * Everything streams in tiles built by workers, one draw call per tile, and stands on the
 * terrain as drawn through a per-tile ground grid (see GroundGrid).
 */
export class BuildingLayer implements WorldLayer {
  readonly object = new Group();
  readonly attribution = [SWISSTOPO_ATTRIBUTION];
  readonly preset: BuildingPreset;
  private readonly materials = new BuildingMaterials();
  private workers?: BuildingWorkers;
  private readonly footprints = new Map<string, Tile>();
  private readonly cellTiles = new Map<number, Tile>();
  /** Cells known to hold buildings, per footprint tile that told us. */
  private readonly knownCells = new Map<string, Uint32Array>();
  private readonly uploads: Tile[] = [];
  private grid: CellGrid = SWISSBUILDINGS_GRID;
  private cellBase?: string;
  private cellBaseRequest?: Promise<void>;
  private cellBaseRetry = 0;
  private lastRevision = -1;
  private reseatAt = -1e9;
  private reseatFarAt = -1e9;
  /** performance.now() by which this frame's ground work has to stop. */
  private budgetEnd = 0;
  private lastCellPick = { lon: 0, lat: 0, h: 0, frame: -1 };
  private wantedCells: Array<{ key: number; distance: number }> = [];
  private frames = 0;
  private loadingSince = 0;
  private stuckWarned = false;
  private readonly view: ViewPoint = { lon: 0, lat: 0, agl: 0 };
  private readonly counters = { downloaded: 0, failed: 0, evicted: 0, buildMs: 0 };
  private wantedPending = 0;
  /** Main-thread time of update(): smoothed mean and worst after the first second, ms. */
  private readonly timing = { mean: 0, max: 0 };
  private maskDirty = true;

  constructor(
    private frame: LocalFrame,
    device: DeviceClass,
    preset?: Partial<BuildingPreset>,
  ) {
    this.object.name = 'Buildings';
    this.preset = { ...BUILDING_PRESETS[device], ...preset };
  }

  /** Footprint range now: further at night, when the lit windows of distant towns show. */
  private range = 0;

  get loading(): boolean {
    return this.wantedPending > 0;
  }

  setFrame(frame: LocalFrame) {
    this.frame = frame;
    for (const t of this.allTiles()) if (t.mesh) this.place(t);
  }

  update(ctx: LayerContext) {
    const start = performance.now();
    this.frames++;
    this.workers ??= new BuildingWorkers(
      () => new Worker(new URL('./buildings.worker.ts', import.meta.url), { type: 'module' }),
      this.preset.workers,
      this.preset.inFlight,
    );
    if (this.preset.detailRange > 0) this.ensureCellBase();

    const c = ctx.conditions;
    const u = this.materials.uniforms;
    u.night.value = c.night;
    u.exposure.value = c.exposure;
    u.snowLine.value = c.snowLine;
    u.winter.value = c.season === 'winter' ? 1 : 0;

    const ground = ctx.groundHeight(ctx.view.lon, ctx.view.lat);
    this.view.lon = ctx.view.lon;
    this.view.lat = ctx.view.lat;
    this.view.agl = ground === undefined ? Math.max(ctx.view.h - 600, 0) : ctx.view.h - ground;

    // Terrain tiles arrive many times a second while flying: tiles near the camera are
    // re-seated at most every 1.5 s, far ones (metres matter less there) every 8 s.
    // With a backlog of new tiles waiting for their ground (a fresh view), more time goes
    // to it: the view fills in seconds instead of trickling in.
    const backlog = this.uploads.length > 3 ? 2.5 : 1;
    this.budgetEnd = start + this.preset.groundBudgetMs * backlog;
    if (ctx.groundRevision !== this.lastRevision) {
      const now = performance.now();
      const near = now - this.reseatAt > 1500;
      const far = now - this.reseatFarAt > 8000;
      if (near) {
        this.reseatAt = now;
        if (far) this.reseatFarAt = now;
        this.lastRevision = far ? ctx.groundRevision : this.lastRevision;
        for (const t of this.allTiles())
          if (far || t.distance < this.preset.footprintDetailRange) t.ground?.invalidate();
      }
    }

    this.range = c.night > 0.5 ? this.preset.nightRange : this.preset.footprintRange;
    this.selectFootprints(ctx);
    this.selectCells();
    this.upload(ctx);
    this.seat(ctx);
    this.fade(ctx.dt);
    this.updateMask();
    this.countPending();
    const ms = performance.now() - start;
    this.timing.mean += (ms - this.timing.mean) * 0.05;
    if (this.frames > 60) this.timing.max = Math.max(this.timing.max, ms);
  }

  // ---- what to load ----

  private selectFootprints(ctx: LayerContext) {
    const p = this.preset;
    const wanted = tilesInRange(this.view, FOOTPRINT_ZOOM, this.range);
    const seen = new Set<string>();
    for (const w of wanted) {
      const id = `${w.key.x}/${w.key.y}`;
      seen.add(id);
      const lod = footprintLod(w.distance, undefined, p);
      let t = this.footprints.get(id);
      if (!t) {
        t = this.newTile('footprints', id, mercatorTileBounds(w.key), lod, w.key);
        this.footprints.set(id, t);
        this.request(t, ctx);
      }
      t.distance = w.distance;
      t.handle?.setPriority(w.distance);
      // A different level of detail is built next to the shown one and crossfaded.
      const next = footprintLod(w.distance, t.lod, p);
      if (t.state === 'shown' && next !== t.lod && !t.successor) {
        t.successor = this.newTile('footprints', id, t.bounds, next, w.key);
        this.request(t.successor, ctx);
      }
      if (t.successor) t.successor.distance = w.distance;
      if (t.state === 'failed' && performance.now() - t.failedAt > 20_000) this.request(t, ctx);
    }
    for (const [id, t] of this.footprints) {
      if (seen.has(id)) continue;
      t.distance = viewDistance(this.view, t.bounds);
      if (shouldEvict(t.distance, this.range)) {
        this.drop(t);
        this.footprints.delete(id);
        this.knownCells.delete(id);
      }
    }
  }

  private selectCells() {
    const p = this.preset;
    if (p.detailRange <= 0 || !this.cellBase) return;
    // Picking cells walks every known cell: only when the camera has moved a little.
    const last = this.lastCellPick;
    const moved =
      Math.hypot((this.view.lon - last.lon) * 76_000, (this.view.lat - last.lat) * 111_200) +
      Math.abs(this.view.agl - last.h);
    if (moved > 15 || this.frames - last.frame > 30) {
      last.lon = this.view.lon;
      last.lat = this.view.lat;
      last.h = this.view.agl;
      last.frame = this.frames;
      const known = new Set<number>();
      for (const [id, cells] of this.knownCells) {
        const t = this.footprints.get(id);
        if (!t || t.distance > p.detailRange * 1.5) continue;
        for (const c of cells) known.add(c);
      }
      this.wantedCells = cellsInRange(this.grid, this.view, known, p.detailRange, p.maxCells);
    }
    const seen = new Set<number>();
    for (const w of this.wantedCells) {
      seen.add(w.key);
      let t = this.cellTiles.get(w.key);
      if (!t) {
        t = this.newTile('cell', String(w.key), cellBounds(this.grid, w.key), 0);
        t.cell = w.key;
        this.cellTiles.set(w.key, t);
        this.request(t);
      }
      t.distance = w.distance;
      t.handle?.setPriority(w.distance + 50);
      if (t.state === 'failed' && performance.now() - t.failedAt > 20_000) this.request(t);
    }
    for (const [id, t] of this.cellTiles) {
      if (seen.has(id)) continue;
      t.distance = viewDistance(this.view, t.bounds);
      // Out of the budget (a closer cell took its place) or out of range.
      const over =
        this.wantedCells.length >= p.maxCells &&
        t.distance > (this.wantedCells.at(-1)?.distance ?? 0) * 1.15;
      if (shouldEvict(t.distance, p.detailRange, 1.2) || over) {
        this.drop(t);
        this.cellTiles.delete(id);
        this.maskDirty = true;
      }
    }
  }

  private newTile(
    kind: Tile['kind'],
    id: string,
    bounds: GeoBounds,
    lod: FootprintLod,
    key?: TileKey,
  ): Tile {
    return {
      kind,
      id,
      key,
      lod,
      bounds,
      frame: new LocalFrame((bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2, 0),
      distance: 0,
      state: 'queued',
      fade: 0,
      failedAt: 0,
      bytes: 0,
    };
  }

  private request(t: Tile, ctx?: LayerContext) {
    if (!this.workers) return;
    t.state = 'queued';
    let job: BuildingJob;
    if (t.kind === 'footprints') {
      const k = t.key!;
      job = {
        kind: 'footprints',
        url: fillTemplate(VECTOR_TILE_URL, k.z, k.x, k.y),
        key: k,
        lod: t.lod,
        elevation: this.elevationSamples(t.bounds, ctx),
        grid: this.grid,
      };
    } else {
      job = {
        kind: 'cell',
        url: this.cellBase + cellPath(this.grid, t.cell!),
        cell: t.cell!,
        grid: this.grid,
      };
    }
    t.handle = this.workers.submit(job, t.distance, (r) => this.onResult(t, r));
  }

  /** Sea-level heights on a 5 x 5 grid over the tile, from the terrain loaded so far. */
  private elevationSamples(b: GeoBounds, ctx?: LayerContext): number[] {
    const out: number[] = [];
    let fallback = 500;
    for (let j = 0; j < 5; j++)
      for (let i = 0; i < 5; i++) {
        const lon = b.west + ((b.east - b.west) * i) / 4;
        const lat = b.north - ((b.north - b.south) * j) / 4;
        const h = ctx?.groundHeight(lon, lat);
        const v = h === undefined ? NaN : h - geoidUndulation(lon, lat);
        if (!Number.isNaN(v)) fallback = v;
        out.push(v);
      }
    return out.map((v) => (Number.isNaN(v) ? fallback : v));
  }

  private onResult(t: Tile, r: JobResult) {
    t.handle = undefined;
    if (!r.ok) {
      if (r.reason === 'absent') t.state = 'absent';
      else if (r.reason === 'error') {
        t.state = 'failed';
        t.failedAt = performance.now();
        this.counters.failed++;
        console.warn(`buildings: tile ${t.kind} ${t.id} failed`, r.error);
      }
      // Cancelled: the tile was dropped already.
      return;
    }
    if (!this.isLive(t)) return;
    t.output = r.output;
    t.bytes = r.output.bytes;
    this.counters.downloaded += r.output.bytes;
    this.counters.buildMs += r.output.buildMs;
    t.state = 'built';
    if (r.output.cells && t.kind === 'footprints') {
      this.knownCells.set(t.id, r.output.cells);
      this.lastCellPick.frame = -1e9;
    }
    this.uploads.push(t);
  }

  /** Still wanted: the current tile of its place, or the successor waiting to replace it. */
  private isLive(t: Tile): boolean {
    if (t.kind === 'cell') return this.cellTiles.get(t.cell!) === t;
    const cur = this.footprints.get(t.id);
    return cur === t || cur?.successor === t;
  }

  private drop(t: Tile) {
    t.handle?.cancel();
    t.handle = undefined;
    if (t.successor) this.drop(t.successor);
    t.successor = undefined;
    if (t.mesh) {
      this.object.remove(t.mesh);
      t.mesh.geometry.dispose();
      (t.mesh.material as MeshStandardNodeMaterial).dispose();
      this.counters.evicted++;
    }
    t.mesh = undefined;
    t.output = undefined;
    const i = this.uploads.indexOf(t);
    if (i >= 0) this.uploads.splice(i, 1);
  }

  // ---- to the GPU ----

  private upload(ctx: LayerContext) {
    this.uploads.sort((a, b) => a.distance - b.distance);
    let count = 0;
    let bytes = 0;
    for (let i = 0; i < this.uploads.length;) {
      if (count >= this.preset.uploadsPerFrame || bytes >= this.preset.uploadBytesPerFrame) break;
      const t = this.uploads[i]!;
      if (!this.isLive(t) || !t.output) {
        this.uploads.splice(i, 1);
        continue;
      }
      const m = t.output.mesh;
      if (!t.ground) {
        if (m.positions.length === 0) {
          // An empty tile (no buildings): nothing to draw, but it counts as done.
          this.uploads.splice(i, 1);
          this.show(t, undefined);
          continue;
        }
        const step = t.kind === 'cell' ? 14 : this.preset.groundStep;
        t.ground = new GroundGrid(t.frame, m.minX, m.maxX, m.minZ, m.maxZ, step);
      }
      // The ground under a new tile is sampled before it is shown (within the budget).
      // Ground work shares one time budget per frame (seating included); a tile keeps the
      // budget until its ground and lift are done, the next one waits.
      while (!t.ground.ready && performance.now() < this.budgetEnd)
        t.ground.fill(ctx.groundHeight, 300);
      if (!t.ground.ready) {
        // No terrain under it yet (or out of time): try the next tile.
        if (performance.now() > this.budgetEnd) break;
        i++;
        continue;
      }
      let lifted = false;
      while (!lifted && performance.now() < this.budgetEnd)
        lifted = this.advanceLift(t, this.liftSlice());
      if (!lifted) break;
      this.uploads.splice(i, 1);
      this.show(t, this.createMesh(t));
      count++;
      bytes += m.positions.byteLength + m.meta.byteLength + m.indices.byteLength;
    }
  }

  private createMesh(t: Tile): BuildingMesh {
    const m = t.output!.mesh;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(m.positions, 3));
    const lift = new BufferAttribute(t.lifting!.out, 1);
    t.lifting = undefined;
    g.setAttribute('bLift', lift);
    g.setAttribute('bRoof', new BufferAttribute(m.roof, 4, true));
    g.setAttribute('bWall', new BufferAttribute(m.wall, 4, true));
    g.setAttribute('bInfo', new BufferAttribute(m.info, 4, true));
    g.setIndex(new BufferAttribute(m.indices, 1));
    // A material per tile: one shared node graph (so one shader), its own render state.
    const mesh = new BuildingMesh(g, this.materials.create(t.kind === 'cell'));
    mesh.name = `buildings ${t.kind} ${t.id}`;
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = true;
    mesh.userData.triangles = m.indices.length / 3;
    mesh.userData.buildings = m.buildingCount;
    mesh.userData.bytes =
      m.positions.byteLength +
      lift.array.byteLength +
      m.roof.byteLength +
      m.wall.byteLength +
      m.info.byteLength +
      m.indices.byteLength;
    mesh.geoid = geoidUndulation(t.frame.origin.lon, t.frame.origin.lat);
    t.mesh = mesh;
    this.bound(t);
    this.place(t);
    return mesh;
  }

  /** Bounding sphere around the lifted vertices (the shader moves them onto the ground). */
  private bound(t: Tile) {
    const m = t.output!.mesh;
    const gr = t.ground!;
    const g = t.mesh!.geometry;
    const lo = new Vector3(m.minX, gr.min + Math.min(m.minY, -1), m.minZ);
    const hi = new Vector3(m.maxX, gr.max + m.maxY, m.maxZ);
    g.boundingSphere = new Sphere(lo.clone().add(hi).multiplyScalar(0.5), lo.distanceTo(hi) / 2);
  }

  private place(t: Tile) {
    const mesh = t.mesh!;
    placeTile(t.frame, this.frame, mesh.matrix);
    mesh.matrixWorldNeedsUpdate = true;
  }

  /** A built tile goes on screen (or takes the place of the tile it was built to replace). */
  private show(t: Tile, mesh: BuildingMesh | undefined) {
    if (t.kind === 'footprints') {
      const cur = this.footprints.get(t.id)!;
      if (cur !== t) {
        // A successor: shown next to its predecessor until it has faded in.
        t.state = 'shown';
        t.fade = 0;
        if (mesh) this.object.add(mesh);
        else this.finishSuccession(cur);
        return;
      }
    }
    t.state = 'shown';
    t.fade = 0;
    if (mesh) {
      mesh.castShadow = t.distance < this.preset.shadowRange;
      this.object.add(mesh);
    }
    this.maskDirty = true;
  }

  private finishSuccession(cur: Tile) {
    const next = cur.successor!;
    cur.successor = undefined;
    // The old tile goes; the successor takes its place in the map.
    this.drop(cur);
    this.footprints.set(next.id, next);
    if (next.output?.cells) this.knownCells.set(next.id, next.output.cells);
  }

  // ---- the ground under the tiles ----

  private seat(ctx: LayerContext) {
    const tiles: Tile[] = [];
    for (const t of this.allTiles()) if (t.mesh && (t.ground?.dirty || t.lifting)) tiles.push(t);
    tiles.sort((a, b) => a.distance - b.distance);
    for (const t of tiles) {
      if (performance.now() > this.budgetEnd) break;
      if (!t.lifting) {
        if (!t.ground!.fill(ctx.groundHeight, 400).completed) continue;
      }
      if (this.advanceLift(t, this.liftSlice())) {
        const lift = t.mesh!.geometry.getAttribute('bLift') as BufferAttribute;
        (lift.array as Float32Array).set(t.lifting!.out);
        t.lifting = undefined;
        lift.needsUpdate = true;
        this.bound(t);
      }
    }
  }

  /** Vertices whose lift is computed per call (about a millisecond's worth). */
  private liftSlice() {
    return 8_000;
  }

  /** Continues the lift of a tile's vertices onto its (complete) ground; true when done. */
  private advanceLift(t: Tile, count: number): boolean {
    const m = t.output!.mesh;
    const n = m.positions.length / 3;
    t.lifting ??= { out: new Float32Array(n), cursor: 0 };
    const job = t.lifting;
    const end = Math.min(n, job.cursor + count);
    t.ground!.lift(m.positions, m.meta, m.buildings, job.out, job.cursor, end);
    job.cursor = end;
    return end >= n;
  }

  // ---- fades ----

  private fade(dt: number) {
    const step = dt / this.preset.fadeSeconds;
    for (const t of this.footprints.values()) {
      if (t.state === 'shown' && t.mesh) {
        if (t.fade < 1) t.fade = Math.min(1, t.fade + step);
        t.mesh.fadeLo = 0;
        t.mesh.fadeHi = t.fade;
        t.mesh.castShadow = t.distance < this.preset.shadowRange;
      }
      const s = t.successor;
      if (s?.state === 'shown') {
        s.fade = Math.min(1, s.fade + step);
        if (s.mesh) {
          // Complementary dither: each pixel shows exactly one of the two builds.
          s.mesh.fadeLo = 0;
          s.mesh.fadeHi = s.fade;
          if (t.mesh) {
            t.mesh.fadeLo = s.fade;
            t.mesh.fadeHi = 1.001;
          }
        }
        if (s.fade >= 1) this.finishSuccession(t);
      }
    }
    for (const t of this.cellTiles.values()) {
      if (t.state !== 'shown' || !t.mesh) continue;
      if (t.fade < 1) {
        t.fade = Math.min(1, t.fade + step);
        this.maskDirty = true;
      }
      t.mesh.fadeLo = 0;
      t.mesh.fadeHi = t.fade;
    }
  }

  /** Writes the fade of every shown 3D cell around the camera into the shared mask. */
  private updateMask() {
    const g = this.grid;
    const cx = Math.floor((this.view.lon - g.west) / cellWidth(g));
    const cy = Math.floor((this.view.lat - g.south) / cellHeight(g));
    const ox = cx - MASK_SIZE / 2;
    const oy = cy - MASK_SIZE / 2;
    const origin = this.materials.uniforms.maskOrigin.value;
    // Move the window in steps, so it is not rewritten for every metre flown.
    if (Math.abs(origin.x - ox) > 8 || Math.abs(origin.y - oy) > 8) {
      origin.set(ox, oy);
      this.maskDirty = true;
    }
    if (!this.maskDirty) return;
    this.maskDirty = false;
    const data = this.materials.mask.image.data as Uint8Array;
    data.fill(0);
    for (const t of this.cellTiles.values()) {
      if (t.state !== 'shown' || !t.mesh) continue;
      const x = (t.cell! % g.size) - origin.x;
      const y = Math.floor(t.cell! / g.size) - origin.y;
      if (x < 0 || y < 0 || x >= MASK_SIZE || y >= MASK_SIZE) continue;
      data[y * MASK_SIZE + x] = Math.round(t.fade * 255);
    }
    this.materials.mask.needsUpdate = true;
  }

  // ---- bookkeeping ----

  /**
   * Counts what the current view still waits for: footprint tiles in range and the 3D cells
   * picked, not yet on screen. Failed and absent tiles count as done; and after a minute of
   * waiting the layer stops holding up the loading screen whatever is still missing.
   */
  private countPending() {
    let n = 0;
    for (const t of this.footprints.values())
      if (t.distance < this.range && (t.state === 'queued' || t.state === 'built')) n++;
    for (const w of this.wantedCells) {
      const t = this.cellTiles.get(w.key);
      if (t && (t.state === 'queued' || t.state === 'built')) n++;
    }
    if (this.preset.detailRange > 0 && !this.cellBase && !this.cellBaseFailed()) n++;
    const now = performance.now();
    if (n === 0) {
      this.loadingSince = 0;
      this.stuckWarned = false;
    } else if (!this.loadingSince) this.loadingSince = now;
    else if (now - this.loadingSince > 60_000) {
      if (!this.stuckWarned) console.warn(`buildings: still waiting for ${n} tiles; not blocking`);
      this.stuckWarned = true;
      n = 0;
    }
    this.wantedPending = n;
  }

  private cellBaseFailed() {
    return this.cellBaseRetry > 0 && !this.cellBaseRequest;
  }

  /** Reads the dated release folder of swissBUILDINGS3D (it changes with every update). */
  private ensureCellBase() {
    if (this.cellBase || this.cellBaseRequest || performance.now() < this.cellBaseRetry) return;
    this.cellBaseRequest = fetch(BUILDINGS_3D_BASE + 'tileset.json')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json: unknown) => {
        this.cellBase = BUILDINGS_3D_BASE + parseReleaseFolder(json);
      })
      .catch((err: unknown) => {
        console.warn('buildings: swissBUILDINGS3D unavailable, footprints only', err);
        this.cellBaseRetry = performance.now() + 30_000;
      })
      .finally(() => (this.cellBaseRequest = undefined));
  }

  private *allTiles(): Iterable<Tile> {
    for (const t of this.footprints.values()) {
      yield t;
      if (t.successor) yield t.successor;
    }
    yield* this.cellTiles.values();
  }

  stats(): BuildingStats {
    let buildings = 0;
    let triangles = 0;
    let drawn = 0;
    let gpuBytes = 0;
    let footprintTiles = 0;
    let cells = 0;
    let absent = 0;
    for (const t of this.allTiles()) {
      if (t.state === 'absent') absent++;
      if (!t.mesh) continue;
      if (t.kind === 'cell') cells++;
      else footprintTiles++;
      buildings += t.mesh.userData.buildings as number;
      triangles += t.mesh.userData.triangles as number;
      gpuBytes += (t.mesh.userData.bytes as number) + (t.ground?.size ?? 0) * 4;
      drawn++;
    }
    return {
      footprintTiles,
      cells,
      buildings,
      triangles,
      drawn,
      queued: this.workers?.queued ?? 0,
      inFlight: this.workers?.inFlight ?? 0,
      pendingUploads: this.uploads.length,
      gpuBytes,
      downloaded: this.counters.downloaded,
      absentCells: absent,
      failed: this.counters.failed,
      evicted: this.counters.evicted,
      buildMs: this.counters.buildMs,
      updateMs: this.timing.mean,
      updateMaxMs: this.timing.max,
    };
  }

  dispose() {
    for (const t of [...this.allTiles()]) this.drop(t);
    this.footprints.clear();
    this.cellTiles.clear();
    this.workers?.dispose();
    this.materials.dispose();
  }
}

/** The dated folder of the current release, from the top tileset.json ("20260520/"). */
export function parseReleaseFolder(json: unknown): string {
  const t = json as { root?: { children?: Array<{ content?: { uri?: string; url?: string } }> } };
  for (const c of t.root?.children ?? []) {
    const uri = c.content?.uri ?? c.content?.url;
    const m = uri?.match(/^(.*\/)tileset\.json$/);
    if (m) return m[1]!;
  }
  throw new Error('buildings tileset.json: no release folder');
}
