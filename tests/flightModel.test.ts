import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { AIRCRAFT, A320, C172, PC12, type AircraftType } from '../src/aircraft/types';
import {
  type FlightEvent,
  type FlightInput,
  FlightModel,
  stallSpeed,
  topSpeed,
} from '../src/physics/FlightModel';

/** Flat ground at y = 0, +Y up, sea level. */
const flat = {
  up: (_p: Vector3, out: Vector3) => out.set(0, 1, 0),
  heightAboveGround: (p: Vector3) => p.y,
  altitude: (p: Vector3) => p.y,
};
const NORTH = new Vector3(0, 0, -1);
const DEG = Math.PI / 180;
const DT = 1 / 120;
const idle = (): FlightInput => ({
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle: 0,
  boost: false,
  brake: false,
});

function run(m: FlightModel, seconds: number, input: FlightInput | ((t: number) => FlightInput)) {
  const events: FlightEvent[] = [];
  for (let t = 0; t < seconds && !m.crashed; t += DT)
    m.step(DT, typeof input === 'function' ? input(t) : input, events);
  return events;
}

function onRunway(type: AircraftType = C172) {
  const m = new FlightModel(flat, type.physics);
  m.reset(new Vector3(0, type.physics.gearHeight, 0), NORTH, 0, true);
  return m;
}

function inAir(type: AircraftType, speed: number, height = 1500) {
  const m = new FlightModel(flat, type.physics);
  m.gearDown = type.physics.fixedGear;
  m.reset(new Vector3(0, height, 0), NORTH, speed, false);
  m.gearDown = type.physics.fixedGear;
  return m;
}

/**
 * A simple pilot: flies the pitch attitude that gives the wanted vertical speed (flight path
 * angle + angle of attack) with pitch-rate damping, wings level with the ailerons.
 */
function holdVs(m: FlightModel, vs: number, throttle: number): FlightInput {
  const gamma = Math.asin(Math.max(-1, Math.min(1, vs / Math.max(m.speed, 1))));
  const correction = Math.max(-0.05, Math.min(0.05, (vs - m.verticalSpeed) * 0.01));
  const theta = gamma + m.alpha + correction;
  const pitchRate = -m.omega.x;
  return {
    ...idle(),
    throttle,
    pitch: Math.max(-1, Math.min(1, (theta - m.pitch) * 4 - pitchRate * 2)),
    roll: Math.max(-1, Math.min(1, -m.bank * 2 - m.omega.z * 0.5)),
  };
}

describe('6-DOF flight model', () => {
  it('stands still on the runway, resting on its springs', () => {
    const m = onRunway();
    run(m, 5, idle());
    expect(m.crashed).toBe(false);
    expect(m.onGround).toBe(true);
    expect(m.speed).toBeLessThan(0.3);
    expect(Math.abs(m.position.y - C172.physics.gearHeight)).toBeLessThan(0.25);
  });

  it('stays put when the terrain under it gets more detailed (jumps up)', () => {
    let offset = 0;
    const env = { ...flat, heightAboveGround: (p: Vector3) => p.y - offset };
    const m = new FlightModel(env, C172.physics);
    m.reset(new Vector3(0, C172.physics.gearHeight + 0.35, 0), NORTH, 0, true);
    const ev = run(m, 2, idle());
    offset = 0.4;
    ev.push(...run(m, 4, idle()));
    offset = -1.7; // and a coarser tile under it: the ground drops away
    ev.push(...run(m, 4, idle()));
    expect(ev.some((e) => e.type === 'crash')).toBe(false);
    expect(m.onGround).toBe(true);
    expect(m.speed).toBeLessThan(0.5);
  });

  it('a trimmed aircraft flies on hands-off without diverging', () => {
    for (const type of AIRCRAFT) {
      const v = stallSpeed(type.physics) * 1.5;
      const m = inAir(type, v);
      run(m, 20, { ...idle(), throttle: 0.5 });
      expect(m.crashed, type.id).toBe(false);
      expect(Math.abs(m.bank), type.id).toBeLessThan(15 * DEG);
      expect(Math.abs(m.pitch), type.id).toBeLessThan(25 * DEG);
    }
  });

  it('ailerons roll right, the elevator pitches the nose up', () => {
    const r = inAir(C172, 50);
    run(r, 1, { ...idle(), throttle: 0.6, roll: 1 });
    expect(r.bank).toBeGreaterThan(20 * DEG);
    const p = inAir(C172, 50);
    const before = p.pitch;
    run(p, 1, { ...idle(), throttle: 0.6, pitch: 1 });
    expect(p.pitch - before).toBeGreaterThan(8 * DEG);
  });

  it('stalls when pulled too slow: the nose drops, letting go recovers', () => {
    const m = inAir(C172, 30);
    let stalled = false;
    run(m, 8, () => {
      stalled ||= m.stalled;
      return { ...idle(), pitch: 1 };
    });
    expect(stalled).toBe(true);
    run(m, 12, () => holdVs(m, 0, 0.8));
    expect(m.crashed).toBe(false);
    expect(m.stalled).toBe(false);
    expect(m.speed).toBeGreaterThan(stallSpeed(C172.physics));
  });

  it('brakes to a stop', () => {
    const m = onRunway();
    m.velocity.copy(m.forward).multiplyScalar(25);
    const start = m.position.clone();
    run(m, 30, { ...idle(), brake: true });
    expect(m.speed).toBeLessThan(0.5);
    expect(m.position.distanceTo(start)).toBeLessThan(250);
  });

  it('crashes on a hard landing, without gear, and when flying into the ground', () => {
    const hard = inAir(C172, 35, 6);
    hard.velocity.y = -7;
    expect(run(hard, 3, { ...idle() }).some((e) => e.type === 'crash')).toBe(true);
    const belly = inAir(PC12, 50, 4);
    belly.gearDown = false;
    const ev = run(belly, 4, () => holdVs(belly, -1.5, 0.2));
    expect(ev.find((e) => e.type === 'crash')).toMatchObject({ reason: 'gear-up' });
    const dive = inAir(C172, 60, 30);
    const ev2 = run(dive, 10, { ...idle(), throttle: 1, pitch: -1 });
    expect(ev2.some((e) => e.type === 'crash')).toBe(true);
  });
});

