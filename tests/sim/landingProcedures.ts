/**
 * Hand-flown landings from a 3 NM final: the runway, the approach set-up and what the flight
 * records from the threshold to the stop. The runway runs north from the world's origin (the
 * threshold); the 3° glide path meets the ground at the aim point 300 m beyond it.
 */
import { TestEnvironment, createAircraft, type Vec3 } from '../../src/sim';
import type { FlightModel } from '../../src/sim/flightModel';
import { integrateOrientation } from '../../src/sim/math';
import { FLAPS, newFa18, setFuel } from './fa18Harness';
import { HornetPilot } from './fa18Procedures';
import { AttitudePilot, DEG, FT, KT, Pid, SIM_DT, clamp, type Flight } from './harness';

export const AIM_POINT = 300;
export const GLIDE_PATH = 3 * DEG;
/** Half the width of a 45 m runway. */
export const RUNWAY_HALF_WIDTH = 22.5;

export interface LandingFlight extends Flight {
  ac: FlightModel;
}

/** In the air on the extended centre line, `nm` from the aim point, on the glide path. */
export function onFinal(
  ac: FlightModel,
  nm: number,
  kias: number,
  setup: { flaps: number; gearDown?: boolean },
): LandingFlight {
  const env = new TestEnvironment();
  const distance = nm * 1852;
  ac.controls.flaps = setup.flaps;
  ac.reset(
    {
      position: env.position(distance * Math.tan(GLIDE_PATH), AIM_POINT - distance),
      headingDeg: 0,
      speed: kias * KT,
      onGround: false,
      gearDown: setup.gearDown ?? true,
    },
    env,
  );
  return { ac, env };
}

/** Strut compressions of the wheels, m (private to the flight model). */
export const struts = (ac: FlightModel) =>
  (ac as unknown as { compression: Float64Array }).compression;

/** Distance along the runway from the threshold and to the right of the centre line, m. */
export function runwayPosition(f: Flight, p: Vec3 = f.ac.state.position) {
  const o = f.env.position(0);
  const up = f.env.up(o, { x: 0, y: 0, z: 0 });
  const n = f.env.north(o, { x: 0, y: 0, z: 0 });
  const e = { x: n.y * up.z - n.z * up.y, y: n.z * up.x - n.x * up.z, z: n.x * up.y - n.y * up.x };
  const d = { x: p.x - o.x, y: p.y - o.y, z: p.z - o.z };
  return {
    along: d.x * n.x + d.y * n.y + d.z * n.z,
    cross: d.x * e.x + d.y * e.y + d.z * e.z,
  };
}

/** Height of the glide path above the runway at a distance from the threshold, m. */
export const glidePathHeight = (along: number) => (AIM_POINT - along) * Math.tan(GLIDE_PATH);

/** What a landing comes to, from the threshold to the stop. */
export interface LandingRecord {
  crashed: string | undefined;
  /** Contact points (propeller, tail, wing tips, belly...) that touched the ground. */
  struck: string[];
  /** Over the threshold at 50 ft: distance from the threshold (m) where it passed 50 ft. */
  fiftyFeet: number;
  touchdown: {
    along: number;
    cross: number;
    sinkFpm: number;
    kias: number;
    pitchDeg: number;
    bankDeg: number;
    alphaDeg: number;
  };
  /** Largest load factor on the wheels after touch-down, g. */
  maxLoad: number;
  /** Largest distance from the centre line on the ground, m. */
  maxCross: number;
  stop: number;
  stopped: boolean;
  /** From 50 ft to the stop, and the ground roll, m. */
  landingDistance: number;
  groundRoll: number;
}

/** Watches a landing; call `step` after every simulation step, `done` at the end. */
export class LandingRecorder {
  private readonly r: LandingRecord = {
    crashed: undefined,
    struck: [],
    fiftyFeet: NaN,
    touchdown: {
      along: NaN,
      cross: NaN,
      sinkFpm: NaN,
      kias: NaN,
      pitchDeg: NaN,
      bankDeg: NaN,
      alphaDeg: NaN,
    },
    maxLoad: 0,
    maxCross: 0,
    stop: NaN,
    stopped: false,
    landingDistance: NaN,
    groundRoll: NaN,
  };
  touchedDown = false;
  private lastVs = 0;
  constructor(private readonly f: LandingFlight) {}

  step() {
    const t = this.f.ac.telemetry;
    const r = this.r;
    const pos = runwayPosition(this.f);
    if (Number.isNaN(r.fiftyFeet) && (t.agl ?? 100) < 50 * FT) r.fiftyFeet = pos.along;
    const touching = (this.f.ac as unknown as { contactTouching: Uint8Array }).contactTouching;
    this.f.ac.def.contacts.forEach((c, i) => {
      if (touching[i] && !r.struck.includes(c.name)) r.struck.push(c.name);
    });
    if (!this.touchedDown && t.onGround) {
      this.touchedDown = true;
      r.touchdown = {
        along: pos.along,
        cross: pos.cross,
        // The step's vertical speed has already been stopped by the wheels: the one before.
        sinkFpm: (-this.lastVs * 60) / FT,
        kias: t.ias / KT,
        pitchDeg: t.pitch / DEG,
        bankDeg: t.bank / DEG,
        alphaDeg: t.alpha / DEG,
      };
    }
    this.lastVs = t.verticalSpeed;
    if (this.touchedDown) {
      r.maxLoad = Math.max(r.maxLoad, t.loadFactor);
      r.maxCross = Math.max(r.maxCross, Math.abs(pos.cross));
      if (!r.stopped && t.groundSpeed < 0.3) {
        r.stopped = true;
        r.stop = pos.along;
      }
    }
    r.crashed = t.crashed;
    return r.stopped || t.crashed !== undefined;
  }

