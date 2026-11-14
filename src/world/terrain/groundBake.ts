/**
 * The ground data of a tile, baked in the tile worker after the terrain, photo and mask: the
 * night lights and the road field (one small mipmapped texture) and the horizon angles (a tiny
 * texture). Reads the vector tiles the mask was drawn from, the generalised settlement areas
 * of zoom 11 and the coarse terrain of the surroundings.
 */
import type { VectorTile } from '@mapbox/vector-tile';
import {
  type GeoBounds,
  QM_MAX,
  VECTOR_TILE_MAX_ZOOM,
  type QuantizedMesh,
  type TileKey,
  geoTileAt,
  geoTileBounds,
  geoTileSpan,
  mercatorTileRange,
  vectorTilePointToLonLat,
} from '@geo';
import { HORIZON_CONTEXT_ZOOM } from './groundSettings';
import { type HeightField, horizonMap, mosaic, rasterizeMesh } from './horizon';
import {
  DISTRICT_MARGIN,
  DISTRICT_SIGMA,
  type LightRoad,
  bakeLights,
  encodeLights,
} from './lights';
import type { GroundJob, GroundOutput } from './protocol';
import { blur, byteMips, fieldAt, fillPolygon, grid } from './raster';
import { type RoadLine, bakeRoads } from './roads';

const M_PER_DEG_LAT = 111_132;
/** Settlement polygons come from this zoom (generalised built-up areas, the same everywhere). */
const SETTLEMENT_ZOOM = 11;
/** How far beyond the tile lights can reach into it (the wide glow of a lamp), metres. */
const LIGHT_MARGIN = 160;
/** Single farm and hut lights come from buildings at these vector zooms and above. */
const FARM_MIN_ZOOM = 13;
/** Terrain tiles up to this zoom bake their lights from the main roads only (see below). */
const COARSE_LIGHTS_MAX_ZOOM = 10;

export interface LoadedVector {
  tile: TileKey;
  vt: VectorTile | null;
}

export interface BakeDeps {
  vector(z: number, x: number, y: number): Promise<VectorTile | null>;
  /** Coarse height field of a geographic terrain tile (sea-level heights), null if absent. */
  terrainField(key: TileKey): Promise<HeightField | null>;
}

/** A line or ring in degrees (lon, lat pairs) with its bounding box. */
interface GeoLine {
  ll: Float64Array;
  west: number;
  south: number;
  east: number;
  north: number;
}

interface ParsedRoad extends GeoLine {
  cls: string;
  ramp: boolean;
  tunnel: boolean;
  surface?: string;
}

/**
 * Features of a vector tile in degrees, parsed once per worker: neighbouring terrain tiles and
 * all their levels of detail read the same vector tiles, and decoding plus the inverse
 * Mercator projection were most of the baking time.
 */
interface ParsedVector {
  roads?: ParsedRoad[];
  residential?: GeoLine[][];
  buildings?: Array<{ lon: number; lat: number; r: number }>;
}
const parsedCache = new WeakMap<VectorTile, ParsedVector>();

function parsedOf(vt: VectorTile): ParsedVector {
  let p = parsedCache.get(vt);
  if (!p) parsedCache.set(vt, (p = {}));
  return p;
}

function geoLine(tile: TileKey, extent: number, ring: Array<{ x: number; y: number }>): GeoLine {
  const ll = new Float64Array(ring.length * 2);
  const pt = { lon: 0, lat: 0 };
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  ring.forEach((q, k) => {
    vectorTilePointToLonLat(tile, extent, q.x, q.y, pt);
    ll[k * 2] = pt.lon;
    ll[k * 2 + 1] = pt.lat;
    west = Math.min(west, pt.lon);
    east = Math.max(east, pt.lon);
    south = Math.min(south, pt.lat);
    north = Math.max(north, pt.lat);
  });
  return { ll, west, south, east, north };
}

