/**
 * Exterior lights: which are on, and the flash patterns of beacon and strobes. Deterministic
 * (driven by the simulation time), so replays and screenshots repeat exactly.
 */
import type { Telemetry } from '@sim';

export interface AircraftLights {
  nav: boolean;
  beacon: boolean;
  strobe: boolean;
  landing: boolean;
  taxi: boolean;
}

/**
 * What a pilot would have on when nobody sets the switches (without the systems' light
 * state): beacon and position lights with the engine running, strobes on the
 * runway and in the air, landing light below 1000 ft above the ground, taxi light rolling.
 */
export function autoLights(t: Telemetry): AircraftLights {
  const running = t.engines.some((e) => e.running);
  const rolling = t.onGround && t.groundSpeed > 1.5;
  const fast = t.onGround ? t.groundSpeed > 15 : true;
  const low = t.agl === undefined ? false : t.agl < 300;
  return {
    nav: running,
    beacon: running,
    strobe: running && fast,
    landing: running && fast && (t.onGround || low),
    taxi: running && rolling,
  };
}

/** The sky's exposure at noon and in a dark night (sky/atmosphere.ts: exposureFor). */
const EXPOSURE_NOON = 4.2;
const EXPOSURE_NIGHT = 400;

/**
 * How strongly a lamp's glow shows for the sky's exposure, 0.2 .. 1. A lamp is as bright at
 * noon as at midnight, but the eye is stopped down by day: its halo all but disappears in
 * sunlight and blooms in the dark. Even steps of brightness are even steps of the logarithm.
 */
export function glowVisibility(exposure: number): number {
  return 0.2 + 0.8 * darkness(exposure);
}

/** 0 at noon .. 1 in a dark night, even in the logarithm of the exposure. */
export function darkness(exposure: number): number {
  const t =
    Math.log(Math.max(exposure, 1e-6) / EXPOSURE_NOON) / Math.log(EXPOSURE_NIGHT / EXPOSURE_NOON);
  return Math.min(Math.max(t, 0), 1);
}

/**
 * Emission of the panel's post lights and the gauges' internal lighting (multiplies the
 * painted colour). A lamp of fixed brightness: emission x exposure on screen, so it shows at
 * night and vanishes in daylight. A small share of self-light by day keeps the dials readable
 * in the glareshield's shadow; it fades out with the daylight.
 */
export const POST_LIGHT = 0.0011;
export const PANEL_DAY_FILL = 0.04;
export function panelGlow(exposure: number, panelLight: number): number {
  const lamp = Math.min(POST_LIGHT * exposure, 0.45) * Math.min(Math.max(panelLight, 0), 1);
  return lamp + PANEL_DAY_FILL * (1 - darkness(exposure));
}

/**
 * Backlit displays and annunciator lamps: bright enough to read by day, dimmed at night (the
 * sets' photocells do the same) so they do not glare.
 */
export function displayGlow(exposure: number): number {
  return 1.1 - 0.72 * darkness(exposure);
}

/** The checklist highlight: easy to see on a sunlit panel, soft at night. */
export function highlightGlow(exposure: number): number {
  return 3.2 - 2.5 * darkness(exposure);
}

/** Beacon: a red flash of 0.12 s, 45 times a minute. 0..1. */
export function beaconIntensity(time: number): number {
  const period = 60 / 45;
  const p = ((time % period) + period) % period;
  const on = 0.12;
  if (p > on + 0.08) return 0;
  // Fast rise, short decay: an LED flash seen through a red dome.
  return p < on ? 1 : 1 - (p - on) / 0.08;
}

/** Strobes: two short white flashes every 1.2 s. 0..1. */
export function strobeIntensity(time: number): number {
  const period = 1.2;
  const p = ((time % period) + period) % period;
  return p < 0.04 || (p > 0.12 && p < 0.16) ? 1 : 0;
}
