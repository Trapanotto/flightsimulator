/**
 * The pilot outside the aircraft: in free fall, under a parachute, and on foot. A point mass
 * in the world frame (ECEF metres) like the aircraft, with the Environment's air and ground.
 *
 * Free fall: drag on the air-relative velocity, sized for a belly-to-earth terminal velocity
 * of 55 m/s at sea level (about 120 mph, the figure every skydiving course teaches), with a
 * little tracking. Opening: a pilot-chute and line-stretch delay, then an inflation that
 * brings the jumper to canopy speed with a bounded deceleration. Canopy: a gliding point
 * mass whose lift and drag follow the brake setting, so a quick, deep pull of both toggles
 * (the flare) converts the forward speed into lift for a moment and stops the descent – and
 * only if it is timed for the last few metres. On foot: walking and running over the terrain,
 * swimming in a lake.
 *
 * `state` has the shape of an aircraft's, so the app interpolates and places it with the
 * same code: the reference point is the hips (centre of mass), the body axes are x along the
 * heading, y right, z down, always upright; how the figure lies or hangs is the visual's job.
 */
import { DEG, clamp, cross, dot, normalize, quatFromAxes, smoothstep } from '../math';
import type { AircraftState, AirSample, Environment, GroundSample, Vec3 } from '../types';

export type ParachutistMode = 'freefall' | 'canopy' | 'walk';
/** Things the app reacts to with a message or a sound. */
export type ParachutistEvent = 'opened' | 'landed' | 'hardLanding' | 'fatal' | 'splash';
/** A steerable ram-air wing (sport rig) or the round canopy of an ejection seat. */
export type CanopyKind = 'ramAir' | 'round';

/** The pilot's input, read once per step. Axes -1..1. */
export interface ParachutistInput {
  /** Right positive: turn (on foot, in free fall, the right toggle under the canopy). */
  x: number;
  /** Forward positive: walk or track forward; back is brakes under the canopy. */
  y: number;
  /** On foot: run. */
  run: boolean;
  /** Free fall: pull the ripcord. Under the canopy: both toggles down (flare). */
  pull: boolean;
}

/** What the HUD shows, without allocating. */
export interface ParachutistView {
  state: ParachutistMode;
  /** Height of the feet above the ground (the body in free fall), m. */
  agl: number;
  /** Speed over the ground (horizontal) and vertical speed (positive up), m/s. */
  speed: number;
  verticalSpeed: number;
  /** Heading the pilot faces or flies, degrees true 0..360. */
  headingDeg: number;
}

export const G = 9.81;
const RHO0 = 1.225;
/** Belly-to-earth terminal velocity at sea level, m/s. */
export const TERMINAL_VELOCITY = 55;
const K_FREEFALL = G / (TERMINAL_VELOCITY * TERMINAL_VELOCITY);
/** Hips above the soles standing, and hanging in the harness. */
export const HIP_HEIGHT = 0.95;
const HANG = 0.95;
/** A swimmer's hips under the surface: head and shoulders stay out. */
const SWIM_DEPTH = 0.7;

/**
 * Ram-air canopy, a ~170 sq ft sport main at a 1:1 wing loading: forward speed and sink at
 * sea level in full flight and in deep brakes. They define the lift and drag per unit mass
 * the glide model uses; a different air density then scales the speeds as for any wing.
 */
export const RAM_AIR = { forward: [11, 5.5], sink: [5, 3.4] } as const;
/** Military round canopy (as on ejection seats): barely steerable, ~5.5 m/s descent. */
export const ROUND = { forward: 1.2, sink: 5.5 } as const;

/** Lift and drag per unit mass and dynamic pressure, m^2/kg, for a speed pair. */
function polarPoint(forward: number, sink: number): [number, number] {
  const v2 = forward * forward + sink * sink;
  const q = 0.5 * RHO0 * v2;
  const gamma = Math.atan2(sink, forward);
  return [(G * Math.cos(gamma)) / q, (G * Math.sin(gamma)) / q];
}
const [AL_FULL, AD_FULL] = polarPoint(RAM_AIR.forward[0], RAM_AIR.sink[0]);
const [AL_BRAKE, AD_BRAKE] = polarPoint(RAM_AIR.forward[1], RAM_AIR.sink[1]);
const [AL_ROUND, AD_ROUND] = polarPoint(ROUND.forward, ROUND.sink);

