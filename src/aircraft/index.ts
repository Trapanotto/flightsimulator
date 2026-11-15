/**
 * aircraft – 3D models, cockpits and avionics displays, driven by the simulation state.
 * Depends on: sim.
 */
export {
  type AircraftVisual,
  type AircraftVisualOptions,
  type ControlHit,
  type Vec3Like,
  createReferenceMarker,
  loadAircraftVisual,
} from './AircraftVisual';
export type { AircraftLights } from './lights';
export {
  type ClickTarget,
  type PressResult,
  LEVER_DRAG_SPAN,
  REPEAT,
  dragControl,
  isDragged,
  pressControl,
  turnKnob,
  wheelControl,
} from './controlClicks';
export {
  EXPLOSION_DELAY,
  ImpactWatch,
  LAYOUTS,
  type BreakPlan,
  type Impact,
  type ImpactTelemetry,
  type Layout,
  type PieceKind,
  type Region,
  type Role,
  type Severity,
  fireGain,
  impactOf,
  pieceKey,
  planBreak,
  regionOf,
  roleOf,
  severityOf,
  sizeFactor,
  splitTriangles,
} from './wreck/breakup';
export { ParticleSystem, type ParticleSpec } from './wreck/particles';
export { WreckFx, type WreckFxOptions } from './wreck/WreckFx';
export { Wreck, type WreckEnv, type WreckOptions } from './wreck/Wreck';
