import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshLambertMaterial,
  SRGBColorSpace,
  Sphere,
  Texture,
  Vector3,
} from 'three';
import { WorkerPool } from '../core/WorkerPool';
import type { EnuFrame } from '../geo/ellipsoid';
import { type TileKey, geoTileBounds, tileId } from '../geo/tiles';
import { SWISSIMAGE_TEMPLATE, type TerrainSource } from './sources';
import type { ImageryJob, ImageryResult, TerrainJob, TerrainResult } from './workerTypes';

/** Imagery is fetched this many zoom levels deeper than the terrain tile (≈ 512 px per tile). */
const IMAGERY_ZOOM_OFFSET = 2;
const TEXTURE_SIZE = 512;

export interface LoaderStats {
  total: number;
  loaded: number;
  failed: number;
  terrainInFlight: number;
  imageryInFlight: number;
  queued: number;
}

/**
 * Phase 1 loader: loads a fixed list of tiles once and keeps them.
 * Phase 2 replaces the fixed list with a streaming quadtree.
 */
export class TerrainLoader {
  readonly group = new Group();
  private readonly terrainPool: WorkerPool<TerrainJob, TerrainResult>;
  private readonly imageryPool: WorkerPool<ImageryJob, ImageryResult>;
  private total = 0;
  private loaded = 0;
  private failed = 0;

  constructor(
    private readonly source: TerrainSource,
    private readonly frame: EnuFrame,
    private readonly anisotropy: number,
  ) {
    const cores = navigator.hardwareConcurrency || 4;
    const size = Math.max(1, Math.min(2, cores - 2));
    // In-flight caps keep us at ≈ 10 parallel requests (fair use, see concept ch. 19).
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

  get stats(): LoaderStats {
    return {
      total: this.total,
      loaded: this.loaded,
      failed: this.failed,
      terrainInFlight: this.terrainPool.inFlight,
      imageryInFlight: this.imageryPool.inFlight,
      queued: this.terrainPool.queued + this.imageryPool.queued,
    };
  }

  /** Higher priority loads first. */
  load(tiles: Array<{ key: TileKey; priority: number }>, onTile?: () => void) {
    this.total += tiles.length;
    for (const { key, priority } of tiles) {
      void this.loadTile(key, priority).then(
        () => {
          this.loaded++;
          onTile?.();
        },
        (err) => {
          this.failed++;
          console.warn(`terrain tile ${tileId(key)} failed:`, err);
          onTile?.();
        },
      );
    }
  }

  private async loadTile(key: TileKey, priority: number) {
    const bounds = geoTileBounds(key);
    const terrain = this.terrainPool.submit(
      { url: this.source.url(key.z, key.x, key.y), bounds, frame: this.frame },
      priority,
    );
    const imagery = this.imageryPool.submit(
      {
        template: SWISSIMAGE_TEMPLATE,
        bounds,
        zoom: Math.min(19, key.z + IMAGERY_ZOOM_OFFSET),
        size: TEXTURE_SIZE,
      },
      priority,
    );
    const [mesh, img] = await Promise.all([terrain.promise, imagery.promise]);

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
    geometry.setAttribute('uv', new BufferAttribute(mesh.uvs, 2));
    geometry.setIndex(new BufferAttribute(mesh.indices, 1));
    geometry.boundingSphere = new Sphere(new Vector3(...mesh.sphereCenter), mesh.sphereRadius);

    const texture = new Texture(img.bitmap);
    texture.flipY = false;
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = this.anisotropy;
    texture.needsUpdate = true;

    const tile = new Mesh(geometry, new MeshLambertMaterial({ map: texture }));
    tile.name = tileId(key);
    tile.position.set(...mesh.offset);
    tile.matrixAutoUpdate = false;
    tile.updateMatrix();
    this.group.add(tile);
  }

  dispose() {
    this.terrainPool.dispose();
    this.imageryPool.dispose();
    this.group.traverse((o) => {
      if (o instanceof Mesh) {
        o.geometry.dispose();
        const m = o.material as MeshLambertMaterial;
        m.map?.dispose();
        m.dispose();
      }
    });
  }
}
