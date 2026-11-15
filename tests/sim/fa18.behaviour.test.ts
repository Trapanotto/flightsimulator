/**
 * The Hornet flown through manoeuvres by a scripted pilot (a loop, an aileron roll, a split-S,
 * a high angle of attack pass), a supersonic run with the transonic trim change held by the
 * FCS, a single-engine approach, the integration at Mach 1.8 and 220°/s of roll, determinism
 * and the cost of a step.
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../../src/sim';
import { FA18 } from '../../src/sim/fa18';
import { DEG, FT, KT, Pid, clamp, fly, headingError } from './harness';
import { FLAPS, fa18Airborne, fa18OnGround, fcs, hud, setFuel } from './fa18Harness';
import { HornetPilot, stickForG } from './fa18Procedures';

describe('F/A-18 manoeuvres', () => {
  it('flies a loop at 5 g and comes out on its heading', () => {
    const f = fa18Airborne(3000, 450, { heading: 90 });
    const { ac } = f;
    const t = ac.telemetry;
    ac.controls.throttle.fill(1);
    const h0 = t.altitude;
    let turned = 0;
    let wasInverted = false;
    let maxBeta = 0;
    fly(f, 60, () => {
      ac.controls.pitch = stickForG(f, 4);
      ac.controls.roll = 0;
      turned += ac.state.angularVelocity.y * SIM_DT;
      if (Math.abs(t.bank) > 150 * DEG && Math.abs(t.pitch) < 20 * DEG) wasInverted = true;
      maxBeta = Math.max(maxBeta, Math.abs(t.beta));
      return turned >= 2 * Math.PI - 0.05;
    });
    expect(turned).toBeGreaterThan(2 * Math.PI - 0.1);
    expect(wasInverted).toBe(true);
    expect(Math.abs(headingError(90, t.headingDeg))).toBeLessThan(10);
    expect(Math.abs(t.bank)).toBeLessThan(10 * DEG);
    // Full afterburner in the loop: it comes out with energy gained, higher.
    expect(t.altitude - h0).toBeGreaterThan(-100);
    expect(t.altitude - h0).toBeLessThan(1200);
    expect(maxBeta).toBeLessThan(3 * DEG);
    expect(t.crashed).toBeUndefined();
  }, 30_000);

  it('flies an aileron roll: 360° about the flight path in under two seconds', () => {
    const f = fa18Airborne(4000, 420, { heading: 0 });
    const { ac } = f;
    const t = ac.telemetry;
    const h0 = t.altitude;
    const pilot = new HornetPilot(f);
    let rolled = 0;
    let duration = NaN;
    let maxBeta = 0;
    fly(f, 6, (dt) => {
      ac.controls.pitch = 0;
      if (Number.isNaN(duration)) {
        ac.controls.roll = 1;
        if (rolled >= 2 * Math.PI - 0.25) duration = t.time;
      } else pilot.bankTo(0, dt);
      rolled += ac.state.angularVelocity.x * SIM_DT;
      maxBeta = Math.max(maxBeta, Math.abs(t.beta));
    });
    expect(duration).toBeLessThan(2.1);
    expect(Math.abs(t.bank)).toBeLessThan(3 * DEG);
    expect(Math.abs(headingError(0, t.headingDeg))).toBeLessThan(5);
    // Stick free the flight path sags while the lift points sideways and down.
    expect(Math.abs(t.altitude - h0)).toBeLessThan(150);
    expect(maxBeta).toBeLessThan(4 * DEG);
  });

  it('flies a split-S: half roll, pull through, out the other way', () => {
    const f = fa18Airborne(6000, 300, { heading: 0 });
    const { ac } = f;
    const t = ac.telemetry;
    const pilot = new HornetPilot(f);
    ac.controls.throttle.fill(0.6);
    const h0 = t.altitude;
    let phase: 'roll' | 'pull' | 'out' = 'roll';
    let pulled = 0;
    let peak = 0;
    fly(f, 40, (dt) => {
      if (phase === 'roll') {
        pilot.bankTo(Math.PI, dt);
        ac.controls.pitch = 0;
        if (Math.abs(t.bank) > 170 * DEG) phase = 'pull';
      } else if (phase === 'pull') {
        ac.controls.roll = 0;
        ac.controls.pitch = stickForG(f, 4.5);
        pulled += ac.state.angularVelocity.y * dt;
        peak = Math.max(peak, t.loadFactor);
        if (pulled >= Math.PI - 0.05) phase = 'out';
      } else {
        pilot.bankTo(0, dt);
        ac.controls.pitch = 0;
        return true;
      }
      return false;
    });
    expect(phase).toBe('out');
    expect(Math.abs(headingError(180, t.headingDeg))).toBeLessThan(15);
    const lost = h0 - t.altitude;
    expect(lost).toBeGreaterThan(800);
    expect(lost).toBeLessThan(3000);
    expect(peak).toBeLessThan(6);
    expect(t.crashed).toBeUndefined();
  }, 30_000);

  it('makes a high angle of attack pass at 30° and more without departing', () => {
    const f = fa18Airborne(3000, 250, { heading: 0 });
    const { ac } = f;
    const t = ac.telemetry;
    const pilot = new HornetPilot(f);
    const h0 = t.altitude;
    let throttle = 0.3;
    let stick = 0;
    let maxBeta = 0;
    let maxP = 0;
    let timeAbove30 = 0;
    fly(f, 60, (dt) => {
      // Behind the drag curve: the stick asks for the angle of attack (above 22° the FCS
      // takes the stick as an angle of attack), the throttles hold the altitude.
      const aim = t.time < 10 ? 15 * DEG : 32 * DEG;
      stick = clamp(stick + 0.5 * ((aim - t.alpha) / DEG) * dt * 0.05, 0, 1);
      ac.controls.pitch = stick;
      pilot.heading(0, dt);
      const climb = (h0 - t.altitude) * 0.1 - t.verticalSpeed;
      throttle = clamp(throttle + 0.02 * climb * dt, 0, 1);
      ac.controls.throttle.fill(clamp(throttle + 0.03 * climb, 0, 1));
      if (t.time > 30) {
        maxBeta = Math.max(maxBeta, Math.abs(t.beta));
        maxP = Math.max(maxP, Math.abs(ac.state.angularVelocity.x));
        if (t.alpha > 28 * DEG) timeAbove30 += dt;
      }
    });
    expect(timeAbove30).toBeGreaterThan(20);
    expect(Math.abs(t.altitude - h0)).toBeLessThan(100);
    expect(maxBeta).toBeLessThan(6 * DEG);
    expect(maxP).toBeLessThan(25 * DEG);
    expect(Math.abs(headingError(0, t.headingDeg))).toBeLessThan(15);
    expect(t.ias / KT).toBeLessThan(170);
    expect(t.crashed).toBeUndefined();
  }, 30_000);
});

describe('F/A-18 supersonic and engine-out', () => {
  it('runs through the transonic region to Mach 1.4 with the stick free: the FCS holds the trim change', () => {
    const f = fa18Airborne(30_000 * FT, 540);
    const { ac } = f;
    const t = ac.telemetry;
    ac.controls.throttle.fill(1);
    const h0 = t.altitude;
    const stab0 = t.elevator;
    let worst = 0;
    let worstN = 0;
    fly(f, 150, () => {
      worst = Math.max(worst, Math.abs(t.altitude - h0));
      worstN = Math.max(worstN, Math.abs(t.loadFactor - 1));
      return (t.mach ?? 0) > 1.4;
    });
    expect(t.mach).toBeGreaterThan(1.4);
    // The centre of pressure moved aft: the stabilators went trailing edge up to hold 1 g.
    expect(t.elevator).toBeGreaterThan(stab0 + 0.01);
    expect(worst).toBeLessThan(250);
    expect(worstN).toBeLessThan(0.2);
    expect(t.crashed).toBeUndefined();
  }, 30_000);

  it('integrates stably at Mach 1.8 and at 220°/s of roll', () => {
    const fast = fa18Airborne(11_000, 1030);
    fast.ac.controls.throttle.fill(1);
    let finite = true;
    fly(fast, 10, () => {
      fast.ac.controls.roll = fast.ac.telemetry.time > 2 && fast.ac.telemetry.time < 5 ? 1 : 0;
      for (const v of Object.values(fast.ac.state.angularVelocity)) finite &&= Number.isFinite(v);
    });
    expect(finite).toBe(true);
    expect(fast.ac.telemetry.mach).toBeGreaterThan(1.75);
    expect(Math.abs(fast.ac.state.angularVelocity.x)).toBeLessThan(3 * DEG);
    // 220°/s: the step turns 1.8° per step; the roll stops cleanly and the attitude is right.
    const roll = fa18Airborne(4500, 420);
    let rolled = 0;
    fly(roll, 6, () => {
      roll.ac.controls.roll = roll.ac.telemetry.time < 4.27 ? 1 : 0;
      rolled += roll.ac.state.angularVelocity.x * SIM_DT;
    });
    const wrapped = Math.atan2(Math.sin(rolled), Math.cos(rolled));
    expect(Math.abs(wrapped - roll.ac.telemetry.bank)).toBeLessThan(3 * DEG);
    expect(Math.abs(roll.ac.state.angularVelocity.y)).toBeLessThan(3 * DEG);
  }, 30_000);

  it('flies a single-engine approach on speed with the rudders holding the yaw', () => {
    const f = fa18Airborne(250, 145, { flaps: FLAPS.full, gearDown: true });
    const { ac } = f;
    setFuel(f, 15_000 - ac.def.mass);
    ac.controls.pitchTrim = 0;
    const t = ac.telemetry;
    ac.failures.set('engine', true);
    const pilot = new HornetPilot(f);
    const thrust = new Pid(0.3, 0.1, 0, 0.6);
    let worstHeading = 0;
    let maxBank = 0;
    const thr0 = ac.controls.throttle[1]!;
    let fifty = false;
    fly(f, 90, (dt) => {
      ac.controls.pitch = 0;
      pilot.heading(0, dt);
      // Both throttles move; only the right engine answers (in afterburner if it must).
      ac.controls.throttle.fill(clamp(thr0 + thrust.update(-3 * DEG - pilot.gamma, dt), 0, 1));
      if (t.time > 10) {
        worstHeading = Math.max(worstHeading, Math.abs(headingError(0, t.headingDeg)));
        maxBank = Math.max(maxBank, Math.abs(t.bank));
      }
      if ((t.agl ?? 100) < 50 * FT) fifty = true;
      return fifty;
    });
    expect(t.engines[0]!.running).toBe(false);
    expect(hud(f).cautions).toContain('L ENG OUT');
    expect(fifty).toBe(true);
    expect(Math.abs(t.alpha - 8.1 * DEG)).toBeLessThan(1 * DEG);
    expect(worstHeading).toBeLessThan(5);
    expect(maxBank).toBeLessThan(10 * DEG);
    expect(Math.abs(t.rudder)).toBeGreaterThan(0.02);
    expect(t.crashed).toBeUndefined();
  }, 30_000);
});

describe('F/A-18 integration', () => {
  it('is deterministic, fills its telemetry with finite numbers and costs under 0.15 ms a step', () => {
    const runOnce = () => {
      const f = fa18Airborne(3000, 400, { wind: { fromDeg: 250, speed: 8 } });
      for (let i = 0; i < 20 / SIM_DT; i++) {
        f.ac.controls.roll = Math.sin(i * 0.01) * 0.4;
        f.ac.controls.pitch = Math.cos(i * 0.007) * 0.3;
        f.ac.step(SIM_DT, f.env);
      }
      return JSON.stringify([f.ac.state, f.ac.telemetry]);
    };
    expect(runOnce()).toBe(runOnce());
    const f = fa18Airborne(5000 * FT, 400);
    fly(f, 2);
    const t = f.ac.telemetry;
    for (const [k, val] of Object.entries(t))
      if (typeof val === 'number') expect(Number.isFinite(val), k).toBe(true);
    for (const e of t.engines)
      for (const [k, val] of Object.entries(e))
        if (typeof val === 'number') expect(Number.isFinite(val), k).toBe(true);
    for (const [k, val] of Object.entries(t.avionics!.fa18!))
      if (typeof val === 'number') expect(Number.isFinite(val), k).toBe(true);
    const g = fa18OnGround();
    fly(g, 1);
    // Warm up, then the best of three: the machine's other work is not the step's cost.
    fly(f, 5);
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      fly(f, 25);
      fly(g, 25);
      best = Math.min(best, (performance.now() - t0) / (50 / SIM_DT));
    }
    expect(best).toBeLessThan(0.15);
  }, 30_000);

  it('uses the F/A-18 cockpit, its control law and its autopilot', () => {
    const f = fa18OnGround();
    expect(f.ac.cockpit.has('engineCrank')).toBe(true);
    expect(f.ac.cockpit.has('gLimiterOverride')).toBe(true);
    // The throttles in the cockpit are the levers of ControlInput.
    f.ac.cockpit.set('throttle1', 0.75);
    expect(f.ac.controls.throttle[0]).toBe(0.75);
    expect(f.ac.controls.throttle[1]).toBe(0);
    f.ac.cockpit.set('flaps', 2);
    expect(f.ac.controls.flaps).toBe(1);
    expect(fcs(f).mode).toBeDefined();
    expect(FA18.info.category).toBe('fighter');
    expect(f.ac.telemetry.avionics?.fa18).toBeDefined();
  });
});
