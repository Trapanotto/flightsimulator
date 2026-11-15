/**
 * Jet engines: a two-spool turbofan (an airliner's) and an afterburning low-bypass turbofan
 * (a fighter's), one class with the afterburner as an option.
 *
 * The high-pressure spool (N2) is the state; the fan (N1) follows it through the engine's
 * steady working line, a little behind. The engine control turns the thrust lever into an N1
 * demand, so the lever sets thrust and the spool lag decides how quickly it comes: several
 * seconds from idle, as certification asks. Thrust at full power lapses with the total
 * pressure and, past the flat-rating temperature (Mattingly's throttle ratio), with the total
 * temperature; a high-bypass fan also loses thrust with Mach (J. D. Mattingly, Aircraft Engine
 * Design, 2nd ed., 2002, section 2.3.2). Fuel follows a thrust-specific consumption that
 * rises with Mach and √θ (same source, with the coefficients set to the engine's data).
 *
 * An afterburning engine has military power at `military` of the lever travel; the travel
 * above lights the afterburner, opens the nozzle and multiplies the fuel flow.
 */
import { clamp, lookup, smoothstep } from '../math';
import type { EngineTelemetry } from '../types';
import {
  ramRatios,
  P0,
  T0,
  type Mounting,
  type Powerplant,
  type PowerplantInput,
  type Rotor,
} from './powerplant';

type Table = readonly (readonly [number, number])[];

export interface TurbofanData {
  /** Sea-level static thrust at full dry power (take-off or military), N. */
  ratedThrust: number;
  /** Total temperature ratio up to which full thrust is held (the flat rating). */
  throttleRatio: number;
  /** Thrust lapse with total temperature beyond the flat rating, per unit of θ (3.5 to 3.8). */
  temperatureLapse: number;
  /** Thrust lapse with Mach at full power, F ∝ (1 - k √M) (0.49 for a high-bypass fan, 0 low bypass). */
  machLapse: number;
  /**
   * Thrust lost where the air at the engine face is thin and cold: below a Reynolds number
   * index RNI = δ / θ^1.2 (total conditions, 1 at sea level static) of `index`, the full-power
   * thrust falls in proportion to (1 - RNI / index), by `loss` at RNI 0. The blades' boundary
   * layers thicken at a low Reynolds number and the compressors lose flow and efficiency
   * (P. P. Walsh and P. Fletcher, Gas Turbine Performance, 2nd ed., 2004, section 7.4); the
   * fixed power and bleed taken off the engine also weigh more on its smaller thrust. The
   * pressure-ratio lapse above leaves both out, which is why it carries a fighter too high at
   * low speed (reconstructed against the published ceiling where no engine deck is in hand).
   */
  reynolds?: { index: number; loss: number };
  /** Fan speed at 100 %, rpm (for `rpm`), and the spools' speeds at full and idle power, per cent. */
  n1Rpm: number;
  n1Max: number;
  n1Idle: number;
  n2Max: number;
  n2Idle: number;
  /** Thrust share over fan speed share of maximum (corrected), a rising table through (1, 1). */
  thrust: Table;
  /** Thrust-specific fuel consumption (c0 + c1 M) √θ, kg/(N s), and idle fuel flow at sea level, kg/s. */
  tsfc: [number, number];
  idleFuel: number;
  /** Exhaust gas temperature (corrected, K) over N2 share of maximum. */
  egt: Table;
  /** Spool time constants (s) at idle and at high power, and the N2 rate limits (share per s). */
  spool: { idle: number; high: number; accel: number; decel: number };
  /** Reverser: travel time (s), reverse thrust as a share of the forward thrust, fan limit share. */
  reverser?: { time: number; share: number; n1: number };
  start: {
    /** N2 share the starter (bleed air) reaches, and its time constant, s. */
    starterN2: number;
    starterTime: number;
    /** Fuel and ignition at this N2 share; light-off delay, s; starter cut-out share. */
    lightOffN2: number;
    lightOffDelay: number;
    cutoutN2: number;
    /** N2 share per second from light-off to idle. */
    accel: number;
    /** EGT peak of the start, K. */
    peakEgt: number;
  };
  /** Angular momentum of the spools at full power, kg m²/s. */
  angularMomentum: number;
  /**
   * Phase 4: the engine control's thrust rating schedule, lever travel (0..1) to the share
   * of the fan range it asks for (an airliner's detents: idle, climb, maximum continuous,
   * take-off). Without it the lever asks for the fan range in proportion.
   */
  lever?: Table;
  afterburner?: {
    /** Lever share at military power; above it the afterburner. */
    military: number;
    /** Sea-level static thrust at full afterburner, N, and the TSFC (c0 + c1 M) √θ there. */
    thrust: number;
    tsfc: [number, number];
    /** Seconds from lighting to full afterburner. */
    lightTime: number;
    /** Nozzle opening (0..1) at idle, at military power and at full afterburner. */
    nozzle: [number, number, number];
  };
}

