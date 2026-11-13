import type { DeviceClass } from '../layers';

/** How much of the building stock is drawn and how fast it streams. */
export interface BuildingPreset {
  /** Footprint buildings (vector tiles) out to this distance from the camera, metres. */
  footprintRange: number;
  /** At night, lit windows are seen from further: footprints out to this distance. */
  nightRange: number;
  /** Within this distance footprint tiles are built in full (eaves, sheds, every corner). */
  footprintDetailRange: number;
  /** swissBUILDINGS3D models within this distance; 0 = footprints only. */
  detailRange: number;
  /** At most this many swissBUILDINGS3D cells at once (a city centre is dense). */
  maxCells: number;
  workers: number;
  /** Downloads and builds at the same time (also the request limit towards swisstopo). */
  inFlight: number;
  /** Tiles handed to the GPU per frame, and the vertex bytes that may take. */
  uploadsPerFrame: number;
  uploadBytesPerFrame: number;
  /** Spacing of the ground samples under footprint tiles, metres. */
  groundStep: number;
  /** Milliseconds per frame for sampling the terrain under the buildings. */
  groundBudgetMs: number;
  /** Buildings closer than this cast shadows (the shadow map only covers the aircraft). */
  shadowRange: number;
  fadeSeconds: number;
}

export const BUILDING_PRESETS: Record<DeviceClass, BuildingPreset> = {
  desktop: {
    footprintRange: 12_000,
    nightRange: 22_000,
    footprintDetailRange: 3_500,
    detailRange: 900,
    maxCells: 140,
    workers: 3,
    inFlight: 8,
    uploadsPerFrame: 3,
    uploadBytesPerFrame: 3 * 2 ** 20,
    groundStep: 30,
    groundBudgetMs: 1.5,
    shadowRange: 1_500,
    fadeSeconds: 0.7,
  },
  mobile: {
    footprintRange: 5_000,
    nightRange: 9_000,
    footprintDetailRange: 1_500,
    detailRange: 300,
    maxCells: 24,
    workers: 2,
    inFlight: 4,
    uploadsPerFrame: 1,
    uploadBytesPerFrame: 2 ** 20,
    groundStep: 45,
    groundBudgetMs: 1,
    shadowRange: 600,
    fadeSeconds: 0.7,
  },
};

/** Footprint tile builds: 0 in full, 1 simplified, 2 flat boxes for the night-only ring. */
export type FootprintLod = 0 | 1 | 2;

/**
 * The build a footprint tile at this distance should have. A tile keeps its build while it is
 * within 15 % of that build's distance band, so flying along a boundary does not rebuild it.
 */
export function footprintLod(
  distance: number,
  current: FootprintLod | undefined,
  p: Pick<BuildingPreset, 'footprintDetailRange' | 'footprintRange'>,
): FootprintLod {
  const target: FootprintLod =
    distance < p.footprintDetailRange ? 0 : distance < p.footprintRange ? 1 : 2;
  if (current === undefined) return target;
  const bands = [0, p.footprintDetailRange, p.footprintRange, Infinity];
  const lo = bands[current]! * 0.85;
  const hi = bands[current + 1]! * 1.15;
  return distance >= lo && distance <= hi ? current : target;
}
