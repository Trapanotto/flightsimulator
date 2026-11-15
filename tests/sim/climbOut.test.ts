/**
 * The climb-out of a keyboard pilot: full power, the pitch held for the climb speed, the feet
 * left to the rudder helper (RudderFeet), the wings levelled once and then left alone.
 *
 * What a rigged single owes that pilot is no rolling moment at the climb speed with the ball
 * centred: then a released wing stays where it is and only the spiral mode moves it. What
 * it does not owe is a stable spiral. In a climb the outer wing of a turn meets the air at
 * a larger angle on its helical path and, with the ball centred, nothing rolls it back: a
 * climbing turn overbanks (FAA Airplane Flying Handbook, climbing turns), here doubling the
 * bank in about 10 s at Vy. Real pilots touch the aileron now and then; so must ours.
 */
import { describe, expect, it } from 'vitest';
import { createAircraft, TestEnvironment, type AircraftId } from '../../src/sim';
import type { FlightModel } from '../../src/sim/flightModel';
import { AttitudePilot, DEG, KT, Pid, RudderFeet, SIM_DT, clamp, headingError } from './harness';
import { pc12Airborne } from './pc12Harness';

/**
 * Take-off and climb at `vy`: wings held level for `level` s after lift-off, then hands off
 * for `free` s. Returns the aileron held (mean over the last 5 s before letting go), the
 * rudder held, and the largest bank and heading change while hands off.
 */
function climbOut(id: AircraftId, flaps: number, vr: number, vy: number, level = 30, free = 15) {
  const env = new TestEnvironment();
  const ac = createAircraft(id) as FlightModel;
  ac.controls.flaps = flaps;
  ac.reset({ position: env.position(0), headingDeg: 140, speed: 0, onGround: true }, env);
  const t = ac.telemetry;
  const c = ac.controls;
  const feet = new RudderFeet(ac);
  const attitude = new AttitudePilot(ac);
  const speed = new Pid(0.02, 0.004, 0, 0.1);
  let liftOff = -1;
  let held = 0;
  let rudder = 0;
  let heading = 0;
  let maxBank = 0;
  let maxTurn = 0;
  for (let i = 0; i < (60 + level + free) / SIM_DT && !t.crashed; i++) {
    c.throttle[0] = Math.min(1, t.time / 3);
    if (liftOff < 0) {
      c.pitch = t.ias > vr * KT ? clamp(3 * (9 * DEG - t.pitch), 0, 1) : 0;
      if ((t.agl ?? 0) > 3) liftOff = t.time;
    } else attitude.pitchTo(9 * DEG + speed.update(t.ias / KT - vy, SIM_DT), SIM_DT);
    const since = liftOff < 0 ? -1 : t.time - liftOff;
    if (since > 5) {
      c.flaps = 0;
      c.gearDown = false;
    }
    if (since >= 0 && since < level) attitude.bankTo(0, SIM_DT);
    else c.roll = 0;
    if (since > level - 5 && since < level) held += (c.roll * SIM_DT) / 5;
    feet.step(SIM_DT);
    ac.step(SIM_DT, env);
    if (since >= level && heading === 0) {
      heading = t.headingDeg;
      rudder = t.rudder;
    }
    if (since > level && since < level + free) {
      maxBank = Math.max(maxBank, Math.abs(t.bank) / DEG);
      maxTurn = Math.max(maxTurn, Math.abs(headingError(t.headingDeg, heading)));
    }
    if (since > level + free) break;
  }
  return {
    crashed: t.crashed,
    held,
    rudder,
    rigging: ac.def.controls.rudderRigging,
    maxBank,
    maxTurn,
  };
}

describe('a hands-off climb-out with the ball centred', () => {
  it.each([
    ['c172', 0, 55, 74],
    ['pc12', 1 / 3, 83, 130],
  ] as const)(
    '%s: rigged for the climb at Vy, and it needs right rudder',
    (id, flaps, vr, vy) => {
      const r = climbOut(id, flaps, vr, vy);
      expect(r.crashed).toBeUndefined();
      // No rolling moment left to hold at zero slip...
      expect(Math.abs(r.held), 'aileron held at Vy').toBeLessThan(0.005);
      // ...so the released wings only follow the slow spiral at first.
      expect(r.maxBank, 'bank, hands off').toBeLessThan(1.5);
      expect(r.maxTurn, 'heading change, hands off').toBeLessThan(10);
      // The engine still pulls left: the feet hold right rudder beyond the cruise rigging.
      expect(r.rudder - r.rigging, 'right rudder').toBeGreaterThan(0.02);
    },
    30_000,
  );

  it('the PC-12 still rolls left at full power slow after lift-off (torque)', () => {
    const f = pc12Airborne(300, 85, { flaps: 1 / 3, gearDown: true });
    const { ac } = f;
    // As on a take-off: aileron and rudder trim at their take-off marks.
    ac.controls.rollTrim = 0;
    ac.controls.yawTrim = 0;
    ac.controls.throttle[0] = 1;
    const feet = new RudderFeet(ac);
    const attitude = new AttitudePilot(ac);
    const speed = new Pid(0.02, 0.004, 0, 0.2);
    const base = ac.telemetry.pitch + 5 * DEG;
    let held = 0;
    for (let i = 0; i < 20 / SIM_DT; i++) {
      attitude.pitchTo(base + speed.update(ac.telemetry.ias / KT - 85, SIM_DT), SIM_DT);
      attitude.bankTo(0, SIM_DT);
      feet.step(SIM_DT);
      if (i * SIM_DT > 15) held += (ac.controls.roll * SIM_DT) / 5;
      ac.step(SIM_DT, f.env);
    }
    expect(held).toBeGreaterThan(0.03);
  }, 30_000);
});
