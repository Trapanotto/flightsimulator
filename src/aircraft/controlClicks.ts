/**
 * What a click, a wheel notch or a drag on a cockpit control does to its value: the rules the
 * demo page uses, for the app to share. Plain TypeScript (tested in Node).
 *
 * - toggle: a press flips it.
 * - button: 1 while pressed, 0 on release.
 * - selector: a press on the right (or upper) half steps up, on the left half down; one without
 *   sides steps round. START of the ignition springs back to BOTH on release.
 * - knob: a press on the right half turns up one step, the left half down; the outer ring of a
 *   dual knob makes the coarse step (`ControlHit.step`). Holding repeats (see REPEAT). The
 *   wheel turns it too.
 * - lever: dragged (up = pushed in, except alternate air which is pulled); a tap steps 10 %.
 */
import { type ControlSpec, limitControl } from '@sim';

export interface ClickTarget {
  side: -1 | 0 | 1;
  step?: number;
}

export interface PressResult {
  value: number;
  /** The value to set when the pointer is released (momentary controls). */
  release?: number;
}

/** Held knobs repeat after `delay` seconds, every `interval`. */
export const REPEAT = { delay: 0.4, interval: 0.07 } as const;
/** Share of the lever travel per tap, and per wheel notch. */
export const LEVER_TAP = 0.1;
export const LEVER_NOTCH = 0.05;
/** A lever's full travel is a drag over this share of the viewport height. */
export const LEVER_DRAG_SPAN = 0.35;

const MAGNETO_START = 4;
const MAGNETO_BOTH = 3;

export function pressControl(spec: ControlSpec, value: number, hit: ClickTarget): PressResult {
  switch (spec.kind) {
    case 'toggle':
      return { value: value >= 0.5 ? 0 : 1 };
    case 'button':
      return { value: 1, release: 0 };
    case 'selector': {
      const n = spec.positions?.length ?? 2;
      const next =
        hit.side === 0 ? (Math.round(value) + 1) % n : limitControl(spec, value + hit.side);
      if (spec.id === 'magnetos' && next === MAGNETO_START)
        return { value: next, release: MAGNETO_BOTH };
      return { value: next };
    }
    case 'knob':
      return { value: turnKnob(spec, value, hit.side === 0 ? 1 : hit.side, hit.step) };
    case 'lever':
      return {
        value: limitControl(spec, value + (hit.side === 0 ? 1 : hit.side) * LEVER_TAP * span(spec)),
      };
  }
}

/** Wheel notches (positive = away from the user / up) on a control. */
export function wheelControl(
  spec: ControlSpec,
  value: number,
  notches: number,
  hit: ClickTarget,
): number {
  const n = Math.sign(notches) * Math.max(1, Math.round(Math.abs(notches)));
  switch (spec.kind) {
    case 'knob': {
      let v = value;
      for (let i = 0; i < Math.abs(n); i++) v = turnKnob(spec, v, Math.sign(n) as 1 | -1, hit.step);
      return v;
    }
    case 'selector':
      return limitControl(spec, value + Math.sign(n));
    case 'lever':
      return limitControl(spec, value + n * LEVER_NOTCH * span(spec));
    default:
      return value;
  }
}

/** A drag of `dy` pixels (down positive) on a lever, or on the trim wheel. */
export function dragControl(
  spec: ControlSpec,
  value: number,
  dy: number,
  viewportHeight: number,
): number {
  const share = -dy / (viewportHeight * LEVER_DRAG_SPAN);
  if (spec.kind === 'lever') {
    // Alternate air is pulled towards the pilot to switch it on.
    const sign = spec.id === 'carbHeat' ? -1 : 1;
    return limitControl(spec, value + sign * share * span(spec));
  }
  if (spec.id === 'trim') {
    // Rolling the top of the wheel forward trims nose down.
    return limitControl(spec, value - share * span(spec));
  }
  return value;
}

/** Controls that are dragged rather than clicked. */
export function isDragged(spec: ControlSpec): boolean {
  return spec.kind === 'lever' || spec.id === 'trim';
}

/**
 * One detent of a knob. Frequencies turn their kHz within the MHz and the MHz within the band
 * (the outer ring), as the radios do; transponder digits stay octal and do not carry.
 */
export function turnKnob(spec: ControlSpec, value: number, dir: -1 | 1, coarse?: number): number {
  if (spec.id === 'xpdrCode') {
    const place = coarse ?? 1;
    const digit = Math.floor(value / place) % 10;
    const next = (Math.min(digit, 7) + dir + 8) % 8;
    return value + (next - digit) * place;
  }
  const isRadio = spec.wraps && (spec.min ?? 0) >= 100_000;
  if (isRadio) {
    const step = spec.step ?? 25;
    const mhz = Math.floor(value / 1000);
    const khz = value - mhz * 1000;
    const lo = Math.floor((spec.min ?? 0) / 1000);
    const hi = Math.floor((spec.max ?? 0) / 1000);
    if (coarse) {
      const n = hi - lo + 1;
      return ((((mhz - lo + dir) % n) + n) % n) * 1000 + lo * 1000 + khz;
    }
    const top = Math.floor(((spec.max ?? 0) % 1000) / step) * step + step;
    return mhz * 1000 + ((((khz + dir * step) % top) + top) % top);
  }
  return limitControl(spec, value + dir * (coarse ?? spec.step ?? 1));
}

function span(spec: ControlSpec): number {
  return (spec.max ?? 1) - (spec.min ?? 0);
}