function roadsOf({ tile, vt }: LoadedVector): ParsedRoad[] {
  if (!vt) return [];
  const p = parsedOf(vt);
  if (p.roads) return p.roads;
  const out: ParsedRoad[] = [];
  const layer = vt.layers.transportation;
  for (let i = 0; layer && i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 2) continue;
    const props = f.properties;
    const cls = String(props.class ?? '');
    if (cls === 'rail' || cls === 'path' || cls === 'footway' || cls === 'transit') continue;
    for (const ring of f.loadGeometry())
      out.push({
        ...geoLine(tile, layer.extent, ring),
        cls,
        ramp: props.ramp === 1 || props.ramp === true || props.ramp === '1',
        tunnel: props.brunnel === 'tunnel',
        surface: typeof props.surface === 'string' ? props.surface : undefined,
      });
  }
  return (p.roads = out);
}

function residentialOf({ tile, vt }: LoadedVector): GeoLine[][] {
  if (!vt) return [];
  const p = parsedOf(vt);
  if (p.residential) return p.residential;
  const out: GeoLine[][] = [];
  const layer = vt.layers.landuse;
  for (let i = 0; layer && i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 3 || f.properties.class !== 'residential') continue;
    out.push(f.loadGeometry().map((ring) => geoLine(tile, layer.extent, ring)));
  }
  return (p.residential = out);
}

/** Building centres with a stable random number each (the same at every zoom). */
function buildingsOf({ tile, vt }: LoadedVector) {
  if (!vt) return [];
  const p = parsedOf(vt);
  if (p.buildings) return p.buildings;
  const out: NonNullable<ParsedVector['buildings']> = [];
  const layer = vt.layers.building;
  const pt = { lon: 0, lat: 0 };
  for (let i = 0; layer && i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 3) continue;
    const ring = f.loadGeometry()[0];
    if (!ring || ring.length < 3) continue;
    let x = 0;
    let y = 0;
    for (const q of ring) {
      x += q.x;
      y += q.y;
    }
    x /= ring.length;
    y /= ring.length;
    vectorTilePointToLonLat(tile, layer.extent, x, y, pt);
    // Hashed from the position on a grid of about 5 m.
    const gx = Math.round(pt.lon * 20_000);
    const gy = Math.round(pt.lat * 20_000);
    let h = Math.imul(gx ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(gy, 0xc2b2ae35);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    out.push({ lon: pt.lon, lat: pt.lat, r: (h >>> 0) / 4294967296 });
  }
  return (p.buildings = out);
}

const overlaps = (l: GeoLine, b: GeoBounds) =>
  l.east >= b.west && l.west <= b.east && l.north >= b.south && l.south <= b.north;

/** Lon/lat to pixels of a raster of `size` over `b`, with an extra offset and scale. */
function toPixels(l: GeoLine, b: GeoBounds, size: number, offset = 0, scale = 1): number[] {
  const sx = (size / (b.east - b.west)) * scale;
  const sy = (size / (b.north - b.south)) * scale;
  const out = new Array<number>(l.ll.length);
  for (let k = 0; k < l.ll.length; k += 2) {
    out[k] = (l.ll[k]! - b.west) * sx + offset;
    out[k + 1] = (b.north - l.ll[k + 1]!) * sy + offset;
  }
  return out;
}

/**
 * Settled land 0..1 over the tile and a margin, on n x n cells: residential areas of the
 * generalised base map (zoom 11 and coarser carry whole towns and villages as single polygons).
 */
export function settlementOf(
  tiles: LoadedVector[],
  b: GeoBounds,
  wide: GeoBounds,
  size: number,
  marginPx: number,
  n = 256,
) {
  const cell = (size + 2 * marginPx) / n;
  const g = grid(n, n);
  let any = false;
  for (const t of tiles)
    for (const poly of residentialOf(t)) {
      // A feature may be a multipolygon whose parts lie far apart (the first ring alone said
      // nothing about the others), so rings are tested one by one. A hole lies inside its
      // outer ring, so even-odd filling stays right with the rings that are kept.
      const rings = poly.filter((ring) => overlaps(ring, wide));
      if (rings.length === 0) continue;
      any = true;
      fillPolygon(
        g,
        rings.map((ring) => toPixels(ring, b, size, marginPx / cell, 1 / cell)),
        1,
      );
    }
  return any ? { g, margin: marginPx, cell } : undefined;
}

