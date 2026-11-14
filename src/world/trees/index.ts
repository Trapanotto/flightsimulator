import type { LocalFrame } from '@geo';
import type { DeviceClass, WorldLayer } from '../layers';
import { TreeLayer } from './TreeLayer';

/**
 * The trees of the world: real 3D trees where swisstopo's vector tiles have forest, groves,
 * scrub and single trees.
 *
 * - Chunks are the zoom-14 vector tiles (about 1.7 km). A Web Worker downloads the tile, the
 *   orthophoto at 3 m and a coarse terrain tile, rasterises forest and exclusions (water,
 *   buildings, roads, runways) and scatters trees on a jittered global grid with hashes of the
 *   cell, so every tree is the same on every visit and for every player (scatter.ts).
 * - Species follow the elevation belts of the Swiss forest inventory, tilted by the photo
 *   (dark stands are conifers); the tree line thins and stunts them (species.ts).
 * - Each tree takes the colour of the photo under it relative to its species' summer colour, so
 *   the forest sits in the orthophoto and fades into it seamlessly; seasons recolour that.
 * - Three levels of detail per form (tiered conifer, lumpy broadleaf) with screen-door
 *   cross-fades, thinning with distance by a per-tree rank, a smooth fade-out (material.ts).
 * - Trees stand on a height grid sampled from the loaded terrain and glide to new heights when
 *   finer terrain arrives (seat.ts).
 */
export function createTreeLayer(frame: LocalFrame, device: DeviceClass): WorldLayer {
  return new TreeLayer(frame, device);
}

export { TREE_PRESETS, type TreePreset } from './presets';
