import { Color, Group, type InstancedMesh, Quaternion, Vector3 } from 'three';
import { WorkerPool } from '../core/WorkerPool';
import type { AtmosphereUniforms } from '../render/Atmosphere';
import type { World } from '../world/World';
import { BuildingSet, type ChurchInstance, type HouseInstance } from './BuildingSet';
import {
  type TileBuildings,
  VECTOR_ZOOM,
  churchTypeOf,
  houseTypeOf,
  regionOf,
  tintOf,
  wallHeight,
} from './footprints';
import type { BuildingJob } from '../workers/buildings.worker';

interface Tile {
  key: string;
  x: number;
  y: number;
  data?: TileBuildings;
  /** Placed houses in base-frame coordinates (independent of the floating origin). */
  houses?: Array<HouseInstance & { base: Vector3 }>;
  churches?: Array<ChurchInstance & { base: Vector3 }>;
  loading: boolean;
  failed: boolean;
}

const Y = new Vector3(0, 1, 0);
const DEG = Math.PI / 180;

/** Web Mercator tile containing lon/lat. */
function tileOf(lon: number, lat: number, z: number) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = lat * DEG;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return { x, y };
}

function tileCentre(x: number, y: number, z: number) {
  const n = 2 ** z;
  const lon = ((x + 0.5) / n) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) / DEG;
  return { lon, lat };
}

/**
 * Regional Blender houses on swisstopo footprints around the camera. All loaded houses share
 * one instanced mesh per type and part (~22 draw calls in total).
 */
export class BuildingLayer {
  readonly group = new Group();
  /** Radius around the camera in metres (quality preset); 0 = off. */
  radius = 3000;
  private set?: BuildingSet;
  private readonly tiles = new Map<string, Tile>();
  private readonly pool: WorkerPool<BuildingJob, TileBuildings>;
  private meshes: InstancedMesh[] = [];
  private dirty = false;
  private nextUpdate = 0;
  private readonly shiftAtBuild = new Vector3();

  constructor(
    private readonly world: World,
    atmosphere: AtmosphereUniforms,
  ) {
    this.group.name = 'Buildings';
    this.pool = new WorkerPool(
      () =>
        new Worker(new URL('../workers/buildings.worker.ts', import.meta.url), { type: 'module' }),
      1,
      2,
    );
    void BuildingSet.load(atmosphere).then(
      (s) => {
        this.set = s;
        this.dirty = true;
      },
      (err) => console.error('buildings', err),
    );
  }

  get stats() {
    let houses = 0;
    for (const t of this.tiles.values()) houses += t.houses?.length ?? 0;
    return { tiles: this.tiles.size, houses, draws: this.meshes.length };
  }

  /** Floating origin moved. */
  rebase(delta: Vector3) {
    this.group.position.sub(delta);
  }

  update(now: number) {
    if (now >= this.nextUpdate) {
      this.nextUpdate = now + 500;
      this.selectTiles();
      this.placeReadyTiles();
    }
    if (this.dirty && this.set) this.rebuild();
  }

