import { describe, expect, it } from 'vitest';
import { geoTileAt, geoTileBounds, geodeticToEcef, upAt } from '../../src/geo';
import {
  type Plane,
  Quadtree,
  type QuadtreeOptions,
  type TileNode,
  type ViewState,
} from '../../src/world/terrain/Quadtree';

/** Records requests; the test decides when tiles "arrive". */
class FakeProvider {
  requested: TileNode[] = [];
  cancelled: TileNode[] = [];
  request(n: TileNode) {
    this.requested.push(n);
  }
  cancel(n: TileNode) {
    this.cancelled.push(n);
  }
}

const OPTS: QuadtreeOptions = {
  roots: [
    { z: 8, x: 266, y: 194 },
    { z: 8, x: 267, y: 194 },
  ],
  maxZoom: 16,
  maxZoomOutside: 11,
  detailBounds: { west: 5.9, south: 45.8, east: 10.5, north: 47.85 },
  texelsPerTile: 256,
  maxTexelPx: 1.5,
  viewDistance: 150_000,
  staleFrames: 5,
};

function view(lon: number, lat: number, h: number, planes: Plane[] = []): ViewState {
  const up = upAt(lon, lat, { x: 0, y: 0, z: 0 });
  return {
    lon,
    lat,
    h,
    ecef: geodeticToEcef(lon, lat, h, { x: 0, y: 0, z: 0 }),
    forward: { x: -up.x, y: -up.y, z: -up.z },
    planes,
    pixelsPerRadian: 1080 / (2 * Math.tan((55 * Math.PI) / 360)),
  };
}

/** Lets every requested tile arrive (heights of the Swiss plateau) and runs a frame. */
function settle(tree: Quadtree, p: FakeProvider, v: ViewState, rounds = 30) {
  for (let i = 0; i < rounds; i++) {
    tree.update(v);
    const pending = [...tree.loading];
    if (pending.length === 0 && i > 0) break;
    for (const n of pending) tree.markReady(n, 500, 1200);
    p.requested.length = 0;
  }
  tree.update(v);
}

const BELP = { lon: 7.4972, lat: 46.9122 };

