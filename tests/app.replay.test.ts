import { describe, expect, it } from 'vitest';
import { FlightRecording, ReplayPlayer, pictureName, type RecordSource } from '../src/app/replay';
import {
  type AircraftId,
  type Cockpit,
  SIM_DT,
  TestEnvironment,
  type Telemetry,
  createAircraft,
  neutralControls,
} from '../src/sim';

/** A hand-made aircraft whose values the test sets directly. */
function fakeSource() {
  const values = new Map<string, number>([['flaps', 0]]);
  const cockpit: Cockpit = {
    specs: [{ id: 'flaps', kind: 'lever', initial: 0 }] as Cockpit['specs'],
    get: (id) => values.get(id) ?? 0,
    set: (id, v) => values.set(id, v),
    has: (id) => values.has(id),
  };
  const source = {
    state: {
      position: { x: 0, y: 0, z: 0 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      velocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
    },
    telemetry: { time: 0, headingDeg: 0, gear: 1, onGround: false, crashed: undefined },
    controls: neutralControls(1),
    cockpit,
  };
  return source as typeof source & RecordSource;
}

const yaw = (deg: number) => {
  const h = (deg * Math.PI) / 180 / 2;
  return { x: 0, y: 0, z: Math.sin(h), w: Math.cos(h) };
};

describe('FlightRecording', () => {
  it('keeps a fixed rate in a ring and overwrites the oldest frames', () => {
    const rec = new FlightRecording({ rate: 20, seconds: 1 });
    const src = fakeSource();
    for (let f = 0; f <= 180; f++) rec.record(f / 60, src);
    // 3 s at 20 Hz is 61 samples; one second (plus the frame closing it) is held.
    expect(rec.length).toBe(rec.capacity);
    expect(rec.end).toBeCloseTo(3, 6);
    expect(rec.duration).toBeCloseTo(1, 6);
    // Time going back is a restarted flight: a new recording.
    rec.record(0.5, src);
    expect(rec.length).toBe(1);
    expect(rec.start).toBe(0.5);
  });

  it('blends between frames: headings across north, the short arc of the rotation', () => {
    const rec = new FlightRecording({ rate: 10 });
    const src = fakeSource();
    src.telemetry.headingDeg = 359.2;
    src.state.orientation = yaw(350);
    src.state.velocity.x = 50;
    rec.record(0, src);
    src.telemetry.headingDeg = 0.8;
    src.telemetry.gear = 0.5;
    src.telemetry.onGround = true;
    // The same rotation as -q: blending must not swing the long way round.
    const q = yaw(10);
    src.state.orientation = { x: -q.x, y: -q.y, z: -q.z, w: -q.w };
    src.state.position.x = 5;
    rec.record(0.1, src);

    const frame = rec.sample(0.05, rec.createFrame());
    const t = frame.telemetry as unknown as typeof src.telemetry;
    expect(t.headingDeg).toBeCloseTo(0, 4);
    expect(t.gear).toBeCloseTo(0.75, 6);
    // Booleans come from the earlier frame.
    expect(t.onGround).toBe(false);
    // Halfway from 350° to 10° is 0°: the identity (up to sign).
    expect(Math.abs(frame.state.orientation.w)).toBeCloseTo(1, 6);
    // Constant speed: the cubic is the straight line.
    expect(frame.state.position.x).toBeCloseTo(2.5, 9);
    const yawAt = (s: number) => {
      const q = rec.sample(s, rec.createFrame()).state.orientation;
      return 2 * Math.atan2(q.z * Math.sign(q.w), Math.abs(q.w)) * (180 / Math.PI);
    };
    // No jump across the frames: a quarter of the way is a quarter of the 20°.
    expect(yawAt(0.025)).toBeCloseTo(-5, 4);
  });

  it.each(['c172', 'pc12', 'a320', 'fa18'] as AircraftId[])(
    'gives back what a %s showed at the sampled times',
    (id) => {
      const env = new TestEnvironment();
      const ac = createAircraft(id);
      ac.reset({ position: env.position(1200), headingDeg: 355, speed: 90, onGround: false }, env);
      const rec = new FlightRecording();
      const kept: { time: number; telemetry: Telemetry; controls: unknown; cockpit: number[] }[] =
        [];
      let time = 0;
      for (let f = 0; f < 240; f++) {
        // Something moving: a turn with the flaps and gear going.
        ac.controls.roll = Math.sin(f / 40) * 0.5;
        ac.controls.pitch = 0.1;
        if (f === 60) {
          ac.controls.gearDown = !ac.controls.gearDown;
          ac.cockpit.set('flaps', 1);
          ac.controls.flaps = 0.5;
        }
        ac.step(SIM_DT, env);
        ac.step(SIM_DT, env);
        time += 2 * SIM_DT;
        if (rec.record(time, ac))
          kept.push({
            time,
            telemetry: structuredClone(ac.telemetry),
            controls: structuredClone(ac.controls),
            cockpit: ac.cockpit.specs.map((s) => ac.cockpit.get(s.id)),
          });
      }
      expect(kept.length).toBeGreaterThan(20);
      const frame = rec.createFrame();
      for (const k of kept) {
        rec.sample(k.time, frame);
        expectSame(frame.telemetry, k.telemetry, 'telemetry');
        expectSame(frame.controls, k.controls, 'controls');
        expect(ac.cockpit.specs.map((s) => frame.cockpit.get(s.id))).toEqual(
          k.cockpit.map((v) => Math.fround(v)),
        );
      }
    },
  );
});

/** Deep equality with numbers to single precision (the recording stores floats). */
function expectSame(got: unknown, want: unknown, path: string) {
  if (typeof want === 'number' && typeof got === 'number') {
    if (Number.isNaN(want)) expect(got, path).toBeNaN();
    else expect(got, path).toBe(Math.fround(want));
    return;
  }
  if (typeof want !== 'object' || want === null || Array.isArray(want) !== Array.isArray(got)) {
    expect(got, path).toBe(want);
    return;
  }
  const g = got as Record<string, unknown>;
  const w = want as Record<string, unknown>;
  if (Array.isArray(want)) expect((got as unknown[]).length, path).toBe(want.length);
  for (const key of Object.keys(w)) expectSame(g[key], w[key], `${path}.${key}`);
}

describe('ReplayPlayer', () => {
  it('plays at its speed, seeks within the recording and stops at the end', () => {
    const rec = new FlightRecording();
    const src = fakeSource();
    for (let f = 0; f <= 200; f++) rec.record(10 + f / 20, src);
    const player = new ReplayPlayer(rec);
    expect(player.time).toBe(10);
    player.setSpeed(2);
    expect(player.advance(0.5)).toBeCloseTo(1, 9);
    expect(player.time).toBeCloseTo(11, 9);
    player.seek(-5);
    expect(player.time).toBe(10);
    player.seek(19.5);
    expect(player.advance(1)).toBeCloseTo(0.5, 9);
    expect(player.time).toBe(20);
    expect(player.playing).toBe(false);
    expect(player.advance(1)).toBe(0);
    expect(player.view()).toEqual({ time: 20, start: 10, end: 20, playing: false, speed: 2 });
    // Play at the end starts over.
    player.play(true);
    expect(player.time).toBe(10);
    expect(player.frame().time).toBe(10);
  });
});

it('names a picture by aircraft and local time', () => {
  expect(pictureName('Pilatus PC-12', new Date(2026, 5, 21, 9, 5, 7))).toBe(
    'trapanotto-pilatus-pc-12-2026-06-21-090507.png',
  );
});