/**
 * The flare, relative to deep brakes: lift and drag while flying, the seconds of holding it
 * over which the wing stalls, the lift lost and drag gained stalled, the stroke time.
 */
const FLARE = {
  lift: 1.6,
  drag: 0.9,
  stall: [2.5, 3.5] as const,
  lostLift: 0.6,
  stallDrag: 1,
  stroke: 0.2,
};

/** Opening sequence, s: pilot chute, bag and line stretch, then inflation until this time. */
const OPENING = {
  ramAir: { snatch: 0.9, open: 3.0 },
  round: { snatch: 0.3, open: 1.6 },
} as const;
/** Deceleration bound during inflation (the snatch force is felt, not simulated), m/s^2. */
const OPENING_DECEL = 4 * G;

/** Landing thresholds: up to these a landing is a stand-up one. */
export const SOFT_SINK = 4;
const SOFT_SPEED = 7;
/** Above this sink rate an impact is not survivable. */
export const FATAL_SINK = 12;

const WALK = 1.6;
const RUN = 5.5;
const SWIM = 0.9;
/** Steeper ground than this cannot be walked up. */
export const MAX_SLOPE = 38 * DEG;
/** The ground drops more than this below the feet: falling, not walking. */
const STEP_DOWN = 0.6;

const v3 = (): Vec3 => ({ x: 0, y: 0, z: 0 });

export class Parachutist {
  /** Hips position, velocity (world), upright orientation along the heading. */
  readonly state: AircraftState = {
    position: v3(),
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    velocity: v3(),
    angularVelocity: v3(),
  };
  mode: ParachutistMode = 'walk';
  canopy: CanopyKind = 'ramAir';
  alive = true;
  /** On foot in water. */
  swimming = false;
  /** Seconds since the ripcord was pulled (-1 before), and the inflation 0..1. */
  sincePull = -1;
  deploy = 0;
  /** Under the canopy: brake setting and flare reached 0..1, bank (rad, right +). */
  brakes = 0;
  flare = 0;
  bank = 0;
  /** Seconds since the feet touched the ground after a descent (-1 while not landed). */
  sinceLanding = -1;
  /** Metres walked: the visual's stride phase. */
  stride = 0;
  /** Sink rate and ground speed at the last touchdown, m/s. */
  touchdownSink = 0;
  touchdownSpeed = 0;
  /** Simulated seconds since leaving the aircraft. */
  time = 0;

  /** Unit vectors at the current position: up, heading (horizontal), right. */
  readonly up = v3();
  readonly forward = v3();
  readonly right = v3();
  private readonly north = v3();
  private readonly down = v3();
  private readonly air: AirSample = {
    wind: v3(),
    density: RHO0,
    temperature: 288,
    pressure: 101325,
  };
  private readonly vAir = v3();
  private readonly tmp = v3();
  private lastGround = 0;
  private groundKnown = false;
  private turnRate = 0;
  private flareHeld = 0;
  /** Canopy flight: speed along the heading and vertical, relative to the air. */
  private u = 0;
  private w = 0;
  private readonly events: ParachutistEvent[] = [];

  /**
   * Starts outside: at `position` (the hips) with `velocity`, facing `headingDeg`. Airborne
   * starts in free fall; otherwise standing on the ground below.
   */
  reset(
    position: Vec3,
    velocity: Vec3,
    headingDeg: number,
    airborne: boolean,
    env: Environment,
    canopy: CanopyKind = 'ramAir',
  ) {
    const s = this.state;
    s.position.x = position.x;
    s.position.y = position.y;
    s.position.z = position.z;
    s.velocity.x = velocity.x;
    s.velocity.y = velocity.y;
    s.velocity.z = velocity.z;
    s.angularVelocity.x = s.angularVelocity.y = s.angularVelocity.z = 0;
    this.mode = airborne ? 'freefall' : 'walk';
    this.canopy = canopy;
    this.alive = true;
    this.swimming = false;
    this.sincePull = -1;
    this.deploy = 0;
    this.brakes = 0;
    this.flare = 0;
    this.bank = 0;
    this.sinceLanding = -1;
    this.stride = 0;
    this.touchdownSink = 0;
    this.touchdownSpeed = 0;
    this.time = 0;
    this.turnRate = 0;
    this.flareHeld = 0;
    this.u = this.w = 0;
    this.events.length = 0;
    this.groundKnown = false;
    env.up(s.position, this.up);
    env.north(s.position, this.north);
    const h = headingDeg * DEG;
    // east = north x up
    cross(this.right, this.north, this.up);
    this.forward.x = Math.cos(h) * this.north.x + Math.sin(h) * this.right.x;
    this.forward.y = Math.cos(h) * this.north.y + Math.sin(h) * this.right.y;
    this.forward.z = Math.cos(h) * this.north.z + Math.sin(h) * this.right.z;
    this.frame(env);
    if (!airborne) {
      const g = env.ground(s.position);
      if (g) this.standOn(g, env);
    }
  }

