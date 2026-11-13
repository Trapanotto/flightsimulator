/** Loudness curves of the aircraft sounds, as gains 0..1. Plain maths, tested without audio. */

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Engine: silent when stopped, clearly there at idle, loud at full rpm; quieter inside. */
export function engineLevel(rpm: number, inside: boolean): number {
  if (rpm < 60) return 0;
  const level = 0.25 + 0.75 * clamp01(rpm / 2700);
  return level * (inside ? 0.5 : 0.85);
}

/**
 * Wind over the airframe: grows with the square of the airspeed (dynamic pressure), from
 * nothing at a walking pace to full level at `fullSpeed` (m/s).
 */
export function windLevel(tas: number, fullSpeed: number, inside: boolean): number {
  const q = clamp01(tas / fullSpeed);
  return q * q * (inside ? 0.35 : 0.5);
}

/** Tyres on the ground: a rumble that grows with the rolling speed. */
export function groundRollLevel(onGround: boolean, groundSpeed: number, inside: boolean): number {
  if (!onGround) return 0;
  return clamp01(groundSpeed / 30) * (inside ? 0.5 : 0.3);
}
