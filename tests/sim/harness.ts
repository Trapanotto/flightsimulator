/**
 * Test pilots and helpers for flying the simulation headless: simple PID loops that hold
 * speed with pitch, heading with bank, altitude with pitch and the ball with rudder, the way
 * a test pilot flies a handbook procedure.
 */
import {
  SIM_DT,
  TestEnvironment,
  createAircraft,
  isa,
  type SimAircraft,
  type TestEnvironmentOptions,
} from '../../src/sim';

export const KT = 1852 / 3600;
export const FT = 0.3048;
export const FPM = FT / 60;
export const DEG = Math.PI / 180;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class Pid {
  private integral = 0;
  private last: number | undefined;
  constructor(
    private readonly kp: number,
    private readonly ki: number,
    private readonly kd: number,
    private readonly limit = 1,
  ) {}
  update(error: number, dt: number): number {
    const d = this.last === undefined ? 0 : (error - this.last) / dt;
    this.last = error;
    const out = this.kp * error + this.ki * this.integral + this.kd * d;
    // Anti-windup: only integrate while the output is not saturated the same way.
    if (Math.abs(out) < this.limit || Math.sign(out) !== Math.sign(error))
      this.integral += error * dt;
    return clamp(out, -this.limit, this.limit);
  }
  reset() {
    this.integral = 0;
    this.last = undefined;
  }
}

/** Shortest signed difference of two headings, degrees. */
export const headingError = (target: number, actual: number) =>
  ((target - actual + 540) % 360) - 180;

/** Calibrated airspeed in knots (equivalent airspeed at these speeds). */
export function kcas(ac: SimAircraft, env: TestEnvironment): number {
  const rho = env.air(ac.state.position, {
    wind: { x: 0, y: 0, z: 0 },
    density: 0,
    temperature: 0,
    pressure: 0,
  }).density;
  return (ac.telemetry.tas * Math.sqrt(rho / 1.225)) / KT;
}

export interface Flight {
  ac: SimAircraft;
  env: TestEnvironment;
}

export function airborne(
  altitude: number,
  ktas: number,
  options: TestEnvironmentOptions & { flaps?: number; heading?: number } = {},
): Flight {
  const env = new TestEnvironment(options);
  const ac = createAircraft('c172');
  ac.controls.flaps = options.flaps ?? 0;
  ac.reset(
    {
      position: env.position(altitude - (options.elevation ?? 0)),
      headingDeg: options.heading ?? 0,
      speed: ktas * KT,
      onGround: false,
    },
    env,
  );
  return { ac, env };
}

export function onGround(options: TestEnvironmentOptions & { heading?: number } = {}): Flight {
  const env = new TestEnvironment(options);
  const ac = createAircraft('c172');
  ac.reset(
    { position: env.position(0), headingDeg: options.heading ?? 0, speed: 0, onGround: true },
    env,
  );
  return { ac, env };
}

/** Runs for `seconds` (or until `pilot` returns true), calling the pilot before each step. */
export function fly(
  f: Flight,
  seconds: number,
  pilot: (dt: number) => boolean | void = () => {},
): number {
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n; i++) {
    if (pilot(SIM_DT) === true) return i * SIM_DT;
    f.ac.step(SIM_DT, f.env);
  }
  return seconds;
}

/**
 * The attitude part of a pilot: pitch to a commanded attitude, bank to a commanded angle,
 * rudder to keep the ball centred. The outer loops below command these.
 */
export class AttitudePilot {
  private readonly pitchPid = new Pid(2.2, 0.8, 0, 1);
  private readonly rollPid = new Pid(2.0, 0.2, 0, 1);
  constructor(private readonly ac: SimAircraft) {}
  pitchTo(theta: number, dt: number) {
    const t = this.ac.telemetry;
    const q = this.ac.state.angularVelocity.y;
    this.ac.controls.pitch = clamp(this.pitchPid.update(theta - t.pitch, dt) - 0.5 * q, -1, 1);
  }
  bankTo(phi: number, dt: number) {
    const t = this.ac.telemetry;
    const p = this.ac.state.angularVelocity.x;
    this.ac.controls.roll = clamp(this.rollPid.update(phi - t.bank, dt) - 0.3 * p, -1, 1);
  }
  ball() {
    this.ac.controls.yaw = clamp(3 * this.ac.telemetry.beta, -1, 1);
  }
}

