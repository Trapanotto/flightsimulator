/// <reference lib="webworker" />
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import {
  type Footprint,
  type TileBuildings,
  VECTOR_TILE_URL,
  orientedBox,
} from '../buildings/footprints';
import { fetchRetry } from '../net/fetchRetry';

declare const self: DedicatedWorkerGlobalScope;

export interface BuildingJob {
  z: number;
  x: number;
  y: number;
}

type Pos = [number, number];
const DEG = Math.PI / 180;

/** Polygons of a GeoJSON geometry (outer rings only). */
function outerRings(geom: { type: string; coordinates: unknown }): Pos[][] {
  if (geom.type === 'Polygon') return [(geom.coordinates as Pos[][])[0]!];
  if (geom.type === 'MultiPolygon') return (geom.coordinates as Pos[][][]).map((p) => p[0]!);
  return [];
}

function pointInRing(p: Pos, ring: Pos[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function tileBounds(z: number, x: number, y: number) {
  const n = 2 ** z;
  const lon = (i: number) => (i / n) * 360 - 180;
  const lat = (j: number) => Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) / DEG;
  return { west: lon(x), east: lon(x + 1), north: lat(y), south: lat(y + 1) };
}

async function load(job: BuildingJob): Promise<TileBuildings> {
  const url = VECTOR_TILE_URL.replace('{z}', String(job.z))
    .replace('{x}', String(job.x))
    .replace('{y}', String(job.y));
  const res = await fetchRetry(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const vt = new VectorTile(new PbfReader(new Uint8Array(await res.arrayBuffer())));
  const b = tileBounds(job.z, job.x, job.y);
  const lat0 = (b.north + b.south) / 2;
  const lon0 = (b.west + b.east) / 2;
  const mx = 111_320 * Math.cos(lat0 * DEG);
  const my = 110_540;

  const footprints: Footprint[] = [];
  const layer = vt.layers.building;
  for (let i = 0; layer && i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.properties.class && f.properties.class !== 'roof') continue;
    const height =
      Number(f.properties.render_height ?? 7) - Number(f.properties.render_min_height ?? 0);
    for (const ring of outerRings(f.toGeoJSON(job.x, job.y, job.z).geometry as never)) {
      if (ring.length < 4) continue;
      const local = ring
        .slice(0, -1)
        .map(([lon, lat]) => [(lon - lon0) * mx, (lat - lat0) * my] as [number, number]);
      const box = orientedBox(local);
      if (box.area < 12) continue;
      const lon = lon0 + box.cx / mx;
      const lat = lat0 + box.cy / my;
      // Buildings crossing the tile edge are in both tiles: keep them only where their centre is.
      if (lon < b.west || lon >= b.east || lat < b.south || lat >= b.north) continue;
      footprints.push({
        lon,
        lat,
        angle: box.angle,
        length: Math.max(3, box.length),
        width: Math.max(3, box.width),
        height: Math.max(2.5, height),
        area: box.area,
      });
    }
  }

  const churches: Array<{ lon: number; lat: number }> = [];
  const poi = vt.layers.poi;
  for (let i = 0; poi && i < poi.length; i++) {
    const f = poi.feature(i);
    if (f.properties.class !== 'place_of_worship') continue;
    const g = f.toGeoJSON(job.x, job.y, job.z).geometry as { type: string; coordinates: Pos };
    if (g.type === 'Point') churches.push({ lon: g.coordinates[0], lat: g.coordinates[1] });
  }

  let canton: string | null = null;
  const admin = vt.layers.administrative_unit;
  for (let i = 0; admin && i < admin.length; i++) {
    const f = admin.feature(i);
    if (f.properties.class !== 'canton') continue;
    const name = String(f.properties['name:de'] ?? f.properties.name ?? '');
    canton ??= name;
    for (const ring of outerRings(f.toGeoJSON(job.x, job.y, job.z).geometry as never)) {
      if (pointInRing([lon0, lat0], ring)) canton = name;
    }
  }
  return { footprints, churches, canton };
}

self.onmessage = async (e: MessageEvent<{ id: number; job: BuildingJob }>) => {
  const { id, job } = e.data;
  try {
    self.postMessage({ id, ok: true, result: await load(job) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) });
  }
};
