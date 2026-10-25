/**
 * Building footprints from geo.admin.ch vector tiles (ch.swisstopo.base.vt) and the rules that
 * turn them into regional house types. Pure functions (used in a worker and in tests).
 */
import type { ChurchType, HouseType } from './BuildingSet';

export const VECTOR_TILE_URL =
  'https://vectortiles.geo.admin.ch/tiles/ch.swisstopo.base.vt/v1.0.0/{z}/{x}/{y}.pbf';
export const VECTOR_ZOOM = 14;

export interface Footprint {
  lon: number;
  lat: number;
  /** Direction of the long side, degrees counter-clockwise from east. */
  angle: number;
  length: number;
  width: number;
  /** Total height (ground to ridge), metres. */
  height: number;
  area: number;
}

export interface TileBuildings {
  footprints: Footprint[];
  churches: Array<{ lon: number; lat: number }>;
  canton: string | null;
  /** Tree positions as lon, lat pairs. */
  trees: Float64Array;
  /** Named places (village, town, ...) for the HUD. */
  places: Array<{ name: string; cls: string; lon: number; lat: number }>;
}

/**
 * Oriented box of a polygon ring (metres, local x east / y north) from its principal axes.
 * Good for the mostly rectangular Swiss houses; area is the polygon's own area.
 */