export interface TurbofanDef extends Mounting {
  kind: 'turbofan' | 'afterburning';
  engine: TurbofanData;
}

export class TurbofanPowerplant implements Powerplant {
  readonly kind: 'turbofan' | 'afterburning';
  readonly telemetry: EngineTelemetry = {
    running: true,
    rpm: 0,
    power: 0,
    fuelFlow: 0,
    n1: 0,
    n2: 0,
    turbineTemperature: 15,
    reversing: false,
    starting: false,
  };
  thrust = 0;
  readonly reactionTorque = 0;
  fuelFlow = 0;
  cranking = false;
  shortfall = 0;
  /** Spool speeds as shares of 100 %. */
  n1 = 0;
  n2 = 0;
  /** Exhaust gas temperature, K (NaN until the first step tells the ambient). */
  egt = NaN;
  lit = true;
  /** Reverser travel 0 stowed .. 1 deployed; afterburner 0..1; nozzle opening 0..1. */
  reverser = 0;
  afterburner = 0;
  nozzle = 0;
  private latched = false;
  private lightTimer = 0;
  private readonly ram = { theta: 1, delta: 1 };

  constructor(readonly def: TurbofanDef) {
    this.kind = def.kind;
    if (def.engine.afterburner) {
      this.telemetry.afterburner = 0;
      this.telemetry.nozzle = def.engine.afterburner.nozzle[0];
    }
  }

  get data() {
    return this.def.engine;
  }
  get running() {
    return this.lit;
  }
  get angularMomentum() {
    return (this.def.engine.angularMomentum * this.n2) / this.def.engine.n2Max;
  }
  get accessorySpeed() {
    return this.n2 * 100;
  }
  get load() {
    return this.thrust / this.def.engine.ratedThrust;
  }

  reset(running: boolean, inAir: boolean) {
    void inAir;
    const d = this.def.engine;
    this.lit = running;
    this.latched = false;
    this.lightTimer = 0;
    this.n2 = running ? d.n2Idle : 0;
    this.n1 = running ? d.n1Idle : 0;
    this.egt = NaN;
    this.reverser = 0;
    this.afterburner = 0;
    this.nozzle = d.afterburner?.nozzle[0] ?? 0;
    this.thrust = 0;
    this.fuelFlow = 0;
    this.cranking = false;
    this.finish();
  }

  private corrections(input: PowerplantInput) {
    ramRatios(input.mach, this.ram);
    const thetaT = (input.temperature / T0) * this.ram.theta;
    const deltaT = (input.pressure / P0) * this.ram.delta * input.inletRecovery;
    return { thetaT, deltaT, sq: Math.sqrt(thetaT) };
  }

  /** Fan share (corrected) the control asks for; dry lever travel 0..1. */
  private dryLever(input: PowerplantInput): number {
    const ab = this.def.engine.afterburner;
    const t = clamp(input.throttle, 0, 1);
    if (this.def.engine.lever) return lookup(this.def.engine.lever, t);
    return ab ? Math.min(1, t / ab.military) : t;
  }

  /** Full-power thrust lapse in this air (1 at sea level static). */
  private lapse(input: PowerplantInput, thetaT: number, deltaT: number, k: number) {
    const d = this.def.engine;
    let a = deltaT * (1 - d.machLapse * Math.sqrt(Math.max(0, input.mach)));
    if (thetaT > d.throttleRatio) a *= 1 - (k * (thetaT - d.throttleRatio)) / thetaT;
    const re = d.reynolds;
    if (re) {
      const index = deltaT / thetaT ** 1.2;
      if (index < re.index) a *= 1 - re.loss * (1 - index / re.index);
    }
    return Math.max(0, a);
  }

  /** N2 share in steady running for a fan share. */
  private n2For(n1: number) {
    const d = this.def.engine;
    const x = clamp((n1 - d.n1Idle) / (d.n1Max - d.n1Idle), -0.5, 1.2);
    // The high spool runs a flatter line than the fan: most of the fan's range in a third of N2's.
    return d.n2Idle + (d.n2Max - d.n2Idle) * (x >= 0 ? Math.sqrt(x) : x);
  }

  private n1For(n2: number) {
    const d = this.def.engine;
    const x = (n2 - d.n2Idle) / (d.n2Max - d.n2Idle);
    return d.n1Idle + (d.n1Max - d.n1Idle) * (x >= 0 ? x * x : x);
  }

