/**
 * Free-turbine turboprop in the manner of the PT6A: a gas generator (Ng) whose hot gas drives
 * a separate power turbine on the propeller shaft, and a propeller governor that holds the
 * propeller speed by changing the blade angle.
 *
 * The gas generator is described in corrected terms (speed over √θ, power over δ√θ, ITT
 * over θ, at the compressor face with the ram rise), which is what makes one map serve every
 * altitude and temperature. The power lever asks for a share of the rated (flat-rated) shaft
 * power; the fuel control runs Ng towards what gives it, but never past maximum Ng or the ITT
 * limit. Near the ground the torque limit is reached first; with altitude and on hot days the
 * ITT limit comes first and the available power falls: the flat rating.
 *
 * Start: the starter turns the gas generator only (the propeller stays feathered); the
 * condition lever introduces fuel, the igniters light it, the starter cuts out on its own and
 * the gas generator accelerates to idle. The blades are held by oil pressure from the engine:
 * below a gas generator speed (and with the condition lever at cut-off) they go to feather.
 * With the power lever over the gate on the ground, the lever sets the blade angle directly
 * (beta) down into reverse, and the power rises with it.
 */
import { clamp, inverseLookup, lookup, smoothstep } from '../math';
import type { EngineTelemetry } from '../types';
import type { VariablePitchPropellerData } from './propeller';
import type { PropellerMount } from './piston';
import {
  ramRatios,
  T0,
  P0,
  type Mounting,
  type Powerplant,
  type PowerplantInput,
  type Rotor,
} from './powerplant';

type Table = readonly (readonly [number, number])[];

export interface TurbopropData {
  /** Shaft power at the torque limit and the governed propeller speed (the flat rating), W. */
  ratedPower: number;
  /** Governed propeller speed, rpm. */
  propRpm: number;
  /** Gas generator speeds as a share of 100 % Ng: limit, ground idle, flight idle. */
  maxNg: number;
  groundIdleNg: number;
  flightIdleNg: number;
  /**
   * The gas generator map over corrected speed (Ng / √θ): corrected shaft power (W), corrected
   * ITT (K) and corrected fuel flow (kg/s). Rising tables.
   */
  power: Table;
  itt: Table;
  fuel: Table;
  /** ITT the fuel control does not let the engine pass in flight, K. */
  ittLimit: number;
  /** Gas generator response: time constants at idle and at high power (s), and the rate limits (per s). */
  spool: { idle: number; high: number; accel: number; decel: number };
  start: {
    /** Ng the starter alone reaches at full power, and how fast (time constant, s). */
    starterNg: number;
    starterTime: number;
    /** Lowest Ng at which fuel lights, and how long it takes after fuel and spark, s. */
    lightOffNg: number;
    lightOffDelay: number;
    /** The starter disengages by itself at this Ng. */
    cutoutNg: number;
    /** Acceleration of a lit gas generator below idle, per s (with the starter still helping). */
    accel: number;
    /** ITT reached just after light-off, K (the start's peak). */
    peakItt: number;
  };
  /** Inertia of propeller, power turbine and reduction gearbox at propeller speed, kg m². */
  inertia: number;
  /** Friction torque of the propeller shaft per rad/s. */
  friction: number;
  /** Governor: blade angle rate (rad/s) per unit speed error, and per unit of speed change rate. */
  governor: { gain: number; damping: number };
  /** Reverse: share of rated power at full reverse, and the propeller speed share it is held to. */
  reverse: { power: number; rpm: number };
  /** Share of inlet pressure lost with the inertial separator open. */
  separatorLoss: number;
  /** Below this Ng the oil pressure cannot hold the blades: they go to feather. */
  featherNg: number;
}

export interface TurbopropDef extends Mounting {
  kind: 'turboprop';
  engine: TurbopropData;
  propeller: VariablePitchPropellerData & PropellerMount;
}

const RPM = (2 * Math.PI) / 60;

