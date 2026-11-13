/**
 * aircraft – 3D models, cockpits and avionics displays, driven by the simulation state.
 * Depends on: sim.
 */
export {
  type AircraftVisual,
  type AircraftVisualOptions,
  type Vec3Like,
  createReferenceMarker,
  loadAircraftVisual,
} from './AircraftVisual';
export type { AircraftLights } from './lights';
