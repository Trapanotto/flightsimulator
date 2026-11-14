/**
 * The radios, receivers, transponder and GPS of the avionics unit, driven with made-up
 * inputs over a made-up navigation database.
 */
import { describe, expect, it } from 'vitest';
import type { AvionicsInput, NavDatabase, NavStation, Waypoint } from '../../src/sim/avionicsTypes';
import { createAvionics } from '../../src/sim/avionics/avionics';
import { destination, radioHorizonNm, rangeBearing, wrap180 } from '../../src/sim/avionics/geo';
import { GPS_FULL_SCALE } from '../../src/sim/avionics/gps';
import {
  GS_FULL_SCALE_PER_ANGLE,
  LOC_HALF_WIDTH_AT_THRESHOLD,
  MARKER_COVERAGE,
  VOR_FULL_SCALE_DEG,
  lineOfSightNm,
  localizerFullScale,
  thresholdDistance,
} from '../../src/sim/avionics/navReceiver';
import { IDENT_DURATION_S } from '../../src/sim/avionics/avionics';
import { C172_CONTROLS, CockpitPanel } from '../../src/sim/cockpit';
import { SIM_DT } from '../../src/sim/fixedStep';

const NM = 1852;
const FT = 0.3048;
const KT = NM / 3600;
const LAT = 46.91;
const LON = 7.5;

const at = (course: number, distance: number, from = { lat: LAT, lon: LON }) =>
  destination(from.lat, from.lon, course, distance, { lat: 0, lon: 0 });

const vor: NavStation = {
  ident: 'TST',
  name: 'Test VOR',
  type: 'VOR-DME',
  frequency: 113_300,
  lat: LAT,
  lon: LON,
  elevation: 500,
  rangeNm: 100,
};
/** Same frequency, further away: the receiver must pick the nearer one. */
const vorFar: NavStation = {
  ...vor,
  ident: 'FAR',
  name: 'Far VOR',
  ...at(270, 60 * NM),
};
const ndbPos = at(90, 20 * NM);
const ndb: NavStation = {
  ident: 'NB',
  name: 'Test NDB',
  type: 'NDB',
  frequency: 375,
  lat: ndbPos.lat,
  lon: ndbPos.lon,
  elevation: 400,
  rangeNm: 25,
};
/** ILS 14: threshold at the origin, localizer 2300 m beyond it, glide slope 300 m in. */
const RWY = 140;
const locPos = at(RWY, 2300);
const gsPos = at(RWY + 90, 120, at(RWY, 300));
const ils: NavStation = {
  ident: 'ITST',
  name: 'Test ILS 14',
  type: 'ILS',
  frequency: 110_300,
  lat: locPos.lat,
  lon: locPos.lon,
  elevation: 500,
  rangeNm: 25,
  course: RWY,
  glideSlope: { lat: gsPos.lat, lon: gsPos.lon, elevation: 500, angleDeg: 3 },
  dme: { lat: gsPos.lat, lon: gsPos.lon, elevation: 500 },
};
const loc: NavStation = {
  ...ils,
  ident: 'ILOC',
  type: 'LOC',
  frequency: 109_900,
  glideSlope: undefined,
};

function database(stations: NavStation[]) {
  const db = {
    calls: 0,
    onFrequency(f: number) {
      db.calls++;
      return stations.filter((s) => s.frequency === f);
    },
  };
  return db satisfies NavDatabase & { calls: number };
}

function input(over: Partial<AvionicsInput> = {}): AvionicsInput {
  return {
    powered: true,
    com1Failed: false,
    lon: LON,
    lat: LAT,
    altitude: 1500,
    heading: 0,
    track: 0,
    groundSpeed: 50,
    verticalSpeed: 0,
    ias: 50,
    pitch: 0,
    bank: 0,
    turnRate: 0,
    onGround: false,
    declination: 0,
    indicatedHeading: 0,
    indicatedAltitude: 1500,
    pilotPitch: 0,
    pilotRoll: 0,
    ...over,
  };
}

function setup(stations: NavStation[] = [vor, vorFar, ndb, ils, loc]) {
  const unit = createAvionics();
  const cockpit = new CockpitPanel(C172_CONTROLS);
  cockpit.reset(true);
  const db = database(stations);
  unit.setDatabase(db);
  const step = (i: AvionicsInput, seconds = SIM_DT) => {
    for (let t = 0; t < seconds - 1e-9; t += SIM_DT) {
      unit.step(SIM_DT, i, cockpit);
      for (const s of cockpit.specs) if (s.kind === 'button') cockpit.set(s.id, 0);
    }
  };
  /** The aircraft placed on a true bearing and distance from a point. */
  const place = (
    i: AvionicsInput,
    bearing: number,
    distance: number,
    from = { lat: LAT, lon: LON },
  ) => {
    const p = at(bearing, distance, from);
    i.lat = p.lat;
    i.lon = p.lon;
    return i;
  };
  return { unit, cockpit, db, step, place, t: unit.telemetry };
}

