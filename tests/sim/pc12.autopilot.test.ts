/**
 * The PC-12's flight director autopilot flying the aircraft: altitude and heading hold, a
 * flight level change climb with altitude preselect, a coupled ILS to minimums, go-around,
 * heading sync, the three navigation sources and BARO STD.
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT, ecefToGeodetic, type NavStation } from '../../src/sim';
import { destination, rangeBearing } from '../../src/sim/avionics/geo';
import { FT, KT, type Flight } from './harness';
import { engine, pc12Airborne, type Pc12Flight } from './pc12Harness';

const NM = 1852;
const LAT = 46.91;
const LON = 7.5;

/** Presses a button for one step, as a finger on the panel does. */
function press(f: Pc12Flight, id: string) {
  f.ac.cockpit.set(id, 1);
  f.ac.step(SIM_DT, f.env);
  f.ac.cockpit.set(id, 0);
  f.ac.step(SIM_DT, f.env);
}

function run(f: Flight, seconds: number, each?: () => boolean | void) {
  for (let i = 0; i < seconds / SIM_DT; i++) {
    if (each?.() === true) return i * SIM_DT;
    f.ac.step(SIM_DT, f.env);
  }
  return seconds;
}

const ap = (f: Flight) => f.ac.telemetry.avionics!.autopilot;
const altFt = (f: Flight) => f.ac.telemetry.instruments!.altitude / FT;