  private n2Target(input: PowerplantInput, sq: number) {
    const d = this.def.engine;
    let lever = this.dryLever(input);
    const reverse = input.reverse && input.onGround && d.reverser;
    if (reverse) lever *= d.reverser!.n1;
    // The control holds a corrected fan speed: the physical one rises on a warm day.
    const n1 = (d.n1Idle + (d.n1Max - d.n1Idle) * lever) * Math.min(sq, 1.05);
    return clamp(this.n2For(n1), d.n2Idle, d.n2Max * 1.02);
  }

  step(dt: number, input: PowerplantInput, rotor: Rotor | undefined) {
    void rotor;
    const d = this.def.engine;
    const { thetaT, deltaT, sq } = this.corrections(input);
    if (Number.isNaN(this.egt)) this.egt = input.temperature;
    const fuelOn = input.condition >= 0.5 && input.hasFuel && !input.failed;
    if (input.starter && input.starterPower > 0.05) this.latched = true;
    if (this.latched && (this.n2 >= d.start.cutoutN2 || input.starterPower <= 0.05))
      this.latched = false;
    this.cranking = this.latched;
    const sparks = input.ignition > 0 && (this.latched || input.continuousIgnition);
    if (!fuelOn) {
      this.lit = false;
      this.lightTimer = 0;
    } else if (!this.lit) {
      // A windmilling core in flight relights on its own with the igniters on.
      if (sparks && this.n2 >= d.start.lightOffN2) {
        this.lightTimer += dt;
        if (this.lightTimer >= d.start.lightOffDelay) this.lit = true;
      } else this.lightTimer = 0;
    }
    // Windmilling: the ram air turns the spools of a dead engine.
    const windmill = 0.12 * clamp(input.mach / 0.8, 0, 1);
    if (!this.lit) {
      const target = Math.max(windmill, this.latched ? d.start.starterN2 * input.starterPower : 0);
      const tau = this.latched ? d.start.starterTime : 8;
      this.n2 += (target - this.n2) * (1 - Math.exp(-dt / tau));
    } else {
      const target = this.n2Target(input, sq);
      if (this.n2 < d.n2Idle - 0.005 && target > this.n2) {
        this.n2 = Math.min(target, this.n2 + d.start.accel * (this.latched ? 1 : 0.7) * dt);
      } else {
        const tau =
          d.spool.idle + (d.spool.high - d.spool.idle) * smoothstep(d.n2Idle, d.n2Max, this.n2);
        const dn = (target - this.n2) * (1 - Math.exp(-dt / tau));
        this.n2 += clamp(dn, -d.spool.decel * dt, d.spool.accel * dt);
      }
    }
    const n1Target = this.lit ? this.n1For(this.n2) : this.n2 * 1.2;
    this.n1 += (n1Target - this.n1) * (1 - Math.exp(-dt / 0.4));
    this.moveReverser(dt, input);
    this.moveAfterburner(dt, input);
    this.output(input, thetaT, deltaT, sq);
    let egtTarget = input.temperature;
    if (this.lit) {
      egtTarget = lookup(d.egt, this.n2 / d.n2Max / sq) * thetaT;
      if (this.n2 < d.n2Idle) {
        const idle = lookup(d.egt, d.n2Idle / d.n2Max / sq) * thetaT;
        const hump =
          d.start.peakEgt -
          (d.start.peakEgt - idle) * smoothstep(d.start.lightOffN2, d.n2Idle, this.n2);
        egtTarget = Math.max(egtTarget, hump);
      }
      egtTarget += 120 * this.afterburner;
    }
    this.egt += (egtTarget - this.egt) * (1 - Math.exp(-dt / (egtTarget > this.egt ? 1.5 : 5)));
    this.finish();
  }

  private moveReverser(dt: number, input: PowerplantInput) {
    const r = this.def.engine.reverser;
    if (!r) return;
    const want = input.reverse && input.onGround ? 1 : 0;
    this.reverser += clamp(want - this.reverser, -dt / r.time, dt / r.time);
  }

  private moveAfterburner(dt: number, input: PowerplantInput) {
    const ab = this.def.engine.afterburner;
    if (!ab) return;
    const d = this.def.engine;
    // The afterburner lights only with the core at military power.
    const want =
      this.lit && this.n2 > 0.97 * d.n2Max && input.throttle > ab.military
        ? (input.throttle - ab.military) / (1 - ab.military)
        : 0;
    if (want > this.afterburner)
      this.afterburner = Math.min(want, this.afterburner + dt / ab.lightTime);
    else this.afterburner = Math.max(want, this.afterburner - (2 * dt) / ab.lightTime);
    const dry = smoothstep(d.n2Idle, d.n2Max, this.n2);
    const [idle, mil, max] = ab.nozzle;
    this.nozzle =
      this.afterburner > 0 ? mil + (max - mil) * this.afterburner : idle + (mil - idle) * dry;
  }

