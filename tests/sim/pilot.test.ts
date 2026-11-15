/**
 * The pilot outside the aircraft: free fall, the parachute, landings, walking, and leaving
 * the aircraft in the three ways.
 */
import { describe, expect, it } from 'vitest';
import {
  Parachutist,
  type ParachutistEvent,
  type ParachutistInput,
  type ParachutistView,
  SIM_DT,
  TERMINAL_VELOCITY,
  TestEnvironment,
  canEnter,
  createAircraft,
  leaveAircraft,
} from '../../src/sim';

const idle = (): ParachutistInput => ({ x: 0, y: 0, run: false, pull: false });
const view = (): ParachutistView => ({
  state: 'walk',
  agl: 0,
  speed: 0,
  verticalSpeed: 0,
  headingDeg: 0,
});

const air = { wind: { x: 0, y: 0, z: 0 }, density: 0, temperature: 0, pressure: 0 };
const density = (env: TestEnvironment, p: Parachutist) => env.air(p.state.position, air).density;

/** A velocity straight down at `speed`. */
function down(env: TestEnvironment, speed: number) {
  const u = env.up(env.origin, { x: 0, y: 0, z: 0 });
  return { x: -u.x * speed, y: -u.y * speed, z: -u.z * speed };
}

/** Runs until `until` says stop (or `seconds` pass), collecting the events. */
function run(
  p: Parachutist,
  env: TestEnvironment,
  seconds: number,
  input: (p: Parachutist) => ParachutistInput = idle,
  until: (p: Parachutist) => boolean = () => false,
) {
  const events: ParachutistEvent[] = [];
  for (let t = 0; t < seconds && !until(p); t += SIM_DT)
    events.push(...p.step(SIM_DT, env, input(p)));
  return events;
}

function jumper(env: TestEnvironment, agl: number, headingDeg = 0) {
  const p = new Parachutist();
  p.reset(env.position(agl), { x: 0, y: 0, z: 0 }, headingDeg, true, env);
  return p;
}

/** Jumps from 1500 m and lets the canopy open (pulled at once). */
function underCanopy(env: TestEnvironment, agl = 1500) {
  const p = jumper(env, agl);
  run(p, env, 2);
  p.pull();
  run(p, env, 12);
  return p;
}

describe('free fall', () => {
  it('reaches the belly-to-earth terminal velocity of about 55 m/s at sea level', () => {
    const env = new TestEnvironment({ elevation: 0 });
    const p = jumper(env, 3000);
    run(p, env, 25);
    const v = p.view(view());
    expect(p.mode).toBe('freefall');
    // Higher up the air is thinner and the fall faster, by the square root of the density.
    expect(-v.verticalSpeed * Math.sqrt(density(env, p) / 1.225)).toBeCloseTo(TERMINAL_VELOCITY, 0);
  });

  it('falls to the ground without a pull: nothing opens by itself', () => {
    const env = new TestEnvironment({ elevation: 540 });
    const p = jumper(env, 1500);
    const events = run(p, env, 120, idle, (q) => q.mode === 'walk');
    expect(events).not.toContain('opened');
    expect(events).toContain('fatal');
    expect(p.alive).toBe(false);
  });

  it('opens at the pull and is flying ~150 m lower', () => {
    const env = new TestEnvironment({ elevation: 540 });
    const p = jumper(env, 1500);
    run(p, env, 15); // at terminal velocity
    const pulledAt = p.agl;
    const events = run(
      p,
      env,
      10,
      (q) => ({ x: 0, y: 0, run: false, pull: q.mode === 'freefall' }),
      (q) => q.deploy >= 1,
    );
    expect(events).toContain('opened');
    expect(pulledAt - p.agl).toBeGreaterThan(80);
    expect(pulledAt - p.agl).toBeLessThan(200);
  });

  it('is fatal when the parachute is pulled too low', () => {
    const env = new TestEnvironment({ elevation: 540 });
    const p = new Parachutist();
    // Falling at terminal velocity 80 m above the ground: pulled now, too late.
    p.reset(env.position(80), down(env, 55), 0, true, env);
    const events = run(
      p,
      env,
      30,
      (q) => ({ x: 0, y: 0, run: false, pull: q.mode === 'freefall' }),
      (q) => q.mode === 'walk',
    );
    expect(events).toContain('fatal');
    expect(p.alive).toBe(false);
  });

  it('tracks forward a little with the stick forward', () => {
    const env = new TestEnvironment({ elevation: 0 });
    const p = jumper(env, 4000, 90);
    run(p, env, 20, () => ({ x: 0, y: 1, run: false, pull: false }));
    const v = p.view(view());
    expect(v.speed).toBeGreaterThan(10);
    expect(v.speed).toBeLessThan(20);
    expect(v.headingDeg).toBeCloseTo(90, 0);
  });
});

