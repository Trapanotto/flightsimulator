/**
 * Structural icing: supercooled water in cloud or precipitation freezes on what it hits.
 * Worst from just below freezing to about -15 °C; colder, the cloud is mostly ice crystals
 * that do not stick.
 */
import { clamp } from '../math';

/** How hard it ices, 0..1, from the air temperature (°C) and the visible moisture (0..1). */
export function icingSeverity(temperatureC: number, moisture: number): number {
  if (moisture <= 0.05) return 0;
  const warm = clamp((0.5 - temperatureC) / 3, 0, 1);
  const cold = clamp((temperatureC + 25) / 10, 0, 1);
  return clamp(moisture, 0, 1) * warm * cold;
}

/** How fast ice melts or sublimates off in air above freezing, 1/s. */
export function meltRate(temperatureC: number): number {
  return temperatureC > 0.5 ? clamp(temperatureC / 5, 0.2, 1) / 600 : 0;
}

/** Ice on the airframe and in the pitot tube. */
export class Icing {
  /** Airframe ice, 0 clean .. 1 heavy. */
  airframe = 0;
  /** Ice in the pitot tube, 0..1; it blocks at 1 and clears below 0.6. */
  pitot = 0;
  pitotBlocked = false;
  /** Time into the de-icing boots' cycle, s. */
  private bootTimer = 0;

  reset() {
    this.bootTimer = 0;
    this.airframe = 0;
    this.pitot = 0;
    this.pitotBlocked = false;
  }

  /**
   * `speedShare`: true airspeed over a typical cruise (55 m/s): the faster, the more water
   * the airframe sweeps up. `pitotHeat`: switch on and the bus powered. `bootCycle`: period
   * of the pneumatic de-icing boots, s (0 off): each inflation cracks off most of the ice
   * that has built up on the leading edges since the last.
   */
  step(
    dt: number,
    severity: number,
    melt: number,
    speedShare: number,
    pitotHeat: boolean,
    pitotFailed: boolean,
    bootCycle = 0,
  ) {
    const catchRate = severity * clamp(speedShare, 0, 2);
    // Moderate icing loads a light aircraft heavily in a quarter of an hour.
    if (catchRate > 0 || this.airframe > 0)
      this.airframe = clamp(this.airframe + (catchRate / 900 - melt) * dt, 0, 1);
    if (bootCycle > 0) {
      this.bootTimer += dt;
      if (this.bootTimer >= bootCycle) {
        this.bootTimer = 0;
        // What stays is the residual ice between the boots and on the unprotected parts.
        this.airframe *= 0.2;
      }
    } else this.bootTimer = 0;
    // The pitot tube is small and sharp: it ices within a minute, the heater clears it in ten seconds.
    const pitotRate = pitotHeat ? -0.1 : catchRate / 45 - melt * 2;
    if (pitotRate > 0 || this.pitot > 0) this.pitot = clamp(this.pitot + pitotRate * dt, 0, 1);
    if (this.pitot >= 1) this.pitotBlocked = true;
    else if (this.pitot < 0.6) this.pitotBlocked = false;
    if (pitotFailed) this.pitotBlocked = true;
  }
}
