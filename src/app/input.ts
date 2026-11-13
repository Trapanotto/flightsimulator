import type { ControlInput } from '@sim';

/** What on-screen controls contribute; null = that control is not being touched. */
export interface TouchAxes {
  pitch: number | null;
  roll: number | null;
  yaw: number | null;
  throttle: number | null;
  brake: boolean;
}

/** A gamepad reduced to what flying needs. */
export interface PadState {
  /** -1..1; pitch positive = stick back. */
  pitch: number;
  roll: number;
  yaw: number;
  /** Triggers 0..1: throttle up and down. */
  throttleUp: number;
  throttleDown: number;
  brake: boolean;
}

export interface InputOptions {
  invertPitch: boolean;
  /**
   * How far a held key moves the yoke, 0..1 (default 1). A key is all or nothing, and full
   * yoke at cruise speed breaks the aircraft: the app lowers this as the airspeed rises.
   */
  keyAuthority?: number;
}

/** One-shot commands since the last frame. */
export interface InputEvents {
  flapsDown: number;
  flapsUp: number;
  gearToggle: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const approach = (v: number, target: number, maxStep: number) =>
  v + clamp(target - v, -maxStep, maxStep);

/** Key codes (KeyboardEvent.code) per function; two alternatives each where it helps. */
export const KEYS = {
  pitchUp: ['KeyS', 'ArrowDown'],
  pitchDown: ['KeyW', 'ArrowUp'],
  rollLeft: ['KeyA', 'ArrowLeft'],
  rollRight: ['KeyD', 'ArrowRight'],
  yawLeft: ['KeyQ'],
  yawRight: ['KeyE'],
  throttleUp: ['ShiftLeft', 'ShiftRight', 'PageUp'],
  throttleDown: ['ControlLeft', 'ControlRight', 'PageDown'],
  brake: ['KeyB', 'Space'],
  flapsDown: ['KeyF'],
  flapsUp: ['KeyV'],
  gear: ['KeyG'],
  view: ['KeyC'],
  pause: ['KeyP', 'Escape'],
} as const;

/** Flap settings the lever clicks into (0, 10, 20, 30 degrees on the Cessna). */
const FLAP_NOTCHES = [0, 1 / 3, 2 / 3, 1];

/**
 * Turns keys, a gamepad and on-screen controls into the pilot's control positions.
 *
 * A key is on or off, a yoke is not: held keys move the yoke at a limited rate and it centres
 * when they are released, so the keyboard flies smoothly. Analogue devices (gamepad, touch)
 * pass through directly and take precedence while they are deflected.
 */
export class PilotInput {
  private pitch = 0;
  private roll = 0;
  private yaw = 0;
  private throttle = 0;
  private flapNotch = 0;
  private gearDown = true;
  private lastTouchThrottle: number | null = null;

  /** Yoke travel per second while a key is held, and when centring. */
  private static readonly DEFLECT = 1.8;
  private static readonly CENTRE = 2.6;
  private static readonly THROTTLE_RATE = 0.45;

  /** Call when a flight starts. */
  reset(throttle: number, flaps: number, gearDown: boolean) {
    this.pitch = this.roll = this.yaw = 0;
    this.throttle = clamp(throttle, 0, 1);
    this.flapNotch = FLAP_NOTCHES.reduce(
      (best, f, i) => (Math.abs(f - flaps) < Math.abs(FLAP_NOTCHES[best]! - flaps) ? i : best),
      0,
    );
    this.gearDown = gearDown;
    this.lastTouchThrottle = null;
  }

