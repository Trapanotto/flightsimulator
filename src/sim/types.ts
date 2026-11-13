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
  /** Elevator trim, -1 (nose down) .. 1 (nose up). */
  pitchTrim: number;
  /** One entry per engine: 0 idle cut-off .. 1 full rich (piston engines). */
  mixture: number[];
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
  /** Unit vector towards true north in the horizontal plane at a world position. */
  north(position: Vec3, out: Vec3): Vec3;
  /** Height above the ellipsoid of a world position, metres. */
  altitude(position: Vec3): number;
  air(position: Vec3, out: AirSample): AirSample;
  /** Ground below a world position, or undefined while the terrain there is not loaded. */
  ground(position: Vec3): GroundSample | undefined;
}

/** One engine as instruments, sound and the 3D model see it. */
export interface EngineTelemetry {
  running: boolean;
  /** Propeller or fan speed, revolutions per minute. */
  rpm: number;
  /** Output as a fraction of rated power or thrust, 0..1 (above 1 with afterburner). */
  power: number;
  /** kg/s */
  fuelFlow: number;
}

/**
 * Derived values of one aircraft, refreshed every step. Everything outside the simulation
 * (instruments, HUD, sound, moving parts of the model, camera) reads these instead of
 * recomputing them. SI units, angles in radians unless the name says degrees.
 */
export interface Telemetry {
  /** Simulated seconds since the reset. */
  time: number;
  /** Indicated and true airspeed, ground speed, m/s. */
  ias: number;
  tas: number;
  groundSpeed: number;
  /** Height above the ellipsoid, m. */
  altitude: number;
  /** Height of the lowest wheel above the ground, m; undefined while the ground is not loaded. */
  agl: number | undefined;
  /** m/s, positive up. */
  verticalSpeed: number;
  /** True heading and track over the ground, degrees 0..360. */
  headingDeg: number;
  trackDeg: number;
  /** Nose above the horizon and bank to the right, radians. */
  pitch: number;
  bank: number;
  /** Angle of attack and sideslip, radians. */
  alpha: number;
  beta: number;
  /** Load factor along the body's up axis (1 in level flight). */
  loadFactor: number;
  onGround: boolean;
  /** The stall warning sounds. */
  stallWarning: boolean;
  /** Actual positions (they lag the levers): flaps 0..1, gear 0 up .. 1 down. */
  flaps: number;
  gear: number;
  /** Control surface deflections actually reached, -1..1 (elevator, ailerons, rudder). */
  elevator: number;
  aileron: number;
  rudder: number;
  engines: EngineTelemetry[];
  /** kg */
  fuel: number;
  /** Set once the aircraft is destroyed; the reason is a short code like 'ground' or 'overstress'. */
  crashed: string | undefined;
}

/** Where and how a flight starts. */
export interface InitialCondition {
  /** World position (ECEF) of the aircraft's reference point. On the ground: of the ground below it. */
  position: Vec3;
  /** True heading, degrees. */
  headingDeg: number;
  /** True airspeed along the heading, m/s (0 on the ground). */
  speed: number;
  onGround: boolean;
  /** Engines running (default true). */
  enginesRunning?: boolean;
}

/** The aircraft types the simulation knows. */
export type AircraftId = 'c172';

/** Figures of a type that menus and the camera need without flying it. */
export interface AircraftInfo {
  id: AircraftId;
  name: string;
  engines: number;
  /** m/s: stall speed clean and in landing configuration, never-exceed speed. */
  vs: number;
  vs0: number;
  vne: number;
  /** kg */
  maxTakeoffMass: number;
  retractableGear: boolean;
}

/** A simulated aircraft: advanced in fixed steps, read by renderer, audio and instruments. */
export interface SimAircraft {
  readonly info: AircraftInfo;
  readonly state: AircraftState;
  /** Written by the app from the pilot's input before each step. */
  readonly controls: ControlInput;
  readonly telemetry: Telemetry;
  /** Places the aircraft, trimmed for the condition, and clears everything else. */
  reset(start: InitialCondition, env: Environment): void;
  /** Advances by `dt` seconds (always the fixed step). */
  step(dt: number, env: Environment): void;
}
