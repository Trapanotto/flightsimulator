/** The C172S cockpit: the levers shared with ControlInput, and the start conditions. */
import { describe, expect, it } from 'vitest';
import { TestEnvironment, createAircraft } from '../../src/sim';
import type { FlightModel } from '../../src/sim/flightModel';
import { airborne, fly, onGround } from './harness';

const cold = () => {
  const env = new TestEnvironment();
  const ac = createAircraft('c172') as FlightModel;
  ac.reset(
    { position: env.position(0), headingDeg: 0, speed: 0, onGround: true, enginesRunning: false },
    env,
  );
  return { ac, env };
};

describe('cockpit', () => {
  it('reads and moves the levers of ControlInput', () => {
    const { ac } = onGround();
    const p = ac.cockpit;
    p.set('throttle', 0.4);
    expect(ac.controls.throttle[0]).toBeCloseTo(0.4, 12);
    ac.controls.mixture[0] = 0.7;
    expect(p.get('mixture')).toBeCloseTo(0.7, 12);
    // Flap selector 0/10/20/30 degrees is ControlInput.flaps 0, 1/3, 2/3, 1.
    for (const [position, lever] of [
      [0, 0],
      [1, 1 / 3],
      [2, 2 / 3],
      [3, 1],
    ] as const) {
      p.set('flaps', position);
      expect(ac.controls.flaps).toBeCloseTo(lever, 12);
      expect(p.get('flaps')).toBe(position);
    }
    ac.controls.flaps = 0.4;
    expect(p.get('flaps')).toBe(1);
    p.set('trim', 0.31);
    expect(ac.controls.pitchTrim).toBeCloseTo(0.32, 12);
    p.set('parkingBrake', 1);
    expect(ac.controls.parkingBrake).toBe(true);
    ac.controls.parkingBrake = false;
    expect(p.get('parkingBrake')).toBe(0);
  });

  it('starts a running aircraft configured, lights on as for the runway or the cruise', () => {
    const { ac } = onGround();
    const p = ac.cockpit;
    for (const id of ['battery', 'alternator', 'avionics']) expect(p.get(id), id).toBe(1);
    expect(p.get('magnetos')).toBe(3);
    expect(p.get('mixture')).toBe(1);
    expect(p.get('parkingBrake')).toBe(0);
    expect(p.get('xpdrMode')).toBe(3);
    expect(p.get('fuelSelector')).toBe(1);
    expect(p.get('fuelShutoff')).toBe(1);
    const lights = ac.telemetry.systems!.lights;
    expect(lights).toEqual({ beacon: true, landing: true, taxi: true, nav: true, strobe: true });
    expect(ac.telemetry.engines[0]!.running).toBe(true);
    expect(ac.telemetry.systems!.busVolts).toBeGreaterThan(24);

    const air = airborne(1500, 100).ac;
    expect(air.telemetry.systems!.lights).toEqual({
      beacon: true,
      landing: false,
      taxi: false,
      nav: true,
      strobe: true,
    });
  });

  it('starts a cold aircraft parked: master off, magnetos off, idle cut-off, brake set', () => {
    const { ac, env } = cold();
    const p = ac.cockpit;
    for (const spec of p.specs) expect(p.get(spec.id), spec.id).toBe(spec.initial);
    expect(ac.controls.parkingBrake).toBe(true);
    expect(ac.controls.mixture[0]).toBe(0);
    fly({ ac, env }, 1);
    const s = ac.telemetry.systems!;
    expect(s.busVolts).toBe(0);
    expect(s.avionicsPowered).toBe(false);
    expect(Object.values(s.lights).some((l) => l)).toBe(false);
    expect(ac.telemetry.engines[0]!.running).toBe(false);
  });

  it('keeps the flap lever set before a reset', () => {
    const f = airborne(1500, 62, { flaps: 1 });
    expect(f.ac.cockpit.get('flaps')).toBe(3);
    expect(f.ac.telemetry.flaps).toBe(1);
  });

  it('lights the exterior lights by switch, and only with the bus powered', () => {
    const f = onGround();
    const p = f.ac.cockpit;
    p.set('lightLanding', 0);
    p.set('lightStrobe', 0);
    fly(f, 0.1);
    let lights = f.ac.telemetry.systems!.lights;
    expect(lights.landing).toBe(false);
    expect(lights.strobe).toBe(false);
    expect(lights.beacon).toBe(true);
    p.set('battery', 0);
    fly(f, 0.1);
    lights = f.ac.telemetry.systems!.lights;
    expect(lights.beacon).toBe(false);
    expect(lights.nav).toBe(false);
  });
});
