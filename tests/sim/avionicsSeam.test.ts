/**
 * The seam for the avionics unit: the flight model drives whatever AvionicsUnit it is given,
 * passes it the aircraft's state, shows its telemetry and lets its autopilot fly. A fake unit
 * stands in for the real one here.
 */
import { describe, expect, it } from 'vitest';
import {
  TestEnvironment,
  type AutopilotCommand,
  type AvionicsInput,
  type AvionicsTelemetry,
  type AvionicsUnit,
  type Cockpit,
  type NavDatabase,
  type Waypoint,
} from '../../src/sim';
import { C172 } from '../../src/sim/c172';
import { FlightModel } from '../../src/sim/flightModel';
import { DEG, KT, fly } from './harness';

const receiver = () => ({
  frequency: 110_000,
  valid: false,
  ident: '',
  localizer: false,
  course: 0,
  deviation: 0,
  toFrom: 'off' as const,
  bearing: undefined,
  glideSlope: undefined,
  standby: 110_000,
});

class FakeAvionics implements AvionicsUnit {
  readonly inputs: AvionicsInput[] = [];
  command: AutopilotCommand | undefined;
  plan: readonly Waypoint[] = [];
  resets = 0;
  database: NavDatabase | undefined;
  /** What the autopilot commands while "engaged". */
  engage: AutopilotCommand | undefined;
  readonly telemetry: AvionicsTelemetry = {
    powered: false,
    com1: { active: 118_100, standby: 121_500 },
    com2: { active: 121_500, standby: 121_500 },
    nav1: receiver(),
    nav2: receiver(),
    dme: { source: 'nav1', distanceNm: undefined, groundSpeedKt: undefined, minutes: undefined },
    adf: { frequency: 300, valid: false, ident: '', relativeBearing: undefined },
    transponder: { code: 7000, mode: 'alt', ident: false, reply: false },
    markers: { outer: false, middle: false, inner: false },
    autopilot: {
      engaged: false,
      lateral: 'roll',
      lateralArmed: undefined,
      vertical: 'pitch',
      verticalArmed: undefined,
      selectedAltitude: 3000,
      selectedVerticalSpeed: 0,
      disconnectWarning: false,
    },
    gps: {
      plan: [],
      active: -1,
      distanceNm: undefined,
      bearing: undefined,
      desiredTrack: undefined,
      crossTrackNm: undefined,
      groundSpeedKt: 0,
      track: 0,
      lon: 0,
      lat: 0,
    },
  };
  setDatabase(db: NavDatabase) {
    this.database = db;
  }
  setFlightPlan(plan: readonly Waypoint[]) {
    this.plan = plan;
  }
  directTo() {}
  reset() {
    this.resets++;
    this.command = undefined;
  }
  step(_dt: number, input: AvionicsInput, cockpit: Cockpit) {
    this.inputs.push({ ...input });
    this.telemetry.powered = input.powered;
    this.telemetry.com1.active = cockpit.get('com1Active');
    const engaged = input.powered && this.engage !== undefined;
    this.telemetry.autopilot.engaged = engaged;
    this.command = engaged ? this.engage : undefined;
  }
}

function setup(unit?: FakeAvionics) {
  const env = new TestEnvironment({ declination: 2.5, geoidHeight: 48 });
  const ac = new FlightModel(C172, unit);
  ac.reset({ position: env.position(1500), headingDeg: 30, speed: 100 * KT, onGround: false }, env);
  return { ac, env, f: { ac, env } };
}

describe('avionics seam', () => {
  it('flies as before without an avionics unit', () => {
    const { ac, f } = setup();
    expect(ac.avionicsUnit).toBeUndefined();
    expect(ac.telemetry.avionics).toBeUndefined();
    // The setup calls go nowhere, without failing.
    ac.avionics.setFlightPlan([{ ident: 'BERN', lon: 7.5, lat: 46.9 }]);
    ac.avionics.directTo(0);
    const h0 = ac.telemetry.altitude;
    fly(f, 20);
    expect(Math.abs(ac.telemetry.altitude - h0)).toBeLessThan(10);
  });

  it('steps the unit with the aircraft state and shows its telemetry', () => {
    const unit = new FakeAvionics();
    const { ac, f } = setup(unit);
    expect(unit.resets).toBe(1);
    expect(ac.avionics).toBe(unit);
    const plan = [{ ident: 'BERN', lon: 7.5, lat: 46.9 }];
    ac.avionics.setFlightPlan(plan);
    expect(unit.plan).toBe(plan);
    ac.cockpit.set('com1Active', 120_450);
    fly(f, 1);
    expect(ac.telemetry.avionics).toBe(unit.telemetry);
    expect(unit.telemetry.com1.active).toBe(120_450);
    const i = unit.inputs.at(-1)!;
    const t = ac.telemetry;
    expect(i.powered).toBe(true);
    expect(i.com1Failed).toBe(false);
    expect(i.lat).toBeCloseTo(46.91, 1);
    expect(i.lon).toBeCloseTo(7.5, 1);
    expect(i.altitude).toBeCloseTo(1500 - 48, -1);
    expect(i.heading).toBeCloseTo(t.headingDeg, 0);
    expect(i.ias).toBeCloseTo(t.ias, 0);
    expect(i.declination).toBe(2.5);
    expect(i.indicatedHeading).toBeCloseTo(t.headingDeg - 2.5, 0);
    expect(i.indicatedAltitude).toBeCloseTo(1500 - 48, -1);
    expect(i.onGround).toBe(false);
    // Avionics switch off: the unit is told it has no power; COM 1 failure is passed on.
    ac.cockpit.set('avionics', 0);
    ac.failures.set('com1', true);
    fly(f, 0.1);
    expect(unit.inputs.at(-1)!.powered).toBe(false);
    expect(unit.inputs.at(-1)!.com1Failed).toBe(true);
    expect(ac.telemetry.avionics!.powered).toBe(false);
  });

  it("lets the engaged autopilot fly pitch, roll and trim instead of the pilot's yoke", () => {
    const unit = new FakeAvionics();
    const { ac, f } = setup(unit);
    const trim = ac.controls.pitchTrim;
    unit.engage = { roll: 0.3, pitch: 0, pitchTrim: trim + 0.05 };
    let pilotSaw = 0;
    fly(f, 3, () => {
      // The pilot holds the yoke neutral; the unit still sees the pilot's own input.
      ac.controls.roll = 0;
      ac.controls.pitch = 0.01;
      pilotSaw = unit.inputs.at(-1)?.pilotPitch ?? 0;
    });
    expect(ac.telemetry.bank).toBeGreaterThan(10 * DEG);
    expect(ac.controls.pitchTrim).toBeCloseTo(trim + 0.05, 9);
    expect(pilotSaw).toBe(0.01);
    expect(ac.controls.roll).toBe(0);
    // Disengaged: the pilot has the aircraft back, the trim stays where it was left.
    unit.engage = undefined;
    const bank = ac.telemetry.bank;
    fly(f, 2, () => {
      ac.controls.roll = -0.5;
    });
    expect(ac.telemetry.bank).toBeLessThan(bank);
    expect(ac.controls.pitchTrim).toBeCloseTo(trim + 0.05, 9);
  });
});
