import { Quaternion, Vector3 } from 'three';

/**
 * Arcade flight model (concept ch. 9). Not a simulation: the velocity follows the nose
 * ("grip"), banking turns the aircraft by itself, stalls are soft, landings are forgiving.
 *
 * Axes of the aircraft model: nose +Z, up +Y, right wing -X.
 * World: any frame where `env.up(p)` gives the local vertical (render coordinates in the game,
 * flat ground in tests).
 */

export interface FlightEnv {
  /** Local vertical (unit) at a point. */
  up(p: Vector3, out: Vector3): Vector3;
  /** Height of a point above the terrain, or undefined if no terrain data is loaded there. */
  heightAboveGround(p: Vector3): number | undefined;
}

export interface FlightInput {
  /** -1 nose down .. 1 nose up */
  pitch: number;
  /** -1 left .. 1 right */
  roll: number;
  /** -1 left .. 1 right */
  yaw: number;
  /** 0 .. 1 */
  throttle: number;
  boost: boolean;
  brake: boolean;
  /** Trim wheel: -1 nose down .. 1 nose up (rate while held). */
  trim?: number;
}

export type Assist = 'easy' | 'normal' | 'pro';

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

/** TR-1 performance figures (concept ch. 9). */
export const TR1 = {
  thrust: 7.0, // m/s² at full throttle
  boostFactor: 1.6,
  boostSeconds: 5,
  boostRecharge: 0.25, // seconds of boost regained per second
  /** Drag coefficient: thrust = drag at ~140 m/s. */
  drag: 7.0 / 140 ** 2,
  gearDrag: 0.35,
  flapDrag: 0.45,
  stallSpeed: 30, // m/s clean, flaps lower it by up to 7 m/s
  rotateSpeed: 33,
  rollRate: Math.PI, // rad/s (180°/s)
  pitchRate: 1.25,
  yawRate: 0.5,
  grip: 3.0, // how fast the flight path follows the nose (1/s)
  gearHeight: 1.53, // model origin above ground with gear down
  bellyHeight: 0.62,
  maxSinkRate: 4.5,
  /** Highest load factor a full pull can produce (arcade: generous, but no 15 g turns). */
  maxG: 8,
  /** Angle of attack: aoaRef at aoaSpeed, growing with 1/v², capped at aoaMax. */
  aoaRef: 5 * (Math.PI / 180),
  aoaSpeed: 40,
  aoaMax: 12 * (Math.PI / 180),
  /** Hands-off pitch attitude range of the trim, radians. */
  trimMin: -20 * (Math.PI / 180),
  trimMax: 25 * (Math.PI / 180),
  /** Trim wheel speed, radians of hands-off attitude per second. */
  trimRate: 4 * (Math.PI / 180),
};

const G = 9.81;
const DEG = Math.PI / 180;
const LOCAL_F = new Vector3(0, 0, 1);
const LOCAL_U = new Vector3(0, 1, 0);
const LOCAL_R = new Vector3(-1, 0, 0);
/** Points that must not touch the ground (model coordinates). */
const HULL = {
  nose: new Vector3(0, 0.0, 6.0),
  wingL: new Vector3(4.6, 0.05, -0.5),
  wingR: new Vector3(-4.6, 0.05, -0.5),
  tail: new Vector3(0, 2.05, -5.2),
};

const tmpQ = new Quaternion();
const tmp = new Vector3();
const tmp2 = new Vector3();

export class FlightModel {
  readonly position = new Vector3();
  readonly quaternion = new Quaternion();
  /** Unit flight path direction. */
  readonly direction = new Vector3(0, 0, 1);
  /** Speed along the flight path, m/s. */
  speed = 0;
  /** Extra sink below stall speed, m/s (downwards). */
  sink = 0;
  readonly velocity = new Vector3();
  onGround = false;
  crashed = false;
  gearDown = true;
  /** 0 .. 1 */
  flaps = 0;
  throttle = 0;
  boostLeft = TR1.boostSeconds;
  boosting = false;
  assist: Assist = 'easy';
  /**
   * Pitch trim as the attitude held hands-off (radians). It follows the nose while the stick is
   * moved, so letting go holds the current attitude; the trim wheel moves it from there.
   */
  trim = 0;
  /** Load factor (g), smoothed, for the HUD. */
  gLoad = 1;
  /** Seconds since the last touchdown or liftoff (to debounce events). */
  private sinceGroundChange = 10;
  private readonly lastVelocity = new Vector3();