describe('COM', () => {
  it('swaps on the press only and keeps 25 kHz steps', () => {
    const { unit, cockpit, step, t } = setup();
    cockpit.set('com1Active', 118_100);
    cockpit.set('com1Standby', 121_512);
    expect(cockpit.get('com1Standby')).toBe(121_500);
    const i = input();
    step(i);
    cockpit.set('com1Swap', 1);
    step(i);
    expect(t.com1.active).toBe(121_500);
    expect(t.com1.standby).toBe(118_100);
    // Held down (not released between steps): one swap only.
    step(i);
    cockpit.set('com1Swap', 1);
    for (let k = 0; k < 5; k++) unit.step(SIM_DT, i, cockpit);
    expect(t.com1.active).toBe(118_100);
    cockpit.set('com1Swap', 0);
    for (let k = 0; k < 5; k++) unit.step(SIM_DT, i, cockpit);
    expect(t.com1.active).toBe(118_100);
  });

  it('COM 1 is dead when it has failed', () => {
    const { cockpit, step, t } = setup();
    const i = input({ com1Failed: true });
    cockpit.set('com1Swap', 1);
    step(i);
    expect(t.com1.active).toBe(0);
    expect(cockpit.get('com1Active')).toBe(118_100);
    expect(t.com2.active).toBe(121_500);
  });
});

describe('NAV: VOR', () => {
  it('tunes the nearest station in range and looks stations up only now and then', () => {
    const { cockpit, step, t, db } = setup();
    cockpit.set('nav1Active', 113_300);
    const i = input();
    step(i, 0.5);
    expect(t.nav1.ident).toBe('TST');
    const calls = db.calls;
    step(i, 10);
    // Two receivers and the ADF, about once a second each.
    expect(db.calls - calls).toBeLessThanOrEqual(33);
    expect(db.calls - calls).toBeGreaterThanOrEqual(27);
  });

  it('is limited by the radio horizon', () => {
    // 1.23 (sqrt(h1) + sqrt(h2)) NM, h in feet.
    expect(radioHorizonNm(10_000, 0)).toBeCloseTo(123, 5);
    expect(lineOfSightNm(500 + 5000 * FT, 500)).toBeCloseTo(
      1.23 * (Math.sqrt(5000 + 6) + Math.sqrt(20)),
      3,
    );
    const { cockpit, step, t, place } = setup([vor]);
    cockpit.set('nav1Active', 113_300);
    // 60 NM out: received at 5000 ft above the station, not at 1000 ft.
    const high = place(input({ altitude: 500 + 5000 * FT }), 180, 60 * NM);
    step(high, 1.1);
    expect(t.nav1.valid).toBe(true);
    const low = place(input({ altitude: 500 + 1000 * FT }), 180, 60 * NM);
    step(low, 1.1);
    expect(t.nav1.valid).toBe(false);
    expect(t.nav1.ident).toBe('');
  });

  it('shows the radial, deviation and TO/FROM with a 10 degree full scale', () => {
    const { cockpit, step, t, place } = setup();
    cockpit.set('nav1Active', 113_300);
    const decl = 3;
    // On the 093 radial magnetic (096 true), 20 NM out.
    const i = place(input({ declination: decl, altitude: 3000 }), 96, 20 * NM);
    cockpit.set('obs1', 93);
    step(i, 0.1);
    expect(t.nav1.toFrom).toBe('from');
    expect(t.nav1.deviation).toBeCloseTo(0, 3);
    expect(t.nav1.bearing!).toBeCloseTo(273, 1);
    // Course 098 FROM: the aircraft is 5 degrees left of it, the needle half right.
    cockpit.set('obs1', 98);
    step(i);
    expect(VOR_FULL_SCALE_DEG).toBe(10);
    expect(t.nav1.deviation).toBeCloseTo(0.5, 2);
    // Course 268 TO the station: its inbound line (the 088 radial) lies north, to the right
    // flying west.
    cockpit.set('obs1', 268);
    step(i);
    expect(t.nav1.toFrom).toBe('to');
    expect(t.nav1.deviation).toBeCloseTo(0.5, 2);
    // Course 278 TO: 5 degrees the other way.
    cockpit.set('obs1', 278);
    step(i);
    expect(t.nav1.deviation).toBeCloseTo(-0.5, 2);
    // Abeam: the flag.
    cockpit.set('obs1', 3);
    step(i);
    expect(t.nav1.toFrom).toBe('off');
  });

  it('loses TO/FROM in the cone overhead', () => {
    const { cockpit, step, t, place } = setup();
    cockpit.set('nav1Active', 113_300);
    const i = place(input({ altitude: 500 + 2000 }), 0, 500);
    step(i, 0.1);
    expect(t.nav1.valid).toBe(true);
    expect(t.nav1.toFrom).toBe('off');
  });
});

