/** Zürich runway 14 and its ILS, for the A320's approach and landing tests. */
import type { NavStation } from '../../src/sim';
import { destination, rangeBearing } from '../../src/sim/avionics/geo';
import { ecefToGeodetic } from '../../src/sim';
import { DEG, FT, fly } from './harness';
import { a320Airborne, press, type A320Flight } from './a320Harness';
import { levers } from './a320Procedures';

export const NM = 1852;
/**
 * Zürich runway 14 (AIP Switzerland AD 2 LSZH, approximate, reconstructed): threshold
 * 47.4823 N 8.5308 E at 1402 ft (427 m), true course 139.7°, 3300 m long; ILS 14 on
 * 108.30 MHz (frequency from memory; the test only needs it to be tunable) with a 3° glide
 * slope 300 m past the threshold.
 */
export const ZRH = { lat: 47.4823, lon: 8.5308, elevation: 427, course: 139.7, length: 3300 };
const at = (course: number, distance: number, from = { lat: ZRH.lat, lon: ZRH.lon }) =>
  destination(from.lat, from.lon, course, distance, { lat: 0, lon: 0 });
const LOC = at(ZRH.course, ZRH.length + 300);
const GS = at(ZRH.course + 90, 120, at(ZRH.course, 300));
export const ILS14: NavStation = {
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
export function place(f: A320Flight, before: number, left: number, heightFt: number) {
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
export function runwayPosition(f: A320Flight) {
  const g = ecefToGeodetic(f.ac.state.position);
  const rb = { distance: 0, bearing: 0 };
  rangeBearing(ZRH.lat, ZRH.lon, g.lat, g.lon, rb);
  const a = (rb.bearing - ZRH.course) * DEG;
  return { along: rb.distance * Math.cos(a), right: rb.distance * Math.sin(a) };
}

/** On the ILS of Zürich 14, 15 NM out, below the glide slope, both autopilots engaged. */
export function onApproach(o: { wind?: { fromDeg: number; speed: number } } = {}) {
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
