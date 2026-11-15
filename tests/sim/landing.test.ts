/**
 * Landings of the PC-12 and the F/A-18 flown by hand from a 3 NM final on a 3° path: once as
 * a test pilot flies them (landingProcedures.ts), once as a keyboard player can
 * (keyboardPilot.ts). Nothing may break or touch the runway but the wheels, the aircraft
 * stays on a 45 m runway and stops within the published landing distance with the margin an
 * operator plans with (the published distance over 50 ft is the shortest; the landing
 * distance required is that divided by 0.6).
 */
import { describe, expect, it } from 'vitest';
import { createAircraft } from '../../src/sim';
import type { FlightModel } from '../../src/sim/flightModel';
import { FLAPS, newFa18, setFuel } from './fa18Harness';
import { fa18KeyboardLanding, pc12KeyboardLanding } from './keyboardPilot';
import {
  RUNWAY_HALF_WIDTH,
  fa18HandLanding,
  firmArrival,
  pc12HandLanding,
  type LandingRecord,
} from './landingProcedures';

/** PC-12 Pilot's Information Manual: landing over 50 ft 558 m, ground roll 370 m with reverse. */
const PC12_LANDING = 558;
const PC12_ROLL = 370;
/** F/A-18 field landing roll from an on-speed approach, reconstructed (fa18.performance.test.ts). */
const FA18_ROLL = 850;

function landedSafely(r: LandingRecord) {
  expect(r.crashed).toBeUndefined();
  expect(r.struck, 'contact points that touched').toEqual([]);
  expect(r.stopped).toBe(true);
  expect(r.maxCross, 'off the centre line (m)').toBeLessThan(RUNWAY_HALF_WIDTH - 5);
  // On the runway, not in the undershoot.
  expect(r.touchdown.along).toBeGreaterThan(0);
}

describe('hand-flown landings from 3 NM', () => {
  it('PC-12: 85 KIAS, flaps 40, flare, beta and reverse, brakes', () => {
    const r = pc12HandLanding();
    landedSafely(r);
    expect(r.touchdown.sinkFpm).toBeLessThan(300);
    expect(r.touchdown.kias).toBeGreaterThan(70);
    expect(r.touchdown.kias).toBeLessThan(83);
    // Main wheels first, nose up but the tail well clear.
    expect(r.touchdown.pitchDeg).toBeGreaterThan(0);
    expect(r.maxLoad).toBeLessThan(2);
    expect(r.maxCross).toBeLessThan(3);
    expect(r.landingDistance).toBeLessThan(PC12_LANDING / 0.6);
    expect(Math.abs(r.groundRoll / PC12_ROLL - 1)).toBeLessThan(0.15);
  }, 30_000);

  it('F/A-18: on speed, gear and full flaps, flown onto the runway without a flare', () => {
    const r = fa18HandLanding();
    landedSafely(r);
    // A firm, carrier-style arrival: the path's sink rate, far inside the gear's 1440 ft/min.
    expect(r.touchdown.sinkFpm).toBeGreaterThan(500);
    expect(r.touchdown.sinkFpm).toBeLessThan(900);
    expect(Math.abs(r.touchdown.alphaDeg - 8.1)).toBeLessThan(0.5);
    expect(r.maxCross).toBeLessThan(3);
    expect(r.groundRoll).toBeGreaterThan(650);
    expect(r.groundRoll).toBeLessThan(1000);
    expect(r.landingDistance).toBeLessThan((FA18_ROLL + 300) / 0.6);
  }, 30_000);
});

describe('a keyboard pilot lands them', () => {
  it('PC-12: taps of yoke and power, the rudder to the helper', () => {
    const r = pc12KeyboardLanding();
    landedSafely(r);
    // Within the gear's design sink rate (CS 23.473: 10 ft/s).
    expect(r.touchdown.sinkFpm).toBeLessThan(600);
    expect(r.landingDistance).toBeLessThan(PC12_LANDING / 0.6);
  }, 30_000);

  it('F/A-18: taps of stick with the automatic throttle on speed', () => {
    const r = fa18KeyboardLanding();
    landedSafely(r);
    expect(r.touchdown.sinkFpm).toBeLessThan(1440);
    expect(r.landingDistance).toBeLessThan((FA18_ROLL + 300) / 0.6);
  }, 30_000);
});

describe('gear loads', () => {
  it("takes the F/A-18's carrier design sink of 24 ft/s on speed, and breaks well beyond", () => {
    const hornet = (sink: number) =>
      firmArrival(newFa18(), sink, 139, FLAPS.full, (f) => {
        setFuel(f, 15_000 - f.ac.def.mass);
        f.ac.controls.pitchTrim = 0;
      });
    for (const sink of [700, 1440]) {
      const r = hornet(sink);
      expect(r.crashed, `${sink} ft/min`).toBeUndefined();
      expect(r.struck, `${sink} ft/min`).toEqual([]);
    }
    expect(hornet(2000).crashed).toBe('gear');
    // The PC-12 at its own design sink rate, 10 ft/s.
    const pc12 = firmArrival(createAircraft('pc12') as FlightModel, 600, 80, 1);
    expect(pc12.crashed).toBeUndefined();
  }, 30_000);
});
