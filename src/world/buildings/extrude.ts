import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { LocalFrame, type TileKey, vectorTilePointToLonLat } from '@geo';
import {
  type Ring,
  boxRing,
  cleanRing,
  clipRingToRect,
  orientedBox,
  signedArea,
  simplifyRing,
} from './footprint';
import { type CellGrid, cellIdAt, mercatorTileBounds } from './grid';
import { KIND, type MeshData, MeshBuilder } from './mesh';
import type { FootprintLod } from './presets';
import { addSolid, orient } from './roof';
import { colours, planBuilding, seedAt } from './style';

/** Footprint tiles: zoom 14 is the only level of swisstopo's vector tiles with heights. */
export const FOOTPRINT_ZOOM = 14;

export interface FootprintTileOptions {
  key: TileKey;
  /**
   * 0: every building as it is; 1: without eaves and the smallest sheds, outlines to half a
   * metre; 2: far away (simplified outlines, no sheds); 3: boxes, for their lit windows.
   */
  lod: FootprintLod;
  /**
   * Ground heights above sea level on a 5 x 5 grid over the tile (row 0 at the north edge),
   * for the alpine look; the exact ground comes later, on the main thread.
   */
  elevation: number[];
  grid: CellGrid;
}

export interface FootprintTile {
  mesh: MeshData;
  /** swissBUILDINGS3D cells that hold at least one building of this tile (their centres). */
  cells: Uint32Array;
}

/** Ground height (sea level) from the 5 x 5 samples at fractions fx (east), fy (south). */
function elevationAt(e: number[], fx: number, fy: number): number {
  if (e.length < 25) return 500;
  const x = Math.min(Math.max(fx * 4, 0), 3.999);
  const y = Math.min(Math.max(fy * 4, 0), 3.999);
  const i = Math.floor(x);
  const j = Math.floor(y);
  const tx = x - i;
  const ty = y - j;
  const a = e[j * 5 + i]! * (1 - tx) + e[j * 5 + i + 1]! * tx;
  const b = e[(j + 1) * 5 + i]! * (1 - tx) + e[(j + 1) * 5 + i + 1]! * tx;
  return a * (1 - ty) + b * ty;
}

/**
 * Extruded buildings from the `building` layer of swisstopo's base vector tiles: one mesh per
 * zoom-14 tile in the tile's tangent frame (origin at its centre on the ellipsoid), with y
 * relative to each building's ground point. Heights are the data's render_height (from the
 * 3D building model, whole metres); roofs are generated (see style.ts and roof.ts).
 *
 * Features crossing the tile edge appear in both neighbours: those the server cut at its
 * small buffer are clipped to the tile so that the two halves meet; those that fit in the
 * buffer are kept by the tile holding their centre only.
 */