  // Body axes in world space, updated each step.
  readonly forward = new Vector3();
  readonly up = new Vector3();
  readonly right = new Vector3();
  /** Local vertical at the aircraft. */
  readonly worldUp = new Vector3(0, 1, 0);

  constructor(private readonly env: FlightEnv) {}

  /** Places the aircraft level, nose along `forward` (projected onto the horizon). */
  reset(position: Vector3, forward: Vector3, speed: number, onGround: boolean) {
    this.position.copy(position);
    this.env.up(position, this.worldUp);
    const f = forward.clone().addScaledVector(this.worldUp, -forward.dot(this.worldUp)).normalize();
    // Model X is the left wing: up x forward (the pilot's right is forward x up).
    const left = new Vector3().crossVectors(this.worldUp, f);
    this.quaternion.copy(quaternionFromBasis(left, this.worldUp, f));
    this.direction.copy(f);
    this.speed = speed;
    this.sink = 0;
    this.onGround = onGround;
    this.crashed = false;
    this.gearDown = onGround || this.gearDown;
    this.throttle = onGround ? 0 : 0.7;
    this.boostLeft = TR1.boostSeconds;
    this.sinceGroundChange = 10;
    this.updateAxes();
    this.trim = this.pitch;
    this.velocity.copy(this.direction).multiplyScalar(speed);
    this.lastVelocity.copy(this.velocity);
  }

  /** Bank angle in radians, positive = right wing down. */
  get bank(): number {
    return Math.asin(Math.max(-1, Math.min(1, -this.right.dot(this.worldUp))));
  }

  /** Nose angle above the horizon in radians. */
  get pitch(): number {
    return Math.asin(Math.max(-1, Math.min(1, this.forward.dot(this.worldUp))));
  }

  get stallSpeed(): number {
    return TR1.stallSpeed - 7 * this.flaps;
  }

  get stalled(): boolean {
    return !this.onGround && this.speed < this.stallSpeed;
  }

  /** Vertical speed, m/s (positive = climbing). */
  get verticalSpeed(): number {
    return this.velocity.dot(this.worldUp);
  }

  step(dt: number, input: FlightInput, events: FlightEvent[] = []) {
    if (this.crashed) return;
    this.env.up(this.position, this.worldUp);
    this.updateAxes();
    this.throttle = input.throttle;

    // Boost: limited, recharges when not in use.
    this.boosting = input.boost && this.boostLeft > 0 && this.throttle > 0.5;
    this.boostLeft = this.boosting
      ? Math.max(0, this.boostLeft - dt)
      : Math.min(TR1.boostSeconds, this.boostLeft + TR1.boostRecharge * dt);

    const s = this.speed;
    const eff = Math.min(1, Math.max(0.12, (s - 10) / 40));

    if (this.onGround) this.stepGround(dt, input, eff);
    else this.stepAir(dt, input, eff);

    // Speed along the path: thrust, drag, gravity along the path, ground friction.
    const thrust = this.throttle * TR1.thrust * (this.boosting ? TR1.boostFactor : 1);
    const dragK = TR1.drag * (1 + (this.gearDown ? TR1.gearDrag : 0) + this.flaps * TR1.flapDrag);
    let accel = thrust - dragK * s * s - G * this.direction.dot(this.worldUp);
    if (this.onGround) accel -= 0.25 + (input.brake ? 3.5 : 0);
    this.speed = Math.max(0, s + accel * dt);

    // Below stall speed the wing cannot carry the weight: sink builds up.
    if (!this.onGround) {
      const lift = Math.min(1, (this.speed / this.stallSpeed) ** 2);
      this.sink += G * (1 - lift) * dt;
      this.sink *= Math.exp(-1.5 * lift * dt);
    } else {
      this.sink = 0;
    }

    this.velocity
      .copy(this.direction)
      .multiplyScalar(this.speed)
      .addScaledVector(this.worldUp, -this.sink);
    this.position.addScaledVector(this.velocity, dt);
    this.sinceGroundChange += dt;

    this.handleGround(events);
    if (!this.crashed) this.checkHull(events);

    // Load factor from the change of velocity (+1 g for gravity), smoothed.
    tmp.copy(this.velocity).sub(this.lastVelocity).divideScalar(Math.max(dt, 1e-4));
    tmp.addScaledVector(this.worldUp, G);
    const g = tmp.dot(this.up) / G;
    this.gLoad += (g - this.gLoad) * Math.min(1, dt * 6);
    this.lastVelocity.copy(this.velocity);
  }

