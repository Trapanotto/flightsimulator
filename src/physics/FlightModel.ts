import { Quaternion, Vector3 } from 'three';
import { type AircraftPhysics, DEFAULT_AIRCRAFT } from '../aircraft/types';

/**
 * Six-degree-of-freedom flight model in the style of JSBSim (own code, MIT): a rigid body
 * with mass and inertia, aerodynamic forces and moments from non-dimensional coefficients
 * (lift with stall, drag polar, stability and damping derivatives, control derivatives),
 * propeller or jet thrust with altitude lapse, and a spring/damper landing gear with rolling
 * friction, brakes, side grip and nose-wheel steering. Ground effect near the runway.
 *
 * Flight controls: direct law (stick = surface deflection) with a yaw damper that keeps turns
 * coordinated while the pedals are free, or fly-by-wire laws for the types that have them
 * (stick = load factor and roll rate, computed by inverting the aerodynamic model).
 *
 * Model axes: x = left wing, y = up, z = nose (right-handed). Roll rate p = ω·z (right wing
 * down positive), pitch rate q = -ω·x (nose up positive), yaw rate r = -ω·y (nose right).
 * World: any frame where `env.up(p)` gives the local vertical.
 */

export interface FlightEnv {
  /** Local vertical (unit) at a point. */
  up(p: Vector3, out: Vector3): Vector3;
  /** Height of a point above the terrain, or undefined if no terrain data is loaded there. */
  heightAboveGround(p: Vector3): number | undefined;
  /** Altitude above sea level (air density); defaults to height above ground. */
  altitude?(p: Vector3): number;
}

export interface FlightInput {
  /** -1 nose down .. 1 nose up (elevator) */
  pitch: number;
  /** -1 left .. 1 right (ailerons) */
  roll: number;
  /** -1 left .. 1 right (rudder, nose wheel) */
  yaw: number;
  /** 0 .. 1 */
  throttle: number;
  /** Afterburner (types that have one). */
  boost: boolean;
  brake: boolean;
  /** Trim wheel: -1 nose down .. 1 nose up (rate while held). */
  trim?: number;
  /**
   * Pitch / roll come from on/off keys: they are turned into rate demands (a pilot's hand
   * easing the stick) instead of slamming the surfaces to the stop.
   */
  digitalPitch?: boolean;
  digitalRoll?: boolean;
}

export interface TouchdownEvent {
  type: 'touchdown';
  /** Sink rate in m/s at touchdown. */
  sinkRate: number;
  rating: 'butter' | 'good' | 'firm';
}
export interface CrashEvent {
  type: 'crash';
  reason: 'terrain' | 'hard-landing' | 'gear-up' | 'wingtip' | 'nose';
  speed: number;
}
export interface LiftoffEvent {
  type: 'liftoff';
  speed: number;
}
export type FlightEvent = TouchdownEvent | CrashEvent | LiftoffEvent;

const G = 9.81;
const RHO0 = 1.225;
const DEG = Math.PI / 180;
/** Internal integration step (stiff gear springs need small steps). */
const SUB_DT = 1 / 240;

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);

/**
 * Density ratio up to 11 km: ISA pressure, temperature ISA + isaDev (K). Warm air is thinner
 * (density altitude): a hot summer day costs lift and power like a higher airfield.
 */
export function densityRatio(altitude: number, isaDev = 0): number {
  const h = Math.max(-500, Math.min(11000, altitude));
  const isa = Math.pow(1 - 2.25577e-5 * h, 4.2559);
  const t = 288.15 - 0.0065 * h;
  return isa * (t / (t + isaDev));
}

/**
 * Lift curve in the JSBSim style (as in FlightGear's c172p): linear, then rounding off to
 * CLmax over the last 2 degrees (the wing stalls gradually from the root) with the peak
 * 1 degree past where the straight line would reach CLmax; after it the lift drops by about a
 * third, and towards flat-plate lift (sin 2a) at very large angles.
 * `latched`: after a stall the flow stays separated until the angle is ~3 deg lower
 * (hysteresis), so the lift stays on the lower branch.
 */
export function liftCurve(
  alpha: number,
  CL0: number,
  CLa: number,
  CLmax: number,
  latched = false,
): number {
  const sign = alpha < -0.01 ? -1 : 1;
  // Negative side: the same shape, a little weaker.
  const cmax = sign > 0 ? CLmax : CLmax * 0.8 + CL0;
  const a = sign > 0 ? alpha : -alpha;
  const cl0 = sign > 0 ? CL0 : -CL0;
  const a0 = (cmax - cl0) / CLa;
  // Parabola leaving the straight line tangentially, slope 0 at the peak: it stays under
  // the line and reaches CLmax 1 degree past where the line would.
  const d = 2 * DEG;
  const aLin = a0 - d / 2;
  const aS = aLin + d;
  let cl: number;
  if (a <= aLin) cl = cl0 + CLa * a;
  else if (a <= aS && !latched) {
    const x = a - aLin;
    cl = cl0 + CLa * aLin + CLa * x - (CLa * x * x) / (2 * d);
  } else {
    const past = Math.max(0, a - (latched ? aS - 3 * DEG : aS));
    const post = cmax * (0.66 + 0.34 * Math.exp(-past / (4 * DEG))) * (latched ? 0.9 : 1);
    const flat = 1.05 * Math.sin(2 * a);
    const w = Math.min(1, Math.max(0, (a - 20 * DEG) / (20 * DEG)));
    cl = Math.min(post, cl0 + CLa * a) * (1 - w) + flat * w;
  }
  return sign * cl;
}

