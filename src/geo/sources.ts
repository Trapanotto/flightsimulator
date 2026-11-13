/** swisstopo / geo.admin.ch data sources of the world (free to use, credit "© swisstopo"). */

export const TERRAIN_BASE = 'https://3d.geo.admin.ch/ch.swisstopo.terrain.3d/v1/';

/** SWISSIMAGE orthophotos, Web Mercator WMTS, down to zoom 20 (about 10 cm per pixel here). */
export const SWISSIMAGE_URL =
  'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg';
export const SWISSIMAGE_MAX_ZOOM = 20;

/** swisstopo base vector tiles (Web Mercator, zoom 0..14): water, land cover, roads, ... */
export const VECTOR_TILE_URL =
  'https://vectortiles.geo.admin.ch/tiles/ch.swisstopo.base.vt/v1.0.0/{z}/{x}/{y}.pbf';
export const VECTOR_TILE_MAX_ZOOM = 14;

export const SWISSTOPO_ATTRIBUTION = '© swisstopo';

export function fillTemplate(template: string, z: number, x: number, y: number): string {
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

/** The parts of a terrain layer.json the client needs. */
export interface TerrainLayer {
  /** URL template with {z}/{x}/{y}; already carries the data version. */
  template: string;
  maxZoom: number;
}

/**
 * Reads swisstopo's terrain layer.json. The tile path contains a data date and a version that
 * change with every data update, so they must come from here, not from a constant.
 */
export function parseTerrainLayer(json: unknown, base = TERRAIN_BASE): TerrainLayer {
  const layer = json as { tiles?: string[]; version?: string; maxzoom?: number; format?: string };
  const tile = layer.tiles?.[0];
  if (!tile || layer.format !== 'quantized-mesh-1.0')
    throw new Error('terrain layer.json: no quantized-mesh tiles');
  return {
    template: base + tile.replace('{version}', layer.version ?? ''),
    maxZoom: layer.maxzoom ?? 14,
  };
}
