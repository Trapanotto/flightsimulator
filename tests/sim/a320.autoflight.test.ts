/**
 * The A320's flight guidance flying the aircraft: the automatic landing (CAT 3 DUAL) on the
 * ILS of Zürich 14, a go-around from 50 ft, take-off with SRS and the thrust reduction,
 * managed and selected climb and descent with altitude capture and a plan constraint, the
 * speed profile with the crossover, V/S, EXPED, heading and NAV, and the autothrust modes.
 */
import { describe, expect, it } from 'vitest';
import { ecefToGeodetic, type NavStation } from '../../src/sim';
import { destination, rangeBearing } from '../../src/sim/avionics/geo';
import { DEG, FPM, FT, KT, fly } from './harness';
import { a320Airborne, a320OnGround, airbus, press, type A320Flight } from './a320Harness';
import { cruising, levers } from './a320Procedures';

const NM = 1852;
/**
 * Zürich runway 14 (AIP Switzerland AD 2 LSZH, approximate, reconstructed): threshold
 * 47.4823 N 8.5308 E at 1402 ft (427 m), true course 139.7°, 3300 m long; ILS 14 on
 * 108.30 MHz (frequency from memory; the test only needs it to be tunable) with a 3° glide
 * slope 300 m past the threshold.
 */
const ZRH = { lat: 47.4823, lon: 8.5308, elevation: 427, course: 139.7, length: 3300 };
const at = (course: number, distance: number, from = { lat: ZRH.lat, lon: ZRH.lon }) =>
  destination(from.lat, from.lon, course, distance, { lat: 0, lon: 0 });
const LOC = at(ZRH.course, ZRH.length + 300);
const GS = at(ZRH.course + 90, 120, at(ZRH.course, 300));
const ILS14: NavStation = {
  ident: 'IKL',
  name: 'Zürich ILS 14',
  type: 'ILS',
  frequency: 108_300,
  lat: LOC.lat,
  lon: LOC.lon,
  elevation: ZRH.elevation,
  rangeNm: 25,
  course: ZRH.course,
  glideSlope: { lat: GS.lat, lon: GS.lon, elevation: ZRH.elevation, angleDeg: 3 },
  dme: { lat: GS.lat, lon: GS.lon, elevation: ZRH.elevation },
  airport: 'LSZH',
  runway: '14',
};

/** Puts the aircraft at a distance (m) before the threshold and an offset to the left (m). */
function place(f: A320Flight, before: number, left: number, heightFt: number) {
  const p = at(ZRH.course + 270, left, at(ZRH.course + 180, before));
  const rb = { distance: 0, bearing: 0 };
  rangeBearing(ZRH.lat, ZRH.lon, p.lat, p.lon, rb);
  const pos = f.env.position(
    heightFt * FT,
    rb.distance * Math.cos(rb.bearing * DEG),
    rb.distance * Math.sin(rb.bearing * DEG),
  );
  f.ac.state.position.x = pos.x;
  f.ac.state.position.y = pos.y;
  f.ac.state.position.z = pos.z;
}

/** Along-track distance past the threshold and distance right of the centreline, m. */
function runwayPosition(f: A320Flight) {
  const g = ecefToGeodetic(f.ac.state.position);
  const rb = { distance: 0, bearing: 0 };
  rangeBearing(ZRH.lat, ZRH.lon, g.lat, g.lon, rb);
  const a = (rb.bearing - ZRH.course) * DEG;
  return { along: rb.distance * Math.cos(a), right: rb.distance * Math.sin(a) };
}

