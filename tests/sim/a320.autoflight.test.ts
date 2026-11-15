/**
 * The A320's flight guidance flying the aircraft: the automatic landing (CAT 3 DUAL) on the
 * ILS of Zürich 14, a go-around from 50 ft, take-off with SRS and the thrust reduction,
 * managed and selected climb and descent with altitude capture and a plan constraint, the
 * speed profile with the crossover, V/S, EXPED, heading and NAV, and the autothrust modes.
 */
import { describe, expect, it } from 'vitest';
import { ecefToGeodetic } from '../../src/sim';
import { destination } from '../../src/sim/avionics/geo';
import { DEG, FPM, FT, KT, fly } from './harness';
import { a320OnGround, airbus, press } from './a320Harness';
import { NM, ZRH, onApproach, runwayPosition } from './a320Zurich';
import { cruising, levers } from './a320Procedures';

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
      if (agl < 1000 && !t.onGround)
        worstLoc = Math.max(worstLoc, Math.abs(runwayPosition(f).right));
      if (t.onGround && !touchdown)
        touchdown = { ...runwayPosition(f), sink: t.verticalSpeed / FPM };
      // After touch-down the crew selects idle reverse.
      if (touchdown) ac.controls.reverse = true;
      return touchdown !== undefined && t.groundSpeed < 10 * KT;
    });
    expect(stopped).toBeLessThan(600);
    expect(t.crashed).toBeUndefined();
    for (const m of ['LOC*', 'LOC', 'G/S*', 'G/S', 'LAND', 'FLARE', 'ROLL OUT'])
      expect(seen).toContain(m);
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
      if (!modes && b.fma.vertical === 'SRS')
        modes = `${b.fma.thrust}|${b.fma.vertical}|${b.fma.lateral}`;
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
