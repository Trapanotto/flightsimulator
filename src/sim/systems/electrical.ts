/**
 * Batteries, generators and the main and avionics buses. Loads are currents at bus voltage
 * (most consumers are regulated electronics or lamps that change little over the range
 * that matters); the bus voltage comes from the batteries' open-circuit voltages, their
 * internal resistances and what the generators can give at their drive speed. Closed form,
 * no iteration: this runs every step. A type lists its batteries and generators; with one of
 * each (the Cessna) it is the single battery and alternator of a light aircraft.
 */
import { clamp } from '../math';
import type { ElectricalData } from './data';

export interface GeneratorInput {
  /** Its switch is on. */
  on: boolean;
  failed: boolean;
  /** Drive speed (the engine's accessory speed). */
  speed: number;
}

export interface ElectricalInput {
  /**
   * The first battery's switch and the first generator, the common case of one of each; for
   * more, `batteries` and `generators` give each one.
   */
  battery: boolean;
  alternator: boolean;
  alternatorFailed: boolean;
  /** Drive speed of the first generator (engine rpm). */
  rpm: number;
  batteries?: readonly boolean[];
  generators?: readonly GeneratorInput[];
  /** Everything drawn from the main bus except the avionics bus, A. */
  mainLoad: number;
  avionicsSwitch: boolean;
}

export class Electrical {
  /** Charge of each battery, 0..1. */
  readonly charges: Float64Array;
  /** Current into each battery (positive charging), A, and what each generator gives, A. */
  readonly batteryAmps: Float64Array;
  readonly generatorAmps: Float64Array;
  /** Each generator is on line (switched on, working, turning fast enough). */
  readonly generatorOnline: Uint8Array;
  /** Main bus voltage and the total battery current (positive charging), A. */
  volts = 0;
  amps = 0;
  avionicsPowered = false;
  /** The main bus has enough voltage for its consumers (lights, flaps, turn coordinator). */
  busPowered = false;

  constructor(private readonly data: ElectricalData) {
    this.charges = new Float64Array(data.batteries.length).fill(1);
    this.batteryAmps = new Float64Array(data.batteries.length);
    this.generatorAmps = new Float64Array(data.generators.length);
    this.generatorOnline = new Uint8Array(data.generators.length);
  }

  /** Charge of the first battery, 0..1. */
  get charge() {
    return this.charges[0] ?? 0;
  }
  set charge(v: number) {
    this.charges[0] = v;
  }

  reset(charge: number) {
    this.charges.fill(charge);
    this.batteryAmps.fill(0);
    this.generatorAmps.fill(0);
    this.generatorOnline.fill(0);
    this.volts = 0;
    this.amps = 0;
    this.avionicsPowered = false;
    this.busPowered = false;
  }

  /** Open-circuit voltage: flat over most of the charge, collapsing when nearly empty. */
  openCircuitVolts(charge: number, battery = 0): number {
    const d = this.data.batteries[battery]!;
    if (charge >= 0.2) return d.lowVolts + ((d.fullVolts - d.lowVolts) * (charge - 0.2)) / 0.8;
    return d.lowVolts * (Math.max(charge, 0) / 0.2) ** 0.3;
  }

  /** Maximum current of a generator at a drive speed, A. */
  alternatorCapacity(speed: number, generator = 0): number {
    const d = this.data.generators[generator]!;
    return d.amps * clamp((speed - d.cutIn) / (d.full - d.cutIn), 0, 1);
  }

  private batteryOn(input: ElectricalInput, i: number) {
    return input.batteries ? input.batteries[i] === true : i === 0 && input.battery;
  }

  step(dt: number, input: ElectricalInput) {
    const d = this.data;
    const nb = d.batteries.length;
    let anyBattery = false;
    for (let i = 0; i < nb; i++) if (this.batteryOn(input, i)) anyBattery = true;
    if (!anyBattery) {
      // The generator fields are excited from the bus: with the batteries off nothing works.
      this.volts = 0;
      this.amps = 0;
      this.batteryAmps.fill(0);
      this.generatorAmps.fill(0);
      this.generatorOnline.fill(0);
      this.avionicsPowered = false;
      this.busPowered = false;
      return;
    }
    // The avionics load counts with last step's state: the bus decides the avionics, not the
    // other way round, and a one-step lag cannot be seen.
    const load = input.mainLoad + (this.avionicsPowered ? d.loads.avionics : 0);
    let alt = 0;
    let regulated = 0;
    for (let k = 0; k < d.generators.length; k++) {
      const g = input.generators?.[k];
      const on = g ? g.on && !g.failed : k === 0 && input.alternator && !input.alternatorFailed;
      const cap = on ? this.alternatorCapacity(g ? g.speed : input.rpm, k) : 0;
      this.generatorOnline[k] = cap > 0 ? 1 : 0;
      this.generatorAmps[k] = cap;
      alt += cap;
      if (cap > 0) regulated = Math.max(regulated, d.generators[k]!.volts);
    }
    if (regulated === 0) regulated = d.generators[0]?.volts ?? 28;
    // The consumers as a resistance that draws `load` at the regulated voltage: a sagging
    // bus draws less, and a flat battery gives nothing.
    const g = load / regulated;
    // A charging battery takes less current the fuller it is.
    let need = load;
    for (let i = 0; i < nb; i++) {
      if (!this.batteryOn(input, i)) continue;
      const voc = this.openCircuitVolts(this.charges[i]!, i);
      const rc = d.batteries[i]!.resistance + 1.5 * this.charges[i]! ** 6;
      need += Math.max(0, regulated - voc) / rc;
    }
    let volts: number;
    const regulating = alt > 0 && alt >= need;
    if (regulating) volts = regulated;
    else {
      // The generators, if any, give all they can; the batteries make up the difference or
      // take what is left over.
      let num = alt;
      let den = g;
      for (let i = 0; i < nb; i++) {
        if (!this.batteryOn(input, i)) continue;
        const voc = this.openCircuitVolts(this.charges[i]!, i);
        const r = d.batteries[i]!.resistance;
        const rb = alt > g * voc ? r + 1.5 * this.charges[i]! ** 6 : r;
        num += voc / rb;
        den += 1 / rb;
      }
      volts = num / den;
    }
    let amps = 0;
    for (let i = 0; i < nb; i++) {
      if (!this.batteryOn(input, i)) {
        this.batteryAmps[i] = 0;
        continue;
      }
      const voc = this.openCircuitVolts(this.charges[i]!, i);
      const r = d.batteries[i]!.resistance;
      const rc = r + 1.5 * this.charges[i]! ** 6;
      let a: number;
      if (regulating) a = (regulated - voc) / (regulated > voc ? rc : r);
      else a = (volts - voc) / (alt > g * voc ? rc : r);
      this.batteryAmps[i] = a;
      amps += a;
      this.charges[i] = clamp(
        this.charges[i]! + (a * dt) / (d.batteries[i]!.ampHours * 3600),
        0,
        1,
      );
    }
    // What the generators actually give: the load and the charging, shared by capacity.
    if (alt > 0) {
      const given = Math.max(0, Math.min(alt, volts * g + amps));
      for (let k = 0; k < d.generators.length; k++)
        this.generatorAmps[k] = (this.generatorAmps[k]! / alt) * given;
    }
    this.volts = volts;
    this.amps = amps;
    this.busPowered = volts >= d.busMinVolts;
    // A volt of hysteresis keeps the radios from flickering at the threshold.
    const avionicsMin = d.avionicsMinVolts + (this.avionicsPowered ? 0 : 1);
    this.avionicsPowered = input.avionicsSwitch && volts >= avionicsMin;
  }
}