/** Angle of attack of the lift peak for the curve above. */
export function stallAngle(CL0: number, CLa: number, CLmax: number): number {
  return (CLmax - CL0) / CLa + 1 * DEG;
}

/** Thrust in newtons at true airspeed v (m/s), density ratio sigma, throttle 0..1. */
export function thrustAt(
  p: AircraftPhysics,
  v: number,
  sigma: number,
  throttle: number,
  boost: boolean,
) {
  const e = p.propulsion;
  if (e.kind === 'prop') {
    // Static thrust at low speed, then power-limited: T = eta * P / v. Propeller efficiency
    // climbs with airspeed (advance ratio) and peaks at cruise.
    const eta = e.efficiency * Math.min(1, (1.25 * v) / (v + 0.25 * p.vne));
    const t = Math.min(e.staticThrust, (eta * e.power) / Math.max(v, 1));
    return throttle * t * sigma;
  }
  const lapse = Math.pow(sigma, 0.7) * Math.max(0.6, 1 - 0.18 * (v / 340));
  return throttle * e.staticThrust * lapse * (boost ? e.afterburner : 1);
}

/** Transonic drag rise (shock waves) from about Mach 0.8. */
export function waveDrag(v: number): number {
  const t = Math.min(1, Math.max(0, (v / 340 - 0.8) / 0.25));
  return 0.06 * t * t * (3 - 2 * t);
}

/** Stall speed (m/s, sea level) clean or with full flaps. */
export function stallSpeed(p: AircraftPhysics, flaps = 0): number {
  const clmax = p.aero.CLmax + flaps * p.aero.CLflaps;
  return Math.sqrt((2 * p.mass * G) / (RHO0 * p.wingArea * clmax));
}

/** Level-flight top speed at sea level (thrust = drag), m/s. */
export function topSpeed(p: AircraftPhysics, boost = false): number {
  const a = p.aero;
  const ar = (p.span * p.span) / p.wingArea;
  let best = 0;
  for (let v = 20; v < 500; v += 0.5) {
    const q = 0.5 * RHO0 * v * v;
    const cl = (p.mass * G) / (q * p.wingArea);
    const cd =
      a.CD0 + (p.fixedGear ? a.CDgear : 0) + (cl * cl) / (Math.PI * a.e * ar) + waveDrag(v);
    if (thrustAt(p, v, 1, 1, boost) >= q * p.wingArea * cd) best = v;
  }
  return best;
}

interface Wheel {
  /** Contact point (bottom of the tyre), model coordinates. */
  pos: Vector3;
  steer: boolean;
  brake: boolean;
  k: number;
  c: number;
  /** Compression last step, for touchdown detection. */
  comp: number;
}

const tmpQ = new Quaternion();
const qInv = new Quaternion();
const v1 = new Vector3();
const v2 = new Vector3();
const v3 = new Vector3();
const vAirM = new Vector3();
const vAir = new Vector3();
const forceM = new Vector3();
const forceW = new Vector3();
const torqueM = new Vector3();
const omegaW = new Vector3();

export class FlightModel {
  /** Model origin (reference point of the 3D model), world coordinates. */
  readonly position = new Vector3();
  readonly quaternion = new Quaternion();
  readonly velocity = new Vector3();
  /**
   * Wind (world axes, m/s, where the air moves). The aerodynamics see the velocity relative to
   * the air; `speed` is the airspeed, `groundSpeed` the speed over the ground.
   */
  readonly wind = new Vector3();
  groundSpeed = 0;
  /** Temperature deviation from the standard atmosphere, K (from the weather). */
  isaDeviation = 0;
  /**
   * Engine output 0..1: follows the throttle with the engine's own lag (piston almost at
   * once, turboprop about a second, a jet slowly from idle - spool-up).
   */
  engine = 0;
  /** Flow separated (stall hysteresis) and the wing that drops first (+1 right, -1 left). */
  private stallLatch = false;
  private dropSide = 1;
  /** Rate of change of the angle of attack (filtered), rad/s: downwash lag at the tail. */
  private alphaDot = 0;
  private prevAlpha = 0;
  /** Lift gained near the ground (ground effect), factor. */
  private groundLift = 1;
  /** Angular velocity in model axes (rad/s). */
  readonly omega = new Vector3();
  /** Unit direction of flight (or the nose when standing still). */
  readonly direction = new Vector3(0, 0, 1);
  speed = 0;
  onGround = false;
  crashed = false;
  gearDown = true;
  /** 0 .. 1 */
  flaps = 0;
  throttle = 0;
  boostLeft = 0;
  boosting = false;
  /** Elevator trim, -1 .. 1 (fraction of the elevator travel). */
  trim = 0;
  /** Load factor (g) along the aircraft's up axis, smoothed, for the HUD. */
  gLoad = 1;
  /** Angle of attack and sideslip, radians. */
  alpha = 0;
  beta = 0;

  readonly forward = new Vector3();
  readonly up = new Vector3();
  readonly right = new Vector3();
  /** Local vertical at the aircraft. */
  readonly worldUp = new Vector3(0, 1, 0);

  p!: AircraftPhysics;
  private wheels: Wheel[] = [];
  private hull: Array<[string, Vector3]> = [];
  private readonly cg = new Vector3();
  private readonly cgW = new Vector3();
  private airborneTime = 10;
  private groundTime = 10;
  private readonly controls = { e: 0, a: 0, r: 0 };
  /** Surface commands this step, before the actuator rate limit. */
  private readonly cmd = { e: 0, a: 0, r: 0 };
  /** Fly-by-wire: bank and flight path held while the stick is released. */
  private bankRef = 0;
  /** A pitch key was held last step (auto-trim on release); the pilot flies with keys. */
  private keyPitchHeld = false;
  private keyFlying = false;
  private pathRef = 0;
  /** Induced drag factor from ground effect (1 = free air), updated once per frame. */
  private groundEffect = 1;
  private readonly gearTorque = new Vector3();

