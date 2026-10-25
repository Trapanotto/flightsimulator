import { Quaternion, Vector3 } from 'three';
import { type AircraftPhysics, DEFAULT_AIRCRAFT } from '../aircraft/types';

/**
 * Six-degree-of-freedom flight model in the style of JSBSim (own code, MIT): a rigid body
 * with mass and inertia, aerodynamic forces and moments from non-dimensional coefficients
 * (lift with stall, drag polar, stability and damping derivatives, control derivatives),
 * propeller or jet thrust with altitude lapse, and a spring/damper landing gear with rolling
 * friction, brakes, side grip and nose-wheel steering.
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

/** ISA density ratio up to 11 km. */
export function densityRatio(altitude: number): number {
  const h = Math.max(-500, Math.min(11000, altitude));
  return Math.pow(1 - 2.25577e-5 * h, 4.2559);
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
    // Static thrust at low speed, then power-limited: T = eta * P / v.
    const t = Math.min(e.staticThrust, (e.efficiency * e.power) / Math.max(v, 1));
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
const forceM = new Vector3();
const forceW = new Vector3();
const torqueM = new Vector3();
const omegaW = new Vector3();

export class FlightModel {
  /** Model origin (reference point of the 3D model), world coordinates. */
  readonly position = new Vector3();
  readonly quaternion = new Quaternion();
  readonly velocity = new Vector3();
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
    if (!onGround && speed > 1) {
      // Trimmed flight: nose up by the angle of attack that carries the weight, elevator
      // trim that cancels the pitching moment there.
      const a = this.p.aero;
      const rho = RHO0 * densityRatio(this.altitudeOf(position));
      const cl = (this.p.mass * G) / (0.5 * rho * speed * speed * this.p.wingArea);
      const alpha = Math.min(
        this.alphaStall() * 0.8,
        (cl - a.CL0 - this.flaps * a.CLflaps) / a.CLa,
      );
      this.rotateLocal(X, -alpha);
      this.updateAxes();
      this.trim = clamp(-(a.Cm0 + a.Cma * alpha + this.flaps * a.Cmflaps) / a.Cmde, -1, 1);
    } else {
      this.trim = 0;
      if (onGround) this.settle();
    }
    this.speed = speed;
    this.direction.copy(speed > 0.5 ? this.velocity : this.forward).normalize();
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
    const n = Math.max(1, Math.round(dt / SUB_DT));
    for (let i = 0; i < n && !this.crashed; i++) this.subStep(dt / n, input, events);
  }

  private subStep(dt: number, input: FlightInput, events: FlightEvent[]) {
    const p = this.p;
    const a = p.aero;
    this.env.up(this.position, this.worldUp);
    this.updateAxes();
    this.throttle = clamp(input.throttle, 0, 1);

    // Afterburner: limited, recharges slowly.
    const e = p.propulsion;
    const ab = e.kind === 'jet' ? e.afterburnerSeconds : 0;
    this.boosting = ab > 0 && input.boost && this.boostLeft > 0 && this.throttle > 0.9;
    this.boostLeft = this.boosting
      ? Math.max(0, this.boostLeft - dt)
      : Math.min(ab, this.boostLeft + 0.2 * dt);

    // Control surfaces move at a finite rate; trim wheel.
    const rate = p.controlRate * dt;
    const c = this.controls;
    c.e += clamp(input.pitch - c.e, -rate, rate);
    c.a += clamp(input.roll - c.a, -rate, rate);
    c.r += clamp(input.yaw - c.r, -rate, rate);
    this.trim = clamp(this.trim + (input.trim ?? 0) * 0.12 * dt, -1, 1);
    const de = clamp(c.e + this.trim, -1, 1);

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
    vAirM.copy(this.velocity).applyQuaternion(qInv);
    const V = vAirM.length();
    const sigma = densityRatio(this.altitudeOf(this.cgW));
    const qbar = 0.5 * RHO0 * sigma * V * V;
    this.alpha = V > 1 ? Math.atan2(-vAirM.y, vAirM.z) : 0;
    this.beta = V > 1 ? Math.asin(clamp(-vAirM.x / V, -1, 1)) : 0;
    const Vr = Math.max(V, 10);
    const ph = (this.omega.z * p.span) / (2 * Vr);
    const qh = (-this.omega.x * p.chord) / (2 * Vr);
    const rh = (-this.omega.y * p.span) / (2 * Vr);

    const cl = this.liftCoefficient(this.alpha) + a.CLde * de + a.CLq * qh;
    const ar = (p.span * p.span) / p.wingArea;
    const stall = Math.max(0, this.alpha - this.alphaStall());
    const cd =
      a.CD0 +
      (this.gearDown ? a.CDgear : 0) +
      this.flaps * a.CDflaps +
      (cl * cl) / (Math.PI * a.e * ar) +
      1.2 * stall +
      0.3 * Math.abs(this.beta) +
      waveDrag(V);
    const cy = a.CYb * this.beta + a.CYdr * c.r;
    const Cl = a.Clb * this.beta + a.Clp * ph + a.Clr * rh + a.Clda * c.a + a.Cldr * c.r;
    // Past the stall the wing loses its lift ahead of the tail: the nose drops.
    const Cm =
      a.Cm0 + a.Cma * this.alpha + a.Cmq * qh + a.Cmde * de + this.flaps * a.Cmflaps - 0.6 * stall;
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
    forceM.z += thrustAt(p, V, sigma, this.throttle, this.boosting);

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

    this.speed = this.velocity.length();
    if (this.speed > 0.5) this.direction.copy(this.velocity).divideScalar(this.speed);
    else this.direction.copy(this.forward);
    const g = specific.dot(this.up) / (p.mass * G);
    this.gLoad += (g - this.gLoad) * Math.min(1, dt * 6);

    this.checkHull(events);
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
    const linear = a.CL0 + this.flaps * a.CLflaps + a.CLa * alpha;
    const as = this.alphaStall();
    const clmax = a.CLmax + this.flaps * a.CLflaps;
    if (alpha <= as) return Math.max(-clmax * 0.8, linear);
    // Past the stall the lift breaks down to ~60 % over about 10 degrees.
    return clmax * (0.6 + 0.4 * Math.exp(-(alpha - as) / (6 * DEG)));
  }

  /** Angle where the linear lift reaches CLmax (flaps shift the curve up, same CLmax gain). */
  private alphaStall(): number {
    const a = this.p.aero;
    return (a.CLmax - a.CL0) / a.CLa - this.flaps * 1.5 * DEG;
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