  /** Pulls the ripcord (free fall only). */
  pull() {
    if (this.mode !== 'freefall' || !this.alive) return;
    this.mode = 'canopy';
    this.sincePull = 0;
    this.deploy = 0;
  }

  /** Height of the feet above the ground (of the body in free fall), m. */
  get agl(): number {
    // Before any ground has been seen this is the height above the ellipsoid.
    return (
      this.hipsAgl - (this.mode === 'freefall' ? 0 : this.mode === 'canopy' ? HANG : HIP_HEIGHT)
    );
  }

  private hipsAgl = 0;

  /**
   * Advances by `dt` (the fixed step). Returns the events of this step (the same array,
   * refilled every step).
   */
  step(dt: number, env: Environment, input: ParachutistInput): readonly ParachutistEvent[] {
    this.events.length = 0;
    this.time += dt;
    if (this.sinceLanding >= 0) this.sinceLanding += dt;
    const s = this.state;
    env.up(s.position, this.up);
    env.air(s.position, this.air);
    const g = env.ground(s.position);
    const alt = env.altitude(s.position);
    if (g) {
      this.lastGround = g.height;
      this.groundKnown = true;
    }
    this.hipsAgl = alt - this.lastGround;
    if (!this.alive) {
      s.velocity.x = s.velocity.y = s.velocity.z = 0;
      this.frame(env);
      return this.events;
    }
    if (this.mode === 'freefall') this.fall(dt, env, input);
    else if (this.mode === 'canopy') this.fly(dt, env, input);
    else this.walk(dt, env, input, g);
    this.frame(env);
    return this.events;
  }

  /** Fills `out` for the HUD. */
  view(out: ParachutistView): ParachutistView {
    const v = this.state.velocity;
    const vu = dot(v, this.up);
    out.state = this.mode;
    out.agl = Math.max(0, this.agl);
    out.verticalSpeed = vu;
    out.speed = Math.sqrt(Math.max(0, dot(v, v) - vu * vu));
    out.headingDeg = this.headingDeg;
    return out;
  }

  /** Heading of the body, degrees true 0..360. */
  get headingDeg(): number {
    const n = this.north;
    const east = cross(this.tmp, n, this.up);
    const h = Math.atan2(dot(this.forward, east), dot(this.forward, n)) / DEG;
    return h < 0 ? h + 360 : h;
  }

  // ---------------------------------------------------------------------------------------

  private airVelocity() {
    const v = this.state.velocity;
    const wnd = this.air.wind;
    this.vAir.x = v.x - wnd.x;
    this.vAir.y = v.y - wnd.y;
    this.vAir.z = v.z - wnd.z;
    return this.vAir;
  }

  private turn(rate: number, dt: number) {
    // Rotating the heading about the local vertical; `frame` re-orthogonalises it.
    const a = rate * dt;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const f = this.forward;
    // forward x up is the right-hand side; a positive rate turns towards it.
    const r = cross(this.right, f, this.up);
    f.x = f.x * c + r.x * sn;
    f.y = f.y * c + r.y * sn;
    f.z = f.z * c + r.z * sn;
    normalize(f, f);
  }

