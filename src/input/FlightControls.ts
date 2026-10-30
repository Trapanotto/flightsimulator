import type { FlightInput } from '../physics/FlightModel';

/** One-shot actions (toggles), consumed once per frame. */
export type FlightAction =
  'gear' | 'flaps' | 'camera' | 'reset' | 'pause' | 'mouseAim' | 'map' | 'mute' | 'exit' | 'jump';

const DEADZONE = 0.08;
const EXPO = 0.4;
/** Keyboard axes ramp to their target at this rate (1/s) so taps are gentle. */
const KEY_RAMP = 5;
const THROTTLE_RATE = 0.6;

/** Deadzone + expo curve: fine control near the centre, full deflection at the edge. */
export function shapeAxis(v: number): number {
  const a = Math.abs(v);
  if (a < DEADZONE) return 0;
  const t = (a - DEADZONE) / (1 - DEADZONE);
  return Math.sign(v) * ((1 - EXPO) * t + EXPO * t * t * t);
}

const KEYS = {
  pitchDown: ['KeyW', 'ArrowUp'],
  pitchUp: ['KeyS', 'ArrowDown'],
  rollLeft: ['KeyA', 'ArrowLeft'],
  rollRight: ['KeyD', 'ArrowRight'],
  yawLeft: ['KeyQ'],
  yawRight: ['KeyE'],
  throttleUp: ['ShiftLeft', 'ShiftRight', 'KeyR'],
  throttleDown: ['ControlLeft', 'ControlRight', 'KeyF'],
  boost: ['Space'],
  brake: ['KeyB'],
  trimDown: ['PageUp', 'Numpad7'],
  trimUp: ['PageDown', 'Numpad1'],
} as const;

const ACTION_KEYS: Record<string, FlightAction> = {
  KeyG: 'gear',
  KeyV: 'flaps',
  KeyC: 'camera',
  Backspace: 'reset',
  KeyP: 'pause',
  KeyN: 'mouseAim',
  KeyM: 'map',
  KeyO: 'mute',
  // Get out / in, jump with the parachute, pull.
  KeyJ: 'exit',
  Space: 'jump',
};

/** Standard gamepad layout (Xbox naming). */
const PAD = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  UP: 12,
  DOWN: 13,
};

/**
 * Merges keyboard, gamepad, touch and mouse-aim into one FlightInput.
 * Priority per axis: whichever device is deflected the most wins.
 */
export class FlightControls {
  readonly input: FlightInput = {
    pitch: 0,
    roll: 0,
    yaw: 0,
    throttle: 0,
    boost: false,
    brake: false,
    trim: 0,
  };
  /** Set by the touch UI (already shaped). */
  readonly touch = { pitch: 0, roll: 0, active: false, boost: false, throttle: -1 };
  /** Set by the mouse-aim controller when enabled. */
  readonly aim = { pitch: 0, roll: 0, yaw: 0, active: false };
  invertPitch = false;
  private readonly keys = new Set<string>();
  private readonly keyAxes = { pitch: 0, roll: 0, yaw: 0 };
  private readonly actions: FlightAction[] = [];
  private padButtons: boolean[] = [];
  gamepadName = '';

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  /** Queue an action from UI buttons. */
  trigger(a: FlightAction) {
    this.actions.push(a);
  }

  /** Returns and clears the actions since the last call. */
  takeActions(): FlightAction[] {
    return this.actions.splice(0);
  }

  /** True while the keyboard steers (mouse aim yields to it). */
  get keyboardSteering(): boolean {
    return this.anyKey([...KEYS.pitchDown, ...KEYS.pitchUp, ...KEYS.rollLeft, ...KEYS.rollRight]);
  }