  constructor(
    private readonly env: FlightEnv,
    physics: AircraftPhysics = DEFAULT_AIRCRAFT.physics,
  ) {
    this.setPhysics(physics);
  }

  /** Switches the aircraft type (mass, aerodynamics, gear, hull). */
  setPhysics(p: AircraftPhysics) {
    this.p = p;
    this.cg.fromArray(p.cg);
    this.hull = Object.entries(p.hull).map(([k, v]) => [k, new Vector3(...v)]);
    this.wheels = p.wheels.map((w) => {
      const k = (p.mass * G * w.share) / p.gearStroke;
      return {
        pos: new Vector3(...w.pos),
        steer: !!w.steer,
        brake: !!w.brake,
        k,
        c: 2 * 0.7 * Math.sqrt(k * p.mass * w.share),
        comp: 0,
      };
    });
    this.boostLeft = p.propulsion.kind === 'jet' ? p.propulsion.afterburnerSeconds : 0;
    if (p.fixedGear) this.gearDown = true;
  }

  /** Places the aircraft level (on the runway, or in trimmed flight at `speed`). */
  reset(position: Vector3, forward: Vector3, speed: number, onGround: boolean) {
    this.position.copy(position);
    this.env.up(position, this.worldUp);
    const f = forward.clone().addScaledVector(this.worldUp, -forward.dot(this.worldUp)).normalize();
    const left = new Vector3().crossVectors(this.worldUp, f);
    this.quaternion.copy(quaternionFromBasis(left, this.worldUp, f));
    this.omega.set(0, 0, 0);
    this.controls.e = this.controls.a = this.controls.r = 0;
    this.crashed = false;
    this.onGround = onGround;
    this.gearDown = onGround || this.gearDown || this.p.fixedGear;
    this.throttle = onGround ? 0 : 0.7;
    this.setPhysics(this.p);
    this.airborneTime = onGround ? 0 : 10;
    this.groundTime = onGround ? 10 : 0;
    this.updateAxes();
    this.velocity.copy(this.forward).multiplyScalar(speed);
    // In the air `speed` is the airspeed: the aircraft drifts with the wind from the start.
    if (!onGround) this.velocity.add(this.wind);
    if (!onGround && speed > 1) {
      // Trimmed flight: nose up by the angle of attack that carries the weight, elevator
      // trim that cancels the pitching moment there.
      const a = this.p.aero;
      const sigma = densityRatio(this.altitudeOf(position), this.isaDeviation);
      const { alpha, de, qs, cl } = this.trimFor(speed, sigma);
      this.rotateLocal(X, -alpha);
      this.updateAxes();
      this.trim = this.p.fbw ? 0 : de;
      if (this.p.fbw) this.controls.e = this.cmd.e = de;
      // Throttle for level flight: thrust = drag.
      const ar = (this.p.span * this.p.span) / this.p.wingArea;
      const cd =
        a.CD0 +
        (this.gearDown ? a.CDgear : 0) +
        this.flaps * a.CDflaps +
        (cl * cl) / (Math.PI * a.e * ar) +
        waveDrag(speed);
      const full = thrustAt(this.p, speed, sigma, 1, false);
      this.throttle = full > 0 ? clamp((qs * cd) / full, 0.05, 1) : 0.7;
      this.pathRef = 0;
      this.bankRef = 0;
    } else {
      // Takeoff trim: set for the best climb speed (about Vy), so the aircraft flies on after the rotation.
      this.trim = onGround && !this.p.fbw ? this.trimFor(1.5 * this.stallSpeed, 1).de : 0;
      if (onGround) this.settle();
    }
    this.engine = this.throttle;
    this.stallLatch = false;
    this.alphaDot = 0;
    this.prevAlpha = this.alpha;
    this.speed = speed;
    this.groundSpeed = this.velocity.length();
    this.direction.copy(this.groundSpeed > 0.5 ? this.velocity : this.forward).normalize();
  }

  /** Angle of attack and elevator for 1 g flight at `speed` (the elevator also makes lift). */
  private trimFor(speed: number, sigma: number) {
    const a = this.p.aero;
    const qs = 0.5 * RHO0 * sigma * speed * speed * this.p.wingArea;
    const cl = (this.p.mass * G) / qs;
    let alpha = 0;
    let de = 0;
    for (let i = 0; i < 6; i++) {
      alpha = Math.min(
        this.alphaStall() * 0.8,
        (cl - a.CL0 - this.flaps * a.CLflaps - a.CLde * de) / a.CLa,
      );
      de = clamp(-(a.Cm0 + a.Cma * alpha + this.flaps * a.Cmflaps) / a.Cmde, -1, 1);
    }
    return { alpha, de, qs, cl };
  }

  /**
   * Lifts the aircraft so that no wheel is deeper in the ground than its static compression
   * (spawning, or the terrain under a parked aircraft got more detailed). Returns the lift.
   */
  private settle(followDown = false): number {
    if (!this.gearDown) return 0;
    let deepest = -Infinity;
    for (const w of this.wheels) {
      v1.copy(w.pos).applyQuaternion(this.quaternion).add(this.position);
      const h = this.env.heightAboveGround(v1);
      if (h !== undefined) deepest = Math.max(deepest, -h);
    }
    if (deepest === -Infinity) return 0;
    const lift = deepest - this.p.gearStroke;
    if (lift > 0) {
      this.position.addScaledVector(this.worldUp, lift);
      return lift;
    }
    // The ground dropped away under a parked or taxiing aircraft: put it back on its wheels.
    if (followDown && deepest < -0.05) {
      this.position.addScaledVector(this.worldUp, deepest);
      return -deepest;
    }
    return 0;
  }

