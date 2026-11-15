/**
 * The A320's FCOM procedures flown headless: by the flight guidance where an airline crew
 * would use it (climb, cruise, descent), by the test pilots of harness.ts where the figure is
 * a hand-flown one (take-off, landing, stall). Each returns the measured figures; the tests
 * compare them with the published values.
 */
import { DEG, FPM, FT, KT, Pid, clamp, fly, headingError } from './harness';
import {
  a320Airborne,
  a320OnGround,
  airbus,
  press,
  type A320Flight,
  type A320Options,
} from './a320Harness';
import { horizontalDistance } from './pc12Procedures';

export const totalFuelFlow = (f: A320Flight) =>
  f.ac.telemetry.engines.reduce((a, e) => a + e.fuelFlow, 0) * 3600;

/** Stick for a pitch attitude through the load factor law (P on attitude, D on pitch rate). */
export function attitudeStick(f: A320Flight, theta: number) {
  const t = f.ac.telemetry;
  return clamp(4.5 * (theta - t.pitch) - 2.5 * f.ac.state.angularVelocity.y, -1, 1);
}

/** Stick for a flight path angle: the law's load factor for the path change in 2 s. */
export function pathStick(f: A320Flight, gamma: number) {
  const t = f.ac.telemetry;
  const g = Math.asin(clamp(t.verticalSpeed / Math.max(t.tas, 30), -1, 1));
  const dn = (t.tas / 9.80665) * ((gamma - g) / 2);
  return clamp(dn, -0.5, 0.5);
}

/** Both thrust levers. */
export function levers(f: A320Flight, value: number) {
  f.ac.cockpit.set('throttle1', value);
  f.ac.cockpit.set('throttle2', value);
}

/**
 * In the air with the autopilot and autothrust engaged: levers in CLB, heading selected,
 * altitude and speed as given (the speed managed unless one is selected).
 */
export function cruising(
  altitudeFt: number,
  ktas: number,
  o: A320Options & { speed?: number; mach?: number } = {},
): A320Flight {
  const f = a320Airborne(altitudeFt * FT, ktas, o);
  const c = f.ac.cockpit;
  c.set('fcuAltitude', Math.round(altitudeFt / 100) * 100);
  c.set('fcuHeading', o.heading ?? 0);
  levers(f, 0.62);
  press(f, 'fcuHeadingPull');
  press(f, 'athr');
  fly(f, 6);
  press(f, 'ap1');
  press(f, 'fcuVsPush');
  if (o.mach !== undefined) {
    press(f, 'fcuSpeedPull');
    press(f, 'fcuMach');
    c.set('fcuSpeed', Math.round(o.mach * 100));
  } else if (o.speed !== undefined) {
    press(f, 'fcuSpeedPull');
    c.set('fcuSpeed', o.speed);
  }
  return f;
}

/** Level at an altitude and Mach with the autothrust holding it: fuel flow, N1, angle of attack. */
export function a320Cruise(altitudeFt: number, mach: number, mass: number) {
  const a = 295.07 * Math.sqrt((216.65 + Math.max(0, 36_089 - altitudeFt) * 0.0019812) / 216.65);
  const f = cruising(altitudeFt, (mach * a) / KT, { mass, mach });
  fly(f, 150);
  const t = f.ac.telemetry;
  return {
    flight: f,
    fuelFlow: totalFuelFlow(f),
    mach: t.mach!,
    n1: t.engines[0]!.n1!,
    vsFpm: t.verticalSpeed / FPM,
    alphaDeg: t.alpha / DEG,
    altitudeFt: t.altitude / FT,
  };
}

/**
 * Managed climb from 1500 ft at 250 kt to FL 350: THR CLB, 250 kt below FL 100, then
 * 300 kt and Mach 0.78. Returns the rate of climb through FL 100 and the time, distance
 * and fuel to FL 350.
 */