  private stepAir(dt: number, input: FlightInput, eff: number) {
    // Body rates.
    let roll = input.roll * TR1.rollRate * eff;
    // Pitch rate limited so the load factor stays below ~maxG at high speed.
    const pitchLimit = Math.min(TR1.pitchRate, (TR1.maxG * G) / Math.max(this.speed, 1));
    let pitch = input.pitch * pitchLimit * eff;
    const yaw = input.yaw * TR1.yawRate * eff;
    const bank = this.bank;
    const upright = this.up.dot(this.worldUp) > 0;

    // Trim: hands off, the nose eases towards the trimmed attitude.
    const handsOff = Math.abs(input.pitch) < 0.05;
    if (!handsOff || !upright) this.trim = this.pitch;
    this.trim = Math.max(
      TR1.trimMin,
      Math.min(TR1.trimMax, this.trim + (input.trim ?? 0) * TR1.trimRate * dt),
    );
    if (handsOff && upright && !this.stalled) {
      pitch += Math.max(-0.25, Math.min(0.25, (this.trim - this.pitch) * 1.5)) * eff;
    }

    if (
      this.assist === 'easy' &&
      Math.abs(input.roll) < 0.05 &&
      upright &&
      Math.abs(bank) < 75 * DEG
    ) {
      // Auto level: wings return to horizontal when the stick is released.
      roll -= bank * 1.6;
    }
    if (this.stalled) {
      // Soft stall: the nose drops towards the flight path.
      pitch -= (1 - this.speed / this.stallSpeed) * 0.9;
    }

    this.rotateLocal(LOCAL_F, roll * dt);
    this.rotateLocal(LOCAL_R, pitch * dt);
    this.rotateLocal(LOCAL_U, -yaw * dt);

    // Coordinated turn: banking turns the nose around the local vertical.
    if (this.assist !== 'pro' && upright) {
      const b = Math.max(-75 * DEG, Math.min(75 * DEG, bank));
      const rate = (G * Math.tan(b)) / Math.max(this.speed, 25);
      tmpQ.setFromAxisAngle(this.worldUp, -rate * dt * 0.85);
      this.quaternion.premultiply(tmpQ);
    }
    this.quaternion.normalize();
    this.updateAxes();

    // Grip: the flight path follows the nose (weaker when slow), a few degrees below it:
    // slow flight needs a higher angle of attack, flaps reduce it.
    const grip = TR1.grip * eff * (this.stalled ? 0.4 : 1);
    this.direction.lerp(this.pathTarget(tmp), Math.min(1, grip * dt)).normalize();
  }

  /** Angle of attack in radians for the current speed and flap setting. */
  get angleOfAttack(): number {
    const a = TR1.aoaRef * (TR1.aoaSpeed / Math.max(this.speed, 15)) ** 2 * (1 - 0.35 * this.flaps);
    return Math.min(a, TR1.aoaMax);
  }

  /** Where the flight path wants to point: the nose, lowered by the angle of attack. */
  private pathTarget(out: Vector3): Vector3 {
    const a = this.angleOfAttack;
    return out
      .copy(this.forward)
      .multiplyScalar(Math.cos(a))
      .addScaledVector(this.up, -Math.sin(a));
  }

