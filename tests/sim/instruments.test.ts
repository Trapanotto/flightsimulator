/**
 * Vacuum and pitot-static systems and the flight instruments. Published figures: suction
 * 4.5-5.5 in Hg green and LOW VACUUM below 3.0 in Hg (C172S Information Manual, sections 2
 * and 7); a directional gyro may precess up to 3° in 15 minutes (FAA Instrument Flying
 * Handbook, FAA-H-8083-15B, chapter 5); a standard-rate turn is 3°/s; the altimeter follows
 * the ICAO standard atmosphere (Doc 7488), about 8.3 m (27 ft) per hPa near sea level.
 */
import { describe, expect, it } from 'vitest';
import { TestEnvironment, createAircraft } from '../../src/sim';
import type { FlightModel } from '../../src/sim/flightModel';
import { altimeterReading } from '../../src/sim/systems/instruments';
import {
  AltitudePilot,
  AttitudePilot,
  DEG,
  FT,
  KT,
  SpeedPilot,
  airborne,
  fly,
  headingError,
  onGround,
  type Flight,
} from './harness';

const ins = (f: Flight) => f.ac.telemetry.instruments!;

/** Level flight on a heading, holding altitude; bank commanded by `bank` (rad) if given. */
function level(f: Flight, heading: number, bank?: () => number) {
  const pilot = new AltitudePilot(f.ac, heading, f.ac.telemetry.altitude);
  const attitude = new AttitudePilot(f.ac);
  return (dt: number) => {
    pilot.step(dt);
    if (bank) {
      attitude.bankTo(bank(), dt);
      attitude.ball();
    }
  };
}

describe('vacuum system and gyros', () => {
  it('gives 4.5 to 5.5 in Hg in flight and at run-up power, less at idle', () => {
    const f = airborne(1500, 100);
    fly(f, 5);
    const s = f.ac.telemetry.systems!;
    expect(s.vacuum).toBeGreaterThanOrEqual(4.5);
    expect(s.vacuum).toBeLessThanOrEqual(5.5);
    expect(s.annunciators.lowVacuum).toBe(false);
    expect(ins(f).gyroFlag).toBe(false);
    const g = onGround();
    fly(g, 5);
    expect(g.ac.telemetry.systems!.vacuum).toBeLessThan(4.5);
    expect(g.ac.telemetry.systems!.vacuum).toBeGreaterThan(3);
  });

  it('shows the truth with suction; topples slowly after a vacuum failure', () => {
    const f = airborne(1500, 100);
    const t = f.ac.telemetry;
    const i = ins(f);
    const weave = level(f, 0, () => 15 * DEG * Math.sin(t.time / 8));
    fly(f, 20, weave);
    expect(Math.abs(i.bank - t.bank) / DEG).toBeLessThan(0.5);
    expect(Math.abs(i.pitch - t.pitch) / DEG).toBeLessThan(0.5);
    f.ac.failures.set('vacuum', true);
    fly(f, 5, weave);
    expect(t.systems!.vacuum).toBeLessThan(0.5);
    expect(t.systems!.annunciators.lowVacuum).toBe(true);
    expect(i.gyroFlag).toBe(true);
    // Slowly: the rotor still holds for a while.
    fly(f, 25, weave);
    expect(Math.abs(i.bank - t.bank) / DEG).toBeLessThan(2);
    fly(f, 300, weave);
    const bankError = Math.abs(i.bank - t.bank) / DEG;
    const headingWrong = Math.abs(headingError(i.heading, t.headingDeg));
    expect(bankError + headingWrong).toBeGreaterThan(10);
  });

  it('drifts the directional gyro about 3° in 15 minutes; the knob realigns it', () => {
    const f = airborne(3000 * FT, 100);
    const t = f.ac.telemetry;
    fly(f, 900, level(f, 0));
    const drift = headingError(ins(f).heading, t.headingDeg);
    // The Earth turns under the gyro at 15°/h × sin(latitude): 2.7° in 15 min at Bern.
    expect(Math.abs(drift)).toBeGreaterThan(2);
    expect(Math.abs(drift)).toBeLessThanOrEqual(3);
    f.ac.cockpit.set('gyroAdjust', -Math.round(drift));
    fly(f, 0.1);
    expect(Math.abs(headingError(ins(f).heading, t.headingDeg))).toBeLessThan(0.6);
  }, 20_000);

  it('spins the gyros up after a cold start and erects the attitude indicator', () => {
    const env = new TestEnvironment();
    const ac = createAircraft('c172') as FlightModel;
    ac.reset(
      { position: env.position(0), headingDeg: 0, speed: 0, onGround: true, enginesRunning: false },
      env,
    );
    const f = { ac, env };
    // Parked: the attitude indicator lies tilted, no suction.
    expect(Math.abs(ins(f).bank - ac.telemetry.bank) / DEG).toBeGreaterThan(5);
    const p = ac.cockpit;
    p.set('battery', 1);
    p.set('mixture', 1);
    p.set('throttle', 0.08);
    p.set('fuelPump', 1);
    fly(f, 4);
    p.set('fuelPump', 0);
    p.set('magnetos', 4);
    fly(f, 3);
    p.set('magnetos', 3);
    p.set('throttle', 0.2);
    fly(f, 240);
    expect(ac.telemetry.engines[0]!.running).toBe(true);
    expect(Math.abs(ins(f).bank - ac.telemetry.bank) / DEG).toBeLessThan(1);
    expect(Math.abs(ins(f).pitch - ac.telemetry.pitch) / DEG).toBeLessThan(1);
  });
});

