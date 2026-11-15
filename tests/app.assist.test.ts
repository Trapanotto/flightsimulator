import { describe, expect, it } from 'vitest';
import { RudderAssist } from '../src/app/assist';
import { SIM_DT, TestEnvironment, createAircraft, geodeticToEcef } from '../src/sim';

describe('RudderAssist', () => {
  /** A full-throttle take-off run without touching the rudder; returns the worst heading error. */
  const run = (enabled: boolean) => {
    const env = new TestEnvironment();
    const ac = createAircraft('c172');
    ac.reset(
      { position: geodeticToEcef(46.9, 7.5, 0), headingDeg: 90, speed: 0, onGround: true },
      env,
    );
    const assist = new RudderAssist();
    assist.enabled = enabled;
    let worst = 0;
    for (let i = 0; i < 120 * 14 && ac.telemetry.ias < 28; i++) {
      ac.controls.throttle[0] = Math.min(1, i / 240);
      ac.controls.yaw = 0;
      assist.apply(SIM_DT, ac.telemetry, ac.controls);
      ac.step(SIM_DT, env);
      const error = Math.abs(((ac.telemetry.headingDeg - 90 + 540) % 360) - 180);
      worst = Math.max(worst, error);
    }
    expect(ac.telemetry.crashed).toBeUndefined();
    return worst;
  };

  it('keeps the take-off run straight where the aircraft alone would veer off', () => {
    expect(run(false)).toBeGreaterThan(15);
    expect(run(true)).toBeLessThan(2);
  });

  it('steps aside as soon as the pilot uses the rudder', () => {
    const env = new TestEnvironment();
    const ac = createAircraft('c172');
    ac.reset(
      { position: geodeticToEcef(46.9, 7.5, 0), headingDeg: 90, speed: 0, onGround: true },
      env,
    );
    const assist = new RudderAssist();
    ac.controls.yaw = 0.5;
    assist.apply(SIM_DT, ac.telemetry, ac.controls);
    expect(ac.controls.yaw).toBe(0.5);
  });

  it('holds the wings level in a hands-off climb, and leaves a turn alone', () => {
    const climb = (level: boolean) => {
      const env = new TestEnvironment();
      const ac = createAircraft('c172');
      ac.reset(
        { position: geodeticToEcef(46.9, 7.5, 600), headingDeg: 90, speed: 38, onGround: false },
        env,
      );
      const assist = new RudderAssist();
      assist.level = level;
      // Full power at the climb speed, the pitch held by a simple hand, the ailerons let go.
      for (let i = 0; i < 120 * 60; i++) {
        ac.controls.throttle[0] = 1;
        ac.controls.roll = 0;
        ac.controls.yaw = 0;
        ac.controls.pitch = Math.max(-1, Math.min(1, (38 - ac.telemetry.ias) * -0.05));
        assist.apply(SIM_DT, ac.telemetry, ac.controls);
        ac.step(SIM_DT, env);
      }
      return Math.abs(ac.telemetry.bank) * (180 / Math.PI);
    };
    // The climbing spiral takes the aircraft without the help, not with it.
    expect(climb(true)).toBeLessThan(2);
    expect(climb(false)).toBeGreaterThan(climb(true) + 3);

    const assist = new RudderAssist();
    const controls = createAircraft('c172').controls;
    const telemetry = { headingDeg: 90, bank: (25 * Math.PI) / 180, beta: 0, onGround: false };
    controls.roll = 0;
    assist.apply(SIM_DT, telemetry as never, controls);
    assist.apply(SIM_DT, telemetry as never, controls);
    expect(controls.roll).toBe(0);
  });
});