export function a320Climb(mass: number, topFt = 35_000) {
  const f = cruising(1500, 250, { mass });
  const { ac } = f;
  const t = ac.telemetry;
  ac.cockpit.set('fcuAltitude', topFt);
  press(f, 'fcuSpeedPush');
  press(f, 'fcuAltitudePush');
  const start = { ...ac.state.position };
  const fuel0 = t.fuel;
  let time = 0;
  // Rates of climb through these altitudes, ft/min (over 1000 ft around each).
  const marks = [5000, 15_000, 25_000, 33_000];
  const rates = marks.map(() => NaN);
  const below = marks.map(() => NaN);
  const elapsed = fly(f, 3000, () => {
    time += 1 / 120;
    const alt = t.altitude / FT;
    marks.forEach((m, i) => {
      if (Number.isNaN(below[i]!) && alt > m - 500) below[i] = time;
      if (Number.isNaN(rates[i]!) && alt > m + 500) rates[i] = 1000 / ((time - below[i]!) / 60);
    });
    return alt >= topFt - 30;
  });
  const rate10 = rates[0]!;
  return {
    flight: f,
    minutes: elapsed / 60,
    distanceNm: horizontalDistance(f, start, ac.state.position) / 1852,
    fuel: fuel0 - t.fuel,
    rate10,
    rates,
    mode: airbus(f).fma.vertical,
  };
}

/** Rate of climb at an altitude and Mach in THR CLB (the ceiling's measure), ft/min. */
export function a320ClimbRate(altitudeFt: number, mach: number, mass: number) {
  const f = a320Cruise(altitudeFt - 300, mach, mass).flight;
  f.ac.cockpit.set('fcuAltitude', 39_800);
  press(f, 'fcuAltitudePull');
  fly(f, 20);
  const h0 = f.ac.telemetry.altitude;
  fly(f, 20);
  return ((f.ac.telemetry.altitude - h0) / FT) * 3;
}

/** Idle descent in OP DES at a selected speed: the flight path angle, degrees. */
export function a320IdleDescent(kias: number, mass: number) {
  const f = cruising(24_000, kias * 1.45, { mass, speed: kias });
  f.ac.cockpit.set('fcuAltitude', 5000);
  press(f, 'fcuAltitudePull');
  fly(f, 60);
  const p0 = { ...f.ac.state.position };
  const h0 = f.ac.telemetry.altitude;
  fly(f, 90);
  const h = h0 - f.ac.telemetry.altitude;
  const d = horizontalDistance(f, p0, f.ac.state.position);
  return {
    angleDeg: Math.atan2(h, d) / DEG,
    vsFpm: f.ac.telemetry.verticalSpeed / FPM,
    kias: f.ac.telemetry.ias / KT,
    mode: airbus(f).fma.thrust,
  };
}

/**
 * 1 g stall speed of a configuration: in direct law (ADIRS off, no protection) from a
 * trimmed approach slow down at 1 kt/s, idle, holding the heading; the highest lift
 * coefficient flown gives VS1g (CS 25.103).
 */
