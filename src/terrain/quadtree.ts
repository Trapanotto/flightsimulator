import * as THREE from 'three';
import {
  CH_BOUNDS,
  MAX_TERRAIN_ZOOM,
  ROOT_TERRAIN_ZOOM,
} from '../geo/constants';
import {
  terrainTileBounds,
  terrainTilesForBounds,
  type GeoBounds,
} from '../geo/tiles';
import { EnuFrame } from '../geo/wgs84';
import type { BuiltTerrainMesh } from './buildMesh';
import { ImageryLoader, TerrainLoader } from './loader';
import type { TerrainProvider } from './provider';

type NodeState = 'idle' | 'queued' | 'ready' | 'error';
type ImageryState = 'none' | 'requested' | 'ready' | 'error';

export interface TerrainNode {
  key: string;
  z: number;
  x: number;
  y: number;
  bounds: GeoBounds;
  center: THREE.Vector3;
  radius: number;
  geometricError: number;
  state: NodeState;
  imageryState: ImageryState;
  mesh?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  children?: TerrainNode[];
  parent?: TerrainNode;
  attempts: number;
  retryAt: number;
  priority: number;
  minHeight?: number;
  maxHeight?: number;
}

export interface TerrainStats {
  loaded: number;
  visible: number;
  textured: number;
  pending: number;
  triangles: number;
  nodes: number;
}

const SSE_THRESHOLD = 1.5;
const MAX_DISTANCE = 110_000;
const MAX_NODES = 520;
const RETRY_DELAY_MS = 6_000;
const MAX_ATTEMPTS = 2;

export class TerrainQuadtree {
  readonly roots: TerrainNode[] = [];
  readonly nodes = new Map<string, TerrainNode>();

  private readonly terrainLoader: TerrainLoader;
  private readonly imageryLoader: ImageryLoader;
  private readonly frame: EnuFrame;
  private readonly scene: THREE.Scene;
  private readonly maxAnisotropy: number;
  private readonly frustum = new THREE.Frustum();
  private readonly projectionView = new THREE.Matrix4();
  private readonly visibleKeys = new Set<string>();
  private loadedCount = 0;
  private texturedCount = 0;

  constructor(
    scene: THREE.Scene,
    provider: TerrainProvider,
    frame: EnuFrame,
    renderer: THREE.WebGLRenderer,
    private maxZoom = MAX_TERRAIN_ZOOM,
  ) {
    this.scene = scene;
    this.frame = frame;
    this.maxAnisotropy = Math.min(
      8,
      renderer.capabilities.getMaxAnisotropy?.() ?? 1,
    );

    this.terrainLoader = new TerrainLoader(
      provider,
      frame.origin,
      (key, mesh) => this.onTerrainDecoded(key, mesh),
      (key, message) => this.onTerrainError(key, message),
    );

    this.imageryLoader = new ImageryLoader(
      (key, bitmap, imageryZ) => this.onImageryReady(key, bitmap, imageryZ),
      (key, message) => this.onImageryError(key, message),
    );

    for (const tile of terrainTilesForBounds(CH_BOUNDS, ROOT_TERRAIN_ZOOM)) {
      const node = this.createNode(tile.z, tile.x, tile.y);
      this.roots.push(node);
      this.nodes.set(node.key, node);
    }
  }

  update(camera: THREE.PerspectiveCamera, viewportHeight: number) {
    camera.updateMatrixWorld();
    this.projectionView.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(this.projectionView);

    this.visibleKeys.clear();

    for (const root of this.roots) {
      this.visit(root, camera, viewportHeight);
    }
  }

  getStats(): TerrainStats {
    let triangles = 0;
    for (const key of this.visibleKeys) {
      const node = this.nodes.get(key);
      const index = node?.mesh?.geometry.index;
      if (node?.mesh?.visible && index) triangles += index.count / 3;
    }

    return {
      loaded: this.loadedCount,
      visible: this.visibleKeys.size,
      textured: this.texturedCount,
      pending:
        this.terrainLoader.pendingCount + this.imageryLoader.pendingCount,
      triangles,
      nodes: this.nodes.size,
    };
  }

  private createNode(z: number, x: number, y: number): TerrainNode {
    const bounds = terrainTileBounds(x, y, z);
    const centerLon = (bounds.west + bounds.east) / 2;
    const centerLat = (bounds.south + bounds.north) / 2;
    const centerEnu = this.frame.toEnu(centerLon, centerLat, 0);
    const west = this.frame.toEnu(bounds.west, centerLat, 0);
    const east = this.frame.toEnu(bounds.east, centerLat, 0);
    const south = this.frame.toEnu(centerLon, bounds.south, 0);
    const north = this.frame.toEnu(centerLon, bounds.north, 0);
    const width = Math.hypot(east.e - west.e, east.n - west.n);
    const height = Math.hypot(north.e - south.e, north.n - south.n);
    const diagonal = Math.hypot(width, height);

    return {
      key: `${z}/${x}/${y}`,
      z,
      x,
      y,
      bounds,
      center: new THREE.Vector3(centerEnu.e, centerEnu.u, -centerEnu.n),
      radius: diagonal / 2 + 4_000,
      geometricError: Math.min(
        1_200,
        Math.max(4, Math.max(width, height) / 128),
      ),
      state: 'idle',
      imageryState: 'none',
      attempts: 0,
      retryAt: 0,
      priority: 0,
    };
  }

