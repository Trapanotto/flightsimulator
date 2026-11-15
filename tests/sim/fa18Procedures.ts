/**
 * Test pilots for the F/A-18 and the procedures they fly; each returns the measured figure
 * that fa18.performance.test.ts compares with the published one.
 *
 * The Hornet's stick commands load factor and roll rate, so these pilots ask the flight
 * control system for a load factor change (flight path) and a roll rate (bank), the way a
 * pilot flies it.
 */
import { DEG, FPM, FT, KT, Pid, clamp, fly, headingError } from './harness';
import { horizontalDistance } from './pc12Procedures';
import { FLAPS, fa18Airborne, fa18OnGround, fcs, setFuel, type Fa18Flight } from './fa18Harness';

const G = 9.80665;

/** Stick (−1..1) for a load factor change from the 1 g reference: the inverse of the FCS's gearing. */
export function stickForG(f: Fa18Flight, dn: number): number {
  const law = fcs(f);
  const span = dn >= 0 ? Math.max(law.gLimit - 1, 1) : 4;
  const s = clamp(Math.abs(dn) / span, 0, 1);
  const p = (-0.35 + Math.sqrt(0.35 * 0.35 + 2.6 * s)) / 1.3;
  return Math.sign(dn) * clamp(p, 0, 1);
}

/** Flight path and bank: the outer loops every procedure uses. */
export class HornetPilot {
  private readonly gammaPid = new Pid(0.7, 0.15, 0, 0.6);
  constructor(readonly f: Fa18Flight) {}

  get gamma() {
    const t = this.f.ac.telemetry;
    return Math.asin(clamp(t.verticalSpeed / Math.max(t.tas, 1), -1, 1));
  }

  /** Load factor change asked for a flight path angle, in a bank. */
  flyGamma(gammaCmd: number, dt: number, extraG = 0) {
    const t = this.f.ac.telemetry;
    const dGamma = this.gammaPid.update(gammaCmd - this.gamma, dt);
    // Flight path rate over a few seconds; a gentler loop where the FCS answers slowly (high and slow).
    const q = 0.5 * 1.225 * (t.ias * t.ias);
    const k = clamp(q / 15_000, 0.35, 1);
    const dn = (Math.max(t.tas, 50) / G) * dGamma * k + extraG;
    this.f.ac.controls.pitch = stickForG(this.f, dn);
  }

  /** Holds an altitude with the flight path. */
  holdAltitude(altitude: number, dt: number) {
    const t = this.f.ac.telemetry;
    const vs = clamp((altitude - t.altitude) / 8, -20, 20);
    this.flyGamma(Math.asin(clamp(vs / Math.max(t.tas, 50), -0.3, 0.3)), dt);
  }

  /** Rolls to a bank angle with roll rate, the rudder left to the FCS. */
  bankTo(phi: number, dt: number) {
    void dt;
    const t = this.f.ac.telemetry;
    const err = Math.atan2(Math.sin(phi - t.bank), Math.cos(phi - t.bank));
    const rate = clamp(2.5 * err, -1.5, 1.5);
    this.f.ac.controls.roll = clamp(rate / (220 * DEG), -1, 1);
    this.f.ac.controls.yaw = 0;
  }

  /** Wings level on a heading. */
  heading(target: number, dt: number) {
    const err = headingError(target, this.f.ac.telemetry.headingDeg);
    this.bankTo(clamp(0.05 * err, -0.5, 0.5), dt);
  }
}

/**
 * Maximum level speed: full afterburner at a constant altitude until the Mach number stops
 * rising (less than 0.0005 in 20 s), from a start a little below it.
 */
export function maxLevelMach(altitudeFt: number, startKtas: number) {
  const f = fa18Airborne(altitudeFt * FT, startKtas);
  const pilot = new HornetPilot(f);
  const t = f.ac.telemetry;
  f.ac.controls.throttle.fill(1);
  const h = altitudeFt * FT;
  let last = 0;
  for (let i = 0; i < 40; i++) {
    fly(f, 20, (dt) => {
      pilot.holdAltitude(h, dt);
      pilot.heading(0, dt);
    });
    const m = t.mach!;
    if (Math.abs(m - last) < 0.0005) break;
    last = m;
  }
  return { mach: t.mach!, kias: t.ias / KT, altitudeError: t.altitude - h, crashed: t.crashed };
}