  private fall(dt: number, env: Environment, input: ParachutistInput) {
    const s = this.state;
    const up = this.up;
    const va = this.airVelocity();
    const speed = Math.sqrt(dot(va, va));
    const k = K_FREEFALL * (this.air.density / RHO0);
    // Flat turns, and tracking: arms back, legs straight, the body planes forward.
    this.turnRate += (clamp(input.x, -1, 1) * 1.6 - this.turnRate) * Math.min(1, dt * 3);
    this.turn(this.turnRate, dt);
    const along = dot(va, this.forward);
    const wantAlong = input.y >= 0 ? input.y * 14 : input.y * 5;
    const track = clamp((wantAlong - along) * 0.8, -0.3 * G, 0.3 * G);
    const ax = -k * speed * va.x + track * this.forward.x - G * up.x;
    const ay = -k * speed * va.y + track * this.forward.y - G * up.y;
    const az = -k * speed * va.z + track * this.forward.z - G * up.z;
    s.velocity.x += ax * dt;
    s.velocity.y += ay * dt;
    s.velocity.z += az * dt;
    this.move(dt);
    // Only the pilot opens the parachute (the owner's choice: no automatic opening device,
    // not even after an ejection): who never pulls hits the ground.
    if (input.pull) this.pull();
    if (this.groundKnown && this.hipsAgl <= 0.3) this.touchdown(env);
  }

  /**
   * Lift and drag per unit mass and dynamic pressure at a brake setting `b` and flare `f`.
   * The flare pulls the toggles past the brakes: much more lift for the drag while the
   * speed lasts. Held for longer than about two seconds the wing stalls and drops: the flare
   * only works timed for the last few metres.
   */
  private coefficients(b: number, f = 0, held = 0): [number, number] {
    if (this.canopy === 'round') return [AL_ROUND, AD_ROUND];
    // Brakes act more towards the end of the toggle stroke.
    const e = b * b * (1.6 - 0.6 * b);
    let al = AL_FULL + (AL_BRAKE - AL_FULL) * e;
    let ad = AD_FULL + (AD_BRAKE - AD_FULL) * e;
    if (f > 0) {
      al += (AL_BRAKE * FLARE.lift - al) * f;
      ad += (AD_BRAKE * FLARE.drag - ad) * f;
      const stalled = smoothstep(FLARE.stall[0], FLARE.stall[1], held);
      al *= 1 - FLARE.lostLift * f * stalled;
      ad *= 1 + FLARE.stallDrag * f * stalled;
    }
    return [al, ad];
  }

  private fly(dt: number, env: Environment, input: ParachutistInput) {
    const s = this.state;
    const up = this.up;
    const timing = OPENING[this.canopy];
    this.sincePull += dt;
    const round = this.canopy === 'round';
    const wantBrakes = round ? 0 : Math.min(1, Math.max(0, -input.y) + 0.2 * Math.abs(input.x));
    const wantFlare = !round && input.pull ? 1 : 0;
    // A toggle stroke takes a moment, and the wing pitches up behind it.
    this.brakes += (wantBrakes - this.brakes) * Math.min(1, dt / 0.3);
    this.flare += (wantFlare - this.flare) * Math.min(1, dt / FLARE.stroke);
    // Letting the toggles up lets the wing fly again.
    this.flareHeld = this.flare > 0.5 ? this.flareHeld + dt : Math.max(0, this.flareHeld - 2 * dt);
    const rho = this.air.density;
    if (this.deploy < 1) {
      this.deploy = smoothstep(timing.snatch, timing.open, this.sincePull);
      if (this.sincePull >= timing.open) this.deploy = 1;
      this.inflate(dt, rho);
      if (this.deploy >= 1) {
        const va = this.airVelocity();
        this.u = Math.max(0.5, dot(va, this.forward));
        this.w = dot(va, up);
        this.events.push('opened');
      }
    } else {
      const steer = round ? 0.15 : 0.95;
      this.turnRate += (clamp(input.x, -1, 1) * steer - this.turnRate) * Math.min(1, dt * 2);
      const v2 = this.u * this.u + this.w * this.w;
      const v = Math.sqrt(v2);
      const [al, ad] = this.coefficients(this.brakes, this.flare, this.flareHeld);
      // A turn banks the jumper under the wing; the lift then holds up less.
      this.bank = Math.atan2(v * this.turnRate, G);
      const q = 0.5 * rho * v2;
      const lift = al * q * Math.cos(this.bank);
      const drag = ad * q;
      const du = (-drag * this.u - lift * this.w) / v;
      const dw = (-drag * this.w + lift * this.u) / v - G;
      this.u = Math.max(0.3, this.u + du * dt);
      this.w += dw * dt;
      this.turn(this.turnRate, dt);
      const wind = this.air.wind;
      const f = this.forward;
      s.velocity.x = f.x * this.u + up.x * this.w + wind.x;
      s.velocity.y = f.y * this.u + up.y * this.w + wind.y;
      s.velocity.z = f.z * this.u + up.z * this.w + wind.z;
    }
    this.move(dt);
    if (this.groundKnown && this.hipsAgl - HANG <= 0) this.touchdown(env);
  }

