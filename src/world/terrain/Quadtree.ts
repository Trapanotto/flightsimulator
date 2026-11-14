import {
  type GeoBounds,
  type TileKey,
  type Vec3Like,
  boundsIntersect,
  distanceToBounds,
  geoTileBounds,
  geoTileChildren,
  geoTileWidthMetres,
  geodeticToEcef,
} from '@geo';

/**
 * Geographic quadtree with screen-space-error level of detail. Pure maths and bookkeeping (no
 * renderer), so the selection is tested in Node.
 *
 * Everything is kept in ECEF and geodetic coordinates, so nothing here changes when the render
 * frame moves (floating origin): the caller hands in the frustum planes in ECEF.
 */

export type TileState = 'idle' | 'loading' | 'ready' | 'failed';

/** Plane in ECEF: points with nx·x + ny·y + nz·z + d >= 0 are on the inner side. */
export interface Plane {
  nx: number;
  ny: number;
  nz: number;
  d: number;
}

/** Everything the selection needs to know about the camera this frame. */
export interface ViewState {
  /** Camera position: geodetic (height above the ellipsoid) and ECEF. */
  lon: number;
  lat: number;
  h: number;
  ecef: Vec3Like;
  /** Unit view direction in ECEF (for priorities). */
  forward: Vec3Like;
  /** Frustum planes in ECEF (usually 6); empty = no culling. */
  planes: Plane[];
  /** Pixels per radian at the screen centre: screenHeight / (2 tan(fovY / 2)). */
  pixelsPerRadian: number;
}

export interface QuadtreeOptions {
  /** Root tiles, all at the same zoom. */
  roots: TileKey[];
  /** Deepest zoom inside `detailBounds`, and outside of it. */
  maxZoom: number;
  maxZoomOutside: number;
  detailBounds: GeoBounds;
  /** Texture pixels across a tile: the error of a tile is its width / this. */
  texelsPerTile: number;
  /** Largest allowed screen size of a texel (pixels) before a tile is split. */
  maxTexelPx: number;
  /** Nothing farther than this (metres, horizontal) is drawn or loaded. */
  viewDistance: number;
  /** Frames a download may stay unrequested before it is cancelled. */
  staleFrames: number;
}

/** Ellipsoid height range a tile is assumed to span before its data is known. */
const UNKNOWN_MIN_H = -100;
const UNKNOWN_MAX_H = 4900;

export class TileNode<T = unknown> {
  readonly bounds: GeoBounds;
  /** Metres of ground per texture pixel: the error this tile may show. */
  readonly texelMetres: number;
  /** Bounding sphere in ECEF. */
  readonly center = { x: 0, y: 0, z: 0 };
  radius = 0;
  state: TileState = 'idle';
  children?: TileNode<T>[];
  /** A child could not be loaded (outside the data): this node stays a leaf. */
  childrenFailed = false;
  minH: number;
  maxH: number;
  /** Frame stamps of the last use (rendered or needed as fallback) and request. */
  lastUsed = -1;
  lastRequested = -1;
  /** Higher loads first. */
  priority = 0;
  /** Showed its children last frame (for hysteresis). */
  refined = false;
  /** Per-frame cache of canDraw(). */
  private drawStamp = -1;
  private drawValue = false;
  /** Data of the provider (GPU mesh, height surface, ...). */
  data?: T;

  constructor(
    readonly key: TileKey,
    readonly parent: TileNode<T> | undefined,
    /** Inside the detail area: may refine down to the full max zoom. */
    readonly inside: boolean,
    texelsPerTile: number,
    minH = UNKNOWN_MIN_H,
    maxH = UNKNOWN_MAX_H,
  ) {
    this.bounds = geoTileBounds(key);
    this.texelMetres = geoTileWidthMetres(key) / texelsPerTile;
    this.minH = minH;
    this.maxH = maxH;
    this.updateSphere();
  }

  /** Sphere around the tile from corners, edge midpoints and centre at both height limits. */
  updateSphere() {
    const b = this.bounds;
    const lons = [b.west, (b.west + b.east) / 2, b.east];
    const lats = [b.south, (b.south + b.north) / 2, b.north];
    const pts: Vec3Like[] = [];
    for (const lon of lons)
      for (const lat of lats)
        for (const h of [this.minH, this.maxH])
          pts.push(geodeticToEcef(lon, lat, h, { x: 0, y: 0, z: 0 }));
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of pts) {
      cx += p.x;
      cy += p.y;
      cz += p.z;
    }
    cx /= pts.length;
    cy /= pts.length;
    cz /= pts.length;
    let r = 0;
    for (const p of pts) r = Math.max(r, Math.hypot(p.x - cx, p.y - cy, p.z - cz));
    this.center.x = cx;
    this.center.y = cy;
    this.center.z = cz;
    // Edges bulge between the sampled points (Earth curvature); a small margin covers them.
    this.radius = r * 1.02;
  }

  contains(lon: number, lat: number) {
    const b = this.bounds;
    return lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;
  }

  /** True if this tile, or all its children recursively, can be drawn this frame. */
  canDraw(frame: number): boolean {
    if (this.state === 'ready') return true;
    if (this.drawStamp === frame) return this.drawValue;
    this.drawStamp = frame;
    this.drawValue = !!this.children && this.children.every((c) => c.canDraw(frame));
    return this.drawValue;
  }
}

