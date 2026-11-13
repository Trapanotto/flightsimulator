import type { LocalFrame } from '@geo';
import type { DeviceClass, WorldLayer } from '../layers';
import { BuildingLayer } from './BuildingLayer';

export { BuildingLayer, type BuildingStats } from './BuildingLayer';
export { BUILDING_PRESETS, type BuildingPreset } from './presets';

/**
 * The buildings of the world: swissBUILDINGS3D models near the camera, extruded footprints
 * with generated roofs further out. The layer's group carries `userData.stats()` (see
 * BuildingStats) for demo pages and performance notes, which only see the World.
 */
export function createBuildingLayer(frame: LocalFrame, device: DeviceClass): WorldLayer {
  const layer = new BuildingLayer(frame, device);
  layer.object.userData.stats = () => layer.stats();
  return layer;
}