export function orientedBox(ring: Array<[number, number]>): {
  cx: number;
  cy: number;
  angle: number;
  length: number;
  width: number;
  area: number;
} {
  const n = ring.length;
  let area2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[(i + 1) % n]!;
    const cross = x0 * y1 - x1 * y0;
    area2 += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  const area = Math.abs(area2) / 2;
  if (area < 1e-6) {
    cx = ring.reduce((s, p) => s + p[0], 0) / n;
    cy = ring.reduce((s, p) => s + p[1], 0) / n;
  } else {
    cx /= 3 * area2;
    cy /= 3 * area2;
  }
  // Orientation from the longest edges (weighted by length), robust for L-shapes and rectangles.
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[(i + 1) % n]!;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    // Double the angle so opposite and perpendicular edges add up instead of cancelling.
    const a = Math.atan2(dy, dx) * 4;
    sx += Math.cos(a) * len;
    sy += Math.sin(a) * len;
  }
  let angle = Math.atan2(sy, sx) / 4;
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  let minU = Infinity,
    maxU = -Infinity,
    minV = Infinity,
    maxV = -Infinity;
  for (const [x, y] of ring) {
    const u = (x - cx) * ca + (y - cy) * sa;
    const v = -(x - cx) * sa + (y - cy) * ca;
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  let length = maxU - minU;
  let width = maxV - minV;
  // Centre of the box (may differ from the centroid for L-shapes).
  const bu = (minU + maxU) / 2;
  const bv = (minV + maxV) / 2;
  const bx = cx + bu * ca - bv * sa;
  const by = cy + bu * sa + bv * ca;
  if (width > length) {
    [length, width] = [width, length];
    angle += Math.PI / 2;
  }
  return { cx: bx, cy: by, angle, length, width, area };
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

export type Region = 'mittelland' | 'oberland' | 'valais' | 'engadin' | 'graubuenden' | 'ticino';

const CANTON_REGION: Record<string, Region> = {
  Ticino: 'ticino',
  Wallis: 'valais',
  'Valais/Wallis': 'valais',
  Valais: 'valais',
  Graubünden: 'graubuenden',
  'Graubünden/Grigioni/Grischun': 'graubuenden',
  Uri: 'oberland',
  Obwalden: 'oberland',
  Nidwalden: 'oberland',
  Glarus: 'oberland',
  'Appenzell Innerrhoden': 'oberland',
};

/** Region of a place from its canton, position and elevation. */
export function regionOf(
  canton: string | null,
  lon: number,
  lat: number,
  elevation: number,
): Region {
  const c = canton ? CANTON_REGION[canton] : undefined;
  // South of the Alps outside Ticino too: Misox, Bergell, Puschlav.
  if (c === 'ticino' || (lat < 46.42 && lon > 8.45 && lon < 10.2 && c !== 'valais'))
    return 'ticino';
  if (c === 'valais') return 'valais';
  if (c === 'graubuenden')
    return lon > 9.55 && lat < 46.85 && elevation > 1350 ? 'engadin' : 'graubuenden';
  if (c === 'oberland') return 'oberland';
  // Alpine north side (Bernese Oberland, Fribourg/Vaud Alps, central Switzerland): south of
  // roughly Thun–Lucerne, chalets already from ~550 m (Interlaken, Lauterbrunnen).
  if (lat < 46.76 && lon > 6.8 && lon < 9.6 && elevation > 550) return 'oberland';
  if (elevation > 800 && lat < 46.95 && lon > 8.2) return 'oberland';
  if (elevation > 950) return 'oberland';
  return 'mittelland';
}

/**
 * House type for a footprint. `dense` = the tile has many buildings (town), so small houses are
 * urban family houses rather than farms.
 */
export function houseTypeOf(
  f: Footprint,
  region: Region,
  elevation: number,
  dense: boolean,
): HouseType {
  if (f.area < 38) return 'shed';
  if (f.height >= 14 || (f.area > 700 && f.height >= 11)) return 'block';
  if ((f.area > 900 && f.height < 14) || (f.area > 500 && f.height < 8)) return 'hall';
  switch (region) {
    case 'ticino':
      return f.area < 90 ? 'rustico' : f.height > 10 && dense ? 'urban' : 'ticino';
    case 'engadin':
      return 'engadin';
    case 'valais':
      return elevation > 900 ? 'valais' : dense ? 'urban' : 'valais';
    case 'graubuenden':
      return elevation > 1000
        ? f.area < 140
          ? 'valais'
          : 'chalet'
        : dense
          ? 'urban'
          : 'farmhouse';
    case 'oberland':
      return dense && f.height > 10 ? 'urban' : 'chalet';
    case 'mittelland':
    default:
      if (dense) return f.area > 260 && f.height < 10 ? 'farmhouse' : 'urban';
      return f.area > 150 ? 'farmhouse' : 'urban';
  }
}

export function churchTypeOf(region: Region): ChurchType {
  return region === 'ticino' ? 'campanile' : 'spire';
}

/** Roof pitch per type (degrees), to split total height into walls + roof. */
export const ROOF_PITCH: Record<HouseType, number> = {
  farmhouse: 42,
  chalet: 24,
  valais: 28,
  engadin: 20,
  rustico: 28,
  ticino: 18,
  urban: 35,
  block: 0,
  hall: 0,
  shed: 12,
};

/** Wall height so that walls + roof reach the footprint's total height. */
export function wallHeight(type: HouseType, f: Footprint): number {
  const roof = (f.width / 2) * Math.tan((ROOF_PITCH[type] * Math.PI) / 180);
  const minimum = type === 'farmhouse' ? 3.2 : 2.6;
  return Math.max(minimum, Math.min(f.height - roof, 60));
}

// ---------------------------------------------------------------------------
// Plaster colours by region (linear-ish RGB multipliers on white plaster)
// ---------------------------------------------------------------------------

const PALETTES: Record<Region | 'urban', Array<[number, number, number]>> = {
  ticino: [
    [1, 0.86, 0.62],
    [1, 0.78, 0.66],
    [0.98, 0.92, 0.7],
    [0.95, 0.83, 0.76],
    [1, 0.95, 0.85],
  ],
  urban: [
    [1, 0.97, 0.9],
    [0.94, 0.94, 0.92],
    [1, 0.93, 0.78],
    [0.92, 0.9, 0.86],
    [0.97, 0.9, 0.85],
  ],
  engadin: [
    [1, 1, 0.97],
    [0.98, 0.96, 0.92],
  ],
  mittelland: [
    [1, 0.97, 0.92],
    [0.97, 0.95, 0.9],
  ],
  oberland: [[1, 0.97, 0.92]],
  valais: [[0.98, 0.96, 0.9]],
  graubuenden: [
    [1, 0.98, 0.94],
    [0.97, 0.94, 0.88],
  ],
};

/** Deterministic plaster tint for a building (same house, same colour on every visit). */
export function tintOf(
  region: Region,
  type: HouseType,
  lon: number,
  lat: number,
): [number, number, number] {
  const palette =
    type === 'urban' || type === 'block'
      ? region === 'ticino'
        ? PALETTES.ticino
        : PALETTES.urban
      : PALETTES[region];
  const h = Math.abs(Math.sin(lon * 12_989.8 + lat * 78_233.1) * 43_758.5453) % 1;
  return palette[Math.floor(h * palette.length) % palette.length]!;
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

export const TREE_TYPES = ['spruce', 'fir', 'larch', 'arve', 'beech', 'chestnut'] as const;
export type TreeType = (typeof TREE_TYPES)[number];

const TREE_HEIGHT: Record<TreeType, [number, number]> = {
  spruce: [18, 32],
  fir: [18, 30],
  larch: [15, 28],
  arve: [8, 15],
  beech: [14, 26],
  chestnut: [10, 18],
};

/** Species by elevation and region; deterministic per position. Null = no tree (too high). */
export function treeOf(
  region: Region,
  elevation: number,
  lon: number,
  lat: number,
): { type: TreeType; height: number } | null {
  const h = Math.abs(Math.sin(lon * 91_234.7 + lat * 47_123.9) * 43_758.5453) % 1;
  const h2 = Math.abs(Math.sin(lon * 17_771.3 + lat * 61_337.1) * 24_634.6345) % 1;
  if (elevation > 2350) return null;
  let type: TreeType;
  const alpine = region === 'engadin' || region === 'valais';
  if (region === 'ticino' && elevation < 1000)
    type = h < 0.55 ? 'chestnut' : h < 0.85 ? 'beech' : 'spruce';
  else if (elevation < 650) type = h < 0.45 ? 'beech' : h < 0.85 ? 'spruce' : 'fir';
  else if (elevation < 1350)
    type = h < 0.65 ? 'spruce' : h < 0.85 ? 'fir' : alpine ? 'larch' : 'beech';
  else if (elevation < 1900)
    type = alpine
      ? h < 0.5
        ? 'larch'
        : h < 0.75
          ? 'arve'
          : 'spruce'
      : h < 0.6
        ? 'spruce'
        : h < 0.85
          ? 'larch'
          : 'arve';
  else type = h < 0.55 ? 'larch' : 'arve';
  const [lo, hi] = TREE_HEIGHT[type];
  // Smaller towards the tree line.
  const shrink = elevation > 1800 ? Math.max(0.45, 1 - (elevation - 1800) / 1000) : 1;
  return { type, height: (lo + (hi - lo) * h2) * shrink };
}