export function buildFootprintTile(bytes: Uint8Array, o: FootprintTileOptions): FootprintTile {
  const bounds = mercatorTileBounds(o.key);
  const frame = new LocalFrame(
    (bounds.west + bounds.east) / 2,
    (bounds.south + bounds.north) / 2,
    0,
  );
  const out = new MeshBuilder();
  const cells = new Set<number>();
  const layer = new VectorTile(new PbfReader(bytes)).layers.building;
  if (!layer) return { mesh: out.finish(), cells: new Uint32Array(0) };

  const extent = layer.extent;
  const ll = { lon: 0, lat: 0 };
  const q = { x: 0, y: 0, z: 0 };
  // Tile size in metres, for the building density (towns have more flat roofs).
  frame.fromGeodetic(bounds.east, bounds.north, 0, q);
  const areaKm2 = (4 * Math.abs(q.x) * Math.abs(q.z)) / 1e6;
  const density = layer.length / Math.max(areaKm2, 0.01);
  const half = { x: Math.abs(q.x), z: Math.abs(q.z) };
  const toLocal = (px: number, py: number, ring: Ring) => {
    vectorTilePointToLonLat(o.key, extent, px, py, ll);
    frame.fromGeodetic(ll.lon, ll.lat, 0, q);
    ring.push(q.x, q.z);
  };
  // Far builds drop sheds and garages; the ring seen only at night keeps just the larger.
  const minArea = [4, 15, 30, 70][o.lod]!;
  const minHole = [4, 25, 60, 60][o.lod]!;
  const tolerance = [0, 0.6, 1.2, 3][o.lod]!;

  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 3) continue;
    const props = f.properties;
    const cls = typeof props.class === 'string' ? props.class : undefined;
    if (cls === 'construction') continue;
    const height = typeof props.render_height === 'number' ? props.render_height : undefined;

    // Rings in tile units; outer rings run clockwise on the map (positive area here, as in
    // the local frame where z points south), each followed by its holes.
    const polys: Array<{
      outer: Array<{ x: number; y: number }>;
      holes: Array<Array<{ x: number; y: number }>>;
    }> = [];
    for (const ring of f.loadGeometry()) {
      let a = 0;
      for (let k = 0; k < ring.length; k++) {
        const p = ring[k]!;
        const r = ring[(k + 1) % ring.length]!;
        a += p.x * r.y - r.x * p.y;
      }
      if (a > 0) polys.push({ outer: ring, holes: [] });
      else if (a < 0) polys.at(-1)?.holes.push(ring);
    }

    for (const poly of polys) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let sx = 0;
      let sy = 0;
      for (const p of poly.outer) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
        sx += p.x;
        sy += p.y;
      }
      const crosses = minX < 0 || minY < 0 || maxX > extent || maxY > extent;
      // The server's buffer is narrow; a feature reaching its border was cut there.
      const margin = extent / 512;
      const cut =
        crosses &&
        (minX <= -margin || minY <= -margin || maxX >= extent + margin || maxY >= extent + margin);
      if (crosses && !cut) {
        const cx = sx / poly.outer.length;
        const cy = sy / poly.outer.length;
        if (cx < 0 || cy < 0 || cx >= extent || cy >= extent) continue;
      }

      const convert = (pts: Array<{ x: number; y: number }>) => {
        const r: Ring = [];
        for (const p of pts) toLocal(p.x, p.y, r);
        const c = cleanRing(r);
        return cut && c.length ? clipRingToRect(c, -half.x, -half.z, half.x, half.z) : c;
      };
      // What the building is (size, shape, anchor, seed, so its plan and colours) comes from
      // the full outline at every build: a tile changing its build must not change the look.
      const outerRing = convert(poly.outer);
      if (outerRing.length < 6) continue;
      const holeRings = poly.holes
        .map(convert)
        .filter((h) => h.length >= 6 && Math.abs(signedArea(h)) > 4);
      const oriented = orient(outerRing, holeRings);
      const area =
        signedArea(oriented.outer) - holeRings.reduce((s, h) => s + Math.abs(signedArea(h)), 0);
      if (area < minArea) continue;
      // The geometry of far builds: simpler outlines, only the larger courtyards.
      const simple = (r: Ring) => (tolerance ? simplifyRing(r, tolerance) : r);
      const shape = orient(
        simple(oriented.outer),
        oriented.holes
          .map(simple)
          .filter((h) => h.length >= 6 && Math.abs(signedArea(h)) > minHole),
      );
      if (shape.outer.length < 6) continue;

      const box = orientedBox(oriented.outer);
      const boxArea = 4 * box.halfLength * box.halfWidth;
      // Anchor: the centre of the outline's points (its ground height is the building's).
      let ax = 0;
      let az = 0;
      const n = oriented.outer.length / 2;
      for (let k = 0; k < n; k++) {
        ax += oriented.outer[2 * k]!;
        az += oriented.outer[2 * k + 1]!;
      }
      ax /= n;
      az /= n;
      const geo = frame.toGeodetic({ x: ax, y: 0, z: az });
      const fx = (geo.lon - bounds.west) / (bounds.east - bounds.west);
      const fy = (bounds.north - geo.lat) / (bounds.north - bounds.south);
      const elevation = elevationAt(o.elevation, fx, fy);
      const seed = seedAt(geo.lon * 1e5, geo.lat * 1e5);
      const plan = planBuilding({
        area,
        fill: boxArea > 0 ? area / boxArea : 1,
        box,
        holes: holeRings.length > 0,
        height,
        cls,
        elevation,
        density,
        seed,
      });
      const cell = cellIdAt(o.grid, geo.lon, geo.lat);
      if (cell >= 0) cells.add(cell);
      const { roof, wall } = colours(plan.kind, seed, elevation > 1000);
      out.begin({
        anchorX: ax,
        anchorZ: az,
        cell,
        seed,
        roof,
        wall,
        kind: plan.kind,
        eave: plan.eave,
      });
      const boxed = plan.boxed;
      const canopy = plan.kind === KIND.canopy;
      addSolid(out, {
        outer: boxed ? boxRing(box) : shape.outer,
        holes: boxed ? [] : shape.holes,
        // The night-only ring: a box as high as the roof's middle (only its windows are seen).
        roof:
          o.lod === 3
            ? { kind: 'flat', box, eave: (plan.eave + plan.height) / 2, ridge: plan.height }
            : { kind: plan.roof, box, eave: plan.eave, ridge: plan.height },
        base: canopy ? Math.max(plan.height - 0.6, 0.5) : -1,
        grounded: !canopy,
        roofOutline: boxed && plan.overhang > 0 && !o.lod ? boxRing(box, plan.overhang) : undefined,
      });
    }
  }
  return { mesh: out.finish(), cells: Uint32Array.from(cells) };
}
