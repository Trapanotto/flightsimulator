import { describe, expect, it } from 'vitest';
import { AIRPORTS, bearingDeg, findAirport, offsetPoint, runwayStart } from '../src/app/airports';
import { GEOID_HEIGHT, WorldEnvironment } from '../src/app/environment';
import { type InputEvents, PilotInput } from '../src/app/input';
import { emptyState, lerpState, stateToRenderPose } from '../src/app/pose';
import { LocalFrame, geodeticToEcef } from '../src/geo';
import { neutralControls } from '../src/sim';

const v = () => ({ x: 0, y: 0, z: 0 });
const BERN = { lon: 7.4972, lat: 46.9122, h: 560 };
const noEvents = (): InputEvents => ({ flapsDown: 0, flapsUp: 0, gearToggle: 0 });

/** Rotates a vector by a quaternion. */
function rotate(
  q: { x: number; y: number; z: number; w: number },
  p: { x: number; y: number; z: number },
) {
  const { x, y, z, w } = q;
  const ix = w * p.x + y * p.z - z * p.y;
  const iy = w * p.y + z * p.x - x * p.z;
  const iz = w * p.z + x * p.y - y * p.x;
  const iw = -x * p.x - y * p.y - z * p.z;
  return {
    x: ix * w + iw * -x + iy * -z - iz * -y,
    y: iy * w + iw * -y + iz * -x - ix * -z,
    z: iz * w + iw * -z + ix * -y - iy * -x,
  };
}

/** Body-to-ECEF quaternion of an aircraft flying level at lon/lat on a true heading. */
function levelOrientation(lon: number, lat: number, headingDeg: number) {
  const env = new WorldEnvironment({ ground: () => undefined }, () => new LocalFrame(lon, lat));
  const p = geodeticToEcef(lon, lat, 1000, v());
  const up = env.up(p, v());
  const north = env.north(p, v());
  const east = {
    x: north.y * up.z - north.z * up.y,
    y: north.z * up.x - north.x * up.z,
    z: north.x * up.y - north.y * up.x,
  };
  const h = (headingDeg * Math.PI) / 180;
  const fwd = {
    x: north.x * Math.cos(h) + east.x * Math.sin(h),
    y: north.y * Math.cos(h) + east.y * Math.sin(h),
    z: north.z * Math.cos(h) + east.z * Math.sin(h),
  };
  const down = { x: -up.x, y: -up.y, z: -up.z };
  const right = {
    x: down.y * fwd.z - down.z * fwd.y,
    y: down.z * fwd.x - down.x * fwd.z,
    z: down.x * fwd.y - down.y * fwd.x,
  };
  // Columns fwd, right, down -> quaternion (trace method is enough for these cases).
  const m = [fwd.x, right.x, down.x, fwd.y, right.y, down.y, fwd.z, right.z, down.z];
  const tr = m[0]! + m[4]! + m[8]!;
  let q;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    q = { w: 0.25 / s, x: (m[7]! - m[5]!) * s, y: (m[2]! - m[6]!) * s, z: (m[3]! - m[1]!) * s };
  } else if (m[0]! > m[4]! && m[0]! > m[8]!) {
    const s = 2 * Math.sqrt(1 + m[0]! - m[4]! - m[8]!);
    q = { w: (m[7]! - m[5]!) / s, x: 0.25 * s, y: (m[1]! + m[3]!) / s, z: (m[2]! + m[6]!) / s };
  } else if (m[4]! > m[8]!) {
    const s = 2 * Math.sqrt(1 + m[4]! - m[0]! - m[8]!);
    q = { w: (m[2]! - m[6]!) / s, x: (m[1]! + m[3]!) / s, y: 0.25 * s, z: (m[5]! + m[7]!) / s };
  } else {
    const s = 2 * Math.sqrt(1 + m[8]! - m[0]! - m[4]!);
    q = { w: (m[3]! - m[1]!) / s, x: (m[2]! + m[6]!) / s, y: (m[5]! + m[7]!) / s, z: 0.25 * s };
  }
  return { q, p };
}

