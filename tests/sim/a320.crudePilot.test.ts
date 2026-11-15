/**
 * A crude pilot in the A320, as a keyboard gives it: 0.6 of full aft stick while the key is
 * held (ramping at 1.8 per second, as the app does), exactly neutral when released. From a
 * running start on the runway with nothing set but the flap lever, take-offs pulled whenever
 * the nose is below a few degrees, too-early flap retraction, landings held aft from 30 ft and
 * a take-off run in a crosswind must never break the aircraft.
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT, TestEnvironment, createAircraft, type SimAircraft } from '../../src/sim';
import { DEG, FPM, FT, KT, clamp, headingError } from './harness';

const KEY_STICK = 0.6;
const KEY_RATE = 1.8;

/** The keyboard's stick: towards 0.6 while held, back to exactly 0 when released. */
function key(current: number, held: boolean, dt: number) {
  return held ? Math.min(KEY_STICK, current + KEY_RATE * dt) : 0;
}

function levers(ac: SimAircraft, v: number) {
  ac.cockpit.set('throttle1', v);
  ac.cockpit.set('throttle2', v);
}

interface TakeoffRun {
  crashed: string | undefined;
  liftOff: boolean;
  /** Lowest height after first reaching 150 ft, ft; climb rate a minute after lift-off, ft/min. */
  lowestAfter150: number;
  vsAfterMinute: number;
  maxAlphaDeg: number;
  maxPitchDeg: number;
  floor: boolean;
  minAglAfterLiftOff: number;
}

/**
 * The app's running start: reset on the runway, engines running, nothing set but the flap
 * lever; TOGA over 3 s, the heading held with small rudder, the stick held aft above VR
 * whenever the pitch is below `p` degrees.
 */
function takeoff(
  flapLever: number,
  p: number,
  o: { flapsUpAt150?: boolean; wind?: number } = {},
): TakeoffRun {
  const env = new TestEnvironment(o.wind ? { wind: { fromDeg: 90, speed: o.wind } } : {});
  const ac = createAircraft('a320');
  ac.reset({ position: env.position(0), headingDeg: 0, speed: 0, onGround: true }, env);
  ac.controls.flaps = flapLever / 4;
  const t = ac.telemetry;
  const c = ac.controls;
  const b = t.avionics!.autopilot.airbus!;
  let liftOffTime = NaN;
  let reached150 = false;
  let lowest = Infinity;
  let vsAfterMinute = NaN;
  let maxAlpha = 0;
  let maxPitch = 0;
  let floor = false;
  let minAgl = Infinity;
  let vr = NaN;
  for (let i = 0; i < 150 / SIM_DT && !t.crashed; i++) {
    if (i === 1) vr = b.speeds.vr;
    levers(ac, Math.min(1, t.time / 3));
    c.yaw = t.onGround ? clamp(0.1 * headingError(0, t.headingDeg), -0.3, 0.3) : 0;
    c.pitch = key(c.pitch, t.ias / KT > vr && t.pitch < p * DEG, SIM_DT);
    ac.step(SIM_DT, env);
    const agl = (t.agl ?? 0) / FT;
    if (!t.onGround && Number.isNaN(liftOffTime)) liftOffTime = t.time;
    if (!Number.isNaN(liftOffTime)) {
      minAgl = Math.min(minAgl, t.time - liftOffTime > 3 ? agl : Infinity);
      maxAlpha = Math.max(maxAlpha, t.alpha / DEG);
      maxPitch = Math.max(maxPitch, t.pitch / DEG);
      floor ||= b.controls.alphaFloor;
    }
    if (agl > 150 && !reached150) {
      reached150 = true;
      c.gearDown = false;
      if (o.flapsUpAt150) c.flaps = 0;
    }
    if (reached150) lowest = Math.min(lowest, agl);
    if (!Number.isNaN(liftOffTime) && Number.isNaN(vsAfterMinute) && t.time - liftOffTime > 60)
      vsAfterMinute = t.verticalSpeed / FPM;
  }
  return {
    crashed: t.crashed,
    liftOff: !Number.isNaN(liftOffTime),
    lowestAfter150: lowest,
    vsAfterMinute,
    maxAlphaDeg: maxAlpha,
    maxPitchDeg: maxPitch,
    floor,
    minAglAfterLiftOff: minAgl,
  };
}

