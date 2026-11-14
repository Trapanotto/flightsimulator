/**
 * The autopilot flying the real C172 flight model: a closed loop of aircraft, avionics and
 * the autopilot's command, the way the flight model is meant to drive the unit.
 */
import { describe, expect, it } from 'vitest';
import { createAircraft } from '../../src/sim/aircraft';
import type {
  AvionicsInput,
  AvionicsUnit,
  NavDatabase,
  NavStation,
} from '../../src/sim/avionicsTypes';
import { createAvionics } from '../../src/sim/avionics/avionics';
import { destination, rangeBearing, wrap180, wrap360 } from '../../src/sim/avionics/geo';
import { CockpitPanel } from '../../src/sim/cockpit';
import { SIM_DT } from '../../src/sim/fixedStep';
import {
  TestEnvironment,
  ecefToGeodetic,
  type TestEnvironmentOptions,
} from '../../src/sim/testEnvironment';
import type { AirSample, SimAircraft, Vec3 } from '../../src/sim/types';

const KT = 1852 / 3600;
const FT = 0.3048;
const FPM = FT / 60;
const NM = 1852;

const LAT = 46.91;
const LON = 7.5;

/** Wind that varies along the flight path: frozen turbulence, the same on every run. */
class GustyEnvironment extends TestEnvironment {
  constructor(
    options: TestEnvironmentOptions,
    private readonly gust: number,
  ) {
    super(options);
  }
  override air(position: Vec3, out: AirSample): AirSample {
    super.air(position, out);
    const g = this.gust;
    const x = position.x;
    const y = position.y;
    const z = position.z;
    out.wind.x += g * (0.6 * Math.sin(x / 180 + 1.3) + 0.4 * Math.sin(y / 67 + 0.4));
    out.wind.y += g * (0.6 * Math.sin(y / 150 + 2.1) + 0.4 * Math.sin(z / 83 + 2.9));
    out.wind.z += g * (0.6 * Math.sin(z / 210 + 0.2) + 0.4 * Math.sin(x / 59 + 1.1));
    return out;
  }
}

interface RigOptions extends TestEnvironmentOptions {
  /** Height above the ground plane (m), offset north and east of the origin (m). */
  height: number;
  north?: number;
  east?: number;
  heading: number;
  kias: number;
  declination?: number;
  gust?: number;
  stations?: NavStation[];
}

/**
 * The flight model's side of the contract: build the AvionicsInput from the aircraft, step
 * the unit, apply its command to the controls, step the aircraft, release the buttons.
 */
class Rig {
  readonly env: TestEnvironment;
  readonly ac: SimAircraft;
  readonly unit: AvionicsUnit = createAvionics();
  readonly cockpit: CockpitPanel;
  readonly declination: number;
  time = 0;
  /** A pilot hand on the throttle: holds this indicated airspeed if set (knots). */
  holdSpeed: number | undefined;
  private speedIntegral = 0;
  private baseThrottle = NaN;
  /** The directional gyro shows this much too much, degrees. */
  gyroError = 0;
  private lastHeading = NaN;
  readonly input: AvionicsInput = {
    powered: true,
    com1Failed: false,
    lon: 0,
    lat: 0,
    altitude: 0,
    heading: 0,
    track: 0,
    groundSpeed: 0,
    verticalSpeed: 0,
    ias: 0,
    pitch: 0,
    bank: 0,
    turnRate: 0,
    onGround: false,
    declination: 0,
    indicatedHeading: 0,
    indicatedAltitude: 0,
    pilotPitch: 0,
    pilotRoll: 0,
  };

  constructor(o: RigOptions) {
    this.env = o.gust ? new GustyEnvironment(o, o.gust) : new TestEnvironment(o);
    this.ac = createAircraft('c172');
    this.declination = o.declination ?? 0;
    this.ac.reset(
      {
        position: this.env.position(o.height, o.north ?? 0, o.east ?? 0),
        headingDeg: o.heading,
        speed: o.kias * KT,
        onGround: false,
      },
      this.env,
    );
    this.cockpit = this.ac.cockpit as CockpitPanel;
    // C172_CONTROLS: the trim knob is ControlInput's trim lever.
    const controls = this.ac.controls;
    this.cockpit.bind(
      'trim',
      () => controls.pitchTrim,
      (v) => (controls.pitchTrim = v),
    );
    const db: NavDatabase = {
      onFrequency: (f) => (o.stations ?? []).filter((s) => s.frequency === f),
    };
    this.unit.setDatabase(db);
    this.unit.reset();
  }

