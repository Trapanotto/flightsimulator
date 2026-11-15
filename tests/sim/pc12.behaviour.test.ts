/**
 * Flying qualities and systems of the PC-12 that have no single handbook number: hands-off
 * stability, the stick pusher, an engine failure, the gear and flaps, a wheels-up landing,
 * exceedances, the yaw damper, pressurisation, the cockpit, resets, determinism and cost.
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT, TestEnvironment, createAircraft, PC12_CONTROLS } from '../../src/sim';
import type { FlightModel } from '../../src/sim/flightModel';
import { AltitudePilot, AttitudePilot, DEG, FT, KT, SpeedPilot, fly } from './harness';
import { engine, pc12Airborne, pc12OnGround } from './pc12Harness';
import { horizontalDistance } from './pc12Procedures';

describe('PC-12 flying qualities', () => {
  it('flies hands-off in cruise, trimmed by the reset', () => {
    const f = pc12Airborne(20_000 * FT, 260);
    const t = f.ac.telemetry;
    const h0 = t.altitude;
    const v0 = t.ias;
    fly(f, 60);
    expect(Math.abs(t.altitude - h0)).toBeLessThan(30);
    expect(Math.abs(t.bank) / DEG).toBeLessThan(5);
    expect(Math.abs(t.ias - v0) / KT).toBeLessThan(3);
  });

  it('fires the stick pusher before the stall, and flies on once the yoke is released', () => {
    const f = pc12Airborne(6000 * FT, 120);
    const { ac } = f;
    const t = ac.telemetry;
    ac.controls.throttle[0] = 0;
    let shaker = false;
    let pushed = false;
    let maxAlpha = 0;
    let maxYawRate = 0;
    const attitude = new AttitudePilot(ac);
    let held = NaN;
    fly(f, 40, (dt) => {
      // A slow pull until the pusher fires; then the pilot keeps the pull it had, as in the
      // certification test, and the pusher has to win against it.
      if (Number.isNaN(held)) ac.controls.pitch = Math.min(1, t.time / 20);
      if (t.stickPusher && Number.isNaN(held)) held = t.time;
      attitude.bankTo(0, dt);
      shaker ||= t.stickShaker === true;
      pushed ||= t.stickPusher === true;
      maxAlpha = Math.max(maxAlpha, t.alpha);
      maxYawRate = Math.max(maxYawRate, Math.abs(ac.state.angularVelocity.z));
      // Five seconds of it, then the pilot gives up the pull.
      return !Number.isNaN(held) && t.time > held + 5;
    });
    expect(shaker).toBe(true);
    expect(pushed).toBe(true);
    // The pusher keeps the wing from a deep stall: no wing drop, no spin.
    expect(maxAlpha / DEG).toBeLessThan(15);
    expect(maxYawRate / DEG).toBeLessThan(10);
    ac.controls.pitch = 0;
    let recovered = false;
    fly(f, 15, (dt) => {
      attitude.bankTo(0, dt);
      if (t.alpha < 8 * DEG && t.ias > 100 * KT) recovered = true;
    });
    expect(recovered).toBe(true);
    expect(t.crashed).toBeUndefined();
  }, 30_000);

  it('feathers by itself after an engine failure and glides about 16:1', () => {
    const f = pc12Airborne(15_000 * FT, 220);
    f.ac.failures.set('engine', true);
    const pilot = new SpeedPilot(f.ac, 0);
    // Slowing gently to the best glide speed.
    let target = f.ac.telemetry.ias / KT;
    fly(f, 60, (dt) => {
      target = Math.max(125, target - 2 * dt);
      pilot.step(target, dt);
    });
    const e = engine(f);
    expect(e.running).toBe(false);
    expect(e.propRpm).toBeLessThan(150);
    const p0 = { ...f.ac.state.position };
    const h0 = f.ac.telemetry.altitude;
    fly(f, 90, (dt) => pilot.step(125, dt));
    const ratio = horizontalDistance(f, p0, f.ac.state.position) / (h0 - f.ac.telemetry.altitude);
    expect(ratio).toBeGreaterThan(15);
    expect(ratio).toBeLessThan(17);
  }, 30_000);

  it('retracts and extends the gear in seconds; gear and flaps change drag and trim', () => {
    const f = pc12Airborne(5000 * FT, 140, { gearDown: true });
    expect(f.ac.telemetry.gear).toBe(1);
    f.ac.controls.gearDown = false;
    fly(f, 4);
    expect(f.ac.telemetry.gear).toBeGreaterThan(0.3);
    expect(f.ac.telemetry.gear).toBeLessThan(0.7);
    expect(f.ac.telemetry.systems!.annunciators.gearUnsafe).toBe(true);
    fly(f, 6);
    expect(f.ac.telemetry.gear).toBe(0);
    expect(f.ac.telemetry.systems!.annunciators.gearUnsafe).toBe(false);
    // Trimmed at the same speed: the gear needs power, and its drag below the centre of
    // gravity pitches the nose down (more nose-up trim).
    const trim = (flaps: number, gearDown: boolean) => {
      const a = pc12Airborne(5000 * FT, 130, { flaps, gearDown });
      return { throttle: a.ac.controls.throttle[0]!, trim: a.ac.controls.pitchTrim };
    };
    const clean = trim(0, false);
    const gear = trim(0, true);
    const flaps = trim(1 / 3, false);
    expect(gear.throttle).toBeGreaterThan(clean.throttle + 0.03);
    expect(gear.trim).toBeGreaterThan(clean.trim);
    // The flaps add drag, and they lower the body angle for the same lift: the tail then
    // carries more download and the trim goes nose down.
    expect(flaps.throttle).toBeGreaterThan(clean.throttle + 0.02);
    expect(flaps.trim).toBeLessThan(clean.trim);
    // Raising the gear in level flight at constant power: the aircraft speeds up.
    const g = pc12Airborne(5000 * FT, 140, { gearDown: true });
    const hold = new AltitudePilot(g.ac, 0, g.ac.telemetry.altitude);
    g.ac.controls.gearDown = false;
    fly(g, 60, (dt) => hold.step(dt));
    expect(g.ac.telemetry.tas / KT).toBeGreaterThan(148);
  }, 30_000);

  it('keeps the gear down on the ground (squat switch)', () => {
    const f = pc12OnGround();
    f.ac.controls.gearDown = false;
    f.ac.controls.parkingBrake = true;
    fly(f, 10);
    expect(f.ac.telemetry.gear).toBe(1);
    expect(f.ac.telemetry.onGround).toBe(true);
  });

  it('survives a wheels-up landing on the runway at a low sink rate', () => {
    const env = new TestEnvironment();
    const ac = createAircraft('pc12') as FlightModel;
    ac.controls.flaps = 1;
    ac.reset({ position: env.position(3), headingDeg: 0, speed: 80 * KT, onGround: false }, env);
    expect(ac.telemetry.gear).toBe(0);
    ac.controls.throttle[0] = 0;
    const attitude = new AttitudePilot(ac);
    const f = { ac, env };
    fly(f, 40, (dt) => {
      attitude.pitchTo(2 * DEG, dt);
      attitude.bankTo(0, dt);
    });
    expect(ac.telemetry.crashed).toBeUndefined();
    expect(ac.telemetry.groundSpeed).toBeLessThan(1);
    expect(ac.telemetry.agl).toBeLessThan(0.1);
    // Dropped in hard it is a wreck.
    const hard = createAircraft('pc12') as FlightModel;
    hard.reset({ position: env.position(2), headingDeg: 0, speed: 80 * KT, onGround: false }, env);
    const up = env.up(hard.state.position, { x: 0, y: 0, z: 0 });
    hard.state.velocity.x -= up.x * 6;
    hard.state.velocity.y -= up.y * 6;
    hard.state.velocity.z -= up.z * 6;
    fly({ ac: hard, env }, 3);
    expect(hard.telemetry.crashed).toBeDefined();
  });

  it('notes an overspeed with the gear down as an exceedance, not a failure', () => {
    const f = pc12Airborne(5000 * FT, 210, { gearDown: true });
    fly(f, 1);
    expect(f.ac.telemetry.ias / KT).toBeGreaterThan(185);
    expect(f.ac.telemetry.exceedances).toContain('gear');
    expect(f.ac.telemetry.crashed).toBeUndefined();
    // The gear still comes up, and the note goes once below VLE.
    f.ac.controls.gearDown = false;
    fly(f, 10);
    expect(f.ac.telemetry.gear).toBe(0);
    expect(f.ac.telemetry.exceedances).not.toContain('gear');
    const fast = pc12Airborne(8000 * FT, 300);
    fly(fast, 1);
    expect(fast.ac.telemetry.exceedances).toContain('overspeed');
    const flaps = pc12Airborne(5000 * FT, 150, { flaps: 1, gearDown: true });
    fly(flaps, 1);
    expect(flaps.ac.telemetry.exceedances).toContain('flaps');
  });

  it('damps the dutch roll with the yaw damper', () => {
    const swing = (yd: boolean) => {
      const f = pc12Airborne(10_000 * FT, 200);
      if (yd) {
        f.ac.cockpit.set('yawDamper', 1);
        fly(f, 0.1);
        f.ac.cockpit.set('yawDamper', 0);
      }
      fly(f, 1);
      fly(f, 1, () => void (f.ac.controls.yaw = 0.4));
      fly(f, 1, () => void (f.ac.controls.yaw = -0.4));
      f.ac.controls.yaw = 0;
      fly(f, 4);
      let r = 0;
      fly(f, 4, () => void (r = Math.max(r, Math.abs(f.ac.state.angularVelocity.z))));
      expect(f.ac.telemetry.avionics!.autopilot.yawDamper).toBe(yd);
      return r;
    };
    const off = swing(false);
    const on = swing(true);
    expect(off).toBeGreaterThan(1 * DEG);
    expect(on).toBeLessThan(off * 0.2);
  });
});

describe('PC-12 systems', () => {
  it('pressurises the cabin in the climb and warns when the cabin climbs past 10 000 ft', () => {
    const f = pc12Airborne(25_000 * FT, 260);
    const s = f.ac.telemetry.systems!;
    fly(f, 5);
    // 5.75 psi at FL250 holds the cabin near 8000 ft.
    expect(s.cabinAltitude! / FT).toBeLessThan(10_000);
    expect(s.cabinDifferential!).toBeLessThanOrEqual(5.75 * 6894.757 + 1);
    expect(s.cabinDifferential!).toBeGreaterThan(5.5 * 6894.757);
    expect(s.annunciators.cabinAltitude).toBe(false);
    f.ac.cockpit.set('pressurisation', 1);
    fly(f, 60);
    expect(s.cabinAltitude! / FT).toBeGreaterThan(20_000);
    expect(s.annunciators.cabinAltitude).toBe(true);
  });

  it('runs on two generators and two batteries; the starter-generator carries the bus', () => {
    const f = pc12Airborne(10_000 * FT, 200);
    fly(f, 2);
    const s = f.ac.telemetry.systems!;
    expect(s.busVolts).toBeGreaterThan(27.5);
    expect(s.annunciators.generators).toEqual([false, false]);
    f.ac.failures.set('alternator', true);
    fly(f, 2);
    expect(s.annunciators.generators).toEqual([true, false]);
    expect(s.busVolts).toBeGreaterThan(27);
    f.ac.cockpit.set('generator2', 0);
    fly(f, 2);
    expect(s.batteryAmps).toBeLessThan(0);
    expect(s.annunciators.lowVolts).toBe(true);
  });

  it('cycles the de-icing boots and keeps the wing tanks balanced', () => {
    const f = pc12Airborne(10_000 * FT, 180, { moisture: 1 });
    const s = f.ac.telemetry.systems!;
    const hold = new AltitudePilot(f.ac, 0, f.ac.telemetry.altitude);
    fly(f, 300, (dt) => hold.step(dt));
    const iced = s.airframeIce;
    expect(iced).toBeGreaterThan(0.1);
    f.ac.cockpit.set('bootsDeice', 2);
    fly(f, 65, (dt) => hold.step(dt));
    expect(s.annunciators.deice).toBe(true);
    expect(s.airframeIce).toBeLessThan(iced * 0.5);
    f.ac.setFuel(400, 600);
    fly(f, 120, (dt) => hold.step(dt));
    expect(Math.abs(s.fuelLeft - s.fuelRight)).toBeLessThan(20);
  }, 30_000);
});

describe('PC-12 cockpit and resets', () => {
  it('binds the levers that mirror ControlInput', () => {
    const { ac } = pc12OnGround();
    const p = ac.cockpit;
    const c = ac.controls;
    p.set('throttle', 0.4);
    expect(c.throttle[0]).toBeCloseTo(0.4, 12);
    for (const [pos, lever] of [
      [0, 0],
      [1, 1 / 3],
      [2, 2 / 3],
      [3, 1],
    ] as const) {
      p.set('flaps', pos);
      expect(c.flaps).toBeCloseTo(lever, 12);
    }
    p.set('condition', 1);
    expect(c.condition![0]).toBe(0.5);
    p.set('condition', 2);
    expect(c.condition![0]).toBe(1);
    p.set('gear', 0);
    expect(c.gearDown).toBe(false);
    p.set('reverse', 1);
    expect(c.reverse).toBe(true);
    p.set('trim', 0.3);
    expect(c.pitchTrim).toBeCloseTo(0.3, 12);
    p.set('aileronTrim', -0.2);
    expect(c.rollTrim).toBeCloseTo(-0.2, 12);
    p.set('rudderTrim', 0.5);
    expect(c.yawTrim).toBeCloseTo(0.5, 12);
    p.set('parkingBrake', 1);
    expect(c.parkingBrake).toBe(true);
  });

  it('lets every switch do something', () => {
    const f = pc12OnGround();
    const p = f.ac.cockpit;
    const s = f.ac.telemetry.systems!;
    fly(f, 1);
    const amps = s.batteryAmps;
    const v = s.busVolts;
    // Lights and heaters load the bus (on the battery alone the ammeter shows it).
    p.set('generator1', 0);
    p.set('generator2', 0);
    fly(f, 0.5);
    const base = s.batteryAmps;
    for (const id of [
      'lightLanding',
      'lightRecognition',
      'propDeice',
      'windshieldHeat',
      'pitotHeat',
    ]) {
      p.set(id, 1);
      fly(f, 0.2);
    }
    expect(s.batteryAmps).toBeLessThan(base - 50);
    expect(s.lights.recognition).toBe(true);
    void amps;
    void v;
    // The rudder trim moves the rudder, the aileron trim the ailerons.
    const a = pc12Airborne(5000 * FT, 150);
    const r0 = a.ac.telemetry.rudder;
    a.ac.cockpit.set('rudderTrim', 1);
    fly(a, 1);
    expect(a.ac.telemetry.rudder).toBeGreaterThan(r0 + 0.2);
    a.ac.cockpit.set('aileronTrim', 1);
    fly(a, 1);
    expect(a.ac.telemetry.aileron).toBeGreaterThan(0.05);
    // The firewall shutoff starves the engine.
    a.ac.cockpit.set('fuelShutoff', 0);
    fly(a, 20);
    expect(engine(a).running).toBe(false);
    // Every control of the list exists on the aircraft and takes a value.
    for (const spec of PC12_CONTROLS) expect(a.ac.cockpit.has(spec.id), spec.id).toBe(true);
  });

  it('starts cold and dark, or running for the runway or the cruise', () => {
    const env = new TestEnvironment();
    const ac = createAircraft('pc12') as FlightModel;
    ac.reset(
      { position: env.position(0), headingDeg: 0, speed: 0, onGround: true, enginesRunning: false },
      env,
    );
    for (const spec of ac.cockpit.specs)
      expect(ac.cockpit.get(spec.id), spec.id).toBe(spec.initial);
    expect(ac.telemetry.engines[0]!.running).toBe(false);
    fly({ ac, env }, 1);
    expect(ac.telemetry.systems!.busVolts).toBe(0);
    const g = pc12OnGround();
    expect(g.ac.telemetry.engines[0]!.running).toBe(true);
    expect(g.ac.cockpit.get('condition')).toBe(2);
    expect(g.ac.telemetry.gear).toBe(1);
    fly(g, 2);
    expect(g.ac.telemetry.systems!.busVolts).toBeGreaterThan(27.5);
    expect(engine(g).propRpm).toBeGreaterThan(600);
    const air = pc12Airborne(10_000 * FT, 200);
    expect(air.ac.telemetry.gear).toBe(0);
    expect(air.ac.telemetry.avionics!.autopilot.engaged).toBe(false);
    expect(air.ac.telemetry.systems!.cabinAltitude! / FT).toBeLessThan(10_000);
  });

  it('is deterministic, fills its telemetry with finite numbers and costs under 0.1 ms a step', () => {
    const runOnce = () => {
      const f = pc12Airborne(3000, 200, { wind: { fromDeg: 250, speed: 8 } });
      for (let i = 0; i < 20 / SIM_DT; i++) {
        f.ac.controls.roll = Math.sin(i * 0.01) * 0.3;
        f.ac.controls.pitch = Math.cos(i * 0.007) * 0.2;
        f.ac.step(SIM_DT, f.env);
      }
      return JSON.stringify([f.ac.state, f.ac.telemetry]);
    };
    expect(runOnce()).toBe(runOnce());
    const f = pc12Airborne(5000 * FT, 200);
    fly(f, 2);
    for (const [k, val] of Object.entries(f.ac.telemetry))
      if (typeof val === 'number') expect(Number.isFinite(val), k).toBe(true);
    for (const [k, val] of Object.entries(f.ac.telemetry.engines[0]!))
      if (typeof val === 'number') expect(Number.isFinite(val), k).toBe(true);
    const g = pc12OnGround();
    fly(g, 1);
    const t0 = performance.now();
    fly(f, 50);
    fly(g, 50);
    const perStep = (performance.now() - t0) / (100 / SIM_DT);
    expect(perStep).toBeLessThan(0.1);
  });
});