/** On the ILS of Zürich 14, 15 NM out, below the glide slope, both autopilots engaged. */
function onApproach(o: { wind?: { fromDeg: number; speed: number } } = {}) {
  const f = a320Airborne(ZRH.elevation + 3000 * FT, 175, {
    mass: 60_000,
    latitude: ZRH.lat,
    longitude: ZRH.lon,
    elevation: ZRH.elevation,
    heading: ZRH.course + 25,
    flapLever: 2,
    gearDown: true,
    wind: o.wind,
  });
  place(f, 15 * NM, 0.8 * NM, 3000);
  f.ac.avionics.setDatabase({ onFrequency: (fr) => (fr === ILS14.frequency ? [ILS14] : []) });
  const c = f.ac.cockpit;
  c.set('nav1Active', ILS14.frequency);
  c.set('fcuHeading', Math.round(ZRH.course + 25));
  c.set('fcuAltitude', 3000);
  c.set('spoilersArmed', 1);
  c.set('autobrake', 2);
  levers(f, 0.62);
  fly(f, 0.1);
  press(f, 'athr');
  press(f, 'fcuHeadingPull');
  fly(f, 6);
  press(f, 'ap1');
  press(f, 'fcuVsPush');
  press(f, 'fcuAppr');
  press(f, 'ap2');
  return f;
}