  /** Bank angle in radians, positive = right wing down. */
  get bank(): number {
    return Math.asin(clamp(-this.right.dot(this.worldUp), -1, 1));
  }

  /** Nose angle above the horizon in radians. */
  get pitch(): number {
    return Math.asin(clamp(this.forward.dot(this.worldUp), -1, 1));
  }

  /** Stall speed for the current flap setting (sea level), m/s. */
  get stallSpeed(): number {
    return stallSpeed(this.p, this.flaps);
  }

  get stalled(): boolean {
    return !this.onGround && this.speed > 5 && this.alpha > this.alphaStall();
  }

  /** Angle of attack in radians. */
  get angleOfAttack(): number {
    return this.alpha;
  }

  /** Vertical speed, m/s (positive = climbing). */
  get verticalSpeed(): number {
    return this.velocity.dot(this.worldUp);
  }

  step(dt: number, input: FlightInput, events: FlightEvent[] = []) {
    if (this.crashed) return;
    // Ground effect: the ground blocks the wing-tip vortices, induced drag falls within about
    // one span of the ground (McCormick).
    const h = this.env.heightAboveGround(this.position);
    if (h === undefined) {
      this.groundEffect = 1;
      this.groundLift = 1;
    } else {
      const k = Math.pow((16 * Math.max(0.3, h)) / this.p.span, 2);
      this.groundEffect = k / (1 + k);
      // Lift gain near the ground (as JSBSim's kCLge table, a bit milder: +12 % at h = 0).
      this.groundLift = 1 + 0.12 * Math.exp((-4.5 * Math.max(0, h)) / this.p.span);
    }
    const n = Math.max(1, Math.round(dt / SUB_DT));
    for (let i = 0; i < n && !this.crashed; i++) this.subStep(dt / n, input, events);
  }

