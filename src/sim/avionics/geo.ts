/**
 * Great-circle geometry on a sphere for the receivers and the GPS. A sphere of the mean Earth
 * radius is within 0.5 % of the ellipsoid, far below what a needle or a NM display resolves.
 * Everything works on radians and writes into scratch fields, so the step allocates nothing.
 */

/** Mean Earth radius (IUGG), m. */
export const EARTH_RADIUS = 6_371_008.8;
export const NM = 1852;
export const FT = 0.3048;
export const DEG = Math.PI / 180;
export const FPM = FT / 60;
export const KT = NM / 3600;

/** Angle wrapped into (-180, 180], degrees. */
export function wrap180(deg: number): number {
  let a = deg % 360;
  if (a > 180) a -= 360;
  else if (a <= -180) a += 360;
  return a;
}

/** Angle wrapped into [0, 360), degrees. */
export function wrap360(deg: number): number {
  const a = deg % 360;
  return a < 0 ? a + 360 : a;
}

/** Central angle between two points (haversine, well conditioned at short range), radians. */
export function centralAngle(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const sdLat = Math.sin((lat2 - lat1) / 2);
  const sdLon = Math.sin((lon2 - lon1) / 2);
  const h = sdLat * sdLat + Math.cos(lat1) * Math.cos(lat2) * sdLon * sdLon;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial true course from point 1 to point 2, radians (-pi..pi). */
export function initialCourse(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = lon2 - lon1;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return Math.atan2(y, x);
}

/** Distance (m) and true bearing (degrees 0..360) from one point to another, in degrees. */
export interface RangeBearing {
  distance: number;
  bearing: number;
}

export function rangeBearing(
  latDeg1: number,
  lonDeg1: number,
  latDeg2: number,
  lonDeg2: number,
  out: RangeBearing,
): RangeBearing {
  const lat1 = latDeg1 * DEG;
  const lon1 = lonDeg1 * DEG;
  const lat2 = latDeg2 * DEG;
  const lon2 = lonDeg2 * DEG;
  out.distance = centralAngle(lat1, lon1, lat2, lon2) * EARTH_RADIUS;
  out.bearing = wrap360(initialCourse(lat1, lon1, lat2, lon2) / DEG);
  return out;
}

/** A point reached from a start along a true course (degrees) after a distance (m). */
export function destination(
  latDeg: number,
  lonDeg: number,
  courseDeg: number,
  distance: number,
  out: { lat: number; lon: number },
): { lat: number; lon: number } {
  const lat1 = latDeg * DEG;
  const lon1 = lonDeg * DEG;
  const c = courseDeg * DEG;
  const d = distance / EARTH_RADIUS;
  const sinLat = Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(c);
  const lat2 = Math.asin(sinLat);
  const lon2 =
    lon1 +
    Math.atan2(Math.sin(c) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * sinLat);
  out.lat = lat2 / DEG;
  out.lon = lon2 / DEG;
  return out;
}

/** Radio horizon, NM, of two antennas at heights above a common surface (ft). */
export function radioHorizonNm(heightFt1: number, heightFt2: number): number {
  // 1.23 * sqrt(h ft) NM: the line-of-sight range with the standard 4/3 Earth radius for
  // VHF refraction.
  return 1.23 * (Math.sqrt(Math.max(heightFt1, 0)) + Math.sqrt(Math.max(heightFt2, 0)));
}
