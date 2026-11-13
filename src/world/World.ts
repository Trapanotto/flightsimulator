import { type Camera, type Color, Frustum, Group, Matrix4, Vector3 } from 'three/webgpu';
import {
  LocalFrame,
  SWISSTOPO_ATTRIBUTION,
  type SurfaceHit,
  TERRAIN_BASE,
  ecefToGeodetic,
  parseTerrainLayer,
} from '@geo';
import { MASK_B_GLACIER, MASK_B_GRASS_RUNWAY, MASK_B_RUNWAY } from './terrain/protocol';
import type { Plane, ViewState } from './terrain/Quadtree';
import { TerrainStreamer } from './terrain/TerrainStreamer';
import { DETAIL_PERIOD, TerrainMaterials } from './terrain/terrainMaterial';

/** How much of the world is drawn; set from the device class and the graphics setting. */
export interface WorldQuality {
  /** Metres to the far edge of what is drawn. */
  viewDistance: number;
  /**
   * Level of detail: the largest screen size of one orthophoto texel (pixels) before a tile is
   * replaced by its four children. Lower = sharper and more tiles.
   */
  maxTexelPx: number;
  /** Orthophoto texture size per tile (pixels per side). */
  textureSize: number;
  /** Land-cover mask (water, forest, ...) size per tile (pixels per side). */
  maskSize: number;
  /** Tiles kept on the GPU (drawn plus cached). */
  maxTiles: number;
  /** New tiles handed to the GPU per frame (limits hitches). */
  uploadsPerFrame: number;
  /** Tiles built at the same time (each starts with downloads: also the network limit). */
  tilesInFlight: number;
  /** Web Workers that download, decode and compose tiles. */
  workers: number;
  /** Deepest terrain zoom (swisstopo goes to 18; 17 is about 100 m per tile). */
  maxZoom: number;
  /** Anisotropic filtering of the orthophotos (sharp ground at grazing angles). */
  anisotropy: number;
  /** Procedural close-up detail on the ground. */
  detail: boolean;
  /** Lakes and rivers as a water surface. */
  water: boolean;
}

/** Presets per device class; the app picks one. */
export const WORLD_QUALITY: Record<'desktop' | 'mobile', WorldQuality> = {
  desktop: {
    viewDistance: 150_000,
    maxTexelPx: 1.4,
    textureSize: 512,
    maskSize: 256,
    maxTiles: 320,
    uploadsPerFrame: 3,
    tilesInFlight: 6,
    workers: 3,
    maxZoom: 17,
    anisotropy: 8,
    detail: true,
    water: true,
  },
  mobile: {
    viewDistance: 80_000,
    maxTexelPx: 2,
    textureSize: 256,
    maskSize: 128,
    maxTiles: 160,
    uploadsPerFrame: 2,
    tilesInFlight: 4,
    workers: 2,
    maxZoom: 16,
    anisotropy: 4,
    detail: true,
    water: true,
  },
};

/** The ground at one place. */
export interface GroundInfo {
  /** Height above the ellipsoid, metres. */
  height: number;
  /** Unit normal of the surface in render space (x east, y up, z south). */
  normal: { x: number; y: number; z: number };
  /** What is there: decides wheel friction and whether a landing is survivable. */
  surface: 'asphalt' | 'concrete' | 'grass' | 'gravel' | 'snow' | 'water' | 'terrain';
}

/** Numbers for the demo page and performance reports. */
export interface WorldStats {
  tilesDrawn: number;
  tilesLoaded: number;
  triangles: number;
  /** Estimated GPU memory of the loaded tiles (textures with mipmaps, buffers), bytes. */
  gpuBytes: number;
  queued: number;
  inFlight: number;
  pendingUploads: number;
  maxZoom: number;
  uploaded: number;
  evicted: number;
  cancelled: number;
  absent: number;
  failed: number;
}