describe('magnetic compass', () => {
  it('reads the magnetic heading in steady flight', () => {
    const f = airborne(1500, 100, { heading: 90, declination: 3 });
    fly(f, 10, level(f, 90));
    expect(ins(f).compass).toBeCloseTo(f.ac.telemetry.headingDeg - 3, 0);
    expect(ins(f).heading).toBeCloseTo(f.ac.telemetry.headingDeg - 3, 0);
  });

  it('turning from north, first shows a turn the other way; from south, leads the turn', () => {
    const north = airborne(1500, 90, { heading: 0 });
    fly(north, 3, level(north, 0));
    let minNorth = 0;
    fly(north, 4, (dt) => {
      level(north, 0, () => 20 * DEG)(dt);
      minNorth = Math.min(minNorth, headingError(ins(north).compass, 0));
    });
    expect(headingError(north.ac.telemetry.headingDeg, 0)).toBeGreaterThan(3);
    expect(minNorth).toBeLessThan(-3);

    const south = airborne(1500, 90, { heading: 180 });
    fly(south, 3, level(south, 180));
    fly(
      south,
      4,
      level(south, 180, () => 20 * DEG),
    );
    const turned = headingError(south.ac.telemetry.headingDeg, 180);
    const shown = headingError(ins(south).compass, 180);
    expect(turned).toBeGreaterThan(3);
    expect(shown).toBeGreaterThan(turned + 5);
  });

  it('heading east, shows a turn to the north while accelerating and to the south while slowing', () => {
    const fast = airborne(1500, 70, { heading: 90 });
    fast.ac.controls.throttle[0] = 1;
    let minShown = 90;
    fly(fast, 8, (dt) => {
      level(fast, 90)(dt);
      minShown = Math.min(minShown, ins(fast).compass);
    });
    expect(minShown).toBeLessThan(90 - 3);

    const slow = airborne(1500, 120, { heading: 90 });
    slow.ac.controls.throttle[0] = 0;
    let maxShown = 90;
    fly(slow, 8, (dt) => {
      level(slow, 90)(dt);
      maxShown = Math.max(maxShown, ins(slow).compass);
    });
    expect(maxShown).toBeGreaterThan(90 + 3);
  });
});

describe('turn coordinator', () => {
  it('shows 3°/s in a standard-rate turn, with the ball centred', () => {
    const tas = 90 * KT;
    const bank = Math.atan((tas * 3 * DEG) / 9.80665);
    const f = airborne(1500, 90);
    fly(
      f,
      30,
      level(f, 0, () => bank),
    );
    expect(ins(f).turnRate).toBeGreaterThan(2.7);
    expect(ins(f).turnRate).toBeLessThan(3.3);
    expect(Math.abs(ins(f).slip)).toBeLessThan(0.15);
    expect(ins(f).turnFlag).toBe(false);
  });

  it('puts the ball out of a skid and stops without power', () => {
    const f = airborne(1500, 90);
    const attitude = new AttitudePilot(f.ac);
    fly(f, 3, (dt) => {
      attitude.bankTo(0, dt);
      f.ac.controls.yaw = 0.6;
    });
    // Too much right rudder: the ball goes left.
    expect(ins(f).slip).toBeLessThan(-0.2);
    f.ac.controls.yaw = 0;
    f.ac.cockpit.set('battery', 0);
    fly(
      f,
      60,
      level(f, 0, () => 20 * DEG),
    );
    expect(ins(f).turnFlag).toBe(true);
    expect(Math.abs(ins(f).turnRate)).toBeLessThan(1);
  });
});

