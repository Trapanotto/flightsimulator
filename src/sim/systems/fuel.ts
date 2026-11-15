/**
 * Fuel tanks feeding the engines through a selector and a shutoff valve. The lines and the
 * fuel control hold a little fuel, so a starved engine runs on for a few seconds. A type
 * lists its tanks (or takes the usual two wing tanks), which positions of the selector feed
 * which tanks, and which tanks each engine may draw from.
 */
import type { FuelData, TankData } from './data';

/** Selector positions of the Cessna's LEFT / BOTH / RIGHT selector. */
export const FUEL_LEFT = 0;
export const FUEL_BOTH = 1;
export const FUEL_RIGHT = 2;

/** The tanks a fuel layout has: its own list, or two wing tanks. */
export function tanksOf(data: FuelData): TankData[] {
  return (
    data.tanks ?? [
      { id: 'left', usable: data.tankUsable, position: { x: 0, y: -data.tankArm, z: 0 } },
      { id: 'right', usable: data.tankUsable, position: { x: 0, y: data.tankArm, z: 0 } },
    ]
  );
}

export class FuelSystem {
  readonly tanks: TankData[];
  /** Usable fuel per tank, kg. */
  readonly amount: Float64Array;
  private readonly line: Float64Array;
  private readonly supply: Uint8Array;
  private readonly engineFeeds: number[][];
  private selector = -1;

  constructor(
    private readonly data: FuelData,
    engines = 1,
  ) {
    this.tanks = tanksOf(data);
    this.amount = new Float64Array(this.tanks.map((t) => t.usable));
    this.line = new Float64Array(engines).fill(data.lineFuel);
    this.supply = new Uint8Array(engines).fill(1);
    const all = this.tanks.map((_, i) => i);
    this.engineFeeds = Array.from({ length: engines }, (_, e) => data.engineFeeds?.[e] ?? all);
  }

  /** Usable fuel in the first two tanks (the wing tanks), kg. */
  get left() {
    return this.amount[0] ?? 0;
  }
  get right() {
    return this.amount[1] ?? 0;
  }

  /** Fills the first two tanks (left, right), clamped to their capacity. */
  reset(left: number, right: number) {
    const fill = this.tanks.map((t, i) => (i === 0 ? left : i === 1 ? right : t.usable));
    this.fill(fill);
  }

  /** Fuel in every tank, kg, clamped to each tank's capacity. */
  fill(amounts: readonly number[]) {
    for (let i = 0; i < this.tanks.length; i++)
      this.amount[i] = Math.max(
        0,
        Math.min(amounts[i] ?? this.tanks[i]!.usable, this.tanks[i]!.usable),
      );
    this.line.fill(this.data.lineFuel);
  }

  get total() {
    let s = 0;
    for (let i = 0; i < this.amount.length; i++) s += this.amount[i]!;
    return s;
  }

  /** The tank may feed engine `e` with the selector where it stands. */
  private feeds(tank: number, e: number) {
    const sel = this.data.selector;
    if (sel && this.selector >= 0) {
      const set = sel.feeds[this.selector];
      if (set && !set.includes(tank)) return false;
    }
    return this.engineFeeds[e]!.includes(tank);
  }

  /** Fuel can flow from a selected, not empty tank through an open valve (to every engine). */
  updateSupply(selector: number, shutoffOpen: boolean) {
    this.selector = selector;
    for (let e = 0; e < this.supply.length; e++) {
      let ok = false;
      for (let t = 0; t < this.tanks.length; t++)
        if (this.amount[t]! > 0 && this.feeds(t, e)) ok = true;
      this.supply[e] = shutoffOpen && ok ? 1 : 0;
    }
    return this.supply[0] === 1;
  }

  /** Fuel reaches the tank side of the first engine (the selector and valve allow it). */
  get fuelAvailable() {
    return this.supply[0] === 1;
  }

  /** The first engine still gets fuel: from the tanks, or what is left in the lines. */
  get engineHasFuel() {
    return this.hasFuel(0);
  }

  available(e: number) {
    return this.supply[e] === 1;
  }

  hasFuel(e: number) {
    return this.supply[e] === 1 || this.line[e]! > 0;
  }

  /**
   * Takes each engine's flow (kg/s; a number for a single engine) and whatever the leak
   * loses. An engine draws evenly from every tank that feeds it: the tanks stay level.
   */
  consume(dt: number, flow: number | ArrayLike<number>, selector: number, leak: boolean) {
    this.selector = selector;
    if (leak) this.amount[0] = Math.max(0, this.amount[0]! - this.data.leakRate * dt);
    const n = this.supply.length;
    for (let e = 0; e < n; e++) {
      const f = typeof flow === 'number' ? (e === 0 ? flow : 0) : (flow[e] ?? 0);
      const burn = f * dt;
      if (this.supply[e] !== 1) {
        this.line[e] = Math.max(0, this.line[e]! - burn);
        continue;
      }
      this.line[e] = this.data.lineFuel;
      let count = 0;
      for (let t = 0; t < this.tanks.length; t++)
        if (this.amount[t]! > 0 && this.feeds(t, e)) count++;
      if (count === 0) continue;
      for (let t = 0; t < this.tanks.length; t++)
        if (this.amount[t]! > 0 && this.feeds(t, e))
          this.amount[t] = Math.max(0, this.amount[t]! - burn / count);
    }
    this.balance(dt);
  }

  /** Automatic balancing: the pumps move fuel from the fuller wing tank to the other. */
  private balance(dt: number) {
    const b = this.data.balance;
    if (b === undefined || this.tanks.length < 2) return;
    const diff = this.amount[0]! - this.amount[1]!;
    if (Math.abs(diff) <= b) return;
    // About a kilogram a second, as a boost pump transferring through the collector.
    const move = Math.min(Math.abs(diff) / 2, 1 * dt) * Math.sign(diff);
    this.amount[0] = this.amount[0]! - move;
    this.amount[1] = this.amount[1]! + move;
  }

  /**
   * How far the fuel's weight has moved off the centre of gravity, per unit of g: Σ m r over
   * what is missing from each tank (the definition's centre of gravity has the tanks full,
   * so full or evenly drawn symmetric tanks give nothing).
   */
  imbalance(out: { x: number; y: number; z: number }) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let t = 0; t < this.tanks.length; t++) {
      const tank = this.tanks[t]!;
      const p = tank.position;
      const dm = this.amount[t]! - tank.usable;
      x += dm * p.x;
      y += dm * p.y;
      z += dm * p.z;
    }
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
  }
}