  press(id: string) {
    this.cockpit.set(id, 1);
  }

  step() {
    const t = this.ac.telemetry;
    const i = this.input;
    const g = ecefToGeodetic(this.ac.state.position);
    i.lat = g.lat;
    i.lon = g.lon;
    i.altitude = t.altitude;
    i.heading = t.headingDeg;
    i.track = t.trackDeg;
    i.groundSpeed = t.groundSpeed;
    i.verticalSpeed = t.verticalSpeed;
    i.ias = t.ias;
    i.pitch = t.pitch;
    i.bank = t.bank;
    i.turnRate = Number.isNaN(this.lastHeading)
      ? 0
      : wrap180(t.headingDeg - this.lastHeading) / SIM_DT;
    this.lastHeading = t.headingDeg;
    i.onGround = t.onGround;
    i.declination = this.declination;
    i.indicatedHeading = wrap360(t.headingDeg - this.declination + this.gyroError);
    i.indicatedAltitude = t.altitude;
    this.unit.step(SIM_DT, i, this.cockpit);
    const c = this.unit.command;
    if (c) {
      this.ac.controls.roll = c.roll;
      this.ac.controls.pitch = c.pitch;
      this.ac.controls.pitchTrim = c.pitchTrim;
    }
    if (this.holdSpeed !== undefined) {
      // A gentle hand: power for the speed over tens of seconds, as a pilot sets it.
      if (Number.isNaN(this.baseThrottle)) this.baseThrottle = this.ac.controls.throttle[0]!;
      const e = this.holdSpeed - t.ias / KT;
      this.speedIntegral = Math.max(-100, Math.min(100, this.speedIntegral + e * SIM_DT));
      this.ac.controls.throttle[0] = Math.max(
        0,
        Math.min(1, this.baseThrottle + 0.02 * e + 0.004 * this.speedIntegral),
      );
    }
    this.ac.step(SIM_DT, this.env);
    // The cockpit releases buttons after a step.
    for (const s of this.cockpit.specs) if (s.kind === 'button') this.cockpit.set(s.id, 0);
    this.time += SIM_DT;
  }

  /** Flies for `seconds`, calling `each` after every step. */
  fly(seconds: number, each?: () => void) {
    const n = Math.round(seconds / SIM_DT);
    for (let k = 0; k < n; k++) {
      this.step();
      each?.();
    }
  }

  get altitudeFt() {
    return this.ac.telemetry.altitude / FT;
  }
  get heading() {
    return this.ac.telemetry.headingDeg;
  }
}

describe('autopilot: heading', () => {
  it('holds the heading and turns 90 degrees without overshooting', () => {
    const rig = new Rig({ height: 3000 * FT, heading: 90, kias: 105, declination: 3 });
    rig.cockpit.set('headingBug', 87);
    rig.press('apEngage');
    rig.fly(1);
    rig.press('apHdg');
    rig.fly(30);
    expect(rig.unit.telemetry.autopilot.lateral).toBe('hdg');
    let worst = 0;
    rig.fly(30, () => (worst = Math.max(worst, Math.abs(wrap180(rig.heading - 90)))));
    expect(worst, 'heading hold, degrees').toBeLessThan(2);

    rig.cockpit.set('headingBug', 177);
    let overshoot = 0;
    let maxBank = 0;
    rig.fly(90, () => {
      overshoot = Math.max(overshoot, wrap180(rig.heading - 180));
      maxBank = Math.max(maxBank, Math.abs(rig.ac.telemetry.bank) / (Math.PI / 180));
    });
    expect(Math.abs(wrap180(rig.heading - 180))).toBeLessThan(2);
    expect(overshoot).toBeLessThan(10);
    expect(maxBank).toBeLessThan(23);
  });
});