describe('airports', () => {
  it('knows Bern-Belp and lines up on runway 32 heading north-west', () => {
    const lszb = findAirport('LSZB')!;
    const start = runwayStart(lszb, '32')!;
    expect(start.headingDeg).toBeGreaterThan(315);
    expect(start.headingDeg).toBeLessThan(325);
    const back = runwayStart(lszb, '14')!;
    expect(Math.abs(((back.headingDeg - start.headingDeg + 360) % 360) - 180)).toBeLessThan(0.5);
    expect(runwayStart(lszb, '99')).toBeUndefined();
  });

  it('has runway designators that match their headings', () => {
    for (const a of AIRPORTS)
      for (const r of a.runways)
        for (const i of [0, 1] as const) {
          const heading = bearingDeg(r.ends[i], r.ends[1 - i]!);
          // Designators are magnetic and rounded: within 12 degrees of the true heading here.
          const diff = Math.abs(((heading - Number(r.ends[i].ident) * 10 + 540) % 360) - 180);
          expect(diff, `${a.icao} ${r.ends[i].ident}`).toBeLessThan(12);
        }
  });

  it('offsets points by metres', () => {
    const p = offsetPoint({ lon: 7.5, lat: 46.9 }, 90, 1000);
    expect(p.lat).toBeCloseTo(46.9, 3);
    expect((p.lon - 7.5) * 111_320 * Math.cos((46.9 * Math.PI) / 180)).toBeCloseTo(1000, -1);
  });
});

describe('WorldEnvironment', () => {
  const frame = new LocalFrame(BERN.lon, BERN.lat, BERN.h);
  const flat = {
    ground: () => ({ height: BERN.h, normal: { x: 0, y: 1, z: 0 }, surface: 'grass' as const }),
  };
  const env = new WorldEnvironment(flat, () => frame);
  const p = geodeticToEcef(BERN.lon, BERN.lat, BERN.h + 1000, v());

  it('gives up, north and altitude from the ellipsoid', () => {
    const up = env.up(p, v());
    const north = env.north(p, v());
    expect(Math.hypot(up.x, up.y, up.z)).toBeCloseTo(1, 12);
    expect(up.x * north.x + up.y * north.y + up.z * north.z).toBeCloseTo(0, 12);
    expect(north.z).toBeGreaterThan(0);
    expect(env.altitude(p)).toBeCloseTo(BERN.h + 1000, 4);
  });

  it('returns the ground normal in world axes', () => {
    const g = env.ground(p)!;
    const up = env.up(p, v());
    expect(g.height).toBe(BERN.h);
    expect(g.normal.x).toBeCloseTo(up.x, 10);
    expect(g.normal.y).toBeCloseTo(up.y, 10);
    expect(g.normal.z).toBeCloseTo(up.z, 10);
  });

  it('uses sea-level altitude for the air and blows the wind the right way', () => {
    const air = env.air(p, { wind: v(), density: 0, temperature: 0, pressure: 0 });
    // 1560 m above the ellipsoid is about 1510 m above sea level.
    expect(air.pressure).toBeCloseTo(84_400, -3);
    expect(GEOID_HEIGHT).toBeGreaterThan(45);
    expect(Math.hypot(air.wind.x, air.wind.y, air.wind.z)).toBe(0);
    // A west wind (from 270) moves the air east.
    env.air_ = { windFromDeg: 270, windSpeed: 10, isaDeviation: 0, wetness: 0 };
    const w = env.air(p, { wind: v(), density: 0, temperature: 0, pressure: 0 }).wind;
    const local = frame.dirToLocal(w, v());
    expect(local.x).toBeGreaterThan(10);
    expect(Math.abs(local.z)).toBeLessThan(1e-6);
    expect(Math.abs(local.y)).toBeLessThan(1e-6);
  });
});