  done(): LandingRecord {
    const r = this.r;
    r.landingDistance = r.stop - r.fiftyFeet;
    r.groundRoll = r.stop - r.touchdown.along;
    return r;
  }
}

/** Flies until the recorder sees a stop (or `seconds` pass), the pilot before each step. */
export function flyLanding(f: LandingFlight, seconds: number, pilot: (dt: number) => void) {
  const rec = new LandingRecorder(f);
  for (let i = 0; i < seconds / SIM_DT; i++) {
    pilot(SIM_DT);
    f.ac.step(SIM_DT, f.env);
    if (rec.step()) break;
  }
  return rec;
}

/** Steering for the centre line: the heading (degrees) that brings the aircraft onto it. */
export function centreLineHeading(f: Flight) {
  const t = f.ac.telemetry;
  const { cross } = runwayPosition(f);
  // Rate across the centre line from the track.
  const crossRate = t.groundSpeed * Math.sin(t.trackDeg * DEG);
  return Math.max(-12, Math.min(12, -0.3 * cross - 2 * crossRate));
}

const wrap = (deg: number) => ((deg + 540) % 360) - 180;

/**
 * PC-12 at its landing mass, flaps 40, gear down, 85 KIAS on the glide path: pitch flies the
 * path, power the speed. Power to idle at 50 ft over the threshold, round out from about
 * 4 m and put it on (it is landed, not held off), then beta and reverse, brakes and the nose
 * wheel on the centre line.
 */
/** Round-out height, m, and touch-down attitude of the PC-12, degrees. */
const FLARE = 5;
const TOUCHDOWN_PITCH = 4;
export function pc12HandLanding(trace?: (f: LandingFlight, phase: string) => void) {
  const ac = createAircraft('pc12') as FlightModel;
  const f = onFinal(ac, 3, 85, { flaps: 1 });
  const t = ac.telemetry;
  const c = ac.controls;
  const attitude = new AttitudePilot(ac);
  const speed = new Pid(0.03, 0.01, 0, 1);
  const path = new Pid(0.02, 0.004, 0, 0.15);
  const thr0 = c.throttle[0]!;
  let phase: 'approach' | 'idle' | 'flare' | 'rollout' = 'approach';
  let flareTheta = 0;
  let rollTime = 0;
  let noseDown = false;
  const rec = flyLanding(f, 240, (dt) => {
    trace?.(f, phase);
    const agl = t.agl ?? 100;
    const along = runwayPosition(f).along;
    const track = centreLineHeading(f);
    if (phase !== 'rollout') attitude.bankTo(clamp(0.03 * wrap(track - t.trackDeg), -0.3, 0.3), dt);
    if (phase === 'approach') {
      const above = t.altitude - glidePathHeight(along) - 2;
      const vsTarget = -t.groundSpeed * Math.tan(GLIDE_PATH) - clamp(0.15 * above, -2, 2);
      attitude.pitchTo(-1 * DEG - path.update(t.verticalSpeed - vsTarget, dt), dt);
      c.throttle[0] = clamp(thr0 + speed.update(85 - t.ias / KT, dt), 0, 1);
      attitude.ball();
      if (agl < 50 * FT) phase = 'idle';
    } else if (phase === 'idle') {
      c.throttle[0] = 0;
      // Down the same path at idle: the nose a little lower to keep the speed.
      const vsTarget = -t.groundSpeed * Math.tan(GLIDE_PATH);
      attitude.pitchTo(-2.5 * DEG - path.update(t.verticalSpeed - vsTarget, dt), dt);
      attitude.ball();
      if (agl < FLARE) {
        phase = 'flare';
        flareTheta = t.pitch;
      }
    } else if (phase === 'flare') {
      c.throttle[0] = 0;
      // Round out: the nose comes up to the touch-down attitude as the runway comes up, a
      // little more if it still sinks fast; the speed bleeds towards about 1.1 VS0.
      const share = clamp(1 - agl / FLARE, 0, 1);
      const sinking = clamp(-1.2 - t.verticalSpeed, 0, 2) * 2 * DEG;
      attitude.pitchTo(flareTheta + (TOUCHDOWN_PITCH * DEG - flareTheta) * share + sinking, dt);
      attitude.ball();
      if (t.onGround) {
        phase = 'rollout';
        flareTheta = t.pitch;
      }
    } else if (!t.onGround && agl > 0.3 && !noseDown) {
      // Bounced: hold the attitude, power at idle, and land again.
      phase = 'flare';
      c.reverse = false;
      c.throttle[0] = 0;
      flareTheta = t.pitch;
    } else {
      rollTime += dt;
      c.roll = clamp(-2 * t.bank, -1, 1);
      c.yaw = clamp(0.15 * wrap(track - t.headingDeg) - 0.6 * ac.state.angularVelocity.z, -1, 1);
      // Beta on the main wheels takes the lift and the float away; the nose is lowered onto
      // its wheel over two seconds (pushed down at once it bounces the mains off and
      // wheelbarrows), then the yoke comes back to unload it under the brakes and reverse.
      c.reverse = true;
      noseDown ||= struts(ac)[0]! > 0;
      if (!noseDown && rollTime < 3) attitude.pitchTo(flareTheta * (1 - rollTime / 2), dt);
      else c.pitch = 0.2;
      const brake = noseDown ? 1 : 0;
      c.brakeLeft = brake;
      c.brakeRight = brake;
      // Full reverse down to 30 KIAS, then back to beta.
      c.throttle[0] = noseDown && t.ias / KT > 30 ? 1 : 0;
    }
  });
  return rec.done();
}