/**
 * Rate of climb at a Mach number: full afterburner, the Mach held with the flight path, over
 * 1000 ft either side of the altitude.
 */
export function climbRate(altitudeFt: number, mach: number, throttle = 1) {
  const f = fa18Airborne(altitudeFt * FT - 300, (mach * soundSpeed(altitudeFt * FT)) / KT);
  const pilot = new HornetPilot(f);
  const t = f.ac.telemetry;
  f.ac.controls.throttle.fill(throttle);
  const speed = new Pid(3, 0.3, 0, 0.7);
  let gammaCmd = 0;
  const control = (dt: number) => {
    gammaCmd = clamp(speed.update((t.mach ?? 0) - mach, dt) * 4, -0.2, 1.2);
    pilot.flyGamma(gammaCmd, dt);
    pilot.heading(0, dt);
  };
  fly(f, 25, control);
  const h0 = t.altitude;
  const t0 = t.time;
  fly(f, 8, control);
  return {
    fpm: (t.altitude - h0) / (t.time - t0) / FPM,
    mach: t.mach!,
    crashed: t.crashed,
  };
}

/**
 * Specific excess power at a point: level flight at full throttle, (T - D) V / W measured as
 * the energy height's rate (m/s) while the altitude is held.
 */
export function excessPower(altitudeFt: number, mach: number, throttle = 1) {
  const f = fa18Airborne(altitudeFt * FT, (mach * soundSpeed(altitudeFt * FT)) / KT);
  const pilot = new HornetPilot(f);
  const t = f.ac.telemetry;
  const h = altitudeFt * FT;
  f.ac.controls.throttle.fill(throttle);
  fly(f, 1.5, (dt) => {
    pilot.holdAltitude(h, dt);
    pilot.heading(0, dt);
  });
  const e0 = t.altitude + (t.tas * t.tas) / (2 * G);
  const t0 = t.time;
  fly(f, 1, (dt) => {
    pilot.holdAltitude(h, dt);
    pilot.heading(0, dt);
  });
  const e1 = t.altitude + (t.tas * t.tas) / (2 * G);
  return { ps: (e1 - e0) / (t.time - t0), mach: t.mach! };
}

export function soundSpeed(altitude: number) {
  const temp = altitude < 11_000 ? 288.15 - 0.0065 * altitude : 216.65;
  return Math.sqrt(1.4 * 287.053 * temp);
}

/**
 * Time to climb from 1000 ft to an altitude: afterburner, a climb at Mach 0.85 (the flight
 * path flown to hold it), clean at the take-off mass.
 */
export function timeToClimb(targetFt: number, mach = 0.85) {
  const f = fa18Airborne(1000 * FT, (mach * soundSpeed(1000 * FT)) / KT);
  const pilot = new HornetPilot(f);
  const t = f.ac.telemetry;
  f.ac.controls.throttle.fill(1);
  let gamma = 0;
  let time = NaN;
  fly(f, 600, (dt) => {
    // Too fast: steeper.
    const e = (t.mach ?? 0) - mach;
    gamma = clamp(gamma + 2 * e * dt, -0.1, 1.2);
    pilot.flyGamma(clamp(gamma + 3 * e, -0.1, 1.3), dt);
    pilot.heading(0, dt);
    if (t.altitude >= targetFt * FT) {
      time = t.time;
      return true;
    }
    return false;
  });
  return { seconds: time, crashed: t.crashed };
}

/**
 * Take-off from brake release, sea level ISA: military power or full afterburner, flaps HALF,
 * take-off trim; full aft stick at the rotation speed until the nose is at about 10°, then
 * the climb. Ground roll to the main wheels leaving the runway, m.
 */
