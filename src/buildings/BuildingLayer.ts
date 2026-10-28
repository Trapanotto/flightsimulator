import {
  type BufferGeometry,
  Color,
  SRGBColorSpace,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { createTreeMaterial } from './buildingMaterial';
import { WorkerPool } from '../core/WorkerPool';
import type { AtmosphereUniforms } from '../render/Atmosphere';
import type { World } from '../world/World';
import { BuildingSet, type ChurchInstance, type HouseInstance } from './BuildingSet';
import {
  TREE_TYPES,
  type TileBuildings,
  VECTOR_ZOOM,
  churchTypeOf,
  houseTypeOf,
  regionOf,
  tintOf,
  variantOf,
  seasonOf,
  treeOf,
  treeTint,
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
  /** Spacing the tile's trees were generated with. */
  treeSpacing: number;
}

const Y = new Vector3(0, 1, 0);
const DEG = Math.PI / 180;
const TREES_URL = `${import.meta.env.BASE_URL}assets/buildings/trees.glb`;
const m4 = new Matrix4();
const tq = new Quaternion();
const tp = new Vector3();
const ts = new Vector3();
const tc = new Color();

/** The date the trees dress for: today, or ?date=2026-07-15 (testing). */
function seasonDate(): Date {
  const q = new URLSearchParams(location.search).get('date');
  const d = q ? new Date(q) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

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
  /** Trees: radius around the camera and spacing in forests (metres); 0 = off. */
  treeRadius = 700;
  treeSpacing = 11;
  /** Tree shapes by `<species>_<variant>`. */
  private treeGeos?: Map<string, BufferGeometry>;
  private readonly treeMaterial;
  private treeMeshes: InstancedMesh[] = [];
  private readonly treeCentre = new Vector3(Infinity, 0, 0);
  private treesDirty = false;
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
    this.treeMaterial = createTreeMaterial(atmosphere);
    void new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .loadAsync(TREES_URL)
      .then(
        (gltf) => {
          const geos = new Map<string, BufferGeometry>();
          gltf.scene.updateMatrixWorld(true);
          gltf.scene.traverse((o) => {
            if (!(o instanceof Mesh)) return;
            const name = (o.name.replace(/_mesh$/, '') || o.parent?.name || '').replace(
              'Tree_',
              '',
            );
            const g = (o.geometry as BufferGeometry).clone();
            g.applyMatrix4(o.matrixWorld);
            const species = name.replace(/_\d+$/, '');
            if ((TREE_TYPES as readonly string[]).includes(species)) geos.set(name, g);
          });
          this.treeGeos = geos;
          this.treesDirty = true;
        },
        (err) => console.error('trees', err),
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
    const trees = this.treeMeshes.reduce((n, m) => n + m.count, 0);
    return {
      tiles: this.tiles.size,
      houses,
      trees,
      draws: this.meshes.length + this.treeMeshes.length,
    };
  }

  /** Nearest named place: villages and towns within 6 km, hamlets within 2 km. */
  nearestPlace(lon: number, lat: number): { name: string; km: number } | null {
    const kx = 111.32 * Math.cos(lat * DEG);
    let best: { name: string; km: number } | null = null;
    let bestScore = Infinity;
    for (const t of this.tiles.values()) {
      for (const p of t.data?.places ?? []) {
        const km = Math.hypot((p.lon - lon) * kx, (p.lat - lat) * 110.54);
        const reach = p.cls === 'hamlet' ? 2 : p.cls === 'village' ? 6 : 12;
        if (km > reach) continue;
        // Bigger places win at equal distance.
        const score =
          km / (p.cls === 'city' ? 3 : p.cls === 'town' ? 2 : p.cls === 'village' ? 1.3 : 1);
        if (score < bestScore) {
          bestScore = score;
          best = { name: p.name, km };
        }
      }
    }
    return best;
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
    // Houses and trees share the group's floating-origin offset, so they are rebuilt together:
    // after tile changes, or when the camera moved ~150 m (trees follow the camera).
    const cam = this.world.camera.position.clone().add(this.world.originShift);
    const treesDue = !!this.treeGeos && (this.treesDirty || cam.distanceTo(this.treeCentre) > 150);
    if ((this.dirty && this.set) || treesDue) {
      this.dirty = false;
      this.treesDirty = false;
      this.treeCentre.copy(cam);
      this.rebuild();
      this.rebuildTrees();
    }
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
      const t: Tile = {
        key: cnd.key,
        x: cnd.x,
        y: cnd.y,
        loading: true,
        failed: false,
        treeSpacing: this.treeSpacing,
      };
      this.tiles.set(cnd.key, t);
      this.pool
        .submit(
          { z, x: cnd.x, y: cnd.y, treeSpacing: this.treeRadius > 0 ? this.treeSpacing : 0 },
          -cnd.d,
        )
        .promise.then(
          (data) => {
            t.data = data;
            t.loading = false;
            this.treesDirty = true;
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
        const variant = variantOf(type, region, f);
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
          variant,
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

  /** Instanced trees within treeRadius of the camera, one mesh per species. */
  private rebuildTrees() {
    for (const m of this.treeMeshes) {
      this.group.remove(m);
      m.dispose();
    }
    this.treeMeshes = [];
    if (this.treeRadius <= 0 || !this.treeGeos) return;
    const w = this.world;
    const needZoom = Math.min(14, w.quality.maxZoom);
    const [clon, clat] = w.toGeo(w.camera.position);
    const kx = 111_320 * Math.cos(clat * DEG);
    const ky = 110_540;
    const r2 = this.treeRadius * this.treeRadius;
    const lists = new Map<string, number[]>();
    const season = seasonOf(seasonDate());
    for (const t of this.tiles.values()) {
      const d = t.data;
      if (!d || !d.trees.length) continue;
      const cc = tileCentre(t.x, t.y, VECTOR_ZOOM);
      if (w.terrainDetailAt(cc.lon, cc.lat) < needZoom) continue;
      const centre = w.fromGeo(cc.lon, cc.lat, 0);
      const up = w.upAt(centre, new Vector3());
      const qUp = new Quaternion().setFromUnitVectors(Y, up);
      for (let i = 0; i < d.trees.length; i += 2) {
        const lon = d.trees[i]!;
        const lat = d.trees[i + 1]!;
        const dx = (lon - clon) * kx;
        const dy = (lat - clat) * ky;
        if (dx * dx + dy * dy > r2) continue;
        const g = w.groundAt(lon, lat);
        if (g === undefined) continue;
        const tree = treeOf(regionOf(d.canton, lon, lat, g), g, lon, lat);
        if (!tree) continue;
        const pos = w.fromGeo(lon, lat, g - 0.3);
        const key = `${tree.type}_${tree.variant}`;
        const list = lists.get(key) ?? [];
        const tint = treeTint(tree.type, lon, lat, season);
        // x, y, z, height, yaw, qUp (x, y, z, w), width, tint (r, g, b)
        list.push(
          pos.x,
          pos.y,
          pos.z,
          tree.height,
          (lon * 1e5) % 6.283,
          qUp.x,
          qUp.y,
          qUp.z,
          qUp.w,
          tree.width,
          ...tint,
        );
        lists.set(key, list);
      }
    }
    // Positions are relative to the current origin (group offset was reset by rebuild()).
    const STRIDE = 13;
    for (const [key, list] of lists) {
      const geo = this.treeGeos.get(key) ?? this.treeGeos.get(key.replace(/_\d+$/, '_0'));
      if (!geo) continue;
      const n = list.length / STRIDE;
      const mesh = new InstancedMesh(geo, this.treeMaterial, n);
      for (let i = 0; i < n; i++) {
        const o = i * STRIDE;
        // Multipliers are meant on screen (sRGB), the shader multiplies linear colours.
        mesh.setColorAt(i, tc.setRGB(list[o + 10]!, list[o + 11]!, list[o + 12]!, SRGBColorSpace));
        tq.set(list[o + 5]!, list[o + 6]!, list[o + 7]!, list[o + 8]!);
        tq.multiply(new Quaternion().setFromAxisAngle(Y, list[o + 4]!));
        const hgt = list[o + 3]!;
        mesh.setMatrixAt(
          i,
          m4.compose(
            tp.set(list[o]!, list[o + 1]!, list[o + 2]!),
            tq,
            ts.set(hgt * 0.95 * list[o + 9]!, hgt, hgt * 0.95 * list[o + 9]!),
          ),
        );
      }
      mesh.frustumCulled = false;
      mesh.name = `trees_${key}`;
      this.treeMeshes.push(mesh);
      this.group.add(mesh);
    }
  }

  dispose() {
    this.pool.dispose();
    for (const m of this.meshes) m.geometry.dispose();
  }
}