/** Starts and stops tile loads. Implemented by the terrain streamer, faked in tests. */
export interface TileProvider<T> {
  request(node: TileNode<T>): void;
  /** Stops a load; the node goes back to idle. */
  cancel(node: TileNode<T>): void;
}

export interface SelectionStats {
  /** Tiles drawn this frame. */
  rendered: number;
  /** Tiles this frame wants that are not loaded yet. */
  missing: number;
  /** Tiles this frame wants in total (loaded or not). */
  wanted: number;
  loading: number;
  ready: number;
  maxZoom: number;
}

/**
 * Selects the tiles to draw. A tile is replaced by its children only when every visible child
 * can be drawn, so the surface never has holes; until then the parent stays. Invisible children
 * are loaded too (at low priority), so turning the camera does not fall back to coarse tiles.
 */
export class Quadtree<T = unknown> {
  readonly roots: TileNode<T>[];
  readonly rendered: TileNode<T>[] = [];
  readonly loading = new Set<TileNode<T>>();
  readonly ready = new Set<TileNode<T>>();
  readonly stats: SelectionStats = {
    rendered: 0,
    missing: 0,
    wanted: 0,
    loading: 0,
    ready: 0,
    maxZoom: 0,
  };
  private frame = 0;
  private view!: ViewState;
  /**
   * Ask for all levels of the view at once instead of each level after its parent has
   * arrived (ten round trips from the roots to the finest tiles). The tiles below a parent
   * that is still loading are picked with its height range unknown, so a few too many are
   * loaded: right behind a loading screen, wasteful while flying.
   */
  eager = false;

  constructor(
    readonly opts: QuadtreeOptions,
    private readonly provider: TileProvider<T>,
  ) {
    this.roots = opts.roots.map(
      (k) => new TileNode<T>(k, undefined, this.isInside(k), opts.texelsPerTile),
    );
  }

  get frameNumber() {
    return this.frame;
  }

  update(view: ViewState) {
    this.frame++;
    this.view = view;
    this.rendered.length = 0;
    const s = this.stats;
    s.missing = 0;
    s.wanted = 0;
    s.maxZoom = 0;

    for (const root of this.roots) {
      root.lastUsed = this.frame;
      if (!this.inRange(root)) continue;
      const visible = this.visible(root);
      if (root.canDraw(this.frame)) {
        if (visible) this.select(root);
        else this.want(root, 0);
      } else {
        this.want(root, visible ? 1e6 : 1);
        // Children loaded while the root was evicted can still stand in for it.
        if (visible && root.children?.every((c) => c.canDraw(this.frame)))
          for (const c of root.children) this.select(c);
      }
    }

    // Downloads nobody asked for recently: the camera moved on.
    for (const node of [...this.loading]) {
      if (node.lastRequested < this.frame - this.opts.staleFrames) {
        this.loading.delete(node);
        node.state = 'idle';
        this.provider.cancel(node);
      }
    }
    s.rendered = this.rendered.length;
    s.loading = this.loading.size;
    s.ready = this.ready.size;
  }

  /** The provider finished loading a node. Height range in metres above the ellipsoid. */
  markReady(node: TileNode<T>, minH: number, maxH: number) {
    node.state = 'ready';
    this.loading.delete(node);
    this.ready.add(node);
    node.minH = minH;
    node.maxH = maxH;
    node.updateSphere();
    // Children so far assumed the full Alpine height range; the parent's is much tighter.
    for (const c of node.children ?? []) {
      if (c.state === 'ready') continue;
      c.minH = minH;
      c.maxH = maxH;
      c.updateSphere();
    }
  }

  /** The node does not exist at the source (outside coverage): keep its parent as the leaf. */
  markFailed(node: TileNode<T>) {
    node.state = 'failed';
    this.loading.delete(node);
    if (node.parent) node.parent.childrenFailed = true;
  }

  /** A load failed for a passing reason (network): it may be tried again later. */
  markIdle(node: TileNode<T>) {
    node.state = 'idle';
    this.loading.delete(node);
  }

  /**
   * Ready tiles that may be freed so that at most `maxReady` stay, least recently used first.
   * Roots and tiles used in the last frames are kept.
   */
  evictionCandidates(maxReady: number): TileNode<T>[] {
    const excess = this.ready.size - maxReady;
    if (excess <= 0) return [];
    const old: TileNode<T>[] = [];
    for (const n of this.ready) if (n.parent && n.lastUsed < this.frame - 2) old.push(n);
    old.sort((a, b) => a.lastUsed - b.lastUsed || b.key.z - a.key.z);
    return old.slice(0, excess);
  }

  /** The provider freed a node's data. */
  markEvicted(node: TileNode<T>) {
    node.state = 'idle';
    node.data = undefined;
    this.ready.delete(node);
  }