describe('NAV: ILS', () => {
  it('derives the localizer full scale from the 700 ft course width at the threshold', () => {
    // Threshold: the glide slope antenna 300 m in plus 15 m / tan 3 degrees (ICAO RDH).
    const dThr = thresholdDistance(ils)!;
    expect(dThr).toBeCloseTo(2300 - 300 + 15 / Math.tan(3 * (Math.PI / 180)), 0);
    // ICAO Annex 10: 0.00145 DDM/m and 0.155 DDM full scale = 106.9 m; 700 ft = 106.7 m.
    expect(LOC_HALF_WIDTH_AT_THRESHOLD).toBeCloseTo(0.155 / 0.00145, -0.5);
    expect(localizerFullScale(ils)).toBeCloseTo(Math.atan(106.68 / dThr) * (180 / Math.PI), 3);
    // Without a glide slope the threshold is unknown: 2.5 degrees.
    expect(localizerFullScale(loc)).toBe(2.5);
  });

  it('shows the localizer, its back course reversed, and the glide slope', () => {
    const { cockpit, step, t, place } = setup();
    cockpit.set('nav1Active', 110_300);
    const fs = localizerFullScale(ils);
    // 6 NM out on the approach, half full scale to the right of the centreline (seen
    // inbound): the needle points left.
    const loc = { lat: ils.lat, lon: ils.lon };
    const i = place(
      input({ altitude: 500 + 6 * NM * Math.tan(3 * (Math.PI / 180)) }),
      RWY + 180 - fs / 2,
      6 * NM + 2300,
      loc,
    );
    step(i, 0.1);
    expect(t.nav1.valid).toBe(true);
    expect(t.nav1.localizer).toBe(true);
    expect(t.nav1.deviation).toBeCloseTo(-0.5, 2);
    expect(t.nav1.glideSlope).toBeDefined();
    // Behind the antenna on the same (south-west) side: still points left, which flown
    // inbound on the back course (heading 320) is away from the centreline.
    const back = place(input({ altitude: 1500 }), RWY + fs / 2, 6 * NM, loc);
    step(back, 0.1);
    expect(t.nav1.deviation).toBeCloseTo(-0.5, 2);
    expect(t.nav1.glideSlope).toBeUndefined();
  });

  it('has a glide slope full scale of 0.24 times the path angle', () => {
    // ICAO Annex 10 3.1.5.6.2: 0.0875 DDM at 0.12 theta, full scale 0.175 DDM.
    expect(GS_FULL_SCALE_PER_ANGLE).toBeCloseTo((0.12 * 0.175) / 0.0875, 6);
    expect(GS_FULL_SCALE_PER_ANGLE * 3).toBeCloseTo(0.7, 1);
    const { cockpit, step, t, place } = setup();
    cockpit.set('nav1Active', 110_300);
    const gs = { lat: gsPos.lat, lon: gsPos.lon };
    const d = 5 * NM;
    const height = (angle: number) => 500 + d * Math.tan(angle * (Math.PI / 180));
    // 0.36 degrees below the path: half full scale, fly up.
    const i = place(input({ altitude: height(3 - 0.36) }), RWY + 180, d, gs);
    step(i, 0.1);
    expect(t.nav1.glideSlope!).toBeCloseTo(0.5, 2);
    i.altitude = height(3 + 1);
    step(i);
    expect(t.nav1.glideSlope).toBe(-1);
  });

  it('lights the markers along the approach', () => {
    const { cockpit, step, t, place } = setup();
    cockpit.set('nav1Active', 110_300);
    const lit = (distance: number) => {
      const h = 500 + distance * Math.tan(3 * (Math.PI / 180)) + 15;
      step(place(input({ altitude: h }), RWY + 180, distance), 0.1);
      const m = t.markers;
      return (m.outer ? 'O' : '') + (m.middle ? 'M' : '') + (m.inner ? 'I' : '');
    };
    expect(lit(4 * NM)).toBe('O');
    expect(lit(4 * NM + MARKER_COVERAGE.outer / 2 - 20)).toBe('O');
    expect(lit(4 * NM + MARKER_COVERAGE.outer / 2 + 20)).toBe('');
    expect(lit(2 * NM)).toBe('');
    expect(lit(0.5 * NM)).toBe('M');
    expect(lit(300)).toBe('I');
  });
});