  private selectTiles() {
    const w = this.world;
    if (this.radius <= 0) {
      if (this.tiles.size) {
        this.tiles.clear();
        this.dirty = true;
      }
      return;
    }
    const [lon, lat] = w.toGeo(w.camera.position);
    const z = VECTOR_ZOOM;
    const c = tileOf(lon, lat, z);
    const tileM = (40_075_016 * Math.cos(lat * DEG)) / 2 ** z;
    const r = Math.ceil(this.radius / tileM);
    const wanted = new Set<string>();
    const candidates: Array<{ key: string; x: number; y: number; d: number }> = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = c.x + dx;
        const y = c.y + dy;
        const cc = tileCentre(x, y, z);
        const d = Math.hypot(
          (cc.lon - lon) * 111_320 * Math.cos(lat * DEG),
          (cc.lat - lat) * 110_540,
        );
        if (d > this.radius + tileM * 0.7) continue;
        const key = `${x}/${y}`;
        wanted.add(key);
        candidates.push({ key, x, y, d });
      }
    }
    // Drop tiles that are far away now.
    for (const [key, t] of this.tiles) {
      const cc = tileCentre(t.x, t.y, z);
      const d = Math.hypot(
        (cc.lon - lon) * 111_320 * Math.cos(lat * DEG),
        (cc.lat - lat) * 110_540,
      );
      if (!wanted.has(key) && d > this.radius * 1.4 + tileM) {
        this.tiles.delete(key);
        if (t.houses) this.dirty = true;
      }
    }
    candidates.sort((a, b) => a.d - b.d);
    for (const cnd of candidates) {
      if (this.tiles.has(cnd.key)) continue;
      const t: Tile = { key: cnd.key, x: cnd.x, y: cnd.y, loading: true, failed: false };
      this.tiles.set(cnd.key, t);
      this.pool.submit({ z, x: cnd.x, y: cnd.y }, -cnd.d).promise.then(
        (data) => {
          t.data = data;
          t.loading = false;
        },
        () => {
          t.loading = false;
          t.failed = true;
        },
      );
    }
  }

  /** Places houses of loaded tiles once the terrain under them is detailed enough. */
  private placeReadyTiles() {
    const w = this.world;
    const needZoom = Math.min(14, w.quality.maxZoom);
    for (const t of this.tiles.values()) {
      if (!t.data || t.houses) continue;
      const cc = tileCentre(t.x, t.y, VECTOR_ZOOM);
      if (w.terrainDetailAt(cc.lon, cc.lat) < needZoom) continue;
      const fps = t.data.footprints;
      const tileKm2 = ((40_075_016 * Math.cos(cc.lat * DEG)) / 2 ** VECTOR_ZOOM / 1000) ** 2;
      const dense = fps.length / tileKm2 > 250;
      const shift = w.originShift;
      const centre = w.fromGeo(cc.lon, cc.lat, 0);
      const basis = w.basisAt(centre);
      const qUp = new Quaternion().setFromUnitVectors(Y, basis.up);
      const qUpInv = qUp.clone().invert();
      const houses: Array<HouseInstance & { base: Vector3 }> = [];
      const used = new Set<number>();

      // Churches: the largest building near each place-of-worship point.
      const churches: Array<ChurchInstance & { base: Vector3 }> = [];
      for (const ch of t.data.churches) {
        let best = -1;
        let bestArea = 0;
        fps.forEach((f, i) => {
          const d = Math.hypot(
            (f.lon - ch.lon) * 111_320 * Math.cos(cc.lat * DEG),
            (f.lat - ch.lat) * 110_540,
          );
          if (d < 45 && f.area > 120 && f.area > bestArea && !used.has(i)) {
            best = i;
            bestArea = f.area;
          }
        });
        if (best < 0) continue;
        used.add(best);
        const f = fps[best]!;
        const g = w.groundAt(f.lon, f.lat);
        if (g === undefined) continue;
        const pos = w.fromGeo(f.lon, f.lat, g - 0.5);
        const region = regionOf(t.data.canton, f.lon, f.lat, g);
        churches.push({
          type: churchTypeOf(region),
          x: 0,
          y: 0,
          z: 0,
          yaw: 0,
          size: Math.min(45, Math.max(14, f.length)),
          q: this.orientation(f.angle, basis, qUp, qUpInv),
          base: pos.clone().add(shift),
        });
      }

      fps.forEach((f, i) => {
        if (used.has(i)) return;
        const g = w.groundAt(f.lon, f.lat);
        if (g === undefined) return;
        const region = regionOf(t.data!.canton, f.lon, f.lat, g);
        const type = houseTypeOf(f, region, g, dense);
        const tint = tintOf(region, type, f.lon, f.lat);
        const pos = w.fromGeo(f.lon, f.lat, g - 0.35);
        houses.push({
          type,
          x: 0,
          y: 0,
          z: 0,
          yaw: 0,
          length: f.length,
          width: f.width,
          height: wallHeight(type, f),
          tint: new Color(...tint),
          q: this.orientation(f.angle, basis, qUp, qUpInv),
          base: pos.clone().add(shift),
        });
      });
      t.houses = houses;
      t.churches = churches;
      this.dirty = true;
    }
  }

  /** Quaternion: local vertical from the tile basis, long side along `angle` (from east). */
  private orientation(
    angle: number,
    basis: { up: Vector3; north: Vector3; east: Vector3 },
    qUp: Quaternion,
    qUpInv: Quaternion,
  ) {
    const dir = basis.east
      .clone()
      .multiplyScalar(Math.cos(angle))
      .addScaledVector(basis.north, Math.sin(angle));
    dir.applyQuaternion(qUpInv);
    const yaw = Math.atan2(-dir.z, dir.x);
    return new Quaternion().setFromAxisAngle(Y, yaw).premultiply(qUp);
  }

  private rebuild() {
    this.dirty = false;
    for (const m of this.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
      m.dispose();
    }
    this.meshes = [];
    if (!this.set) return;
    // Positions relative to the current floating origin; the group offset resets with them.
    const shift = this.world.originShift;
    this.shiftAtBuild.copy(shift);
    this.group.position.set(0, 0, 0);
    const houses: HouseInstance[] = [];
    const churches: ChurchInstance[] = [];
    for (const t of this.tiles.values()) {
      for (const h of t.houses ?? []) {
        houses.push({ ...h, x: h.base.x - shift.x, y: h.base.y - shift.y, z: h.base.z - shift.z });
      }
      for (const c of t.churches ?? []) {
        churches.push({
          ...c,
          x: c.base.x - shift.x,
          y: c.base.y - shift.y,
          z: c.base.z - shift.z,
        });
      }
    }
    const up = new Vector3(0, 1, 0);
    this.meshes = [...this.set.createHouses(houses, up), ...this.set.createChurches(churches, up)];
    for (const m of this.meshes) {
      m.frustumCulled = false;
      this.group.add(m);
    }
  }

  dispose() {
    this.pool.dispose();
    for (const m of this.meshes) m.geometry.dispose();
  }
}
