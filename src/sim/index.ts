/**
 * sim – flight model, engines, systems and the air. Plain TypeScript: no renderer, no DOM,
 * runs in Node for tests. Depends on no other package.
 */
export type {
  AircraftState,
  AirSample,
  ControlInput,
  Environment,
  GroundSample,
  Quat,
  SimAircraft,
  Surface,
  Vec3,
} from './types';
export { FixedStep, SIM_DT, SIM_HZ } from './fixedStep';
export { isa, type IsaSample } from './atmosphere';
