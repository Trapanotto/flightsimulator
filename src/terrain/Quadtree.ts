import { Box3, type Frustum, Vector3 } from 'three';
import { DEG, type EnuFrame, ecefToLocal, geodeticToEcef } from '../geo/ellipsoid';
import { type GeoBounds, type TileKey, geoTileBounds, geoTileSpan } from '../geo/tiles';
import { sampleHeightGrid } from './heightGrid';

export type TileState = 'idle' | 'loading' | 'ready' | 'failed';

export class TileNode {
  readonly bounds: GeoBounds;
  readonly box = new Box3();
  readonly center = new Vector3();
  /** Geometric error in metres: how far this tile may deviate from the full-detail surface. */
  readonly error: number;
  state: TileState = 'idle';
  children?: TileNode[];
  /** A child could not be loaded (e.g. outside data coverage): treat this node as a leaf. */
  childrenFailed = false;
  minH: number;
  maxH: number;
  heights?: Float32Array;
  lastUsed = -1;
  lastRequested = -1;
  priority = 0;

  constructor(
    readonly key: TileKey,
    readonly parent: TileNode | undefined,
    /** Inside the detail area (Switzerland): may refine up to the full max zoom. */
    readonly inside: boolean,
    frame: EnuFrame,
    minH: number,
    maxH: number,
  ) {
    this.bounds = geoTileBounds(key);
    const latC = (this.bounds.south + this.bounds.north) / 2;
    const widthM = geoTileSpan(key.z) * 111_320 * Math.cos(latC * DEG);
    this.error = widthM / 64;
    this.minH = minH;
    this.maxH = maxH;
    this.updateBox(frame);
  }

  /** Box from corners, edge midpoints and centre at min/max height (covers earth curvature). */
  updateBox(frame: EnuFrame) {
    const b = this.bounds;
    this.box.makeEmpty();
    const p = new Vector3();
    for (const lon of [b.west, (b.west + b.east) / 2, b.east]) {
      for (const lat of [b.south, (b.south + b.north) / 2, b.north]) {
        for (const h of [this.minH, this.maxH]) {
          p.set(...ecefToLocal(frame, ...geodeticToEcef(lon, lat, h)));
          this.box.expandByPoint(p);
        }
      }
    }
    this.box.getCenter(this.center);
  }

  contains(lon: number, lat: number) {
    const b = this.bounds;
    return lon >= b.west && lon < b.east && lat >= b.south && lat < b.north;
  }
}

/** Starts and cancels tile downloads. Implemented by TerrainEngine; faked in tests. */
export interface TileProvider {
  request(node: TileNode): void;
  /** Returns true if the download was stopped and the node is idle again. */
  cancel(node: TileNode): boolean;
}

export interface QuadtreeOptions {
  /** Root tiles, all at the same zoom. */
  roots: { z: number; x0: number; x1: number; y0: number; y1: number };
  /** Max zoom inside `detailBounds` (Switzerland) and outside of it. */
  maxZoom: number;
  maxZoomOutside: number;
  detailBounds: GeoBounds;
  /** Max screen-space error in pixels before a tile is split. */
  tau: number;
}

export interface SelectionStats {
  rendered: number;
  /** Rendered tiles that want more detail whose children are still loading. */
  pending: number;
  loading: number;
  ready: number;
  maxZoomRendered: number;
}

/** Frames a queued download may go unrequested before it is cancelled. */
const STALE_FRAMES = 30;

/**
 * Geographic quadtree with screen-space-error LOD.
 * A tile is replaced by its four children only once all four are loaded,
 * so the surface never has holes; until then the parent stays visible.
 */
export class Quadtree {
  readonly roots: TileNode[] = [];
  readonly rendered: TileNode[] = [];
  readonly loading = new Set<TileNode>();
  readonly ready = new Set<TileNode>();
  stats: SelectionStats = { rendered: 0, pending: 0, loading: 0, ready: 0, maxZoomRendered: 0 };

  private frame = 0;
  private readonly tmpBox = new Box3();
  private readonly toNode = new Vector3();
  private camera = new Vector3();
  private forward = new Vector3();
  private shift = new Vector3();
  private frustum!: Frustum;
  private k = 1;