describe('stateToRenderPose', () => {
  const frame = new LocalFrame(BERN.lon, BERN.lat, BERN.h);

  it('draws an aircraft heading north with its nose to -z and its roof up', () => {
    const { q, p } = levelOrientation(BERN.lon, BERN.lat, 0);
    const state = { ...emptyState(), position: p, orientation: q };
    const pose = stateToRenderPose(state, frame, { position: v(), quaternion: { ...q } });
    // Model axes: z forward, y up, x left.
    const nose = rotate(pose.quaternion, { x: 0, y: 0, z: 1 });
    const roof = rotate(pose.quaternion, { x: 0, y: 1, z: 0 });
    const left = rotate(pose.quaternion, { x: 1, y: 0, z: 0 });
    expect(nose.z).toBeCloseTo(-1, 9);
    expect(roof.y).toBeCloseTo(1, 9);
    // Heading north, the left wing points west (-x).
    expect(left.x).toBeCloseTo(-1, 9);
    // 1000 m above the ellipsoid, seen from a frame whose origin is at 560 m.
    expect(pose.position.y).toBeCloseTo(1000 - BERN.h, 3);
  });

  it('draws an aircraft heading east with its nose to +x', () => {
    const { q, p } = levelOrientation(BERN.lon, BERN.lat, 90);
    const state = { ...emptyState(), position: p, orientation: q };
    const pose = stateToRenderPose(state, frame, { position: v(), quaternion: { ...q } });
    const nose = rotate(pose.quaternion, { x: 0, y: 0, z: 1 });
    expect(nose.x).toBeCloseTo(1, 9);
  });

  it('blends states halfway', () => {
    const a = emptyState();
    const b = emptyState();
    b.position.x = 10;
    b.orientation = { x: 0, y: 0, z: Math.sin(0.1), w: Math.cos(0.1) };
    const mid = lerpState(a, b, 0.5, emptyState());
    expect(mid.position.x).toBe(5);
    expect(
      Math.hypot(mid.orientation.x, mid.orientation.y, mid.orientation.z, mid.orientation.w),
    ).toBeCloseTo(1, 12);
    expect(mid.orientation.z).toBeCloseTo(Math.sin(0.05), 4);
  });
});

describe('PilotInput', () => {
  const run = (input: PilotInput, seconds: number, held: string[], events = noEvents()) => {
    const out = neutralControls(1);
    const down = (c: string) => held.includes(c);
    for (let t = 0; t < seconds; t += 1 / 60)
      input.update(
        1 / 60,
        down,
        null,
        null,
        t === 0 ? events : noEvents(),
        { invertPitch: false },
        out,
      );
    return out;
  };

  it('moves the yoke gradually while a key is held and centres it afterwards', () => {
    const input = new PilotInput();
    const short = run(input, 0.1, ['KeyS']);
    expect(short.pitch).toBeGreaterThan(0.1);
    expect(short.pitch).toBeLessThan(0.3);
    expect(run(input, 1, ['KeyS']).pitch).toBe(1);
    expect(run(input, 1, []).pitch).toBe(0);
    expect(run(input, 1, ['KeyW']).pitch).toBe(-1);
  });

  it('rolls and yaws with their keys and inverts pitch on request', () => {
    const input = new PilotInput();
    const out = run(input, 1, ['ArrowRight', 'KeyQ']);
    expect(out.roll).toBe(1);
    expect(out.yaw).toBe(-1);
    const inv = neutralControls(1);
    const i2 = new PilotInput();
    for (let i = 0; i < 60; i++)
      i2.update(1 / 60, (c) => c === 'KeyS', null, null, noEvents(), { invertPitch: true }, inv);
    expect(inv.pitch).toBe(-1);
  });

  it('keeps the throttle where it was left and steps the flaps in notches', () => {
    const input = new PilotInput();
    input.reset(0, 0, true);
    expect(run(input, 1, ['ShiftLeft']).throttle[0]).toBeCloseTo(0.45, 1);
    expect(run(input, 1, []).throttle[0]).toBeCloseTo(0.45, 1);
    expect(run(input, 0.02, [], { flapsDown: 1, flapsUp: 0, gearToggle: 0 }).flaps).toBeCloseTo(
      1 / 3,
    );
    expect(run(input, 0.02, [], { flapsDown: 5, flapsUp: 0, gearToggle: 0 }).flaps).toBe(1);
    expect(run(input, 0.02, [], { flapsDown: 0, flapsUp: 1, gearToggle: 0 }).flaps).toBeCloseTo(
      2 / 3,
    );
    expect(run(input, 0.02, [], { flapsDown: 0, flapsUp: 0, gearToggle: 1 }).gearDown).toBe(false);
  });

  it('lets a gamepad or the touch stick override the keys', () => {
    const input = new PilotInput();
    const out = neutralControls(1);
    const pad = { pitch: 0.5, roll: -0.25, yaw: 0, throttleUp: 0, throttleDown: 0, brake: true };
    input.update(1 / 60, () => false, pad, null, noEvents(), { invertPitch: false }, out);
    expect(out.pitch).toBe(0.5);
    expect(out.roll).toBe(-0.25);
    expect(out.brakeLeft).toBe(1);
    const touch = { pitch: -1, roll: null, yaw: null, throttle: 0.8, brake: false };
    input.update(1 / 60, () => false, pad, touch, noEvents(), { invertPitch: false }, out);
    expect(out.pitch).toBe(-1);
    expect(out.roll).toBe(-0.25);
    expect(out.throttle[0]).toBe(0.8);
  });
});