  /** Thrust and fuel flow for the spools as they are. */
  private output(input: PowerplantInput, thetaT: number, deltaT: number, sq: number) {
    const d = this.def.engine;
    const ab = d.afterburner;
    const theta = input.temperature / T0;
    const m = Math.max(0, input.mach);
    if (!this.lit) {
      // A windmilling engine is a drag: the ram drag of the air it lets through.
      this.thrust = -0.02 * d.ratedThrust * (input.pressure / P0) * m * m;
      this.fuelFlow = 0;
      return;
    }
    const share = lookup(d.thrust, this.n1 / sq / d.n1Max);
    const dryMax = d.ratedThrust * this.lapse(input, thetaT, deltaT, d.temperatureLapse);
    let dry = dryMax * share;
    const tsfcDry = (d.tsfc[0] + d.tsfc[1] * m) * Math.sqrt(theta);
    let fuel = tsfcDry * Math.max(0, dry) + d.idleFuel * deltaT * sq * (1 - clamp(share, 0, 1));
    if (ab && this.afterburner > 0) {
      const wet = ab.thrust * this.lapse(input, thetaT, deltaT, 3.5);
      const tsfcWet = (ab.tsfc[0] + ab.tsfc[1] * m) * Math.sqrt(theta);
      const extra = (wet - dryMax) * this.afterburner;
      dry += extra;
      // The afterburner burns at its own, much higher consumption: at full the whole thrust does.
      fuel =
        tsfcDry * dryMax * (1 - this.afterburner) + tsfcWet * (dryMax + extra) * this.afterburner;
    }
    const r = d.reverser;
    // Deployed, the cascades turn the fan's air forward; half-way, they spoil most of it.
    this.thrust = r ? dry * (1 - this.reverser) - dry * r.share * this.reverser : dry;
    this.fuelFlow = fuel;
  }

  settle(input: PowerplantInput, rotor: Rotor | undefined) {
    void rotor;
    const d = this.def.engine;
    const { thetaT, deltaT, sq } = this.corrections(input);
    this.latched = false;
    this.cranking = false;
    if (input.condition < 0.5 || !input.hasFuel || input.failed) this.lit = false;
    this.reverser = 0;
    if (this.lit) {
      this.n2 = this.n2Target(input, sq);
      this.n1 = this.n1For(this.n2);
      const ab = d.afterburner;
      this.afterburner =
        ab && input.throttle > ab.military ? (input.throttle - ab.military) / (1 - ab.military) : 0;
      this.egt = lookup(d.egt, this.n2 / d.n2Max / sq) * thetaT + 120 * this.afterburner;
      if (ab) {
        const dry = smoothstep(d.n2Idle, d.n2Max, this.n2);
        const [idle, mil, max] = ab.nozzle;
        this.nozzle =
          this.afterburner > 0 ? mil + (max - mil) * this.afterburner : idle + (mil - idle) * dry;
      }
    } else {
      this.n2 = 0.12 * clamp(input.mach / 0.8, 0, 1);
      this.n1 = this.n2 * 1.2;
      this.egt = input.temperature;
      this.afterburner = 0;
    }
    this.output(input, thetaT, deltaT, sq);
    const asked = this.lit ? this.dryLever(input) : 0;
    // The control holds a corrected fan speed: compare corrected with corrected, or a cold
    // high altitude (θ below 1) looks like a shortfall that is not there.
    const got = (this.n1For(this.n2) / Math.min(sq, 1.05) - d.n1Idle) / (d.n1Max - d.n1Idle);
    this.shortfall = Math.max(0, asked - got);
    this.finish();
  }

  private finish() {
    const t = this.telemetry;
    const d = this.def.engine;
    t.running = this.lit;
    t.n1 = this.n1 * 100;
    t.n2 = this.n2 * 100;
    t.rpm = this.n1 * d.n1Rpm;
    t.power = this.thrust / d.ratedThrust;
    t.fuelFlow = this.fuelFlow;
    t.turbineTemperature = (Number.isNaN(this.egt) ? T0 : this.egt) - 273.15;
    t.reversing = this.reverser > 0.05;
    t.starting = this.cranking;
    if (d.afterburner) {
      t.afterburner = this.afterburner;
      t.nozzle = this.nozzle;
    }
  }

  stop() {
    this.lit = false;
    this.n1 = 0;
    this.n2 = 0;
    this.thrust = 0;
    this.fuelFlow = 0;
    this.afterburner = 0;
    this.latched = false;
    this.cranking = false;
    this.finish();
  }
}
