/**
 * Flying qualities and handling of the C172S that have no single handbook number: trim,
 * stability, stall behaviour, ground handling, crosswind, crashes, engine and determinism.
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT, TestEnvironment, createAircraft, type SimAircraft } from '../../src/sim';
import { AttitudePilot, DEG, FT, KT, airborne, fly, onGround } from './harness';
import { takeoff } from './procedures';

const distance = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('trim and stability', () => {
  it.each([
    [65, 0],
    [75, 0],
    [100, 0],
    [120, 0],
    [62, 1],
  ])('starts trimmed in the air at %i KTAS (flaps lever %d)', (ktas, flaps) => {
    const f = airborne(1500, ktas, { flaps });
    const t = f.ac.telemetry;
    const theta0 = t.pitch;
    let maxVs = 0;
    let maxQ = 0;
    fly(f, 5, () => {
      maxVs = Math.max(maxVs, Math.abs(t.verticalSpeed));
      maxQ = Math.max(maxQ, Math.abs(f.ac.state.angularVelocity.y));
    });
    expect(maxVs, 'vertical speed').toBeLessThan(0.3);
    expect(maxQ / DEG, 'pitch rate').toBeLessThan(0.3);
    expect(Math.abs(t.pitch - theta0) / DEG).toBeLessThan(0.5);
    expect(Math.abs(t.tas / KT - ktas)).toBeLessThan(1);
    // The solved trim is handed to the pilot's levers.
    expect(f.ac.controls.pitch).toBe(0);
    expect(Math.abs(f.ac.controls.pitchTrim)).toBeLessThan(1);
  });

  it('flies level hands-off for 60 s when trimmed for cruise', () => {
    const f = airborne(3000 * FT, 105);
    const t = f.ac.telemetry;
    const h0 = t.altitude;
    const v0 = t.ias;
    fly(f, 60);
    expect(Math.abs(t.altitude - h0), 'altitude change (m)').toBeLessThan(10);
    expect(Math.abs(t.bank) / DEG, 'bank').toBeLessThan(5);
    expect(Math.abs(t.ias - v0) / KT, 'speed change').toBeLessThan(2);
  });

  it('is statically and dynamically stable in pitch, with a 25-35 s phugoid', () => {
    const f = airborne(3000 * FT, 95);
    const { ac } = f;
    const t = ac.telemetry;
    // A one-second pull: the short period must damp within a few seconds...
    fly(f, 1, () => {
      ac.controls.pitch = 0.2;
    });
    ac.controls.pitch = 0;
    fly(f, 4);
    expect(Math.abs(ac.state.angularVelocity.y) / DEG).toBeLessThan(2);
    // ...and the speed oscillation that follows is the phugoid.
    const speeds: number[] = [];
    fly(f, 150, () => {
      speeds.push(t.tas);
    });
    const peaks: { i: number; v: number }[] = [];
    for (let i = 60; i < speeds.length - 60; i++) {
      const v = speeds[i]!;
      let peak = true;
      for (let k = i - 60; k <= i + 60 && peak; k++) if (speeds[k]! > v) peak = false;
      if (peak) peaks.push({ i, v });
    }
    expect(peaks.length).toBeGreaterThanOrEqual(3);
    const period = ((peaks[2]!.i - peaks[0]!.i) / 2) * SIM_DT;
    expect(period).toBeGreaterThan(25);
    expect(period).toBeLessThan(35);
    // Damped: the swing around the trim speed does not grow.
    const mean = speeds.reduce((a, b) => a + b) / speeds.length;
    expect(peaks[2]!.v - mean).toBeLessThan(peaks[0]!.v - mean);
  });

  it('turns left at full power and low speed with the feet off the rudder (P-factor, slipstream)', () => {
    const f = airborne(1500, 65);
    f.ac.controls.throttle[0] = 1;
    const h0 = f.ac.telemetry.headingDeg;
    fly(f, 5);
    const change = ((f.ac.telemetry.headingDeg - h0 + 540) % 360) - 180;
    expect(change).toBeLessThan(-1);
  });

  it('yaws against a roll made with the ailerons alone (adverse yaw)', () => {
    const f = airborne(1500, 70);
    let minR = 0;
    fly(f, 0.6, () => {
      f.ac.controls.roll = 1;
      minR = Math.min(minR, f.ac.state.angularVelocity.z);
    });
    expect(f.ac.state.angularVelocity.x).toBeGreaterThan(20 * DEG);
    expect(minR).toBeLessThan(-2 * DEG);
  });
});

describe('stall', () => {
  it('drops the nose with the yoke held back and recovers when it is released', () => {
    const f = airborne(1500, 65);
    const { ac } = f;
    const t = ac.telemetry;
    ac.controls.throttle[0] = 0;
    let maxPitch = -Infinity;
    let dropAfterMax = 0;
    let warned = false;
    fly(f, 14, () => {
      ac.controls.pitch = Math.min(1, t.time / 8);
      warned ||= t.stallWarning;
      maxPitch = Math.max(maxPitch, t.pitch);
      dropAfterMax = Math.max(dropAfterMax, maxPitch - t.pitch);
    });
    expect(warned).toBe(true);
    expect(dropAfterMax / DEG, 'nose drop').toBeGreaterThan(4);
    // Released: the wing unstalls and the aircraft flies again.
    ac.controls.pitch = 0;
    let recovered = false;
    fly(f, 10, () => {
      if (t.alpha < 10 * DEG && t.ias > 55 * KT) recovered = true;
    });
    expect(recovered).toBe(true);
    expect(t.crashed).toBeUndefined();
  });
});

describe('ground handling', () => {
  it('stays put with the parking brake at idle, on level and on sloped ground', () => {
    for (const slope of [
      undefined,
      { gradient: 0.04, downhillDeg: 0 },
      { gradient: 0.04, downhillDeg: 90 },
    ]) {
      const f = onGround({ slope, heading: 0 });
      f.ac.controls.parkingBrake = true;
      fly(f, 20);
      const p = { ...f.ac.state.position };
      fly(f, 40);
      expect(distance(p, f.ac.state.position), 'creep (m)').toBeLessThan(0.005);
      expect(f.ac.telemetry.onGround).toBe(true);
      expect(f.ac.telemetry.agl).toBeCloseTo(0, 2);
      expect(
        Math.abs(f.ac.state.angularVelocity.x) + Math.abs(f.ac.state.angularVelocity.y),
      ).toBeLessThan(1e-3);
      expect(f.ac.telemetry.engines[0]!.rpm).toBeGreaterThan(550);
      expect(f.ac.telemetry.engines[0]!.rpm).toBeLessThan(900);
    }
  });

  it('sits level on its wheels after a reset on the ground', () => {
    const f = onGround({ heading: 123 });
    const t = f.ac.telemetry;
    expect(t.onGround).toBe(true);
    expect(Math.abs(t.headingDeg - 123)).toBeLessThan(0.1);
    expect(Math.abs(t.pitch) / DEG).toBeLessThan(1.5);
    fly(f, 2);
    expect(Math.abs(t.verticalSpeed)).toBeLessThan(0.01);
    expect(Math.abs(t.headingDeg - 123)).toBeLessThan(0.5);
  });

  it('taxies, steers with the pedals and stops with the brakes', () => {
    const f = onGround();
    const { ac } = f;
    const t = ac.telemetry;
    ac.controls.throttle[0] = 0.15;
    fly(f, 10);
    expect(t.groundSpeed).toBeGreaterThan(1);
    ac.controls.yaw = 1;
    const h0 = t.headingDeg;
    fly(f, 5);
    expect((t.headingDeg - h0 + 360) % 360).toBeGreaterThan(30);
    ac.controls.yaw = 0;
    ac.controls.throttle[0] = 0;
    ac.controls.brakeLeft = 1;
    ac.controls.brakeRight = 1;
    fly(f, 6);
    expect(t.groundSpeed).toBeLessThan(0.05);
    expect(t.crashed).toBeUndefined();
  });

  it('takes off with a 10 kt direct crosswind under control', () => {
    const r = takeoff({ crosswindKt: 10 });
    expect(r.crashed).toBeUndefined();
    expect(r.totalFt).toBeGreaterThan(1000);
    expect(r.maxHeadingDeviation).toBeLessThan(5);
    expect(r.maxBankDeg).toBeLessThan(10);
  });

  it('takes off uphill on sloped grass, just longer', () => {
    const flat = takeoff({ surface: 'grass' });
    const uphill = takeoff({ surface: 'grass', slope: { gradient: 0.02, downhillDeg: 180 } });
    expect(uphill.crashed).toBeUndefined();
    expect(uphill.groundRollFt).toBeGreaterThan(flat.groundRollFt);
    expect(flat.groundRollFt).toBeGreaterThan(takeoff().groundRollFt);
  });

  it('holds the aircraft while the terrain under it is not loaded, then settles', () => {
    const env = new TestEnvironment({ noGround: true });
    const ac = createAircraft('c172');
    const start = env.position(0);
    ac.reset({ position: start, headingDeg: 0, speed: 0, onGround: true }, env);
    for (let i = 0; i < 240; i++) ac.step(SIM_DT, env);
    expect(distance(ac.state.position, start)).toBeLessThan(0.01);
    expect(ac.telemetry.agl).toBeUndefined();
    expect(ac.telemetry.crashed).toBeUndefined();
    env.noGround = false;
    for (let i = 0; i < 360; i++) ac.step(SIM_DT, env);
    expect(ac.telemetry.onGround).toBe(true);
    expect(ac.telemetry.agl).toBeCloseTo(0, 2);
    expect(Math.abs(ac.telemetry.verticalSpeed)).toBeLessThan(0.02);
    // In flight, missing terrain just means no collisions.
    const f = airborne(300, 100, { noGround: true });
    fly(f, 10);
    expect(f.ac.telemetry.crashed).toBeUndefined();
    expect(f.ac.telemetry.agl).toBeUndefined();
  });
});

describe('crashes', () => {
  it('reports flying into the ground', () => {
    const f = airborne(60, 100);
    fly(f, 30, () => {
      f.ac.controls.pitch = -0.1;
      return f.ac.telemetry.crashed !== undefined;
    });
    expect(f.ac.telemetry.crashed).toBeDefined();
    // A wreck stays where it is.
    const p = { ...f.ac.state.position };
    fly(f, 1);
    expect(distance(p, f.ac.state.position)).toBe(0);
  });

  it('reports structural overstress in a hard pull at high speed', () => {
    const f = airborne(1500, 145);
    fly(f, 5, () => {
      f.ac.controls.pitch = 1;
      return f.ac.telemetry.crashed !== undefined;
    });
    expect(f.ac.telemetry.crashed).toBe('overstress');
  });

  it('survives a firm landing but not a drop onto the gear', () => {
    for (const [sink, survives] of [
      [1.5, true],
      [6, false],
    ] as const) {
      const env = new TestEnvironment();
      const ac = createAircraft('c172');
      ac.reset({ position: env.position(3), headingDeg: 0, speed: 50 * KT, onGround: false }, env);
      // Turn the trimmed glide into a straight sink onto the mains, nose slightly up.
      const up = env.up(ac.state.position, { x: 0, y: 0, z: 0 });
      ac.state.velocity.x -= up.x * sink;
      ac.state.velocity.y -= up.y * sink;
      ac.state.velocity.z -= up.z * sink;
      for (let i = 0; i < 360; i++) ac.step(SIM_DT, env);
      expect(ac.telemetry.crashed === undefined, `sink ${sink} m/s: ${ac.telemetry.crashed}`).toBe(
        survives,
      );
    }
  });
});

describe('engine and systems', () => {
  it('stops at idle cut-off, restarts with the starter and burns fuel', () => {
    const f = onGround();
    const { ac } = f;
    const e = ac.telemetry.engines[0]!;
    const fuel0 = ac.telemetry.fuel;
    ac.controls.parkingBrake = true;
    fly(f, 30);
    expect(ac.telemetry.fuel).toBeLessThan(fuel0);
    expect(e.fuelFlow).toBeGreaterThan(0);
    ac.controls.mixture[0] = 0;
    fly(f, 10);
    expect(e.running).toBe(false);
    expect(e.rpm).toBeLessThan(1);
    expect(e.fuelFlow).toBe(0);
    ac.controls.mixture[0] = 1;
    ac.controls.starter = [true];
    fly(f, 3);
    ac.controls.starter = [false];
    fly(f, 5);
    expect(e.running).toBe(true);
    expect(e.rpm).toBeGreaterThan(500);
  });

  it('starts with the engine off when asked to', () => {
    const env = new TestEnvironment();
    const ac = createAircraft('c172');
    ac.reset(
      { position: env.position(0), headingDeg: 0, speed: 0, onGround: true, enginesRunning: false },
      env,
    );
    for (let i = 0; i < 120; i++) ac.step(SIM_DT, env);
    expect(ac.telemetry.engines[0]!.running).toBe(false);
    expect(ac.telemetry.engines[0]!.rpm).toBe(0);
  });

  it('loses power with density altitude', () => {
    const power = (altitudeFt: number, isaDeviation = 0) => {
      const f = airborne(altitudeFt * FT, 100, { isaDeviation });
      f.ac.controls.throttle[0] = 1;
      fly(f, 3);
      return f.ac.telemetry.engines[0]!.power;
    };
    const sl = power(1000);
    const high = power(8000);
    expect(high).toBeLessThan(sl * 0.85);
    expect(power(8000, 20)).toBeLessThan(high);
  });

  it('moves the flaps to their detents at the speed of the electric motor', () => {
    const f = airborne(1500, 80);
    const t = f.ac.telemetry;
    f.ac.controls.flaps = 1;
    fly(f, 4.5);
    expect(t.flaps).toBeGreaterThan(0.4);
    expect(t.flaps).toBeLessThan(0.6);
    fly(f, 6);
    expect(t.flaps).toBe(1);
    f.ac.controls.flaps = 0.4; // nearest detent: 10°
    fly(f, 10);
    expect(t.flaps).toBeCloseTo(1 / 3, 5);
  });
});

describe('frames and determinism', () => {
  function flight(ac: SimAircraft, env: TestEnvironment, seconds: number) {
    for (let i = 0; i < seconds / SIM_DT; i++) {
      ac.controls.roll = Math.sin(i * 0.01) * 0.3;
      ac.controls.pitch = Math.cos(i * 0.007) * 0.2;
      ac.controls.yaw = Math.sin(i * 0.013) * 0.2;
      ac.step(SIM_DT, env);
    }
  }

  it('gives bit-identical results for identical inputs', () => {
    const run = () => {
      const env = new TestEnvironment({ wind: { fromDeg: 250, speed: 8 } });
      const ac = createAircraft('c172');
      ac.reset({ position: env.position(800), headingDeg: 40, speed: 50, onGround: false }, env);
      flight(ac, env, 30);
      return JSON.stringify([ac.state, ac.telemetry]);
    };
    expect(run()).toBe(run());
  });

  it('flies the same far from the reference point, on a curved Earth, in any direction', () => {
    // Trimmed flight at high latitude heading west, wings held level and the elevator left
    // alone, keeps its altitude and its track: nothing assumes a flat world or a fixed "up".
    const f = airborne(3000 * FT, 105, { latitude: 64, longitude: -20, heading: 270 });
    const t = f.ac.telemetry;
    const attitude = new AttitudePilot(f.ac);
    const h0 = t.altitude;
    fly(f, 120, (dt) => attitude.bankTo(0, dt));
    expect(Math.abs(t.altitude - h0)).toBeLessThan(15);
    expect(Math.abs(((t.headingDeg - 270 + 540) % 360) - 180)).toBeLessThan(5);
    expect(Math.abs(((t.trackDeg - t.headingDeg + 540) % 360) - 180)).toBeLessThan(3);
  });

  it('fills every telemetry field with finite values', () => {
    const f = airborne(1500, 90);
    fly(f, 2);
    for (const [k, v] of Object.entries(f.ac.telemetry))
      if (typeof v === 'number') expect(Number.isFinite(v), k).toBe(true);
  });

  it('costs well under 0.1 ms per step', () => {
    const f = airborne(1500, 100);
    fly(f, 5);
    const g = onGround();
    fly(g, 1);
    const t0 = performance.now();
    fly(f, 50);
    fly(g, 50);
    const perStep = (performance.now() - t0) / (100 / SIM_DT);
    expect(perStep).toBeLessThan(0.1);
  });
});
