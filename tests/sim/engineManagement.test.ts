/**
 * Engine management of the Lycoming IO-360-L2A against the C172S Information Manual:
 * magneto check at 1800 rpm (drop not above 150 rpm on either magneto, not more than 50 rpm
 * between them), the cold start (mixture rich, throttle open 1/4 inch, auxiliary pump to prime,
 * starter; oil pressure within 30 seconds), oil pressure 20 psi minimum at idle and 50-90 psi
 * green, oil temperature green 100-245 °F (38-118 °C), leaning above 3000 ft.
 */
import { describe, expect, it } from 'vitest';
import { TestEnvironment, createAircraft } from '../../src/sim';
import type { FlightModel } from '../../src/sim/flightModel';
import { FT, SpeedPilot, airborne, fly, onGround, type Flight } from './harness';

const rpm = (f: Flight) => f.ac.telemetry.engines[0]!.rpm;
const running = (f: Flight) => f.ac.telemetry.engines[0]!.running;

function cold(options: { ambientIsaDeviation?: number } = {}): Flight & { ac: FlightModel } {
  const env = new TestEnvironment({ isaDeviation: options.ambientIsaDeviation });
  const ac = createAircraft('c172') as FlightModel;
  ac.reset(
    { position: env.position(0), headingDeg: 0, speed: 0, onGround: true, enginesRunning: false },
    env,
  );
  return { ac, env };
}

/** Throttle set for 1800 rpm on the brakes, as for the run-up. */
function runUp(): Flight & { ac: FlightModel } {
  const f = onGround() as Flight & { ac: FlightModel };
  f.ac.controls.parkingBrake = true;
  let throttle = 0.5;
  for (let k = 0; k < 40; k++) {
    f.ac.controls.throttle[0] = throttle;
    fly(f, 2);
    throttle += (1800 - rpm(f)) * 0.0002;
  }
  fly(f, 5);
  return f;
}

describe('magnetos', () => {
  it('drops at most 150 rpm on either magneto at the 1800 rpm run-up, within 50 of each other', () => {
    const f = runUp();
    const both = rpm(f);
    expect(both).toBeCloseTo(1800, -1);
    f.ac.cockpit.set('magnetos', 1);
    fly(f, 5);
    const right = both - rpm(f);
    f.ac.cockpit.set('magnetos', 3);
    fly(f, 5);
    expect(rpm(f)).toBeCloseTo(both, 0);
    f.ac.cockpit.set('magnetos', 2);
    fly(f, 5);
    const left = both - rpm(f);
    for (const drop of [left, right]) {
      expect(drop).toBeGreaterThan(75);
      expect(drop).toBeLessThanOrEqual(150);
    }
    expect(Math.abs(left - right)).toBeLessThanOrEqual(50);
  });

  it('stops the engine on OFF', () => {
    const f = onGround();
    f.ac.cockpit.set('magnetos', 0);
    fly(f, 8);
    expect(running(f)).toBe(false);
    expect(rpm(f)).toBeLessThan(1);
  });
});

