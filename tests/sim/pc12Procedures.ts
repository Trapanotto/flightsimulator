/**
 * The PC-12's handbook procedures flown by the test pilots of harness.ts. Each returns the
 * measured figure; pc12.poh.test.ts compares it with the published value.
 */
import {
  AltitudePilot,
  AttitudePilot,
  DEG,
  FPM,
  FT,
  KT,
  Pid,
  SpeedPilot,
  clamp,
  fly,
  headingError,
  kcas,
  type Flight,
} from './harness';
import { engine, pc12Airborne, pc12OnGround } from './pc12Harness';

/** Ground distance (m) between two world positions, along the local horizontal. */
export function horizontalDistance(
  f: Flight,
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
) {
  const up = f.env.up(a, { x: 0, y: 0, z: 0 });
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const v = d.x * up.x + d.y * up.y + d.z * up.z;
  return Math.sqrt(Math.max(0, d.x * d.x + d.y * d.y + d.z * d.z - v * v));
}

/**
 * Stall: from trimmed flight with the power at idle, slow down at 1 kt/s holding the heading
 * until the stick pusher fires (the PC-12's stall speeds are the speeds at the pusher, as
 * certification counts a stall identification device). Returns the calibrated and indicated
 * speeds at the shaker and at the pusher, and the lowest speed.
 */
export function pc12Stall(flapsLever: number, gearDown: boolean) {
  const f = pc12Airborne(5000 * FT, flapsLever > 0 ? 100 : 125, { flaps: flapsLever, gearDown });
  const { ac } = f;
  ac.controls.throttle[0] = 0;
  const pilot = new SpeedPilot(ac, 0);
  const t = ac.telemetry;
  let target = t.ias / KT;
  let shaker = 0;
  let pusher = 0;
  let minCas = Infinity;
  fly(f, 150, (dt) => {
    target -= dt;
    pilot.step(target, dt);
    const cas = kcas(ac, f.env);
    minCas = Math.min(minCas, cas);
    if (t.stickShaker && !shaker) shaker = cas;
    if (t.stickPusher && !pusher) {
      pusher = cas;
      return true;
    }
    return false;
  });
  return { shakerKcas: shaker, pusherKcas: pusher, minKcas: minCas, flight: f };
}

/** Best rate of climb at `kias`, maximum power, clean, around `altitudeFt`. */
export function pc12Climb(altitudeFt: number, kias: number) {
  const f = pc12Airborne(altitudeFt * FT - 150, kias + 5);
  const { ac } = f;
  ac.controls.throttle[0] = 1;
  const pilot = new SpeedPilot(ac, 0);
  fly(f, 30, (dt) => pilot.step(kias, dt));
  const h0 = ac.telemetry.altitude;
  fly(f, 30, (dt) => pilot.step(kias, dt));
  return {
    fpm: (ac.telemetry.altitude - h0) / 30 / FPM,
    torque: engine(f).torque!,
    itt: engine(f).turbineTemperature!,
  };
}

/** Level flight at full power (or a torque share): true airspeed, torque, ITT, fuel flow. */
export function pc12Level(altitudeFt: number, startKtas: number, torque?: number) {
  const f = pc12Airborne(altitudeFt * FT, startKtas);
  const { ac } = f;
  const pilot = new AltitudePilot(ac, 0, altitudeFt * FT);
  const powerPid = new Pid(0.5, 0.2, 0, 1);
  const control = (dt: number) => {
    pilot.step(dt);
    if (torque === undefined) ac.controls.throttle[0] = 1;
    else
      ac.controls.throttle[0] = clamp(
        ac.controls.throttle[0]! + powerPid.update(torque - engine(f).torque!, dt) * dt,
        0,
        1,
      );
  };
  fly(f, 240, control);
  fly(f, 30, control);
  const e = engine(f);
  return {
    ktas: ac.telemetry.tas / KT,
    torque: e.torque!,
    itt: e.turbineTemperature!,
    ng: e.n2!,
    fuelFlow: e.fuelFlow,
    vsFpm: ac.telemetry.verticalSpeed / FPM,
  };
}

/** Glide with the propeller feathered, gear and flaps up: horizontal distance over height lost. */
export function pc12Glide(kias: number) {
  const f = pc12Airborne(10_000 * FT, kias, { enginesRunning: false });
  const { ac } = f;
  ac.controls.throttle[0] = 0;
  const pilot = new SpeedPilot(ac, 0);
  fly(f, 40, (dt) => pilot.step(kias, dt));
  const p0 = { ...ac.state.position };
  const h0 = ac.telemetry.altitude;
  fly(f, 90, (dt) => pilot.step(kias, dt));
  return {
    ratio: horizontalDistance(f, p0, ac.state.position) / (h0 - ac.telemetry.altitude),
    propRpm: engine(f).propRpm!,
  };
}

/**
 * Take-off at MTOW, sea level ISA, flaps 15: power set against the brakes as far as they
 * hold, release, take-off power within two seconds, rotate at VR to about 10°, then accelerate
 * to the 50 ft speed and climb. Returns the ground roll and the distance to 50 ft, m.
 */
