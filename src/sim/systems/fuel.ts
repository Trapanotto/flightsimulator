/**
 * Two wing tanks feeding the engine through the selector and the shutoff valve. The lines and
 * the injection system hold a little fuel, so a starved engine runs on for a few seconds.
 */
import type { SystemsData } from './data';

type FuelData = SystemsData['fuel'];

/** Selector positions as in C172_CONTROLS. */
export const FUEL_LEFT = 0;
export const FUEL_BOTH = 1;
export const FUEL_RIGHT = 2;

export class FuelSystem {
  /** Usable fuel per tank, kg. */
  left: number;
  right: number;
  private line: number;
  private supply = true;

  constructor(private readonly data: FuelData) {
    this.left = data.tankUsable;
    this.right = data.tankUsable;
    this.line = data.lineFuel;
  }

  reset(left: number, right: number) {
    this.left = Math.max(0, Math.min(left, this.data.tankUsable));
    this.right = Math.max(0, Math.min(right, this.data.tankUsable));
    this.line = this.data.lineFuel;
  }

  get total() {
    return this.left + this.right;
  }

  /** Fuel can flow from a selected, not empty tank through an open valve. */
  updateSupply(selector: number, shutoffOpen: boolean) {
    const fromLeft = selector !== FUEL_RIGHT && this.left > 0;
    const fromRight = selector !== FUEL_LEFT && this.right > 0;
    this.supply = shutoffOpen && (fromLeft || fromRight);
    return this.supply;
  }

  /** Fuel reaches the tank side of the engine (the selector and valve allow it). */
  get fuelAvailable() {
    return this.supply;
  }

  /** The engine still gets fuel: from the tanks, or what is left in the lines. */
  get engineHasFuel() {
    return this.supply || this.line > 0;
  }

  /** Takes `flow` kg/s for the engine and whatever the leak loses. */
  consume(dt: number, flow: number, selector: number, leak: boolean) {
    if (leak) this.left = Math.max(0, this.left - this.data.leakRate * dt);
    const burn = flow * dt;
    if (!this.supply) {
      this.line = Math.max(0, this.line - burn);
      return;
    }
    this.line = this.data.lineFuel;
    const useLeft = selector !== FUEL_RIGHT && this.left > 0;
    const useRight = selector !== FUEL_LEFT && this.right > 0;
    if (useLeft && useRight) {
      // BOTH draws evenly: the tanks stay level, the centre of gravity does not move.
      this.left = Math.max(0, this.left - burn / 2);
      this.right = Math.max(0, this.right - burn / 2);
    } else if (useLeft) this.left = Math.max(0, this.left - burn);
    else this.right = Math.max(0, this.right - burn);
  }
}