  /**
   * From free-fall speed to canopy speed: the air-relative velocity is pulled towards the
   * open canopy's, harder as it inflates, with the deceleration bounded.
   */
  private inflate(dt: number, rho: number) {
    const s = this.state;
    const up = this.up;
    const va = this.airVelocity();
    const speed = Math.sqrt(dot(va, va));
    const k = K_FREEFALL * (rho / RHO0);
    const [al, ad] = this.coefficients(0);
    // Equilibrium glide at this density.
    const cl2 = al * al + ad * ad;
    const vEq = Math.sqrt(G / (0.5 * rho * Math.sqrt(cl2)));
    const gamma = Math.atan2(ad, al);
    const fwd = vEq * Math.cos(gamma) * this.deploy;
    const sink = vEq * Math.sin(gamma);
    const t = this.tmp;
    t.x = this.forward.x * fwd - up.x * sink - va.x;
    t.y = this.forward.y * fwd - up.y * sink - va.y;
    t.z = this.forward.z * fwd - up.z * sink - va.z;
    const gap = Math.sqrt(dot(t, t));
    const pullAcc = Math.min(OPENING_DECEL, gap * 3 * this.deploy);
    const scale = gap > 1e-6 ? pullAcc / gap : 0;
    // Until the canopy holds the weight, gravity and the body's drag still act.
    const free = 1 - this.deploy;
    s.velocity.x += (t.x * scale - free * (k * speed * va.x + G * up.x)) * dt;
    s.velocity.y += (t.y * scale - free * (k * speed * va.y + G * up.y)) * dt;
    s.velocity.z += (t.z * scale - free * (k * speed * va.z + G * up.z)) * dt;
  }

  private walk(dt: number, env: Environment, input: ParachutistInput, g: GroundSample | undefined) {
    const s = this.state;
    const up = this.up;
    const v = s.velocity;
    const vUp = dot(v, up);
    this.swimming = g?.surface === 'water';
    const top = this.swimming ? SWIM : input.run ? RUN : WALK;
    const fwd = clamp(input.y, -1, 1);
    const turnRate = clamp(input.x, -1, 1) * (input.run ? 1.6 : 2.2);
    this.turn(turnRate, dt);
    // Wanted horizontal velocity: along the heading, slower backwards.
    const want = this.tmp;
    const speed = top * (fwd < 0 ? 0.5 * fwd : fwd);
    want.x = this.forward.x * speed;
    want.y = this.forward.y * speed;
    want.z = this.forward.z * speed;
    if (g && !this.swimming) {
      // Too steep: the uphill part of the step is lost.
      const n = g.normal;
      const nUp = dot(n, up);
      if (nUp < Math.cos(MAX_SLOPE)) {
        const d = this.down;
        // Horizontal part of the normal points downhill.
        d.x = n.x - up.x * nUp;
        d.y = n.y - up.y * nUp;
        d.z = n.z - up.z * nUp;
        normalize(d, d);
        const intoHill = dot(want, d);
        if (intoHill < 0) {
          want.x -= d.x * intoHill;
          want.y -= d.y * intoHill;
          want.z -= d.z * intoHill;
        }
      }
    }
    const k = 1 - Math.exp(-dt * (this.hipsAgl > HIP_HEIGHT + STEP_DOWN ? 0.5 : 8));
    // Horizontal velocity eases towards the wish; the vertical one is gravity's.
    let hx = v.x - up.x * vUp;
    let hy = v.y - up.y * vUp;
    let hz = v.z - up.z * vUp;
    hx += (want.x - hx) * k;
    hy += (want.y - hy) * k;
    hz += (want.z - hz) * k;
    const vy = vUp - G * dt;
    v.x = hx + up.x * vy;
    v.y = hy + up.y * vy;
    v.z = hz + up.z * vy;
    this.move(dt);
    this.stride += Math.sqrt(hx * hx + hy * hy + hz * hz) * dt;
    const g2 = env.ground(s.position);
    if (!g2) return;
    this.lastGround = g2.height;
    this.groundKnown = true;
    this.hipsAgl = env.altitude(s.position) - g2.height;
    const stand = g2.surface === 'water' ? -SWIM_DEPTH : HIP_HEIGHT;
    if (this.hipsAgl <= stand + STEP_DOWN) {
      // On the ground (or walking down a slope): the feet stay on it.
      const fell = -dot(v, up);
      if (fell > 6) this.judge(fell, Math.sqrt(hx * hx + hy * hy + hz * hz), g2, true);
      this.standOn(g2, env);
    }
  }

