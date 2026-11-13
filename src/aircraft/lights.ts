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
 * What a pilot would have on when nobody sets the switches (there are no light switches in
 * the controls yet): beacon and position lights with the engine running, strobes on the
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
