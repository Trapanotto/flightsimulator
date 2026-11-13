/**
 * Contracts of the simulation. Plain data, no renderer types: three's Vector3 and Quaternion
 * are structurally compatible, so the render side can pass its own objects in.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * Rigid-body state of one aircraft.
 *
 * World frame: ECEF, metres (WGS84). JavaScript numbers are doubles, so millimetre precision
 * holds over the whole country. Body frame: x forward, y right, z down (flight dynamics
 * convention). `orientation` turns body vectors into world vectors.
 */
export interface AircraftState {
  position: Vec3;
  orientation: Quat;
  /** Velocity of the centre of gravity in the world frame, m/s. */
  velocity: Vec3;
  /** Angular velocity in the body frame, rad/s (roll, pitch, yaw rates). */
  angularVelocity: Vec3;
}

/** What the pilot (or the autopilot) commands. Axes -1..1, levers 0..1. */
export interface ControlInput {
  /** Positive = stick back, nose up. */
  pitch: number;
  /** Positive = roll right. */
  roll: number;
  /** Positive = nose right. */
  yaw: number;
  /** One entry per engine. */
  throttle: number[];
  flaps: number;
  gearDown: boolean;
  /** Left and right wheel brakes. */
  brakeLeft: number;
  brakeRight: number;
  parkingBrake: boolean;
}

/** The air at one point. */
export interface AirSample {
  /** Velocity of the air mass in the world frame, m/s (wind, up- and downdraughts, gusts). */
  wind: Vec3;
  /** kg/m^3 */
  density: number;
  /** K */
  temperature: number;
  /** Pa */
  pressure: number;
}

/** Kind of surface under a wheel; sets rolling and braking friction. */
export type Surface = 'asphalt' | 'concrete' | 'grass' | 'gravel' | 'snow' | 'water' | 'terrain';

export interface GroundSample {
  /** Height of the surface above the ellipsoid at this point, metres. */
  height: number;
  /** Unit normal of the surface in the world frame. */
  normal: Vec3;
  surface: Surface;
  /** 0 dry .. 1 standing water or slush. */
  wetness: number;
}

/**
 * Everything the simulation needs to know about the world. Implemented by the app from the
 * `world` and `sky` packages; the simulation never reaches into them itself.
 */
export interface Environment {
  /** Local vertical (unit vector away from the Earth) at a world position. */
  up(position: Vec3, out: Vec3): Vec3;
  /** Height above the ellipsoid of a world position, metres. */
  altitude(position: Vec3): number;
  air(position: Vec3, out: AirSample): AirSample;
  /** Ground below a world position, or undefined while the terrain there is not loaded. */
  ground(position: Vec3): GroundSample | undefined;
}

/** A simulated aircraft: advanced in fixed steps, read by renderer, audio and instruments. */
export interface SimAircraft {
  readonly state: AircraftState;
  readonly controls: ControlInput;
  /** Advances by `dt` seconds (always the fixed step). */
  step(dt: number, env: Environment): void;
}
