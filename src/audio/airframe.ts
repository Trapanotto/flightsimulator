/**
 * Airframe and listener: wind, gear, buffet and shock levels by type, and where the listener
 * is (cockpit, outside view, fly-by camera) as gain, air absorption, Doppler and the pan and
 * delay of each engine. Plain maths, tested without audio.
 */
import type { Vec3 } from '@sim';
import type { Position, SoundProfile } from './profiles';
import { SOUND_SPEED } from './turbine';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * Wind over the airframe of a turbine type: grows with dynamic pressure (the indicated
 * airspeed), full at the type's `windFullSpeed`, and a little beyond. Inside, the cabin keeps
 * most of it out: a pressurised airliner at 250 kt is quieter than a Cessna at 110.
 */
export function airframeWind(profile: SoundProfile, ias: number, inside: boolean): number {
  const q = Math.min(1.4, (ias / profile.windFullSpeed) ** 2);
  return q * (inside ? (profile.cabin?.wind ?? 0.35) : 0.5);
}

/** Speed of sound at a height above sea level (standard atmosphere), m/s. */
export function soundSpeedAt(altitude: number): number {
  const t = Math.max(216.65, 288.15 - 0.0065 * altitude);
  return Math.sqrt(1.4 * 287.05 * t);
}

/**
 * Shock and transonic noise: the canopy and the airframe start to buzz towards Mach 1 and
 * the noise stays high beyond, growing with the dynamic pressure.
 */
export function shockLevel(profile: SoundProfile, mach: number, ias: number): number {
  const s = profile.airframe?.shock ?? 0;
  if (s <= 0) return 0;
  const q = Math.min(1.5, (ias / profile.windFullSpeed) ** 2);
  return s * smoothstep(0.82, 1.05, mach) * (0.5 + 0.5 * q);
}

/** Speed brake buffet: the brake's share out times the dynamic pressure. */
export function buffetLevel(profile: SoundProfile, speedbrake: number, ias: number): number {
  const b = profile.airframe?.buffet ?? 0;
  const q = Math.min(1.3, (ias / (0.6 * profile.windFullSpeed)) ** 2);
  return b * clamp01(speedbrake) * q;
}

/** The extended gear roaring in the airstream. */
export function gearRoarLevel(profile: SoundProfile, gear: number, ias: number): number {
  const r = profile.airframe?.gearRoar ?? 0;
  const q = Math.min(1.3, (ias / (0.6 * profile.windFullSpeed)) ** 2);
  return r * clamp01(gear) * q;
}

/** The camera relative to the aircraft, in its body axes (x forward, y right, z down). */
export interface CameraRelative {
  /** Camera position minus aircraft position, m. */
  offset: Vec3;
  /** Camera velocity minus aircraft velocity, m/s. */
  velocity: Vec3;
}

/** How the listener hears the aircraft: overall and per engine. */
export interface Listening {
  /** Gain for the distance (1 at the usual view distance and closer). */
  gain: number;
  /** Air absorption: everything above this is damped, Hz. */
  lowpassHz: number;
  /** Doppler factor of the frequencies (above 1 approaching). */
  pitch: number;
  /** Per engine: pan -1 left .. 1 right, and the delay of its sound, s. */
  pans: number[];
  delays: number[];
  /** Directivity: share of the fan tones (radiated forward) and the jet (aft), 0..1.2. */
  forward: number;
  aft: number;
}

const ONE: Position[] = [{ x: 0, y: 0, z: 0 }];

/**
 * Where the listener sits: in the cockpit, at the usual outside view behind the aircraft, or
 * at the camera the app reports. The listener looks at the aircraft (forward in the cockpit).
 */
export function listening(
  profile: SoundProfile,
  inside: boolean,
  camera?: CameraRelative,
): Listening {
  const engines = profile.engines ?? ONE;
  const ref = profile.viewDistance ?? 15;
  let at: Vec3;
  let look: Vec3;
  if (inside) {
    at = profile.pilot ?? { x: 0, y: 0, z: 0 };
    look = { x: 1, y: 0, z: 0 };
  } else {
    at = camera?.offset ?? { x: -ref, y: 0, z: -0.25 * ref };
    const d = Math.hypot(at.x, at.y, at.z) || 1;
    look = { x: -at.x / d, y: -at.y / d, z: -at.z / d };
  }
  // Right of the view: look x up, with up = -z in body axes.
  let right = { x: -look.y, y: look.x, z: 0 };
  const rl = Math.hypot(right.x, right.y);
  right = rl > 1e-6 ? { x: right.x / rl, y: right.y / rl, z: 0 } : { x: 0, y: 1, z: 0 };
  const dists = engines.map((e) => Math.hypot(e.x - at.x, e.y - at.y, e.z - at.z) || 0.1);
  const pans = engines.map((e, i) =>
    Math.max(-1, Math.min(1, ((e.x - at.x) * right.x + (e.y - at.y) * right.y) / dists[i]!)),
  );
  const nearest = Math.min(...dists);
  const delays = dists.map((d) => (d - nearest) / SOUND_SPEED);
  if (inside || !camera)
    return { gain: 1, lowpassHz: 18_000, pitch: 1, pans, delays, forward: 1, aft: 1 };

  const o = camera.offset;
  const v = camera.velocity;
  const d = Math.max(1, Math.hypot(o.x, o.y, o.z));
  // Range rate, positive when the camera and the aircraft move apart.
  const rate = (o.x * v.x + o.y * v.y + o.z * v.z) / d;
  const pitch = Math.min(2, Math.max(0.5, dopplerFactor(rate)));
  // Inverse distance (6 dB per doubling), never louder than the usual view.
  const gain = Math.min(1, ref / d);
  // Air absorption grows with frequency and distance: a far aircraft is a dull rumble.
  const lowpassHz = Math.max(700, 18_000 / (1 + d / 250));
  const cos = o.x / d;
  return {
    gain,
    lowpassHz,
    pitch,
    pans,
    delays,
    forward: 0.6 + 0.6 * clamp01(0.5 + 0.5 * cos),
    aft: 0.6 + 0.6 * clamp01(0.5 - 0.5 * cos),
  };
}

/**
 * Doppler factor for a sound source and listener moving apart at `rangeRate` m/s (negative
 * when approaching): the listener hears the frequency times c / (c + rate).
 */
export function dopplerFactor(rangeRate: number, c = SOUND_SPEED): number {
  return c / Math.max(0.2 * c, c + rangeRate);
}
