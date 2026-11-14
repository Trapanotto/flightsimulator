/** Loudness curves of the aircraft sounds, as gains 0..1. Plain maths, tested without audio. */
import type { Surface } from '@sim';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Engine: silent when it does not turn, clearly there at idle, loud at full rpm; quieter
 * inside. A cranking or windmilling engine keeps this level: the worklet makes it softer by
 * leaving out the combustion.
 */
export function engineLevel(rpm: number, inside: boolean): number {
  if (rpm < 20) return 0;
  // Fade in from a standstill instead of jumping to the idle level.
  const level = (0.25 + 0.75 * clamp01(rpm / 2700)) * clamp01((rpm - 20) / 120);
  return level * (inside ? 0.5 : 0.85);
}

/** What the engine is doing, as the ear tells it apart. */
export type EngineMode = 'stopped' | 'cranking' | 'catching' | 'running' | 'windmilling';

/** Seconds after the first firing during which the engine still stumbles. */
export const CATCH_TIME = 1.6;

export function engineMode(
  running: boolean,
  rpm: number,
  starter: boolean,
  sinceCatch: number,
): EngineMode {
  if (running) return sinceCatch < CATCH_TIME ? 'catching' : 'running';
  if (starter) return 'cranking';
  return rpm >= 20 ? 'windmilling' : 'stopped';
}

/**
 * Share of the cylinder strokes that fire: none while cranking or windmilling, a stumbling
 * half when the engine catches, all once it runs.
 */
export function firingShare(mode: EngineMode, sinceCatch: number): number {
  if (mode === 'running') return 1;
  if (mode !== 'catching') return 0;
  return 0.45 + 0.55 * clamp01(sinceCatch / CATCH_TIME);
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

/** How a surface sounds under the wheels. */
export interface SurfaceSound {
  /** Low-pass of the rumble, Hz, and its loudness relative to asphalt. */
  rumbleHz: number;
  rumble: number;
  /** A higher band on loose surfaces (grass swishing, gravel crunching): centre Hz, level. */
  crunchHz: number;
  crunch: number;
  /** Tyres chirp at touch-down and brakes squeal only on a hard surface. */
  hard: boolean;
}

export function surfaceSound(surface: Surface | undefined): SurfaceSound {
  switch (surface) {
    case 'grass':
    case 'terrain':
      return { rumbleHz: 90, rumble: 1.3, crunchHz: 1400, crunch: 0.35, hard: false };
    case 'gravel':
      return { rumbleHz: 170, rumble: 1.2, crunchHz: 2600, crunch: 0.6, hard: false };
    case 'snow':
      return { rumbleHz: 80, rumble: 0.6, crunchHz: 900, crunch: 0.3, hard: false };
    case 'water':
      return { rumbleHz: 120, rumble: 0, crunchHz: 800, crunch: 0, hard: false };
    case 'concrete':
      return { rumbleHz: 160, rumble: 1.05, crunchHz: 1000, crunch: 0, hard: true };
    default:
      return { rumbleHz: 140, rumble: 1, crunchHz: 1000, crunch: 0, hard: true };
  }
}

/**
 * Touch-down: the tyres chirp when they spin up against a hard surface (louder with more
 * ground speed to spin up to and a firmer arrival), and the gear thumps with the sink rate.
 * `sinkRate` m/s positive down, `groundSpeed` m/s. Gains 0..1 before the inside/outside mix.
 */
export function touchdownLevel(
  sinkRate: number,
  groundSpeed: number,
  surface: Surface | undefined,
): { chirp: number; thump: number } {
  const sink = Math.max(0, sinkRate);
  const firm = clamp01(sink / 3);
  const spin = clamp01((groundSpeed - 5) / 25);
  const chirp = surfaceSound(surface).hard ? spin * (0.35 + 0.65 * firm) : 0;
  return { chirp, thump: clamp01(0.15 + sink / 2.5) };
}

/** Brakes squeal faintly when held firmly on a hard surface while still rolling. */
export function brakeSquealLevel(
  brake: number,
  groundSpeed: number,
  surface: Surface | undefined,
  inside: boolean,
): number {
  if (!surfaceSound(surface).hard || groundSpeed < 1 || groundSpeed > 25) return 0;
  const hold = clamp01((brake - 0.35) / 0.5);
  // Loudest at a slow roll, when the pads grab instead of slipping.
  const slow = clamp01(1 - groundSpeed / 25);
  return hold * (0.4 + 0.6 * slow) * (inside ? 0.025 : 0.012);
}

/** Rain on the airframe: precipitation 0..1, louder with airspeed (more drops hit). */
export function rainLevel(precipitation: number, tas: number, inside: boolean): number {
  const p = clamp01(precipitation);
  if (p <= 0) return 0;
  return Math.sqrt(p) * (0.6 + 0.4 * clamp01(tas / 50)) * (inside ? 0.12 : 0.05);
}

/**
 * A spinning gyro rotor: it comes up to speed in seconds but coasts down for minutes, so the
 * whine sinks slowly after the power is gone. Returns the new spin 0..1 after `dt` seconds.
 */
export function gyroSpin(spin: number, driven: boolean, dt: number, up = 6, down = 45): number {
  const target = driven ? 1 : 0;
  const tau = driven ? up : down;
  return target + (spin - target) * Math.exp(-dt / tau);
}

/**
 * Loudness of the cockpit sounds (peaks for one-shot events). Quiet next to the engine, which
 * sits at 0.12..0.5 inside: a switch is a sharp but small transient.
 */
export const COCKPIT_LEVEL = {
  switch: 0.12,
  knob: 0.05,
  lever: 0.05,
  flapMotor: 0.035,
  fuelPump: 0.012,
  gyro: 0.003,
  disconnect: 0.07,
  starterClick: 0.1,
} as const;
