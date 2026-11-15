/**
 * Control laws: the step between what the pilot (or the autopilot) asks for and where the
 * surfaces go. The flight model calls the type's law once per step with the pilot's input,
 * the state and the telemetry; the law fills a surface command, which the flight model then
 * moves the surfaces towards at their rate limits.
 *
 * - `DirectLaw`: mechanical controls (the Cessna; the PC-12 with its stick pusher and yaw
 *   damper). The yoke moves the surfaces in proportion, and with reversible controls the pilot
 *   cannot hold full deflection against high air loads.
 * - `PassThroughLaw`: the trivial fly-by-wire law, stick to surfaces with powered actuators.
 *   The A320's and the F/A-18's own laws replace it (`AircraftDefinition.controlLaw`).
 */
import type { AircraftDefinition } from './definition';
import { clamp } from './math';
import type { AircraftState, ControlInput, Telemetry } from './types';

/** Where the surfaces should go. Angles in rad, shares of travel -1..1 or 0..1. */
export interface SurfaceCommand {
  /** Elevator (or stabilator), rad, positive trailing edge up (nose up); a tab's trim included. */
  elevator: number;
  /** Incidence of a movable stabiliser, rad, positive nose up (0 for tab-trimmed types). */
  stabiliser: number;
  /** Ailerons, -1..1, positive rolls right (right aileron up). */
  aileron: number;
  /** Rudder, -1..1, positive nose right. */
  rudder: number;
  /** Spoilers on both wings and the fuselage speed brake, 0..1. */
  spoilers: number;
  speedbrake: number;
  /** Differential tail, -1..1, positive rolls right. */
  differentialTail: number;
  /** Trailing-edge flaps and leading-edge devices, rad; undefined: as the flap lever schedules. */
  flap: number | undefined;
  leadingEdge: number | undefined;
}

export const newSurfaceCommand = (): SurfaceCommand => ({
  elevator: 0,
  stabiliser: 0,
  aileron: 0,
  rudder: 0,
  spoilers: 0,
  speedbrake: 0,
  differentialTail: 0,
  flap: undefined,
  leadingEdge: undefined,
});

/** What a law is given each step. */
export interface ControlLawContext {
  /** The pilot's controls as the app wrote them. */
  readonly controls: ControlInput;
  /** Stick input flown this step: the pilot's, or the autopilot's while it is engaged. */
  readonly pitch: number;
  readonly roll: number;
  readonly yaw: number;
  readonly state: AircraftState;
  /** Telemetry of the end of the last step. */
  readonly telemetry: Telemetry;
  /** Dynamic pressure (Pa) and Mach number now. */
  readonly q: number;
  readonly mach: number;
  /** Angle of attack at the stall warning vane, rad. */
  readonly vaneAlpha: number;
  /** The surface actuators have power (hydraulic pressure, or always for mechanical controls). */
  readonly powered: boolean;
  /** The yaw damper is engaged (the avionics' YD button). */
  readonly yawDamper: boolean;
  /** The stall protection has power. */
  readonly stallProtection: boolean;
  readonly dt: number;
}

export interface ControlLaw {
  /** Stick shaker and pusher are active (for telemetry and sound). */
  readonly shaker: boolean;
  readonly pusher: boolean;
  reset(): void;
  step(ctx: ControlLawContext, out: SurfaceCommand): void;
}

/** Pitch trim as a stabiliser incidence or an equivalent elevator angle, rad. */
export function trimAngle(def: AircraftDefinition, trim: number): number {
  const c = def.controls;
  const t = clamp(trim, -1, 1);
  return t >= 0 ? t * c.trimUp : t * c.trimDown;
}

/** Mechanical controls, with optional stick shaker and pusher and a yaw damper servo. */
export class DirectLaw implements ControlLaw {
  shaker = false;
  pusher = false;
  private pushTime = 0;
  private yawRateLow = 0;

  constructor(readonly def: AircraftDefinition) {}

  reset() {
    this.shaker = false;
    this.pusher = false;
    this.pushTime = 0;
    this.yawRateLow = 0;
  }