describe('autopilot: altitude', () => {
  it.each([
    [0, 50],
    [5, 100],
  ])('holds the altitude in %d m/s of gusty wind within %d ft', (wind, limit) => {
    const rig = new Rig({
      height: 4000 * FT,
      heading: 200,
      kias: 100,
      wind: wind ? { fromDeg: 240, speed: wind } : undefined,
      gust: wind ? wind * 0.5 : 0,
    });
    rig.press('apEngage');
    rig.fly(0.5);
    rig.press('apAlt');
    rig.fly(1);
    const target = rig.altitudeFt;
    rig.fly(20);
    let worst = 0;
    rig.fly(240, () => (worst = Math.max(worst, Math.abs(rig.altitudeFt - target))));
    expect(rig.unit.telemetry.autopilot.vertical).toBe('alt');
    expect(worst).toBeLessThan(limit);
  });

  it('climbs at 500 ft/min and captures the selected altitude', () => {
    const rig = new Rig({ height: 3000 * FT, heading: 0, kias: 90 });
    rig.cockpit.set('apAltitude', 5000);
    rig.press('apEngage');
    rig.fly(0.5);
    for (let k = 0; k < 5; k++) {
      rig.press('apVsUp');
      rig.fly(0.2);
    }
    rig.ac.controls.throttle[0] = 1;
    expect(rig.unit.telemetry.autopilot.selectedVerticalSpeed).toBe(500);
    expect(rig.unit.telemetry.autopilot.verticalArmed).toBe('alt');
    let vsSum = 0;
    let n = 0;
    let peak = 0;
    let minIas = Infinity;
    rig.fly(400, () => {
      const alt = rig.altitudeFt;
      if (alt > 3300 && alt < 4700) {
        vsSum += rig.ac.telemetry.verticalSpeed / FPM;
        n++;
      }
      peak = Math.max(peak, alt);
      minIas = Math.min(minIas, rig.ac.telemetry.ias / KT);
    });
    expect(vsSum / n).toBeGreaterThan(450);
    expect(vsSum / n).toBeLessThan(550);
    expect(rig.unit.telemetry.autopilot.vertical).toBe('alt');
    expect(peak - 5000).toBeLessThan(50);
    expect(Math.abs(rig.altitudeFt - 5000)).toBeLessThan(20);
  });
});

/** A made-up navigation database around the test origin. */
const ELEVATION = 500;
const vor: NavStation = {
  ident: 'TST',
  name: 'Test VOR',
  type: 'VOR-DME',
  frequency: 113_300,
  lat: LAT,
  lon: LON,
  elevation: ELEVATION,
  rangeNm: 80,
};

describe('autopilot: NAV', () => {
  it('intercepts and tracks a VOR radial in a 10 m/s crosswind', () => {
    // 15 NM south and 2 NM east of the VOR, inbound on the 180 radial (course 360).
    const rig = new Rig({
      elevation: ELEVATION,
      height: 4000 * FT,
      north: -15 * NM,
      east: 2 * NM,
      heading: 315,
      kias: 105,
      declination: 2,
      wind: { fromDeg: 272, speed: 10 },
      stations: [vor],
    });
    rig.cockpit.set('nav1Active', 113_300);
    rig.cockpit.set('obs1', 0);
    rig.cockpit.set('headingBug', 313);
    rig.press('apEngage');
    rig.fly(0.5);
    rig.press('apHdg');
    rig.fly(0.5);
    rig.press('apAlt');
    rig.fly(0.5);
    rig.press('apNav');
    rig.fly(0.5);
    const ap = rig.unit.telemetry.autopilot;
    expect(ap.lateralArmed ?? ap.lateral).toBe('nav');
    const rb = { distance: 0, bearing: 0 };
    const crossTrack = () => {
      const g = ecefToGeodetic(rig.ac.state.position);
      rangeBearing(LAT, LON, g.lat, g.lon, rb);
      return {
        xt: (rb.distance * Math.sin((rb.bearing - 182) * (Math.PI / 180))) / NM,
        d: rb.distance / NM,
      };
    };
    let captured = NaN;
    let onCourse = NaN;
    let worst = 0;
    let toFrom = '';
    rig.fly(600, () => {
      if (Number.isNaN(captured) && ap.lateral === 'nav') captured = rig.time;
      const { xt, d } = crossTrack();
      // Settled: first time within 0.1 NM, then a minute to take out the wind.
      if (Number.isNaN(onCourse) && Math.abs(xt) < 0.1) onCourse = rig.time;
      if (rig.time > onCourse + 60 && d > 2) worst = Math.max(worst, Math.abs(xt));
      const tf = rig.unit.telemetry.nav1.toFrom;
      if (!toFrom.endsWith(tf)) toFrom += (toFrom ? ' ' : '') + tf;
    });
    expect(captured).toBeLessThan(200);
    expect(onCourse).toBeLessThan(300);
    expect(worst).toBeLessThan(0.3);
    // Passing the station: TO, the cone of confusion, FROM.
    expect(toFrom).toBe('to off from');
    expect(rig.unit.telemetry.autopilot.lateral).toBe('nav');
  });
});