  /** The most detailed ready tile containing lon/lat, or undefined. */
  finestReadyAt(lon: number, lat: number): TileNode<T> | undefined {
    let found: TileNode<T> | undefined;
    let level: TileNode<T>[] | undefined = this.roots;
    while (level) {
      const node: TileNode<T> | undefined = level.find((c) => c.contains(lon, lat));
      if (!node) break;
      if (node.state === 'ready') found = node;
      level = node.children;
    }
    return found;
  }

  private select(node: TileNode<T>) {
    node.lastUsed = this.frame;
    const sse = this.sse(node);
    const maxZoom = node.inside ? this.opts.maxZoom : this.opts.maxZoomOutside;
    // Hysteresis: a refined tile merges back only clearly below the threshold, so tiles do not
    // flip between two levels while the camera hovers at the boundary.
    const limit = node.refined ? this.opts.maxTexelPx * 0.85 : this.opts.maxTexelPx;
    const wantsMore = node.key.z < maxZoom && !node.childrenFailed && sse > limit;

    if (wantsMore) {
      const children = this.ensureChildren(node);
      let drawable = true;
      for (const c of children) {
        c.lastUsed = this.frame;
        if (!this.inRange(c)) continue;
        const inView = this.visible(c);
        if (c.state !== 'ready') {
          this.want(c, this.priority(c, inView));
          if (this.eager && inView) this.ahead(c);
        }
        if (inView && !c.canDraw(this.frame)) drawable = false;
      }
      if (drawable) {
        node.refined = true;
        for (const c of children) if (this.inRange(c) && this.visible(c)) this.select(c);
        return;
      }
    }
    node.refined = false;
    if (node.state === 'ready') {
      this.rendered.push(node);
      if (node.key.z > this.stats.maxZoom) this.stats.maxZoom = node.key.z;
    } else {
      // Not loaded (evicted) but its children are: they stand in, and the node reloads.
      this.want(node, this.priority(node, true));
      for (const c of node.children ?? []) if (this.inRange(c) && this.visible(c)) this.select(c);
    }
  }

  /** Asks for the visible tiles below a node that is not loaded yet, by the rule of select. */
  private ahead(node: TileNode<T>) {
    const maxZoom = node.inside ? this.opts.maxZoom : this.opts.maxZoomOutside;
    if (node.key.z >= maxZoom || node.childrenFailed || node.state === 'failed') return;
    if (this.sse(node) <= this.opts.maxTexelPx) return;
    for (const c of this.ensureChildren(node)) {
      c.lastUsed = this.frame;
      if (c.state === 'ready' || !this.inRange(c) || !this.visible(c)) continue;
      this.want(c, this.priority(c, true));
      this.ahead(c);
    }
  }

  private want(node: TileNode<T>, priority: number) {
    this.stats.wanted++;
    node.lastRequested = this.frame;
    node.priority = priority;
    if (node.state === 'ready' || node.state === 'failed') return;
    this.stats.missing++;
    if (node.state === 'idle') {
      node.state = 'loading';
      this.loading.add(node);
      this.provider.request(node);
    }
  }

  /** Visible tiles first, coarse before fine (they are the fallback), ahead before behind. */
  private priority(node: TileNode<T>, inView: boolean): number {
    const v = this.view;
    const dx = node.center.x - v.ecef.x;
    const dy = node.center.y - v.ecef.y;
    const dz = node.center.z - v.ecef.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const ahead = Math.max(0, (dx * v.forward.x + dy * v.forward.y + dz * v.forward.z) / len);
    const base = (inView ? 1000 : 10) / (1 + node.key.z);
    return base * (1 + ahead) + this.sse(node) * 0.01;
  }

  /** Screen size in pixels of one texel of the tile at its nearest point. */
  sse(node: TileNode<T>): number {
    return (node.texelMetres * this.view.pixelsPerRadian) / Math.max(1, this.distance(node));
  }

  /** Distance from the camera to the nearest point of the tile's box (metres). */
  distance(node: TileNode<T>): number {
    const v = this.view;
    const horizontal = distanceToBounds(v.lon, v.lat, node.bounds);
    const vertical = v.h < node.minH ? node.minH - v.h : v.h > node.maxH ? v.h - node.maxH : 0;
    return Math.hypot(horizontal, vertical);
  }

  private inRange(node: TileNode<T>): boolean {
    return distanceToBounds(this.view.lon, this.view.lat, node.bounds) <= this.opts.viewDistance;
  }

  private visible(node: TileNode<T>): boolean {
    const c = node.center;
    for (const p of this.view.planes)
      if (p.nx * c.x + p.ny * c.y + p.nz * c.z + p.d < -node.radius) return false;
    return true;
  }

  private ensureChildren(node: TileNode<T>): TileNode<T>[] {
    node.children ??= geoTileChildren(node.key).map(
      (k) =>
        new TileNode<T>(k, node, this.isInside(k), this.opts.texelsPerTile, node.minH, node.maxH),
    );
    return node.children;
  }

  private isInside(key: TileKey): boolean {
    return boundsIntersect(geoTileBounds(key), this.opts.detailBounds);
  }
}
