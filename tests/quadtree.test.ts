import { describe, expect, it } from 'vitest';
import { Frustum, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { ecefToLocal, enuFrame, geodeticToEcef } from '../src/geo/ellipsoid';
import { GRID } from '../src/terrain/heightGrid';
import { Quadtree, type TileNode, type TileProvider } from '../src/terrain/Quadtree';

const frame = enuFrame(8.2275, 46.8182, 0);
const local = (lon: number, lat: number, h: number) =>
  new Vector3(...ecefToLocal(frame, ...geodeticToEcef(lon, lat, h)));

/** Loads every requested tile instantly with a flat height of 550 m + zoom (to tell levels apart). */
class InstantProvider implements TileProvider {
  pending: TileNode[] = [];
  cancelled = 0;
  request(node: TileNode) {
    this.pending.push(node);
  }
  cancel() {
    this.cancelled++;
    return true;
  }
  flush(tree: Quadtree) {
    for (const n of this.pending.splice(0)) {
      tree.markReady(n, 500, 600, new Float32Array(GRID * GRID).fill(550 + n.key.z));
    }
  }
}

function makeTree(provider: TileProvider) {
  return new Quadtree(
    frame,
    {
      roots: { z: 7, x0: 132, x1: 135, y0: 96, y1: 98 },
      maxZoom: 15,
      maxZoomOutside: 10,
      detailBounds: { west: 5.85, south: 45.75, east: 10.6, north: 47.9 },
      tau: 4,
    },
    provider,
  );
}

function view(pos: Vector3, target: Vector3) {
  const cam = new PerspectiveCamera(60, 16 / 9, 3, 600_000);
  cam.position.copy(pos);
  cam.up.copy(
    pos
      .clone()
      .add(new Vector3(0, 6_371_000, 0))
      .normalize(),
  );
  cam.lookAt(target);
  cam.updateMatrixWorld();
  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
  );
  const forward = target.clone().sub(pos).normalize();
  return { frustum, forward };
}

function settle(tree: Quadtree, p: InstantProvider, pos: Vector3, target: Vector3, frames = 20) {
  const { frustum, forward } = view(pos, target);
  for (let i = 0; i < frames; i++) {
    tree.update(pos, forward, frustum, new Vector3(), 1080, (60 * Math.PI) / 180);
    p.flush(tree);
  }
}

const isAncestor = (a: TileNode, b: TileNode) => {
  for (let n = b.parent; n; n = n.parent) if (n === a) return true;
  return false;
};

describe('quadtree LOD', () => {
  it('refines to max zoom near a low camera, without overlapping tiles', () => {
    const p = new InstantProvider();
    const tree = makeTree(p);
    const pos = local(7.44, 46.95, 900); // low over Bern
    settle(tree, p, pos, local(7.6, 46.95, 600));
    expect(tree.stats.maxZoomRendered).toBe(15);
    expect(tree.rendered.length).toBeLessThan(400);
    for (const a of tree.rendered)
      for (const b of tree.rendered) expect(isAncestor(a, b)).toBe(false);
  });

  it('stays coarse from far away', () => {
    const p = new InstantProvider();
    const tree = makeTree(p);
    settle(tree, p, local(8.2, 46.8, 400_000), local(8.2, 46.8, 0));
    expect(tree.stats.maxZoomRendered).toBeLessThanOrEqual(10);
  });

  it('answers heights from the most detailed loaded tile', () => {
    const p = new InstantProvider();
    const tree = makeTree(p);
    expect(tree.heightAt(7.44, 46.95)).toBeUndefined();
    settle(tree, p, local(7.44, 46.95, 900), local(7.6, 46.95, 600));
    expect(tree.heightAt(7.44, 46.95)).toBe(550 + 15);
  });

  it('frees tiles that are no longer used, never roots', () => {
    const p = new InstantProvider();
    const tree = makeTree(p);
    settle(tree, p, local(7.44, 46.95, 900), local(7.6, 46.95, 600));
    // Fly to the other end of the country.
    settle(tree, p, local(9.84, 46.5, 2500), local(10.0, 46.5, 2000), 25);
    const free = tree.evictionCandidates(50);
    // Only tiles unused for a few frames may go; tiles in view stay even above the budget.
    expect(free.length).toBeGreaterThan(100);
    expect(free.every((n) => n.parent !== undefined && n.lastUsed < 43)).toBe(true);
  });

  it('cancels downloads that are no longer requested', () => {
    const p = new InstantProvider();
    const tree = makeTree(p);
    const a = view(local(7.44, 46.95, 900), local(7.6, 46.95, 600));
    tree.update(local(7.44, 46.95, 900), a.forward, a.frustum, new Vector3(), 1080, 1);
    const before = tree.loading.size;
    expect(before).toBeGreaterThan(1);
    // Never deliver; keep updating with an empty view (looking at the sky).
    const b = view(local(7.44, 46.95, 900), local(7.44, 46.95, 1_000_000));
    for (let i = 0; i < 40; i++)
      tree.update(local(7.44, 46.95, 900), b.forward, b.frustum, new Vector3(), 1080, 1);
    expect(p.cancelled).toBeGreaterThan(0);
    expect(tree.loading.size).toBeLessThan(before);
  });
});