  private subStep(dt: number, input: FlightInput, events: FlightEvent[]) {
    const p = this.p;
    const a = p.aero;
    this.env.up(this.position, this.worldUp);
    this.updateAxes();
    this.throttle = clamp(input.throttle, 0, 1);
    const e = p.propulsion;
    {
      // Engine lag: piston ~0.3 s, turboprop ~1.2 s, jets slow from idle (N1 spool-up),
      // faster down than up.
      const up = this.throttle > this.engine;
      const tau =
        e.kind === 'prop'
          ? e.power > 300_000
            ? up
              ? 1.2
              : 0.9
            : 0.3
          : e.afterburner > 1
            ? up
              ? 0.8 + 2.2 * (1 - this.engine) ** 2
              : 1
            : up
              ? 1.2 + 5 * (1 - this.engine) ** 2
              : 2;
      this.engine += (this.throttle - this.engine) * (1 - Math.exp(-dt / tau));
    }

    // Afterburner: limited, recharges slowly.
    const ab = e.kind === 'jet' ? e.afterburnerSeconds : 0;
    this.boosting = ab > 0 && input.boost && this.boostLeft > 0 && this.engine > 0.9;
    this.boostLeft = this.boosting
      ? Math.max(0, this.boostLeft - dt)
      : Math.min(ab, this.boostLeft + 0.2 * dt);

    // The terrain under a slow aircraft on the ground jumped (more detailed tiles): follow it
    // instead of letting the springs throw the aircraft into the air.
    if (this.onGround && this.speed < 15 && this.settle(true) > 0) {
      const down = this.velocity.dot(this.worldUp);
      if (down < 0) this.velocity.addScaledVector(this.worldUp, -down);
    }
    // Centre of gravity in world space (the game may have moved the origin).
    this.cgW.copy(this.cg).applyQuaternion(this.quaternion).add(this.position);

    // ---- aerodynamics (model axes) ----
    qInv.copy(this.quaternion).invert();
    vAirM.copy(this.velocity).sub(this.wind).applyQuaternion(qInv);
    const V = vAirM.length();
    const sigma = densityRatio(this.altitudeOf(this.cgW), this.isaDeviation);
    const qbar = 0.5 * RHO0 * sigma * V * V;
    this.alpha = V > 1 ? Math.atan2(-vAirM.y, vAirM.z) : 0;
    this.beta = V > 1 ? Math.asin(clamp(-vAirM.x / V, -1, 1)) : 0;
    // Rate of change of alpha, smoothed (it comes from a difference): the tail feels the
    // wing's downwash a moment late, which damps pitching.
    const rawAdot = V > 15 && dt > 0 ? clamp((this.alpha - this.prevAlpha) / dt, -2, 2) : 0;
    this.alphaDot += (rawAdot - this.alphaDot) * Math.min(1, dt / 0.04);
    this.prevAlpha = this.alpha;
    // Stall hysteresis: the flow separates at the peak and reattaches ~3 deg lower.
    const aS = this.alphaStall();
    if (!this.stallLatch && this.alpha > aS && V > 10) {
      this.stallLatch = true;
      // The wing that drops: the one the aircraft yaws or slips towards.
      this.dropSide = this.omega.y < 0 || this.beta > 0 ? 1 : -1;
    } else if (this.stallLatch && this.alpha < aS - 3 * DEG) this.stallLatch = false;
    const Vr = Math.max(V, 10);
    const ph = (this.omega.z * p.span) / (2 * Vr);
    const qh = (-this.omega.x * p.chord) / (2 * Vr);
    const rh = (-this.omega.y * p.span) / (2 * Vr);

    // ---- flight controls: surfaces move at a finite rate ----
    this.flightControls(dt, input, V, qbar);
    const rate = p.controlRate * dt;
    const c = this.controls;
    c.e += clamp(this.cmd.e - c.e, -rate, rate);
    c.a += clamp(this.cmd.a - c.a, -rate, rate);
    c.r += clamp(this.cmd.r - c.r, -rate, rate);
    const de = clamp(c.e + this.trim, -1, 1);

    const adh = (this.alphaDot * p.chord) / (2 * Vr);
    const CLadot = a.CLadot ?? 1.5;
    const Cmadot = a.Cmadot ?? 0.42 * a.Cmq;
    const cl =
      this.liftCoefficient(this.alpha) * this.groundLift + a.CLde * de + a.CLq * qh + CLadot * adh;
    const ar = (p.span * p.span) / p.wingArea;
    const stall = Math.max(0, this.alpha - this.alphaStall());
    // Drag past the stall grows towards that of a flat plate (2 sin^2 a).
    const sa = Math.sin(Math.min(this.alpha, 80 * DEG));
    const ss = Math.sin(this.alphaStall());
    const stallDrag = this.alpha > this.alphaStall() ? 1.9 * (sa * sa - ss * ss) : 0;
    const cd =
      a.CD0 +
      (this.gearDown ? a.CDgear : 0) +
      this.flaps * a.CDflaps +
      ((cl * cl) / (Math.PI * a.e * ar)) * this.groundEffect +
      stallDrag +
      0.3 * Math.abs(this.beta) +
      waveDrag(V);
    const cy = a.CYb * this.beta + a.CYdr * c.r;
    // Stalled: one wing drops first (asymmetric separation), stronger the deeper the stall.
    const drop = this.stallLatch ? this.dropSide * 0.06 * Math.min(1, stall / (5 * DEG) + 0.3) : 0;
    const Cl = a.Clb * this.beta + a.Clp * ph + a.Clr * rh + a.Clda * c.a + a.Cldr * c.r + drop;
    // Past the stall the wing loses its lift ahead of the tail: the nose drops.
    const Cm =
      a.Cm0 +
      a.Cma * this.alpha +
      a.Cmq * qh +
      Cmadot * adh +
      a.Cmde * de +
      this.flaps * a.Cmflaps -
      0.6 * stall;
    const Cn = a.Cnb * this.beta + a.Cnr * rh + a.Cnp * ph + a.Cndr * c.r + a.Cnda * c.a;

    forceM.set(0, 0, 0);
    torqueM.set(0, 0, 0);
    if (V > 0.5) {
      const vHat = v1.copy(vAirM).divideScalar(V);
      const liftDir = v2.crossVectors(vHat, X).normalize();
      const qs = qbar * p.wingArea;
      forceM
        .addScaledVector(liftDir, qs * cl)
        .addScaledVector(vHat, -qs * cd)
        .addScaledVector(X, -qs * cy);
      // Roll about +z, pitch (nose up) about -x, yaw (nose right) about -y.
      torqueM.set(-qs * p.chord * Cm, -qs * p.span * Cn, qs * p.span * Cl);
    }
    const thrust = thrustAt(p, V, sigma, this.engine, this.boosting);
    forceM.z += thrust;
    if (e.kind === 'prop' && !this.crashed) {
      // Single propeller (clockwise seen from the cockpit), as JSBSim/FlightGear model it:
      // - torque reaction rolls the aircraft to the left,
      // - the spiralling slipstream hits the fin on the left and the descending blade bites
      //   harder at high angle of attack (P-factor): the nose yaws left - right rudder on
      //   the takeoff roll and in the climb,
      // - the slipstream blows over the fin: the rudder steers even at walking pace.
      const shaft = (e.power * this.engine * sigma) / (2 * Math.PI * e.rps);
      const R = e.radius;
      // Engine and fin are rigged to cancel all this at cruise: it shows at low speed and
      // high power (takeoff, climb, slow flight).
      const low = clamp(1 - V / (0.55 * p.vne), 0, 1) ** 2;
      const slip = 0.28 / (1 + V / 30);
      const pFactor = 0.6 * clamp(this.alpha, -0.1, 0.35);
      torqueM.z -= shaft * 0.35 * low;
      torqueM.y += thrust * R * (slip + pFactor) * low;
      const qSlip = (0.5 * thrust) / (Math.PI * R * R);
      torqueM.y -= qSlip * p.wingArea * 0.35 * p.span * a.Cndr * c.r;
    }

    // ---- forces in world space ----
    forceW.copy(forceM).applyQuaternion(this.quaternion);
    const specific = v3.copy(forceW).clone(); // aero + thrust (+ gear), for the load factor
    const gear = this.gearForces(dt, input, events);
    if (this.crashed) return;
    specific.add(gear);
    forceW.add(gear).addScaledVector(this.worldUp, -p.mass * G);

    this.velocity.addScaledVector(forceW, dt / p.mass);
    this.cgW.addScaledVector(this.velocity, dt);

    // ---- rotation: Euler's equations in model axes ----
    const I = p.inertia;
    const w = this.omega;
    const Iw = v1.set(I[0] * w.x, I[1] * w.y, I[2] * w.z);
    const gyro = v2.crossVectors(w, Iw);
    torqueM.add(this.gearTorque).sub(gyro);
    w.x += (torqueM.x / I[0]) * dt;
    w.y += (torqueM.y / I[1]) * dt;
    w.z += (torqueM.z / I[2]) * dt;
    const ang = w.length() * dt;
    if (ang > 0) {
      tmpQ.setFromAxisAngle(v1.copy(w).normalize(), ang);
      this.quaternion.multiply(tmpQ).normalize();
    }
    this.updateAxes();
    this.position.copy(this.cg).applyQuaternion(this.quaternion).negate().add(this.cgW);

    this.groundSpeed = this.velocity.length();
    this.speed = vAir.copy(this.velocity).sub(this.wind).length();
    if (this.groundSpeed > 0.5) this.direction.copy(this.velocity).divideScalar(this.groundSpeed);
    else this.direction.copy(this.forward);
    const g = specific.dot(this.up) / (p.mass * G);
    this.gLoad += (g - this.gLoad) * Math.min(1, dt * 6);

    this.checkHull(events);
  }