describe('starting', () => {
  it('starts cold as in the handbook: mixture rich, throttle 1/4 inch, prime, start', () => {
    const f = cold();
    const p = f.ac.cockpit;
    p.set('battery', 1);
    p.set('lightBeacon', 1);
    p.set('throttle', 0.08);
    p.set('mixture', 1);
    p.set('fuelPump', 1);
    fly(f, 4);
    p.set('fuelPump', 0);
    p.set('magnetos', 4);
    const crank = fly(f, 8, () => running(f) && rpm(f) > 500);
    p.set('magnetos', 3);
    expect(running(f)).toBe(true);
    expect(crank).toBeLessThan(5);
    p.set('alternator', 1);
    // Oil pressure within 30 seconds, else shut down.
    fly(f, 30);
    const s = f.ac.telemetry.systems!;
    expect(s.oilPressure).toBeGreaterThan(20);
    expect(rpm(f)).toBeGreaterThan(800);
    expect(rpm(f)).toBeLessThan(1400);
    expect(s.batteryAmps).toBeGreaterThan(0);
  });

  it('does not fire a cold engine that was not primed', () => {
    const f = cold();
    const p = f.ac.cockpit;
    p.set('battery', 1);
    p.set('throttle', 0.08);
    p.set('mixture', 1);
    p.set('magnetos', 4);
    fly(f, 5);
    expect(running(f)).toBe(false);
    // The starter turns it, though.
    expect(rpm(f)).toBeGreaterThan(150);
  });

  it('needs battery power to crank, and fuel, mixture and ignition to fire', () => {
    const attempt = (setup: (f: Flight & { ac: FlightModel }) => void) => {
      const f = cold();
      const p = f.ac.cockpit;
      p.set('battery', 1);
      p.set('throttle', 0.08);
      p.set('mixture', 1);
      p.set('fuelPump', 1);
      fly(f, 4);
      p.set('fuelPump', 0);
      p.set('magnetos', 4);
      setup(f);
      fly(f, 5);
      return { running: running(f), rpm: rpm(f) };
    };
    expect(attempt(() => {}).running).toBe(true);
    const noBattery = attempt((f) => f.ac.cockpit.set('battery', 0));
    expect(noBattery.rpm).toBe(0);
    expect(noBattery.running).toBe(false);
    expect(attempt((f) => f.ac.cockpit.set('mixture', 0)).running).toBe(false);
    // With the valve shut it may catch on the primed fuel and what is in the lines, but it
    // cannot keep running.
    expect(
      attempt((f) => {
        f.ac.cockpit.set('fuelShutoff', 0);
        fly(f, 25);
      }).running,
    ).toBe(false);
    // Turned past START by ControlInput's starter with the switch OFF: START grounds nothing,
    // so the key alone is enough (it passes BOTH on the way).
    const key = attempt((f) => {
      f.ac.cockpit.set('magnetos', 0);
      f.ac.controls.starter = [true];
    });
    expect(key.running).toBe(true);
  });

  it('cannot crank on a flat battery', () => {
    const f = cold();
    f.ac.systems.electrical.charge = 0.005;
    const p = f.ac.cockpit;
    p.set('battery', 1);
    p.set('mixture', 1);
    p.set('magnetos', 4);
    fly(f, 3);
    expect(rpm(f)).toBeLessThan(60);
  });
});

describe('mixture', () => {
  it('stops the engine at idle cut-off', () => {
    const f = onGround();
    f.ac.cockpit.set('mixture', 0);
    fly(f, 8);
    expect(running(f)).toBe(false);
    expect(f.ac.telemetry.engines[0]!.fuelFlow).toBe(0);
  });

  it('is rich of peak at full rich; leaning to peak EGT cuts the fuel flow', () => {
    const f = airborne(1000 * FT, 100);
    f.ac.controls.throttle[0] = 0.8;
    fly(f, 20);
    const s = f.ac.telemetry.systems!;
    const rich = { egt: s.egt, flow: f.ac.telemetry.engines[0]!.fuelFlow };
    expect(rich.egt).toBeLessThan(0.95);
    let peak = { mixture: 1, egt: 0, flow: 0 };
    for (let m = 1; m >= 0.6; m -= 0.02) {
      f.ac.controls.mixture[0] = m;
      fly(f, 8);
      if (s.egt > peak.egt)
        peak = { mixture: m, egt: s.egt, flow: f.ac.telemetry.engines[0]!.fuelFlow };
    }
    expect(peak.mixture).toBeLessThan(0.9);
    expect(peak.egt).toBeGreaterThan(rich.egt + 0.05);
    expect(peak.flow).toBeLessThan(rich.flow * 0.9);
  });

  it('needs leaning at altitude: leaning at 8000 ft gives more power on less fuel', () => {
    const f = airborne(8000 * FT, 105);
    f.ac.controls.throttle[0] = 1;
    const pilot = new SpeedPilot(f.ac, 0);
    fly(f, 20, (dt) => pilot.step(95, dt));
    const e = f.ac.telemetry.engines[0]!;
    const rich = { power: e.power, flow: e.fuelFlow, egt: f.ac.telemetry.systems!.egt };
    f.ac.controls.mixture[0] = 0.85;
    fly(f, 20, (dt) => pilot.step(95, dt));
    expect(e.power).toBeGreaterThan(rich.power * 1.02);
    expect(e.fuelFlow).toBeLessThan(rich.flow);
    expect(f.ac.telemetry.systems!.egt).toBeGreaterThan(rich.egt);
  });
});

