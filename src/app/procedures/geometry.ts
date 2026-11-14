/**
 * Flat-earth geometry around an airport in nautical miles. Within the 30 NM a controller
 * cares about, the error of a local tangent plane is far below what a vector is rounded to.
 */
import type { AtcRunway } from './world';

const RAD = Math.PI / 180;
const NM_PER_DEG_LAT = 60;

export interface LonLat {
  lon: number;
  lat: number;
}

/** East and north of `ref` in nautical miles. */
export function localNm(ref: LonLat, p: LonLat): { e: number; n: number } {
  return {
    e: (p.lon - ref.lon) * Math.cos(ref.lat * RAD) * NM_PER_DEG_LAT,
    n: (p.lat - ref.lat) * NM_PER_DEG_LAT,
  };
}

export function fromLocalNm(ref: LonLat, e: number, n: number): LonLat {
  return {
    lon: ref.lon + e / (Math.cos(ref.lat * RAD) * NM_PER_DEG_LAT),
    lat: ref.lat + n / NM_PER_DEG_LAT,
  };
}

export function distanceNm(a: LonLat, b: LonLat): number {
  const d = localNm(a, b);
  return Math.hypot(d.e, d.n);
}

/** True bearing from a to b, degrees 0..360. */
export function bearingTo(a: LonLat, b: LonLat): number {
  const d = localNm(a, b);
  return norm360(Math.atan2(d.e, d.n) / RAD);
}

export const norm360 = (deg: number) => ((deg % 360) + 360) % 360;

/** Signed a - b of two headings, -180..180. */
export const angleDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180;

/**
 * A point in the frame of an approach: `x` nautical miles out from the threshold along the
 * extended centre line (positive on the approach side), `y` nautical miles to the right of
 * the final approach course (as seen by a pilot on final).
 */
export function approachFrame(rwy: AtcRunway, p: LonLat): { x: number; y: number } {
  const d = localNm(rwy.threshold, p);
  const c = rwy.course * RAD;
  return {
    x: -(d.e * Math.sin(c) + d.n * Math.cos(c)),
    y: d.e * Math.cos(c) - d.n * Math.sin(c),
  };
}

export function fromApproachFrame(rwy: AtcRunway, x: number, y: number): LonLat {
  const c = rwy.course * RAD;
  const e = -x * Math.sin(c) + y * Math.cos(c);
  const n = -x * Math.cos(c) - y * Math.sin(c);
  return fromLocalNm(rwy.threshold, e, n);
}

/** On the paved runway (with a few metres to spare at the edges). */
export function onRunway(rwy: AtcRunway, p: LonLat, marginM = 5): boolean {
  const d = localNm(rwy.start, p);
  const c = rwy.course * RAD;
  const along = (d.e * Math.sin(c) + d.n * Math.cos(c)) * 1852;
  const across = (d.e * Math.cos(c) - d.n * Math.sin(c)) * 1852;
  return (
    along >= -marginM &&
    along <= rwy.length + marginM &&
    Math.abs(across) <= rwy.width / 2 + marginM
  );
}

/** Metres from the start of the take-off run (where the holding point is). */
export function metresFromStart(rwy: AtcRunway, p: LonLat): number {
  return distanceNm(rwy.start, p) * 1852;
}