  /**
   * Pilot input -> surface commands (this.cmd). Direct law: the stick moves the surfaces, the
   * trim wheel offsets the elevator, a yaw damper coordinates turns while the pedals are free.
   * Fly-by-wire: commanded pitch and roll accelerations are turned into surface deflections by
   * inverting the moment equations (dynamic inversion).
   */
  private flightControls(dt: number, input: FlightInput, V: number, qbar: number) {
    const p = this.p;
    const a = p.aero;
    const I = p.inertia;
    const cmd = this.cmd;
    const fbw = p.fbw;
    const qs = qbar * p.wingArea;
    const airborne = !this.onGround && V > 15 && qs > 1;
    const bank = this.bank;
    const theta = this.pitch;
    // Flight path angle through the air (what the wings feel), not over the ground.
    const climb = this.velocity.dot(this.worldUp) - this.wind.dot(this.worldUp);
    const gamma = V > 1 ? Math.asin(clamp(climb / V, -1, 1)) : 0;
    const Vr = Math.max(V, 10);
    const pr = this.omega.z;
    const qr = -this.omega.x;
    const rr = -this.omega.y;
    const ph = (pr * p.span) / (2 * Vr);
    const qh = (qr * p.chord) / (2 * Vr);
    const rh = (rr * p.span) / (2 * Vr);
    const stall = Math.max(0, this.alpha - this.alphaStall());

    cmd.e = input.pitch;
    cmd.a = input.roll;
    cmd.r = input.yaw;
    if (!fbw) this.trim = clamp(this.trim + (input.trim ?? 0) * 0.12 * dt, -1, 1);

    // Key held: pitch rate demand (direct-law types; fly-by-wire already commands rates).
    const noseWheelDown = this.onGround && this.wheels.some((w) => w.steer && w.comp > 0);
    const keyPitch =
      !fbw && !!input.digitalPitch && Math.abs(input.pitch) > 0.03 && V > 0.5 * this.stallSpeed;
    if (keyPitch) {
      let qCmd = input.pitch * p.keyPitchRate * DEG;
      if (this.onGround) qCmd = Math.min(qCmd, 1.5 * (p.rotationLimit * DEG - theta));
      // A held key never pulls the wing past the stall.
      else qCmd = Math.min(qCmd, 2 * (this.alphaStall() - 3 * DEG - this.alpha));
      const qDot = 4 * (qCmd - qr);
      const cmRest = a.Cm0 + a.Cma * this.alpha + a.Cmq * qh + this.flaps * a.Cmflaps - 0.6 * stall;
      const de = ((I[0] * qDot + this.gearTorque.x) / (qs * p.chord) - cmRest) / a.Cmde;
      // Nose wheel still down: full stick until the nose comes up.
      if (!(noseWheelDown && input.pitch > 0)) cmd.e = clamp(de, -1, 1) - this.trim;
    } else if (this.keyPitchHeld && airborne) {
      // Key released in flight: trimmed for the angle of attack the key left, the nose stays
      // (never slower than 1.2 x stall speed).
      const slowest = this.trimFor(1.2 * this.stallSpeed, 1).de;
      const steady = -(a.Cm0 + a.Cma * this.alpha + this.flaps * a.Cmflaps) / a.Cmde;
      const t = clamp(Math.min(steady, slowest), -1, 1);
      this.controls.e += this.trim - t;
      this.trim = t;
    }
    this.keyPitchHeld = keyPitch;
    if (input.digitalPitch || input.digitalRoll) this.keyFlying = true;
    else if (Math.abs(input.pitch) > 0.03 || Math.abs(input.roll) > 0.03) this.keyFlying = false;
    // Flying with keys: the extra lift for a level turn (up to 45 deg) is added, as a pilot
    // would pull for it.
    if (this.keyFlying && airborne && !fbw && !keyPitch) {
      const phi = Math.min(Math.abs(bank), 45 * DEG);
      const dn = 1 / Math.cos(phi) - 1;
      const qTurn = (G * Math.sin(phi) ** 2) / (Vr * Math.cos(phi));
      const dAlpha = (dn * p.mass * G) / (qs * a.CLa);
      const dCm = -(a.Cma * dAlpha + (a.Cmq * qTurn * p.chord) / (2 * Vr));
      cmd.e += dCm / a.Cmde;
    }
    // Roll key held: roll rate demand. Released (still flying with keys): the bank stays where
    // the key left it, so the aircraft does not creep into a spiral.
    const keyRoll = !!input.digitalRoll && Math.abs(input.roll) > 0.03;
    if (!fbw && airborne && (keyRoll || (this.keyFlying && Math.abs(input.roll) <= 0.03))) {
      let pCmd: number;
      if (keyRoll) {
        pCmd = input.roll * p.keyRollRate * DEG;
        this.bankRef = bank;
      } else pCmd = 0.8 * (this.bankRef - bank);
      const pDot = (keyRoll ? 8 : 4) * (pCmd - pr);
      const clRest = a.Clb * this.beta + a.Clp * ph + a.Clr * rh + a.Cldr * this.controls.r;
      cmd.a = clamp(((I[2] * pDot) / (qs * p.span) - clRest) / a.Clda, -1, 1);
    }

    // Fly-by-wire: ground mode is direct; the flight laws blend in over 2 s after liftoff.
    const law = fbw && airborne ? clamp((this.airborneTime - 0.5) / 2, 0, 1) : 0;
    // Takeoff rotation, until the flight laws have taken over: the stick commands a pitch rate
    // (no over-rotation, no tail strike), released the attitude is held.
    if (fbw && law < 1 && V > 0.5 * this.stallSpeed && qs > 1) {
      const lim = p.rotationLimit * DEG;
      let qCmd = Math.max(0, input.pitch) * fbw.rotationRate * DEG;
      qCmd = Math.min(qCmd, 1.5 * (lim - theta));
      if (input.pitch <= 0.03 && theta < 0.5 * DEG) qCmd = 0;
      const qDot = 4 * (qCmd - qr);
      const cmRest = a.Cm0 + a.Cma * this.alpha + a.Cmq * qh + this.flaps * a.Cmflaps;
      const de = ((I[0] * qDot + this.gearTorque.x) / (qs * p.chord) - cmRest) / a.Cmde;
      // Nose wheel still down: the stick acts directly until the nose comes up.
      if (input.pitch < -0.03 || noseWheelDown) cmd.e = input.pitch;
      else cmd.e = clamp(de, -1, 1) - this.trim;
    }
    if (fbw && law > 0) {
      // Pitch: load factor demand; released, the flight path is held (bank-compensated up to
      // the bank-hold angle); angle-of-attack protection below the stall.
      const stick = input.pitch;
      const free = Math.abs(stick) <= 0.03;
      if (!free || law < 1) this.pathRef = gamma;
      const comp = Math.cos(Math.min(Math.abs(bank), fbw.bankHold * DEG, 60 * DEG));
      let n = Math.cos(theta) / comp;
      n += stick > 0 ? stick * (fbw.gMax - 1) : stick * (1 - fbw.gMin);
      let qCmd = (G / Vr) * (n - Math.cos(theta) * Math.cos(bank));
      if (free) qCmd += 0.6 * (this.pathRef - gamma);
      const aProt = this.alphaStall() - 3 * DEG;
      qCmd = clamp(qCmd, 2 * (-0.15 - this.alpha), 2 * (aProt - this.alpha));
      const qDot = fbw.pitchGain * (qCmd - qr);
      const cmRest = a.Cm0 + a.Cma * this.alpha + a.Cmq * qh + this.flaps * a.Cmflaps - 0.6 * stall;
      const de = ((I[0] * qDot + this.gearTorque.x) / (qs * p.chord) - cmRest) / a.Cmde;
      // Auto-trim: the computers own the whole elevator.
      cmd.e = lerp(cmd.e, clamp(de, -1, 1) - this.trim, law);

      // Roll: rate demand, bank held when released, back to bankHold, never past bankMax.
      const roll = input.roll;
      let pCmd: number;
      if (Math.abs(roll) > 0.03) {
        pCmd = roll * fbw.rollRate * DEG;
        this.bankRef = clamp(bank, -fbw.bankHold * DEG, fbw.bankHold * DEG);
      } else pCmd = 1.2 * (this.bankRef - bank);
      // Bank protection: the roll rate fades out towards bankMax (and pulls back past it).
      if (Math.sign(pCmd) === Math.sign(bank)) {
        const room = 1.5 * (fbw.bankMax * DEG - Math.abs(bank));
        pCmd = Math.sign(pCmd) * Math.min(Math.abs(pCmd), room);
      }
      const pDot = fbw.rollGain * (pCmd - pr);
      const clRest = a.Clb * this.beta + a.Clp * ph + a.Clr * rh + a.Cldr * this.controls.r;
      const da = ((I[2] * pDot) / (qs * p.span) - clRest) / a.Clda;
      cmd.a = lerp(cmd.a, clamp(da, -1, 1), law);
    } else if (!airborne) {
      this.bankRef = bank;
      this.pathRef = gamma;
    }

    // Yaw damper / turn coordination while the pedals are free: no sideslip, the yaw rate of a
    // coordinated turn.
    if (airborne && Math.abs(input.yaw) < 0.05) {
      const rCmd = (G * Math.sin(bank) * Math.cos(theta)) / Vr;
      const rDot = 2.5 * (rCmd - rr) + 6 * this.beta;
      const cnRest = a.Cnb * this.beta + a.Cnr * rh + a.Cnp * ph + a.Cnda * this.controls.a;
      const dr = ((I[1] * rDot) / (qs * p.span) - cnRest) / a.Cndr;
      const auth = fbw ? 1 : 0.6;
      const blend = clamp((this.airborneTime - 0.3) / 1.5, 0, 1);
      cmd.r = clamp(dr, -auth, auth) * blend;
    }
  }