  step(ctx: ControlLawContext, out: SurfaceCommand) {
    const def = this.def;
    const c = def.controls;
    const ci = ctx.controls;
    // Reversible controls: at high dynamic pressure the pilot cannot hold full deflection.
    const hold = Math.min(1, c.holdLimitPressure / Math.max(ctx.q, 1));
    const p = clamp(ctx.pitch, -1, 1) * hold;
    const stick = p >= 0 ? p * c.elevatorUp : p * c.elevatorDown;
    const trim = trimAngle(def, ci.pitchTrim);
    if (c.trim === 'stabiliser') {
      out.stabiliser = trim;
      out.elevator = clamp(stick, -c.elevatorDown, c.elevatorUp);
    } else {
      out.stabiliser = 0;
      out.elevator = clamp(trim + stick, -c.elevatorDown, c.elevatorUp);
    }
    this.stallProtection(ctx, out);
    let aileron = clamp(ctx.roll, -1, 1) * hold + c.aileronRigging;
    if (c.rollTrim) aileron += c.rollTrim * clamp(ci.rollTrim ?? 0, -1, 1);
    out.aileron = clamp(aileron, -1, 1);
    let rudder = clamp(ctx.yaw, -1, 1) * hold + c.rudderRigging;
    if (c.yawTrim) rudder += c.yawTrim * clamp(ci.yawTrim ?? 0, -1, 1);
    rudder += this.yawDamper(ctx);
    out.rudder = clamp(rudder, -1, 1);
    out.spoilers = clamp(ci.speedbrake ?? 0, 0, 1);
    out.speedbrake = out.spoilers;
    out.differentialTail = 0;
    out.flap = undefined;
    out.leadingEdge = undefined;
  }

  /** Shaker, then pusher, by the vane angle for the flap setting. */
  private stallProtection(ctx: ControlLawContext, out: SurfaceCommand) {
    const sp = this.def.stallProtection;
    if (!sp) return;
    const on = ctx.stallProtection && !ctx.telemetry.onGround;
    const detents = sp.pusher.length - 1;
    const x = clamp(ctx.telemetry.flaps, 0, 1) * detents;
    const i = Math.min(Math.floor(x), detents - 1);
    const f = x - i;
    const shake = sp.shaker[i]! + (sp.shaker[i + 1]! - sp.shaker[i]!) * f;
    const push = sp.pusher[i]! + (sp.pusher[i + 1]! - sp.pusher[i]!) * f;
    const a = ctx.vaneAlpha;
    this.shaker = on && a > shake;
    if (on && a > push) {
      this.pusher = true;
      this.pushTime = 0;
    } else if (this.pusher) {
      this.pushTime += ctx.dt;
      // Held for at least a second, until the angle is well back.
      if (!on || (a < push - sp.release && this.pushTime > 1)) this.pusher = false;
    }
    if (this.pusher) {
      // The pusher's servo overpowers the pilot's pull.
      const down = -sp.push * this.def.controls.elevatorDown;
      out.elevator = Math.min(out.elevator, down);
    }
  }

  /** Rudder against the yaw rate, washed out so a steady turn is not opposed. */
  private yawDamper(ctx: ControlLawContext): number {
    const yd = this.def.yawDamper;
    if (!yd) return 0;
    const r = ctx.state.angularVelocity.z;
    this.yawRateLow += (r - this.yawRateLow) * (1 - Math.exp(-ctx.dt / yd.washout));
    if (!ctx.yawDamper || ctx.telemetry.onGround) return 0;
    return clamp(-yd.gain * (r - this.yawRateLow), -0.3, 0.3);
  }
}

/**
 * The trivial fly-by-wire law: stick to surfaces through powered actuators, no protections,
 * no hold limit. A placeholder the A320 and F/A-18 laws replace; it also shows the contract.
 */
export class PassThroughLaw implements ControlLaw {
  readonly shaker = false;
  readonly pusher = false;
  constructor(readonly def: AircraftDefinition) {}
  reset() {}
  step(ctx: ControlLawContext, out: SurfaceCommand) {
    const c = this.def.controls;
    const p = clamp(ctx.pitch, -1, 1);
    const trim = trimAngle(this.def, ctx.controls.pitchTrim);
    const stick = p >= 0 ? p * c.elevatorUp : p * c.elevatorDown;
    out.stabiliser = c.trim === 'stabiliser' ? trim : 0;
    out.elevator = clamp(
      (c.trim === 'stabiliser' ? 0 : trim) + stick,
      -c.elevatorDown,
      c.elevatorUp,
    );
    out.aileron = clamp(ctx.roll, -1, 1);
    out.rudder = clamp(ctx.yaw, -1, 1);
    out.spoilers = clamp(ctx.controls.speedbrake ?? 0, 0, 1);
    out.speedbrake = out.spoilers;
    out.differentialTail = 0;
    out.flap = undefined;
    out.leadingEdge = undefined;
  }
}

export function createControlLaw(def: AircraftDefinition): ControlLaw {
  return def.controlLaw ? def.controlLaw(def) : new DirectLaw(def);
}
