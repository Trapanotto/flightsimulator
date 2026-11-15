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
});

export { ZRH, ILS14, onApproach, place, runwayPosition, a320OnGround, cruising };
