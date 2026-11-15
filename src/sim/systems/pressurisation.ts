/**
 * Cabin pressurisation: bleed air from the engine fills the cabin, the outflow valve holds
 * the cabin at the selected altitude unless the structure's maximum differential pressure
 * would be passed, and the controller moves the cabin altitude at gentle rates. Without bleed
 * air (engine stopped, ECS off) or with the dump selected, the cabin leaks down to the
 * outside pressure.
 */
import type { PressurisationData } from './data';

const T0 = 288.15;
const P0 = 101_325;
const LAPSE = 0.0065;
const EXP = 5.25588;

/** ISA pressure at a pressure altitude (m) and back. */
export const pressureAt = (h: number) => P0 * (1 - (LAPSE * h) / T0) ** EXP;
export const altitudeAt = (p: number) => (T0 / LAPSE) * (1 - (p / P0) ** (1 / EXP));

export class Pressurisation {
  /** Cabin pressure, Pa. */
  cabinPressure = P0;

  constructor(readonly data: PressurisationData) {}

  get cabinAltitude() {
    return altitudeAt(this.cabinPressure);
  }

  reset(outside: number, pressurised: boolean, selectedFt: number) {
    this.cabinPressure = pressurised ? this.target(outside, selectedFt) : outside;
  }

  /** The cabin pressure the controller aims for. */
  private target(outside: number, selectedFt: number) {
    const selected = pressureAt(Math.max(0, selectedFt * 0.3048));
    // It never pressurises below the outside air, nor past the maximum differential.
    return Math.max(outside, Math.min(selected, outside + this.data.maxDifferential));
  }

  step(dt: number, outside: number, bleed: boolean, dump: boolean, selectedFt: number) {
    const d = this.data;
    if (!bleed || dump) {
      // Dumped, the outflow valve opens wide; without bleed air the cabin leaks slowly.
      const tau = dump ? 8 : 90;
      this.cabinPressure += (outside - this.cabinPressure) * (1 - Math.exp(-dt / tau));
      return;
    }
    const target = this.target(outside, selectedFt);
    const h = this.cabinAltitude;
    const goal = altitudeAt(target);
    const rate = goal > h ? d.climbRate : d.descentRate;
    const next = h + Math.max(-rate * dt, Math.min(rate * dt, goal - h));
    this.cabinPressure = pressureAt(next);
    // The safety valve opens at the maximum differential whatever the controller does.
    if (this.cabinPressure > outside + d.maxDifferential)
      this.cabinPressure = outside + d.maxDifferential;
  }
}