describe('canopy', () => {
  it('glides at about 11 m/s and sinks at 5 in full flight, slower in deep brakes', () => {
    const env = new TestEnvironment({ elevation: 0 });
    const p = underCanopy(env, 2000);
    run(p, env, 10);
    // Equivalent (sea-level) speeds: up high a wing flies faster by sqrt(rho0 / rho).
    let k = Math.sqrt(density(env, p) / 1.225);
    const full = p.view(view());
    expect(full.speed * k).toBeCloseTo(11, 0);
    expect(-full.verticalSpeed * k).toBeCloseTo(5, 0);
    run(p, env, 15, () => ({ x: 0, y: -1, run: false, pull: false }));
    k = Math.sqrt(density(env, p) / 1.225);
    const brakes = p.view(view());
    expect(brakes.speed * k).toBeCloseTo(5.5, 0);
    expect(-brakes.verticalSpeed * k).toBeCloseTo(3.4, 0);
  });

  it('turns with one toggle and sinks faster in the turn', () => {
    const env = new TestEnvironment({ elevation: 0 });
    const p = underCanopy(env, 2000);
    const h0 = p.headingDeg;
    run(p, env, 4, () => ({ x: 1, y: 0, run: false, pull: false }));
    const v = p.view(view());
    const turned = (p.headingDeg - h0 + 360) % 360;
    expect(turned).toBeGreaterThan(90);
    expect(-v.verticalSpeed).toBeGreaterThan(6);
  });

  it('lands softly after a flare in the last metres, hard without one', () => {
    const env = new TestEnvironment({ elevation: 540 });
    const flared = underCanopy(env);
    const softly = run(
      flared,
      env,
      600,
      (q) => ({ x: 0, y: 0, run: false, pull: q.agl < 4 }),
      (q) => q.mode === 'walk',
    );
    expect(softly).toContain('landed');
    expect(flared.touchdownSink).toBeLessThan(2.5);

    const straight = underCanopy(env);
    const hard = run(straight, env, 600, idle, (q) => q.mode === 'walk');
    expect(hard).toContain('hardLanding');
    expect(straight.alive).toBe(true);

    // Flaring far too high stalls the wing and it drops in at the brakes' sink rate.
    const early = underCanopy(env);
    run(
      early,
      env,
      600,
      (q) => ({ x: 0, y: 0, run: false, pull: q.agl < 40 }),
      (q) => q.mode === 'walk',
    );
    expect(early.touchdownSink).toBeGreaterThan(flared.touchdownSink + 1);
  });

  it('drifts with the wind', () => {
    // Wind from the north at 8 m/s; the canopy flies east, so it is carried south.
    const env = new TestEnvironment({ elevation: 0, wind: { fromDeg: 0, speed: 8 } });
    const p = new Parachutist();
    p.reset(env.position(1500), { x: 0, y: 0, z: 0 }, 90, true, env);
    p.pull();
    run(p, env, 60);
    const north = { x: 0, y: 0, z: 0 };
    env.north(p.state.position, north);
    const d = {
      x: p.state.position.x - env.origin.x,
      y: p.state.position.y - env.origin.y,
      z: p.state.position.z - env.origin.z,
    };
    const southward = -(d.x * north.x + d.y * north.y + d.z * north.z);
    expect(southward).toBeGreaterThan(8 * 50);
    expect(southward).toBeLessThan(8 * 62);
  });

  it('splashes down in a lake', () => {
    const env = new TestEnvironment({ elevation: 372, surface: 'water' });
    const p = underCanopy(env);
    const events = run(p, env, 600, idle, (q) => q.mode === 'walk');
    expect(events).toContain('splash');
    expect(p.swimming).toBe(true);
    expect(p.alive).toBe(true);
  });
});