export function takeoff(throttle: number, vr = 130) {
  const f = fa18OnGround();
  const { ac } = f;
  const t = ac.telemetry;
  const c = ac.controls;
  c.flaps = FLAPS.half;
  ac.cockpit.set('takeoffTrim', 1);
  fly(f, 0.1);
  ac.cockpit.set('takeoffTrim', 0);
  c.brakeLeft = 1;
  c.brakeRight = 1;
  c.throttle.fill(Math.min(throttle, 0.75));
  fly(f, 5);
  const start = { ...ac.state.position };
  c.brakeLeft = 0;
  c.brakeRight = 0;
  c.throttle.fill(throttle);
  let liftOff: number | undefined;
  let liftOffKias = 0;
  let phase: 'roll' | 'rotate' | 'air' = 'roll';
  let maxDeviation = 0;
  fly(f, 60, () => {
    const heading = headingError(0, t.headingDeg);
    maxDeviation = Math.max(maxDeviation, Math.abs(heading));
    c.yaw = clamp(0.2 * heading - 0.5 * ac.state.angularVelocity.z, -1, 1);
    c.roll = clamp(-0.5 * t.bank, -1, 1);
    if (phase === 'roll') {
      c.pitch = 0;
      if (t.ias / KT >= vr) phase = 'rotate';
    } else if (phase === 'rotate') {
      // The nose to about 8°: the tail pipes clear the runway up to 10°.
      c.pitch = clamp(6 * (8 * DEG - t.pitch) - 1.5 * ac.state.angularVelocity.y, -0.3, 1);
      if (!t.onGround && (t.agl ?? 0) > 0.3) {
        phase = 'air';
        liftOff = horizontalDistance(f, start, ac.state.position);
        liftOffKias = t.ias / KT;
        return true;
      }
    }
    return false;
  });
  return { groundRoll: liftOff ?? NaN, liftOffKias, maxDeviation, crashed: t.crashed };
}

/**
 * Approach on speed: flaps FULL, gear down, at a landing mass, the angle of attack the FCS
 * holds with the trim centred (8.1°) and the thrust flown for a 3° glide path. Returns the
 * indicated airspeed it settles at.
 */
export function onSpeedApproach(mass: number) {
  const f = fa18Airborne(600, 145, { flaps: FLAPS.full, gearDown: true });
  const { ac } = f;
  setFuel(f, mass - ac.def.mass);
  ac.controls.pitchTrim = 0;
  const t = ac.telemetry;
  const pilot = new HornetPilot(f);
  const thrust = new Pid(0.25, 0.08, 0, 0.5);
  const thr0 = ac.controls.throttle[0]!;
  const path = -3 * DEG;
  const control = (dt: number) => {
    // Neutral stick holds the angle of attack; the throttles fly the glide path.
    ac.controls.pitch = 0;
    pilot.heading(0, dt);
    ac.controls.throttle.fill(clamp(thr0 + thrust.update(path - pilot.gamma, dt), 0, 0.75));
  };
  fly(f, 40, control);
  const kias: number[] = [];
  fly(f, 10, (dt) => {
    control(dt);
    kias.push(t.ias / KT);
  });
  return {
    kias: kias.reduce((a, b) => a + b, 0) / kias.length,
    alpha: t.alpha / DEG,
    gamma: pilot.gamma / DEG,
    mass: ac.mass,
    onSpeed: ac.telemetry.avionics?.fa18?.onSpeed,
  };
}

/**
 * Landing: an on-speed 3° approach at the landing mass to touchdown without flare (the
 * Hornet's field landing is flown like a carrier approach), idle, then full braking with
 * anti-skid. Ground roll from touchdown to a stop, m.
 */