export function a320Stall(flapLever: number, mass: number, onePlusF = false) {
  const f = a320Airborne(10_000 * FT, flapLever === 0 ? 210 : 170, {
    mass,
    flapLever: onePlusF ? 2 : flapLever,
    gearDown: flapLever === 4,
  });
  const { ac } = f;
  // CONF 1+F in flight: lever 1 from lever 2 below 210 kt.
  if (onePlusF) {
    fly(f, 0.1);
    ac.controls.flaps = 1 / 4;
    fly(f, 8);
  }
  const samples: [number, number][] = [];
  ac.cockpit.set('adirs', 0);
  levers(f, 0);
  const t = ac.telemetry;
  const pitch = new Pid(2.2, 0.8, 0, 1);
  const speed = new Pid(0.012, 0.002, 0, 0.5);
  let target = t.ias / KT;
  let clMax = 0;
  let alphaAt = 0;
  let elevatorAt = 0;
  let base = t.pitch;
  fly(f, 1);
  base = t.pitch;
  fly(f, 160, (dt) => {
    target -= dt;
    const theta = base + speed.update(t.ias / KT - target, dt);
    ac.controls.pitch = clamp(
      pitch.update(theta - t.pitch, dt) - 0.5 * ac.state.angularVelocity.y,
      -1,
      1,
    );
    // In direct law the pilot trims with the wheel.
    ac.controls.pitchTrim = clamp(ac.controls.pitchTrim + 0.4 * t.elevator * dt, -1, 1);
    ac.controls.roll = clamp(2 * (0 - t.bank) - 0.3 * ac.state.angularVelocity.x, -1, 1);
    const q = 0.5 * 1.225 * t.ias * t.ias;
    const cl = (ac.mass * 9.80665 * t.loadFactor) / (q * 122.6);
    samples.push([t.alpha, cl]);
    if (cl > clMax) {
      clMax = cl;
      alphaAt = t.alpha;
      elevatorAt = t.elevator;
    }
    // Past the maximum lift the stall is identified: recover (the test stops).
    return (cl < 0.95 * clMax && t.alpha > alphaAt + 2 * DEG) || t.ias / KT < target - 15;
  });
  const vs = Math.sqrt((2 * mass * 9.80665) / (1.225 * 122.6 * clMax)) / KT;
  /** Angle of attack where the lift first reaches a share of its maximum, degrees. */
  const alphaAtShare = (share: number) =>
    (samples.find((p) => p[1] >= share * clMax)?.[0] ?? NaN) / DEG;
  return {
    vs1g: vs,
    clMax,
    law: airbus(f).controls.law,
    config: airbus(f).controls.config,
    alphaDeg: alphaAt / DEG,
    elevator: elevatorAt,
    crashed: t.crashed,
    alphaAtShare,
  };
}

export interface TakeoffResult {
  flight: A320Flight;
  /** Distance from brake release to lift-off and to 35 ft, m. */
  liftOff: number;
  to35: number;
  liftOffKias: number;
  v35Kias: number;
  maxPitchDeg: number;
  /** Largest heading deviation on the runway, degrees, and the lowest height after lift-off. */
  headingDeviation: number;
  crashed: string | undefined;
  /** Climb gradient between 35 and 400 ft, per cent. */
  gradient: number;
  rudderTrim: number;
}

/**
 * Take-off in CONF 1+F with TOGA (or FLX), as the FCOM's: thrust set, brakes released,
 * rotation at VR at about 3°/s to 15° (12.5° with one engine), then SRS-like pitch for V2 +
 * 10 (V2 with an engine out). With `failAtV1` the left engine fails at V1 and the pilot keeps
 * the runway heading with the rudder and trims it out after lift-off.
 */
