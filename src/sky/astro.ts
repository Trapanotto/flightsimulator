/**
 * Moon and stars: positions for a date and a place. Plain TypeScript, tested in Node.
 *
 * The moon uses the low-precision series of the Astronomical Almanac (about 0.3° in
 * longitude, 0.2° in latitude): plenty for a disc of half a degree.
 */

const RAD = Math.PI / 180;

function julianDay(date: Date): number {
  return date.getTime() / 86_400_000 + 2_440_587.5;
}

/** Greenwich mean sidereal time, degrees (IAU 1982, enough for star positions). */
export function greenwichSiderealTime(date: Date): number {
  const d = julianDay(date) - 2_451_545;
  const t = d / 36_525;
  const g = 280.46061837 + 360.98564736629 * d + t * t * (0.000387933 - t / 38_710_000);
  return ((g % 360) + 360) % 360;
}

/** Geocentric equatorial position of the moon: right ascension and declination (degrees). */
export function moonEquatorial(date: Date): { ra: number; dec: number; parallax: number } {
  const t = (julianDay(date) - 2_451_545) / 36_525;
  const s = (a: number, b: number) => Math.sin((a + b * t) * RAD);
  const c = (a: number, b: number) => Math.cos((a + b * t) * RAD);
  const lambda =
    218.32 +
    481_267.881 * t +
    6.29 * s(135.0, 477_198.87) -
    1.27 * s(259.3, -413_335.36) +
    0.66 * s(235.7, 890_534.22) +
    0.21 * s(269.9, 954_397.74) -
    0.19 * s(357.5, 35_999.05) -
    0.11 * s(186.5, 966_404.03);
  const beta =
    5.13 * s(93.3, 483_202.02) +
    0.28 * s(228.2, 960_400.89) -
    0.28 * s(318.3, 6003.15) -
    0.17 * s(217.6, -407_332.21);
  const parallax =
    0.9508 +
    0.0518 * c(135.0, 477_198.87) +
    0.0095 * c(259.3, -413_335.36) +
    0.0078 * c(235.7, 890_534.22) +
    0.0028 * c(269.9, 954_397.74);
  const eps = (23.4393 - 0.013 * t) * RAD;
  const l = lambda * RAD;
  const b = beta * RAD;
  // Ecliptic -> equatorial.
  const x = Math.cos(b) * Math.cos(l);
  const y = Math.cos(eps) * Math.cos(b) * Math.sin(l) - Math.sin(eps) * Math.sin(b);
  const z = Math.sin(eps) * Math.cos(b) * Math.sin(l) + Math.cos(eps) * Math.sin(b);
  const ra = (((Math.atan2(y, x) / RAD) % 360) + 360) % 360;
  const dec = Math.asin(z) / RAD;
  return { ra, dec, parallax };
}

/**
 * Rotation from the equatorial frame (x to the vernal equinox, z to the celestial north pole)
 * into render space (x east, y up, z south) at a place and time, row-major 3x3.
 */
export function equatorialToLocal(date: Date, latDeg: number, lonDeg: number): number[] {
  const lst = (greenwichSiderealTime(date) + lonDeg) * RAD;
  const phi = latDeg * RAD;
  const cl = Math.cos(lst);
  const sl = Math.sin(lst);
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  // First the sky turns by the sidereal time (hour angles), then the pole tilts by latitude.
  const rz = [cl, sl, 0, -sl, cl, 0, 0, 0, 1];
  const a = [0, 1, 0, cp, 0, sp, sp, 0, -cp];
  const m: number[] = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      m.push(a[i * 3]! * rz[j]! + a[i * 3 + 1]! * rz[3 + j]! + a[i * 3 + 2]! * rz[6 + j]!);
  return m;
}

/** Azimuth (degrees from north, clockwise) and elevation of a render-space direction. */
export function azimuthElevation(v: [number, number, number]): {
  azimuth: number;
  elevation: number;
} {
  const [x, y, z] = v;
  const elevation = Math.asin(Math.max(-1, Math.min(1, y))) / RAD;
  const azimuth = (((Math.atan2(x, -z) / RAD) % 360) + 360) % 360;
  return { azimuth, elevation };
}

/** Unit vector in render space (x east, y up, z south) from azimuth and elevation, degrees. */
export function directionFromAzEl(
  azimuthDeg: number,
  elevationDeg: number,
): [number, number, number] {
  const az = azimuthDeg * RAD;
  const el = elevationDeg * RAD;
  return [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)];
}

/**
 * The moon seen from a place: direction in render space (topocentric, the parallax of about
 * one degree lowers it near the horizon), azimuth and elevation.
 */
export function moonPosition(
  date: Date,
  latDeg: number,
  lonDeg: number,
): { direction: [number, number, number]; azimuth: number; elevation: number } {
  const { ra, dec, parallax } = moonEquatorial(date);
  const m = equatorialToLocal(date, latDeg, lonDeg);
  const e = [
    Math.cos(dec * RAD) * Math.cos(ra * RAD),
    Math.cos(dec * RAD) * Math.sin(ra * RAD),
    Math.sin(dec * RAD),
  ];
  const v: [number, number, number] = [0, 1, 2].map(
    (i) => m[i * 3]! * e[0]! + m[i * 3 + 1]! * e[1]! + m[i * 3 + 2]! * e[2]!,
  ) as [number, number, number];
  const geo = azimuthElevation(v);
  const elevation = geo.elevation - parallax * Math.cos(geo.elevation * RAD);
  return { direction: directionFromAzEl(geo.azimuth, elevation), azimuth: geo.azimuth, elevation };
}

/**
 * Illuminated fraction of the moon (0 new .. 1 full) from the directions to sun and moon
 * (any common frame): the phase angle is close to 180° minus their separation.
 */
export function moonIlluminatedFraction(
  sun: [number, number, number],
  moon: [number, number, number],
): number {
  const cosElong = sun[0] * moon[0] + sun[1] * moon[1] + sun[2] * moon[2];
  // cos(phase angle) = -cos(elongation).
  return (1 - cosElong) / 2;
}

/** Illuminance of the full moon at the top of the atmosphere, lux. */
export const FULL_MOON_LUX = 0.26;

/**
 * Moonlight outside the atmosphere for a phase (illuminated fraction), lux. The moon's
 * surface reflects strongly backwards, so the half moon gives about a tenth of the full.
 */
export function moonIlluminanceLux(fraction: number): number {
  // Phase angle from the fraction; Allen's phase law fitted as 10^(-0.4 * 0.026 |a| ...).
  const a = Math.acos(Math.max(-1, Math.min(1, 2 * fraction - 1))) / RAD;
  const mag = 0.026 * a + 4e-9 * a ** 4;
  return FULL_MOON_LUX * 10 ** (-0.4 * mag);
}