  /** Puts the hips at standing (or swimming) height over the ground and stops the descent. */
  private standOn(g: GroundSample, env: Environment) {
    const s = this.state;
    const up = this.up;
    const stand = g.surface === 'water' ? -SWIM_DEPTH : HIP_HEIGHT;
    const dh = stand - (env.altitude(s.position) - g.height);
    s.position.x += up.x * dh;
    s.position.y += up.y * dh;
    s.position.z += up.z * dh;
    this.hipsAgl = stand;
    const vu = dot(s.velocity, up);
    s.velocity.x -= up.x * vu;
    s.velocity.y -= up.y * vu;
    s.velocity.z -= up.z * vu;
    this.swimming = g.surface === 'water';
  }

  private touchdown(env: Environment) {
    const s = this.state;
    const g = env.ground(s.position);
    const up = this.up;
    const v = s.velocity;
    const vu = dot(v, up);
    const sink = -vu;
    const horizontal = Math.sqrt(Math.max(0, dot(v, v) - vu * vu));
    const fromCanopy = this.mode === 'canopy';
    this.mode = 'walk';
    this.sinceLanding = 0;
    this.touchdownSink = sink;
    this.touchdownSpeed = horizontal;
    this.judge(sink, horizontal, g, fromCanopy);
    // The run-out after a stand-up landing; a fall stops on the spot.
    const keep = this.alive && fromCanopy ? 0.35 : 0;
    v.x = (v.x - up.x * vu) * keep;
    v.y = (v.y - up.y * vu) * keep;
    v.z = (v.z - up.z * vu) * keep;
    this.turnRate = 0;
    this.bank = 0;
    this.brakes = 0;
    this.flare = 0;
    if (g) this.standOn(g, env);
  }

  private judge(sink: number, horizontal: number, g: GroundSample | undefined, canopy: boolean) {
    const water = g?.surface === 'water';
    // Water forgives a parachute landing, not a free fall onto it.
    const fatal = water ? sink > 25 : sink > FATAL_SINK || (!canopy && sink > FATAL_SINK * 0.8);
    if (fatal) {
      this.alive = false;
      this.events.push('fatal');
    } else if (water) this.events.push('splash');
    else if (sink <= SOFT_SINK && horizontal <= SOFT_SPEED) this.events.push('landed');
    else this.events.push('hardLanding');
  }

  private move(dt: number) {
    const p = this.state.position;
    const v = this.state.velocity;
    p.x += v.x * dt;
    p.y += v.y * dt;
    p.z += v.z * dt;
    // Over the few centimetres of one step the ground is taken as flat.
    this.hipsAgl += dot(v, this.up) * dt;
  }

  /** Keeps the heading horizontal at the new position and writes the orientation. */
  private frame(env: Environment) {
    const s = this.state;
    env.up(s.position, this.up);
    env.north(s.position, this.north);
    const up = this.up;
    const f = this.forward;
    const fu = dot(f, up);
    f.x -= up.x * fu;
    f.y -= up.y * fu;
    f.z -= up.z * fu;
    if (dot(f, f) < 1e-12) {
      f.x = this.north.x;
      f.y = this.north.y;
      f.z = this.north.z;
    }
    normalize(f, f);
    this.down.x = -up.x;
    this.down.y = -up.y;
    this.down.z = -up.z;
    // Body y (right) = z (down) x x (forward).
    cross(this.right, this.down, f);
    quatFromAxes(s.orientation, f, this.right, this.down);
    s.angularVelocity.x = s.angularVelocity.y = 0;
    s.angularVelocity.z = this.mode === 'walk' ? 0 : this.turnRate;
  }
}