function lines(tiles: LoadedVector[], b: GeoBounds, wide: GeoBounds, size: number) {
  const out: Array<{
    cls: string;
    ramp: boolean;
    tunnel: boolean;
    surface?: string;
    points: number[];
  }> = [];
  for (const t of tiles)
    for (const r of roadsOf(t))
      if (overlaps(r, wide))
        out.push({
          cls: r.cls,
          ramp: r.ramp,
          tunnel: r.tunnel,
          surface: r.surface,
          points: toPixels(r, b, size),
        });
  return out;
}

/** A light per building outside settlements (farms, huts), for about two in three of them. */
function farmLights(tiles: LoadedVector[], b: GeoBounds, wide: GeoBounds, size: number) {
  const out: Array<{ x: number; y: number; weight: number }> = [];
  const sx = size / (b.east - b.west);
  const sy = size / (b.north - b.south);
  for (const t of tiles)
    for (const h of buildingsOf(t)) {
      if (h.r > 0.65) continue;
      if (h.lon < wide.west || h.lon > wide.east || h.lat < wide.south || h.lat > wide.north)
        continue;
      out.push({ x: (h.lon - b.west) * sx, y: (b.north - h.lat) * sy, weight: 0.3 + h.r * 0.4 });
    }
  return out;
}

const around = (b: GeoBounds, metres: number, lat0: number): GeoBounds => {
  const dLat = metres / M_PER_DEG_LAT;
  const dLon = dLat / Math.cos((lat0 * Math.PI) / 180);
  return { west: b.west - dLon, east: b.east + dLon, south: b.south - dLat, north: b.north + dLat };
};

/** True if the land-cover mask (RGBA, R = water) holds any water. */
function anyWater(mask: Uint8Array): boolean {
  for (let i = 0; i < mask.length; i += 4) if (mask[i]! >= 128) return true;
  return false;
}

/** Loads the vector tiles of `zoom` covering `b`. */
async function loadTiles(deps: BakeDeps, b: GeoBounds, zoom: number): Promise<LoadedVector[]> {
  const r = mercatorTileRange(b, zoom);
  const loads: Array<Promise<LoadedVector>> = [];
  for (let y = r.y0; y <= r.y1; y++)
    for (let x = r.x0; x <= r.x1; x++) {
      const tile = { z: zoom, x, y };
      loads.push(deps.vector(zoom, x, y).then((vt) => ({ tile, vt })));
    }
  return Promise.all(loads);
}

/** Heights of the tile itself (sea level), rasterised for the horizon march. */
export function ownField(qm: QuantizedMesh, b: GeoBounds, n: number): HeightField {
  const span = qm.maxHeight - qm.minHeight;
  const heights = new Float32Array(qm.vertexCount);
  for (let i = 0; i < qm.vertexCount; i++) heights[i] = qm.minHeight + (qm.h[i]! / QM_MAX) * span;
  return rasterizeMesh(qm.u, qm.v, heights, qm.indices, QM_MAX, b, n, n);
}

/** The 3 x 3 block of coarse context tiles around the one holding the tile. */
async function contextField(deps: BakeDeps, key: TileKey): Promise<HeightField | undefined> {
  const z = HORIZON_CONTEXT_ZOOM;
  if (key.z < z) return undefined;
  const b = geoTileBounds(key);
  const c = geoTileAt((b.west + b.east) / 2, (b.south + b.north) / 2, z);
  const parts: Array<Promise<HeightField | null>> = [];
  // Row 0 north: y counts from the south.
  for (let dy = 1; dy >= -1; dy--)
    for (let dx = -1; dx <= 1; dx++) parts.push(deps.terrainField({ z, x: c.x + dx, y: c.y + dy }));
  const fields = await Promise.all(parts);
  const first = fields.find((f) => f);
  if (!first) return undefined;
  const s = geoTileSpan(z);
  const cb = geoTileBounds(c);
  const bounds = { west: cb.west - s, east: cb.east + s, south: cb.south - s, north: cb.north + s };
  return mosaic(fields, 3, 3, bounds, first.w, first.h);
}

