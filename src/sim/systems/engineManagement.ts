/**
 * What sits around the engine: magnetos, starter, priming, induction air, oil and exhaust
 * temperature. It decides the engine's `ignition`, `intake`, `fireable` and `starterPower`
 * before each evaluation and follows its temperatures after.
 */
import { clamp } from '../math';
import type { SystemsData } from './data';

type EngineData = SystemsData['engine'];

/** Magneto switch positions as in C172_CONTROLS. */
export const MAG_OFF = 0;
export const MAG_RIGHT = 1;
export const MAG_LEFT = 2;
export const MAG_BOTH = 3;
export const MAG_START = 4;

/** Oil this warm (°C) means a warm engine: it fires without priming. */
const WARM_ENGINE = 35;

export class EngineManagement {
  /** Fuel sprayed into the intake ports for a cold start, 0..1 (0.5 is enough). */
  prime = 0;
  /** °C, psi */
  oilTemperature = 15;
  oilPressure = 0;
  /** Exhaust gas temperature as a share of its peak. */
  egt = 0;
  /** Induction (impact) ice on the air filter, 0..1. */
  inductionIce = 0;

  constructor(private readonly data: EngineData) {}

  reset(running: boolean, ambientC: number, inAir: boolean) {
    this.prime = 0;
    this.inductionIce = 0;
    // A running start is a warmed-up engine: cruise oil in the air, after taxiing on the ground.
    this.oilTemperature = running ? (inAir ? 85 : 70) : ambientC;
    this.oilPressure = running ? (inAir ? 75 : 60) : 0;
    this.egt = running ? (inAir ? 0.85 : 0.7) : 0;
  }

  /**
   * Share of the combustion power the sparks give. One magneto lights one plug per cylinder:
   * the charge burns slower, a few per cent of power and the run-up's rpm drop. `time` is
   * simulated seconds, for the misfiring of a sick magneto.
   */
  ignition(position: number, leftFailed: boolean, time: number): number {
    const left =
      (position === MAG_LEFT || position === MAG_BOTH || position === MAG_START) && !leftFailed;
    // START grounds the right magneto (the left one has the impulse coupling).
    const right = position === MAG_RIGHT || position === MAG_BOTH;
    if (left && right) return 1;
    if (!left && !right) return 0;
    let factor = 1 - this.data.singleMagnetoLoss;
    if (leftFailed && position === MAG_BOTH) {
      // A failing magneto still fires now and then, out of time: rough running.
      factor *=
        1 -
        0.04 *
          (1 + Math.sin(time * 2 * Math.PI * 3.1)) *
          (0.6 + 0.4 * Math.sin(time * 2 * Math.PI * 0.7));
    }
    return factor;
  }

  /** Share of the manifold pressure the induction lets through. */
  intake(alternateAir: number): number {
    const a = clamp(alternateAir, 0, 1);
    if (a === 0 && this.inductionIce === 0) return 1;
    return (1 - this.data.alternateAirLoss * a) * (1 - 0.7 * this.inductionIce);
  }

  /** A warm engine fires on the starter; a cold one needs fuel in the intake ports first. */
  get fireable() {
    return this.oilTemperature > WARM_ENGINE || this.prime >= 0.5;
  }

  /**
   * Priming: with the fuel pump on and the mixture rich, fuel flows into the intake ports.
   * The engine-driven pump does a little of it while cranking. It drains away within a
   * minute or so, and the first firing uses it up.
   */
  stepPrime(
    dt: number,
    pump: boolean,
    mixture: number,
    fuel: boolean,
    cranking: boolean,
    running: boolean,
  ) {
    if (running) {
      // The first revolutions burn the primed fuel.
      this.prime = Math.max(0, this.prime - dt / 3);
      return;
    }
    let rate = -1 / 90;
    if (fuel && mixture > 0.5) {
      if (pump) rate = 0.15;
      else if (cranking) rate = 0.03;
    }
    this.prime = clamp(this.prime + rate * dt, 0, 1);
  }

  /**
   * Oil temperature heads for a balance of the engine's heat (power) and the cooling air
   * (airspeed and slipstream); pressure follows rpm, thicker when cold, capped by the relief
   * valve. EGT follows the mixture: peak at stoichiometric, lower rich or lean of it.
   */
  stepTemperatures(
    dt: number,
    input: {
      running: boolean;
      rpm: number;
      /** Brake power over rated power. */
      load: number;
      /** Speed of the cooling air, m/s (airspeed and slipstream). */
      coolingSpeed: number;
      ambientC: number;
      /** Equivalence ratio of the mixture burning. */
      phi: number;
    },
  ) {
    const d = this.data;
    const cooling = 0.55 + 0.45 * clamp(input.coolingSpeed / 50, 0, 1.4);
    const rise = input.running ? (35 + 60 * clamp(input.load, 0, 1.2)) / cooling : 0;
    const target = input.ambientC + rise;
    // Warming takes some minutes; a stopped engine cools much slower than it warms.
    const tau = input.running ? 240 : 900;
    this.oilTemperature += (target - this.oilTemperature) * (1 - Math.exp(-dt / tau));

    const viscosity = 1 + 0.5 * clamp((70 - this.oilTemperature) / 50, 0, 1);
    const rpmShare = Math.max(0, input.rpm) / 2400;
    const pressureTarget = Math.min(d.oilPressureMax, d.oilPressure * rpmShare ** 0.8 * viscosity);
    this.oilPressure += (pressureTarget - this.oilPressure) * (1 - Math.exp(-dt / 0.5));

    let egtTarget = 0;
    if (input.running) {
      const x = input.phi - 1;
      egtTarget = clamp(1 - 1.9 * x * x, 0, 1) * (0.85 + 0.15 * clamp(input.load, 0, 1));
    }
    this.egt += (egtTarget - this.egt) * (1 - Math.exp(-dt / (input.running ? 4 : 20)));
  }

  /**
   * Induction ice grows in icing conditions (`severity`, with the engine breathing `airflow`
   * as a share of full power), melts in warm air (`melt`, 1/s) and clears with alternate air,
   * which takes warm air from inside the cowling past the blocked filter.
   */
  stepInductionIce(
    dt: number,
    severity: number,
    melt: number,
    alternateAir: number,
    airflow: number,
  ) {
    if (this.inductionIce === 0 && severity === 0) return;
    let rate = (severity * airflow) / 240 - melt;
    if (alternateAir > 0.5) rate = -alternateAir / 30;
    this.inductionIce = clamp(this.inductionIce + rate * dt, 0, 1);
  }
}
