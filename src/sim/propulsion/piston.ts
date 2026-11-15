/**
 * The piston engine as a powerplant: the Lycoming model of engine.ts on a fixed-pitch
 * propeller. The rpm is whatever balances engine and propeller torque on the common shaft.
 */
import { PistonEngine, type EngineOutput, type PistonEngineData } from '../engine';
import type { EngineTelemetry } from '../types';
import type { FixedPitchPropellerData } from './propeller';
import type { Mounting, Powerplant, PowerplantInput, Rotor } from './powerplant';

export interface PistonDef extends Mounting {
  kind: 'piston';
  engine: PistonEngineData;
  propeller: FixedPitchPropellerData & PropellerMount;
}

/** How a propeller's slipstream reaches the airframe. */
export interface PropellerMount {
  /** Swirl recovered by the fuselage and fin is less than the free-stream value. */
  swirlFactor: number;
  /** +1 turns clockwise seen from behind (the usual), -1 counter-clockwise. */
  rotation?: 1 | -1;
}

export class PistonPowerplant implements Powerplant {
  readonly kind = 'piston';
  readonly engine: PistonEngine;
  readonly telemetry: EngineTelemetry = { running: true, rpm: 0, power: 0, fuelFlow: 0 };
  thrust = 0;
  reactionTorque = 0;
  fuelFlow = 0;
  /** Brake power, W (never negative). */
  power = 0;
  cranking = false;
  private readonly out: EngineOutput = {
    torque: 0,
    power: 0,
    fuelFlow: 0,
    manifoldPressure: 0,
    running: true,
  };

  constructor(readonly def: PistonDef) {
    this.engine = new PistonEngine(def.engine);
  }

  get running() {
    return this.engine.running;
  }
  get angularMomentum() {
    return this.def.engine.inertia * this.engine.omega;
  }
  get accessorySpeed() {
    return this.engine.rpm;
  }
  get load() {
    return this.power / this.def.engine.ratedPower;
  }

  reset(running: boolean, inAir: boolean) {
    void inAir;
    this.engine.running = running;
    this.engine.omega = 0;
    this.thrust = 0;
    this.reactionTorque = 0;
    this.fuelFlow = 0;
    this.power = 0;
    this.cranking = false;
    this.sync();
  }

  /** Ground idle: the propeller turning at the idle stop's speed. */
  idle(running: boolean) {
    this.engine.omega = running ? 650 * ((2 * Math.PI) / 60) : 0;
    this.sync();
  }

  private sync() {
    const t = this.telemetry;
    t.running = this.engine.running;
    t.rpm = this.engine.rpm;
    t.power = this.power / this.def.engine.ratedPower;
    t.fuelFlow = this.engine.running ? this.fuelFlow : 0;
  }

  private evaluate(input: PowerplantInput, starter: boolean): EngineOutput {
    const e = this.engine;
    e.ignition = input.ignition;
    e.intake = input.intake;
    e.fireable = input.fireable;
    e.failed = input.failed;
    e.starterPower = input.starterPower;
    return e.evaluate(
      input.throttle,
      input.mixture,
      starter,
      input.pressure,
      input.temperature,
      input.density,
      input.hasFuel,
      this.out,
    );
  }

  step(dt: number, input: PowerplantInput, rotor: Rotor | undefined) {
    this.cranking = input.starter;
    const e = this.evaluate(input, input.starter);
    const absorbed = rotor ? rotor.absorb(this.engine.omega, 0, true) : 0;
    this.engine.omega += ((e.torque - absorbed) / this.def.engine.inertia) * dt;
    // A fixed-pitch propeller on a piston engine never turns backwards.
    if (this.engine.omega < 0) this.engine.omega = 0;
    this.finish(e);
  }

  settle(input: PowerplantInput, rotor: Rotor | undefined) {
    // Shaft speed where engine and propeller torque balance (bisection).
    let lo = 0;
    let hi = 420;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      this.engine.omega = mid;
      this.engine.running = true;
      const e = this.evaluate(input, false);
      const prop = rotor ? rotor.absorb(mid, 0, false) : 0;
      if (e.torque - prop > 0) lo = mid;
      else hi = mid;
    }
    this.engine.omega = (lo + hi) / 2;
    const e = this.evaluate(input, false);
    if (rotor) rotor.absorb(this.engine.omega, 0, true);
    this.finish(e);
  }

  private finish(e: EngineOutput) {
    this.fuelFlow = e.fuelFlow;
    this.power = Math.max(0, e.power);
    // Reaction of the engine torque on the airframe rolls it against the propeller.
    this.reactionTorque = -e.torque;
    this.sync();
  }

  stop() {
    this.engine.omega = 0;
    this.engine.running = false;
    this.telemetry.running = false;
    this.telemetry.rpm = 0;
    this.telemetry.fuelFlow = 0;
  }
}
