/**
 * Hydraulic systems: pressure from engine-driven pumps (while their engine's accessory drive
 * turns fast enough) or from an electric pump that runs on demand, as a light aircraft's gear
 * power pack does. What needs pressure (gear, flaps, powered flight controls) names its system.
 */
import type { HydraulicData } from './data';

export class Hydraulics {
  /** Pressure of each system, psi. */
  readonly pressure: Float64Array;
  /** Each system's electric pump runs this step (it draws current). */
  readonly pumping: Uint8Array;

  constructor(readonly systems: readonly HydraulicData[]) {
    this.pressure = new Float64Array(systems.length);
    this.pumping = new Uint8Array(systems.length);
  }

  index(id: string) {
    return this.systems.findIndex((s) => s.id === id);
  }

  /** Share of nominal pressure of a system, 0..1 (1 for an unknown id: nothing to lose). */
  share(id: string): number {
    const i = this.index(id);
    return i < 0 ? 1 : this.pressure[i]! / this.systems[i]!.pressure;
  }

  reset(running: boolean) {
    for (let i = 0; i < this.systems.length; i++) {
      const s = this.systems[i]!;
      this.pressure[i] = running && s.enginePumps?.length ? s.pressure : 0;
    }
    this.pumping.fill(0);
  }

  /**
   * `speeds`: accessory speed of each engine; `demand`: a system that something is waiting
   * on (its electric pump starts); `electric`: the bus can run a pump.
   */
  step(dt: number, speeds: ArrayLike<number>, demand: (id: string) => boolean, electric: boolean) {
    for (let i = 0; i < this.systems.length; i++) {
      const s = this.systems[i]!;
      let driven = false;
      for (const p of s.enginePumps ?? []) if ((speeds[p.engine] ?? 0) >= p.minSpeed) driven = true;
      const pump = s.electricPump !== undefined && electric && demand(s.id) && !driven;
      this.pumping[i] = pump ? 1 : 0;
      const target = driven || pump ? s.pressure : 0;
      // Pressure builds within a second; without a pump the accumulator bleeds down slower.
      const tau = target > this.pressure[i]! ? 0.5 : 20;
      this.pressure[i] =
        this.pressure[i]! + (target - this.pressure[i]!) * (1 - Math.exp(-dt / tau));
    }
  }
}