/** Holds an indicated airspeed with pitch (attitude command from the speed error). */
export class SpeedPilot {
  private readonly speedPid = new Pid(0.012, 0.002, 0, 0.5);
  readonly attitude: AttitudePilot;
  /** Attitude the speed loop works around (the trimmed pitch at the start). */
  base: number;
  constructor(
    private readonly ac: SimAircraft,
    readonly heading: number,
  ) {
    this.attitude = new AttitudePilot(ac);
    this.base = ac.telemetry.pitch;
  }
  step(kias: number, dt: number) {
    const t = this.ac.telemetry;
    // Too fast: raise the nose.
    const theta = this.base + this.speedPid.update(t.ias / KT - kias, dt);
    this.attitude.pitchTo(theta, dt);
    this.wingsAndHeading(dt);
  }
  wingsAndHeading(dt: number) {
    const bank = clamp(
      0.03 * headingError(this.heading, this.ac.telemetry.headingDeg),
      -0.35,
      0.35,
    );
    this.attitude.bankTo(bank, dt);
    this.attitude.ball();
  }
}

/** Holds altitude with pitch. */
export class AltitudePilot {
  private readonly altPid = new Pid(0.004, 0.0004, 0, 0.3);
  readonly attitude: AttitudePilot;
  base: number;
  constructor(
    private readonly ac: SimAircraft,
    readonly heading: number,
    readonly altitude: number,
  ) {
    this.attitude = new AttitudePilot(ac);
    this.base = ac.telemetry.pitch;
  }
  step(dt: number) {
    const t = this.ac.telemetry;
    const theta =
      this.base + this.altPid.update(this.altitude - t.altitude - 2 * t.verticalSpeed, dt);
    this.attitude.pitchTo(theta, dt);
    const bank = clamp(0.03 * headingError(this.heading, t.headingDeg), -0.35, 0.35);
    this.attitude.bankTo(bank, dt);
    this.attitude.ball();
  }
}

/**
 * Leans like a pilot does for best power: every few seconds tries a little leaner and keeps
 * it while the rpm rises, otherwise goes back. Above about 3000 ft per the handbook.
 */
export class Leaner {
  private timer = 0;
  private lastRpm = 0;
  private direction = -1;
  constructor(private readonly ac: SimAircraft) {}
  step(dt: number) {
    this.timer += dt;
    if (this.timer < 3) return;
    this.timer = 0;
    const rpm = this.ac.telemetry.engines[0]!.rpm;
    if (rpm < this.lastRpm - 1) this.direction = -this.direction;
    this.lastRpm = rpm;
    this.ac.controls.mixture[0] = clamp(
      this.ac.controls.mixture[0]! + 0.02 * this.direction,
      0.3,
      1,
    );
  }
}

/**
 * Feet on the pedals as the app's rudder helper gives them to keyboard pilots
 * (src/app/assist.ts): on the ground they hold the heading of the start of the roll, in the
 * air they centre the ball. In the air this adds what the helper lacks, a slow integral that
 * holds the steady rudder the engine asks for (P-factor, swirl on the fin). A foot that is
 * only proportional to the sideslip needs a sideslip to hold that rudder, and the sideslip
 * rolls the aircraft through its dihedral effect.
 */
export class RudderFeet {
  private hold: number | undefined;
  private bias = 0;
  private command = 0;
  constructor(
    private readonly ac: SimAircraft,
    private readonly integral = 1,
  ) {}
  step(dt: number) {
    const t = this.ac.telemetry;
    let want = 0;
    if (t.onGround) {
      if (t.groundSpeed < 1) {
        this.hold = t.headingDeg;
        this.bias = 0;
      } else {
        this.hold ??= t.headingDeg;
        const error = headingError(this.hold, t.headingDeg);
        this.bias = clamp(this.bias + 0.5 * error * dt, -0.7, 0.7);
        const k = clamp(20 / t.groundSpeed, 0.2, 1);
        const rate = this.ac.state.angularVelocity.z / DEG;
        want = clamp(k * (0.35 * error - 0.08 * rate) + this.bias, -1, 1);
      }
    } else {
      if (this.hold !== undefined) this.bias = 0;
      this.hold = undefined;
      this.bias = clamp(this.bias + this.integral * t.beta * dt, -0.6, 0.6);
      want = clamp(4 * t.beta + this.bias, -1, 1);
    }
    this.command += clamp(want - this.command, -4 * dt, 4 * dt);
    this.ac.controls.yaw = this.command;
  }
}

export { isa, SIM_DT };