export function landing(mass: number, withSpeedbrake = false) {
  const f = fa18Airborne(60, 145, { flaps: FLAPS.full, gearDown: true });
  const { ac } = f;
  setFuel(f, mass - ac.def.mass);
  ac.controls.pitchTrim = 0;
  const t = ac.telemetry;
  const pilot = new HornetPilot(f);
  const thrust = new Pid(0.25, 0.08, 0, 0.5);
  const thr0 = ac.controls.throttle[0]!;
  let phase: 'approach' | 'rollout' = 'approach';
  let touchdown: { x: number; y: number; z: number } | undefined;
  let stopped: { x: number; y: number; z: number } | undefined;
  let tdKias = 0;
  let tdSink = 0;
  let rollTime = 0;
  fly(f, 120, (dt) => {
    if (phase === 'approach') {
      ac.controls.pitch = 0;
      pilot.heading(0, dt);
      ac.controls.throttle.fill(clamp(thr0 + thrust.update(-3 * DEG - pilot.gamma, dt), 0, 0.75));
      if (t.onGround) {
        phase = 'rollout';
        touchdown = { ...ac.state.position };
        tdKias = t.ias / KT;
        tdSink = t.verticalSpeed;
      }
    } else {
      rollTime += dt;
      ac.controls.throttle.fill(0);
      ac.controls.pitch = rollTime < 1 ? 0 : -0.3;
      ac.controls.roll = 0;
      ac.controls.yaw = clamp(
        0.2 * headingError(0, t.headingDeg) - 0.5 * ac.state.angularVelocity.z,
        -1,
        1,
      );
      if (withSpeedbrake) ac.controls.speedbrake = 1;
      const brake = rollTime > 1 ? 1 : 0;
      ac.controls.brakeLeft = brake;
      ac.controls.brakeRight = brake;
      if (t.groundSpeed < 0.3) {
        stopped = { ...ac.state.position };
        return true;
      }
    }
    return false;
  });
  return {
    groundRoll: touchdown && stopped ? horizontalDistance(f, touchdown, stopped) : NaN,
    touchdownKias: tdKias,
    touchdownSink: tdSink,
    crashed: t.crashed,
  };
}

/**
 * Sustained turn: full afterburner at a Mach number and altitude, the load factor raised
 * until the Mach number and the altitude hold together (the turn rate at the sustained g).
 */
export function sustainedTurn(altitudeFt: number, mach: number, fuel?: number) {
  const h = altitudeFt * FT;
  const f = fa18Airborne(h, (mach * soundSpeed(h)) / KT);
  const { ac } = f;
  if (fuel !== undefined) setFuel(f, fuel);
  const t = ac.telemetry;
  const pilot = new HornetPilot(f);
  ac.controls.throttle.fill(1);
  let stick = 0;
  let throttle = 1;
  let n = fcs(f).gLimit;
  const rates: number[] = [];
  const gs: number[] = [];
  fly(f, 60, (dt) => {
    // As much g as the FCS allows; the throttles hold the Mach number while there is thrust
    // to spare (a g-limited turn), and with full thrust the g comes down until it holds.
    const e = (t.mach ?? 0) - mach;
    throttle = clamp(throttle - 4 * e * dt, 0.4, 1);
    if (throttle >= 1) n = clamp(n + 8 * e * dt, 1.5, fcs(f).gLimit);
    else n = Math.min(fcs(f).gLimit, n + 0.5 * dt);
    ac.controls.throttle.fill(throttle);
    stick = clamp(stick + 0.4 * (n - t.loadFactor) * dt, -0.2, 1);
    ac.controls.pitch = stick;
    const level = Math.acos(clamp(1 / Math.max(t.loadFactor, 1.05), -1, 1));
    pilot.bankTo(level + clamp(0.004 * (t.altitude - h) + 0.02 * t.verticalSpeed, -0.3, 0.3), dt);
    if (t.time > 40) {
      const nz = t.loadFactor;
      rates.push((G * Math.sqrt(Math.max(nz * nz - 1, 0))) / t.tas);
      gs.push(nz);
    }
  });
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1);
  return {
    rate: avg(rates) / DEG,
    g: avg(gs),
    mach: t.mach!,
    altitudeError: t.altitude - h,
    gLimited: throttle < 0.99,
    crashed: t.crashed,
  };
}