describe('oil', () => {
  it('stays in the green in cruise and climb, and above 20 psi at idle', () => {
    const f = airborne(3000 * FT, 105);
    f.ac.controls.throttle[0] = 0.75;
    fly(f, 600);
    let s = f.ac.telemetry.systems!;
    expect(s.oilTemperature).toBeGreaterThan(38);
    expect(s.oilTemperature).toBeLessThan(118);
    expect(s.oilPressure).toBeGreaterThan(50);
    expect(s.oilPressure).toBeLessThan(90);
    // A long full-power climb at Vy runs hotter than the cruise, still below the red line.
    const cruiseTemp = s.oilTemperature;
    f.ac.controls.throttle[0] = 1;
    const pilot = new SpeedPilot(f.ac, 0);
    fly(f, 400, (dt) => pilot.step(74, dt));
    s = f.ac.telemetry.systems!;
    expect(s.oilTemperature).toBeGreaterThan(cruiseTemp);
    expect(s.oilTemperature).toBeLessThan(118);

    const g = onGround();
    fly(g, 120);
    s = g.ac.telemetry.systems!;
    expect(s.oilPressure).toBeGreaterThan(20);
    expect(s.annunciators.oilPressure).toBe(false);
    g.ac.cockpit.set('mixture', 0);
    fly(g, 10);
    expect(s.oilPressure).toBeLessThan(1);
    expect(s.annunciators.oilPressure).toBe(true);
  }, 30_000);

  it('warms up over some minutes after a cold start', () => {
    const f = cold();
    const p = f.ac.cockpit;
    p.set('battery', 1);
    p.set('throttle', 0.08);
    p.set('mixture', 1);
    p.set('fuelPump', 1);
    fly(f, 4);
    p.set('fuelPump', 0);
    p.set('magnetos', 4);
    fly(f, 3);
    p.set('magnetos', 3);
    p.set('throttle', 0.25);
    const s = f.ac.telemetry.systems!;
    const t0 = s.oilTemperature;
    fly(f, 60);
    // Cold oil is thick: the pressure runs high at first.
    expect(s.oilPressure).toBeGreaterThan(50);
    fly(f, 300);
    expect(s.oilTemperature - t0).toBeGreaterThan(25);
  });
});

describe('alternate air and induction ice', () => {
  it('costs a little power with alternate air', () => {
    const f = airborne(1500, 100);
    f.ac.controls.throttle[0] = 1;
    fly(f, 10);
    const e = f.ac.telemetry.engines[0]!;
    const before = e.power;
    f.ac.cockpit.set('carbHeat', 1);
    fly(f, 5);
    expect(e.power).toBeLessThan(before * 0.99);
    expect(e.power).toBeGreaterThan(before * 0.93);
  });

  it('ices the induction in cloud below freezing; alternate air clears it', () => {
    const f = airborne(1500, 100, { isaDeviation: -20, moisture: 1 });
    f.ac.controls.throttle[0] = 0.8;
    fly(f, 2);
    const e = f.ac.telemetry.engines[0]!;
    const s = f.ac.telemetry.systems!;
    const before = e.power;
    fly(f, 120);
    expect(s.carbIce).toBeGreaterThan(0.2);
    expect(e.power).toBeLessThan(before * 0.9);
    f.ac.cockpit.set('carbHeat', 1);
    fly(f, 60);
    expect(s.carbIce).toBe(0);
    expect(e.power).toBeGreaterThan(before * 0.9);
  });
});