/**
 * F/A-18 at a 15 000 kg landing mass, flaps FULL, gear down, on speed: the throttles hold the
 * on-speed angle of attack (8.1°, the approach power compensator's job) and the stick flies
 * the glide path. No flare: it flies onto the runway as onto a deck, idle, and the brakes and
 * the nose wheel steering stop it on the centre line.
 */
export function fa18HandLanding(trace?: (f: LandingFlight, phase: string) => void) {
  const ac = newFa18();
  const f = onFinal(ac, 3, 138, { flaps: FLAPS.full });
  setFuel(f, 15_000 - ac.def.mass);
  ac.controls.pitchTrim = 0;
  const t = ac.telemetry;
  const c = ac.controls;
  const pilot = new HornetPilot(f);
  // Power on the flight path; the derivative damps the phugoid that the held angle of attack
  // leaves (thrust moves the speed, the speed the lift).
  const power = new Pid(1, 0.2, 6, 0.5);
  const thr0 = c.throttle[0]!;
  let phase: 'approach' | 'rollout' = 'approach';
  let rollTime = 0;
  const rec = flyLanding(f, 200, (dt) => {
    trace?.(f, phase);
    const along = runwayPosition(f).along;
    const track = centreLineHeading(f);
    if (phase === 'approach') {
      pilot.bankTo(clamp(0.03 * wrap(track - t.trackDeg), -0.3, 0.3), dt);
      const above = t.altitude - glidePathHeight(along) - 2.5;
      c.pitch = 0;
      const gamma = -GLIDE_PATH - clamp(0.003 * above, -0.025, 0.025);
      c.throttle.fill(clamp(thr0 + power.update(gamma - pilot.gamma, dt), 0, 0.75));
      if (t.onGround) phase = 'rollout';
    } else {
      rollTime += dt;
      c.throttle.fill(0);
      c.pitch = rollTime < 1 ? 0 : -0.3;
      c.roll = 0;
      c.yaw = clamp(0.2 * wrap(track - t.headingDeg) - 0.5 * ac.state.angularVelocity.z, -1, 1);
      const brake = rollTime > 1 ? 1 : 0;
      c.brakeLeft = brake;
      c.brakeRight = brake;
    }
  });
  return rec.done();
}

/**
 * A firm arrival: on the approach at `kias` (trimmed, the type's landing configuration) a
 * few metres up, then a sink rate added with the attitude turned down by the same path angle
 * (the angle of attack kept). Returns whether it crashed and which contact points touched.
 */
export function firmArrival(
  ac: FlightModel,
  sinkFpm: number,
  kias: number,
  flaps: number,
  after?: (f: LandingFlight) => void,
) {
  const env = new TestEnvironment();
  ac.controls.flaps = flaps;
  ac.reset(
    {
      position: env.position(3.2),
      headingDeg: 0,
      speed: kias * KT,
      onGround: false,
      gearDown: true,
    },
    env,
  );
  after?.({ ac, env });
  const up = env.up(ac.state.position, { x: 0, y: 0, z: 0 });
  const sink = sinkFpm * (FT / 60);
  const gamma = Math.atan2(sink, kias * KT);
  integrateOrientation(ac.state.orientation, { x: 0, y: -gamma, z: 0 }, 1);
  ac.state.velocity.x -= up.x * sink;
  ac.state.velocity.y -= up.y * sink;
  ac.state.velocity.z -= up.z * sink;
  const f = { ac, env };
  const rec = new LandingRecorder(f);
  for (let i = 0; i < 4 / SIM_DT && !ac.telemetry.crashed; i++) {
    ac.controls.pitch = 0;
    ac.step(SIM_DT, env);
    rec.step();
  }
  const r = rec.done();
  return { crashed: r.crashed, struck: r.struck, maxLoad: r.maxLoad };
}