export class TurbopropPowerplant implements Powerplant {
  readonly kind = 'turboprop';
  readonly telemetry: EngineTelemetry = {
    running: true,
    rpm: 0,
    power: 0,
    fuelFlow: 0,
    n2: 0,
    propRpm: 0,
    torque: 0,
    turbineTemperature: 15,
    reversing: false,
    starting: false,
  };
  thrust = 0;
  reactionTorque = 0;
  fuelFlow = 0;
  cranking = false;
  shortfall = 0;
  /** Gas generator speed, share of 100 %. */
  ng = 0;
  /** Propeller shaft speed, rad/s, and blade angle at 3/4 radius, rad. */
  omega = 0;
  beta: number;
  /** Inter-turbine temperature, K (NaN until the first step tells the ambient). */
  itt = NaN;
  lit = true;
  /** Power turbine torque on the propeller shaft, N m. */
  shaftTorque = 0;
  private latched = false;
  private lightTimer = 0;
  private omegaRate = 0;
  private readonly ram = { theta: 1, delta: 1 };
  private readonly designOmega: number;
  private readonly torqueLimit: number;

  constructor(readonly def: TurbopropDef) {
    this.designOmega = def.engine.propRpm * RPM;
    this.torqueLimit = def.engine.ratedPower / this.designOmega;
    this.beta = def.propeller.feather;
  }

  get data() {
    return this.def.engine;
  }
  get running() {
    return this.lit;
  }
  get angularMomentum() {
    return this.def.engine.inertia * this.omega;
  }
  get accessorySpeed() {
    return this.ng * 100;
  }
  get load() {
    return (this.shaftTorque * this.omega) / this.def.engine.ratedPower;
  }

  reset(running: boolean, inAir: boolean) {
    const d = this.def.engine;
    this.lit = running;
    this.latched = false;
    this.lightTimer = 0;
    this.omegaRate = 0;
    this.ng = running ? (inAir ? d.flightIdleNg : d.groundIdleNg) : 0;
    this.omega = running && inAir ? this.designOmega : 0;
    this.beta = running ? this.def.propeller.fine : this.def.propeller.feather;
    this.itt = NaN;
    this.shaftTorque = 0;
    this.thrust = 0;
    this.reactionTorque = 0;
    this.fuelFlow = 0;
    this.cranking = false;
    this.finish();
  }

  /** Corrected-parameter scaling at the compressor face. */
  private corrections(input: PowerplantInput) {
    ramRatios(input.mach, this.ram);
    const thetaT = (input.temperature / T0) * this.ram.theta;
    const separator = input.inertialSeparator ? 1 - this.def.engine.separatorLoss : 1;
    const deltaT = (input.pressure / P0) * this.ram.delta * input.inletRecovery * separator;
    return { thetaT, deltaT, sq: Math.sqrt(thetaT) };
  }

  private reverseActive(input: PowerplantInput) {
    return input.reverse && input.onGround;
  }

  private idleNg(input: PowerplantInput) {
    const d = this.def.engine;
    return (
      d.groundIdleNg +
      (d.flightIdleNg - d.groundIdleNg) * clamp((input.condition - 0.5) / 0.5, 0, 1)
    );
  }

  /** Where the fuel control runs the gas generator for these levers and this air. */
  private ngTarget(input: PowerplantInput, thetaT: number, deltaT: number, sq: number): number {
    const d = this.def.engine;
    const idle = this.idleNg(input);
    const reverse = this.reverseActive(input);
    const lever = clamp(input.throttle, 0, 1);
    const request = (reverse ? d.reverse.power : 1) * lever * d.ratedPower;
    const corr = deltaT * sq;
    let ng = Math.max(idle, inverseLookup(d.power, (request + input.bleed) / corr) * sq);
    // Topping: maximum Ng, and the Ng where the ITT reaches its limit in this air.
    const ittMax = inverseLookup(d.itt, d.ittLimit / thetaT) * sq;
    ng = Math.min(ng, d.maxNg, Math.max(ittMax, idle));
    // The fuel topping governor takes fuel away when the propeller runs too fast (in beta and
    // reverse the blade angle is the pilot's, so only the fuel can hold the speed).
    const limit = (reverse ? d.reverse.rpm : 1.04) * this.designOmega;
    if (this.omega > limit) ng -= (8 * (this.omega - limit)) / this.designOmega;
    return Math.max(ng, d.groundIdleNg * 0.9);
  }

  /** Power turbine torque at shaft speed omega for a gas power P: rises as the turbine slows. */
  private turbineTorque(power: number, omega: number) {
    const w = this.designOmega;
    return Math.max(0, (power / w) * (2 - omega / w));
  }

  private gasPower(input: PowerplantInput, deltaT: number, sq: number) {
    if (!this.lit) return 0;
    return Math.max(0, lookup(this.def.engine.power, this.ng / sq) * deltaT * sq - input.bleed);
  }