/** An ILS for a runway whose threshold is at the origin, course 140 degrees true. */
const RWY_COURSE = 140;
const RWY_LENGTH = 2000;
const at = (course: number, distance: number, from = { lat: LAT, lon: LON }) =>
  destination(from.lat, from.lon, course, distance, { lat: 0, lon: 0 });
const locPos = at(RWY_COURSE, RWY_LENGTH + 300);
const gsPos = at(RWY_COURSE + 90, 120, at(RWY_COURSE, 300));
const ils: NavStation = {
  ident: 'ITST',
  name: 'Test ILS 14',
  type: 'ILS',
  frequency: 110_300,
  lat: locPos.lat,
  lon: locPos.lon,
  elevation: ELEVATION,
  rangeNm: 25,
  course: RWY_COURSE,
  glideSlope: { lat: gsPos.lat, lon: gsPos.lon, elevation: ELEVATION, angleDeg: 3 },
  dme: { lat: gsPos.lat, lon: gsPos.lon, elevation: ELEVATION },
  airport: 'LSZT',
  runway: '14',
};

describe('autopilot: APR', () => {
  it('flies a coupled ILS approach in a 5 m/s crosswind', () => {
    // 8 NM out on the extended centreline, 0.6 NM to the left, closing at 30 degrees.
    const start = at(RWY_COURSE + 270, 0.6 * NM, at(RWY_COURSE + 180, 8 * NM));
    const rbStart = { distance: 0, bearing: 0 };
    rangeBearing(LAT, LON, start.lat, start.lon, rbStart);
    const rig = new Rig({
      elevation: ELEVATION,
      height: 2500 * FT,
      north: rbStart.distance * Math.cos((rbStart.bearing * Math.PI) / 180),
      east: rbStart.distance * Math.sin((rbStart.bearing * Math.PI) / 180),
      heading: RWY_COURSE + 30,
      kias: 90,
      declination: 2,
      wind: { fromDeg: RWY_COURSE - 90, speed: 5 },
      stations: [ils],
    });
    rig.holdSpeed = 90;
    rig.cockpit.set('nav1Active', 110_300);
    rig.cockpit.set('headingBug', RWY_COURSE + 30 - 2);
    rig.press('apEngage');
    rig.fly(0.5);
    rig.press('apHdg');
    rig.fly(0.5);
    rig.press('apAlt');
    rig.fly(0.5);
    rig.press('apApr');
    rig.fly(0.5);
    const ap = rig.unit.telemetry.autopilot;
    const nav = rig.unit.telemetry.nav1;
    expect(ap.lateralArmed).toBe('apr');
    expect(ap.verticalArmed).toBe('gs');
    const rb = { distance: 0, bearing: 0 };
    let worstLoc = 0;
    let worstGs = 0;
    let locCapture = NaN;
    let gsCapture = NaN;
    let markers = '';
    for (let k = 0; k < 600 * 120; k++) {
      rig.step();
      const g = ecefToGeodetic(rig.ac.state.position);
      rangeBearing(LAT, LON, g.lat, g.lon, rb);
      const fromThreshold = rb.distance / NM;
      if (Number.isNaN(locCapture) && ap.lateral === 'apr') locCapture = fromThreshold;
      if (Number.isNaN(gsCapture) && ap.vertical === 'gs') gsCapture = fromThreshold;
      const m = rig.unit.telemetry.markers;
      const lit = m.outer ? 'O' : m.middle ? 'M' : m.inner ? 'I' : '';
      if (lit && !markers.endsWith(lit)) markers += lit;
      if (fromThreshold < 5) {
        worstLoc = Math.max(worstLoc, Math.abs(nav.deviation));
        worstGs = Math.max(worstGs, Math.abs(nav.glideSlope ?? 1));
      }
      if (rig.altitudeFt - ELEVATION / FT < 200) break;
    }
    expect(rig.altitudeFt - ELEVATION / FT).toBeLessThan(200);
    expect(ap.engaged).toBe(true);
    expect(ap.lateral).toBe('apr');
    expect(ap.vertical).toBe('gs');
    // Half a dot of the five on each side of the indicator.
    expect(worstLoc).toBeLessThan(0.1);
    expect(worstGs).toBeLessThan(0.1);
    // The inner marker lies below 200 ft; outer and middle were overflown in order.
    expect(markers).toBe('OM');
    expect(locCapture).toBeGreaterThan(6);
    // Captured from below: ALT holds 2500 ft until the path comes down to it.
    expect(gsCapture).toBeGreaterThan(6);
    expect(gsCapture).toBeLessThanOrEqual(locCapture);
  });
});

