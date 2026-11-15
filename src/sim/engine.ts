/**
 * Normally aspirated, fuel-injected piston engine driving a fixed-pitch propeller
 * (propulsion/piston.ts puts it on the airframe).
 *
 * The engine makes torque from the air it breathes (manifold pressure, temperature, rpm) and
 * the mixture; the propeller absorbs torque by advance ratio. The rpm is whatever balances the
 * two on the common shaft, so it follows throttle, airspeed and density by itself: about 2300
 * rpm at full throttle standing still, 2700 only once the aircraft is fast.
 */
import { lookup } from './math';

export interface PistonEngineData {
  /** Brake power at sea level, full throttle, full rich, rated rpm, W. */
  ratedPower: number;
  ratedRpm: number;
  /** Swept volume, m^3. */
  displacement: number;
  volumetricEfficiency: number;
  /** Manifold pressure as a fraction of ambient at closed throttle (idle stop). */
  idleManifold: number;
  /** Friction and pumping torque: constant part (N m) and part per rad/s. */
  frictionTorque: number;
  frictionPerRadS: number;
  /** Pumping loss at closed throttle, N m: the pistons pull against the vacuum. */
  pumpingTorque: number;
  /** Rotating inertia of propeller, crankshaft and accessories, kg m^2. */
  inertia: number;
  /** Equivalence ratio at full rich mixture in sea-level air. */
  fullRichRatio: number;
  /** Torque of the starter motor, N m, and the rpm it can turn the engine at. */
  starterTorque: number;
  starterRpm: number;
}

/** Power relative to the best-power mixture, over equivalence ratio. */
const MIXTURE_POWER: readonly (readonly [number, number])[] = [
  [0.5, 0],
  [0.62, 0.45],
  [0.8, 0.82],
  [0.95, 0.96],
  [1.1, 1.0],
  [1.2, 1.0],
  [1.35, 0.97],
  [1.6, 0.86],
  [1.9, 0.55],
  [2.2, 0],
];

const STOICHIOMETRIC_AIR_FUEL = 14.7;
const R_AIR = 287.053;
const SEA_LEVEL_PRESSURE = 101_325;
const SEA_LEVEL_TEMPERATURE = 288.15;
const SEA_LEVEL_DENSITY = 1.225;

export interface EngineOutput {
  /** Shaft torque after friction, N m (negative: the engine drags). */
  torque: number;
  /** Brake power, W. */
  power: number;
  /** kg/s */
  fuelFlow: number;
  manifoldPressure: number;
  running: boolean;
}

export class PistonEngine {
  running = true;
  /** Shaft speed, rad/s. */
  omega = 0;
  /**
   * Set by the systems before each evaluation; the defaults are a healthy engine on both
   * magnetos with clean induction air, so the engine alone behaves as without systems.
   * `ignition`: share of combustion power the sparks give (1 both, a little less on one
   * magneto, 0 with no spark). `intake`: share of the manifold pressure the induction lets
   * through (alternate air, induction ice). `fireable`: a cold engine fires only once primed.
   * `failed`: no power whatever the controls.
   */
  ignition = 1;
  intake = 1;
  fireable = true;
  failed = false;
  /** Share of the starter's torque the battery can drive, 0..1. */
  starterPower = 1;
  private readonly torqueScale: number;

  constructor(readonly data: PistonEngineData) {
    // Calibrate the indicated torque per kg of air so the rated point gives the rated power.
    const omega = (data.ratedRpm * 2 * Math.PI) / 60;
    const friction = data.frictionTorque + data.frictionPerRadS * omega;
    const air = this.airflow(SEA_LEVEL_PRESSURE * 0.98, SEA_LEVEL_TEMPERATURE, data.ratedRpm);
    const indicated = data.ratedPower / omega + friction;
    this.torqueScale = indicated / ((air / omega) * lookup(MIXTURE_POWER, data.fullRichRatio));
  }

  get rpm() {
    return (this.omega * 60) / (2 * Math.PI);
  }

  private airflow(manifold: number, temperature: number, rpm: number) {
    const density = manifold / (R_AIR * temperature);
    return density * this.data.displacement * (rpm / 120) * this.data.volumetricEfficiency;
  }

  /** Equivalence ratio for a mixture lever position in air of the given density. */
  equivalenceRatio(mixture: number, density: number): number {
    // Injection meters fuel by rpm and throttle, not by air density, so the same lever runs
    // richer as the air thins: full rich is over-rich at altitude until the pilot leans.
    return mixture * this.data.fullRichRatio * Math.sqrt(SEA_LEVEL_DENSITY / density);
  }

  /**
   * Torque on the shaft for the given lever positions and air. Also decides whether the engine
   * runs: idle cut-off, no fuel, a hopelessly wrong mixture or too few rpm stop it, and it
   * catches again once it turns fast enough (starter or windmilling) with a usable mixture.
   */
  evaluate(
    throttle: number,
    mixture: number,
    starter: boolean,
    pressure: number,
    temperature: number,
    density: number,
    hasFuel: boolean,
    out: EngineOutput,
  ): EngineOutput {
    const d = this.data;
    const rpm = this.rpm;
    const phi = this.equivalenceRatio(mixture, density);
    const mixturePower = mixture < 0.03 ? 0 : lookup(MIXTURE_POWER, phi);
    const canFire = hasFuel && mixturePower > 0.05 && this.ignition > 0 && !this.failed;
    if (!canFire) this.running = false;
    // Cranking at starter speed is enough to fire; windmilling needs more to fire unaided.
    else if (!this.running && rpm > (starter ? 150 : 350) && this.fireable) this.running = true;
    // While the starter still helps, a just-fired engine is given the time to run up.
    else if (this.running && rpm < (starter ? 100 : 250)) this.running = false;

    const t = Math.min(1, Math.max(0, throttle));
    const manifold = pressure * 0.98 * (d.idleManifold + (1 - d.idleManifold) * t) * this.intake;
    const absOmega = Math.abs(this.omega);
    let friction = d.frictionTorque + d.frictionPerRadS * absOmega;
    // Friction opposes rotation and fades to zero at standstill, so it never turns the shaft.
    // A running engine's friction fades near standstill so it never turns the shaft back; a
    // stopped one holds the propeller against a light windmilling torque.
    friction *= (this.running ? Math.min(1, absOmega / 5) : 1) * Math.sign(this.omega || 1);
    let torque = -friction;
    // Pumping against a closed throttle: what makes idle a near-zero-thrust setting.
    if (this.running)
      torque -= d.pumpingTorque * (1 - manifold / pressure) * Math.min(1, absOmega / 5);
    let fuelFlow = 0;
    if (this.running) {
      const air = this.airflow(manifold, temperature, Math.max(rpm, 0));
      torque += (this.torqueScale * air * mixturePower * this.ignition) / Math.max(this.omega, 1);
      fuelFlow = (air * phi) / STOICHIOMETRIC_AIR_FUEL;
    }
    if (starter && rpm < d.starterRpm) torque += d.starterTorque * this.starterPower;
    out.torque = torque;
    out.power = torque * this.omega;
    out.fuelFlow = fuelFlow;
    out.manifoldPressure = manifold;
    out.running = this.running;
    return out;
  }
}

/** The propeller moved to propulsion/propeller.ts; these names stay for existing callers. */
export {
  propellerForces,
  type FixedPitchPropellerData as PropellerData,
  type PropellerOutput,
} from './propulsion/propeller';