export function a320Takeoff(
  mass: number,
  o: { failAtV1?: boolean; elevation?: number } = {},
): TakeoffResult {
  const f = a320OnGround({ mass, flapLever: 1, elevation: o.elevation });
  const { ac } = f;
  const t = ac.telemetry;
  const c = ac.controls;
  const b = airbus(f);
  ac.cockpit.set('flightDirector', 1);
  ac.cockpit.set('spoilersArmed', 1);
  ac.cockpit.set('autobrake', 3);
  c.parkingBrake = false;
  // Take-off trim for the centre of gravity: a little nose up.
  c.pitchTrim = 0.1;
  fly(f, 2);
  const speeds = { ...b.speeds };
  const vr = speeds.vr;
  const v2 = speeds.v2;
  const v1 = speeds.v1;
  c.brakeLeft = c.brakeRight = 1;
  levers(f, 1);
  fly(f, 3);
  c.brakeLeft = c.brakeRight = 0;
  const start = { ...ac.state.position };
  const ground0 = t.altitude;
  const climb = new Pid(0.02, 0.004, 0, 0.12);
  let phase: 'roll' | 'rotate' | 'climb' = 'roll';
  let liftOff = NaN;
  let liftOffKias = 0;
  let to35 = NaN;
  let v35 = 0;
  let maxPitch = 0;
  let deviation = 0;
  let theta = 0;
  let failed = false;
  let h35 = NaN;
  let p35 = { ...start };
  let gradient = NaN;
  fly(f, 120, (dt) => {
    const kias = t.ias / KT;
    const heading = headingError(0, t.headingDeg);
    const r = ac.state.angularVelocity.z;
    if (o.failAtV1 && !failed && kias >= v1) {
      ac.failures.set('engine', true);
      failed = true;
    }
    maxPitch = Math.max(maxPitch, t.pitch / DEG);
    if (t.onGround) deviation = Math.max(deviation, Math.abs(heading));
    // Rudder: the runway heading on the ground, the ball (sideslip) in the air.
    const yaw = t.onGround ? 0.25 * heading - 2 * r : 4 * t.beta + 0.02 * heading;
    c.yaw = clamp(yaw, -1, 1);
    // Rudder trim takes over what the pedal holds, once airborne.
    if (!t.onGround && failed) c.yawTrim = clamp((c.yawTrim ?? 0) + 0.3 * c.yaw * dt, -1, 1);
    c.roll = t.onGround ? 0 : clamp(1.5 * (0.02 * heading - t.bank), -1, 1);
    if (phase === 'roll') {
      c.pitch = 0;
      if (kias >= vr) {
        phase = 'rotate';
        theta = t.pitch;
      }
    } else if (phase === 'rotate') {
      // About 3°/s towards 15° (12.5° with an engine out), as the FCOM asks.
      const top = (failed ? 12.5 : 15) * DEG;
      theta = Math.min(top, theta + 3 * DEG * dt);
      const q = ac.state.angularVelocity.y;
      c.pitch = clamp(0.4 + 4 * (theta - t.pitch) - 3 * (q - 3 * DEG), -1, 1);
      if (!t.onGround && Number.isNaN(liftOff)) {
        liftOff = horizontalDistance(f, start, ac.state.position);
        liftOffKias = kias;
      }
      if (!t.onGround && t.altitude - ground0 > 20 * FT) phase = 'climb';
    } else {
      // In the air the stick asks for load factor: pitch to the attitude for V2 + 10.
      const target = failed ? v2 : v2 + 10;
      const th = clamp(theta + climb.update(kias - target, dt), 5 * DEG, 18 * DEG);
      c.pitch = attitudeStick(f, th);
      if (t.verticalSpeed > 2) c.gearDown = false;
    }
    const h = t.altitude - ground0;
    if (Number.isNaN(to35) && h >= 35 * FT) {
      to35 = horizontalDistance(f, start, ac.state.position);
      v35 = kias;
      h35 = h;
      p35 = { ...ac.state.position };
    }
    if (!Number.isNaN(to35) && h >= 400 * FT) {
      gradient = ((h - h35) / horizontalDistance(f, p35, ac.state.position)) * 100;
      return true;
    }
    return t.crashed !== undefined;
  });
  return {
    flight: f,
    liftOff,
    to35,
    liftOffKias,
    v35Kias: v35,
    maxPitchDeg: maxPitch,
    headingDeviation: deviation,
    crashed: t.crashed,
    gradient,
    rudderTrim: c.yawTrim ?? 0,
  };
}

/**
 * Landing in CONF FULL at VAPP on a 3° path, hand flown: idle from 20 ft, flare, ground
 * spoilers armed, autobrake (MED by default), no reverse (the FCOM's distances give it no
 * credit). Returns the distance from 50 ft to the stop and the ground roll, m.
 */