describe('pitot-static instruments', () => {
  it('reads altitude above sea level for the actual QNH, about 8.3 m per hPa off it', () => {
    const at = (qnh: number, setting: number, geoidHeight = 0) => {
      const env = new TestEnvironment({ qnh, elevation: 500, geoidHeight });
      const ac = createAircraft('c172');
      ac.reset({ position: env.position(0), headingDeg: 0, speed: 0, onGround: true }, env);
      ac.cockpit.set('altimeterSetting', setting);
      ac.step(1 / 120, env);
      return ac.telemetry.instruments!.altitude - (ac.telemetry.altitude - geoidHeight);
    };
    // Set to QNH, the altimeter reads the elevation of the reference point (the wheels are
    // a metre below it).
    expect(Math.abs(at(1023, 1023))).toBeLessThan(3);
    expect(Math.abs(at(1000, 1000, 50))).toBeLessThan(3);
    // Set 10 hPa too low it reads low by the height of 10 hPa at the setting's datum: about
    // 8.3 m per hPa (the knob shifts the sea-level reference, not the local column).
    const perHpa = (at(1023, 1023) - at(1023, 1013)) / 10;
    expect(perHpa).toBeGreaterThan(8.0);
    expect(perHpa).toBeLessThan(8.5);
    const seaLevel = altimeterReading(101_325, 1013.25) - altimeterReading(101_325, 1014.25);
    expect(seaLevel).toBeCloseTo(-8.3, 1);
  });

  it('lags a few seconds on the vertical speed indicator', () => {
    const f = airborne(1500, 100);
    f.ac.controls.throttle[0] = 1;
    const pilot = new SpeedPilot(f.ac, 0);
    fly(f, 1.5, (dt) => pilot.step(75, dt));
    const t = f.ac.telemetry;
    expect(ins(f).verticalSpeed).toBeLessThan(t.verticalSpeed * 0.8);
    fly(f, 30, (dt) => pilot.step(75, dt));
    expect(ins(f).verticalSpeed).toBeGreaterThan(t.verticalSpeed * 0.9);
    expect(ins(f).verticalSpeed).toBeLessThan(t.verticalSpeed * 1.1);
  });

  it('ices the pitot tube in cloud below freezing unless the heat is on', () => {
    const iced = airborne(1500, 100, { isaDeviation: -20, moisture: 1 });
    const t = iced.ac.telemetry;
    const hold = level(iced, 0);
    const blocked = fly(iced, 180, (dt) => {
      hold(dt);
      return t.systems!.pitotBlocked;
    });
    expect(blocked).toBeLessThan(120);
    // Trapped in the tube, the pressure leaks away: the airspeed falls although it is not.
    fly(iced, 120, hold);
    expect(ins(iced).airspeed).toBeLessThan(t.ias * 0.8);
    // The heater clears it.
    iced.ac.cockpit.set('pitotHeat', 1);
    fly(iced, 15, hold);
    expect(t.systems!.pitotBlocked).toBe(false);
    expect(ins(iced).airspeed).toBe(t.ias);

    const heated = airborne(1500, 100, { isaDeviation: -20, moisture: 1 });
    heated.ac.cockpit.set('pitotHeat', 1);
    fly(heated, 180, level(heated, 0));
    expect(heated.ac.telemetry.systems!.pitotBlocked).toBe(false);
    // Dry air does not ice, whatever the temperature.
    const dry = airborne(1500, 100, { isaDeviation: -20 });
    fly(dry, 180, level(dry, 0));
    expect(dry.ac.telemetry.systems!.pitotBlocked).toBe(false);
  }, 20_000);

  it('reads high in a climb with a blocked pitot tube, like an altimeter', () => {
    const f = airborne(1500, 90);
    f.ac.failures.set('pitot', true);
    f.ac.controls.throttle[0] = 1;
    const pilot = new SpeedPilot(f.ac, 0);
    fly(f, 60, (dt) => pilot.step(80, dt));
    expect(ins(f).airspeed).toBeGreaterThan(f.ac.telemetry.ias + 3 * KT);
  });
});