describe('a crude pilot cannot break the A320', () => {
  for (const flaps of [1, 2, 3])
    it(`takes off pulling below 5 to 15° of pitch, flap lever ${flaps}`, () => {
      for (const p of [5, 8, 10, 12, 15]) {
        const r = takeoff(flaps, p);
        const what = `pulling below ${p}°`;
        expect(r.crashed, what).toBeUndefined();
        expect(r.liftOff, what).toBe(true);
        // Stick neutral holds the attitude, then the flight path: no skimming the runway (a
        // pilot who never pulls past 5° lifts off flat and fast, but still does not touch).
        expect(r.minAglAfterLiftOff, what).toBeGreaterThan(p >= 8 ? 20 : 3);
        expect(r.vsAfterMinute, what).toBeGreaterThan(400);
        expect(r.lowestAfter150, what).toBeGreaterThan(140);
      }
    }, 120_000);

  it('does not break with the flap lever at 0: it needs more runway or does not fly', () => {
    for (const p of [5, 10, 15]) {
      const r = takeoff(0, p);
      expect(r.crashed, `pulling below ${p}°`).toBeUndefined();
    }
  }, 120_000);

  it('survives the flaps retracted to 0 at 150 ft: the protections hold it in the air', () => {
    for (const p of [8, 12]) {
      const r = takeoff(1, p, { flapsUpAt150: true });
      const what = `pulling below ${p}°`;
      expect(r.crashed, what).toBeUndefined();
      expect(r.lowestAfter150, what).toBeGreaterThan(100);
      expect(r.vsAfterMinute, what).toBeGreaterThan(0);
    }
  }, 120_000);

  it('tracks the centreline at TOGA in a 5 m/s crosswind with small rudder corrections', () => {
    const env = new TestEnvironment({ wind: { fromDeg: 90, speed: 5 } });
    const ac = createAircraft('a320');
    ac.reset({ position: env.position(0), headingDeg: 0, speed: 0, onGround: true }, env);
    ac.controls.flaps = 1 / 4;
    const t = ac.telemetry;
    const start = { ...ac.state.position };
    let worstHeading = 0;
    let worstYawRate = 0;
    for (let i = 0; i < 40 / SIM_DT && t.ias / KT < 140; i++) {
      levers(ac, Math.min(1, t.time / 3));
      ac.controls.yaw = clamp(0.1 * headingError(0, t.headingDeg), -0.3, 0.3);
      ac.step(SIM_DT, env);
      worstHeading = Math.max(worstHeading, Math.abs(headingError(0, t.headingDeg)));
      if (t.groundSpeed > 10)
        worstYawRate = Math.max(worstYawRate, Math.abs(ac.state.angularVelocity.z) / DEG);
    }
    const up = env.up(start, { x: 0, y: 0, z: 0 });
    const d = {
      x: ac.state.position.x - start.x,
      y: ac.state.position.y - start.y,
      z: ac.state.position.z - start.z,
    };
    const east = { x: -Math.sin((7.5 * Math.PI) / 180), y: Math.cos((7.5 * Math.PI) / 180), z: 0 };
    const lateral = d.x * east.x + d.y * east.y + d.z * east.z;
    void up;
    expect(t.crashed).toBeUndefined();
    expect(worstHeading).toBeLessThan(3);
    expect(worstYawRate).toBeLessThan(2);
    expect(Math.abs(lateral)).toBeLessThan(10);
  }, 60_000);
});

/**
 * The crude landing: a stabilised approach at VAPP in CONF FULL from 3 NM on a 3° path,
 * stick neutral to 30 ft, then 0.6 aft held to the touch-down, idle from 20 ft.
 */
function crudeLanding(o: { sinkFpm?: number } = {}) {
  const env = new TestEnvironment();
  const ac = createAircraft('a320');
  ac.controls.flaps = 1;
  const h0 = 3 * 1852 * Math.tan(3 * DEG);
  ac.reset(
    { position: env.position(h0), headingDeg: 0, speed: 137 * KT, onGround: false, gearDown: true },
    env,
  );
  const t = ac.telemetry;
  const c = ac.controls;
  const b = t.avionics!.autopilot.airbus!;
  ac.cockpit.set('spoilersArmed', 1);
  ac.cockpit.set('autobrake', 2);
  // The approach thrust the reset trimmed, a hand keeping the speed and the 3° path.
  let lever = c.throttle[0]!;
  const vapp = 137;
  let touched = false;
  let sink = 0;
  let maxPitch = 0;
  let noseRate = 0;
  let wasNoseUp = true;
  for (let i = 0; i < 150 / SIM_DT && !t.crashed; i++) {
    const agl = (t.agl ?? 100) / FT;
    const gamma = Math.asin(clamp(t.verticalSpeed / Math.max(t.tas, 30), -1, 1));
    if (agl > 30) {
      // A pilot's light hand on the path (the law holds it) and the thrust for VAPP.
      const target = o.sinkFpm ? -Math.asin((o.sinkFpm * FPM) / t.tas) : -3 * DEG;
      c.pitch = agl > 60 ? clamp((t.tas / 9.81) * ((target - gamma) / 3), -0.2, 0.2) : 0;
      lever = clamp(lever + 0.01 * (vapp - t.ias / KT) * SIM_DT, 0, 0.8);
    } else c.pitch = touched ? 0 : key(c.pitch, true, SIM_DT);
    levers(ac, agl < 20 || touched ? 0 : lever);
    c.yaw = clamp(0.1 * headingError(0, t.headingDeg), -0.3, 0.3);
    ac.step(SIM_DT, env);
    if (!t.onGround) maxPitch = Math.max(maxPitch, t.pitch / DEG);
    if (t.onGround && !touched) {
      touched = true;
      sink = t.verticalSpeed / FPM;
    }
    // The nose comes down: its pitch rate when the attitude passes 1°.
    if (touched && wasNoseUp && t.pitch < 1 * DEG) {
      wasNoseUp = false;
      noseRate = ac.state.angularVelocity.y / DEG;
    }
    if (touched && t.groundSpeed < 1) break;
  }
  return {
    crashed: t.crashed,
    touched,
    sink,
    maxPitch,
    noseRate,
    stopped: t.groundSpeed < 1,
    spoilers: b.controls.groundSpoilers,
  };
}

describe('the crude pilot landing the A320', () => {
  it('lands held aft from 30 ft without a strike, and lowers the nose gently', () => {
    const r = crudeLanding();
    expect(r.crashed).toBeUndefined();
    expect(r.touched).toBe(true);
    expect(r.stopped).toBe(true);
    // Short of the tail strike attitude.
    expect(r.maxPitch).toBeLessThan(11);
    // The derotation: the nose wheel comes down at a few degrees a second, not slammed.
    expect(r.noseRate).toBeGreaterThan(-5);
  }, 60_000);

  it('takes a 600 ft/min touch-down', () => {
    const r = crudeLanding({ sinkFpm: 600 });
    expect(r.crashed).toBeUndefined();
    expect(r.touched).toBe(true);
  }, 60_000);
});
