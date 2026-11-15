/**
 * Propulsion behind one interface. A type lists its engines (`AircraftDefinition.engines`),
 * each a piston engine, a turboprop, a turbofan or an afterburning turbofan at its own place
 * on the airframe; the flight model steps every one with its own levers and air, applies its
 * thrust at its position (so asymmetric thrust yaws the aircraft) and fills one telemetry
 * entry per engine.
 *
 * Engines that turn a propeller do not compute thrust themselves: the flight model owns the
 * propeller's aerodynamics (its quadrants see the local flow, which is where P-factor and the
 * slipstream come from) and hands the engine a `Rotor` to ask what torque the propeller
 * absorbs at a shaft speed and blade angle. Jets put out a thrust along their axis.
 */
import type { EngineTelemetry, Vec3 } from '../types';

export type PowerplantKind = 'piston' | 'turboprop' | 'turbofan' | 'afterburning';

/** Everything an engine is given each step. Each kind reads what it has. */
export interface PowerplantInput {
  /** Power lever, 0 idle .. 1 maximum (with afterburner for an afterburning engine). */
  throttle: number;
  /** Reverse selected: `throttle` then commands reverse, 0 idle .. 1 full. */
  reverse: boolean;
  /** Condition lever or engine master, 0 cut-off .. 1 run (0.5 a turboprop's ground idle). */
  condition: number;
  /** Mixture, piston engines: 0 idle cut-off .. 1 full rich. */
  mixture: number;
  /**
   * The starter is engaged this step (key held, start button pressed, start switch on). A
   * turbine latches its own start sequence from the first press.
   */
  starter: boolean;
  /** Share of the starter's torque the supply (battery voltage, bleed pressure) can drive. */
  starterPower: number;
  /** Ignition: share of combustion power the sparks give (piston), igniters lit (turbine). */
  ignition: number;
  /** Continuous ignition selected (a turbine's igniters stay on outside the start). */
  continuousIgnition: boolean;
  /** Fuel reaches the engine. */
  hasFuel: boolean;
  /** The engine has failed: no power whatever the controls. */
  failed: boolean;
  /** Piston: share of the manifold pressure the induction lets through; a cold engine fires. */
  intake: number;
  fireable: boolean;
  /** Turbine: share of the inlet total pressure that reaches the compressor (inlet ice). */
  inletRecovery: number;
  /** Turboprop: the inertial separator is open (it costs inlet pressure). */
  inertialSeparator: boolean;
  /** Turbine: bleed air and accessories taken off the gas generator, as shaft power, W. */
  bleed: number;
  /** Static air at the inlet. */
  pressure: number;
  temperature: number;
  density: number;
  mach: number;
  /** Air speed along the engine's axis at the inlet, m/s. */
  airspeed: number;
  onGround: boolean;
}

export const newPowerplantInput = (): PowerplantInput => ({
  throttle: 0,
  reverse: false,
  condition: 1,
  mixture: 1,
  starter: false,
  starterPower: 1,
  ignition: 1,
  continuousIgnition: false,
  hasFuel: true,
  failed: false,
  intake: 1,
  fireable: true,
  inletRecovery: 1,
  inertialSeparator: false,
  bleed: 0,
  pressure: 101_325,
  temperature: 288.15,
  density: 1.225,
  mach: 0,
  airspeed: 0,
  onGround: false,
});

/** The propeller an engine drives, as the flight model computes it. */
export interface Rotor {
  /**
   * Torque (N m) the propeller absorbs at shaft speed `omega` (rad/s) with blade angle
   * `beta` (rad, ignored by a fixed-pitch propeller). With `apply` its thrust and forces go
   * on the airframe and into the slipstream; without, it is only asked (governor, trim).
   */
  absorb(omega: number, beta: number, apply: boolean): number;
}

export interface Powerplant {
  readonly kind: PowerplantKind;
  readonly telemetry: EngineTelemetry;
  /** Thrust along the engine axis, N (jets; 0 for propeller engines, whose rotor applies it). */
  readonly thrust: number;
  /** Torque the engine puts on the airframe about body x, N m (its reaction to the shaft). */
  readonly reactionTorque: number;
  /** kg/s */
  readonly fuelFlow: number;
  /** Angular momentum of the spinning parts along the engine axis, kg m²/s (gyroscopic). */
  readonly angularMomentum: number;
  /** What drives the accessory gearbox: shaft rpm (piston) or gas generator speed, per cent. */
  readonly accessorySpeed: number;
  readonly running: boolean;
  /** Output over rated output, for temperatures, sound and the systems. */
  readonly load: number;
  /** The starter turns the engine this step (it draws current or bleed air). */
  readonly cranking: boolean;
  /** Back to a running or a stopped, cold engine. */
  reset(running: boolean, inAir: boolean): void;
  step(dt: number, input: PowerplantInput, rotor: Rotor | undefined): void;
  /** Steady state at these levers, without the lags: for the trim solver. */
  settle(input: PowerplantInput, rotor: Rotor | undefined): void;
  /** Everything stops at once (the aircraft is wrecked). */
  stop(): void;
}

/** Where an engine sits and which way it points, body frame. */
export interface Mounting {
  /** Thrust point (a propeller's hub, a jet's nozzle), body frame, m. */
  position: Vec3;
  /** Unit thrust direction (default body x). */
  axis?: Vec3;
}

/** ISA sea level, for corrected engine parameters. */
export const P0 = 101_325;
export const T0 = 288.15;

/** Total-to-static ratios at a Mach number (ideal ram recovery, gamma 1.4). */
export function ramRatios(mach: number, out: { theta: number; delta: number }) {
  const m = Math.max(0, mach);
  const t = 1 + 0.2 * m * m;
  out.theta = t;
  out.delta = t ** 3.5;
  return out;
}
