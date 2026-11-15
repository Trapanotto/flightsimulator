/**
 * A crude pilot, as a keyboard gives it: full aft stick or nothing. Take-offs pulled off at
 * any speed and landings held full aft must never break the aircraft; at too low a speed it
 * simply does not fly yet. Flown on both types.
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT, TestEnvironment, createAircraft, type AircraftId } from '../../src/sim';
import { DEG, FT, KT, clamp, headingError } from './harness';

function takeoff(id: AircraftId, flaps: number, rotateKt: number) {
  const env = new TestEnvironment();
  const ac = createAircraft(id);
  ac.controls.flaps = flaps;
  ac.reset({ position: env.position(0), headingDeg: 0, speed: 0, onGround: true }, env);
  const t = ac.telemetry;
  const c = ac.controls;
  let maxAgl = 0;
  let pushedOnGround = false;
  for (let i = 0; i < 90 / SIM_DT && !t.crashed; i++) {
    c.throttle[0] = Math.min(1, t.time / 3);
    c.yaw = clamp(0.35 * headingError(0, t.headingDeg), -1, 1);
    c.pitch = t.ias > rotateKt * KT && t.pitch < 8 * DEG ? 1 : 0;
    ac.step(SIM_DT, env);
    maxAgl = Math.max(maxAgl, t.agl ?? 0);
    pushedOnGround ||= t.onGround && t.stickPusher === true;
  }
  return { crashed: t.crashed, maxAgl, kias: t.ias / KT, pushedOnGround };
}

/** Approach at a steady power and attitude; full aft stick from the flare height to the stop. */
function landing(id: AircraftId, flaps: number, kias: number, flare: number) {
  const env = new TestEnvironment();
  const ac = createAircraft(id);
  ac.controls.flaps = flaps;
  ac.reset(
    {
      position: env.position(300 * FT),
      headingDeg: 0,
      speed: kias * KT,
      onGround: false,
      gearDown: true,
    },
    env,
  );
  const t = ac.telemetry;
  const c = ac.controls;
  const approach = c.throttle[0]! * 0.6;
  let touched = false;
  for (let i = 0; i < 120 / SIM_DT && !t.crashed; i++) {
    const agl = t.agl ?? 100;
    c.throttle[0] = agl < flare ? 0 : approach;
    c.pitch = agl < flare ? 1 : 0;
    c.yaw = clamp(0.35 * headingError(0, t.headingDeg), -1, 1);
    touched ||= t.onGround;
    c.brakeLeft = c.brakeRight = touched ? 1 : 0;
    ac.step(SIM_DT, env);
    if (touched && t.groundSpeed < 0.5) break;
  }
  return { crashed: t.crashed, stopped: t.groundSpeed < 0.5 };
}

/** A firm arrival: the trimmed approach turned into a straight sink onto the wheels. */
function firm(id: AircraftId, flaps: number, kias: number, sinkFpm: number, pitch: number) {
  const env = new TestEnvironment();
  const ac = createAircraft(id);
  ac.controls.flaps = flaps;
  ac.reset(
    { position: env.position(4), headingDeg: 0, speed: kias * KT, onGround: false, gearDown: true },
    env,
  );
  const up = env.up(ac.state.position, { x: 0, y: 0, z: 0 });
  const sink = sinkFpm * (FT / 60);
  ac.state.velocity.x -= up.x * sink;
  ac.state.velocity.y -= up.y * sink;
  ac.state.velocity.z -= up.z * sink;
  ac.controls.throttle[0] = 0;
  for (let i = 0; i < 6 / SIM_DT && !ac.telemetry.crashed; i++) {
    ac.controls.pitch = pitch;
    ac.step(SIM_DT, env);
  }
  return ac.telemetry.crashed;
}

describe('a crude pilot cannot break the PC-12', () => {
  for (const flaps of [0, 1 / 3, 2 / 3])
    it(`takes off with full aft stick from 60 to 100 KIAS, flaps lever ${flaps.toFixed(2)}`, () => {
      for (const vr of [60, 70, 83, 100]) {
        const r = takeoff('pc12', flaps, vr);
        expect(r.crashed, `rotating at ${vr} kt`).toBeUndefined();
        expect(r.maxAgl, `rotating at ${vr} kt`).toBeGreaterThan(50);
        // The pusher is inhibited on the wheels.
        expect(r.pushedOnGround).toBe(false);
      }
    }, 60_000);

  it('lands held full aft through the flare and the roll-out', () => {
    for (const flaps of [2 / 3, 1]) {
      const r = landing('pc12', flaps, 90, 5);
      expect(r.crashed).toBeUndefined();
      expect(r.stopped).toBe(true);
    }
  }, 30_000);

  it('takes a firm touch-down at 600 ft/min, and the published limit sink of 10 ft/s', () => {
    for (const [sink, pitch] of [
      [600, 0],
      [600, 1],
      [600, -0.5],
    ] as const)
      expect(firm('pc12', 1, 85, sink, pitch), `${sink} ft/min, stick ${pitch}`).toBeUndefined();
    // Far past the limit it breaks.
    expect(firm('pc12', 1, 85, 2000, 0)).toBe('gear');
  }, 30_000);
});

describe('the same crude pilot in the Cessna', () => {
  it('takes off pulled full aft from 40 to 65 KIAS, flaps 0 and 10', () => {
    for (const flaps of [0, 1 / 3])
      for (const vr of [40, 50, 65]) {
        const r = takeoff('c172', flaps, vr);
        expect(r.crashed, `flaps ${flaps}, ${vr} kt`).toBeUndefined();
        expect(r.maxAgl, `flaps ${flaps}, ${vr} kt`).toBeGreaterThan(30);
      }
  }, 60_000);

  it('lands held full aft and takes a 600 ft/min arrival', () => {
    const r = landing('c172', 1, 65, 3);
    expect(r.crashed).toBeUndefined();
    expect(r.stopped).toBe(true);
    expect(firm('c172', 1, 60, 600, 1)).toBeUndefined();
  }, 30_000);
});