  /** Wheel springs, dampers and friction. Returns the world force; sets gearTorque (model). */
  private gearForces(dt: number, input: FlightInput, events: FlightEvent[]): Vector3 {
    const p = this.p;
    const total = new Vector3();
    this.gearTorque.set(0, 0, 0);
    omegaW.copy(this.omega).applyQuaternion(this.quaternion);
    let contact = false;
    let maxSink = 0;
    const steerMax = 0.6 * clamp(1 - this.speed / 40, 0.15, 1);
    if (this.gearDown) {
      for (const w of this.wheels) {
        const rM = new Vector3().copy(w.pos).sub(this.cg);
        const rW = rM.clone().applyQuaternion(this.quaternion);
        const pt = rW.clone().add(this.cgW);
        const h = this.env.heightAboveGround(pt);
        if (h === undefined || h > 0) {
          w.comp = 0;
          continue;
        }
        const comp = -h;
        if (comp > p.gearStroke * 4) {
          this.crash(events, 'hard-landing');
          return total;
        }
        contact = true;
        // Point velocity: v_cg + ω × r.
        const vp = new Vector3().crossVectors(omegaW, rW).add(this.velocity);
        const vUp = vp.dot(this.worldUp);
        if (w.comp === 0 && this.airborneTime > 0.5) maxSink = Math.max(maxSink, -vUp);
        w.comp = comp;
        const fn = Math.max(0, w.k * comp - w.c * vUp);
        // Rolling direction: the nose projected on the ground, nose wheel steered by the rudder.
        const roll = this.forward
          .clone()
          .addScaledVector(this.worldUp, -this.forward.dot(this.worldUp))
          .normalize();
        if (w.steer) roll.applyAxisAngle(this.worldUp, -input.yaw * steerMax);
        const side = new Vector3().crossVectors(this.worldUp, roll);
        const vLong = vp.dot(roll);
        const vLat = vp.dot(side);
        const mu = p.rollFriction + (w.brake && input.brake ? p.brakeFriction : 0);
        const f = new Vector3()
          .addScaledVector(this.worldUp, fn)
          .addScaledVector(roll, -clamp(vLong / 0.5, -1, 1) * mu * fn)
          .addScaledVector(side, -clamp(vLat / 0.3, -1, 1) * 0.8 * fn);
        total.add(f);
        const fM = f.applyQuaternion(qInv);
        this.gearTorque.add(new Vector3().crossVectors(rM, fM));
      }
    }
    if (contact) {
      this.groundTime += dt;
      if (!this.onGround && this.airborneTime > 0.5 && maxSink > 0) {
        if (maxSink > p.maxSinkRate || Math.abs(this.bank) > 15 * DEG) {
          this.crash(events, 'hard-landing');
          return total;
        }
        events.push({
          type: 'touchdown',
          sinkRate: maxSink,
          rating: maxSink < 1.0 ? 'butter' : maxSink < 2.0 ? 'good' : 'firm',
        });
      }
      this.airborneTime = 0;
      this.onGround = true;
    } else {
      this.airborneTime += dt;
      if (this.onGround && this.airborneTime > 0.3) {
        this.onGround = false;
        if (this.groundTime > 1) events.push({ type: 'liftoff', speed: this.speed });
        this.groundTime = 0;
      }
    }
    return total;
  }

