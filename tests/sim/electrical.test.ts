/**
 * The electrical system against the C172S Information Manual, section 7: 24 V battery of
 * 12.75 Ah, 28 V 60 A alternator, LOW VOLTS annunciator below 24.5 V. Electric flaps.
 */
import { describe, expect, it } from 'vitest';
import { C172 } from '../../src/sim/c172';
import type { FlightModel } from '../../src/sim/flightModel';
import { Electrical } from '../../src/sim/systems/electrical';
import { airborne, fly, onGround } from './harness';

const data = C172.systems.electrical;

describe('electrical system', () => {
  it('holds the bus at 28 V with the alternator charging, LOW VOLTS out', () => {
    const f = airborne(1500, 100);
    fly(f, 5);
    const s = f.ac.telemetry.systems!;
    expect(s.busVolts).toBeCloseTo(28, 1);
    expect(s.batteryAmps).toBeGreaterThanOrEqual(0);
    expect(s.annunciators.lowVolts).toBe(false);
    expect(s.avionicsPowered).toBe(true);
  });

  it('runs on the battery alone with the engine stopped: below 24.5 V, LOW VOLTS lit', () => {
    const f = onGround();
    f.ac.controls.mixture[0] = 0;
    fly(f, 10);
    const s = f.ac.telemetry.systems!;
    expect(f.ac.telemetry.engines[0]!.running).toBe(false);
    expect(s.busVolts).toBeGreaterThan(22);
    expect(s.busVolts).toBeLessThan(24.5);
    expect(s.annunciators.lowVolts).toBe(true);
    expect(s.batteryAmps).toBeLessThan(0);
  });

  it('gives at most the published 60 A, from about 1500 rpm on', () => {
    const e = new Electrical(data);
    expect(e.alternatorCapacity(2400)).toBe(60);
    expect(e.alternatorCapacity(700)).toBeLessThan(20);
    e.reset(0.8);
    // 80 A of load at cruise rpm: the alternator gives its 60, the battery the rest.
    e.step(1, {
      battery: true,
      alternator: true,
      alternatorFailed: false,
      rpm: 2400,
      mainLoad: 80,
      avionicsSwitch: false,
    });
    const drawn = (80 * e.volts) / 28;
    expect(drawn + e.amps).toBeCloseTo(60, 6);
    expect(e.amps).toBeLessThan(-5);
    expect(e.volts).toBeLessThan(24.5);
  });

  it('drains a 12.75 Ah battery: radios die first, then the rest of the bus', () => {
    const e = new Electrical(data);
    e.reset(1);
    const input = {
      battery: true,
      alternator: true,
      alternatorFailed: true,
      rpm: 2400,
      mainLoad: 8,
      avionicsSwitch: true,
    };
    let avionicsOff: number | undefined;
    let busOff: number | undefined;
    let ampHours = 0;
    for (let t = 0; t < 3 * 3600; t++) {
      e.step(1, input);
      ampHours -= e.amps / 3600;
      if (!e.avionicsPowered && avionicsOff === undefined) avionicsOff = t;
      if (!e.busPowered && busOff === undefined) busOff = t;
    }
    expect(avionicsOff).toBeDefined();
    expect(busOff).toBeDefined();
    expect(avionicsOff!).toBeLessThan(busOff!);
    // Around half an hour to an hour on the battery with the avionics on.
    expect(avionicsOff! / 60).toBeGreaterThan(25);
    expect(avionicsOff! / 60).toBeLessThan(90);
    // Everything the battery gave is its capacity.
    expect(ampHours).toBeLessThanOrEqual(12.75 + 0.01);
    expect(ampHours).toBeGreaterThan(12.75 * 0.9);
  });

  it('charges the battery back after the start, less as it fills', () => {
    const e = new Electrical(data);
    e.reset(0.6);
    const input = {
      battery: true,
      alternator: true,
      alternatorFailed: false,
      rpm: 2200,
      mainLoad: 10,
      avionicsSwitch: true,
    };
    e.step(1, input);
    const first = e.amps;
    for (let t = 0; t < 1800; t++) e.step(1, input);
    expect(first).toBeGreaterThan(10);
    expect(e.amps).toBeLessThan(first / 2);
    expect(e.charge).toBeGreaterThan(0.9);
    expect(e.volts).toBeCloseTo(28, 6);
  });

  it('moves the flaps only with power, and loads the bus while they move', () => {
    const f = airborne(1500, 75);
    const ac = f.ac as FlightModel;
    // On the battery alone the ammeter shows the motor's current.
    ac.cockpit.set('alternator', 0);
    fly(f, 1);
    const amps = ac.telemetry.systems!.batteryAmps;
    ac.controls.flaps = 1 / 3;
    fly(f, 1);
    expect(ac.telemetry.systems!.batteryAmps).toBeLessThan(amps - 5);
    fly(f, 4);
    expect(ac.telemetry.flaps).toBeCloseTo(1 / 3, 6);
    ac.cockpit.set('battery', 0);
    ac.controls.flaps = 1;
    fly(f, 10);
    expect(ac.telemetry.flaps).toBeCloseTo(1 / 3, 6);
    ac.cockpit.set('battery', 1);
    fly(f, 10);
    expect(ac.telemetry.flaps).toBe(1);
  });

  it('powers the avionics bus only with its switch and the master', () => {
    const f = onGround();
    const p = f.ac.cockpit;
    p.set('avionics', 0);
    fly(f, 0.1);
    expect(f.ac.telemetry.systems!.avionicsPowered).toBe(false);
    p.set('avionics', 1);
    fly(f, 0.1);
    expect(f.ac.telemetry.systems!.avionicsPowered).toBe(true);
    p.set('battery', 0);
    fly(f, 0.1);
    expect(f.ac.telemetry.systems!.avionicsPowered).toBe(false);
    expect(f.ac.telemetry.systems!.busVolts).toBe(0);
    expect(f.ac.telemetry.instruments!.turnFlag).toBe(true);
  });
});
