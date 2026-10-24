import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { type FlightEvent, type FlightInput, FlightModel, TR1 } from '../src/physics/FlightModel';

/** Flat ground at y = 0, +Y up. */
const flat = {
  up: (_p: Vector3, out: Vector3) => out.set(0, 1, 0),
  heightAboveGround: (p: Vector3) => p.y,
};
const NORTH = new Vector3(0, 0, -1);
const idle = (): FlightInput => ({
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle: 0,
  boost: false,
  brake: false,
});
const DT = 1 / 120;

function run(m: FlightModel, seconds: number, input: FlightInput | ((t: number) => FlightInput)) {
  const events: FlightEvent[] = [];
  for (let t = 0; t < seconds; t += DT)
    m.step(DT, typeof input === 'function' ? input(t) : input, events);
  return events;
}

function onRunway() {
  const m = new FlightModel(flat);
  m.reset(new Vector3(0, TR1.gearHeight, 0), NORTH, 0, true);
  return m;
}

function inAir(speed = 75, height = 1000) {
  const m = new FlightModel(flat);
  m.gearDown = false;
  m.reset(new Vector3(0, height, 0), NORTH, speed, false);
  m.gearDown = false;
  return m;
}

describe('flight model', () => {
  it('faces the requested direction after reset', () => {
    const m = onRunway();
    expect(m.forward.z).toBeCloseTo(-1, 5);
    expect(m.up.y).toBeCloseTo(1, 5);
    expect(m.bank).toBeCloseTo(0, 5);
  });

  it('takes off in less than 1 km with full throttle and a pull at rotate speed', () => {
    const m = onRunway();
    // Rotate to 10° nose up, then hold it.
    const pull = () =>
      m.speed > TR1.rotateSpeed
        ? Math.max(-1, Math.min(1, (10 * (Math.PI / 180) - m.pitch) * 4))
        : 0;
    const events = run(m, 40, () => ({ ...idle(), throttle: 1, pitch: pull() }));
    const lo = events.find((e) => e.type === 'liftoff');
    expect(lo).toBeDefined();
    expect(m.position.y).toBeGreaterThan(50);
    expect(m.crashed).toBe(false);
    // Distance to lift-off: rerun until airborne.
    const m2 = onRunway();
    for (let t = 0; t < 40 && m2.onGround; t += DT)
      m2.step(DT, { ...idle(), throttle: 1, pitch: m2.speed > TR1.rotateSpeed ? 0.6 : 0 });
    const liftoffAt = -m2.position.z;
    expect(liftoffAt).toBeLessThan(1000);
    expect(liftoffAt).toBeGreaterThan(250);
  });

  it('reaches about 140 m/s in level flight at full throttle', () => {
    const m = inAir(80, 2000);
    run(m, 120, () => ({
      ...idle(),
      throttle: 1,
      pitch: Math.max(-1, Math.min(1, -m.verticalSpeed * 0.05 - m.pitch * 2)),
    }));
    expect(m.speed).toBeGreaterThan(125);
    expect(m.speed).toBeLessThan(150);
  });

  it('turns when banked and returns to wings level (easy assist)', () => {
    const m = inAir();
    run(m, 1.0, { ...idle(), throttle: 0.7, roll: 0.4 });
    expect(m.bank).toBeGreaterThan(0.3);
    const before = m.forward.clone();
    run(m, 3, { ...idle(), throttle: 0.7 });
    // Nose moved to the right (east = +X when facing north = -Z).
    expect(m.forward.x).toBeGreaterThan(before.x);
    expect(Math.abs(m.bank)).toBeLessThan(0.1);
  });

  it('rolls right with positive roll input', () => {
    const m = inAir();
    run(m, 0.3, { ...idle(), throttle: 0.7, roll: 1 });
    expect(m.bank).toBeGreaterThan(0.5);
  });

  it('pitches up with positive pitch input', () => {
    const m = inAir();
    run(m, 0.5, { ...idle(), throttle: 0.7, pitch: 1 });
    expect(m.pitch).toBeGreaterThan(0.3);
  });

  it('stalls softly when too slow: sinks and nose drops, no crash at altitude', () => {
    const m = inAir(32, 1500);
    run(m, 15, { ...idle(), throttle: 0, pitch: 0.8 });
    expect(m.crashed).toBe(false);
    expect(m.position.y).toBeLessThan(1500);
  });

  function approach(sinkRate: number, gearDown = true) {
    const m = new FlightModel(flat);
    m.reset(new Vector3(0, 40, 0), NORTH, 42, false);
    m.gearDown = gearDown;
    m.flaps = 1;
    // Elevator holds the sink rate, throttle holds 40 m/s (how a pilot flies an approach).
    return run(m, 60, () => {
      const vsErr = -sinkRate - m.verticalSpeed;
      return {
        ...idle(),
        pitch: Math.max(-1, Math.min(1, vsErr * 0.25 - m.pitch * 0.5)),
        throttle: Math.max(0, Math.min(1, 0.45 + (40 - m.speed) * 0.08)),
      };
    });
  }

  it('lands softly from a gentle approach', () => {
    const events = approach(1.0);
    const td = events.find((e) => e.type === 'touchdown');
    expect(events.some((e) => e.type === 'crash')).toBe(false);
    expect(td).toBeDefined();
  });

  it('crashes on a too hard landing', () => {
    const events = approach(8);
    expect(events.find((e) => e.type === 'crash')).toMatchObject({ reason: 'hard-landing' });
  });

  it('crashes when landing with the gear up', () => {
    const events = approach(1.0, false);
    expect(events.find((e) => e.type === 'crash')).toMatchObject({ reason: 'gear-up' });
  });

  it('crashes when flying into the ground', () => {
    const m = inAir(90, 200);
    const events = run(m, 20, { ...idle(), throttle: 1, pitch: -1 });
    expect(m.crashed).toBe(true);
    expect(events.some((e) => e.type === 'crash')).toBe(true);
  });

  it('brakes to a stop on the runway', () => {
    const m = onRunway();
    m.speed = 30;
    m.direction.copy(m.forward);
    run(m, 20, { ...idle(), brake: true });
    expect(m.speed).toBe(0);
    expect(m.onGround).toBe(true);
  });
});

describe('ground handling', () => {
  it('stays on the runway when the terrain under it drops (detail refinement)', () => {
    let ground = 0;
    const env = {
      up: (_p: Vector3, out: Vector3) => out.set(0, 1, 0),
      heightAboveGround: (p: Vector3) => p.y - ground,
    };
    const m = new FlightModel(env);
    m.reset(new Vector3(0, TR1.gearHeight, 0), NORTH, 0, true);
    run(m, 0.5, idle());
    ground = -40; // more detailed tile: the real ground is 40 m lower
    const events = run(m, 2, idle());
    expect(m.onGround).toBe(true);
    expect(m.crashed).toBe(false);
    expect(m.position.y).toBeCloseTo(-40 + TR1.gearHeight, 1);
    expect(events.length).toBe(0);
  });
});