describe('autopilot: determinism', () => {
  it('flies the same way twice', () => {
    const run = () => {
      const rig = new Rig({ height: 3000 * FT, heading: 10, kias: 100, gust: 2 });
      rig.cockpit.set('headingBug', 100);
      rig.press('apEngage');
      rig.fly(0.2);
      rig.press('apHdg');
      rig.fly(0.2);
      rig.press('apVsUp');
      rig.fly(60);
      const p = rig.ac.state.position;
      return [p.x, p.y, p.z, rig.ac.controls.pitchTrim, rig.ac.controls.roll];
    };
    expect(run()).toEqual(run());
  });
});

describe('autopilot: modes and disconnects', () => {
  const cruise = () => new Rig({ height: 3000 * FT, heading: 0, kias: 100 });

  it('engages in ROL and VS at the present vertical speed', () => {
    const rig = cruise();
    // Set up a gentle descent by hand first.
    rig.ac.controls.pitchTrim -= 0.03;
    rig.fly(15);
    const vs = rig.ac.telemetry.verticalSpeed / FPM;
    expect(vs).toBeLessThan(-100);
    rig.press('apEngage');
    rig.fly(0.1);
    const ap = rig.unit.telemetry.autopilot;
    expect(ap.engaged).toBe(true);
    expect(ap.lateral).toBe('roll');
    expect(ap.vertical).toBe('vs');
    expect(ap.selectedVerticalSpeed).toBe(Math.round(vs / 100) * 100);
    rig.fly(30);
    expect(Math.abs(rig.ac.telemetry.verticalSpeed / FPM - ap.selectedVerticalSpeed)).toBeLessThan(
      60,
    );
    expect(Math.abs(rig.ac.telemetry.bank)).toBeLessThan(1 * (Math.PI / 180));
  });

  it('steps the vertical speed by 100 ft/min and ALT by 20 ft', () => {
    const rig = cruise();
    rig.cockpit.set('apAltitude', 8000);
    rig.press('apEngage');
    rig.fly(0.2);
    const ap = rig.unit.telemetry.autopilot;
    const vs0 = ap.selectedVerticalSpeed;
    rig.press('apVsUp');
    rig.fly(0.2);
    rig.press('apVsUp');
    rig.fly(0.2);
    rig.press('apVsDown');
    rig.fly(0.2);
    expect(ap.selectedVerticalSpeed).toBe(vs0 + 100);
    rig.press('apAlt');
    rig.fly(0.2);
    expect(ap.vertical).toBe('alt');
    rig.fly(30);
    const held = rig.altitudeFt;
    for (let k = 0; k < 5; k++) {
      rig.press('apVsUp');
      rig.fly(0.2);
    }
    rig.fly(40);
    expect(rig.altitudeFt - held).toBeCloseTo(100, -1);
    // ALT pressed again: back to VS.
    rig.press('apAlt');
    rig.fly(0.2);
    expect(ap.vertical).toBe('vs');
  });

  it('disconnects with a warning when pressed again or overpowered, silently without power', () => {
    const rig = cruise();
    const ap = rig.unit.telemetry.autopilot;
    rig.press('apEngage');
    rig.fly(2);
    rig.press('apEngage');
    rig.fly(0.1);
    expect(ap.engaged).toBe(false);
    expect(ap.disconnectWarning).toBe(true);
    expect(rig.unit.command).toBeUndefined();
    rig.fly(2.5);
    expect(ap.disconnectWarning).toBe(false);

    rig.press('apEngage');
    rig.fly(2);
    // A brief nudge is not enough; a firm pull held is.
    rig.input.pilotPitch = 0.6;
    rig.fly(0.1);
    rig.input.pilotPitch = 0;
    rig.fly(0.5);
    expect(ap.engaged).toBe(true);
    rig.input.pilotRoll = -0.6;
    rig.fly(0.5);
    rig.input.pilotRoll = 0;
    expect(ap.engaged).toBe(false);
    expect(ap.disconnectWarning).toBe(true);
    rig.fly(3);

    rig.press('apEngage');
    rig.fly(1);
    rig.input.powered = false;
    rig.fly(0.1);
    expect(ap.engaged).toBe(false);
    expect(ap.disconnectWarning).toBe(false);
    // Engaging without power does nothing.
    rig.press('apEngage');
    rig.fly(0.1);
    expect(ap.engaged).toBe(false);
  });

  it('flies by the directional gyro, so a gyro error misleads it', () => {
    const rig = new Rig({ height: 3000 * FT, heading: 90, kias: 100 });
    rig.gyroError = 15;
    rig.cockpit.set('headingBug', 90);
    rig.press('apEngage');
    rig.fly(0.2);
    rig.press('apHdg');
    rig.fly(60);
    // The gyro reads 15 too much: it shows 090 while the aircraft flies 075.
    expect(wrap180(rig.heading - 75)).toBeCloseTo(0, 0);
  });

  it('follows a GPS flight plan around a turn with NAV on the GPS', () => {
    const A = { lat: LAT, lon: LON };
    const B = at(60, 12 * NM, A);
    const C = at(150, 15 * NM, B);
    const rig = new Rig({
      height: 4000 * FT,
      north: -1 * NM,
      heading: 60,
      kias: 105,
      declination: 2,
      wind: { fromDeg: 330, speed: 8 },
    });
    rig.unit.setFlightPlan([
      { ident: 'A', ...A },
      { ident: 'B', ...B },
      { ident: 'C', ...C },
    ]);
    rig.cockpit.set('navSource', 1);
    rig.press('apEngage');
    rig.fly(0.2);
    rig.press('apAlt');
    rig.fly(0.2);
    rig.press('apNav');
    rig.fly(0.2);
    const ap = rig.unit.telemetry.autopilot;
    const gps = rig.unit.telemetry.gps;
    let worstSecondLeg = 0;
    let sequenced = NaN;
    rig.fly(900, () => {
      if (Number.isNaN(sequenced) && gps.active === 2) sequenced = rig.time;
      if (rig.time > sequenced + 90 && gps.distanceNm! > 1)
        worstSecondLeg = Math.max(worstSecondLeg, Math.abs(gps.crossTrackNm!));
    });
    expect(ap.lateral).toBe('nav');
    expect(sequenced).toBeLessThan(600);
    expect(worstSecondLeg).toBeLessThan(0.3);
  });
});