export function pc12Takeoff(vr = 83, v50 = 96) {
  const f = pc12OnGround();
  const { ac } = f;
  const t = ac.telemetry;
  const c = ac.controls;
  c.flaps = 1 / 3;
  c.brakeLeft = 1;
  c.brakeRight = 1;
  c.throttle[0] = 0.4;
  // Take-off trim: a little nose up from neutral, and the rudder trim set for the power.
  c.pitchTrim = 0.25;
  c.yawTrim = 0.4;
  fly(f, 8);
  const start = { ...ac.state.position };
  const crept = ac.telemetry.groundSpeed;
  c.brakeLeft = 0;
  c.brakeRight = 0;
  const attitude = new AttitudePilot(ac);
  const climb = new Pid(0.03, 0.01, 0, 0.3);
  const ground0 = t.altitude;
  let liftOff: number | undefined;
  let liftOffKias = 0;
  let total: number | undefined;
  let phase: 'roll' | 'rotate' | 'climb' = 'roll';
  let maxDeviation = 0;
  fly(f, 90, (dt) => {
    const heading = headingError(0, t.headingDeg);
    maxDeviation = Math.max(maxDeviation, Math.abs(heading));
    c.throttle[0] = Math.min(1, c.throttle[0]! + 0.3 * dt);
    if (phase === 'roll') {
      c.yaw = clamp(0.15 * heading - 0.6 * ac.state.angularVelocity.z, -1, 1);
      c.pitch = 0;
      attitude.bankTo(0, dt);
      if (t.ias / KT >= vr) phase = 'rotate';
    } else if (phase === 'rotate') {
      attitude.ball();
      attitude.pitchTo(10 * DEG, dt);
      attitude.bankTo(0, dt);
      if (!t.onGround) {
        phase = 'climb';
        liftOff = horizontalDistance(f, start, ac.state.position);
        liftOffKias = t.ias / KT;
      }
    } else {
      attitude.ball();
      const theta = 8 * DEG + climb.update(t.ias / KT - v50, dt);
      attitude.pitchTo(theta, dt);
      attitude.bankTo(clamp(0.03 * heading, -0.1, 0.1), dt);
      if (t.altitude - ground0 >= 50 * FT) {
        total = horizontalDistance(f, start, ac.state.position);
        return true;
      }
    }
    return false;
  });
  return {
    groundRoll: liftOff ?? NaN,
    total: total ?? NaN,
    liftOffKias,
    maxHeadingDeviation: maxDeviation,
    crashed: t.crashed,
    torque: engine(f).torque!,
    crept,
  };
}

/**
 * Landing at MTOW in landing configuration (flaps 40, gear down) at 85 KIAS on a 3° path:
 * idle and flare near the ground, then reverse and maximum braking. Returns the distance from
 * 50 ft and the ground roll, m.
 */
export function pc12Landing(
  useReverse = true,
  vapp = 85,
  trace?: (f: Flight, phase: string) => void,
) {
  const f = pc12Airborne(120, vapp, { flaps: 1, gearDown: true });
  const { ac } = f;
  const t = ac.telemetry;
  const c = ac.controls;
  const attitude = new AttitudePilot(ac);
  const speed = new Pid(0.03, 0.01, 0, 1);
  const path = new Pid(0.02, 0.004, 0, 0.15);
  const flare = new Pid(0.25, 0.25, 0, 0.25);
  let fifty: { x: number; y: number; z: number } | undefined;
  let touchdown: { x: number; y: number; z: number } | undefined;
  let stopped: { x: number; y: number; z: number } | undefined;
  let phase: 'approach' | 'idle' | 'flare' | 'rollout' = 'approach';
  let flareTheta = 0;
  let tdTime = 0;
  let tdSink = 0;
  const thr0 = c.throttle[0]!;
  fly(f, 200, (dt) => {
    trace?.(f, phase);
    const agl = t.agl ?? 100;
    attitude.bankTo(0, dt);
    if (!fifty && agl < 50 * FT) fifty = { ...ac.state.position };
    if (phase === 'approach') {
      const vsTarget = -vapp * KT * Math.tan(3 * DEG);
      const theta = -1 * DEG - path.update(t.verticalSpeed - vsTarget, dt);
      attitude.pitchTo(theta, dt);
      c.throttle[0] = clamp(thr0 + speed.update(vapp - t.ias / KT, dt), 0, 1);
      attitude.ball();
      if (agl < 50 * FT) phase = 'idle';
    } else if (phase === 'idle') {
      // Over the threshold: power to idle, the nose held a little lower to keep the speed.
      c.throttle[0] = 0;
      const theta = -3 * DEG - path.update(t.verticalSpeed + 3.2, dt);
      attitude.pitchTo(theta, dt);
      attitude.ball();
      if (agl < 4) {
        phase = 'flare';
        flareTheta = t.pitch;
      }
    } else if (phase === 'flare') {
      c.throttle[0] = 0;
      // Round out and put it on: the PC-12 is landed, not held off.
      const vsTarget = -0.7 - 0.5 * Math.max(agl - 0.3, 0);
      const theta = clamp(flareTheta + flare.update(vsTarget - t.verticalSpeed, dt), -2 * DEG, 6 * DEG);
      attitude.pitchTo(theta, dt);
      attitude.ball();
      if (t.onGround) {
        phase = 'rollout';
        touchdown = { ...ac.state.position };
        tdSink = t.verticalSpeed;
      }
    } else {
      tdTime += dt;
      c.yaw = clamp(0.15 * headingError(0, t.headingDeg) - 0.6 * ac.state.angularVelocity.z, -1, 1);
      c.pitch = tdTime < 1 ? -0.3 : 0.2;
      const brake = tdTime > 1 ? 1 : 0;
      c.brakeLeft = brake;
      c.brakeRight = brake;
      if (useReverse && tdTime > 0.5) {
        c.reverse = true;
        // Full reverse down to 30 KIAS, then back to beta.
        c.throttle[0] = t.ias / KT > 30 ? 1 : 0;
      }
      if (t.groundSpeed < 0.3) {
        stopped = { ...ac.state.position };
        return true;
      }
    }
    return false;
  });
  return {
    total: fifty && stopped ? horizontalDistance(f, fifty, stopped) : NaN,
    groundRoll: touchdown && stopped ? horizontalDistance(f, touchdown, stopped) : NaN,
    touchdownSink: tdSink,
    crashed: t.crashed,
  };
}
