/**
 * Solar position (NOAA algorithm, accurate to ~0.1° for current years).
 * Returns azimuth (degrees from north, clockwise) and elevation above the horizon.
 */
export function solarPosition(
  date: Date,
  latDeg: number,
  lonDeg: number,
): { azimuth: number; elevation: number } {
  const rad = Math.PI / 180;
  const jd = date.getTime() / 86_400_000 + 2_440_587.5;
  const t = (jd - 2_451_545) / 36_525;

  const l0 = (280.46646 + t * (36_000.76983 + t * 0.0003032)) % 360;
  const m = 357.52911 + t * (35_999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c =
    Math.sin(m * rad) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m * rad) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m * rad) * 0.000289;
  const trueLong = l0 + c;
  const omega = 125.04 - 1934.136 * t;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * rad);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * rad);
  const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad));

  const y = Math.tan((eps / 2) * rad) ** 2;
  const eqTime =
    (4 / rad) *
    (y * Math.sin(2 * l0 * rad) -
      2 * e * Math.sin(m * rad) +
      4 * e * y * Math.sin(m * rad) * Math.cos(2 * l0 * rad) -
      0.5 * y * y * Math.sin(4 * l0 * rad) -
      1.25 * e * e * Math.sin(2 * m * rad));

  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const trueSolarTime = (((minutes + eqTime + 4 * lonDeg) % 1440) + 1440) % 1440;
  const hourAngle = trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180;

  const lat = latDeg * rad;
  const cosZen =
    Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle * rad);
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZen)));
  const azDen = Math.cos(lat) * Math.sin(zenith);
  let azimuth: number;
  if (Math.abs(azDen) > 1e-6) {
    const azRad = (Math.sin(lat) * Math.cos(zenith) - Math.sin(decl)) / azDen;
    azimuth = 180 - Math.acos(Math.max(-1, Math.min(1, azRad))) / rad;
    if (hourAngle > 0) azimuth = -azimuth;
    azimuth = ((azimuth % 360) + 360) % 360;
  } else {
    azimuth = lat > 0 ? 180 : 0;
  }
  return { azimuth, elevation: 90 - zenith / rad };
}