/**
 * The ground and everything standing on it: terrain, trees, buildings, water, airports.
 *
 * Phase 1: swisstopo's terrain streamed as a quadtree of quantized-mesh tiles, SWISSIMAGE
 * orthophotos warped onto them, lakes and rivers from the vector tiles drawn as water, and a
 * procedural detail layer close to the ground. Trees, buildings and airports will hang their
 * own groups into `object` next to the terrain.
 *
 * Heights: swisstopo's data is above sea level; everything here (mesh and queries) is above the
 * WGS84 ellipsoid, the sea-level heights plus the geoid undulation (geo/geoid.ts).
 */
export class World {
  /** Add to the scene. */
  readonly object = new Group();
  private readonly materials: TerrainMaterials;
  private terrain?: TerrainStreamer;
  private screenHeight = 1080;
  /** Render-space x/z of the detail pattern origin, see setFrame. */
  private readonly detailOrigin = { x: 0, z: 0 };
  private readonly frustum = new Frustum();
  private readonly m = new Matrix4();
  private readonly planes: Plane[] = Array.from({ length: 6 }, () => ({
    nx: 0,
    ny: 0,
    nz: 0,
    d: 0,
  }));
  private readonly v = new Vector3();
  private readonly hit: SurfaceHit = { height: 0, normal: { x: 0, y: 0, z: 1 } };

  constructor(
    private frame: LocalFrame,
    private readonly quality: WorldQuality,
  ) {
    this.object.name = 'World';
    this.materials = new TerrainMaterials({ detail: quality.detail, water: quality.water });
  }

  /** Loads what is needed before the first frame (data source descriptions and the like). */
  async init(): Promise<void> {
    if (this.terrain) return;
    const res = await fetch(TERRAIN_BASE + 'layer.json');
    if (!res.ok) throw new Error(`terrain layer.json: HTTP ${res.status}`);
    const layer = parseTerrainLayer(await res.json());
    this.terrain = new TerrainStreamer(layer, this.frame, { ...this.quality }, this.materials);
    this.object.add(this.terrain.group);
  }

  /** The render frame moved (floating origin). */
  setFrame(frame: LocalFrame) {
    // Keep the detail pattern fixed to the ground: the new origin's position in the old frame is
    // how far the render coordinates of every ground point shift.
    const d = this.frame.fromGeodetic(frame.origin.lon, frame.origin.lat, frame.origin.h, {
      x: 0,
      y: 0,
      z: 0,
    });
    const wrap = (v: number) => ((v % DETAIL_PERIOD) + DETAIL_PERIOD) % DETAIL_PERIOD;
    this.detailOrigin.x = wrap(this.detailOrigin.x + d.x);
    this.detailOrigin.z = wrap(this.detailOrigin.z + d.z);
    this.materials.uniforms.detailOrigin.value.set(this.detailOrigin.x, this.detailOrigin.z);
    this.frame = frame;
    this.terrain?.setFrame(frame);
  }

  /** Drawing buffer size in pixels: the level of detail is measured in screen pixels. */
  setViewport(_width: number, height: number) {
    this.screenHeight = Math.max(1, height);
  }

  /** Colours the water reflects (linear, same units as the sky's own colours). */
  setSkyColors(zenith: Color, horizon: Color) {
    this.materials.uniforms.skyZenith.value.copy(zenith);
    this.materials.uniforms.skyHorizon.value.copy(horizon);
  }

  /** Per frame: load and place what the camera sees. */
  update(camera: Camera) {
    if (!this.terrain) return;
    camera.updateMatrixWorld();
    const frame = this.frame;
    const pos = camera.getWorldPosition(this.v);
    const ecef = frame.toEcef(pos, { x: 0, y: 0, z: 0 });
    const geo = ecefToGeodetic(ecef);
    const dir = camera.getWorldDirection(new Vector3());
    const forward = frame.dirToEcef(dir, { x: 0, y: 0, z: 0 });

    this.m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m, camera.coordinateSystem);
    const origin = frame.originEcef({ x: 0, y: 0, z: 0 });
    this.frustum.planes.forEach((p, i) => {
      const n = frame.dirToEcef(p.normal, { x: 0, y: 0, z: 0 });
      const out = this.planes[i]!;
      out.nx = n.x;
      out.ny = n.y;
      out.nz = n.z;
      out.d = p.constant - (n.x * origin.x + n.y * origin.y + n.z * origin.z);
    });