export interface BakeInput {
  key: TileKey;
  bounds: GeoBounds;
  /** Land-cover mask, RGBA, size x size (R = water). */
  mask: Uint8Array;
  size: number;
  /** The vector tiles the mask was drawn from. */
  tiles: LoadedVector[];
  vectorZoom: number;
  qm: QuantizedMesh;
  job: GroundJob;
}

export async function bakeGround(
  inp: BakeInput,
  deps: BakeDeps,
  timed: <T>(fn: () => T) => T,
): Promise<GroundOutput> {
  const { bounds: b, size, job } = inp;
  const lat0 = (b.north + b.south) / 2;
  const widthM = (b.east - b.west) * M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  const mpp = widthM / size;
  const marginPx = LIGHT_MARGIN / mpp;
  const wide = around(b, LIGHT_MARGIN, lat0);
  // Coarse tiles (seen from tens of kilometres) take the main roads and the built-up areas
  // of zoom 9 and stand in for the lamps of the minor roads with an even glow: the vector
  // tiles that carry every street are large, and parsing them was most of the baking time.
  const coarse = inp.key.z <= COARSE_LIGHTS_MAX_ZOOM;
  const lightZoom = coarse ? 9 : Math.min(inp.key.z, VECTOR_TILE_MAX_ZOOM);
  const settleZoom = coarse ? 9 : SETTLEMENT_ZOOM;
  // How built-up the wider surroundings are: coarse tiles weight their towns by it, and water
  // mirrors the lit shores within a kilometre or so. Most land tiles need neither.
  const district = coarse || anyWater(inp.mask) ? around(b, DISTRICT_MARGIN, lat0) : undefined;
  const tilesAt = (z: number, over = wide) =>
    z === inp.vectorZoom && over === wide ? Promise.resolve(inp.tiles) : loadTiles(deps, over, z);
  const [lightTiles, settleTiles, context] = await Promise.all([
    tilesAt(lightZoom),
    tilesAt(settleZoom, district),
    job.context ? contextField(deps, inp.key) : Promise.resolve(undefined),
  ]);

  return timed(() => {
    const t0 = performance.now();
    const C = job.channels;
    const level0 = new Uint8Array(size * size * C);
    const settlement = settlementOf(settleTiles, b, wide, size, marginPx);
    let districtField: ReturnType<typeof settlementOf>;
    if (district) {
      districtField = settlementOf(settleTiles, b, district, size, DISTRICT_MARGIN / mpp, 64);
      if (districtField) blur(districtField.g, DISTRICT_SIGMA / (districtField.cell * mpp));
    }
    const roads = lines(lightTiles, b, wide, size);
    const points = lightZoom >= FARM_MIN_ZOOM ? farmLights(lightTiles, b, wide, size) : [];
    const outside = settlement ? points.filter((p) => fieldAt(settlement, p.x, p.y) < 0.5) : points;
    const mask = inp.mask;
    const lights = bakeLights({
      size,
      metresPerPixel: mpp,
      roads: roads as LightRoad[],
      points: outside,
      settlement,
      dark: (x, y) => {
        const i =
          (Math.min(size - 1, Math.floor(y)) * size + Math.min(size - 1, Math.floor(x))) * 4;
        return mask[i]! / 255;
      },
      missingMinor: coarse ? 1 : 0,
      district: districtField,
    });
    const lightScale = encodeLights(lights, level0, C, 0);
    const t1 = performance.now();
    if (C === 4) {
      if (job.roads) bakeRoads(size, mpp, roads as RoadLine[], level0, 4, 2);
      else for (let i = 0; i < size * size; i++) level0[i * 4 + 2] = 255;
    }
    const t2 = performance.now();
    const near = ownField(inp.qm, b, 65);
    const horizon = horizonMap({ bounds: b, size: job.horizonSize, near, far: context });
    const t3 = performance.now();
    // Lights average as energy (square-root coded), the road field as plain numbers.
    const mips = byteMips(level0, size, C, [false, false, true, true]);
    const timing = {
      lights: t1 - t0,
      roads: t2 - t1,
      horizon: t3 - t2,
      mips: performance.now() - t3,
    };
    return {
      mips,
      channels: C,
      lightScale,
      lamps: lights.count,
      horizon,
      horizonSize: job.horizonSize,
      timing,
    };
  });
}
