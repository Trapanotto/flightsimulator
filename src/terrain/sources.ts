/** swisstopo / geo.admin.ch endpoints. See docs/KONZEPT.md, chapter 3. */

const TERRAIN_BASE = 'https://3d.geo.admin.ch/ch.swisstopo.terrain.3d/v1/';

export const SWISSIMAGE_TEMPLATE =
  'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg';

/** Water polygons (lakes, wide rivers; based on swissTLM3D) for the water mask. */
export const WATER_TILE_URL =
  'https://vectortiles.geo.admin.ch/tiles/ch.swisstopo.base.vt/v1.0.0/{z}/{x}/{y}.pbf';

interface LayerJson {
  tiles: string[];
  version: string;
  maxzoom: number;
}

export interface TerrainSource {
  url(z: number, x: number, y: number): string;
  maxZoom: number;
}

/**
 * Reads layer.json at runtime: the tile path contains a data date and a
 * version that swisstopo changes with every data update.
 */
export async function loadTerrainSource(): Promise<TerrainSource> {
  const res = await fetch(TERRAIN_BASE + 'layer.json');
  if (!res.ok) throw new Error(`terrain layer.json: HTTP ${res.status}`);
  const layer = (await res.json()) as LayerJson;
  const template = TERRAIN_BASE + layer.tiles[0]!.replace('{version}', layer.version);
  return {
    maxZoom: layer.maxzoom,
    url: (z, x, y) =>
      template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)),
  };
}