    const fov = (camera as Camera & { fov?: number }).fov ?? 55;
    const view: ViewState = {
      lon: geo.lon,
      lat: geo.lat,
      h: geo.h,
      ecef,
      forward,
      planes: this.planes,
      pixelsPerRadian: this.screenHeight / (2 * Math.tan((fov * Math.PI) / 180 / 2)),
    };
    this.terrain.update(view);
  }

  /**
   * Height of the ground above the ellipsoid at lon/lat in metres, or undefined while that
   * place is not loaded. Exact against the finest loaded tile's triangles.
   */
  groundHeight(lon: number, lat: number): number | undefined {
    return this.query(lon, lat)?.height;
  }

  /** The ground at lon/lat, or undefined while that place is not loaded. */
  ground(lon: number, lat: number): GroundInfo | undefined {
    const t = this.terrain;
    const node = t?.tree.finestReadyAt(lon, lat);
    if (!t || !node) return undefined;
    const hit = t.surfaceOf(node).query(lon, lat, this.hit);
    if (!hit) return undefined;
    const normal = this.frame.dirToLocal(hit.normal, { x: 0, y: 0, z: 0 });
    // Land cover at the nearest mask pixel.
    const d = node.data!;
    const b = node.bounds;
    const size = d.maskSize;
    const px = Math.min(size - 1, Math.floor(((lon - b.west) / (b.east - b.west)) * size));
    const py = Math.min(size - 1, Math.floor(((b.north - lat) / (b.north - b.south)) * size));
    const i = (py * size + px) * 4;
    const water = d.maskBytes[i]!;
    const cls = d.maskBytes[i + 2]!;
    const near = (v: number, target: number) => Math.abs(v - target) < 24;
    const surface: GroundInfo['surface'] =
      water >= 128
        ? 'water'
        : near(cls, MASK_B_RUNWAY)
          ? 'asphalt'
          : near(cls, MASK_B_GRASS_RUNWAY)
            ? 'grass'
            : cls >= MASK_B_GLACIER - 24
              ? 'snow'
              : 'terrain';
    return { height: hit.height, normal, surface };
  }

  private query(lon: number, lat: number): SurfaceHit | undefined {
    const t = this.terrain;
    const node = t?.tree.finestReadyAt(lon, lat);
    if (!t || !node) return undefined;
    return t.surfaceOf(node).query(lon, lat, this.hit);
  }

  /** Credits of the data shown, for the interface. */
  readonly attribution: string[] = [SWISSTOPO_ATTRIBUTION];

  /** True while tiles for the current view are still loading. */
  get loading(): boolean {
    const t = this.terrain;
    if (!t) return true;
    return t.tree.stats.missing > 0 || t.pendingUploads > 0;
  }

  /** Share of the tiles the current view needs that are loaded, 0..1 (for a loading screen). */
  get progress(): number {
    const t = this.terrain;
    if (!t) return 0;
    const s = t.tree.stats;
    if (s.wanted === 0) return 0;
    return Math.max(0, Math.min(1, (s.wanted - s.missing - t.pendingUploads) / s.wanted));
  }

  stats(): WorldStats {
    const t = this.terrain;
    const s = t?.stats();
    return {
      tilesDrawn: s?.drawn ?? 0,
      tilesLoaded: s?.loaded ?? 0,
      triangles: s?.triangles ?? 0,
      gpuBytes: s?.gpuBytes ?? 0,
      queued: t?.queued ?? 0,
      inFlight: t?.inFlight ?? 0,
      pendingUploads: t?.pendingUploads ?? 0,
      maxZoom: t?.tree.stats.maxZoom ?? 0,
      ...(t?.counters ?? { uploaded: 0, evicted: 0, cancelled: 0, absent: 0, failed: 0 }),
    };
  }

  dispose() {
    this.terrain?.dispose();
    this.materials.dispose();
  }
}