describe('DME', () => {
  it('shows slant distance, ground speed and time to the station', () => {
    const { cockpit, step, t, place } = setup();
    cockpit.set('nav1Active', 113_300);
    cockpit.set('dmeSource', 0);
    const height = 6000 * FT;
    const i = place(
      input({ altitude: 500 + height, groundSpeed: 120 * KT, track: 0 }),
      180,
      10 * NM,
    );
    step(i, 0.1);
    const slant = Math.hypot(10 * NM, height) / NM;
    expect(t.dme.distanceNm!).toBeCloseTo(slant, 2);
    // Straight at it: the slant range closes a little slower than the ground speed.
    expect(t.dme.groundSpeedKt!).toBeCloseTo((120 * 10) / slant, 0);
    expect(t.dme.minutes!).toBeCloseTo((slant / t.dme.groundSpeedKt!) * 60, 3);
    // Flying away: no time to the station.
    i.track = 180;
    step(i);
    expect(t.dme.groundSpeedKt!).toBeLessThan(0);
    expect(t.dme.minutes).toBeUndefined();
    // DME on NAV 2, tuned to nothing.
    cockpit.set('dmeSource', 1);
    step(i);
    expect(t.dme.source).toBe('nav2');
    expect(t.dme.distanceNm).toBeUndefined();
  });
});

describe('ADF', () => {
  it('points at the NDB relative to the nose and wanders only near the edge of range', () => {
    const { cockpit, step, t, place } = setup();
    cockpit.set('adfFrequency', 375);
    // 10 NM west of the NDB heading north: the station is on the right wing.
    const ndbAt = { lat: ndb.lat, lon: ndb.lon };
    const i = place(input({ heading: 0 }), 270, 10 * NM, ndbAt);
    step(i, 0.1);
    expect(t.adf.valid).toBe(true);
    expect(t.adf.ident).toBe('NB');
    expect(t.adf.relativeBearing!).toBeCloseTo(90, 0);
    let spread = 0;
    for (let k = 0; k < 600; k++) {
      step(i, 0.05);
      spread = Math.max(spread, Math.abs(wrap180(t.adf.relativeBearing! - 90)));
    }
    expect(spread).toBeLessThan(0.5);
    // 24 of its 25 NM: the needle hunts, the same way on every run.
    place(i, 270, 24 * NM, ndbAt);
    const run = () => {
      const { cockpit: c2, step: s2, t: t2 } = setup();
      c2.set('adfFrequency', 375);
      const seen: number[] = [];
      for (let k = 0; k < 200; k++) {
        s2(i, 0.05);
        seen.push(t2.adf.relativeBearing!);
      }
      return seen;
    };
    const a = run();
    expect(a).toEqual(run());
    const wander = Math.max(...a.map((b) => Math.abs(wrap180(b - 90))));
    expect(wander).toBeGreaterThan(2);
    expect(wander).toBeLessThan(10);
    // Out of range.
    place(i, 270, 26 * NM, ndbAt);
    step(i, 1.1);
    expect(t.adf.valid).toBe(false);
    void cockpit;
  });
});

describe('transponder', () => {
  it('holds IDENT for 18 seconds and replies to interrogations', () => {
    const { cockpit, step, t } = setup();
    const i = input();
    cockpit.set('xpdrCode', 7000);
    cockpit.set('xpdrMode', 3);
    step(i);
    expect(t.transponder.mode).toBe('alt');
    expect(t.transponder.code).toBe(7000);
    cockpit.set('xpdrIdent', 1);
    step(i);
    expect(IDENT_DURATION_S).toBe(18);
    expect(t.transponder.ident).toBe(true);
    step(i, 17.8);
    expect(t.transponder.ident).toBe(true);
    step(i, 0.3);
    expect(t.transponder.ident).toBe(false);
    let replies = 0;
    let last = false;
    for (let k = 0; k < 20 * 120; k++) {
      step(i);
      if (t.transponder.reply && !last) replies++;
      last = t.transponder.reply;
    }
    expect(replies).toBeGreaterThanOrEqual(4);
    // Standby: no replies, IDENT does nothing.
    cockpit.set('xpdrMode', 1);
    cockpit.set('xpdrIdent', 1);
    step(i);
    expect(t.transponder.ident).toBe(false);
    step(i, 10);
    expect(t.transponder.reply).toBe(false);
  });
});