  /**
   * Advances the control positions by `dt` seconds and writes them to `out`.
   * `down(code)` tells whether a key is held.
   */
  update(
    dt: number,
    down: (code: string) => boolean,
    pad: PadState | null,
    touch: TouchAxes | null,
    events: InputEvents,
    options: InputOptions,
    out: ControlInput,
  ) {
    const any = (codes: readonly string[]) => codes.some(down);
    const axis = (neg: readonly string[], pos: readonly string[]) =>
      (any(pos) ? 1 : 0) - (any(neg) ? 1 : 0);

    const keyAxis = (current: number, target: number) =>
      approach(current, target, (target === 0 ? PilotInput.CENTRE : PilotInput.DEFLECT) * dt);
    const authority = options.keyAuthority ?? 1;
    this.pitch = keyAxis(this.pitch, axis(KEYS.pitchDown, KEYS.pitchUp) * authority);
    // Rolling is far less critical than pitching; it keeps more of its travel.
    this.roll = keyAxis(this.roll, axis(KEYS.rollLeft, KEYS.rollRight) * (0.5 + 0.5 * authority));
    this.yaw = keyAxis(this.yaw, axis(KEYS.yawLeft, KEYS.yawRight));

    let pitch = this.pitch;
    let roll = this.roll;
    let yaw = this.yaw;
    let brake = any(KEYS.brake);
    let throttleDelta = axis(KEYS.throttleDown, KEYS.throttleUp);

    if (pad) {
      // A deflected stick replaces the keys on that axis.
      if (Math.abs(pad.pitch) > 0.02) pitch = pad.pitch;
      if (Math.abs(pad.roll) > 0.02) roll = pad.roll;
      if (Math.abs(pad.yaw) > 0.02) yaw = pad.yaw;
      throttleDelta += pad.throttleUp - pad.throttleDown;
      brake ||= pad.brake;
    }
    if (options.invertPitch) pitch = -pitch;
    this.throttle = clamp(
      this.throttle + clamp(throttleDelta, -1, 1) * PilotInput.THROTTLE_RATE * dt,
      0,
      1,
    );
    if (touch) {
      // On-screen sticks add to the other devices (their pitch is already inverted if the
      // player asked for that).
      pitch += touch.pitch ?? 0;
      roll += touch.roll ?? 0;
      yaw += touch.yaw ?? 0;
      // The on-screen lever stays where it was put: it sets the throttle when it moves, and
      // keys carry on from there.
      if (touch.throttle !== null && touch.throttle !== this.lastTouchThrottle)
        this.throttle = clamp(touch.throttle, 0, 1);
      this.lastTouchThrottle = touch.throttle;
      brake ||= touch.brake;
    }

    this.flapNotch = clamp(
      this.flapNotch + events.flapsDown - events.flapsUp,
      0,
      FLAP_NOTCHES.length - 1,
    );
    if (events.gearToggle % 2 === 1) this.gearDown = !this.gearDown;

    out.pitch = clamp(pitch, -1, 1);
    out.roll = clamp(roll, -1, 1);
    out.yaw = clamp(yaw, -1, 1);
    for (let i = 0; i < out.throttle.length; i++) out.throttle[i] = this.throttle;
    out.flaps = FLAP_NOTCHES[this.flapNotch]!;
    out.gearDown = this.gearDown;
    out.brakeLeft = out.brakeRight = brake ? 1 : 0;
  }

  get throttlePosition() {
    return this.throttle;
  }
}

/** Reads the first connected gamepad with the standard layout. */
export function readGamepad(): PadState | null {
  const pads =
    typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) {
    if (!p || !p.connected || p.axes.length < 2) continue;
    const dead = (v: number | undefined) => {
      const x = v ?? 0;
      return Math.abs(x) < 0.08 ? 0 : (x - Math.sign(x) * 0.08) / 0.92;
    };
    return {
      roll: dead(p.axes[0]),
      // Stick forward is negative on the axis and means nose down.
      pitch: dead(p.axes[1]),
      yaw: dead(p.axes[2]),
      throttleUp: p.buttons[7]?.value ?? 0,
      throttleDown: p.buttons[6]?.value ?? 0,
      brake: !!p.buttons[0]?.pressed,
    };
  }
  return null;
}

/**
 * Keys held down, from DOM events. Ignores keys typed into form fields and releases
 * everything when the window loses focus (otherwise a key stays "held" forever).
 */
export class Keyboard {
  private readonly held = new Set<string>();
  /** Called once per key press (not on auto-repeat). */
  onPress?: (code: string) => void;

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
        return;
      // The interface may have handled the key already (Esc closing a dialog).
      if (e.defaultPrevented) return;
      if (!e.repeat) {
        this.held.add(e.code);
        this.onPress?.(e.code);
      }
      // Keep the page from scrolling or paging while flying.
      if (e.code.startsWith('Arrow') || e.code === 'Space' || e.code.startsWith('Page'))
        e.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.held.delete(e.code));
    target.addEventListener('blur', () => this.held.clear());
  }

  readonly down = (code: string) => this.held.has(code);
}

/**
 * Yoke travel for held keys at an indicated airspeed (m/s): all of it up to the approach
 * speed, a third of it at twice the stall speed and beyond.
 */
export function keyAuthorityAt(ias: number, stallSpeed: number): number {
  const lo = 1.2 * stallSpeed;
  const hi = 2.2 * stallSpeed;
  return 1 - 0.65 * clamp((ias - lo) / (hi - lo), 0, 1);
}