  constructor(
    private readonly enu: EnuFrame,
    private readonly opts: QuadtreeOptions,
    private readonly provider: TileProvider,
  ) {
    const r = opts.roots;
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const key = { z: r.z, x, y };
        this.roots.push(new TileNode(key, undefined, this.isInside(key), enu, -100, 4800));
      }
    }
  }

  setTau(tau: number) {
    this.opts.tau = tau;
  }

  setMaxZoom(z: number) {
    this.opts.maxZoom = z;
  }

  /**
   * Selects the tiles to draw this frame and queues downloads.
   * camera/forward are in base-frame coordinates; the frustum is in shifted (render) coordinates,
   * `shift` converts base -> render (render = base - shift).
   */
  update(
    camera: Vector3,
    forward: Vector3,
    frustum: Frustum,
    shift: Vector3,
    screenHeight: number,
    fovYRad: number,
  ) {
    this.frame++;
    this.camera.copy(camera);
    this.forward.copy(forward).normalize();
    this.shift.copy(shift);
    this.frustum = frustum;
    this.k = screenHeight / (2 * Math.tan(fovYRad / 2));
    this.rendered.length = 0;
    const s = this.stats;
    s.pending = 0;
    s.maxZoomRendered = 0;

    for (const root of this.roots) {
      if (!this.visible(root)) continue;
      root.lastUsed = this.frame;
      if (root.state === 'ready') this.select(root);
      else this.request(root, 1e9);
    }

    // Cancel downloads nobody asked for recently (the camera moved on).
    for (const node of this.loading) {
      if (node.lastRequested < this.frame - STALE_FRAMES && this.provider.cancel(node)) {
        this.loading.delete(node);
      }
    }

    s.rendered = this.rendered.length;
    s.loading = this.loading.size;
    s.ready = this.ready.size;
  }

  /** Called by the provider when a tile's data is on the GPU. */
  markReady(node: TileNode, minH: number, maxH: number, heights: Float32Array) {
    node.state = 'ready';
    node.minH = minH;
    node.maxH = maxH;
    node.heights = heights;
    node.updateBox(this.enu);
    this.loading.delete(node);
    this.ready.add(node);
    // Children so far used the parent's height range; tighten it.
    node.children?.forEach((c) => {
      if (c.state !== 'ready') {
        c.minH = minH;
        c.maxH = maxH;
        c.updateBox(this.enu);
      }
    });
  }

  markFailed(node: TileNode) {
    node.state = 'failed';
    this.loading.delete(node);
    if (node.parent) node.parent.childrenFailed = true;
  }

  markIdle(node: TileNode) {
    node.state = 'idle';
    this.loading.delete(node);
  }

  /**
   * Returns ready tiles that may be freed, least recently used first, so that at most
   * `maxReady` stay loaded. Root tiles and tiles used in the last frames are kept.
   */
  evictionCandidates(maxReady: number): TileNode[] {
    const excess = this.ready.size - maxReady;
    if (excess <= 0) return [];
    const old: TileNode[] = [];
    for (const n of this.ready) {
      if (n.parent && n.lastUsed < this.frame - 2) old.push(n);
    }
    old.sort((a, b) => a.lastUsed - b.lastUsed);
    return old.slice(0, excess);
  }

  /** Called after the provider freed a node's GPU data. */
  markEvicted(node: TileNode) {
    node.state = 'idle';
    node.heights = undefined;
    this.ready.delete(node);
  }

  /** Terrain height (m) at lon/lat from the most detailed loaded tile, or undefined. */
  heightAt(lon: number, lat: number): number | undefined {
    let node: TileNode | undefined = this.roots.find((r) => r.contains(lon, lat));
    if (!node || node.state !== 'ready') return undefined;
    for (;;) {
      const child: TileNode | undefined = node.children?.find((c) => c.contains(lon, lat));
      if (!child || child.state !== 'ready') break;
      node = child;
    }
    const b = node.bounds;
    return sampleHeightGrid(
      node.heights!,
      (lon - b.west) / (b.east - b.west),
      (lat - b.south) / (b.north - b.south),
    );
  }

  /** Zoom of the most detailed loaded tile containing lon/lat (0 if none). */
  detailAt(lon: number, lat: number): number {
    let node: TileNode | undefined = this.roots.find((r) => r.contains(lon, lat));
    if (!node || node.state !== 'ready') return 0;
    for (;;) {
      const child: TileNode | undefined = node.children?.find((c) => c.contains(lon, lat));
      if (!child || child.state !== 'ready') return node.key.z;
      node = child;
    }
  }

  private select(node: TileNode) {
    const sse = this.sse(node);
    const maxZoom = node.inside ? this.opts.maxZoom : this.opts.maxZoomOutside;
    const wantsMore = node.key.z < maxZoom && sse > this.opts.tau && !node.childrenFailed;

    if (wantsMore) {
      const children = this.ensureChildren(node);
      let allReady = true;
      for (const c of children) {
        // Siblings outside the view still count as used, so they are not evicted.
        c.lastUsed = this.frame;
        if (c.state !== 'ready') {
          allReady = false;
          if (c.state === 'idle' || c.state === 'loading') this.request(c, this.priority(c));
        }
      }
      if (allReady) {
        for (const c of children) if (this.visible(c)) this.select(c);
        return;
      }
      this.stats.pending++;
    }
    this.rendered.push(node);
    if (node.key.z > this.stats.maxZoomRendered) this.stats.maxZoomRendered = node.key.z;
  }

  private request(node: TileNode, priority: number) {
    node.lastRequested = this.frame;
    node.priority = priority;
    if (node.state === 'idle') {
      node.state = 'loading';
      this.loading.add(node);
      this.provider.request(node);
    }
  }

  /** Screen-space error favouring tiles ahead of the camera. */
  private priority(node: TileNode): number {
    this.toNode.copy(node.center).sub(this.camera).normalize();
    const ahead = Math.max(0, this.toNode.dot(this.forward));
    return this.sse(node) * (1 + 0.5 * ahead);
  }

  private sse(node: TileNode): number {
    const d = Math.max(1, node.box.distanceToPoint(this.camera));
    return (node.error * this.k) / d;
  }

  private visible(node: TileNode): boolean {
    this.tmpBox.copy(node.box).translate(this.toNode.copy(this.shift).negate());
    return this.frustum.intersectsBox(this.tmpBox);
  }

  private ensureChildren(node: TileNode): TileNode[] {
    if (!node.children) {
      const { z, x, y } = node.key;
      node.children = [0, 1, 2, 3].map((i) => {
        const key = { z: z + 1, x: x * 2 + (i & 1), y: y * 2 + (i >> 1) };
        return new TileNode(key, node, this.isInside(key), this.enu, node.minH, node.maxH);
      });
    }
    return node.children;
  }

  private isInside(key: TileKey): boolean {
    const b = geoTileBounds(key);
    const d = this.opts.detailBounds;
    return b.east > d.west && b.west < d.east && b.north > d.south && b.south < d.north;
  }
}