describe('on foot', () => {
  it('walks and runs up and down a slope, keeping the feet on it', () => {
    const env = new TestEnvironment({ elevation: 500, slope: { gradient: 0.3, downhillDeg: 0 } });
    const p = new Parachutist();
    // Heading south: uphill.
    p.reset(env.position(1), { x: 0, y: 0, z: 0 }, 180, false, env);
    const start = { ...p.state.position };
    run(p, env, 10, () => ({ x: 0, y: 1, run: true, pull: false }));
    const g = env.ground(p.state.position)!;
    expect(env.altitude(p.state.position) - g.height).toBeCloseTo(0.95, 1);
    const moved = Math.hypot(
      p.state.position.x - start.x,
      p.state.position.y - start.y,
      p.state.position.z - start.z,
    );
    expect(moved).toBeGreaterThan(50);
    expect(moved).toBeLessThan(60);
    expect(env.altitude(p.state.position)).toBeGreaterThan(env.altitude(start) + 14);
    expect(p.view(view()).agl).toBeLessThan(0.05);
  });

  it('cannot walk up a slope too steep', () => {
    const env = new TestEnvironment({ elevation: 500, slope: { gradient: 1.2, downhillDeg: 0 } });
    const p = new Parachutist();
    p.reset(env.position(1), { x: 0, y: 0, z: 0 }, 180, false, env);
    const h0 = env.altitude(p.state.position);
    run(p, env, 5, () => ({ x: 0, y: 1, run: true, pull: false }));
    expect(env.altitude(p.state.position)).toBeLessThan(h0 + 0.5);
  });
});

describe('leaving the aircraft', () => {
  it('steps out beside the stopped aircraft and can get back in', () => {
    const env = new TestEnvironment({ elevation: 500 });
    const ac = createAircraft('c172');
    ac.reset({ position: env.position(0), headingDeg: 90, speed: 0, onGround: true }, env);
    for (let i = 0; i < 240; i++) ac.step(SIM_DT, env);
    const p = new Parachutist();
    expect(leaveAircraft(p, ac, env)).toBe('step');
    expect(p.mode).toBe('walk');
    expect(canEnter(p, ac, env)).toBe(true);
    run(p, env, 4, () => ({ x: 0, y: 1, run: true, pull: false }));
    expect(canEnter(p, ac, env)).toBe(false);
  });

  it('jumps from the door of a flying aircraft with its speed', () => {
    const env = new TestEnvironment({ elevation: 540 });
    const ac = createAircraft('c172');
    ac.reset({ position: env.position(1500), headingDeg: 0, speed: 50, onGround: false }, env);
    const p = new Parachutist();
    expect(leaveAircraft(p, ac, env)).toBe('jump');
    expect(p.mode).toBe('freefall');
    expect(p.view(view()).speed).toBeGreaterThan(45);
  });

  it('ejects from the fighter on the ground: a prompt pull lands survivably', () => {
    const env = new TestEnvironment({ elevation: 450 });
    const ac = createAircraft('fa18');
    ac.reset({ position: env.position(0), headingDeg: 0, speed: 0, onGround: true }, env);
    for (let i = 0; i < 240; i++) ac.step(SIM_DT, env);
    const p = new Parachutist();
    expect(leaveAircraft(p, ac, env, 'eject')).toBe('eject');
    let top = 0;
    const pullSoon = (q: Parachutist) => ({ x: 0, y: 0, run: false, pull: q.time > 0.5 });
    const events = run(p, env, 120, pullSoon, (q) => {
      top = Math.max(top, q.agl);
      return q.mode === 'walk';
    });
    expect(top).toBeGreaterThan(25);
    expect(events).toContain('opened');
    expect(events).not.toContain('fatal');
    expect(p.alive).toBe(true);
    expect(p.canopy).toBe('round');
  });

  it('ejects from the fighter in fast flight; the canopy needs a pull', () => {
    const env = new TestEnvironment({ elevation: 450 });
    const ac = createAircraft('fa18');
    ac.reset({ position: env.position(1500), headingDeg: 0, speed: 200, onGround: false }, env);
    const p = new Parachutist();
    expect(leaveAircraft(p, ac, env)).toBe('eject');
    expect(p.canopy).toBe('round');
    run(p, env, 6);
    expect(p.mode).toBe('freefall');
    const events = run(
      p,
      env,
      10,
      (q) => ({ x: 0, y: 0, run: false, pull: q.mode === 'freefall' }),
      (q) => q.deploy >= 1,
    );
    expect(events).toContain('opened');
    expect(p.agl).toBeGreaterThan(1000);
  });
});