  private createChildren(parent: TerrainNode): TerrainNode[] {
    const children: TerrainNode[] = [];

    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const z = parent.z + 1;
        const x = parent.x * 2 + dx;
        const y = parent.y * 2 + dy;
        const key = `${z}/${x}/${y}`;
        const existing = this.nodes.get(key);
        if (existing) {
          existing.parent = parent;
          children.push(existing);
          continue;
        }

        const node = this.createNode(z, x, y);
        node.parent = parent;
        this.nodes.set(key, node);
        children.push(node);
      }
    }

    return children;
  }

  private visit(
    node: TerrainNode,
    camera: THREE.PerspectiveCamera,
    viewportHeight: number,
  ) {
    const distance = camera.position.distanceTo(node.center);
    const sphere = new THREE.Sphere(node.center, node.radius);

    if (!this.frustum.intersectsSphere(sphere) || distance > MAX_DISTANCE) {
      this.hideSubtree(node);
      return;
    }

    const safeDistance = Math.max(10, distance);
    const tanHalfFov = Math.tan(
      THREE.MathUtils.degToRad(camera.fov) / 2,
    );
    const sse =
      (node.geometricError * viewportHeight) /
      (2 * safeDistance * tanHalfFov);
    node.priority = sse;
    const now = performance.now();

    // Do not fan out before the parent exists: serialising the LOD tree keeps
    // the request queue and the number of live tiles under control.
    const canSplit = node.state === 'ready' || node.state === 'error';
    const wantsSplit =
      canSplit && node.z < this.maxZoom && sse > SSE_THRESHOLD;

    if (wantsSplit) {
      if (!node.children && this.nodes.size < MAX_NODES) {
        node.children = this.createChildren(node);
      }

      const children = node.children;

      if (children) {
        for (const child of children) {
          if (child.state === 'idle' && now >= child.retryAt) {
            this.requestNode(child);
          }
        }

        const allReady = children.every(
          (child) => child.state === 'ready',
        );

        if (allReady) {
          if (node.mesh) node.mesh.visible = false;
          for (const child of children) {
            this.visit(child, camera, viewportHeight);
          }
        } else {
          this.showNode(node);
          for (const child of children) this.hideSubtree(child);
        }
      } else {
        this.showNode(node);
      }
    } else {
      this.showNode(node);
      if (node.children) {
        for (const child of node.children) this.hideSubtree(child);
      }
    }

    if (node.state === 'idle' && now >= node.retryAt) {
      this.requestNode(node);
    }
  }

  private requestNode(node: TerrainNode) {
    if (node.state !== 'idle') return;
    if (this.nodes.size > MAX_NODES && node.parent) return;
    node.state = 'queued';
    this.terrainLoader.enqueue(
      node.key,
      node.z,
      node.x,
      node.y,
      node.bounds,
      node.priority,
    );
  }

  private showNode(node: TerrainNode) {
    if (!node.mesh) return;
    if (!node.mesh.visible) node.mesh.visible = true;
    this.visibleKeys.add(node.key);
    this.requestImagery(node);
  }

  private requestImagery(node: TerrainNode) {
    if (node.imageryState !== 'none' || !node.mesh) return;
    node.imageryState = 'requested';
    this.imageryLoader.enqueue(
      node.key,
      node.bounds,
      node.z,
      node.priority,
    );
  }

  private hideSubtree(node: TerrainNode) {
    if (node.mesh) node.mesh.visible = false;
    if (node.children) {
      for (const child of node.children) this.hideSubtree(child);
    }
  }

  private onTerrainDecoded(key: string, built: BuiltTerrainMesh) {
    const node = this.nodes.get(key);
    if (!node) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(built.positions, 3),
    );
    geometry.setAttribute('normal', new THREE.BufferAttribute(built.normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(built.uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(built.indices, 1));
    geometry.computeBoundingSphere();

    if (!built.hasNormals) geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      color: 0x5f6f50,
      roughness: 0.96,
      metalness: 0,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `terrain-${key}`;
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.scene.add(mesh);

    node.mesh = mesh;
    node.state = 'ready';
    node.minHeight = built.minHeight;
    node.maxHeight = built.maxHeight;
    this.loadedCount++;
  }

  private onTerrainError(key: string, message: string) {
    const node = this.nodes.get(key);
    if (!node) return;

    node.attempts++;
    console.warn(`[terrain] ${key}: ${message} (attempt ${node.attempts})`);

    if (node.attempts < MAX_ATTEMPTS) {
      node.state = 'idle';
      node.retryAt = performance.now() + RETRY_DELAY_MS;
    } else {
      node.state = 'error';
    }
  }

  private onImageryReady(key: string, bitmap: ImageBitmap, _imageryZ: number) {
    const node = this.nodes.get(key);
    if (!node?.mesh) {
      bitmap.close();
      return;
    }

    const texture = new THREE.Texture(bitmap);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.maxAnisotropy;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;

    const material = node.mesh.material;
    material.map = texture;
    material.color.setHex(0xffffff);
    material.needsUpdate = true;
    node.imageryState = 'ready';
    this.texturedCount++;
  }

  private onImageryError(key: string, message: string) {
    const node = this.nodes.get(key);
    if (node) node.imageryState = 'error';
    console.warn(`[imagery] ${key}: ${message}`);
  }

  dispose() {
    this.terrainLoader.dispose();
    this.imageryLoader.dispose();

    for (const node of this.nodes.values()) {
      if (!node.mesh) continue;
      this.scene.remove(node.mesh);
      node.mesh.geometry.dispose();
      node.mesh.material.map?.dispose();
      node.mesh.material.dispose();
    }

    this.nodes.clear();
    this.roots.length = 0;
    this.visibleKeys.clear();
  }
}