  update(dt: number) {
    const target = {
      pitch: (this.anyKey(KEYS.pitchUp) ? 1 : 0) - (this.anyKey(KEYS.pitchDown) ? 1 : 0),
      roll: (this.anyKey(KEYS.rollRight) ? 1 : 0) - (this.anyKey(KEYS.rollLeft) ? 1 : 0),
      yaw: (this.anyKey(KEYS.yawRight) ? 1 : 0) - (this.anyKey(KEYS.yawLeft) ? 1 : 0),
    };
    for (const axis of ['pitch', 'roll', 'yaw'] as const) {
      const cur = this.keyAxes[axis];
      const step = KEY_RAMP * dt;
      this.keyAxes[axis] = cur + Math.max(-step, Math.min(step, target[axis] - cur));
    }

    let throttle = this.input.throttle;
    if (this.anyKey(KEYS.throttleUp)) throttle += THROTTLE_RATE * dt;
    if (this.anyKey(KEYS.throttleDown)) throttle -= THROTTLE_RATE * dt;
    let boost = this.anyKey(KEYS.boost);
    let brake = this.anyKey(KEYS.brake);

    // Gamepad
    let pad = { pitch: 0, roll: 0, yaw: 0 };
    const gp = navigator.getGamepads?.().find((g) => g && g.connected);
    if (gp) {
      this.gamepadName = gp.id;
      const b = (i: number) => gp.buttons[i]?.pressed ?? false;
      const v = (i: number) => gp.buttons[i]?.value ?? 0;
      pad = {
        roll: shapeAxis(gp.axes[0] ?? 0),
        // Stick forward (negative axis) = nose down.
        pitch: shapeAxis(gp.axes[1] ?? 0),
        yaw: (b(PAD.RB) ? 1 : 0) - (b(PAD.LB) ? 1 : 0),
      };
      throttle += (v(PAD.RT) - v(PAD.LT)) * THROTTLE_RATE * dt * 1.5;
      boost ||= b(PAD.A);
      brake ||= b(PAD.B);
      const edge = (i: number, a: FlightAction) => {
        if (b(i) && !this.padButtons[i]) this.actions.push(a);
      };
      edge(PAD.X, 'gear');
      edge(PAD.Y, 'camera');
      edge(PAD.START, 'pause');
      edge(PAD.BACK, 'reset');
      edge(PAD.UP, 'flaps');
      edge(PAD.DOWN, 'flaps');
      this.padButtons = gp.buttons.map((x) => x.pressed);
    }

    // Touch
    if (this.touch.throttle >= 0) throttle = this.touch.throttle;
    boost ||= this.touch.boost;

    const pick = (...vals: number[]) =>
      vals.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
    const keyboardActive = Math.abs(this.keyAxes.pitch) + Math.abs(this.keyAxes.roll) > 0.01;
    const aimOn = this.aim.active && !keyboardActive;
    let pitch = pick(this.keyAxes.pitch, pad.pitch, this.touch.pitch, aimOn ? this.aim.pitch : 0);
    // Pitch from a key: the flight model eases it in as a pitch-rate demand.
    this.input.digitalPitch = pitch !== 0 && pitch === this.keyAxes.pitch;
    if (this.invertPitch) pitch = -pitch;
    this.input.pitch = pitch;
    this.input.roll = pick(this.keyAxes.roll, pad.roll, this.touch.roll, aimOn ? this.aim.roll : 0);
    this.input.digitalRoll = this.input.roll !== 0 && this.input.roll === this.keyAxes.roll;
    this.input.yaw = pick(this.keyAxes.yaw, pad.yaw, aimOn ? this.aim.yaw : 0);
    this.input.throttle = Math.max(0, Math.min(1, throttle));
    this.input.boost = boost;
    this.input.brake = brake;
    this.input.trim = (this.anyKey(KEYS.trimUp) ? 1 : 0) - (this.anyKey(KEYS.trimDown) ? 1 : 0);
  }

  rumble(strength: number, ms: number) {
    const gp = navigator.getGamepads?.().find((g) => g && g.connected);
    void gp?.vibrationActuator?.playEffect?.('dual-rumble', {
      duration: ms,
      strongMagnitude: strength,
      weakMagnitude: strength,
    });
  }

  /** A key is held (walking and parachute controls read the keys directly). */
  held(code: string): boolean {
    return this.keys.has(code);
  }

  private anyKey(codes: readonly string[]) {
    return codes.some((c) => this.keys.has(c));
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (!e.repeat && ACTION_KEYS[e.code]) this.actions.push(ACTION_KEYS[e.code]!);
    this.keys.add(e.code);
    if (
      e.code === 'Space' ||
      e.code.startsWith('Arrow') ||
      e.code.startsWith('Page') ||
      e.code === 'Backspace'
    )
      e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);

  private readonly onBlur = () => this.keys.clear();
}