/** Instantaneous turn: a full-aft-stick pull at a speed, the largest turn rate (deg/s). */
export function instantaneousTurn(altitudeFt: number, kcas: number, fuel?: number) {
  const h = altitudeFt * FT;
  const rho = 1.225 * (1 - 2.2558e-5 * h) ** 4.2559;
  const f = fa18Airborne(h, kcas * Math.sqrt(1.225 / rho));
  const { ac } = f;
  if (fuel !== undefined) setFuel(f, fuel);
  const t = ac.telemetry;
  const pilot = new HornetPilot(f);
  ac.controls.throttle.fill(1);
  let best = 0;
  let peakG = 0;
  let v0 = 0;
  fly(f, 6, (dt) => {
    if (t.time < 1) {
      pilot.bankTo(80 * DEG, dt);
      ac.controls.pitch = stickForG(f, 0.5);
    } else {
      pilot.bankTo(80 * DEG, dt);
      ac.controls.pitch = 1;
      // Turn rate of the flight path from the load factor: g √(n² - 1) / V.
      if (v0 === 0) v0 = t.tas;
      // Only while the speed is still the corner speed (within 5 %).
      if (t.tas < 0.95 * v0) return;
      const n = t.loadFactor;
      best = Math.max(best, (G * Math.sqrt(Math.max(n * n - 1, 0))) / t.tas);
      peakG = Math.max(peakG, n);
    }
  });
  return { rate: best / DEG, peakG, crashed: t.crashed };
}

/**
 * Lowest steady level speed: idle-free, the thrust for level flight, slowed at 1 kt/s with
 * altitude held until the FCS's angle of attack limit stops it holding the altitude.
 */
export function minimumSpeed(flaps: number, gearDown: boolean) {
  const f = fa18Airborne(3000, flaps > 0 ? 150 : 200, { flaps, gearDown });
  const { ac } = f;
  const t = ac.telemetry;
  const pilot = new HornetPilot(f);
  const h = t.altitude;
  let target = t.ias / KT;
  const power = new Pid(0.05, 0.02, 0, 1);
  let min = Infinity;
  let lost = false;
  fly(f, 160, (dt) => {
    target -= dt;
    pilot.holdAltitude(h, dt);
    pilot.heading(0, dt);
    ac.controls.throttle.fill(clamp(0.3 + power.update(target - t.ias / KT, dt), 0, 1));
    if (h - t.altitude > 60) {
      lost = true;
      return true;
    }
    min = Math.min(min, t.ias / KT);
    return false;
  });
  return { kias: min, lost, alpha: t.alpha / DEG, crashed: t.crashed };
}

/** Level acceleration in full afterburner from one Mach number to another, s. */
export function acceleration(altitudeFt: number, from: number, to: number) {
  const h = altitudeFt * FT;
  const f = fa18Airborne(h, (from * soundSpeed(h)) / KT);
  const { ac } = f;
  const t = ac.telemetry;
  const pilot = new HornetPilot(f);
  ac.controls.throttle.fill(1);
  let time = NaN;
  fly(f, 400, (dt) => {
    pilot.holdAltitude(h, dt);
    pilot.heading(0, dt);
    if ((t.mach ?? 0) >= to) {
      time = t.time;
      return true;
    }
    return false;
  });
  return { seconds: time, crashed: t.crashed };
}

/** Cruise fuel flow (both engines, kg/s) in level flight at a Mach and altitude. */
export function cruise(altitudeFt: number, mach: number) {
  const h = altitudeFt * FT;
  const f = fa18Airborne(h, (mach * soundSpeed(h)) / KT);
  const { ac } = f;
  const t = ac.telemetry;
  const pilot = new HornetPilot(f);
  const power = new Pid(1.5, 0.3, 0, 1);
  const thr0 = ac.controls.throttle[0]!;
  fly(f, 60, (dt) => {
    pilot.holdAltitude(h, dt);
    pilot.heading(0, dt);
    ac.controls.throttle.fill(clamp(thr0 + power.update(mach - (t.mach ?? 0), dt), 0, 0.75));
  });
  const flow = t.engines.reduce((a, e) => a + e.fuelFlow, 0);
  return { fuelFlow: flow, ktas: t.tas / KT, mach: t.mach!, throttle: ac.controls.throttle[0]! };
}
