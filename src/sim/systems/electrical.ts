/**
 * Battery, alternator and the main and avionics buses. Loads are currents at bus voltage
 * (most consumers are regulated electronics or lamps that change little over the range
 * that matters); the bus voltage comes from the battery's open-circuit voltage, its internal
 * resistance and what the alternator can give at the engine's rpm. Closed form, no iteration:
 * this runs every step.
 */
import { clamp } from '../math';
import type { SystemsData } from './data';

type ElectricalData = SystemsData['electrical'];

export interface ElectricalInput {
  /** Master switch, battery half and alternator half. */
  battery: boolean;
  alternator: boolean;
  alternatorFailed: boolean;
  /** Engine rpm (drives the alternator). */
  rpm: number;
  /** Everything drawn from the main bus except the avionics bus, A. */
  mainLoad: number;
  avionicsSwitch: boolean;
}

export class Electrical {
  /** Battery charge 0..1. */
  charge = 1;
  /** Main bus voltage and the battery current (positive charging), A. */
  volts = 0;
  amps = 0;
  avionicsPowered = false;
  /** The main bus has enough voltage for its consumers (lights, flaps, turn coordinator). */
  busPowered = false;

  constructor(private readonly data: ElectricalData) {}

  reset(charge: number) {
    this.charge = charge;
    this.volts = 0;
    this.amps = 0;
    this.avionicsPowered = false;
    this.busPowered = false;
  }

  /** Open-circuit voltage: flat over most of the charge, collapsing when nearly empty. */
  openCircuitVolts(charge: number): number {
    const d = this.data;
    if (charge >= 0.2)
      return d.batteryLowVolts + ((d.batteryFullVolts - d.batteryLowVolts) * (charge - 0.2)) / 0.8;
    return d.batteryLowVolts * (Math.max(charge, 0) / 0.2) ** 0.3;
  }

  /** Maximum alternator current at an engine rpm, A. */
  alternatorCapacity(rpm: number): number {
    const d = this.data;
    return (
      d.alternatorAmps *
      clamp((rpm - d.alternatorCutInRpm) / (d.alternatorFullRpm - d.alternatorCutInRpm), 0, 1)
    );
  }

  step(dt: number, input: ElectricalInput) {
    const d = this.data;
    if (!input.battery) {
      // The alternator field is excited from the bus: with the battery off nothing works.
      this.volts = 0;
      this.amps = 0;
      this.avionicsPowered = false;
      this.busPowered = false;
      return;
    }
    // The avionics load counts with last step's state: the bus decides the avionics, not the
    // other way round, and a one-step lag cannot be seen.
    const load = input.mainLoad + (this.avionicsPowered ? d.loads.avionics : 0);
    // The consumers as a resistance that draws `load` at the regulated voltage: a sagging
    // bus draws less, and a flat battery gives nothing.
    const g = load / d.alternatorVolts;
    const voc = this.openCircuitVolts(this.charge);
    const r = d.batteryResistance;
    // A charging battery takes less current the fuller it is.
    const rc = r + 1.5 * this.charge ** 6;
    const alt =
      input.alternator && !input.alternatorFailed ? this.alternatorCapacity(input.rpm) : 0;
    let volts: number;
    let amps: number;
    const regulated = d.alternatorVolts;
    if (alt > 0 && alt >= load + Math.max(0, regulated - voc) / rc) {
      volts = regulated;
      amps = (regulated - voc) / (regulated > voc ? rc : r);
    } else {
      // The alternator, if any, gives all it can; the battery makes up the difference or
      // takes what is left over.
      const rb = alt > g * voc ? rc : r;
      volts = (alt + voc / rb) / (1 / rb + g);
      amps = (volts - voc) / rb;
    }
    this.volts = volts;
    this.amps = amps;
    this.charge = clamp(this.charge + (amps * dt) / (d.batteryAmpHours * 3600), 0, 1);
    this.busPowered = volts >= d.busMinVolts;
    // A volt of hysteresis keeps the radios from flickering at the threshold.
    const avionicsMin = d.avionicsMinVolts + (this.avionicsPowered ? 0 : 1);
    this.avionicsPowered = input.avionicsSwitch && volts >= avionicsMin;
  }
}