  private checkHull(events: FlightEvent[]) {
    for (const [name, local] of this.hull) {
      v1.copy(local).applyQuaternion(this.quaternion).add(this.position);
      const h = this.env.heightAboveGround(v1);
      if (h !== undefined && h < 0) {
        this.crash(
          events,
          name === 'nose' ? 'nose' : name.startsWith('wing') ? 'wingtip' : 'terrain',
        );
        return;
      }
    }
    // Belly on the ground: gear up, or the fuselage itself in the terrain.
    v1.set(0, -this.p.bellyHeight, 0).applyQuaternion(this.quaternion).add(this.position);
    const hb = this.env.heightAboveGround(v1);
    if (hb !== undefined && hb < 0) this.crash(events, this.gearDown ? 'terrain' : 'gear-up');
  }

  private liftCoefficient(alpha: number): number {
    const a = this.p.aero;
    // Flaps shift the curve up (CL0 and CLmax by the same amount) and stall a little earlier.
    const shift = this.flaps * 1.5 * DEG;
    return liftCurve(
      alpha + shift,
      a.CL0 + this.flaps * a.CLflaps - a.CLa * shift,
      a.CLa,
      a.CLmax + this.flaps * a.CLflaps,
      this.stallLatch,
    );
  }

  /** Angle of attack of the lift peak (flaps lower it a little). */
  private alphaStall(): number {
    const a = this.p.aero;
    return stallAngle(a.CL0, a.CLa, a.CLmax) - this.flaps * 1.5 * DEG;
  }

  private altitudeOf(p: Vector3): number {
    if (this.env.altitude) return this.env.altitude(p);
    return this.env.heightAboveGround(p) ?? 0;
  }

  private crash(events: FlightEvent[], reason: CrashEvent['reason']) {
    if (this.crashed) return;
    this.crashed = true;
    events.push({ type: 'crash', reason, speed: this.speed });
    this.speed = 0;
    this.groundSpeed = 0;
    this.velocity.set(0, 0, 0);
    this.omega.set(0, 0, 0);
  }

  private rotateLocal(axis: Vector3, angle: number) {
    if (angle === 0) return;
    tmpQ.setFromAxisAngle(axis, angle);
    this.quaternion.multiply(tmpQ);
  }

  private updateAxes() {
    this.forward.copy(Z).applyQuaternion(this.quaternion);
    this.up.copy(Y).applyQuaternion(this.quaternion);
    this.right.copy(X).applyQuaternion(this.quaternion).negate();
  }
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Quaternion whose rotation maps model X/Y/Z onto the given orthonormal world axes. */
export function quaternionFromBasis(x: Vector3, y: Vector3, z: Vector3): Quaternion {
  const q = new Quaternion();
  const m11 = x.x,
    m12 = y.x,
    m13 = z.x;
  const m21 = x.y,
    m22 = y.y,
    m23 = z.y;
  const m31 = x.z,
    m32 = y.z,
    m33 = z.z;
  const tr = m11 + m22 + m33;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    q.set((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s);
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    q.set(0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s);
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    q.set((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s);
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    q.set((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s);
  }
  return q.normalize();
}