describe('PC-12 autopilot', () => {
  it('engages with the flight director and the yaw damper, and holds altitude and heading', () => {
    const f = pc12Airborne(12_000 * FT, 230, { heading: 90 });
    f.ac.cockpit.set('headingBug', 90);
    press(f, 'apEngage');
    const a = ap(f);
    expect(a.engaged).toBe(true);
    expect(a.yawDamper).toBe(true);
    expect(a.flightDirector).toBeDefined();
    press(f, 'apAlt');
    press(f, 'apHdg');
    expect(a.vertical).toBe('alt');
    expect(a.lateral).toBe('hdg');
    const h0 = altFt(f);
    let worst = 0;
    run(f, 60, () => {
      worst = Math.max(worst, Math.abs(altFt(f) - h0));
    });
    expect(worst).toBeLessThan(40);
    // A turn onto a new heading at the bank limit, without overshooting it.
    f.ac.cockpit.set('headingBug', 180);
    let maxBank = 0;
    let past = 0;
    run(f, 90, () => {
      const t = f.ac.telemetry;
      maxBank = Math.max(maxBank, Math.abs(t.bank) * (180 / Math.PI));
      const hdg = f.ac.telemetry.instruments!.heading;
      past = Math.max(past, hdg - 180);
      worst = Math.max(worst, Math.abs(altFt(f) - h0));
    });
    expect(Math.abs(f.ac.telemetry.instruments!.heading - 180)).toBeLessThan(2);
    expect(maxBank).toBeLessThan(27);
    expect(maxBank).toBeGreaterThan(18);
    expect(past).toBeLessThan(5);
    expect(worst).toBeLessThan(80);
  }, 30_000);

  it('climbs in FLC at the selected airspeed and levels off at the selected altitude', () => {
    const f = pc12Airborne(8000 * FT, 200);
    f.ac.cockpit.set('apAltitude', 14_000);
    press(f, 'apEngage');
    press(f, 'apHdg');
    f.ac.controls.throttle[0] = 1;
    press(f, 'apFlc');
    const a = ap(f);
    expect(a.vertical).toBe('flc');
    // The pitch wheel down asks for 160 KIAS (the wheel rolled down speeds it up).
    const target = 160;
    for (let k = 0; k < 100 && (a.selectedSpeed ?? 0) > target; k++) press(f, 'apVsUp');
    expect(a.selectedSpeed).toBe(target);
    let worstSpeed = 0;
    let armed = false;
    const leveled = run(f, 400, () => {
      const kias = f.ac.telemetry.ias / KT;
      if (altFt(f) > 9500 && altFt(f) < 13_000)
        worstSpeed = Math.max(worstSpeed, Math.abs(kias - target));
      if (a.verticalArmed === 'alt') armed = true;
      return a.vertical === 'alt';
    });
    expect(armed).toBe(true);
    expect(leveled).toBeLessThan(400);
    expect(worstSpeed).toBeLessThan(6);
    // Captured without overshooting by more than the usual few tens of feet.
    let over = 0;
    f.ac.controls.throttle[0] = 0.8;
    run(f, 60, () => {
      over = Math.max(over, altFt(f) - 14_000);
    });
    expect(over).toBeLessThan(120);
    expect(Math.abs(altFt(f) - 14_000)).toBeLessThan(60);
    expect(engine(f).torque!).toBeLessThan(1.02);
  }, 30_000);

  it('flies a coupled ILS approach to minimums in landing configuration', () => {
    const RWY = 140;
    const at = (course: number, distance: number, from = { lat: LAT, lon: LON }) =>
      destination(from.lat, from.lon, course, distance, { lat: 0, lon: 0 });
    const loc = at(RWY, 2300);
    const gs = at(RWY + 90, 120, at(RWY, 300));
    const ils: NavStation = {
      ident: 'ITST',
      name: 'Test ILS 14',
      type: 'ILS',
      frequency: 110_300,
      lat: loc.lat,
      lon: loc.lon,
      elevation: 500,
      rangeNm: 25,
      course: RWY,
      glideSlope: { lat: gs.lat, lon: gs.lon, elevation: 500, angleDeg: 3 },
      dme: { lat: gs.lat, lon: gs.lon, elevation: 500 },
      airport: 'LSZT',
      runway: '14',
    };
    // 9 NM out, 0.8 NM left of the centreline, intercepting at 30 degrees, at 2500 ft above.
    const start = at(RWY + 270, 0.8 * NM, at(RWY + 180, 9 * NM));
    const rb = { distance: 0, bearing: 0 };
    rangeBearing(LAT, LON, start.lat, start.lon, rb);
    const f = pc12Airborne(500 + 2500 * FT, 130, {
      elevation: 500,
      heading: RWY + 30,
      flaps: 1 / 3,
      gearDown: false,
      wind: { fromDeg: RWY - 60, speed: 6 },
    });
    // Move the start to the approach fix (the reset put it over the origin).
    const pos = (
      f.env as unknown as {
        position(h: number, n: number, e: number): { x: number; y: number; z: number };
      }
    ).position(
      2500 * FT,
      rb.distance * Math.cos((rb.bearing * Math.PI) / 180),
      rb.distance * Math.sin((rb.bearing * Math.PI) / 180),
    );
    f.ac.state.position.x = pos.x;
    f.ac.state.position.y = pos.y;
    f.ac.state.position.z = pos.z;
    f.ac.avionics.setDatabase({ onFrequency: (fr) => (fr === ils.frequency ? [ils] : []) });
    const p = f.ac.cockpit;
    p.set('nav1Active', 110_300);
    p.set('navSource', 0);
    p.set('headingBug', RWY + 30);
    p.set('apAltitude', 0);
    press(f, 'apEngage');
    press(f, 'apHdg');
    press(f, 'apAlt');
    press(f, 'apApr');
    const a = ap(f);
    expect(a.lateralArmed).toBe('apr');
    expect(a.verticalArmed).toBe('gs');
    // A pilot's hand on the power for 115 KIAS, gear and full flaps at the glide slope.
    let thr = f.ac.controls.throttle[0]!;
    const base = thr;
    let integral = 0;
    let worstLoc = 0;
    let worstGs = 0;
    let configured = false;
    const nav = f.ac.telemetry.avionics!.nav1;
    const reached = run(f, 600, () => {
      const kias = f.ac.telemetry.ias / KT;
      const want = configured ? 100 : 120;
      // A gentle hand: power for the speed over tens of seconds, as a pilot sets it.
      const e = want - kias;
      integral = Math.max(-150, Math.min(150, integral + e * SIM_DT));
      thr = Math.max(0, Math.min(1, base + 0.02 * e + 0.003 * integral));
      f.ac.controls.throttle[0] = thr;
      if (a.vertical === 'gs' && !configured) {
        configured = true;
        f.ac.controls.gearDown = true;
        f.ac.controls.flaps = 1;
      }
      const g = ecefToGeodetic(f.ac.state.position);
      rangeBearing(LAT, LON, g.lat, g.lon, rb);
      if (rb.distance / NM < 5) {
        worstLoc = Math.max(worstLoc, Math.abs(nav.deviation));
        worstGs = Math.max(worstGs, Math.abs(nav.glideSlope ?? 1));
      }
      // Minimums: 200 ft above the threshold.
      return f.ac.telemetry.altitude - 500 < 200 * FT;
    });
    expect(reached).toBeLessThan(600);
    expect(a.engaged).toBe(true);
    expect(a.lateral).toBe('apr');
    expect(a.vertical).toBe('gs');
    expect(worstLoc).toBeLessThan(0.15);
    expect(worstGs).toBeLessThan(0.2);
    expect(f.ac.telemetry.gear).toBe(1);
    expect(f.ac.telemetry.crashed).toBeUndefined();
  }, 60_000);

  it('goes around: the autopilot lets go and the bars show wings level and 10 degrees up', () => {
    const f = pc12Airborne(3000 * FT, 120, { flaps: 1 / 3 });
    press(f, 'apEngage');
    press(f, 'goAround');
    const a = ap(f);
    expect(a.engaged).toBe(false);
    expect(a.goAround).toBe(true);
    expect(a.flightDirector!.bank).toBeCloseTo(0, 1);
    expect(a.disconnectWarning).toBe(true);
    run(f, 3);
    expect(a.flightDirector!.pitch * (180 / Math.PI)).toBeCloseTo(10, 0);
  });

  it('syncs the heading bug, follows the selected navigation source and shows BARO STD', () => {
    const f = pc12Airborne(6000 * FT, 180, { heading: 37 });
    press(f, 'headingSync');
    expect(f.ac.cockpit.get('headingBug')).toBeCloseTo(37, -0.5);
    const p = f.ac.cockpit;
    expect(p.specs.find((s) => s.id === 'navSource')!.positions).toEqual(['nav1', 'gps', 'nav2']);
    p.set('navSource', 2);
    press(f, 'apEngage');
    press(f, 'apNav');
    // No station on NAV 2: armed, waiting.
    expect(ap(f).lateralArmed).toBe('nav');
    p.set('altimeterSetting', 990);
    run(f, 0.5);
    const local = f.ac.telemetry.instruments!.altitude;
    press(f, 'baroStd');
    run(f, 0.5);
    expect(f.ac.telemetry.instruments!.baroStd).toBe(true);
    // 23 hPa more on the scale: some 190 m higher on the altimeter.
    expect(f.ac.telemetry.instruments!.altitude - local).toBeGreaterThan(150);
    press(f, 'apDisconnect');
    expect(ap(f).engaged).toBe(false);
    // The yaw damper stays with the button of its own.
    expect(ap(f).yawDamper).toBe(true);
    press(f, 'yawDamper');
    expect(ap(f).yawDamper).toBe(false);
  });
});