  step(dt: number, input: PowerplantInput, rotor: Rotor | undefined) {
    const d = this.def.engine;
    const { thetaT, deltaT, sq } = this.corrections(input);
    if (Number.isNaN(this.itt)) this.itt = input.temperature;
    const fuelOn = input.condition >= 0.25 && input.hasFuel && !input.failed;
    // ---- start sequence ----
    if (input.starter && input.starterPower > 0.05) this.latched = true;
    if (this.latched && (this.ng >= d.start.cutoutNg || input.starterPower <= 0.05))
      this.latched = false;
    this.cranking = this.latched;
    const sparks = input.ignition > 0 && (this.latched || input.continuousIgnition);
    if (!fuelOn) {
      this.lit = false;
      this.lightTimer = 0;
    } else if (!this.lit) {
      if (sparks && this.ng >= d.start.lightOffNg) {
        this.lightTimer += dt;
        if (this.lightTimer >= d.start.lightOffDelay) this.lit = true;
      } else this.lightTimer = 0;
    }
    // ---- gas generator ----
    const idle = this.idleNg(input);
    if (!this.lit) {
      const target = this.latched ? d.start.starterNg * input.starterPower : 0;
      const tau = this.latched ? d.start.starterTime : 6;
      this.ng += (target - this.ng) * (1 - Math.exp(-dt / tau));
    } else {
      const target = this.ngTarget(input, thetaT, deltaT, sq);
      if (this.ng < idle - 0.005 && target > this.ng) {
        // Light-off to idle: the burning gas and, until it cuts out, the starter.
        const rate = d.start.accel * (this.latched ? 1 : 0.6);
        this.ng = Math.min(this.ng + rate * dt, target);
      } else {
        const tau =
          d.spool.idle + (d.spool.high - d.spool.idle) * smoothstep(idle, d.maxNg, this.ng);
        const dn = (target - this.ng) * (1 - Math.exp(-dt / tau));
        this.ng += clamp(dn, -d.spool.decel * dt, d.spool.accel * dt);
      }
    }
    // ---- temperature ----
    let ittTarget = input.temperature;
    if (this.lit) {
      ittTarget = lookup(d.itt, this.ng / sq) * thetaT;
      if (this.ng < idle) {
        const idleItt = lookup(d.itt, idle / sq) * thetaT;
        const hump =
          d.start.peakItt -
          (d.start.peakItt - idleItt) * smoothstep(d.start.lightOffNg, idle, this.ng);
        ittTarget = Math.max(ittTarget, hump);
      }
    }
    const ittTau = ittTarget > this.itt ? 1.2 : 4;
    this.itt += (ittTarget - this.itt) * (1 - Math.exp(-dt / ittTau));
    // ---- propeller ----
    const power = this.gasPower(input, deltaT, sq);
    const torque = this.turbineTorque(power, this.omega);
    this.moveBlades(dt, input);
    const absorbed = rotor ? rotor.absorb(this.omega, this.beta, true) : 0;
    const friction = d.friction * this.omega;
    this.omegaRate = (torque - absorbed - friction) / d.inertia;
    this.omega = Math.max(0, this.omega + this.omegaRate * dt);
    this.shaftTorque = torque;
    this.fuelFlow = this.lit ? lookup(d.fuel, this.ng / sq) * deltaT * sq : 0;
    this.finish();
  }

  /** The governor, beta and feathering move the blades at their own rate. */
  private moveBlades(dt: number, input: PowerplantInput) {
    const p = this.def.propeller;
    const d = this.def.engine;
    let target: number;
    const oil = this.ng >= d.featherNg;
    if (input.condition < 0.25 || !oil) target = p.feather;
    else if (this.reverseActive(input)) {
      target = p.ground + (p.reverse - p.ground) * clamp(input.throttle, 0, 1);
    } else {
      // Constant speed: fine the blades when the propeller is slow, coarsen them when fast.
      const err = (this.omega - this.designOmega) / this.designOmega;
      const rate = d.governor.gain * err + (d.governor.damping * this.omegaRate) / this.designOmega;
      target = clamp(this.beta + clamp(rate, -p.pitchRate, p.pitchRate) * dt, p.fine, p.feather);
    }
    this.beta += clamp(target - this.beta, -p.pitchRate * dt, p.pitchRate * dt);
  }