describe('GPS', () => {
  const plan: Waypoint[] = [
    { ident: 'A', lat: LAT, lon: LON },
    { ident: 'B', ...at(90, 40 * NM) },
    { ident: 'C', ...at(0, 40 * NM, at(90, 40 * NM)) },
  ];

  it('flies the leg: distance, bearing, desired track and cross-track error', () => {
    const { unit, step, t, place } = setup();
    unit.setFlightPlan(plan);
    // 10 NM along the first leg and 1 NM north of it (left of course): XTK -1.
    const i = place(input({ declination: 2 }), 0, 1 * NM, at(90, 10 * NM));
    step(i);
    const g = t.gps;
    expect(g.active).toBe(1);
    expect(g.crossTrackNm!).toBeCloseTo(-1, 2);
    expect(g.distanceNm!).toBeCloseTo(Math.hypot(30, 1), 1);
    // A great circle due east at 47 N: the desired track abeam is a little south of east.
    expect(g.desiredTrack!).toBeGreaterThan(90 - 2 - 0.5);
    expect(g.desiredTrack!).toBeLessThan(90 - 2 + 0.5);
    const rb = { distance: 0, bearing: 0 };
    rangeBearing(i.lat, i.lon, plan[1]!.lat, plan[1]!.lon, rb);
    expect(g.bearing!).toBeCloseTo(rb.bearing - 2, 3);
  });

  it('sequences ahead of the turn and goes direct', () => {
    const { unit, step, t, place } = setup();
    unit.setFlightPlan(plan);
    const B = { lat: plan[1]!.lat, lon: plan[1]!.lon };
    const gs = 50;
    // A 90 degree turn at a standard rate: lead r tan 45 = v / omega.
    const lead = gs / (3 * (Math.PI / 180));
    const i = place(input({ groundSpeed: gs, track: 90 }), 270, lead + 100, B);
    step(i);
    expect(t.gps.active).toBe(1);
    place(i, 270, lead - 100, B);
    step(i);
    expect(t.gps.active).toBe(2);
    expect(t.gps.desiredTrack!).toBeCloseTo(0, 0);
    // Direct to A from here.
    unit.directTo(0);
    step(i);
    expect(t.gps.active).toBe(0);
    expect(t.gps.crossTrackNm!).toBeCloseTo(0, 6);
    expect(wrap180(t.gps.desiredTrack! - t.gps.bearing!)).toBeCloseTo(0, 6);
  });

  it('drives indicator 1 with the GPS scale when the NAV source is GPS', () => {
    expect(GPS_FULL_SCALE).toMatchObject({ enRoute: 5, terminal: 1, approach: 0.3 });
    const { unit, cockpit, step, t, place } = setup();
    unit.setFlightPlan(plan);
    cockpit.set('navSource', 1);
    // En route (more than 30 NM from C): 1 NM left of course is a fifth of full scale right.
    const i = place(input(), 0, 1 * NM, at(90, 5 * NM));
    step(i);
    expect(t.nav1.valid).toBe(true);
    expect(t.nav1.deviation).toBeCloseTo(0.2, 2);
    // Terminal: on the last leg 10 NM from C, 0.5 NM right of course.
    unit.directTo(2);
    const C = { lat: plan[2]!.lat, lon: plan[2]!.lon };
    place(i, 180, 10 * NM, C);
    step(i);
    unit.directTo(2);
    place(i, 90, 0.5 * NM, at(180, 10 * NM, C));
    step(i);
    expect(t.nav1.deviation).toBeCloseTo(-0.5, 1);
    // Approach: within 2 NM, 0.15 NM right is half scale.
    place(i, 90, 0.15 * NM, at(180, 1.5 * NM, C));
    step(i);
    expect(t.nav1.deviation).toBeCloseTo(-0.5, 1);
  });
});

describe('power', () => {
  it('is dark without power', () => {
    const { cockpit, step, t } = setup();
    cockpit.set('nav1Active', 113_300);
    cockpit.set('adfFrequency', 375);
    const i = input({ powered: false });
    step(i, 1.1);
    expect(t.powered).toBe(false);
    expect(t.nav1.valid).toBe(false);
    expect(t.adf.valid).toBe(false);
    expect(t.transponder.mode).toBe('off');
    expect(t.dme.distanceNm).toBeUndefined();
    cockpit.set('apEngage', 1);
    step(i);
    expect(t.autopilot.engaged).toBe(false);
  });
});