describe('fleet performance (published figures)', () => {
  // Clean stall (m/s), sea-level top speed (m/s).
  const published: Record<string, { vs: [number, number]; top: [number, number] }> = {
    c172: { vs: [23, 28], top: [55, 75] },
    pc12: { vs: [38, 48], top: [110, 145] },
    phenom100: { vs: [48, 58], top: [180, 260] },
    f35: { vs: [62, 80], top: [300, 380] },
    a320: { vs: [70, 82], top: [240, 320] },
  };
  for (const type of AIRCRAFT) {
    const ref = published[type.id];
    if (!ref) continue;
    it(`${type.id}: stall and top speed match, takes off, lands softly`, () => {
      const p = type.physics;
      const vs = stallSpeed(p);
      expect(vs).toBeGreaterThan(ref.vs[0]);
      expect(vs).toBeLessThan(ref.vs[1]);
      const top = topSpeed(p);
      expect(top).toBeGreaterThan(ref.top[0]);
      expect(top).toBeLessThan(ref.top[1]);

      // Take-off: half flaps, full power, rotate at 1.1 Vs (half flaps) to ~8 deg.
      const m = onRunway(type);
      m.flaps = 0.5;
      const vr = stallSpeed(p, 0.5) * 1.1;
      const events = run(m, 90, () => ({
        ...idle(),
        throttle: 1,
        pitch:
          m.speed > vr ? Math.max(-1, Math.min(1, (8 * DEG - m.pitch) * 3 + m.omega.x * 1.5)) : 0,
        roll: Math.max(-1, Math.min(1, -m.bank * 2)),
      }));
      expect(
        events.find((e) => e.type === 'liftoff'),
        `${type.id} lift-off`,
      ).toBeDefined();
      expect(m.crashed, JSON.stringify(events)).toBe(false);
      expect(m.position.y).toBeGreaterThan(30);

      // Landing: full flaps, 1.3 Vs on a -3 deg path, flare near the ground.
      const v = stallSpeed(p, 1) * 1.3;
      const l = new FlightModel(flat, p);
      l.flaps = 1;
      l.gearDown = true;
      l.reset(new Vector3(0, 40 + p.gearHeight, 0), NORTH, v, false);
      l.gearDown = true;
      l.flaps = 1;
      // Flare height grows with size: about 8 m for a Cessna, 15 m for an A320.
      const flare = Math.max(8, type.length * 0.4);
      const ev = run(l, 120, () => {
        const h = l.position.y - p.gearHeight;
        const target = h > flare ? -v * 0.052 : -0.6;
        return l.onGround ? { ...idle(), brake: true } : holdVs(l, target, h > flare ? 0.35 : 0.1);
      });
      expect(
        ev.some((e) => e.type === 'crash'),
        JSON.stringify(ev),
      ).toBe(false);
      expect(ev.some((e) => e.type === 'touchdown')).toBe(true);
    });
  }

  it('the A320 needs a far faster approach than the Cessna', () => {
    expect(stallSpeed(A320.physics, 1)).toBeGreaterThan(stallSpeed(C172.physics, 1) * 2);
  });
});
