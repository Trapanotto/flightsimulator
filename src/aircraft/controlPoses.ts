/**
 * How each cockpit control looks for its value: rocker tilt, knob turn, lever travel,
 * selector angle. Plain TypeScript, no renderer: tested in Node. The model supplies the axes
 * and travel vectors (extras of the Ctl_ nodes); this file supplies the amounts.
 *
 * Rotations are degrees, positive = clockwise as the pilot looks at the control (the loader
 * turns about the axis that points out of the panel by the negative angle). Slides are a
 * share 0..1 of the node's extras.slide.
 */
import type { ControlSpec } from '@sim';

/** A rocker tilts this far either side of its pivot (degrees). */
export const ROCKER_DEG = 12;
/** Ignition key positions OFF, R, L, BOTH, START, clockwise. */
export const MAGNETO_DEG = [-75, -45, -15, 15, 50] as const;
/** Transponder mode selector OFF, SBY, ON, ALT. */
export const XPDR_MODE_DEG = [-60, -20, 20, 60] as const;
/** Fuel selector LEFT, BOTH, RIGHT: turns about the vertical, positive towards the left. */
export const FUEL_SELECTOR_DEG = [75, 0, -75] as const;
/** DME source toggle NAV 1 (left), NAV 2 (right): turns about the panel's up axis. */
export const DME_SOURCE_DEG = [-25, 25] as const;
/** Panel light rheostat: 0 at -135 degrees, full at +135. */
export const DIMMER_SWEEP_DEG = 270;
/** Trim wheel: radians per unit of trim (the existing model's gearing). */
export const TRIM_WHEEL_RAD = 3;
/** Transponder code knobs: eight detents per turn. */
export const XPDR_DIGIT_DEG = 45;

/** Rotation of a rocker about its hinge, radians: ON presses the top in. */
export function rockerAngle(value: number): number {
  return ((value >= 0.5 ? 1 : -1) * ROCKER_DEG * Math.PI) / 180;
}

/** Degrees of a selector for an index (clamped to the table). */
export function selectorDeg(table: readonly number[], index: number): number {
  const i = Math.min(Math.max(Math.round(index), 0), table.length - 1);
  return table[i]!;
}

/**
 * How far a sliding control is out of its rest position, as a share of its travel
 * (extras.slide). The model's travel points out of the panel (push-pull knobs, the brake
 * handle), down the slot (flap lever) or into the panel (buttons).
 */
export function slideShare(id: string, value: number, spec?: ControlSpec): number {
  switch (id) {
    // Pushed in = open throttle, rich mixture, fuel valve open.
    case 'throttle':
    case 'mixture':
    case 'fuelShutoff':
      return 1 - clamp01(value);
    // Pulled out = alternate air on, brake set.
    case 'carbHeat':
    case 'parkingBrake':
      return clamp01(value);
    case 'flaps': {
      const last = (spec?.positions?.length ?? 4) - 1;
      return clamp01(value / last);
    }
    default:
      // Buttons: pressed in while held.
      return clamp01(value);
  }
}

export function dimmerDeg(value: number): number {
  return -DIMMER_SWEEP_DEG / 2 + clamp01(value) * DIMMER_SWEEP_DEG;
}

/** Transponder code as its four digits, most significant first (each 0..7). */
export function xpdrDigits(code: number): [number, number, number, number] {
  const c = Math.max(0, Math.round(code));
  return [Math.floor(c / 1000) % 10, Math.floor(c / 100) % 10, Math.floor(c / 10) % 10, c % 10].map(
    (d) => Math.min(d, 7),
  ) as [number, number, number, number];
}

/**
 * A knob with detents shows where it was turned, not the number it sets: it turns by the
 * steps the value changed. A big jump (a frequency swap, a reset) is not a turn of the knob,
 * so it is ignored.
 */
export class KnobTurn {
  private prev: number | undefined;
  /** Degrees the knob has been turned (clockwise positive). */
  target = 0;

  constructor(
    private readonly degPerStep: number,
    /** Most steps a single change can be and still count as turning. */
    private readonly maxSteps = 45,
  ) {}

  /** Feeds the current value; returns the knob's angle in degrees. */
  update(spec: ControlSpec, value: number): number {
    if (this.prev !== undefined) {
      const steps = stepsBetween(spec, this.prev, value);
      if (Math.abs(steps) <= this.maxSteps) this.target += steps * this.degPerStep;
    }
    this.prev = value;
    return this.target;
  }
}

/** Signed steps from one value to another; the short way round for a knob that wraps. */
export function stepsBetween(spec: ControlSpec, from: number, to: number): number {
  const step = spec.step ?? 1;
  let d = to - from;
  if (spec.wraps) {
    const span = (spec.max ?? 1) - (spec.min ?? 0) + step;
    d = (((d % span) + span * 1.5) % span) - span / 2;
  }
  return Math.round(d / step);
}

/**
 * A dual concentric knob: the inner knob makes the small steps, the outer ring the large
 * ones (MHz on a radio, 100 kHz on the ADF, 1000 ft on the autopilot). Radio frequencies wrap
 * their kHz within the MHz (as the real sets do); the others simply add.
 */
export class DualKnobTurn {
  private prev: number | undefined;
  inner = 0;
  outer = 0;

  constructor(
    private readonly coarse: number,
    private readonly radio: boolean,
    private readonly innerDeg = 15,
    private readonly outerDeg = 15,
  ) {}

  update(spec: ControlSpec, value: number): { inner: number; outer: number } {
    const p = this.prev;
    this.prev = value;
    if (p === undefined || p === value) return { inner: this.inner, outer: this.outer };
    const step = spec.step ?? 1;
    const c = this.coarse;
    if (this.radio) {
      const fineSpan = c;
      let df = (value % c) - (p % c);
      df = (((df % fineSpan) + fineSpan * 1.5) % fineSpan) - fineSpan / 2;
      const mhz = Math.round(((spec.max ?? 0) - (spec.min ?? 0)) / c) + 1;
      let dc = Math.floor(value / c) - Math.floor(p / c);
      dc = (((dc % mhz) + mhz * 1.5) % mhz) - mhz / 2;
      if (Math.round(dc) === 0) this.inner += Math.round(df / step) * this.innerDeg;
      else if (Math.round(df) === 0 && Math.abs(dc) <= 10)
        this.outer += Math.round(dc) * this.outerDeg;
    } else {
      const d = value - p;
      if (Math.abs(d) < c) this.inner += Math.round(d / step) * this.innerDeg;
      else if (Math.abs(d % c) < 1e-6 && Math.abs(d / c) <= 10)
        this.outer += Math.round(d / c) * this.outerDeg;
    }
    return { inner: this.inner, outer: this.outer };
  }
}

/** Seconds a control takes to settle: switches snap, levers follow. */
export const SETTLE = {
  toggle: 0.018,
  button: 0.015,
  selector: 0.045,
  knob: 0.04,
  lever: 0.07,
} as const;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