describe('quadtree selection', () => {
  it('loads the roots first and draws nothing until they are there', () => {
    const p = new FakeProvider();
    const tree = new Quadtree(OPTS, p);
    tree.update(view(BELP.lon, BELP.lat, 1000));
    expect(p.requested.map((n) => n.key.z)).toEqual([8, 8]);
    expect(tree.rendered).toHaveLength(0);
    expect(tree.stats.missing).toBe(2);
  });

  it('refines near the camera and stays coarse far away', () => {
    const p = new FakeProvider();
    const tree = new Quadtree(OPTS, p);
    const v = view(BELP.lon, BELP.lat, 1100);
    settle(tree, p, v);
    expect(tree.stats.missing).toBe(0);
    const below = tree.rendered.find((n) => n.contains(BELP.lon, BELP.lat))!;
    expect(below.key.z).toBe(OPTS.maxZoom);
    // A tile at the far edge of the roots is much coarser.
    const far = tree.rendered.find((n) => n.contains(8.3, 47.0))!;
    expect(far.key.z).toBeLessThan(13);
    // Screen-space rule: every drawn tile that could split shows its texels at most this big.
    for (const n of tree.rendered) {
      if (n.key.z < OPTS.maxZoom) expect(tree.sse(n)).toBeLessThanOrEqual(OPTS.maxTexelPx);
    }
  });

  it('covers the area exactly once: no holes, no overlaps', () => {
    const p = new FakeProvider();
    const tree = new Quadtree(OPTS, p);
    settle(tree, p, view(BELP.lon, BELP.lat, 600));
    let area = 0;
    for (const n of tree.rendered) {
      const b = n.bounds;
      area += (b.east - b.west) * (b.north - b.south);
    }
    const roots = OPTS.roots.map(geoTileBounds);
    const rootArea = roots.reduce((s, b) => s + (b.east - b.west) * (b.north - b.south), 0);
    expect(area).toBeCloseTo(rootArea, 10);
    // Random points are inside exactly one drawn tile.
    for (let k = 0; k < 200; k++) {
      const lon = 7.03125 + ((k * 0.6180339887) % 1) * 1.40625;
      const lat = 46.40625 + ((k * 0.4142135623) % 1) * 0.703125;
      const inside = tree.rendered.filter((n) => n.contains(lon, lat));
      expect(inside.length).toBeGreaterThanOrEqual(1);
      expect(inside.length).toBeLessThanOrEqual(2); // on a shared edge
    }
  });

  it('keeps the parent until all four children are loaded', () => {
    const p = new FakeProvider();
    const tree = new Quadtree(OPTS, p);
    const v = view(BELP.lon, BELP.lat, 1100);
    tree.update(v);
    for (const n of [...tree.loading]) tree.markReady(n, 500, 1200);
    tree.update(v);
    const root = tree.roots.find((r) => r.contains(BELP.lon, BELP.lat))!;
    expect(root.children).toHaveLength(4);
    // Three of four children arrive: the root is still drawn, none of its children.
    root.children!.slice(0, 3).forEach((c) => tree.markReady(c, 500, 1200));
    tree.update(v);
    expect(tree.rendered).toContain(root);
    expect(tree.rendered.some((n) => n.parent === root)).toBe(false);
    tree.markReady(root.children![3]!, 500, 1200);
    tree.update(v);
    expect(tree.rendered).not.toContain(root);
    expect(tree.rendered.filter((n) => n.parent === root)).toHaveLength(4);
  });

  it('keeps the parent as leaf where the source has no children', () => {
    const p = new FakeProvider();
    const tree = new Quadtree(OPTS, p);
    const v = view(BELP.lon, BELP.lat, 1100);
    tree.update(v);
    for (const n of [...tree.loading]) tree.markReady(n, 500, 1200);
    tree.update(v);
    const root = tree.roots.find((r) => r.contains(BELP.lon, BELP.lat))!;
    tree.markFailed(root.children![0]!);
    for (const c of root.children!.slice(1)) tree.markReady(c, 500, 1200);
    tree.update(v);
    expect(tree.rendered).toContain(root);
    expect(root.childrenFailed).toBe(true);
  });

  it('culls tiles behind a frustum plane and does not load them', () => {
    const p = new FakeProvider();
    const tree = new Quadtree(OPTS, p);
    // Plane through Belp facing east: only tiles east of about 7.5° are visible.
    const c = geodeticToEcef(BELP.lon, BELP.lat, 0, { x: 0, y: 0, z: 0 });
    const lonR = (BELP.lon * Math.PI) / 180;
    const east = { x: -Math.sin(lonR), y: Math.cos(lonR), z: 0 };
    const plane: Plane = {
      nx: east.x,
      ny: east.y,
      nz: east.z,
      d: -(east.x * c.x + east.y * c.y + east.z * c.z),
    };
    settle(tree, p, view(BELP.lon, BELP.lat, 1100, [plane]));
    expect(tree.rendered.length).toBeGreaterThan(0);
    // Bounding spheres are conservative: tiles just behind the plane may still count as visible.
    for (const n of tree.rendered) expect(n.bounds.east).toBeGreaterThan(BELP.lon - 0.06);
    // Fine tiles exist only on the visible side (invisible siblings of drawn tiles aside).
    const fine = [...tree.ready].filter((n) => n.key.z >= 14);
    expect(fine.length).toBeGreaterThan(0);
    for (const n of fine) expect(n.bounds.east).toBeGreaterThan(BELP.lon - 0.05);
  });

  it('cancels loads the camera no longer needs', () => {
    const p = new FakeProvider();
    const tree = new Quadtree(OPTS, p);
    settle(tree, p, view(BELP.lon, BELP.lat, 3000));
    // Descend: new children are requested, then the camera jumps away before they arrive.
    tree.update(view(BELP.lon, BELP.lat, 300));
    const pending = [...tree.loading];
    expect(pending.length).toBeGreaterThan(0);
    const away = view(8.3, 46.5, 30_000);
    for (let i = 0; i <= OPTS.staleFrames + 1; i++) tree.update(away);
    expect(p.cancelled.length).toBeGreaterThan(0);
    for (const n of p.cancelled) expect(n.state).toBe('idle');
  });

  it('evicts least recently used tiles, never drawn ones or roots', () => {
    const p = new FakeProvider();
    const tree = new Quadtree(OPTS, p);
    settle(tree, p, view(BELP.lon, BELP.lat, 600));
    const loadedAtBelp = tree.ready.size;
    settle(tree, p, view(7.9, 46.6, 600));
    for (let i = 0; i < 3; i++) tree.update(view(7.9, 46.6, 600));
    const budget = 120;
    const old = [...tree.ready].filter((n) => n.lastUsed < tree.frameNumber - 2);
    const victims = tree.evictionCandidates(budget);
    // Only tiles unused for a few frames go, as many as needed to meet the budget.
    expect(victims.length).toBe(Math.min(old.length, tree.ready.size - budget));
    expect(victims.length).toBeGreaterThan(0);
    for (let i = 1; i < victims.length; i++)
      expect(victims[i]!.lastUsed).toBeGreaterThanOrEqual(victims[i - 1]!.lastUsed);
    expect(loadedAtBelp).toBeGreaterThan(0);
    const drawn = new Set(tree.rendered);
    for (const n of victims) {
      expect(drawn.has(n)).toBe(false);
      expect(n.parent).toBeDefined();
      tree.markEvicted(n);
    }
    // The selection still covers the view after eviction.
    tree.update(view(7.9, 46.6, 600));
    expect(tree.rendered.length).toBeGreaterThan(0);
  });

  it('finds the finest loaded tile for height queries', () => {
    const p = new FakeProvider();
    const tree = new Quadtree(OPTS, p);
    settle(tree, p, view(BELP.lon, BELP.lat, 600));
    const n = tree.finestReadyAt(BELP.lon, BELP.lat)!;
    expect(n.key).toEqual(geoTileAt(BELP.lon, BELP.lat, OPTS.maxZoom));
    expect(tree.finestReadyAt(0, 0)).toBeUndefined();
  });

  it('does not load beyond the view distance', () => {
    const p = new FakeProvider();
    const tree = new Quadtree({ ...OPTS, viewDistance: 20_000 }, p);
    settle(tree, p, view(BELP.lon, BELP.lat, 600));
    for (const n of tree.ready) if (n.parent) expect(tree.distance(n)).toBeLessThan(20_000 + 1);
  });
});