  settle(input: PowerplantInput, rotor: Rotor | undefined) {
    const d = this.def.engine;
    const p = this.def.propeller;
    const { thetaT, deltaT, sq } = this.corrections(input);
    const fuelOn = input.condition >= 0.25 && input.hasFuel && !input.failed;
    this.latched = false;
    this.cranking = false;
    if (!fuelOn) this.lit = false;
    if (!this.lit) {
      this.ng = 0;
      this.beta = p.feather;
      this.omega = 0;
      this.itt = input.temperature;
      this.shaftTorque = 0;
      this.fuelFlow = 0;
      if (rotor) rotor.absorb(0, this.beta, true);
      this.finish();
      return;
    }
    // Twice: the topping governor's speed limit reads the shaft speed found the first time.
    for (let pass = 0; pass < 2; pass++) {
      this.ng = this.ngTarget(input, thetaT, deltaT, sq);
      const power = this.gasPower(input, deltaT, sq);
      const reverse = this.reverseActive(input);
      const balance = (omega: number, beta: number) =>
        this.turbineTorque(power, omega) -
        d.friction * omega -
        (rotor ? rotor.absorb(omega, beta, false) : 0);
      if (reverse || this.ng < d.featherNg) {
        this.beta = reverse
          ? p.ground + (p.reverse - p.ground) * clamp(input.throttle, 0, 1)
          : p.feather;
        this.omega = bisect((w) => balance(w, this.beta), 0, 1.3 * this.designOmega);
      } else if (balance(this.designOmega, p.fine) <= 0) {
        // Not enough power to reach the governed speed: on the fine pitch stop, slower.
        this.beta = p.fine;
        this.omega = bisect((w) => balance(w, p.fine), 0, this.designOmega);
      } else {
        this.omega = this.designOmega;
        // The torque a blade absorbs peaks where it stalls and falls again towards feather:
        // the governed angle is the first one, coming from fine, that takes all the power.
        this.beta = firstRoot(
          (b) => balance(this.designOmega, b),
          p.fine,
          p.feather,
          2 * (Math.PI / 180),
        );
      }
    }
    const power = this.gasPower(input, deltaT, sq);
    this.shaftTorque = this.turbineTorque(power, this.omega);
    if (rotor) rotor.absorb(this.omega, this.beta, true);
    this.itt = lookup(d.itt, this.ng / sq) * thetaT;
    this.fuelFlow = lookup(d.fuel, this.ng / sq) * deltaT * sq;
    this.omegaRate = 0;
    const asked = this.reverseActive(input) ? 0 : clamp(input.throttle, 0, 1);
    this.shortfall = Math.max(0, asked - (this.shaftTorque * this.omega) / d.ratedPower);
    this.finish();
  }

  private finish() {
    const t = this.telemetry;
    const p = this.def.propeller;
    // The reaction of the shaft torque on the airframe.
    this.reactionTorque = -this.shaftTorque;
    t.running = this.lit;
    t.rpm = this.omega / RPM;
    t.propRpm = t.rpm;
    t.n2 = this.ng * 100;
    t.torque = this.shaftTorque / this.torqueLimit;
    t.power = (this.shaftTorque * this.omega) / this.def.engine.ratedPower;
    t.fuelFlow = this.fuelFlow;
    t.turbineTemperature = (Number.isNaN(this.itt) ? T0 : this.itt) - 273.15;
    t.reversing = this.beta < p.fine - 0.01;
    t.starting = this.cranking;
  }

  stop() {
    this.lit = false;
    this.ng = 0;
    this.omega = 0;
    this.shaftTorque = 0;
    this.fuelFlow = 0;
    this.latched = false;
    this.cranking = false;
    this.finish();
  }
}

/** The first place over [lo, hi] where f, positive at lo, falls through zero (scan, then bisect). */
function firstRoot(f: (x: number) => number, lo: number, hi: number, step: number): number {
  let a = lo;
  while (a < hi) {
    const b = Math.min(hi, a + step);
    if (f(b) <= 0) return bisect(f, a, b);
    a = b;
  }
  return hi;
}

/** Root of a function that falls through zero over [lo, hi] (positive at lo). */
function bisect(f: (x: number) => number, lo: number, hi: number): number {
  if (f(hi) >= 0) return hi;
  if (f(lo) <= 0) return lo;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