export function a320Landing(mass: number, autobrake = 2, useReverse = false) {
  const f = a320Airborne(500 * FT, 140, { mass, flapLever: 4, gearDown: true });
  const { ac } = f;
  const t = ac.telemetry;
  const c = ac.controls;
  const b = airbus(f);
  ac.cockpit.set('spoilersArmed', 1);
  ac.cockpit.set('autobrake', autobrake);
  fly(f, 0.1);
  const vapp = b.speeds.vapp;
  levers(f, 0.62);
  press(f, 'athr');
  press(f, 'fcuSpeedPull');
  ac.cockpit.set('fcuSpeed', 0);
  fly(f, 0.1);
  let fifty: { x: number; y: number; z: number } | undefined;
  let touchdown: { x: number; y: number; z: number } | undefined;
  let stopped: { x: number; y: number; z: number } | undefined;
  let tdSink = 0;
  let tdKias = 0;
  const roll: [number, number][] = [];
  let flareTime = 0;
  let phase: 'approach' | 'flare' | 'rollout' = 'approach';
  fly(f, 200, (dt) => {
    const agl = (t.agl ?? 100) / FT;
    ac.cockpit.set('fcuSpeed', Math.round(vapp));
    c.roll = clamp(1.5 * (0.02 * headingError(0, t.headingDeg) - t.bank), -1, 1);
    if (!fifty && agl < 50) fifty = { ...ac.state.position };
    if (phase === 'approach') {
      c.pitch = pathStick(f, -3 * DEG);
      if (agl < 40) phase = 'flare';
    } else if (phase === 'flare') {
      if (agl < 20) levers(f, 0);
      // The flare against the flare mode's nose-down bias: sink to about 2 ft/s.
      const vsTarget = -(2 + agl / 4) * FT;
      // A pilot's hand: the stick comes back steadily, a little more while the sink is high.
      flareTime += dt;
      c.pitch = clamp(0.12 * flareTime + (0.03 * (vsTarget - t.verticalSpeed)) / FT, -0.2, 0.9);
      if (t.onGround) {
        phase = 'rollout';
        touchdown = { ...ac.state.position };
        tdSink = t.verticalSpeed / FPM;
        tdKias = t.ias / KT;
        levers(f, 0);
      }
    } else {
      c.pitch = 0;
      roll.push([t.time, t.groundSpeed]);
      c.yaw = clamp(0.15 * headingError(0, t.headingDeg) - 0.6 * ac.state.angularVelocity.z, -1, 1);
      if (useReverse) {
        c.reverse = true;
        levers(f, t.ias / KT > 70 ? 1 : 0);
      }
      if (t.groundSpeed < 0.5) {
        stopped = { ...ac.state.position };
        return true;
      }
    }
    return t.crashed !== undefined;
  });
  return {
    flight: f,
    vapp,
    total: fifty && stopped ? horizontalDistance(f, fifty, stopped) : NaN,
    groundRoll: touchdown && stopped ? horizontalDistance(f, touchdown, stopped) : NaN,
    touchdownSink: tdSink,
    touchdownKias: tdKias,
    crashed: t.crashed,
    groundSpoilers: b.controls.groundSpoilers,
    deceleration: rollDeceleration(roll),
  };
}

/**
 * Accelerate-stop: take-off thrust from brake release, the left engine fails at V1, the
 * crew retards both levers (2 s later, as certification allows for the recognition) and the
 * armed ground spoilers and autobrake MAX stop the aircraft. Returns the distance, m.
 */
export function a320AccelerateStop(mass: number) {
  const f = a320OnGround({ mass, flapLever: 1 });
  const { ac } = f;
  const t = ac.telemetry;
  const c = ac.controls;
  const b = airbus(f);
  ac.cockpit.set('spoilersArmed', 1);
  ac.cockpit.set('autobrake', 3);
  c.parkingBrake = false;
  c.pitchTrim = 0.1;
  fly(f, 2);
  const v1 = b.speeds.v1;
  c.brakeLeft = c.brakeRight = 1;
  levers(f, 1);
  fly(f, 3);
  c.brakeLeft = c.brakeRight = 0;
  const start = { ...ac.state.position };
  let failedAt = NaN;
  fly(f, 150, () => {
    const heading = headingError(0, t.headingDeg);
    c.yaw = clamp(0.4 * heading - 2 * ac.state.angularVelocity.z, -1, 1);
    if (Number.isNaN(failedAt) && t.ias / KT >= v1) {
      ac.failures.set('engine', true);
      failedAt = t.time;
    }
    if (!Number.isNaN(failedAt) && t.time > failedAt + 2) levers(f, 0);
    return !Number.isNaN(failedAt) && t.groundSpeed < 0.5;
  });
  return { distance: horizontalDistance(f, start, ac.state.position), v1, crashed: t.crashed };
}

/** Average deceleration (m/s²) of a landing roll between two ground speeds, knots. */
export function rollDeceleration(samples: readonly [number, number][], from = 110, to = 60) {
  const a = samples.find((s) => s[1] <= from * KT);
  const b = samples.find((s) => s[1] <= to * KT);
  return a && b && b[0] > a[0] ? (a[1] - b[1]) / (b[0] - a[0]) : NaN;
}