  private stepGround(dt: number, input: FlightInput, eff: number) {
    // Steering with rudder (nose wheel), stronger at low speed.
    const steer =
      input.yaw * 0.7 * Math.min(1, this.speed / 6) +
      input.roll * 0.15 * Math.min(1, this.speed / 6);
    tmpQ.setFromAxisAngle(this.worldUp, -steer * dt);
    this.quaternion.premultiply(tmpQ);

    // Rotation: above rotate speed the nose may lift, otherwise it settles on the nose wheel.
    const pitchNow = this.pitch;
    const canRotate = this.speed > TR1.rotateSpeed - 6 * this.flaps;
    const wanted =
      canRotate && input.pitch > 0.1 ? Math.min(14 * DEG, pitchNow + input.pitch * 0.6 * dt) : 0;
    this.rotateLocal(LOCAL_R, (wanted - pitchNow) * Math.min(1, dt * 6));
    // Wings level on the ground.
    this.rotateLocal(LOCAL_F, -this.bank * Math.min(1, dt * 8));
    this.quaternion.normalize();
    this.updateAxes();

    // The path follows the nose; once the nose is up and fast enough, the aircraft lifts off.
    this.direction.lerp(this.pathTarget(tmp), Math.min(1, TR1.grip * eff * dt)).normalize();
  }

  private handleGround(events: FlightEvent[]) {
    const hag = this.env.heightAboveGround(this.position);
    if (hag === undefined) return;
    const contact = this.gearDown ? TR1.gearHeight : TR1.bellyHeight;
    const vs = this.velocity.dot(this.worldUp);

    if (hag <= contact && (vs <= 0.05 || this.onGround)) {
      if (!this.onGround) {
        const sinkRate = -vs;
        const bankDeg = Math.abs(this.bank) / DEG;
        const pitchDeg = this.pitch / DEG;
        if (!this.gearDown) return this.crash(events, 'gear-up');
        if (sinkRate > TR1.maxSinkRate || bankDeg > 12 || pitchDeg < -5 || pitchDeg > 18) {
          return this.crash(events, 'hard-landing');
        }
        this.onGround = true;
        if (this.sinceGroundChange > 1) {
          events.push({
            type: 'touchdown',
            sinkRate,
            rating: sinkRate < 1.2 ? 'butter' : sinkRate < 2.5 ? 'good' : 'firm',
          });
        }
        this.sinceGroundChange = 0;
      }
      // Stay on the ground: snap height, remove the downward part of the path.
      this.position.addScaledVector(this.worldUp, contact - hag);
      const down = this.direction.dot(this.worldUp);
      if (down < 0) this.direction.addScaledVector(this.worldUp, -down).normalize();
      this.sink = 0;
    } else if (
      this.onGround &&
      hag > contact + 0.3 &&
      this.speed < this.stallSpeed * 0.9 &&
      vs < 1
    ) {
      // Too slow to fly: the ground under us moved (e.g. more detailed terrain arrived). Stay on it.
      this.position.addScaledVector(this.worldUp, contact - hag);
    } else if (this.onGround && hag > contact + 0.3) {
      this.onGround = false;
      if (this.sinceGroundChange > 1) events.push({ type: 'liftoff', speed: this.speed });
      this.sinceGroundChange = 0;
    }
  }

  private checkHull(events: FlightEvent[]) {
    for (const [name, local] of Object.entries(HULL)) {
      tmp2.copy(local).applyQuaternion(this.quaternion).add(this.position);
      const h = this.env.heightAboveGround(tmp2);
      if (h !== undefined && h < 0) {
        this.crash(
          events,
          name === 'nose' ? 'nose' : name.startsWith('wing') ? 'wingtip' : 'terrain',
        );
        return;
      }
    }
    // The fuselage itself below ground (e.g. flying into a slope).
    const hag = this.env.heightAboveGround(this.position);
    if (hag !== undefined && hag < (this.gearDown ? 0.9 : 0.3) && !this.onGround) {
      this.crash(events, 'terrain');
    }
  }

  private crash(events: FlightEvent[], reason: CrashEvent['reason']) {
    this.crashed = true;
    events.push({ type: 'crash', reason, speed: this.speed });
    this.speed = 0;
    this.velocity.set(0, 0, 0);
  }

  private rotateLocal(axis: Vector3, angle: number) {
    if (angle === 0) return;
    tmpQ.setFromAxisAngle(axis, angle);
    this.quaternion.multiply(tmpQ);
  }

  private updateAxes() {
    this.forward.copy(LOCAL_F).applyQuaternion(this.quaternion);
    this.up.copy(LOCAL_U).applyQuaternion(this.quaternion);
    this.right.copy(LOCAL_R).applyQuaternion(this.quaternion);
  }
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