describe('A320 flight guidance', () => {
  it('lands automatically on the ILS of Zürich 14 in CAT 3 DUAL', () => {
    const f = onApproach();
    const { ac } = f;
    const t = ac.telemetry;
    const b = airbus(f);
    expect(b.fma.autopilot).toBe('AP1+2');
    expect(b.fma.lateralArmed).toBe('LOC');
    expect(b.fma.verticalArmed).toContain('G/S');
    const seen = new Set<string>();
    const callouts = new Set<string>();
    let capability = '';
    let touchdown: { along: number; right: number; sink: number } | undefined;
    let worstLoc = 0;
    const stopped = fly(f, 600, () => {
      seen.add(b.fma.vertical);
      seen.add(b.fma.lateral);
      if (b.guidance.callout) callouts.add(b.guidance.callout);
      // Landing configuration as the glide slope comes alive.
      if (b.fma.vertical.startsWith('G/S')) ac.controls.flaps = 1;
      const agl = (t.agl ?? 1000) / FT;
      if (agl < 400 && agl > 300) capability = b.fma.capability;
      if (agl < 1000 && !t.onGround) worstLoc = Math.max(worstLoc, Math.abs(runwayPosition(f).right));
      if (t.onGround && !touchdown) touchdown = { ...runwayPosition(f), sink: t.verticalSpeed / FPM };
      // After touch-down the crew selects idle reverse.
      if (touchdown) ac.controls.reverse = true;
      return touchdown !== undefined && t.groundSpeed < 10 * KT;
    });
    expect(stopped).toBeLessThan(600);
    expect(t.crashed).toBeUndefined();
    for (const m of ['LOC*', 'LOC', 'G/S*', 'G/S', 'LAND', 'FLARE', 'ROLL OUT']) expect(seen).toContain(m);
    expect(capability).toBe('CAT 3 DUAL');
    expect(callouts).toContain('RETARD');
    expect(touchdown).toBeDefined();
    // Touch-down in the touchdown zone with a normal sink (below 6 ft/s, the structural limit
    // is 10), and within 27 ft (8.2 m) of the centreline as CS-AWO asks of an automatic landing.
    expect(touchdown!.along).toBeGreaterThan(150);
    expect(touchdown!.along).toBeLessThan(750);
    expect(touchdown!.sink).toBeGreaterThan(-360);
    expect(Math.abs(touchdown!.right)).toBeLessThan(8.2);
    expect(worstLoc).toBeLessThan(60);
    const end = runwayPosition(f);
    expect(end.along).toBeLessThan(ZRH.length);
    expect(Math.abs(end.right)).toBeLessThan(8.2);
    expect(b.controls.groundSpoilers).toBe(true);
  }, 120_000);

  it('goes around from 50 ft: TOGA, SRS and GA TRK, then climbs away', () => {
    const f = onApproach();
    const { ac } = f;
    const t = ac.telemetry;
    const b = airbus(f);
    fly(f, 600, () => {
      if (b.fma.vertical.startsWith('G/S')) ac.controls.flaps = 1;
      return (t.agl ?? 1000) / FT < 50;
    });
    expect(b.fma.vertical).toBe('LAND');
    levers(f, 1);
    let lowest = Infinity;
    let modes = '';
    let goAround = false;
    fly(f, 40, () => {
      goAround ||= t.avionics!.autopilot.goAround === true;
      lowest = Math.min(lowest, (t.agl ?? 0) / FT);
      if (!modes && b.fma.vertical === 'SRS') modes = `${b.fma.thrust}|${b.fma.vertical}|${b.fma.lateral}`;
      // Gear up and flaps one step up once climbing.
      if (t.verticalSpeed > 2) {
        ac.controls.gearDown = false;
        ac.controls.flaps = 3 / 4;
      }
    });
    expect(t.onGround).toBe(false);
    expect(t.crashed).toBeUndefined();
    // A go-around from 50 ft loses some 20 to 30 ft; it must not touch the runway.
    expect(lowest).toBeGreaterThan(10);
    expect(modes).toBe('MAN TOGA|SRS|GA TRK');
    expect(b.fma.autopilot).not.toBe('');
    expect(t.verticalSpeed / FPM).toBeGreaterThan(1000);
    expect(t.ias / KT).toBeGreaterThan(b.speeds.vls);
    expect(goAround).toBe(true);
  }, 120_000);

  it('takes off in SRS and RWY, asks for the levers at the thrust reduction altitude, and climbs', () => {
    const f = a320OnGround({ mass: 66_000, flapLever: 1 });
    const { ac } = f;
    const t = ac.telemetry;
    const b = airbus(f);
    const c = ac.cockpit;
    c.set('fcuAltitude', 8000);
    c.set('spoilersArmed', 1);
    c.set('autobrake', 3);
    ac.controls.parkingBrake = false;
    ac.controls.pitchTrim = 0.1;
    fly(f, 1);
    const v2 = b.speeds.v2;
    levers(f, 0.82);
    fly(f, 1);
    expect(b.fma.thrust).toBe('MAN FLX');
    expect(b.fma.vertical).toBe('SRS');
    expect(b.fma.lateral).toBe('RWY');
    // The pilot rotates at VR and follows the flight director's pitch bar, then engages AP 1.
    let caution = false;
    let srsSpeed = 0;
    fly(f, 300, () => {
      const kias = t.ias / KT;
      const bars = t.avionics!.autopilot.flightDirector;
      if (t.onGround) ac.controls.pitch = kias > b.speeds.vr ? 0.5 : 0;
      else if (!t.avionics!.autopilot.engaged && bars) {
        ac.controls.pitch = Math.max(
          -1,
          Math.min(1, 4 * (bars.pitch - t.pitch) - 2 * ac.state.angularVelocity.y),
        );
        if ((t.agl ?? 0) / FT > 400) {
          ac.controls.pitch = 0;
          c.set('ap1', 1);
        }
      } else c.set('ap1', 0);
      if (!t.onGround && t.verticalSpeed > 2) ac.controls.gearDown = false;
      const h = (t.agl ?? 0) / FT;
      if (h > 800 && h < 1200) srsSpeed = kias;
      if (b.fma.thrustCaution === 'LVR CLB') {
        caution = true;
        levers(f, 0.62);
      }
      // Flaps up at S speed (FCOM: from 1+F straight to 0).
      if (b.controls.config !== '0' && kias > b.speeds.s) ac.controls.flaps = 0;
      return t.altitude / FT > 6000;
    });
    expect(caution).toBe(true);
    // SRS holds V2 + 10 (FCOM).
    expect(srsSpeed).toBeGreaterThan(v2 + 4);
    expect(srsSpeed).toBeLessThan(v2 + 20);
    expect(b.fma.thrust).toBe('THR CLB');
    expect(b.fma.vertical).toBe('CLB');
    expect(b.fma.autothrust).toBe('active');
    expect(b.controls.config).toBe('0');
    expect(t.ias / KT).toBeGreaterThan(240);
    expect(t.ias / KT).toBeLessThan(260);
  }, 120_000);

  it('climbs managed at 250 kt, levels at a plan constraint, then crosses over to Mach 0.78', () => {
    const f = cruising(5000, 250, { mass: 62_000 });
    const { ac } = f;
    const t = ac.telemetry;
    const b = airbus(f);
    // A plan straight ahead with an altitude at its second point (12 000 ft).
    const g = ecefToGeodetic(ac.state.position);
    const p1 = destination(g.lat, g.lon, 0, 40 * NM, { lat: 0, lon: 0 });
    const p2 = destination(g.lat, g.lon, 0, 400 * NM, { lat: 0, lon: 0 });
    ac.avionics.setFlightPlan([
      { ident: 'HERE', lat: g.lat, lon: g.lon },
      { ident: 'ALPHA', lat: p1.lat, lon: p1.lon, altitude: 12_000 * FT },
      { ident: 'BRAVO', lat: p2.lat, lon: p2.lon },
    ]);
    press(f, 'fcuHeadingPush');
    press(f, 'fcuSpeedPush');
    ac.cockpit.set('fcuAltitude', 33_000);
    press(f, 'fcuAltitudePush');
    expect(b.fma.vertical).toBe('CLB');
    expect(b.fma.thrust).toBe('THR CLB');
    let at250 = 0;
    let constraint = false;
    fly(f, 1500, () => {
      const alt = t.altitude / FT;
      if (alt > 7000 && alt < 9000) at250 = t.ias / KT;
      if (b.fma.vertical === 'ALT CST') constraint = true;
      return alt > 32_900;
    });
    expect(b.fma.lateral).toBe('NAV');
    expect(constraint).toBe(true);
    expect(at250).toBeGreaterThan(245);
    expect(at250).toBeLessThan(255);
    fly(f, 60);
    expect(b.fma.vertical).toBe('ALT');
    expect(b.fma.thrust).toBe('MACH');
    expect(t.mach!).toBeGreaterThan(0.76);
    expect(t.mach!).toBeLessThan(0.8);
    expect(Math.abs(t.altitude / FT - 33_000)).toBeLessThan(60);
  }, 120_000);

  it('flies V/S, EXPED and an open descent with idle thrust, and captures the altitude', () => {
    const f = cruising(12_000, 330, { mass: 60_000 });
    const { ac } = f;
    const t = ac.telemetry;
    const b = airbus(f);
    const c = ac.cockpit;
    c.set('fcuAltitude', 15_000);
    press(f, 'fcuVsPull');
    c.set('fcuVerticalSpeed', 1500);
    fly(f, 20);
    expect(b.fma.vertical).toBe('V/S +1500');
    expect(Math.abs(t.verticalSpeed / FPM - 1500)).toBeLessThan(150);
    expect(b.fma.thrust).toBe('SPEED');
    fly(f, 200, () => b.fma.vertical === 'ALT');
    fly(f, 10);
    expect(Math.abs(t.altitude / FT - 15_000)).toBeLessThan(50);
    c.set('fcuAltitude', 21_000);
    press(f, 'fcuExped');
    expect(b.fma.vertical).toBe('EXP CLB');
    fly(f, 60);
    // EXPED climbs at green dot.
    expect(Math.abs(t.ias / KT - b.speeds.greenDot)).toBeLessThan(12);
    c.set('fcuAltitude', 10_000);
    press(f, 'fcuAltitudePull');
    fly(f, 30);
    expect(b.fma.vertical).toBe('OP DES');
    expect(b.fma.thrust).toBe('THR IDLE');
    expect(t.verticalSpeed / FPM).toBeLessThan(-1000);
    expect(b.fma.verticalArmed).toBe('ALT');
  }, 120_000);

  it('turns to a selected heading at 25° of bank without overshooting', () => {
    const f = cruising(20_000, 380, { mass: 60_000, heading: 0 });
    const t = f.ac.telemetry;
    f.ac.cockpit.set('fcuHeading', 90);
    let maxBank = 0;
    let past = 0;
    fly(f, 90, () => {
      maxBank = Math.max(maxBank, Math.abs(t.bank) / DEG);
      past = Math.max(past, t.headingDeg > 180 ? 0 : t.headingDeg - 90);
    });
    expect(Math.abs(t.headingDeg - 90)).toBeLessThan(1);
    expect(maxBank).toBeGreaterThan(20);
    expect(maxBank).toBeLessThan(27);
    expect(past).toBeLessThan(3);
  }, 60_000);
});

export { ZRH, ILS14, onApproach, place, runwayPosition, a320OnGround, cruising };
