/**
 * Maths of the on-screen controls. Pure functions: tested in Node.
 * Screen coordinates: x right, y down.
 */

export interface Axes {
  x: number;
  y: number;
}

/** Share of the stick travel around the centre that reads as zero (thumb jitter). */
export const STICK_DEAD_ZONE = 0.08;
/** Blend towards a cubic curve: fine control around the centre, full deflection at the rim. */
export const STICK_EXPO = 0.35;

/**
 * Thumb offset from the stick centre (pixels) → axes in the unit circle. The dead zone is
 * radial and the rest is rescaled, so leaving the dead zone starts at 0 rather than jumping.
 */
export function stickAxes(
  dx: number,
  dy: number,
  radius: number,
  deadZone = STICK_DEAD_ZONE,
): Axes {
  if (!(radius > 0)) return { x: 0, y: 0 };
  const len = Math.hypot(dx, dy) / radius;
  if (!(len > deadZone)) return { x: 0, y: 0 };
  const clamped = Math.min(1, len);
  const scaled = (clamped - deadZone) / (1 - deadZone);
  const k = scaled / len;
  return { x: (dx / radius) * k, y: (dy / radius) * k };
}

/** The knob position (pixels) for an offset, held inside the base. */
export function clampToCircle(dx: number, dy: number, radius: number): Axes {
  const len = Math.hypot(dx, dy);
  if (len <= radius || len === 0) return { x: dx, y: dy };
  return { x: (dx / len) * radius, y: (dy / len) * radius };
}

export function expo(v: number, k = STICK_EXPO): number {
  return (1 - k) * v + k * v * v * v;
}

/**
 * Stick axes → flight controls. Thumb down = stick pulled back = nose up (positive pitch),
 * as with a real yoke; inverted when the player asks for it.
 */
export function stickToControls(a: Axes, invertPitch: boolean): { pitch: number; roll: number } {
  const pitch = clamp1(expo(a.y));
  return { pitch: invertPitch ? -pitch : pitch, roll: clamp1(expo(a.x)) };
}

/** Throttle lever: pointer y within the track → 1 at the top, 0 at the bottom. */
export function leverValue(y: number, top: number, height: number): number {
  if (!(height > 0)) return 0;
  return Math.min(1, Math.max(0, 1 - (y - top) / height));
}

/** Rudder slider: pointer x within the track → -1 (left) .. 1 (right), with a small dead zone. */
export function sliderAxis(x: number, left: number, width: number, deadZone = 0.06): number {
  if (!(width > 0)) return 0;
  const v = Math.min(1, Math.max(-1, ((x - left) / width) * 2 - 1));
  if (Math.abs(v) <= deadZone) return 0;
  return (Math.sign(v) * (Math.abs(v) - deadZone)) / (1 - deadZone);
}

/**
 * Device tilt → angles in degrees, like a steering wheel held in front of you.
 *
 * `beta` and `gamma` are DeviceOrientation angles (degrees); `screenAngle` is
 * screen.orientation.angle (0, 90, 180, 270). Going through the direction of "up" in screen
 * coordinates works the same in every orientation, unlike swapping beta and gamma, and does
 * not need alpha (which follows the compass and drifts).
 *
 * `roll`: turning the device clockwise in the screen plane is positive (bank right).
 * `pitch`: the screen facing more upwards (top edge pulled towards you) is positive.
 */
export function tiltAngles(
  beta: number,
  gamma: number,
  screenAngle: number,
): { pitch: number; roll: number } {
  const r = Math.PI / 180;
  const b = beta * r;
  const g = gamma * r;
  // World up in device coordinates (W3C Z-X'-Y' angles): x right, y top, z out of the screen.
  const ux = -Math.cos(b) * Math.sin(g);
  const uy = Math.sin(b);
  const uz = Math.cos(b) * Math.cos(g);
  const a = screenAngle * r;
  const upOnScreen = ux * Math.sin(a) + uy * Math.cos(a);
  const rightOnScreen = ux * Math.cos(a) - uy * Math.sin(a);
  return {
    roll: Math.atan2(-rightOnScreen, upOnScreen) / r,
    pitch: Math.atan2(uz, Math.hypot(upOnScreen, rightOnScreen)) / r,
  };
}

/**
 * Tilt angles → axes. `neutral` is the pitch angle the player holds the device at, taken when
 * tilt steering starts; `range` is the tilt in degrees that gives full deflection.
 */
export function tiltAxes(
  angles: { pitch: number; roll: number },
  neutral: number,
  invertPitch: boolean,
  range = 25,
): { pitch: number; roll: number } {
  const pitch = clamp1((angles.pitch - neutral) / range);
  return { pitch: invertPitch ? -pitch : pitch, roll: clamp1(angles.roll / range) };
}

function clamp1(v: number): number {
  return Math.min(1, Math.max(-1, v));
}
