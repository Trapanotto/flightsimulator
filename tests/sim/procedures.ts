/**
 * Handbook procedures flown by the test pilots. Each returns the measured figure; the tests
 * compare it with the published value.
 */
import {
  AltitudePilot,
  AttitudePilot,
  DEG,
  FPM,
  FT,
  KT,
  Leaner,
  Pid,
  SpeedPilot,
  airborne,
  clamp,
  fly,
  headingError,
  kcas,
  onGround,
  type Flight,
} from './harness';

/** Ground distance (m) between two world positions, measured along the local horizontal. */
function horizontalDistance(
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
 * Stall: from trimmed flight at idle, slow down at 1 kt/s holding altitude until the stall.
 * Returns the minimum calibrated and indicated speed reached (handbook stall speeds are
 * power off, 1 kt/s, most rearward CG). `setup` changes the aircraft after the reset.
 */
export function stallSpeed(flapsLever: number, setup?: (f: Flight) => void) {
  const f = airborne(1500, flapsLever > 0 ? 65 : 70, { flaps: flapsLever });
  setup?.(f);
  const { ac } = f;
  ac.controls.throttle[0] = 0;
  const pilot = new SpeedPilot(ac, 0);
  const t = ac.telemetry;
  let target = t.ias / KT;
  let minCas = Infinity;
  let minIas = Infinity;
  let warnedAt = 0;
  let stalled = false;
  fly(f, 120, (dt) => {
    target -= dt;
    pilot.step(target, dt);
    if (t.stallWarning && !warnedAt) warnedAt = t.ias / KT;
    const cas = kcas(ac, f.env);
    if (cas < minCas) {
      minCas = cas;
      minIas = t.ias / KT;
    }
    // The stall: the nose drops (or the sink runs away) although the yoke comes back.
    if (
      ac.controls.pitch > 0.3 &&
      (ac.state.angularVelocity.y < -3 * DEG || t.verticalSpeed < -8)
    ) {
      stalled = true;
      return true;
    }
    return false;
  });
  return { kcas: minCas, kias: minIas, warningKias: warnedAt, stalled };
}

/** Best rate of climb at Vy, full throttle, at the given pressure altitude band. */
export function climbRate(altitudeFt: number, vy = 74) {
  const f = airborne(altitudeFt * FT - 150, vy);
  const { ac } = f;
  ac.controls.throttle[0] = 1;
  const pilot = new SpeedPilot(ac, 0);
  const leaner = altitudeFt > 3000 ? new Leaner(ac) : undefined;
  fly(f, 30, (dt) => {
    pilot.step(vy, dt);
    leaner?.step(dt);
  });
  const h0 = ac.telemetry.altitude;
  fly(f, 30, (dt) => {
    pilot.step(vy, dt);
    leaner?.step(dt);
  });
  return {
    fpm: (ac.telemetry.altitude - h0) / 30 / FPM,
    rpm: ac.telemetry.engines[0]!.rpm,
    kias: ac.telemetry.ias / KT,
  };
}

/**
 * Climbs at Vy (decreasing with altitude as in the handbook) leaning for best power, and
 * returns the altitude (ft) where the climb rate falls to 100 ft/min.
 */
export function serviceCeiling() {
  const f = airborne(1000, 74);
  const { ac } = f;
  ac.controls.throttle[0] = 1;
  const pilot = new SpeedPilot(ac, 0);
  const leaner = new Leaner(ac);
  let last = ac.telemetry.altitude;
  let ceiling = 0;
  let timer = 0;
  let previous = { alt: 0, rate: 1000 };
  fly(f, 3600, (dt) => {
    const altFt = ac.telemetry.altitude / FT;
    const vy = 74 - (altFt / 1000) * 0.6;
    pilot.step(vy, dt);
    if (altFt > 3000) leaner.step(dt);
    timer += dt;
    if (timer >= 60) {
      // Rate over the last minute, credited to the middle of that minute.
      const rate = (ac.telemetry.altitude - last) / 60 / FPM;
      const mid = (ac.telemetry.altitude + last) / 2 / FT;
      if (rate < 100) {
        ceiling =
          previous.alt + ((previous.rate - 100) / (previous.rate - rate)) * (mid - previous.alt);
        return true;
      }
      previous = { alt: mid, rate };
      last = ac.telemetry.altitude;
      timer = 0;
    }
    return false;
  });
  return ceiling;
}

/** True airspeed (kt) and rpm in level flight at a power setting (fraction) or full throttle. */
export function levelSpeed(altitudeFt: number, power: number | 'full', startKtas = 110) {
  const f = airborne(altitudeFt * FT, startKtas);
  const { ac } = f;
  const pilot = new AltitudePilot(ac, 0, altitudeFt * FT);
  const leaner = altitudeFt > 3000 ? new Leaner(ac) : undefined;
  const powerPid = new Pid(0.5, 0.2, 0, 1);
  let maxRpm = 0;
  const control = (dt: number) => {
    pilot.step(dt);
    leaner?.step(dt);
    if (power === 'full') ac.controls.throttle[0] = 1;
    else
      ac.controls.throttle[0] = clamp(
        ac.controls.throttle[0]! + powerPid.update(power - ac.telemetry.engines[0]!.power, dt) * dt,
        0,
        1,
      );
  };
  fly(f, 240, control);
  fly(f, 60, (dt) => {
    control(dt);
    maxRpm = Math.max(maxRpm, ac.telemetry.engines[0]!.rpm);
  });
  return {
    ktas: ac.telemetry.tas / KT,
    rpm: maxRpm,
    power: ac.telemetry.engines[0]!.power,
    vsFpm: ac.telemetry.verticalSpeed / FPM,
  };
}

/** Glide at 68 KIAS, idle, flaps up: horizontal distance over height lost. */
export function glideRatio(kias = 68) {
  const f = airborne(2000, kias);
  const { ac } = f;
  ac.controls.throttle[0] = 0;
  const pilot = new SpeedPilot(ac, 0);
  fly(f, 40, (dt) => pilot.step(kias, dt));
  const p0 = { ...ac.state.position };
  const h0 = ac.telemetry.altitude;
  fly(f, 90, (dt) => pilot.step(kias, dt));
  const lost = h0 - ac.telemetry.altitude;
  return {
    ratio: horizontalDistance(f, p0, ac.state.position) / lost,
    rpm: ac.telemetry.engines[0]!.rpm,
  };
}

/** Full-throttle rpm standing on the brakes. */
export function staticRpm() {
  const f = onGround();
  f.ac.controls.parkingBrake = true;
  f.ac.controls.throttle[0] = 1;
  fly(f, 10);
  return { rpm: f.ac.telemetry.engines[0]!.rpm, moved: f.ac.telemetry.groundSpeed };
}

/**
 * Short-field take-off as in the handbook: flaps 10, full throttle on the brakes, release,
 * lift off at 51 KIAS, climb at 57 KIAS to 50 ft. Returns ground roll and total distance (ft).
 */
export function takeoff(
  options: {
    crosswindKt?: number;
    surface?: 'asphalt' | 'grass';
    slope?: { gradient: number; downhillDeg: number };
  } = {},
) {
  const wind = options.crosswindKt ? { fromDeg: 90, speed: options.crosswindKt * KT } : undefined;
  const f = onGround({ wind, surface: options.surface, slope: options.slope });
  const { ac } = f;
  const t = ac.telemetry;
  const c = ac.controls;
  c.flaps = 1 / 3;
  c.brakeLeft = 1;
  c.brakeRight = 1;
  c.throttle[0] = 1;
  fly(f, 12);
  const start = { ...ac.state.position };
  c.brakeLeft = 0;
  c.brakeRight = 0;
  const attitude = new AttitudePilot(ac);
  const climb = new Pid(0.03, 0.01, 0, 0.3);
  const ground0 = t.altitude;
  let liftOff: number | undefined;
  let liftOffKias = 0;
  let total: number | undefined;
  let maxDeviation = 0;
  let maxBank = 0;
  let phase: 'roll' | 'rotate' | 'climb' = 'roll';
  fly(f, 60, (dt) => {
    const heading = headingError(0, t.headingDeg);
    maxDeviation = Math.max(maxDeviation, Math.abs(heading));
    // Rudder and nose wheel keep the centre line; into-wind aileron against the crosswind.
    c.yaw = clamp(0.15 * heading - 0.6 * ac.state.angularVelocity.z, -1, 1);
    const across = horizontalOffset(f, start);
    if (phase === 'roll') {
      c.pitch = 0;
      attitude.bankTo(0, dt);
      if (t.ias / KT >= 47) phase = 'rotate';
    } else if (phase === 'rotate') {
      attitude.pitchTo(12 * DEG, dt);
      attitude.bankTo(0, dt);
      if (!t.onGround) {
        phase = 'climb';
        liftOff = horizontalDistance(f, start, ac.state.position);
        liftOffKias = t.ias / KT;
      }
    } else {
      // Keep the lift-off attitude while accelerating to 57 KIAS, then hold 57 with pitch.
      const theta = 8 * DEG + climb.update(t.ias / KT - 57, dt);
      attitude.pitchTo(theta, dt);
      attitude.bankTo(clamp(-0.002 * across, -0.1, 0.1), dt);
      maxBank = Math.max(maxBank, Math.abs(t.bank));
      if (t.altitude - ground0 >= 50 * FT) {
        total = horizontalDistance(f, start, ac.state.position);
        return true;
      }
    }
    return false;
  });
  return {
    groundRollFt: (liftOff ?? NaN) / FT,
    liftOffKias,
    totalFt: (total ?? NaN) / FT,
    maxHeadingDeviation: maxDeviation,
    maxBankDeg: maxBank / DEG,
    crashed: t.crashed,
  };
}

/** Signed sideways offset (m) of the aircraft from the centre line through `start` heading north. */
function horizontalOffset(f: Flight, start: { x: number; y: number; z: number }) {
  const p = f.ac.state.position;
  const north = f.env.north(start, { x: 0, y: 0, z: 0 });
  const up = f.env.up(start, { x: 0, y: 0, z: 0 });
  const east = {
    x: north.y * up.z - north.z * up.y,
    y: north.z * up.x - north.x * up.z,
    z: north.x * up.y - north.y * up.x,
  };
  return (p.x - start.x) * east.x + (p.y - start.y) * east.y + (p.z - start.z) * east.z;
}

/**
 * Short-field landing: stabilised at 61 KIAS, flaps 30, on a 3° path; idle and flare near
 * the ground, hold off until it settles, then nose down and maximum braking with the yoke
 * held back. Returns the ground roll (ft) from touchdown to a stop.
 */
export function landing(trace?: (f: Flight, phase: string) => void) {
  const f = airborne(120, 61, { flaps: 1 });
  const { ac } = f;
  const t = ac.telemetry;
  const c = ac.controls;
  const attitude = new AttitudePilot(ac);
  const speed = new Pid(0.04, 0.01, 0, 1);
  const path = new Pid(0.02, 0.004, 0, 0.15);
  let touchdown: { x: number; y: number; z: number } | undefined;
  let stopped = false;
  let roll = 0;
  let tdSpeed = 0;
  let tdSink = 0;
  let phase: 'approach' | 'flare' | 'rollout' = 'approach';
  let tdTime = 0;
  let theta = t.pitch;
  let flareTheta = 0;
  const flare = new Pid(0.25, 0.25, 0, 0.25);
  fly(f, 200, (dt) => {
    trace?.(f, phase);
    const agl = t.agl ?? 100;
    attitude.bankTo(0, dt);
    if (phase === 'approach') {
      // Pitch flies the 3° path (about 320 ft/min at 61 kt); power holds the speed.
      const vsTarget = -61 * KT * Math.tan(3 * DEG);
      theta = -1 * DEG - path.update(t.verticalSpeed - vsTarget, dt);
      attitude.pitchTo(theta, dt);
      c.throttle[0] = clamp(0.3 + speed.update(61 - t.ias / KT, dt), 0, 1);
      attitude.ball();
      if (agl < 6) {
        phase = 'flare';
        flareTheta = t.pitch;
      }
    } else if (phase === 'flare') {
      c.throttle[0] = 0;
      // Round out: the sink rate comes down with height; near the ground the aircraft is
      // held off, nose rising, until it settles as the speed bleeds away.
      const vsTarget = -0.25 - 0.4 * Math.max(agl - 0.3, 0);
      theta = clamp(flareTheta + flare.update(vsTarget - t.verticalSpeed, dt), -2 * DEG, 10 * DEG);
      attitude.pitchTo(theta, dt);
      attitude.ball();
      if (t.onGround) {
        phase = 'rollout';
        touchdown = { ...ac.state.position };
        tdSpeed = t.ias / KT;
        tdSink = t.verticalSpeed;
      }
    } else {
      tdTime += dt;
      c.yaw = clamp(0.15 * headingError(0, t.headingDeg) - 0.6 * ac.state.angularVelocity.z, -1, 1);
      // Handbook: nose wheel down, brakes heavily, flaps up for maximum brake effectiveness.
      c.pitch = tdTime < 1 ? -0.3 : 0.3;
      const brake = tdTime > 1 ? 1 : 0;
      c.brakeLeft = brake;
      c.brakeRight = brake;
      if (tdTime > 1) c.flaps = 0;
      if (t.groundSpeed < 0.3) {
        stopped = true;
        roll = horizontalDistance(f, touchdown!, ac.state.position);
        return true;
      }
    }
    return false;
  });
  return {
    groundRollFt: stopped ? roll / FT : NaN,
    touchdownKias: tdSpeed,
    touchdownSink: tdSink,
    crashed: t.crashed,
  };
}
